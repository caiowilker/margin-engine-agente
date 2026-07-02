// Reconciliação fiscal automática — agente local
const log = require("./logger");
const filaFiscal = require("./filaFiscal");
const fiscalDriver = require("./fiscalDriver");
const docs = require("./documentosFiscais");
const fiscalService = require("./fiscalService");

const fiscalRecuperacao = require("./fiscalRecuperacao");
const INTERVAL_MS = parseInt(
  process.env.FISCAL_RECONCILIACAO_MS || "300000",
  10,
);
const RECOVERY_MS = parseInt(process.env.FISCAL_RECOVERY_MS || "30000", 10);

let reconciliacaoTimer = null;
let recoveryTimer = null;

async function executarRecovery() {
  if (!fiscalDriver.EMISSAO_FISCAL) return;
  const acbr = require("./acbr");
  if (acbr.isAcbrBusy() || filaFiscal.acbrOcupado()) {
    log.debug("Recovery adiado — ACBr ou emissão em andamento");
    return;
  }
  await fiscalRecuperacao.processarFilaRecovery(lerConfigRef).catch((err) =>
    log.warn({ err: err.message }, "Recovery: falha fila consulta"),
  );
}

let lerConfigRef = null;

function httpRequest(url, options, body) {
  const http = require("http");
  const https = require("https");
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.request(url, options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data || "{}"));
          } catch {
            resolve({});
          }
        } else {
          reject(new Error(data || `HTTP ${res.statusCode}`));
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function recuperarDocumentoLocal(cfg, numeroVenda, correlationId) {
  const local = filaFiscal.buscarDocumentoPorVenda(numeroVenda);
  if (!local?.chave) return false;

  let xmlContent = null;
  if (local.xml_path) {
    const buf = docs.lerArquivo(local.xml_path);
    xmlContent = buf ? buf.toString("utf8") : null;
  }

  let pdfContentBase64 = null;
  if (local.pdf_path && docs.isPdfValid(local.pdf_path)) {
    pdfContentBase64 = docs.lerArquivoBase64(local.pdf_path);
  }

  await fiscalService.callbackBackend(
    cfg,
    numeroVenda,
    {
      correlationId: correlationId || local.correlation_id,
      chaveNfe: local.chave,
      numeroNfe: local.numero_nfe,
      serieNfe: local.serie_nfe,
      protocolo: local.protocolo,
      cStat: local.c_stat || "100",
      statusFiscal: "AUTORIZADA",
      xmlContent,
      xmlPath: local.xml_path,
      pdfPath: local.pdf_path,
      pdfContentBase64,
      modeloDocumento: fiscalService.inferirModeloDocumento(local, local.chave),
    },
    correlationId || local.correlation_id,
  );
  return true;
}

async function executarCiclo(lerConfigFn) {
  lerConfigRef = lerConfigFn;
  const acbr = require("./acbr");
  if (acbr.isAcbrBusy() || filaFiscal.acbrOcupado()) {
    log.debug("Reconciliação adiada — ACBr ou emissão em andamento");
    return;
  }
  const cfg = await lerConfigFn();
  if (!cfg.backendUrl || !cfg.backendToken || !fiscalDriver.EMISSAO_FISCAL) {
    return;
  }

  await filaFiscal.reprocessarIncertos(lerConfigFn).catch((err) =>
    log.warn({ err: err.message }, "Reconciliação: falha reprocessar INCERTO"),
  );

  let resp;
  try {
    resp = await httpRequest(
      `${cfg.backendUrl.replace(/\/$/, "")}/pdv/fiscal/reconciliacao`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${cfg.backendToken}` },
      },
    );
  } catch (err) {
    log.warn({ err: err.message }, "Reconciliação: falha ao consultar backend");
    return;
  }

  const divergencias = resp.divergencias || [];
  for (const item of divergencias) {
    try {
      const okLocal = await recuperarDocumentoLocal(
        cfg,
        item.numeroVenda,
        item.correlationId,
      );
      if (okLocal) {
        log.info(
          { numeroVenda: item.numeroVenda },
          "Reconciliação: callback recuperado do disco local",
        );
        continue;
      }

      const job = filaFiscal.buscarJobEmissaoPorVenda(item.numeroVenda);
      if (job && job.status === "FALHA_PERMANENTE") {
        await filaFiscal.reprocessarIncertos(lerConfigFn);
      }
    } catch (err) {
      log.warn(
        { numeroVenda: item.numeroVenda, err: err.message },
        "Reconciliação: falha ao processar item",
      );
    }
  }
}

function iniciar(lerConfigFn) {
  lerConfigRef = lerConfigFn;
  if (reconciliacaoTimer) return;
  reconciliacaoTimer = setInterval(() => {
    executarCiclo(lerConfigFn).catch((err) =>
      log.warn({ err: err.message }, "Reconciliação fiscal: erro no ciclo"),
    );
  }, INTERVAL_MS);
  recoveryTimer = setInterval(() => {
    executarRecovery().catch((err) =>
      log.warn({ err: err.message }, "Recovery fiscal: erro no ciclo"),
    );
  }, RECOVERY_MS);
  setTimeout(() => executarRecovery().catch(() => {}), 10000);
  setTimeout(() => executarCiclo(lerConfigFn).catch(() => {}), 15000);
}

function parar() {
  if (reconciliacaoTimer) {
    clearInterval(reconciliacaoTimer);
    reconciliacaoTimer = null;
  }
  if (recoveryTimer) {
    clearInterval(recoveryTimer);
    recoveryTimer = null;
  }
}

module.exports = { iniciar, parar, executarCiclo, executarRecovery };

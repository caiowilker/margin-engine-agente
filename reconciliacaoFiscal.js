// Reconciliação fiscal automática — agente local
const log = require("./logger");
const filaFiscal = require("./filaFiscal");
const acbr = require("./acbr");
const docs = require("./documentosFiscais");
const fiscalService = require("./fiscalService");

const INTERVAL_MS = parseInt(
  process.env.FISCAL_RECONCILIACAO_MS || "300000",
  10,
);

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
      protocolo: local.protocolo,
      cStat: local.c_stat || "100",
      statusFiscal: "AUTORIZADA",
      xmlContent,
      xmlPath: local.xml_path,
      pdfPath: local.pdf_path,
      pdfContentBase64,
    },
    correlationId || local.correlation_id,
  );
  return true;
}

async function executarCiclo(lerConfigFn) {
  const cfg = await lerConfigFn();
  if (!cfg.backendUrl || !cfg.backendToken || !acbr.EMISSAO_FISCAL) return;

  filaFiscal.reprocessarIncertos();

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
        filaFiscal.reprocessarIncertos();
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
  setInterval(() => {
    executarCiclo(lerConfigFn).catch((err) =>
      log.warn({ err: err.message }, "Reconciliação fiscal: erro no ciclo"),
    );
  }, INTERVAL_MS);
  setTimeout(() => executarCiclo(lerConfigFn).catch(() => {}), 15000);
}

module.exports = { iniciar, executarCiclo };

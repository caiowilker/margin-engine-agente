// Orquestração fiscal local — emissão, persistência, callback backend
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const acbr = require("./acbr");
const docs = require("./documentosFiscais");
const filaFiscal = require("./filaFiscal");
const fiscalPreflight = require("./fiscalPreflight");
const fiscalRetry = require("./fiscalRetry");
const { PATHS } = require("./marginPaths");

function httpRequest(url, options, body) {
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
            resolve({ ok: true, raw: data });
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

async function callbackBackend(cfg, numeroVenda, payload, correlationId) {
  const url = `${cfg.backendUrl.replace(/\/$/, "")}/pdv/vendas/${encodeURIComponent(numeroVenda)}/fiscal/resultado`;
  const body = JSON.stringify(payload);
  return httpRequest(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.backendToken}`,
        "X-Correlation-Id": correlationId || "",
      },
    },
    body,
  );
}

async function persistirDocumentosFiscais(cfg, numeroVenda, correlationId, resultado) {
  let xmlPath = null;
  let pdfPath = null;
  let pdfContentBase64 = null;

  if (resultado.xml) {
    xmlPath = docs.salvarXmlAutorizado(resultado.chave, resultado.xml);
  }

  try {
    pdfPath = await acbr.gerarPdfDanfce(resultado.chave, xmlPath);
  } catch (err) {
    throw new Error(`Falha ao gerar DANFC-e PDF: ${err.message}`);
  }

  if (!docs.isPdfValid(pdfPath)) {
    throw new Error("PDF DANFC-e inválido ou ausente após geração ACBr");
  }

  pdfContentBase64 = docs.lerArquivoBase64(pdfPath);

  filaFiscal.salvarDocumento({
    chave: resultado.chave,
    numeroVenda,
    correlationId,
    cStat: resultado.cStat,
    protocolo: resultado.protocolo,
    xmlPath,
    pdfPath,
    tipo: "AUTORIZADA",
  });

  const callbackPayload = {
    correlationId,
    chaveNfe: resultado.chave,
    numeroNfe: resultado.numero,
    serieNfe: resultado.serie,
    qrcode: resultado.qrcode,
    protocolo: resultado.protocolo,
    cStat: resultado.cStat,
    xMotivo: resultado.xMotivo,
    statusFiscal: "AUTORIZADA",
    xmlContent: resultado.xml || null,
    xmlPath,
    pdfPath,
    pdfContentBase64,
    contentType: "application/xml",
  };

  try {
    await callbackBackend(cfg, numeroVenda, callbackPayload, correlationId);
  } catch (err) {
    filaFiscal.enfileirar(
      "CALLBACK_BACKEND",
      {
        cfg: { backendUrl: cfg.backendUrl, backendToken: cfg.backendToken },
        numeroVenda,
        callbackPayload,
        correlationId,
      },
      correlationId,
    );
  }

  return { ...resultado, xmlPath, pdfPath, pdfContentBase64, numeroVenda };
}

async function emitirCompleto(cfg, body) {
  const { numeroVenda, correlationId, ...payload } = body;
  if (!numeroVenda) throw new Error("numeroVenda obrigatório");

  await fiscalPreflight.validarEmissao();

  let resultado;
  try {
    resultado = await acbr.emitirNfce(payload);
  } catch (err) {
    const chaveConsulta = err.chaveConsulta || payload.chaveConsulta;
    if (err.incerto && chaveConsulta) {
      const consulta = await acbr.consultarChave(chaveConsulta);
      if (consulta.situacao === "AUTORIZADA") {
        resultado = {
          fiscal: true,
          chave: chaveConsulta,
          numero: consulta.raw.match(/Numero=(\d+)/)?.[1],
          serie: consulta.raw.match(/Serie=(\d+)/)?.[1] || "001",
          qrcode: null,
          protocolo: consulta.protocolo,
          cStat: consulta.cStat,
          xMotivo: consulta.xMotivo,
          xml: docs.extrairXmlDaResposta(consulta.raw),
          recuperado: true,
        };
      } else {
        throw err;
      }
    } else if (err.incerto) {
      err.chaveConsulta = chaveConsulta;
      throw err;
    } else {
      throw err;
    }
  }

  if (!resultado || resultado.fiscal === false) {
    return { fiscal: false };
  }

  return persistirDocumentosFiscais(cfg, numeroVenda, correlationId, resultado);
}

async function enfileirarEmissao(cfg, body) {
  const correlationId = body.correlationId || crypto.randomUUID();
  const numeroVenda = body.numeroVenda;
  if (!numeroVenda) throw new Error("numeroVenda obrigatório");

  const existente = filaFiscal.obterResultadoEmissao(correlationId);
  if (existente?.status === "CONCLUIDO" && existente.resultado) {
    return JSON.parse(existente.resultado);
  }

  await fiscalPreflight.validarEmissao();

  filaFiscal.enfileirar(
    "EMISSAO",
    {
      cfg: { backendUrl: cfg.backendUrl, backendToken: cfg.backendToken },
      ...body,
      correlationId,
    },
    correlationId,
  );

  return filaFiscal.aguardarConclusao(
    correlationId,
    parseInt(process.env.FISCAL_EMISSAO_TIMEOUT_MS || "120000", 10),
  );
}

async function reimprimirDanfceCompleto(chave, numeroVenda) {
  const doc =
    (chave && filaFiscal.buscarDocumentoPorChave(chave)) ||
    (numeroVenda && filaFiscal.buscarDocumentoPorVenda(numeroVenda));

  if (!doc) {
    throw new Error("Documento fiscal não encontrado localmente");
  }

  const chaveDoc = doc.chave || chave;
  let pdfPath = doc.pdf_path;

  if (!docs.isPdfValid(pdfPath) && chaveDoc) {
    pdfPath = await acbr.gerarPdfDanfce(chaveDoc, doc.xml_path);
    filaFiscal.salvarDocumento({
      chave: chaveDoc,
      numeroVenda: doc.numero_venda || numeroVenda,
      correlationId: doc.correlation_id,
      cStat: doc.c_stat,
      protocolo: doc.protocolo,
      xmlPath: doc.xml_path,
      pdfPath,
      tipo: doc.tipo || "AUTORIZADA",
    });
  }

  await acbr.imprimirDanfce(chaveDoc);
  return { ok: true, chave: chaveDoc, pdfPath, tipo: "pdf" };
}

async function cancelarCompleto(cfg, body) {
  const { chave, motivo, numeroVenda, correlationId } = body;
  const res = await acbr.cancelarNfce(chave, motivo);
  if (res.xml) docs.salvarXmlCancelamento(chave, res.xml);
  if (numeroVenda && cfg.backendUrl) {
    try {
      await httpRequest(
        `${cfg.backendUrl.replace(/\/$/, "")}/pdv/vendas/${encodeURIComponent(numeroVenda)}/fiscal/cancelamento`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.backendToken}`,
            "X-Correlation-Id": correlationId || "",
          },
        },
        JSON.stringify({
          protocolo: res.protocolo,
          cStat: res.cStat,
          xMotivo: res.xMotivo || motivo,
          xmlContent: res.xml || null,
        }),
      );
    } catch (err) {
      filaFiscal.enfileirar(
        "CANCELAMENTO",
        {
          cfg: { backendUrl: cfg.backendUrl, backendToken: cfg.backendToken },
          chave,
          motivo,
          numeroVenda,
          correlationId,
          backendOnly: true,
        },
        correlationId,
      );
    }
  }
  return res;
}

async function inutilizarCompleto(cfg, body) {
  let inutilizacaoId = body.inutilizacaoId || null;

  if (cfg.backendUrl && !inutilizacaoId) {
    const created = await httpRequest(
      `${cfg.backendUrl.replace(/\/$/, "")}/pdv/nfce/inutilizar`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.backendToken}`,
        },
      },
      JSON.stringify({
        serie: body.serie,
        numeroInicial: body.numeroInicial,
        numeroFinal: body.numeroFinal,
        motivo: body.motivo,
        modelo: body.modelo || "65",
      }),
    );
    inutilizacaoId = created.id;
  }

  const res = await acbr.inutilizarNfce(body);
  let xmlPath = null;
  if (res.xml) {
    xmlPath = docs.salvarXmlInutilizacao(
      body.serie,
      body.numeroInicial,
      body.numeroFinal,
      res.xml,
    );
  }
  if (cfg.backendUrl && inutilizacaoId) {
    try {
      await httpRequest(
        `${cfg.backendUrl.replace(/\/$/, "")}/pdv/nfce/inutilizar/registrar`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.backendToken}`,
          },
        },
        JSON.stringify({
          id: inutilizacaoId,
          protocolo: res.protocolo,
          cStat: res.cStat,
          xmlPath,
        }),
      );
    } catch (_) {
      filaFiscal.enfileirar("INUTILIZACAO", {
        cfg,
        body: { ...body, inutilizacaoId },
        res,
        xmlPath,
      });
    }
  }
  return { ...res, inutilizacaoId, xmlPath };
}

function registrarHandlersFila(lerConfigFn) {
  filaFiscal.registrarHandler("CALLBACK_BACKEND", async (payload) => {
    const cfg = payload.cfg || (await lerConfigFn());
    await callbackBackend(
      cfg,
      payload.numeroVenda,
      payload.callbackPayload,
      payload.correlationId,
    );
  });

  filaFiscal.registrarHandler("EMISSAO", async (payload) => {
    const cfg = payload.cfg || (await lerConfigFn());
    const correlationId = payload.correlationId;
    const numeroVenda = payload.numeroVenda;
    try {
      const resultado = await emitirCompleto(cfg, payload);
      filaFiscal.salvarResultadoEmissao(
        correlationId,
        numeroVenda,
        "CONCLUIDO",
        resultado,
        null,
      );
    } catch (err) {
      if (fiscalRetry.isPermanente(err)) {
        filaFiscal.salvarResultadoEmissao(
          correlationId,
          numeroVenda,
          "FALHA_PERMANENTE",
          null,
          err.message,
        );
      }
      throw err;
    }
  });

  filaFiscal.registrarHandler("CANCELAMENTO", async (payload) => {
    const cfg = payload.cfg || (await lerConfigFn());
    if (payload.backendOnly) {
      await httpRequest(
        `${cfg.backendUrl.replace(/\/$/, "")}/pdv/vendas/${encodeURIComponent(payload.numeroVenda)}/fiscal/cancelamento`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.backendToken}`,
          },
        },
        JSON.stringify({
          protocolo: payload.protocolo,
          cStat: payload.cStat,
          xMotivo: payload.motivo,
          xmlContent: payload.xmlContent || null,
        }),
      );
    } else {
      await cancelarCompleto(cfg, payload);
    }
  });

  filaFiscal.registrarHandler("INUTILIZACAO", async (payload) => {
    const cfg = payload.cfg || (await lerConfigFn());
    if (payload.res?.protocolo) {
      await httpRequest(
        `${cfg.backendUrl.replace(/\/$/, "")}/pdv/nfce/inutilizar/registrar`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.backendToken}`,
          },
        },
        JSON.stringify({
          id: payload.body.inutilizacaoId,
          protocolo: payload.res.protocolo,
          cStat: payload.res.cStat,
          xmlPath: payload.xmlPath,
        }),
      );
      return;
    }
    await inutilizarCompleto(cfg, payload.body);
  });
}

module.exports = {
  emitirCompleto,
  enfileirarEmissao,
  reimprimirDanfceCompleto,
  cancelarCompleto,
  inutilizarCompleto,
  callbackBackend,
  persistirDocumentosFiscais,
  registrarHandlersFila,
  PATHS,
};

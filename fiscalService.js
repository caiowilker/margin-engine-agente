// Orquestração fiscal local — emissão idempotente, recovery, sem token em SQLite
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const acbr = require("./acbr");
const docs = require("./documentosFiscais");
const filaFiscal = require("./filaFiscal");
const fiscalPreflight = require("./fiscalPreflight");
const fiscalRetry = require("./fiscalRetry");
const fiscalMetrics = require("./fiscalMetrics");
const fiscalRateLimit = require("./fiscalRateLimit");
const fiscalRecuperacao = require("./fiscalRecuperacao");
const fiscalStorage = require("./fiscalStorage");
const fiscalNumeracao = require("./fiscalNumeracao");
const { PATHS } = require("./marginPaths");

const GERAR_PDF_EMIT =
  (process.env.FISCAL_GERAR_PDF_ON_EMIT || "false").toLowerCase() === "true";

function httpRequest(url, options, body, timeoutMs = 15000) {
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
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`HTTP timeout ${timeoutMs}ms`));
    });
    if (body) req.write(body);
    req.end();
  });
}

async function callbackBackend(cfg, numeroVenda, payload, correlationId) {
  const t0 = Date.now();
  const url = `${cfg.backendUrl.replace(/\/$/, "")}/pdv/vendas/${encodeURIComponent(numeroVenda)}/fiscal/resultado`;
  const body = JSON.stringify(payload);
  const result = await httpRequest(
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
  fiscalMetrics.registrarEmissao(0, { callbackMs: Date.now() - t0 });
  return result;
}

async function persistirAposAutorizacao(cfg, numeroVenda, correlationId, resultado) {
  fiscalStorage.exigirEspacoParaEscrita();
  let xmlPath = null;
  if (resultado.xml) {
    xmlPath = docs.salvarXmlAutorizado(resultado.chave, resultado.xml);
  }

  filaFiscal.salvarDocumento({
    chave: resultado.chave,
    numeroVenda,
    correlationId,
    serieNfe: resultado.serie || resultado.serieNfe,
    numeroNfe: resultado.numero || resultado.numeroNfe,
    cStat: resultado.cStat,
    protocolo: resultado.protocolo,
    xmlPath,
    pdfPath: null,
    tipo: "AUTORIZADA",
  });

  const callbackPayload = {
    correlationId,
    chaveNfe: resultado.chave,
    numeroNfe: resultado.numero || resultado.numeroNfe,
    serieNfe: resultado.serie || resultado.serieNfe,
    qrcode: resultado.qrcode || resultado.qrcodeNfe,
    protocolo: resultado.protocolo,
    cStat: resultado.cStat,
    xMotivo: resultado.xMotivo,
    statusFiscal: "AUTORIZADA",
    xmlContent: resultado.xml || null,
    xmlPath,
    pdfPath: null,
    pdfContentBase64: null,
    contentType: "application/xml",
    pdfPendente: true,
    recuperado: !!resultado.recuperado,
  };

  try {
    await callbackBackend(cfg, numeroVenda, callbackPayload, correlationId);
  } catch (err) {
    filaFiscal.enfileirar(
      "CALLBACK_BACKEND",
      { numeroVenda, callbackPayload, correlationId },
      correlationId,
      numeroVenda,
    );
  }

  if (!GERAR_PDF_EMIT) {
    filaFiscal.enfileirar(
      "GERAR_PDF",
      { chave: resultado.chave, xmlPath, numeroVenda, correlationId },
      correlationId,
      numeroVenda,
    );
  }

  filaFiscal.dispararProcessamento();

  return {
    ...resultado,
    xmlPath,
    pdfPath: null,
    pdfContentBase64: null,
    pdfPendente: !GERAR_PDF_EMIT,
    numeroVenda,
  };
}

async function persistirDocumentosFiscais(cfg, numeroVenda, correlationId, resultado) {
  if (GERAR_PDF_EMIT) {
    fiscalStorage.exigirEspacoParaEscrita();
    let xmlPath = null;
    let pdfPath = null;
    if (resultado.xml) {
      xmlPath = docs.salvarXmlAutorizado(resultado.chave, resultado.xml);
    }
    const tPdf = Date.now();
    pdfPath = await acbr.gerarPdfDanfce(resultado.chave, xmlPath);
    fiscalMetrics.registrarEmissao(0, { pdfMs: Date.now() - tPdf, pdf: true });
    const pdfContentBase64 =
      pdfPath && docs.isPdfValid(pdfPath) ? docs.lerArquivoBase64(pdfPath) : null;
    filaFiscal.salvarDocumento({
      chave: resultado.chave,
      numeroVenda,
      correlationId,
      serieNfe: resultado.serie,
      numeroNfe: resultado.numero,
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
    } catch {
      filaFiscal.enfileirar(
        "CALLBACK_BACKEND",
        { numeroVenda, callbackPayload, correlationId },
        correlationId,
        numeroVenda,
      );
    }
    return { ...resultado, xmlPath, pdfPath, pdfContentBase64, numeroVenda };
  }
  return persistirAposAutorizacao(cfg, numeroVenda, correlationId, resultado);
}

async function finalizarEmissaoRecuperada(cfg, numeroVenda, correlationId, resultado) {
  return persistirDocumentosFiscais(cfg, numeroVenda, correlationId, {
    ...resultado,
    recuperado: true,
  });
}

function reservarNumeracaoJob(payload, job) {
  if (payload._fiscalMeta?.numeroNfe && payload._fiscalMeta?.serieNfe) {
    return payload._fiscalMeta;
  }
  const serie = payload.serieNfe || fiscalNumeracao.SERIE_PADRAO;
  const res = fiscalNumeracao.reservarProximoNumero(serie);
  const meta = {
    numeroNfe: String(res.numero),
    serieNfe: res.serie,
    reservadoEm: new Date().toISOString(),
  };
  filaFiscal.atualizarPayload(job.id, { _fiscalMeta: meta, numeroNfe: meta.numeroNfe, serieNfe: meta.serieNfe });
  return meta;
}

async function emitirCompleto(cfg, body, job = null) {
  const { numeroVenda, correlationId, ...payload } = body;
  if (!numeroVenda) throw new Error("numeroVenda obrigatório");

  const recuperado = await fiscalRecuperacao.verificarAntesDeEmitir(body);
  if (recuperado?.chave) {
    fiscalMetrics.registrarEmissao(0, { recuperada: true, ok: true });
    return finalizarEmissaoRecuperada(cfg, numeroVenda, correlationId, recuperado);
  }

  await fiscalPreflight.validarEmissao({ completo: false });

  const cnpj =
    payload.empresa?.cnpj || payload.cnpj || cfg.empresa?.cnpj || cfg.cnpj;
  const rl = fiscalRateLimit.podeEmitir(cnpj);
  if (!rl.ok) {
    const e = new Error(rl.motivo);
    e.rateLimit = true;
    throw e;
  }
  fiscalRateLimit.registrarTentativa(cnpj);

  if (job && !payload._fiscalMeta?.numeroNfe) {
    const meta = reservarNumeracaoJob(payload, job);
    payload.numeroNfe = meta.numeroNfe;
    payload.serieNfe = meta.serieNfe;
    payload._fiscalMeta = meta;
  } else if (payload._fiscalMeta?.numeroNfe) {
    payload.numeroNfe = payload._fiscalMeta.numeroNfe;
    payload.serieNfe = payload._fiscalMeta.serieNfe;
  }

  const inicio = Date.now();
  let resultado;
  try {
    const tAcbr = Date.now();
    resultado = await acbr.emitirNfce(payload);
    const acbrMs = Date.now() - tAcbr;
    fiscalMetrics.registrarEmissao(Date.now() - inicio, {
      ok: true,
      acbrMs,
      sefazMs: acbrMs,
    });
    if (job && resultado?.chave) {
      filaFiscal.atualizarPayload(job.id, {
        _fiscalMeta: {
          ...(payload._fiscalMeta || {}),
          chave: resultado.chave,
          protocolo: resultado.protocolo,
          numeroNfe: resultado.numero || payload.numeroNfe,
          serieNfe: resultado.serie || payload.serieNfe,
        },
      });
    }
  } catch (err) {
    const rec = await fiscalRecuperacao.verificarAntesDeEmitir({
      ...body,
      chave: err.chaveConsulta,
      chaveConsulta: err.chaveConsulta,
      numeroNfe: payload.numeroNfe,
      serieNfe: payload.serieNfe,
    });
    if (rec?.chave) {
      fiscalMetrics.registrarEmissao(Date.now() - inicio, { recuperada: true, ok: true });
      return finalizarEmissaoRecuperada(cfg, numeroVenda, correlationId, rec);
    }
    if (err.incerto) throw err;
    fiscalRateLimit.registrarFalha(cnpj, fiscalRetry.extrairCStat(err), 1);
    fiscalMetrics.registrarEmissao(Date.now() - inicio, {
      falha: true,
      cStat: fiscalRetry.extrairCStat(err),
      timeout: !!err.incerto,
    });
    throw err;
  }

  if (!resultado || resultado.fiscal === false) return { fiscal: false };

  return persistirDocumentosFiscais(cfg, numeroVenda, correlationId, resultado);
}

async function enfileirarEmissao(cfg, body, opts = {}) {
  const correlationId = body.correlationId || crypto.randomUUID();
  const numeroVenda = body.numeroVenda;
  if (!numeroVenda) throw new Error("numeroVenda obrigatório");

  const sync =
    opts.sync ||
    (process.env.FISCAL_EMITIR_SYNC || "false").toLowerCase() === "true";

  const existente = filaFiscal.obterResultadoEmissao(correlationId);
  if (existente && ["CONCLUIDO", "CONCLUIDO_RECUPERADO"].includes(existente.status) && existente.resultado) {
    return JSON.parse(existente.resultado);
  }

  const porVenda = filaFiscal.vendaJaConcluida(numeroVenda);
  if (porVenda?.resultado) {
    return JSON.parse(porVenda.resultado);
  }

  const enq = filaFiscal.enfileirar(
    "EMISSAO",
    { ...body, correlationId },
    correlationId,
    numeroVenda,
  );

  const corrFinal = enq.correlationId || correlationId;

  if (enq.deduplicado && !sync) {
    const st = filaFiscal.obterResultadoEmissao(corrFinal);
    return {
      fiscal: "pending",
      status: enq.status || st?.status || "PENDENTE",
      correlationId: corrFinal,
      numeroVenda,
      async: true,
      deduplicado: true,
    };
  }

  if (!enq.deduplicado) {
    filaFiscal.salvarResultadoEmissao(corrFinal, numeroVenda, "PENDENTE", null, null);
    fiscalMetrics.registrarEnfileirada();
  }

  filaFiscal.dispararProcessamento();

  if (sync) {
    return filaFiscal.aguardarConclusao(
      corrFinal,
      parseInt(process.env.FISCAL_EMISSAO_TIMEOUT_MS || "120000", 10),
    );
  }

  return {
    fiscal: "pending",
    status: "PENDENTE",
    correlationId: corrFinal,
    numeroVenda,
    async: true,
    deduplicado: !!enq.deduplicado,
  };
}

function consultarStatusEmissao(correlationId) {
  return filaFiscal.consultarStatusEmissao(correlationId);
}

async function reimprimirDanfceCompleto(chave, numeroVenda) {
  const doc =
    (chave && filaFiscal.buscarDocumentoPorChave(chave)) ||
    (numeroVenda && filaFiscal.buscarDocumentoPorVenda(numeroVenda));
  if (!doc) throw new Error("Documento fiscal não encontrado localmente");
  const chaveDoc = doc.chave || chave;
  let pdfPath = doc.pdf_path;
  if (!docs.isPdfValid(pdfPath) && chaveDoc) {
    pdfPath = await acbr.gerarPdfDanfce(chaveDoc, doc.xml_path);
    filaFiscal.salvarDocumento({
      chave: chaveDoc,
      numeroVenda: doc.numero_venda || numeroVenda,
      correlationId: doc.correlation_id,
      serieNfe: doc.serie_nfe,
      numeroNfe: doc.numero_nfe,
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
    } catch {
      filaFiscal.enfileirar(
        "CANCELAMENTO",
        { chave, motivo, numeroVenda, correlationId, backendOnly: true, ...res },
        correlationId,
        numeroVenda,
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
    } catch {
      filaFiscal.enfileirar("INUTILIZACAO", { body: { ...body, inutilizacaoId }, res, xmlPath });
    }
  }
  return { ...res, inutilizacaoId, xmlPath };
}

function registrarHandlersFila(lerConfigFn) {
  filaFiscal.registrarHandler("CALLBACK_BACKEND", async (payload) => {
    const cfg = await lerConfigFn();
    await callbackBackend(
      cfg,
      payload.numeroVenda,
      payload.callbackPayload,
      payload.correlationId,
    );
  });

  filaFiscal.registrarHandler("EMISSAO", async (payload, job) => {
    const cfg = await lerConfigFn();
    const correlationId = payload.correlationId || job.correlation_id;
    const numeroVenda = payload.numeroVenda || job.numero_venda;
    filaFiscal.salvarResultadoEmissao(correlationId, numeroVenda, "PROCESSANDO", null, null);
    try {
      const resultado = await emitirCompleto(cfg, payload, job);
      const status = resultado.recuperado ? "CONCLUIDO_RECUPERADO" : "CONCLUIDO";
      filaFiscal.salvarResultadoEmissao(correlationId, numeroVenda, status, resultado, null);
    } catch (err) {
      if (fiscalRetry.isPermanente(err)) {
        filaFiscal.salvarResultadoEmissao(
          correlationId,
          numeroVenda,
          "FALHA_PERMANENTE",
          null,
          err.message,
        );
      } else if (fiscalRetry.isIncerto(err)) {
        filaFiscal.salvarResultadoEmissao(correlationId, numeroVenda, "INCERTO", null, err.message);
      } else {
        filaFiscal.salvarResultadoEmissao(
          correlationId,
          numeroVenda,
          "FALHA_TEMPORARIA",
          null,
          err.message,
        );
      }
      const cnpj =
        payload.empresa?.cnpj || payload.cnpj || cfg.empresa?.cnpj || cfg.cnpj;
      if (!err.rateLimit) {
        fiscalRateLimit.registrarFalha(
          cnpj,
          fiscalRetry.extrairCStat(err),
          job?.tentativas || 1,
        );
      }
      throw err;
    }
  });

  filaFiscal.registrarHandler("GERAR_PDF", async (payload) => {
    const { chave, xmlPath, numeroVenda, correlationId } = payload;
    if (!chave) throw new Error("chave obrigatória para GERAR_PDF");
    const doc = filaFiscal.buscarDocumentoPorChave(chave);
    if (doc?.pdf_path && docs.isPdfValid(doc.pdf_path)) return;
    const t0 = Date.now();
    const pdfPath = await acbr.gerarPdfDanfce(chave, xmlPath || doc?.xml_path);
    fiscalMetrics.registrarEmissao(0, { pdfMs: Date.now() - t0, pdf: true });
    filaFiscal.salvarDocumento({
      chave,
      numeroVenda: numeroVenda || doc?.numero_venda,
      correlationId: correlationId || doc?.correlation_id,
      serieNfe: doc?.serie_nfe,
      numeroNfe: doc?.numero_nfe,
      cStat: doc?.c_stat,
      protocolo: doc?.protocolo,
      xmlPath: xmlPath || doc?.xml_path,
      pdfPath,
      tipo: doc?.tipo || "AUTORIZADA",
    });
  });

  filaFiscal.registrarHandler("CANCELAMENTO", async (payload) => {
    const cfg = await lerConfigFn();
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
    const cfg = await lerConfigFn();
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
  consultarStatusEmissao,
  finalizarEmissaoRecuperada,
  reimprimirDanfceCompleto,
  cancelarCompleto,
  inutilizarCompleto,
  callbackBackend,
  persistirDocumentosFiscais,
  registrarHandlersFila,
  PATHS,
};

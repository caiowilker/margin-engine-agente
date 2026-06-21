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
const { validarPayloadNfe } = require("./fiscalValidacaoNfe");
const { PATHS } = require("./marginPaths");

function inferirModeloDocumento(doc, chave) {
  if (doc?.modelo_documento) return String(doc.modelo_documento);
  return acbr.inferirModeloDaChave(chave || doc?.chave);
}

async function gerarPdfParaModelo(chave, xmlPath, modeloDocumento) {
  const modelo = String(modeloDocumento || "65");
  if (modelo === "55") return acbr.gerarPdfDanfe(chave, xmlPath);
  return acbr.gerarPdfDanfce(chave, xmlPath);
}

function deveGerarPdfSincrono(resultado) {
  return GERAR_PDF_EMIT || resultado?.modeloDocumento === "55";
}

/** PDF DANFC-e via ACBr — desligado por padrão (cupom térmico ESC/POS pelo agente). */
const GERAR_PDF_HABILITADO =
  (process.env.FISCAL_GERAR_PDF || "false").toLowerCase() === "true";
const GERAR_PDF_EMIT =
  GERAR_PDF_HABILITADO &&
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
    pdfPendente: GERAR_PDF_HABILITADO && !GERAR_PDF_EMIT,
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

  if (GERAR_PDF_HABILITADO && !GERAR_PDF_EMIT && resultado.modeloDocumento !== "55") {
    filaFiscal.enfileirar(
      "GERAR_PDF",
      {
        chave: resultado.chave,
        xmlPath,
        numeroVenda,
        correlationId,
        modeloDocumento: resultado.modeloDocumento || "65",
      },
      correlationId,
      numeroVenda,
    );
  } else if (resultado.modeloDocumento === "55" && !GERAR_PDF_EMIT) {
    filaFiscal.enfileirar(
      "GERAR_PDF",
      {
        chave: resultado.chave,
        xmlPath,
        numeroVenda,
        correlationId,
        modeloDocumento: "55",
      },
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
    pdfPendente: GERAR_PDF_HABILITADO && !GERAR_PDF_EMIT,
    numeroVenda,
  };
}

async function persistirDocumentosFiscais(cfg, numeroVenda, correlationId, resultado) {
  if (deveGerarPdfSincrono(resultado)) {
    fiscalStorage.exigirEspacoParaEscrita();
    let xmlPath = null;
    let pdfPath = null;
    let pdfErro = null;
    if (resultado.xml) {
      xmlPath = docs.salvarXmlAutorizado(resultado.chave, resultado.xml);
    }
    const tPdf = Date.now();
    try {
      pdfPath = await gerarPdfParaModelo(
        resultado.chave,
        xmlPath,
        resultado.modeloDocumento || "65",
      );
      fiscalMetrics.registrarEmissao(0, { pdfMs: Date.now() - tPdf, pdf: true });
    } catch (err) {
      pdfErro = err.message || String(err);
      fiscalMetrics.registrarEmissao(0, { pdfMs: Date.now() - tPdf, pdf: false });
    }
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
      modeloDocumento: resultado.modeloDocumento || "65",
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
      modeloDocumento: resultado.modeloDocumento || "65",
      pdfPendente: !pdfPath && !!pdfErro,
      pdfErro,
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
    return {
      ...resultado,
      xmlPath,
      pdfPath,
      pdfContentBase64,
      pdfPendente: !pdfPath && !!pdfErro,
      pdfErro,
      numeroVenda,
    };
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
  const isNfe55 =
    payload.modeloDocumento === "55" ||
    payload.modelo === 55 ||
    payload.modelo === "55";
  const modelo = isNfe55 ? fiscalNumeracao.MODELO_NFE : fiscalNumeracao.MODELO_NFCE;
  const serie = payload.serieNfe
    || (isNfe55 ? fiscalNumeracao.SERIE_NFE_55 : fiscalNumeracao.SERIE_PADRAO);
  const res = fiscalNumeracao.reservarProximoNumero(serie, modelo);
  const meta = {
    numeroNfe: String(res.numero),
    serieNfe: res.serie,
    modeloDocumento: modelo,
    reservadoEm: new Date().toISOString(),
  };
  filaFiscal.atualizarPayload(job.id, {
    _fiscalMeta: meta,
    numeroNfe: meta.numeroNfe,
    serieNfe: meta.serieNfe,
    modeloDocumento: modelo,
  });
  return meta;
}

function isPayloadNfe55(payload) {
  return (
    payload?.modeloDocumento === "55" ||
    payload?.modelo === 55 ||
    payload?.modelo === "55"
  );
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
  const nfe55 = isPayloadNfe55(payload);
  try {
    const tAcbr = Date.now();
    resultado = nfe55
      ? await acbr.emitirNfe(payload)
      : await acbr.emitirNfce(payload);
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
      modeloDocumento: body.modeloDocumento || "65",
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
    modeloDocumento: body.modeloDocumento || "65",
  };
}

async function enfileirarEmissaoNfe(cfg, body, opts = {}) {
  if (!acbr.isNfeModelo55Habilitado()) {
    const err = new Error(
      "NF-e modelo 55 desabilitada (ACBR_NFE_ENABLED ou EMISSAO_FISCAL)",
    );
    err.permanente = true;
    throw err;
  }
  const destinatario = validarPayloadNfe(body);
  return enfileirarEmissao(
    cfg,
    { ...body, modeloDocumento: "55", destinatario },
    opts,
  );
}

function consultarStatusEmissao(correlationId) {
  const st = filaFiscal.consultarStatusEmissao(correlationId);
  const modelo =
    st.resultado?.modeloDocumento ||
    extrairModeloJob(correlationId) ||
    "65";
  return { ...st, modeloDocumento: modelo };
}

function extrairModeloJob(correlationId) {
  try {
    const job = filaFiscal.obterJobEmissao(correlationId);
    if (!job?.payload) return null;
    const p = JSON.parse(job.payload);
    return p.modeloDocumento || (isPayloadNfe55(p) ? "55" : "65");
  } catch {
    return null;
  }
}

async function reimprimirDanfceCompleto(chave, numeroVenda) {
  const doc =
    (chave && filaFiscal.buscarDocumentoPorChave(chave)) ||
    (numeroVenda && filaFiscal.buscarDocumentoPorVenda(numeroVenda));
  if (!doc) throw new Error("Documento fiscal não encontrado localmente");
  const chaveDoc = doc.chave || chave;
  const modelo = inferirModeloDocumento(doc, chaveDoc);
  let pdfPath = doc.pdf_path;
  if (!docs.isPdfValid(pdfPath) && chaveDoc) {
    pdfPath = await gerarPdfParaModelo(chaveDoc, doc.xml_path, modelo);
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
      modeloDocumento: modelo,
    });
  }
  if (modelo === "65") {
    await acbr.imprimirDanfce(chaveDoc);
  }
  return {
    ok: true,
    chave: chaveDoc,
    pdfPath,
    tipo: modelo === "55" ? "danfe" : "danfce",
    modeloDocumento: modelo,
  };
}

async function obterPdfDocumento(chave, numeroVenda) {
  const doc =
    (chave && filaFiscal.buscarDocumentoPorChave(chave)) ||
    (numeroVenda && filaFiscal.buscarDocumentoPorVenda(numeroVenda));
  const chaveDoc = doc?.chave || chave;
  if (!chaveDoc && !numeroVenda) {
    throw new Error("Informe chave ou numeroVenda");
  }
  const modelo = inferirModeloDocumento(doc, chaveDoc);
  let pdfPath = doc?.pdf_path;
  if (!docs.isPdfValid(pdfPath)) {
    if (!doc?.xml_path && !chaveDoc) {
      throw new Error("PDF não disponível — documento fiscal não encontrado");
    }
    pdfPath = await gerarPdfParaModelo(
      chaveDoc,
      doc?.xml_path,
      modelo,
    );
    if (doc) {
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
        modeloDocumento: modelo,
      });
    }
  }
  const buffer = docs.lerArquivo(pdfPath);
  if (!buffer || buffer.length < 128) {
    throw new Error("PDF inválido ou corrompido");
  }
  return { pdfPath, buffer, modeloDocumento: modelo, chave: chaveDoc };
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
    const { chave, xmlPath, numeroVenda, correlationId, modeloDocumento } =
      payload;
    if (!chave) throw new Error("chave obrigatória para GERAR_PDF");
    const doc = filaFiscal.buscarDocumentoPorChave(chave);
    const modelo =
      modeloDocumento || inferirModeloDocumento(doc, chave);
    if (!GERAR_PDF_HABILITADO && modelo !== "55") return;
    if (doc?.pdf_path && docs.isPdfValid(doc.pdf_path)) return;
    const t0 = Date.now();
    const pdfPath = await gerarPdfParaModelo(
      chave,
      xmlPath || doc?.xml_path,
      modelo,
    );
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
      modeloDocumento: modelo,
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

  if (!GERAR_PDF_HABILITADO) {
    const n = filaFiscal.descartarJobsGerarPdfPendentes();
    if (n > 0) {
      console.log(
        `[Fila fiscal] ${n} job(s) GERAR_PDF descartado(s) — FISCAL_GERAR_PDF=false`,
      );
    }
  }
}

module.exports = {
  emitirCompleto,
  enfileirarEmissao,
  enfileirarEmissaoNfe,
  consultarStatusEmissao,
  finalizarEmissaoRecuperada,
  reimprimirDanfceCompleto,
  obterPdfDocumento,
  inferirModeloDocumento,
  gerarPdfParaModelo,
  cancelarCompleto,
  inutilizarCompleto,
  callbackBackend,
  persistirDocumentosFiscais,
  registrarHandlersFila,
  PATHS,
};

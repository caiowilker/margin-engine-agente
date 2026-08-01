// Orquestração fiscal local — emissão idempotente, recovery, sem token em SQLite
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const fiscalDriver = require("./fiscalDriver");
const factory = require("./fiscal/factory");
const docs = require("./documentosFiscais");
const filaFiscal = require("./filaFiscal");
const fiscalPreflight = require("./fiscalPreflight");
const fiscalRetry = require("./fiscalRetry");
const fiscalMetrics = require("./fiscalMetrics");
const fiscalRateLimit = require("./fiscalRateLimit");
const ufRateLimit = require("./fiscal/ufRateLimit");
const fiscalRecuperacao = require("./fiscalRecuperacao");
const fiscalStorage = require("./fiscalStorage");
const fiscalNumeracao = require("./fiscalNumeracao");
const fiscalTrace = require("./fiscalTraceLog");
const { validarPayloadNfe } = require("./fiscalValidacaoNfe");
const { validarPayloadNfse } = require("./fiscal/nfse/nfseValidate");
const { montarCallbackBackendNfse } = require("./fiscal/nfse/nfseCallback");
const { PATHS } = require("./marginPaths");

function inferirModeloDocumento(doc, chave) {
  if (doc?.modelo_documento) return String(doc.modelo_documento);
  if (doc?.modeloDocumento) return String(doc.modeloDocumento);
  return fiscalDriver.inferirModeloDaChave(chave || doc?.chave);
}

let _lerConfigFn = null;

function lerConteudoXmlAutorizado(xmlPath) {
  if (!xmlPath) return null;
  const buf = docs.lerArquivo(xmlPath);
  return buf ? buf.toString("utf8") : null;
}

async function resolverXmlParaCallback(chave, xmlPathHint) {
  try {
    const pathAuth = await garantirXmlAutorizado(chave, xmlPathHint);
    return { xmlPath: pathAuth, xmlContent: lerConteudoXmlAutorizado(pathAuth) };
  } catch (_) {
    if (xmlPathHint) {
      const xmlContent = lerConteudoXmlAutorizado(xmlPathHint);
      if (xmlContent && docs.xmlEstaAutorizado(xmlContent)) {
        return { xmlPath: xmlPathHint, xmlContent };
      }
    }
    return { xmlPath: xmlPathHint || null, xmlContent: null };
  }
}

const { isCStatAutorizado } = require("./fiscalDriverResposta");

function derivarStatusFiscal(cStat) {
  const cs = String(cStat || "");
  if (cs === "100" || cs === "150") return "AUTORIZADA";
  if (cs === "103" || cs === "104") return "PENDENTE_SEFAZ";
  return "REJEITADA";
}

function montarCallbackPayload(params) {
  const {
    correlationId,
    chave,
    numeroNfe,
    serieNfe,
    protocolo,
    cStat,
    xMotivo,
    qrcode,
    xmlContent,
    xmlPath,
    pdfPath,
    pdfContentBase64,
    modeloDocumento,
    pdfPendente,
    pdfErro,
    recuperado,
  } = params;
  return {
    correlationId,
    chaveNfe: chave,
    numeroNfe,
    serieNfe,
    qrcode: qrcode || null,
    protocolo,
    cStat: cStat || null,
    xMotivo: xMotivo || null,
    statusFiscal: derivarStatusFiscal(cStat),
    xmlContent: xmlContent || null,
    xmlPath: xmlPath || null,
    pdfPath: pdfPath || null,
    pdfContentBase64: pdfContentBase64 || null,
    contentType: "application/xml",
    modeloDocumento: modeloDocumento || inferirModeloDocumento(null, chave),
    pdfPendente: !!pdfPendente,
    pdfErro: pdfErro || null,
    recuperado: !!recuperado,
  };
}

async function enviarCallbackDocumentosFiscais(cfg, numeroVenda, correlationId, payload) {
  if (!cfg?.backendUrl || !numeroVenda) return;
  try {
    await callbackBackend(cfg, numeroVenda, payload, correlationId);
  } catch {
    filaFiscal.enfileirar(
      "CALLBACK_BACKEND",
      { numeroVenda, callbackPayload: payload, correlationId },
      correlationId,
      numeroVenda,
    );
  }
}

async function garantirXmlAutorizado(chave, xmlPathHint) {
  const k = String(chave || "").replace(/\D/g, "");
  if (k.length !== 44) {
    throw new Error("Chave inválida para gerar DANFE");
  }

  const candidato = docs.resolverXmlParaImpressao(k, xmlPathHint);
  if (candidato) {
    const buf = docs.lerArquivo(candidato);
    if (buf && docs.xmlEstaAutorizado(buf.toString("utf8"))) {
      return candidato;
    }
  }

  const local = docs.localizarXmlPorChave(k);
  if (local?.path && docs.xmlEstaAutorizado(local.xml)) {
    return local.path;
  }

  try {
    const consulta = await fiscalDriver.consultarChave(k);
    const cs = String(consulta.cStat || "");
    if (
      consulta.situacao === "AUTORIZADA" ||
      cs === "100" ||
      cs === "150"
    ) {
      const aposConsulta = docs.localizarXmlPorChave(k);
      if (aposConsulta?.path && docs.xmlEstaAutorizado(aposConsulta.xml)) {
        return aposConsulta.path;
      }
      const xmlConsulta = docs.extrairXmlDaResposta(consulta.raw);
      if (xmlConsulta && docs.xmlEstaAutorizado(xmlConsulta)) {
        const salvo = docs.salvarXmlAutorizado(k, xmlConsulta);
        if (salvo) return salvo;
      }
    }
  } catch (_) {
    /* consulta indisponível */
  }

  throw new Error(
    "XML autorizado com protocolo SEFAZ não encontrado — aguarde a confirmação da nota ou tente novamente.",
  );
}

async function gerarPdfParaModelo(chave, xmlPath, modeloDocumento) {
  const modelo = String(modeloDocumento || "65");
  const xmlAutorizado = await garantirXmlAutorizado(chave, xmlPath);
  return gerarPdfComXml(chave, xmlAutorizado, modelo);
}

async function gerarPdfComXml(chave, xmlPathAutorizado, modeloDocumento, formatoPdf = "termico") {
  const modelo = String(modeloDocumento || "65");
  const opts = { formatoPdf };
  if (modelo === "55") return fiscalDriver.gerarPdfDanfe(chave, xmlPathAutorizado);
  return fiscalDriver.gerarPdfDanfce(chave, xmlPathAutorizado, opts);
}

function deveGerarPdfSincrono(resultado) {
  // PDF síncrono só com opt-in explícito — NF-e 55 usa fila GERAR_PDF para não
  // bloquear CONCLUIDO (DANFE via ACBr pode levar minutos no Windows).
  if (GERAR_PDF_EMIT) return true;
  void resultado;
  return false;
}

function agendarCallbackBackend(cfg, numeroVenda, correlationId, callbackPayload, opts = {}) {
  filaFiscal.enfileirar(
    "CALLBACK_BACKEND",
    {
      numeroVenda,
      correlationId,
      callbackPayload,
      nfse: !!opts.nfse,
    },
    correlationId,
    numeroVenda,
  );
  filaFiscal.dispararProcessamento();
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

async function callbackBackend(cfg, numeroVenda, payload, correlationId, opts = {}) {
  const t0 = Date.now();
  const base = cfg.backendUrl.replace(/\/$/, "");
  const url = opts.nfse
    ? `${base}/pdv/nfse/rps/${encodeURIComponent(numeroVenda)}/fiscal/resultado`
    : `${base}/pdv/vendas/${encodeURIComponent(numeroVenda)}/fiscal/resultado`;
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

/** Fail-safe PDV — mantém venda como PENDENTE_FISCAL no backend após falha recuperável/cadastro. */
async function notificarPendenciaFiscalFailSafe(numeroVenda, correlationId, err) {
  if (!_lerConfigFn || !numeroVenda) return;
  if (fiscalRetry.isIncerto(err)) return;
  const cfg = await _lerConfigFn();
  if (!cfg?.backendUrl || !cfg?.backendToken) return;
  const fiscalMotivo = require("./fiscal/fiscalMotivo");
  const meta = fiscalMotivo.classificarDeErro(err);
  const payload = {
    correlationId,
    statusFiscal: fiscalMotivo.statusFiscalFailSafe(err),
    cStat: meta.cStat || fiscalRetry.extrairCStat(err),
    xMotivo: err?.message || String(err),
  };
  const log = require("./logger").child({ modulo: "fiscal_fail_safe" });
  try {
    await callbackBackend(cfg, numeroVenda, payload, correlationId);
    log.info(
      { numeroVenda, correlationId, motivoFiscal: meta.motivoFiscal, recuperavel: meta.recuperavel },
      "Fail-safe: venda mantida como pendência fiscal no backend",
    );
  } catch (cbErr) {
    log.warn(
      { err: cbErr.message, numeroVenda, correlationId },
      "Fail-safe: falha ao notificar pendência fiscal",
    );
  }
}

async function persistirAposAutorizacao(cfg, numeroVenda, correlationId, resultado) {
  if (!isCStatAutorizado(resultado.cStat)) {
    const err = new Error(
      `NF-e aguardando confirmação SEFAZ (cStat ${resultado.cStat || "?"}): ${resultado.xMotivo || "lote em processamento"}`,
    );
    err.cStat = String(resultado.cStat || "104");
    err.incerto = true;
    err.permanente = false;
    err.chaveConsulta = resultado.chave;
    throw err;
  }
  fiscalStorage.exigirEspacoParaEscrita();
  const modelo = resultado.modeloDocumento || inferirModeloDocumento(null, resultado.chave);
  let xmlPath = null;
  if (resultado.xml) {
    xmlPath = docs.salvarXmlAutorizado(resultado.chave, resultado.xml);
  } else if (resultado.xmlPath) {
    xmlPath = resultado.xmlPath;
  }
  const xmlResolvido = await resolverXmlParaCallback(resultado.chave, xmlPath);
  xmlPath = xmlResolvido.xmlPath || xmlPath;

  let pdfPath = resultado.pdfPath || null;
  if (!pdfPath && resultado.chave) {
    const encontrado = docs.localizarPdfPorChave(resultado.chave, modelo);
    if (encontrado) {
      pdfPath = docs.copiarPdfParaCanonico(resultado.chave, encontrado, modelo);
    }
  }
  const pdfContentBase64 =
    pdfPath && docs.isPdfValid(pdfPath) ? docs.lerArquivoBase64(pdfPath) : null;

  filaFiscal.salvarDocumento({
    chave: resultado.chave,
    numeroVenda,
    correlationId,
    serieNfe: resultado.serie || resultado.serieNfe,
    numeroNfe: resultado.numero || resultado.numeroNfe,
    cStat: resultado.cStat,
    protocolo: resultado.protocolo,
    xmlPath,
    pdfPath,
    tipo: "AUTORIZADA",
    modeloDocumento: modelo,
  });

  const callbackPayload = montarCallbackPayload({
    correlationId,
    chave: resultado.chave,
    numeroNfe: resultado.numero || resultado.numeroNfe,
    serieNfe: resultado.serie || resultado.serieNfe,
    qrcode: resultado.qrcode || resultado.qrcodeNfe,
    protocolo: resultado.protocolo,
    cStat: resultado.cStat,
    xMotivo: resultado.xMotivo,
    xmlContent: xmlResolvido.xmlContent || resultado.xml || null,
    xmlPath,
    pdfPath,
    pdfContentBase64,
    modeloDocumento: modelo,
    pdfPendente: !pdfPath && GERAR_PDF_HABILITADO && !GERAR_PDF_EMIT,
    recuperado: !!resultado.recuperado,
  });

  agendarCallbackBackend(cfg, numeroVenda, correlationId, callbackPayload);

  if (GERAR_PDF_HABILITADO && !GERAR_PDF_EMIT && !pdfPath && resultado.chave && xmlPath) {
    filaFiscal.enfileirar(
      "GERAR_PDF",
      {
        chave: resultado.chave,
        xmlPath,
        numeroVenda,
        correlationId,
        modeloDocumento: modelo,
      },
      correlationId,
      numeroVenda,
    );
  }

  filaFiscal.dispararProcessamento();

  return {
    ...resultado,
    xmlPath,
    pdfPath,
    pdfContentBase64,
    pdfPendente: !pdfPath && GERAR_PDF_HABILITADO && !GERAR_PDF_EMIT,
    numeroVenda,
  };
}

async function persistirDocumentosFiscais(cfg, numeroVenda, correlationId, resultado) {
  if (!isCStatAutorizado(resultado.cStat)) {
    const err = new Error(
      `NF-e aguardando confirmação SEFAZ (cStat ${resultado.cStat || "?"}): ${resultado.xMotivo || "lote em processamento"}`,
    );
    err.cStat = String(resultado.cStat || "104");
    err.incerto = true;
    err.permanente = false;
    err.chaveConsulta = resultado.chave;
    throw err;
  }
  if (deveGerarPdfSincrono(resultado)) {
    fiscalStorage.exigirEspacoParaEscrita();
    const modelo = resultado.modeloDocumento || inferirModeloDocumento(null, resultado.chave);
    let xmlPath = null;
    let pdfPath = null;
    let pdfErro = null;
    if (resultado.xml) {
      xmlPath = docs.salvarXmlAutorizado(resultado.chave, resultado.xml);
    }
    const xmlResolvido = await resolverXmlParaCallback(resultado.chave, xmlPath);
    xmlPath = xmlResolvido.xmlPath || xmlPath;
    const tPdf = Date.now();
    try {
      pdfPath = await gerarPdfParaModelo(resultado.chave, xmlPath, modelo);
      fiscalMetrics.registrarEmissao(0, { pdfMs: Date.now() - tPdf, pdf: true });
    } catch (err) {
      pdfErro = err.message || String(err);
      fiscalMetrics.registrarEmissao(0, { pdfMs: Date.now() - tPdf, pdf: false });
    }
    if (!pdfPath && resultado.chave) {
      const encontrado = docs.localizarPdfPorChave(resultado.chave, modelo);
      if (encontrado) {
        pdfPath = docs.copiarPdfParaCanonico(resultado.chave, encontrado, modelo);
        pdfErro = null;
      }
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
      modeloDocumento: modelo,
    });
    const callbackPayload = montarCallbackPayload({
      correlationId,
      chave: resultado.chave,
      numeroNfe: resultado.numero,
      serieNfe: resultado.serie,
      qrcode: resultado.qrcode,
      protocolo: resultado.protocolo,
      cStat: resultado.cStat,
      xMotivo: resultado.xMotivo,
      xmlContent: xmlResolvido.xmlContent || resultado.xml || null,
      xmlPath,
      pdfPath,
      pdfContentBase64,
      modeloDocumento: modelo,
      pdfPendente: !pdfPath && !!pdfErro,
      pdfErro,
      recuperado: !!resultado.recuperado,
    });
    agendarCallbackBackend(cfg, numeroVenda, correlationId, callbackPayload);

    if (!pdfPath && resultado.chave && xmlPath) {
      filaFiscal.enfileirar(
        "GERAR_PDF",
        {
          chave: resultado.chave,
          xmlPath,
          numeroVenda,
          correlationId,
          modeloDocumento: modelo,
        },
        correlationId,
        numeroVenda,
      );
      filaFiscal.dispararProcessamento();
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

const MAX_BUMP_539 = parseInt(process.env.FISCAL_MAX_BUMP_539 || "10", 10);

function enriquecerChaveConsulta539(err) {
  if (!err.chaveConsulta) {
    err.chaveConsulta =
      fiscalRetry.extrairChaveMotivoDuplicidade(err.message) ||
      fiscalRetry.extrairChaveMotivoDuplicidade(err.acbrRaw);
  }
  return err;
}

async function consultarRecuperacao539(body, payload, err) {
  enriquecerChaveConsulta539(err);
  if (!err.chaveConsulta) return null;
  try {
    return await fiscalRecuperacao.verificarAntesDeEmitir({
      ...body,
      chave: err.chaveConsulta,
      chaveConsulta: err.chaveConsulta,
      numeroNfe: payload.numeroNfe,
      serieNfe: payload.serieNfe,
      correlationId: body.correlationId || payload.correlationId,
      modoDuplicidade539: true,
    });
  } catch (consultErr) {
    fiscalTrace.warn("Recovery539", "Consulta SEFAZ falhou — segue bump de numeração", {
      chave: err.chaveConsulta,
      err: consultErr.message,
    });
    return null;
  }
}

function finalizarErro539Esgotado(err, numeroVenda) {
  enriquecerChaveConsulta539(err);
  err.duplicidade539 = true;
  err.permanente = true;
  err.esgotouRecuperacao539 = true;
  err.mensagemAcao =
    "Duplicidade de numeração na SEFAZ — use Diagnóstico → Reprocessar fila ou inutilize a faixa ocupada em homologação.";
  fiscalTrace.error("Recovery539", "Recuperação 539 esgotada", {
    numeroVenda,
    chave: err.chaveConsulta,
    cStat: fiscalRetry.extrairCStat(err),
    tentativas: MAX_BUMP_539,
  });
  return err;
}

function alinharNumeroOcupadoDuplicidade(err, payload, serie, modelo) {
  if (err.chaveConsulta) {
    return fiscalNumeracao.sincronizarNumeroDuplicidade539(
      err.chaveConsulta,
      serie,
      modelo,
    );
  }
  const n = parseInt(String(payload.numeroNfe || payload._fiscalMeta?.numeroNfe || "").replace(/\D/g, ""), 10);
  if (Number.isFinite(n) && n > 0) {
    fiscalNumeracao.sincronizarNumeroAutorizado(serie, n, modelo);
    return n;
  }
  return null;
}

async function tentarRecuperar539ComBump(
  cfg,
  body,
  job,
  payload,
  nfe55,
  activeDriver,
  inicio,
  errInicial,
) {
  const { numeroVenda, correlationId } = body;
  const modelo = nfe55 ? fiscalNumeracao.MODELO_NFE : fiscalNumeracao.MODELO_NFCE;
  const serie =
    payload.serieNfe ||
    payload._fiscalMeta?.serieNfe ||
    (nfe55 ? fiscalNumeracao.SERIE_NFE_55 : fiscalNumeracao.SERIE_PADRAO);

  let err = errInicial;
  err.duplicidade539 = true;
  err.permanente = false;
  for (
    let bump = 0;
    bump < MAX_BUMP_539 && fiscalRetry.isErroDuplicidade539(err);
    bump++
  ) {
    enriquecerChaveConsulta539(err);
    const rec = await consultarRecuperacao539(body, payload, err);
    if (rec?.chave) {
      fiscalTrace.trace("Recovery539", "Nota recuperada via consulta SEFAZ", {
        numeroVenda,
        chave: rec.chave,
        bump,
      });
      fiscalMetrics.registrarEmissao(Date.now() - inicio, {
        recuperada: true,
        ok: true,
        retry539: bump,
      });
      return finalizarEmissaoRecuperada(cfg, numeroVenda, correlationId, rec);
    }

    const ocupado = alinharNumeroOcupadoDuplicidade(err, payload, serie, modelo);
    if (ocupado != null) {
      fiscalTrace.trace("Recovery539", "Numeração alinhada à chave duplicada", {
        numeroVenda,
        chave: err.chaveConsulta || null,
        numeroOcupado: ocupado,
        cStat: fiscalRetry.extrairCStat(err),
        bump,
      });
    }

    const nova = fiscalNumeracao.reservarProximoNumero(serie, modelo);
    payload.numeroNfe = String(nova.numero);
    payload.serieNfe = nova.serie;
    payload._539Retried = true;
    payload._fiscalMeta = {
      ...(payload._fiscalMeta || {}),
      numeroNfe: payload.numeroNfe,
      serieNfe: payload.serieNfe,
      modeloDocumento: modelo,
    };
    if (job) {
      filaFiscal.atualizarPayload(job.id, {
        numeroNfe: payload.numeroNfe,
        serieNfe: payload.serieNfe,
        _539Retried: true,
        _fiscalMeta: payload._fiscalMeta,
      });
    }
    fiscalTrace.trace("Recovery539", "Reemissão com novo número", {
      numeroVenda,
      numeroNfe: payload.numeroNfe,
      bump: bump + 1,
      max: MAX_BUMP_539,
    });

    try {
      const tRetry = Date.now();
      const resultado = nfe55
        ? await activeDriver.emitirNfe(payload)
        : await activeDriver.emitirNfce(payload);
      fiscalMetrics.registrarEmissao(Date.now() - inicio, {
        ok: true,
        cStat: resultado.cStat || "100",
        fiscalDriverMs: Date.now() - tRetry,
        sefazMs: Date.now() - tRetry,
        retry539: bump + 1,
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
      return persistirDocumentosFiscais(cfg, numeroVenda, correlationId, resultado);
    } catch (retryErr) {
      err = retryErr;
    }
  }
  return finalizarErro539Esgotado(err, numeroVenda);
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
  // XML canônico (acbr/xml) é fonte de verdade; backup não entra na numeração.
  const maxXml = fiscalNumeracao.bootstrapDesdeXmlCanonicos(serie, modelo);
  if (maxXml === 0) {
    const maxAutorizadoDb = filaFiscal.maiorNumeroNfeSerie(serie);
    const ultimo = fiscalNumeracao.consultarUltimo(serie, modelo);
    if (maxAutorizadoDb > ultimo) {
      fiscalNumeracao.sincronizarNumeroAutorizado(serie, maxAutorizadoDb, modelo);
    }
  }
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

function isPayloadNfse99(payload) {
  return (
    payload?.modeloDocumento === "99" ||
    payload?.modelo === 99 ||
    payload?.modelo === "99"
  );
}

function resolverDriverFiscal(body) {
  const hint = body?.acbrDriver || body?._fiscalMeta?.acbrDriver;
  if (hint === "lib") {
    return factory.createDriver("lib");
  }
  return fiscalDriver;
}

/** @deprecated use resolverDriverFiscal */
function resolverDriverEmissao(body) {
  return resolverDriverFiscal(body);
}

async function emitirCompleto(cfg, body, job = null) {
  if (isPayloadNfse99(body)) {
    return emitirCompletoNfse(cfg, body, job);
  }
  const activeDriver = resolverDriverEmissao(body);
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

  // Rate-limit por UF (token-bucket) — adia o job se a UF estiver com burst esgotado
  const uf = ufRateLimit.extrairUf(payload);
  if (uf) {
    const rlUf = ufRateLimit.consumir(uf);
    if (!rlUf.ok) {
      fiscalMetrics.registrarBloqueioUf(uf);
      // Adia o job sem marcar como erro: agenda retry com jitter embutido
      if (job) {
        const proxima = new Date(Date.now() + rlUf.aguardarMs).toISOString();
        filaFiscal.adiarJob(job.id, proxima, "rate-limit-uf");
      }
      const e = new Error(rlUf.motivo);
      e.rateLimitUf = true;
      e.aguardarMs = rlUf.aguardarMs;
      e.uf = uf;
      throw e;
    }
  }

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
      ? await activeDriver.emitirNfe(payload)
      : await activeDriver.emitirNfce(payload);
    const fiscalDriverMs = Date.now() - tAcbr;
    fiscalMetrics.registrarEmissao(Date.now() - inicio, {
      ok: true,
      cStat: resultado.cStat || "100",
      fiscalDriverMs,
      sefazMs: fiscalDriverMs,
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
    enriquecerChaveConsulta539(err);
    let rec = null;
    try {
      rec = await consultarRecuperacao539(body, payload, err);
    } catch (_) {
      rec = null;
    }
    if (rec?.chave) {
      fiscalMetrics.registrarEmissao(Date.now() - inicio, { recuperada: true, ok: true });
      return finalizarEmissaoRecuperada(cfg, numeroVenda, correlationId, rec);
    }

    if (fiscalRetry.isErroDuplicidade539(err)) {
      const out539 = await tentarRecuperar539ComBump(
        cfg,
        body,
        job,
        payload,
        nfe55,
        activeDriver,
        inicio,
        err,
      );
      if (out539?.chave) {
        return out539;
      }
      if (out539 && typeof out539 === "object" && out539.message) {
        err = out539;
      }
      if (err.esgotouRecuperacao539) {
        await notificarPendenciaFiscalFailSafe(numeroVenda, correlationId, err);
      }
    }
    if (err.incerto && job) {
      const patch = {};
      if (err.chaveConsulta) {
        patch.chaveConsulta = err.chaveConsulta;
        patch._fiscalMeta = {
          ...(payload._fiscalMeta || {}),
          chave: err.chaveConsulta,
          cStat: fiscalRetry.extrairCStat(err) || "104",
        };
        const localXml = docs.localizarXmlPorChave(err.chaveConsulta);
        filaFiscal.salvarDocumento({
          chave: err.chaveConsulta,
          numeroVenda,
          correlationId,
          serieNfe: payload.serieNfe || payload._fiscalMeta?.serieNfe,
          numeroNfe: payload.numeroNfe || payload._fiscalMeta?.numeroNfe,
          cStat: fiscalRetry.extrairCStat(err) || "104",
          protocolo: null,
          xmlPath: localXml?.path || null,
          tipo: "PENDENTE_AUTORIZACAO",
          modeloDocumento: payload.modeloDocumento || "65",
        });
      }
      if (Object.keys(patch).length) {
        filaFiscal.atualizarPayload(job.id, patch);
      }
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

  if (!resultado || resultado.fiscal === false) {
    const err = new Error(
      "Emissão fiscal desabilitada ou indisponível no agente (EMISSAO_FISCAL)",
    );
    err.permanente = true;
    throw err;
  }

  return persistirDocumentosFiscais(cfg, numeroVenda, correlationId, resultado);
}

async function emitirCompletoNfse(cfg, body, job = null) {
  const activeDriver = resolverDriverEmissao(body);
  const numeroRps = String(body.numeroRps || body.numeroVenda || "");
  const correlationId = body.correlationId;
  if (!numeroRps) throw new Error("numeroRps obrigatório");

  const { numeroVenda: _nv, numeroRps: _nr, correlationId: _cid, ...payload } = body;

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

  const inicio = Date.now();
  let resultado;
  try {
    if (typeof activeDriver.emitirNfse !== "function") {
      throw new Error("Driver fiscal não suporta NFS-e neste agente");
    }
    resultado = await activeDriver.emitirNfse({ ...payload, numeroRps, correlationId });
    fiscalMetrics.registrarEmissao(Date.now() - inicio, {
      ok: true,
      cStat: resultado.cStat || "100",
      modelo: "99",
    });
  } catch (err) {
    fiscalRateLimit.registrarFalha(cnpj, fiscalRetry.extrairCStat(err), 1);
    fiscalMetrics.registrarEmissao(Date.now() - inicio, {
      falha: true,
      cStat: fiscalRetry.extrairCStat(err),
      modelo: "99",
    });
    throw err;
  }

  if (!resultado || resultado.fiscal === false) {
    const err = new Error(
      "Emissão NFS-e desabilitada ou indisponível (NFSE_ENABLED / EMISSAO_FISCAL)",
    );
    err.permanente = true;
    throw err;
  }

  return persistirDocumentosNfse(cfg, numeroRps, correlationId, resultado);
}

async function persistirDocumentosNfse(cfg, numeroRps, correlationId, resultado) {
  if (!isCStatAutorizado(resultado.cStat)) {
    const err = new Error(
      `NFS-e aguardando confirmação (cStat ${resultado.cStat || "?"}): ${resultado.xMotivo || "processando"}`,
    );
    err.cStat = String(resultado.cStat || "104");
    err.incerto = true;
    err.permanente = false;
    err.chaveConsulta = resultado.chave;
    throw err;
  }

  fiscalStorage.exigirEspacoParaEscrita();
  let xmlPath = null;
  if (resultado.xml) {
    xmlPath = docs.salvarXmlAutorizado(resultado.chave, resultado.xml);
  } else if (resultado.xmlPath) {
    xmlPath = resultado.xmlPath;
  }
  const xmlResolvido = await resolverXmlParaCallback(resultado.chave, xmlPath);
  xmlPath = xmlResolvido.xmlPath || xmlPath;

  filaFiscal.salvarDocumento({
    chave: resultado.chave,
    numeroVenda: numeroRps,
    correlationId,
    serieNfe: resultado.serie || resultado.serieRps,
    numeroNfe: resultado.numero || resultado.numeroNfse,
    cStat: resultado.cStat,
    protocolo: resultado.protocolo,
    xmlPath,
    pdfPath: null,
    tipo: "AUTORIZADA",
    modeloDocumento: "99",
  });

  const callbackPayload = montarCallbackBackendNfse(
    resultado,
    correlationId,
    xmlResolvido.xmlContent || resultado.xml || null,
  );

  agendarCallbackBackend(cfg, numeroRps, correlationId, callbackPayload, { nfse: true });
  filaFiscal.dispararProcessamento();

  return {
    ...resultado,
    xmlPath,
    numeroRps,
    modeloDocumento: "99",
  };
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

  fiscalTrace.trace("Fila", "Emissão enfileirada", {
    numeroVenda,
    correlationId: enq.correlationId || correlationId,
    modelo: body.modeloDocumento || "65",
    sync,
    deduplicado: !!enq.deduplicado,
  });

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
  const nfeEnvOk =
    (process.env.ACBR_NFE_ENABLED || "true").toLowerCase() === "true";
  if (!nfeEnvOk) {
    const err = new Error(
      "NF-e modelo 55 desabilitada (ACBR_NFE_ENABLED ou EMISSAO_FISCAL)",
    );
    err.permanente = true;
    throw err;
  }
  const forcar = body?.forcarEmissao === true;
  if (!forcar && !fiscalDriver.EMISSAO_FISCAL) {
    try {
      require("./fiscalLocalConfig").garantirEmissaoFiscalAtiva();
    } catch (_) {
      /* best-effort */
    }
  }
  if (!forcar && !fiscalDriver.EMISSAO_FISCAL) {
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

async function enfileirarEmissaoNfse(cfg, body, opts = {}) {
  const habilitado =
    typeof fiscalDriver.isNfseHabilitado === "function"
      ? fiscalDriver.isNfseHabilitado()
      : false;
  if (!habilitado) {
    const err = new Error(
      "NFS-e desabilitada (NFSE_ENABLED ou EMISSAO_FISCAL)",
    );
    err.permanente = true;
    throw err;
  }
  const validado = validarPayloadNfse(body);
  const numeroRps = String(body.numeroRps || body.numeroVenda || "");
  return enfileirarEmissao(
    cfg,
    {
      ...body,
      ...validado,
      numeroRps,
      numeroVenda: numeroRps,
      modeloDocumento: "99",
    },
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

function consultarStatusEmissaoPorVenda(numeroVenda) {
  const st = filaFiscal.consultarStatusEmissaoPorVenda(numeroVenda);
  const corr = st.correlationId;
  const modelo =
    st.resultado?.modeloDocumento ||
    (corr ? extrairModeloJob(corr) : null) ||
    "65";
  return { ...st, modeloDocumento: modelo };
}

async function sincronizarVendaFiscal(cfg, numeroVenda) {
  if (!numeroVenda) throw new Error("numeroVenda obrigatório");
  const st = consultarStatusEmissaoPorVenda(numeroVenda);
  filaFiscal.dispararProcessamento();

  if (
    st.status === "INCERTO" ||
    st.status === "RECUPERANDO" ||
    st.status === "FALHA_TEMPORARIA" ||
    st.status === "PROCESSANDO" ||
    st.status === "PENDENTE" ||
    st.status === "ENFILEIRADO"
  ) {
    return { ok: true, acao: "aguardando_agente", ...st };
  }

  if (st.status === "CONCLUIDO" || st.status === "CONCLUIDO_RECUPERADO") {
    const resultado = st.resultado || {};
    const doc = filaFiscal.buscarDocumentoPorVenda(numeroVenda);
    const chave = resultado.chave || doc?.chave;
    if (chave && cfg?.backendUrl) {
      const xmlResolvido = await resolverXmlParaCallback(
        chave,
        doc?.xml_path || resultado.xmlPath || null,
      );
      const callbackPayload = montarCallbackPayload({
        correlationId: st.correlationId,
        chave,
        numeroNfe: resultado.numero || resultado.numeroNfe || doc?.numero_nfe,
        serieNfe: resultado.serie || resultado.serieNfe || doc?.serie_nfe,
        protocolo: resultado.protocolo || doc?.protocolo,
        cStat: resultado.cStat || doc?.c_stat || "100",
        xMotivo: resultado.xMotivo,
        qrcode: resultado.qrcode || resultado.qrcodeNfe,
        xmlContent: xmlResolvido.xmlContent || resultado.xml || null,
        xmlPath: xmlResolvido.xmlPath || doc?.xml_path || null,
        modeloDocumento:
          resultado.modeloDocumento ||
          doc?.modelo_documento ||
          inferirModeloDocumento(doc, chave),
        pdfPendente: GERAR_PDF_HABILITADO && !GERAR_PDF_EMIT,
        recuperado: st.status === "CONCLUIDO_RECUPERADO",
      });
      agendarCallbackBackend(cfg, numeroVenda, st.correlationId, callbackPayload);
      filaFiscal.dispararProcessamento();
      return { ok: true, acao: "callback_reenfileirado", ...st };
    }
    return { ok: true, acao: "concluido_sem_chave", ...st };
  }

  return { ok: true, acao: "status_consultado", ...st };
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

async function reimprimirDanfceCompleto(chave, numeroVenda, opts = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = require("./logger").child({ modulo: "reimprimir_danfce" });

  function indexarDocumentoRecuperado(doc, chaveDoc, modelo) {
    if (!doc?.xml_path || !chaveDoc) return;
    try {
      filaFiscal.salvarDocumento({
        chave: chaveDoc,
        numeroVenda: doc.numero_venda || numeroVenda,
        correlationId: doc.correlation_id || null,
        serieNfe: doc.serie_nfe,
        numeroNfe: doc.numero_nfe,
        cStat: doc.c_stat || "100",
        protocolo: doc.protocolo,
        xmlPath: doc.xml_path,
        pdfPath: doc.pdf_path || null,
        tipo: doc.tipo || "AUTORIZADA",
        modeloDocumento: modelo,
      });
    } catch (idxErr) {
      log.warn({ err: idxErr.message, chave: chaveDoc }, "[Reimprimir] Falha ao indexar documento recuperado");
    }
  }

  async function imprimirTermicoComRetry(payload, primeiraVia) {
    const printerService = require("./printerService");
    const max = parseInt(process.env.REIMPRIMIR_PRINT_RETRIES || "3", 10);
    let lastErr;
    for (let i = 0; i < max; i++) {
      try {
        if (primeiraVia) {
          await printerService.imprimirCupom(payload);
        } else {
          await printerService.imprimirSegundaVia(payload);
        }
        return;
      } catch (err) {
        lastErr = err;
        const msg = String(err?.message || "");
        const retryavel = /(-10)|porta|PRINTER_PORTA|timeout|ocupad|offline/i.test(msg);
        if (!retryavel || i >= max - 1) throw err;
        await sleep(400 * (i + 1));
        try {
          await require("./print/printerBootstrap").garantirPortaImpressao({ force: i > 0 });
          require("./print/factory").resetPrintProvider();
        } catch (_) {}
      }
    }
    throw lastErr;
  }

  let doc = null;
  for (let i = 0; i < 8; i++) {
    doc = docs.resolverDocumentoFiscalLocal(chave, numeroVenda);
    if (doc) break;
    if (i < 7) await sleep(400);
  }
  if (!doc) throw new Error("Documento fiscal não encontrado localmente");
  const chaveDoc = doc.chave || chave;
  const modelo = inferirModeloDocumento(doc, chaveDoc);
  indexarDocumentoRecuperado(doc, chaveDoc, modelo);

  const qrInformado =
    (opts.qrcodeNfe && String(opts.qrcodeNfe).trim()) ||
    (opts.qrcode && String(opts.qrcode).trim()) ||
    null;

  const { isSegundaViaIntencional } = require("./print/printIdempotency");
  const segundaViaIntencional =
    isSegundaViaIntencional(opts) ||
    /segunda_via|reimpressao|reimprimir/i.test(String(opts.motivo || ""));

  const { montarPayloadSegundaVia, montarPayloadCupomFiscalLocal } = require("./print/segundaVia");
  let payload = segundaViaIntencional
    ? montarPayloadSegundaVia({
        chave: chaveDoc,
        numeroVenda: doc.numero_venda || numeroVenda,
      })
    : montarPayloadCupomFiscalLocal({
        chave: chaveDoc,
        numeroVenda: doc.numero_venda || numeroVenda,
      });
  if (qrInformado && !require("./print/cupomValidate").resolverQrCodeNfce(payload)) {
    payload = { ...payload, qrcodeNfe: qrInformado, qrcode: qrInformado };
  }
  if (typeof opts.exibirLogo === "boolean") {
    payload = { ...payload, exibirLogo: opts.exibirLogo };
  }
  if (modelo === "55") {
    payload = { ...payload, danfeTermico: true, layout: "danfe-termico" };
  }
  await imprimirTermicoComRetry(payload, !segundaViaIntencional);

  // PDF é opcional e não deve atrasar a resposta da térmica (já enfileirada).
  let pdfPath = doc.pdf_path;
  const chaveParaPdf = chaveDoc;
  const docSnap = doc;
  const numVendaSnap = doc.numero_venda || numeroVenda;
  if (!docs.isPdfValid(pdfPath) && chaveParaPdf) {
    void (async () => {
      try {
        const novoPdf = await gerarPdfParaModelo(chaveParaPdf, docSnap.xml_path, modelo);
        filaFiscal.salvarDocumento({
          chave: chaveParaPdf,
          numeroVenda: numVendaSnap,
          correlationId: docSnap.correlation_id,
          serieNfe: docSnap.serie_nfe,
          numeroNfe: docSnap.numero_nfe,
          cStat: docSnap.c_stat,
          protocolo: docSnap.protocolo,
          xmlPath: docSnap.xml_path,
          pdfPath: novoPdf,
          tipo: docSnap.tipo || "AUTORIZADA",
          modeloDocumento: modelo,
        });
      } catch (pdfErr) {
        log.warn(
          { err: pdfErr.message, chave: chaveParaPdf, numeroVenda: numVendaSnap },
          "[Reimprimir] Impressão térmica OK — PDF opcional indisponível",
        );
      }
    })();
  }
  return {
    ok: true,
    chave: chaveDoc,
    pdfPath: pdfPath || null,
    tipo: modelo === "55" ? "danfe" : "danfce",
    modeloDocumento: modelo,
  };
}

async function obterPdfDocumento(chave, numeroVenda, formatoPdf = "termico") {
  const { normalizarFormatoPdfNfce } = require("./fiscalPdfFormato");
  let doc =
    (chave && filaFiscal.buscarDocumentoPorChave(chave)) ||
    (numeroVenda && filaFiscal.buscarDocumentoPorVenda(numeroVenda));
  if (!doc) {
    doc = docs.resolverDocumentoFiscalLocal(chave, numeroVenda);
  }
  const chaveDoc = doc?.chave || chave;
  if (!chaveDoc && !numeroVenda) {
    throw new Error("Informe chave ou numeroVenda");
  }
  const modelo = inferirModeloDocumento(doc, chaveDoc);
  const formato = normalizarFormatoPdfNfce(formatoPdf, modelo);
  let xmlAutorizado = null;
  try {
    xmlAutorizado = await garantirXmlAutorizado(chaveDoc, doc?.xml_path);
  } catch (err) {
    if (!doc?.xml_path && !chaveDoc) {
      throw new Error("PDF não disponível — documento fiscal não encontrado");
    }
    throw err;
  }

  let pdfPath = doc?.pdf_path;
  if (!docs.pdfValidoParaModelo(pdfPath, modelo, formato) && chaveDoc) {
    const encontrado = docs.localizarPdfPorChave(chaveDoc, modelo, formato);
    if (encontrado && docs.pdfValidoParaModelo(encontrado, modelo, formato)) {
      pdfPath = docs.copiarPdfParaCanonico(chaveDoc, encontrado, modelo, formato);
    }
  }
  const pdfDesatualizado =
    docs.pdfValidoParaModelo(pdfPath, modelo, formato) &&
    xmlAutorizado &&
    doc?.xml_path &&
    doc.xml_path !== xmlAutorizado;
  const pdfFormatoIncorreto =
    (modelo === "55" && docs.isPdfValid(pdfPath) && !docs.pareceDanfeA4(pdfPath)) ||
    (modelo === "65" &&
      docs.isPdfValid(pdfPath) &&
      !docs.pdfValidoParaModelo(pdfPath, modelo, formato));
  if (
    !docs.pdfValidoParaModelo(pdfPath, modelo, formato) ||
    pdfDesatualizado ||
    pdfFormatoIncorreto
  ) {
    pdfPath = await gerarPdfComXml(chaveDoc, xmlAutorizado, modelo, formato);
  }

  const nv = doc?.numero_venda || numeroVenda;
  const corr = doc?.correlation_id || null;
  filaFiscal.salvarDocumento({
    chave: chaveDoc,
    numeroVenda: nv,
    correlationId: corr,
    serieNfe: doc?.serie_nfe,
    numeroNfe: doc?.numero_nfe,
    cStat: doc?.c_stat,
    protocolo: doc?.protocolo,
    xmlPath: xmlAutorizado,
    pdfPath,
    tipo: doc?.tipo || "AUTORIZADA",
    modeloDocumento: modelo,
  });

  if (_lerConfigFn && nv) {
    const cfg = await _lerConfigFn();
    const xmlContent = lerConteudoXmlAutorizado(xmlAutorizado);
    const pdfContentBase64 = docs.lerArquivoBase64(pdfPath);
    const callbackPayload = montarCallbackPayload({
      correlationId: corr,
      chave: chaveDoc,
      numeroNfe: doc?.numero_nfe,
      serieNfe: doc?.serie_nfe,
      protocolo: doc?.protocolo,
      cStat: doc?.c_stat,
      xmlContent,
      xmlPath: xmlAutorizado,
      pdfPath,
      pdfContentBase64,
      modeloDocumento: modelo,
    });
    await enviarCallbackDocumentosFiscais(cfg, nv, corr, callbackPayload);
  }

  const buffer = docs.lerArquivo(pdfPath);
  if (!buffer || buffer.length < 128) {
    throw new Error("PDF inválido ou corrompido");
  }
  return { pdfPath, buffer, modeloDocumento: modelo, chave: chaveDoc, formatoPdf: formato };
}

/** XML autorizado para cupom / QR — disco local ou índice SQLite (sem nuvem). */
async function obterXmlDocumento(chave, numeroVenda) {
  const doc =
    (chave && filaFiscal.buscarDocumentoPorChave(chave)) ||
    (numeroVenda && filaFiscal.buscarDocumentoPorVenda(numeroVenda));
  const chaveDoc = doc?.chave || chave;
  if (!chaveDoc && !numeroVenda) {
    throw new Error("Informe chave ou numeroVenda");
  }
  let xmlPath = doc?.xml_path || null;
  try {
    xmlPath = await garantirXmlAutorizado(chaveDoc, xmlPath);
  } catch (err) {
    if (!xmlPath) {
      throw new Error("XML não disponível — documento fiscal não encontrado");
    }
    throw err;
  }
  const xmlContent = lerConteudoXmlAutorizado(xmlPath);
  if (!xmlContent) {
    throw new Error("XML fiscal vazio ou ilegível");
  }
  if (!docs.xmlEstaAutorizado(xmlContent)) {
    throw new Error("XML fiscal ainda não autorizado");
  }
  return {
    xmlContent,
    xmlPath,
    chave: chaveDoc,
    modeloDocumento: inferirModeloDocumento(doc, chaveDoc),
    qrcode: docs.extrairQrCodeDoXml(xmlContent),
  };
}

async function cancelarCompleto(cfg, body) {
  const { chave, motivo, numeroVenda, correlationId } = body;
  const driver = resolverDriverFiscal(body);
  const res = await driver.cancelarNfce(chave, motivo);
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

async function enviarEventoCompleto(cfg, body) {
  const { documentIni, chave, chaveNfe, tipo, tipoEvento, modeloDocumento, correlationId } = body;
  if (!documentIni || !String(documentIni).trim()) {
    throw new Error("documentIni obrigatório para evento fiscal");
  }
  const res = await resolverDriverFiscal(body).enviarEventoFiscal({
    documentIni,
    chave: chave || chaveNfe,
    chaveNfe: chaveNfe || chave,
    tipo: tipo || tipoEvento,
    tipoEvento: tipoEvento || tipo,
    modeloDocumento,
  });
  if (res.raw && (chave || chaveNfe)) {
        const xml = require("./documentosFiscais").extrairXmlDaResposta(res.raw);
        if (xml) {
          const savedPath = docs.salvarXmlEvento(chave || chaveNfe, xml, tipoEvento || tipo);
          body._xmlEvento = xml;
          if (savedPath) body.xmlPath = savedPath;
        }
  }
  if (cfg?.backendUrl && body.numeroVenda) {
    try {
      await httpRequest(
        `${cfg.backendUrl.replace(/\/$/, "")}/pdv/vendas/${encodeURIComponent(body.numeroVenda)}/fiscal/evento`,
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
          xMotivo: res.xMotivo,
          tipoEvento: res.tipoEvento || tipoEvento || tipo,
          cceId: body.cceId || null,
          sequencia: body.sequencia ?? body.nSeqEvento ?? null,
          correcao: body.correcao || body.xCorrecao || null,
          xmlContent: body._xmlEvento || null,
          xmlPath: body.xmlPath || null,
        }),
      );
    } catch {
      filaFiscal.enfileirar(
        "EVENTO_FISCAL",
        { ...body, ...res },
        correlationId,
        body.numeroVenda,
      );
    }
  }
  return res;
}

async function inutilizarCompleto(cfg, body) {
  let inutilizacaoId = body.inutilizacaoId || null;
  const cnpj =
    body.cnpj ||
    body.empresa?.cnpj ||
    cfg.empresa?.cnpj ||
    cfg.cnpj ||
    null;
  const payload = {
    ...body,
    cnpj,
    ano: body.ano || new Date().getFullYear(),
    modelo: body.modelo || "65",
  };

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
        serie: payload.serie,
        numeroInicial: payload.numeroInicial,
        numeroFinal: payload.numeroFinal,
        motivo: payload.motivo,
        modelo: payload.modelo,
      }),
    );
    inutilizacaoId = created.id;
  }

  const res = await resolverDriverFiscal(payload).inutilizarNfce(payload);
  if (!res?.ok) {
    throw new Error(
      res?.xMotivo ||
        res?.mensagem ||
        "Inutilização rejeitada pela SEFAZ sem detalhe.",
    );
  }

  let xmlPath = null;
  if (res.xml) {
    xmlPath = docs.salvarXmlInutilizacao(
      payload.serie,
      payload.numeroInicial,
      payload.numeroFinal,
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
      filaFiscal.enfileirar("INUTILIZACAO", { body: { ...payload, inutilizacaoId }, res, xmlPath });
    }
  }
  return { ...res, inutilizacaoId, xmlPath };
}

function registrarHandlersFila(lerConfigFn) {
  _lerConfigFn = lerConfigFn;
  filaFiscal.registrarHandler("CALLBACK_BACKEND", async (payload) => {
    const cfg = await lerConfigFn();
    await callbackBackend(
      cfg,
      payload.numeroVenda,
      payload.callbackPayload,
      payload.correlationId,
      { nfse: !!payload.nfse },
    );
  });

  filaFiscal.registrarHandler("EMISSAO", async (payload, job) => {
    const cfg = await lerConfigFn();
    // Painel / emissão manual: forcarEmissao ignora o toggle da frente (EMISSAO_FISCAL).
    let emissaoOk = fiscalDriver.EMISSAO_FISCAL === true || payload?.forcarEmissao === true;
    if (!emissaoOk) {
      try {
        require("./fiscalLocalConfig").garantirEmissaoFiscalAtiva();
      } catch (_) {
        /* best-effort */
      }
      emissaoOk = fiscalDriver.EMISSAO_FISCAL === true || payload?.forcarEmissao === true;
    }
    if (!emissaoOk) {
      throw Object.assign(new Error("EMISSAO_FISCAL desabilitada no agente"), { permanente: true });
    }
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
      const cStatErro = fiscalRetry.extrairCStat(err);
      if (
        fiscalRetry.isErroDuplicidade539(err) ||
        err.esgotouRecuperacao539 ||
        fiscalRetry.isPermanente(err)
      ) {
        try {
          await notificarPendenciaFiscalFailSafe(numeroVenda, correlationId, err);
        } catch (_) {
          /* callback best-effort */
        }
      }
      const cnpj =
        payload.empresa?.cnpj || payload.cnpj || cfg.empresa?.cnpj || cfg.cnpj;
      if (!err.rateLimit && !fiscalRetry.isIncerto(err)) {
        fiscalRateLimit.registrarFalha(
          cnpj,
          fiscalRetry.extrairCStat(err),
          job?.tentativas || 1,
        );
      }
      throw err;
    }
  });

  filaFiscal.registrarHandler("EVENTO_FISCAL", async (payload) => {
    const cfg = await lerConfigFn();
    if (!cfg?.backendUrl || !payload.numeroVenda) {
      throw new Error("EVENTO_FISCAL sem backend ou numeroVenda");
    }
    await httpRequest(
      `${cfg.backendUrl.replace(/\/$/, "")}/pdv/vendas/${encodeURIComponent(payload.numeroVenda)}/fiscal/evento`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.backendToken}`,
          "X-Correlation-Id": payload.correlationId || "",
        },
      },
      JSON.stringify({
        protocolo: payload.protocolo,
        cStat: payload.cStat,
        xMotivo: payload.xMotivo,
        tipoEvento: payload.tipoEvento || payload.tipo,
        cceId: payload.cceId || null,
        sequencia: payload.sequencia ?? payload.nSeqEvento ?? null,
        correcao: payload.correcao || payload.xCorrecao || null,
        xmlContent: payload.xmlContent || null,
        xmlPath: payload.xmlPath || null,
      }),
    );
  });

  filaFiscal.registrarHandler("GERAR_PDF", async (payload) => {
    const { chave, xmlPath, numeroVenda, correlationId, modeloDocumento } =
      payload;
    if (!chave) throw new Error("chave obrigatória para GERAR_PDF");
    const doc = filaFiscal.buscarDocumentoPorChave(chave);
    const modelo =
      modeloDocumento || inferirModeloDocumento(doc, chave);
    if (!GERAR_PDF_HABILITADO && modelo !== "55") return;

    const nv = numeroVenda || doc?.numero_venda;
    const corr = correlationId || doc?.correlation_id;
    let xmlAutorizado = null;
    try {
      xmlAutorizado = await garantirXmlAutorizado(chave, xmlPath || doc?.xml_path);
    } catch (_) {
      xmlAutorizado = xmlPath || doc?.xml_path || null;
    }

    let pdfPath = doc?.pdf_path;
    const pdfDesatualizado =
      docs.pdfValidoParaModelo(pdfPath, modelo) &&
      xmlAutorizado &&
      doc?.xml_path &&
      doc.xml_path !== xmlAutorizado;
    const pdfFormatoIncorreto =
      modelo === "55" &&
      docs.isPdfValid(pdfPath) &&
      !docs.pareceDanfeA4(pdfPath);

    if (
      !docs.pdfValidoParaModelo(pdfPath, modelo) ||
      pdfDesatualizado ||
      pdfFormatoIncorreto
    ) {
      const t0 = Date.now();
      pdfPath = await gerarPdfParaModelo(chave, xmlAutorizado, modelo);
      fiscalMetrics.registrarEmissao(0, { pdfMs: Date.now() - t0, pdf: true });
    }

    filaFiscal.salvarDocumento({
      chave,
      numeroVenda: nv,
      correlationId: corr,
      serieNfe: doc?.serie_nfe,
      numeroNfe: doc?.numero_nfe,
      cStat: doc?.c_stat,
      protocolo: doc?.protocolo,
      xmlPath: xmlAutorizado,
      pdfPath,
      tipo: doc?.tipo || "AUTORIZADA",
      modeloDocumento: modelo,
    });

    const cfg = await lerConfigFn();
    if (cfg.backendUrl && nv) {
      const xmlContent = lerConteudoXmlAutorizado(xmlAutorizado);
      const pdfContentBase64 = docs.lerArquivoBase64(pdfPath);
      const callbackPayload = montarCallbackPayload({
        correlationId: corr,
        chave,
        numeroNfe: doc?.numero_nfe,
        serieNfe: doc?.serie_nfe,
        protocolo: doc?.protocolo,
        cStat: doc?.c_stat,
        xmlContent,
        xmlPath: xmlAutorizado,
        pdfPath,
        pdfContentBase64,
        modeloDocumento: modelo,
      });
      await enviarCallbackDocumentosFiscais(cfg, nv, corr, callbackPayload);
    }
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
  enfileirarEmissaoNfse,
  consultarStatusEmissao,
  consultarStatusEmissaoPorVenda,
  sincronizarVendaFiscal,
  finalizarEmissaoRecuperada,
  reimprimirDanfceCompleto,
  obterPdfDocumento,
  obterXmlDocumento,
  inferirModeloDocumento,
  gerarPdfParaModelo,
  cancelarCompleto,
  enviarEventoCompleto,
  inutilizarCompleto,
  callbackBackend,
  notificarPendenciaFiscalFailSafe,
  persistirDocumentosFiscais,
  registrarHandlersFila,
  PATHS,
};

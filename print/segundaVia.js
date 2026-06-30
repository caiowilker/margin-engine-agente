/**
 * Segunda via e reimpressão térmica — monta payload a partir de venda, fila fiscal ou XML.
 */
const fs = require("fs");
const path = require("path");
const { extrairQrCodeDoXml, isNfeModelo55 } = require("../documentosFiscais");

function marcarSegundaVia(payload, extra = {}) {
  return {
    ...payload,
    segundaVia: true,
    reimpressao: true,
    emitidoEm: payload.emitidoEm || new Date().toISOString(),
    ...extra,
  };
}

function lerXmlDoc(doc) {
  const p = doc?.xml_path || doc?.xmlPath;
  if (!p || !fs.existsSync(p)) return null;
  try {
    return fs.readFileSync(p, "utf8");
  } catch (_) {
    return null;
  }
}

function enriquecerComDocumento(payload, doc) {
  if (!doc) return payload;
  const out = { ...payload };
  const chave = doc.chave || out.chaveNfe;
  if (chave) out.chaveNfe = chave;
  if (doc.numero_nfe) out.numeroNfe = doc.numero_nfe;
  if (doc.serie_nfe) out.serieNfe = doc.serie_nfe;
  if (doc.protocolo) out.protocolo = doc.protocolo;
  if (doc.numero_venda && !out.numeroVenda) out.numeroVenda = doc.numero_venda;

  const xml = out.xmlContent || out.xml || lerXmlDoc(doc);
  if (xml) {
    out.xmlContent = xml;
    const qr = extrairQrCodeDoXml(xml);
    if (qr) {
      out.qrcodeNfe = qr;
      out.qrcode = qr;
    }
  }
  return out;
}

function payloadFromJob(jobPayload) {
  if (!jobPayload || typeof jobPayload !== "object") return null;
  const p = { ...jobPayload };
  delete p.cfg;
  delete p.backendToken;
  delete p._fiscalMeta;
  if (p._fiscalMeta?.chave) p.chaveNfe = p._fiscalMeta.chave;
  return p;
}

/**
 * @param {{ chave?: string, numeroVenda?: string, payload?: object, correlationId?: string }} opts
 */
function montarPayloadSegundaVia(opts = {}) {
  if (opts.payload && typeof opts.payload === "object") {
    return marcarSegundaVia(enriquecerComDocumento(opts.payload, null));
  }

  const filaFiscal = require("../filaFiscal");
  filaFiscal.init?.();

  let doc =
    (opts.chave && filaFiscal.buscarDocumentoPorChave(String(opts.chave).replace(/\D/g, ""))) ||
    null;
  if (!doc && opts.numeroVenda) {
    doc = filaFiscal.buscarDocumentoPorVenda(opts.numeroVenda);
  }

  let cupom = null;
  const corr = opts.correlationId || doc?.correlation_id;
  if (corr) {
    const job = filaFiscal.obterJobEmissao(corr);
    if (job?.payload) {
      try {
        cupom = payloadFromJob(JSON.parse(job.payload));
      } catch (_) {}
    }
  }
  if (!cupom && opts.numeroVenda) {
    const res = filaFiscal.obterResultadoPorVenda(opts.numeroVenda);
    if (res?.resultado) {
      try {
        const parsed = JSON.parse(res.resultado);
        if (parsed?.payload) cupom = payloadFromJob(parsed.payload);
      } catch (_) {}
    }
  }

  if (!cupom && doc) {
    cupom = {
      numeroVenda: doc.numero_venda,
      chaveNfe: doc.chave,
      numeroNfe: doc.numero_nfe,
      serieNfe: doc.serie_nfe,
      protocolo: doc.protocolo,
      total: 0,
      itens: [],
      empresa: {},
      formaPagamento: "dinheiro",
    };
  }

  if (!cupom) {
    throw new Error(
      "Segunda via indisponível — informe payload completo, chave ou numeroVenda com documento local",
    );
  }

  return marcarSegundaVia(enriquecerComDocumento(cupom, doc));
}

function isDanfeTermico(payload) {
  const chave = payload?.chaveNfe || payload?.chave;
  if (!chave) return false;
  return payload.danfeTermico === true && isNfeModelo55(chave);
}

module.exports = {
  marcarSegundaVia,
  montarPayloadSegundaVia,
  enriquecerComDocumento,
  isDanfeTermico,
};

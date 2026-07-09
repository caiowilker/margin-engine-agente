/** Marca d'água / site exibidos no PDF fiscal (ACBr Monitor e ACBrLib). */
const MARCA_DAGUA_MARGIN = "Margin Engine";

/** @typedef {"termico"|"a4"} FormatoPdfNfce */

/**
 * @param {string|undefined|null} raw
 * @param {string} modeloDocumento
 * @returns {FormatoPdfNfce}
 */
function normalizarFormatoPdfNfce(raw, modeloDocumento = "65") {
  if (String(modeloDocumento) === "55") return "a4";
  const f = String(raw || "termico")
    .trim()
    .toLowerCase();
  if (f === "a4" || f === "grande" || f === "pagamento" || f === "consumidor") {
    return "a4";
  }
  return "termico";
}

/**
 * @param {string} modeloDocumento
 * @param {FormatoPdfNfce} [formatoPdf]
 */
function suffixPdfModelo(modeloDocumento = "65", formatoPdf = "termico") {
  if (String(modeloDocumento) === "55") return "danfe";
  return normalizarFormatoPdfNfce(formatoPdf, modeloDocumento) === "a4"
    ? "danfce-a4"
    : "danfce";
}

/**
 * @param {string} chave
 * @param {string} modeloDocumento
 * @param {FormatoPdfNfce} [formatoPdf]
 */
function destinoPdfCanonico(chave, modeloDocumento = "65", formatoPdf = "termico") {
  const k = String(chave || "").replace(/\D/g, "");
  const modelo = String(modeloDocumento || "65");
  const formato = normalizarFormatoPdfNfce(formatoPdf, modelo);
  const suffix = suffixPdfModelo(modelo, formato);
  const { PATHS } = require("./marginPaths");
  return require("path").join(PATHS.pdf, `${k}-${suffix}.pdf`);
}

/**
 * Configura Site / marca d'água no ACBrLib (ignora chaves ausentes por versão).
 * @param {{ configGravarValor: (sec: string, key: string, val: string) => void }} inst
 */
function applyMarcaDaguaAcbrLib(inst) {
  const sets = [
    ["DANFE", "Site", MARCA_DAGUA_MARGIN],
    ["DANFE", "MarcaDagua", MARCA_DAGUA_MARGIN],
    ["Sistema", "Nome", MARCA_DAGUA_MARGIN],
  ];
  for (const [sec, key, val] of sets) {
    try {
      inst.configGravarValor(sec, key, val);
    } catch (_) {
      /* opcional por versão da DLL */
    }
  }
}

/**
 * @param {{ configGravarValor: (sec: string, key: string, val: string) => void }} inst
 * @param {FormatoPdfNfce} formatoPdf
 */
function applyNfcePdfFormatoAcbrLib(inst, formatoPdf) {
  applyMarcaDaguaAcbrLib(inst);
  const termico = formatoPdf !== "a4";
  try {
    inst.configGravarValor("DANFE", "TipoDANFE", "4");
  } catch (_) {
    /* ignore */
  }
  const simplificado = termico ? "1" : "0";
  for (const key of ["Simplificado", "ModeloSimplificado", "ImprimirSimplificado"]) {
    try {
      inst.configGravarValor("DANFE", key, simplificado);
      break;
    } catch (_) {
      /* próxima chave */
    }
  }
  try {
    inst.configGravarValor("DANFE", "ViaConsumidor", "1");
  } catch (_) {
    /* ignore */
  }
}

/**
 * Parâmetros Monitor: ImprimirDANFEPDF(xml, protocolo, marcaDagua, viaConsumidor, simplificado)
 * @param {string} modeloDocumento
 * @param {FormatoPdfNfce} formatoPdf
 */
function paramsImprimirDanfePdfMonitor(modeloDocumento = "65", formatoPdf = "termico") {
  const modelo = String(modeloDocumento || "65");
  const formato = normalizarFormatoPdfNfce(formatoPdf, modelo);
  const viaConsumidor = "1";
  const simplificado =
    modelo === "55" ? "0" : formato === "a4" ? "0" : "1";
  return {
    marcaDagua: MARCA_DAGUA_MARGIN,
    viaConsumidor,
    simplificado,
  };
}

/**
 * Logo DANFE só em layout A4 (NF-e 55 ou NFC-e formato=a4).
 * @param {string} modeloDocumento
 * @param {FormatoPdfNfce} [formatoPdf]
 */
function deveAplicarLogoDanfe(modeloDocumento = "65", formatoPdf = "termico") {
  const modelo = String(modeloDocumento || "65");
  if (modelo === "55") return true;
  return normalizarFormatoPdfNfce(formatoPdf, modelo) === "a4";
}

/**
 * Configura PathLogo no ACBrLib antes de gerar PDF DANFE/DANFC-e A4.
 * @param {{ configGravarValor: (sec: string, key: string, val: string) => void }} inst
 * @param {object} [runtime]
 * @param {{ modelo?: string, formatoPdf?: string }} [opts]
 * @returns {boolean}
 */
function applyDanfeLogoAcbrLib(inst, runtime, opts = {}) {
  try {
    const modelo = String(opts.modelo || "65");
    const formatoPdf = opts.formatoPdf != null ? opts.formatoPdf : modelo === "55" ? "a4" : "termico";
    if (!deveAplicarLogoDanfe(modelo, formatoPdf)) return false;
    const fiscalLogo = require("./fiscal/fiscalLogo");
    const info = fiscalLogo.ler();
    if (!info.ativo || !info.caminhoAbsoluto) return false;
    const logoPath = fiscalLogo.caminhoParaAcbr(runtime);
    if (!logoPath) return false;
    const sets = [
      ["DANFE", "PathLogo", logoPath],
      ["DANFE", "ExpandeLogoMarca", "1"],
    ];
    for (const [sec, key, val] of sets) {
      try {
        inst.configGravarValor(sec, key, val);
      } catch (_) {
        /* opcional por versão */
      }
    }
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  MARCA_DAGUA_MARGIN,
  normalizarFormatoPdfNfce,
  suffixPdfModelo,
  destinoPdfCanonico,
  applyMarcaDaguaAcbrLib,
  applyNfcePdfFormatoAcbrLib,
  deveAplicarLogoDanfe,
  applyDanfeLogoAcbrLib,
  paramsImprimirDanfePdfMonitor,
};

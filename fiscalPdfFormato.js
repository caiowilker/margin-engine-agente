/** Marca d'água / site exibidos no PDF fiscal (ACBr Monitor e ACBrLib). */
const MARCA_DAGUA_MARGIN = "Margin Engine";

/** @typedef {"termico"|"a4"} FormatoPdfNfce */

/** ACBr [DANFENFCe] TipoRelatorioBobina: 0=Fortes bobina, 1=ESC/POS, 2=Fortes A4 (página 595pt). */
const TIPO_RELATORIO_BOBINA_NFCE = {
  FORTES: "0",
  ESCPOS: "1",
  FORTES_A4: "2",
};

/** ACBr [DANFE] TipoDANFE: 1=Retrato A4 (tabelas completas), 4=NFC-e bobina/ESC. */
const TIPO_DANFE_ACBR = {
  RETRATO_A4: "1",
  NFCE: "4",
};

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
 * Grava config no ACBrLib ignorando chaves ausentes por versão da DLL.
 * @param {{ configGravarValor: (sec: string, key: string, val: string) => void }} inst
 */
function configGravarSafe(inst, sets) {
  for (const [sec, key, val] of sets) {
    if (val == null) continue;
    try {
      inst.configGravarValor(sec, key, String(val));
    } catch (_) {
      /* opcional por versão da DLL */
    }
  }
}

/**
 * Parâmetros de layout NFC-e para ACBr (Lib INI e Monitor ConfigGravarValor).
 * A4 pagamento: TipoDANFE=1 + TipoRelatorioBobina=2 (FortesA4) — tabelas completas 595pt.
 * @param {FormatoPdfNfce} formatoPdf
 */
function nfceLayoutAcbrParams(formatoPdf) {
  const a4 = formatoPdf === "a4";
  return {
    tipoDANFE: a4 ? TIPO_DANFE_ACBR.RETRATO_A4 : TIPO_DANFE_ACBR.NFCE,
    tipoRelatorioBobina: a4
      ? TIPO_RELATORIO_BOBINA_NFCE.FORTES_A4
      : TIPO_RELATORIO_BOBINA_NFCE.ESCPOS,
    simplificado: a4 ? "0" : "1",
    viaConsumidor: a4 ? "0" : "1",
    formulario: "0",
    impressora: a4 ? "" : null,
    imprimeItens: "1",
  };
}

/**
 * @param {{ configGravarValor: (sec: string, key: string, val: string) => void }} inst
 * @param {FormatoPdfNfce} formatoPdf
 */
function applyNfcePdfFormatoAcbrLib(inst, formatoPdf) {
  applyMarcaDaguaAcbrLib(inst);
  const layout = nfceLayoutAcbrParams(formatoPdf);
  const a4 = formatoPdf === "a4";

  configGravarSafe(inst, [
    ["DANFE", "TipoDANFE", layout.tipoDANFE],
    ["DANFE", "Formulario", layout.formulario],
    ["DANFENFCe", "TipoRelatorioBobina", layout.tipoRelatorioBobina],
    ["DANFENFCe", "ViaConsumidor", layout.viaConsumidor],
    ["DANFENFCe", "ImprimeItens", layout.imprimeItens],
    ["DANFE", "ViaConsumidor", layout.viaConsumidor],
    ["DANFE", "Simplificado", layout.simplificado],
    ["DANFE", "ModeloSimplificado", layout.simplificado],
    ["DANFE", "ImprimirSimplificado", layout.simplificado],
  ]);

  if (a4) {
    configGravarSafe(inst, [
      ["DANFE", "Impressora", layout.impressora],
      ["DANFE", "ImprimeCodigoEan", "1"],
      ["DANFENFe", "ExibeEAN", "1"],
    ]);
  }
}

/**
 * Comandos Monitor antes de ImprimirDANFEPDF para NFC-e (modelo 65).
 * @param {FormatoPdfNfce} formatoPdf
 * @returns {string[]}
 */
function nfceLayoutMonitorComandos(formatoPdf) {
  const layout = nfceLayoutAcbrParams(formatoPdf);
  const cmds = [
    `NFE.ConfigGravarValor("DANFE","TipoDANFE","${layout.tipoDANFE}")`,
    `NFE.ConfigGravarValor("DANFE","Formulario","${layout.formulario}")`,
    `NFE.ConfigGravarValor("DANFENFCe","TipoRelatorioBobina","${layout.tipoRelatorioBobina}")`,
    `NFE.ConfigGravarValor("DANFENFCe","ViaConsumidor","${layout.viaConsumidor}")`,
    `NFE.ConfigGravarValor("DANFENFCe","ImprimeItens","${layout.imprimeItens}")`,
    `NFE.ConfigGravarValor("DANFE","Simplificado","${layout.simplificado}")`,
    `NFE.ConfigGravarValor("DANFE","ViaConsumidor","${layout.viaConsumidor}")`,
    'NFE.ConfigGravarValor("DANFE","Site","Margin Engine")',
    'NFE.ConfigGravarValor("DANFE","MarcaDagua","Margin Engine")',
  ];
  if (formatoPdf === "a4") {
    cmds.push('NFE.ConfigGravarValor("DANFE","Impressora","")');
    cmds.push('NFE.ConfigGravarValor("DANFE","ImprimeCodigoEan","1")');
    cmds.push('NFE.ConfigGravarValor("DANFENFe","ExibeEAN","1")');
  }
  cmds.push("NFE.ConfigGravar()");
  return cmds;
}

/**
 * Parâmetros Monitor: ImprimirDANFEPDF(xml, protocolo, marcaDagua, viaConsumidor, simplificado)
 * @param {string} modeloDocumento
 * @param {FormatoPdfNfce} formatoPdf
 */
function paramsImprimirDanfePdfMonitor(modeloDocumento = "65", formatoPdf = "termico") {
  const modelo = String(modeloDocumento || "65");
  const formato = normalizarFormatoPdfNfce(formatoPdf, modelo);
  const layout =
    modelo === "55"
      ? { simplificado: "0", viaConsumidor: "0" }
      : nfceLayoutAcbrParams(formato);
  return {
    marcaDagua: MARCA_DAGUA_MARGIN,
    viaConsumidor: layout.viaConsumidor,
    simplificado: layout.simplificado,
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
  TIPO_RELATORIO_BOBINA_NFCE,
  TIPO_DANFE_ACBR,
  normalizarFormatoPdfNfce,
  suffixPdfModelo,
  destinoPdfCanonico,
  nfceLayoutAcbrParams,
  nfceLayoutMonitorComandos,
  applyMarcaDaguaAcbrLib,
  applyNfcePdfFormatoAcbrLib,
  deveAplicarLogoDanfe,
  applyDanfeLogoAcbrLib,
  paramsImprimirDanfePdfMonitor,
};

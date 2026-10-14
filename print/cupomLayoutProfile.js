/**
 * Perfis de layout do cupom térmico (Etapa 12-3).
 *
 * PADRAO — idêntico ao layout atual (default em todo terminal).
 * COMPACTO / ULTRA — OPT-IN 80 mm; 58 mm DESATIVADO.
 * shrinkQr / fontB / EspacoEntreLinhas: sempre off por padrão
 * (opções futuras ativáveis por terminal após teste em papel).
 */

const PERFIS_IDS = Object.freeze(["PADRAO", "COMPACTO", "ULTRA"]);

/**
 * Flags por perfil. PADRAO = tudo off → mesma saída de hoje.
 *
 * Compacto inclui cortes seguros (ex-Ultra): omitVolumes + collapseTotalSeps
 * + compactação de qr_mensagens/chave (sem mexer em conteúdo fiscal).
 * Ultra = máximo sem Font B nem QR menor (rodapé 1 linha).
 */
const PERFIS = Object.freeze({
  PADRAO: Object.freeze({
    id: "PADRAO",
    label: "Padrão",
    omitFooterBlankLines: false,
    omitPreFooterSep: false,
    /** false | "merge_obrigado_volte" | "single_line" */
    compactFooter: false,
    /** Oculta linha Volumes: (sistema / UX). */
    omitVolumes: false,
    /** Colapsa ========== duplicados ao redor do TOTAL. */
    collapseTotalSeps: false,
    /**
     * false | "tight"
     * — remove divisores/labels redundantes em volta do QR; QR intacto.
     */
    compactQrMensagens: false,
    /**
     * false | "tight"
     * — reorganiza quebras de chave/protocolo sem alterar conteúdo.
     */
    compactChaveProtocolo: false,
    shrinkQr: false,
    fontB: false,
    espacoEntreLinhas: null,
    allow58mm: false,
  }),
  COMPACTO: Object.freeze({
    id: "COMPACTO",
    label: "Compacto",
    omitFooterBlankLines: true,
    omitPreFooterSep: true,
    compactFooter: "merge_obrigado_volte",
    omitVolumes: true,
    collapseTotalSeps: true,
    compactQrMensagens: "tight",
    compactChaveProtocolo: "tight",
    shrinkQr: false,
    fontB: false,
    espacoEntreLinhas: null,
    allow58mm: false,
  }),
  ULTRA: Object.freeze({
    id: "ULTRA",
    label: "Ultra compacto",
    omitFooterBlankLines: true,
    omitPreFooterSep: true,
    compactFooter: "single_line",
    omitVolumes: true,
    collapseTotalSeps: true,
    compactQrMensagens: "tight",
    compactChaveProtocolo: "tight",
    shrinkQr: false,
    fontB: false,
    espacoEntreLinhas: null,
    allow58mm: false,
  }),
});

function normalizarPerfilId(raw) {
  const s = String(raw || "PADRAO")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  if (s === "ULTRA_COMPACTO" || s === "ULTRA-COMPACTO") return "ULTRA";
  if (PERFIS_IDS.includes(s)) return s;
  return "PADRAO";
}

function perfilPorId(id) {
  return PERFIS[normalizarPerfilId(id)] || PERFIS.PADRAO;
}

/**
 * Compacto/Ultra fiscal liberado só com flag explícita (após aceite da prova 12-3b).
 * Env: PRINT_CUPOM_FISCAL_COMPACTO=true  |  sidecar/opts cupomFiscalCompactoLiberado
 */
function isFiscalCompactoLiberado(opts = {}) {
  if (opts.cupomFiscalCompactoLiberado === true) return true;
  const env = String(process.env.PRINT_CUPOM_FISCAL_COMPACTO || "")
    .trim()
    .toLowerCase();
  return env === "1" || env === "true" || env === "yes";
}

/**
 * Resolve perfil efetivo.
 * - Default PADRAO
 * - 58 mm + Compacto/Ultra: força PADRAO
 * - Fiscal Compacto/Ultra: BLOQUEADO até PRINT_CUPOM_FISCAL_COMPACTO (condição 12-3b)
 * - Fiscal liberado: omitVolumes=false (qtde total itens = MET III)
 * - fontB / espacoEntreLinhas / shrinkQr: só se override explícito do terminal
 */
function resolveCupomLayoutProfile(opts = {}) {
  const configured = normalizarPerfilId(
    opts.perfil ??
      opts.cupomLayoutPerfil ??
      process.env.PRINT_CUPOM_LAYOUT_PERFIL ??
      "PADRAO",
  );
  let perfil = { ...perfilPorId(configured) };

  const paperMm = Number(opts.paperMm || process.env.PRINTER_PAPER_MM || 80);
  if (paperMm <= 58 && perfil.id !== "PADRAO" && !perfil.allow58mm) {
    return {
      ...PERFIS.PADRAO,
      requestedId: configured,
      forcedReason: "58MM_NAO_VALIDADO",
    };
  }

  const isFiscal = opts.isFiscal === true || opts.fiscal === true;
  if (isFiscal && perfil.id !== "PADRAO" && !isFiscalCompactoLiberado(opts)) {
    return {
      ...PERFIS.PADRAO,
      requestedId: configured,
      forcedReason: "FISCAL_COMPACTO_BLOQUEADO",
    };
  }

  // Overrides opcionais por terminal (sempre default off).
  const fontB =
    opts.fontB === true ||
    String(process.env.PRINT_CUPOM_FONT_B || "").toLowerCase() === "true";
  const espacoRaw =
    opts.espacoEntreLinhas != null
      ? opts.espacoEntreLinhas
      : process.env.PRINT_CUPOM_ESPACO_ENTRE_LINHAS;
  let espacoEntreLinhas = null;
  if (espacoRaw != null && String(espacoRaw).trim() !== "") {
    const n = Number(espacoRaw);
    if (Number.isFinite(n) && n >= 0) espacoEntreLinhas = n;
  }
  const shrinkQr =
    opts.shrinkQr === true ||
    String(process.env.PRINT_CUPOM_SHRINK_QR || "").toLowerCase() === "true";

  // MET DANFE III: qtde total de itens — nunca omitir Volumes no fiscal.
  const omitVolumes = isFiscal ? false : !!perfil.omitVolumes;

  return {
    ...perfil,
    omitVolumes,
    fontB: fontB && perfil.id !== "PADRAO" ? true : false,
    espacoEntreLinhas:
      perfil.id !== "PADRAO" && espacoEntreLinhas != null
        ? espacoEntreLinhas
        : null,
    shrinkQr: shrinkQr && perfil.id !== "PADRAO" ? true : false,
    requestedId: configured,
    forcedReason: null,
  };
}

function listarPerfisPublico() {
  return PERFIS_IDS.map((id) => {
    const p = PERFIS[id];
    return {
      id: p.id,
      label: p.label,
      default: id === "PADRAO",
      optIn: id !== "PADRAO",
      allow58mm: p.allow58mm,
      shrinkQr: false,
      fontB: false,
      espacoEntreLinhas: null,
      omitVolumes: p.omitVolumes,
      collapseTotalSeps: p.collapseTotalSeps,
      compactFooter: p.compactFooter,
      compactQrMensagens: p.compactQrMensagens,
      compactChaveProtocolo: p.compactChaveProtocolo,
      status58mm:
        id === "PADRAO" ? "OK_REFERENCIA_TAGS" : "NAO_VALIDADO_DESATIVADO",
      status80mm:
        id === "PADRAO" ? "DEFAULT_GOLDEN" : "OPT_IN_FISCAL_E_NAOFISCAL",
    };
  });
}

/** Tabela humana do que cada perfil corta (não fiscal + fiscal aparência). */
function descreverCortesPerfil() {
  return {
    PADRAO: {
      corta: [],
      nota: "Saída idêntica ao layout atual (golden). Default em todos os terminais.",
    },
    COMPACTO: {
      corta: [
        "linha_simples / sepEq antes do rodapé",
        "feeds vazios do rodapé (ESC/POS)",
        "merge Obrigado+Volte (mantém linha PDV)",
        "Volumes: (somente NÃO fiscal — fiscal mantém qtde itens MET III)",
        "========== duplicados ao redor do TOTAL (fica um ---)",
        "divisores/labels redundantes em volta do QR (QR intacto)",
        "quebra apertada chave/protocolo (mesmo conteúdo)",
      ],
      nota:
        "Cortes de aparência/sistema. Fiscal bloqueado até PRINT_CUPOM_FISCAL_COMPACTO. Sem Font B, sem QR menor.",
    },
    ULTRA: {
      corta: [
        "tudo do Compacto",
        "rodapé em 1 linha (omite PDV Margin Engine)",
      ],
      nota: "Máximo sem Font B nem redução de QR. Fiscal idem bloqueado até liberação.",
    },
  };
}

module.exports = {
  PERFIS,
  PERFIS_IDS,
  normalizarPerfilId,
  perfilPorId,
  resolveCupomLayoutProfile,
  isFiscalCompactoLiberado,
  listarPerfisPublico,
  descreverCortesPerfil,
};

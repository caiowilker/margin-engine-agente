/**
 * Tipos padronizados de job de impressão — Frente 13.
 */
const TIPOS = Object.freeze({
  CUPOM_FISCAL: "cupom_fiscal",
  CUPOM_NAO_FISCAL: "cupom_nao_fiscal",
  SEGUNDA_VIA: "segunda_via",
  DANFE_TERMICO: "danfe_termico",
  ABERTURA_CAIXA: "abertura_caixa",
  FECHAMENTO_CAIXA: "fechamento_caixa",
  MOVIMENTO_CAIXA: "movimento_caixa",
  SANGRIA: "sangria",
  SUPRIMENTO: "suprimento",
  RECIBO: "recibo",
  RELATORIO: "relatorio",
  REIMPRESSAO: "reimpressao",
  TESTE: "teste",
  GAVETA: "gaveta",
});

const STATUS = Object.freeze({
  PENDENTE: "PENDENTE",
  ENVIANDO: "ENVIANDO",
  IMPRESSO: "IMPRESSO",
  ERRO: "ERRO",
  REPROCESSANDO: "REPROCESSANDO",
  CANCELADO: "CANCELADO",
});

const OP_TO_TIPO = Object.freeze({
  imprimirCupom: (payload) =>
    payload?.cupomSemFiscal || payload?.naoFiscal
      ? TIPOS.CUPOM_NAO_FISCAL
      : TIPOS.CUPOM_FISCAL,
  imprimirSegundaVia: () => TIPOS.SEGUNDA_VIA,
  imprimirAbertura: () => TIPOS.ABERTURA_CAIXA,
  imprimirFechamento: () => TIPOS.FECHAMENTO_CAIXA,
  imprimirMovimentoCaixa: (payload) => {
    const t = String(payload?.tipo || "").toLowerCase();
    if (t.includes("sangria")) return TIPOS.SANGRIA;
    if (t.includes("suprimento")) return TIPOS.SUPRIMENTO;
    return TIPOS.MOVIMENTO_CAIXA;
  },
  imprimirTeste: () => TIPOS.TESTE,
  abrirGaveta: () => TIPOS.GAVETA,
});

function resolverTipo(op, payload) {
  const map = OP_TO_TIPO[op];
  if (!map) return "desconhecido";
  return typeof map === "function" ? map(payload) : map;
}

function extrairMeta(payload = {}, opts = {}) {
  return {
    documento:
      opts.documento ||
      payload?.chaveNfe ||
      payload?.chave ||
      payload?.numeroVenda ||
      payload?.numeroVendaCliente ||
      null,
    numeroVenda:
      payload?.numeroVenda ||
      payload?.numeroVendaCliente ||
      payload?.numero ||
      null,
    usuario: opts.usuario || payload?.operador || payload?.usuario || null,
    caixa: opts.caixa || payload?.caixa || payload?.terminal || null,
    tenantId: opts.tenantId || payload?.tenantId || null,
    motivo: opts.motivo || payload?.motivoReimpressao || null,
  };
}

module.exports = {
  TIPOS,
  STATUS,
  OP_TO_TIPO,
  resolverTipo,
  extrairMeta,
};

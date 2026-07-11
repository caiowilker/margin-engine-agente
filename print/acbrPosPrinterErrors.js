/**
 * Códigos de retorno ACBrLib PosPrinter — mensagens para operador e logs.
 */
const CODIGOS = {
  [-1]: "Biblioteca não inicializada",
  [-2]: "Falha ao finalizar a biblioteca",
  [-3]: "Configuração INI inválida",
  [-5]: "Arquivo INI não encontrado",
  [-6]: "Diretório do INI não encontrado",
  [-10]: "Erro de comunicação com a impressora",
};

const DICAS = {
  [-10]:
    "No Windows com porta RAW, clique Detectar no painel e depois Imprimir teste. Confira o nome exato da impressora e se ela está ligada.",
  [-3]: "Revise Modelo e Porta em Configurações → Impressão.",
  [-5]: "Arquivo posprinter.ini ausente — reinicie o agente ou reinstale.",
};

function hintPortaNaoDefinida(ctx = {}) {
  if (!/porta.*n[aã]o definida/i.test(String(ctx.ultimoMsg || ""))) return null;
  return "A porta RAW não foi aplicada na sessão da impressora — use Detectar no painel :9100 e tente Imprimir teste.";
}

function formatAcbrPosError(fnName, ret, ultimoMsg, ctx = {}) {
  const code = Number(ret);
  const base = CODIGOS[code] || `Erro ACBr (${code})`;
  const parts = [`${fnName || "POS"} falhou (${code}): ${base}`];
  const detalhe = String(ultimoMsg || "").trim();
  if (detalhe && detalhe !== String(code) && !parts[0].includes(detalhe)) {
    parts.push(detalhe);
  }
  if (ctx.porta) parts.push(`Porta=${ctx.porta}`);
  if (ctx.modelo != null) parts.push(`Modelo=${ctx.modelo}`);
  const hintPorta = hintPortaNaoDefinida({ ultimoMsg: detalhe });
  if (hintPorta) parts.push(hintPorta);
  else if (DICAS[code]) parts.push(DICAS[code]);
  const err = new Error(parts.join(" — "));
  err.acbrRet = code;
  return err;
}

module.exports = { CODIGOS, DICAS, formatAcbrPosError };

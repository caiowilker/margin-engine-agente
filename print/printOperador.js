/**
 * Mensagens amigáveis para operador — impressão (nunca expor DLL/stack).
 */
const { classifyPrintError } = require("./printErrors");

const MAPA = [
  {
    teste: /sem papel|pouco papel|tampa/i,
    mensagem: "Impressora sem papel ou com tampa aberta.",
    acao: "Reponha o papel, feche a tampa e tente imprimir novamente.",
  },
  {
    teste: /offline|desconect|desligad|unavailable|econnrefused|econnreset|porta/i,
    mensagem: "Impressora não responde.",
    acao: "Verifique cabo USB, rede ou se a impressora está ligada. Use Detectar no painel.",
  },
  {
    teste: /timeout|tempo esgotado/i,
    mensagem: "A impressão demorou mais que o esperado.",
    acao: "A fila tentará reenviar automaticamente. Se persistir, imprima o teste no painel.",
  },
  {
    teste: /fila|reenviad|queued/i,
    mensagem: "Impressão na fila — será reenviada automaticamente.",
    acao: "Continue a venda; acompanhe o status em Configurações → Impressão.",
  },
  {
    teste: /qr code|nfc-e autorizada/i,
    mensagem: "Cupom fiscal aguardando dados do QR Code.",
    acao: "Aguarde a sincronização ou use Reimprimir / Segunda via quando o documento estiver pronto.",
  },
  {
    teste: /payload|obrigat|inválid/i,
    mensagem: "Não foi possível montar o comprovante.",
    acao: "Tente novamente. Se o problema continuar, gere diagnóstico para o suporte.",
  },
];

function mensagemOperadorImpressao(err) {
  const raw = String(err?.message || err || "");
  const cls = classifyPrintError(err);
  for (const item of MAPA) {
    if (item.teste.test(raw)) {
      return { mensagem: item.mensagem, acao: item.acao, recuperavel: cls.retryable };
    }
  }
  return {
    mensagem: "Não foi possível imprimir neste momento.",
    acao: "Verifique a impressora em Configurações → Impressão e tente novamente.",
    recuperavel: cls.retryable,
  };
}

function formatarErroHttpImpressao(err) {
  const op = mensagemOperadorImpressao(err);
  return {
    erro: op.mensagem,
    acaoRecomendada: op.acao,
    recuperavel: op.recuperavel,
    jobId: err?.jobId || null,
  };
}

module.exports = { mensagemOperadorImpressao, formatarErroHttpImpressao };

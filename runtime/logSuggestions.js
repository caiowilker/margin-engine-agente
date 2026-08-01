/**
 * Sugestões operacionais para erros — apenas em arquivos de log (nunca UI do operador).
 */
const SUGESTOES = [
  {
    teste: /senha informada está errada|senha.*errada|mac verify failure|pkcs12_parse|senha do certificado/i,
    causa: "Senha do certificado A1 incorreta.",
    acao: "Confira a senha do PFX em Configuração Fiscal → Certificado e salve novamente.",
  },
  {
    teste: /validade do certificado já expirou|certificado.*expir|expirad/i,
    causa: "Certificado digital expirado.",
    acao: "Importe um certificado A1 válido em Configuração Fiscal → Certificado.",
  },
  {
    teste: /erro ao ler informações do certificado|certificado|a1|\.pfx|pfx/i,
    causa: "Falha ao carregar o certificado A1.",
    acao: "Verifique o arquivo PFX, a senha e reinicie o serviço Margin Engine.",
  },
  {
    teste: /csc|idtoken/i,
    causa: "CSC da NFC-e incorreto",
    acao: "Confira Id CSC e código CSC em Configuração → Agente.",
  },
  {
    teste: /sefaz|cstat|timeout.*sefaz/i,
    causa: "SEFAZ indisponível ou rejeitou a nota",
    acao: "Aguarde alguns minutos e consulte Diagnóstico → Fila fiscal.",
  },
  {
    teste: /impressora|print|escpos/i,
    causa: "Falha de comunicação com a impressora",
    acao: "Verifique cabo USB/rede e teste em Configuração → Impressão.",
  },
  {
    teste: /sqlite|database is locked|banco/i,
    causa: "Banco local temporariamente bloqueado",
    acao: "Reinicie o serviço Margin Engine. Se persistir, execute Reparar no instalador.",
  },
  {
    teste: /inicializar|finalizar|dll|biblioteca nativa/i,
    causa: "Emissor fiscal integrado precisa ser reiniciado",
    acao: "Reinicie o serviço ou execute Reparar no instalador.",
  },
  {
    teste: /401|token/i,
    causa: "Token do caixa desatualizado",
    acao: "Reative o terminal em PDV → Ativar.",
  },
  {
    teste: /ncm|cfop|cst|csosn/i,
    causa: "Dados fiscais do produto incompletos",
    acao: "Revise cadastro do produto em Configurações → Dados fiscais.",
  },
];

function sugerirParaErro(mensagem) {
  const texto = String(mensagem || "");
  for (const item of SUGESTOES) {
    if (item.teste.test(texto)) {
      return { causa: item.causa, acaoRecomendada: item.acao };
    }
  }
  return {
    causa: "Falha operacional",
    acaoRecomendada: "Consulte Diagnóstico ou exporte pacote para o suporte.",
  };
}

module.exports = { sugerirParaErro, SUGESTOES };

/**
 * Mensagens operacionais — Problema · Causa · Como resolver (sem termos técnicos na UI).
 */
const { sugerirParaErro } = require("./logSuggestions");

const TERMOS_TECNICOS =
  /acbr|dll|\.ini\b|\.json|stack|\.env\b|127\.0\.0\.1|programdata|program files|margin-engine\/|\\users\\|\/home\/|econnreset|sqlite|koffi|ffi\b|unexpected token|erro interno/i;

const REGRAS = [
  {
    teste: /timeout|timed out|tempo esgotado/i,
    problema: "A operação demorou mais que o esperado.",
    causa: "Conexão ou emissor fiscal lento.",
    comoResolver: "Verifique a internet e tente novamente.",
  },
  {
    teste: /ncm|cfop|cst|csosn/i,
    problema: "Dados fiscais do produto incompletos.",
    causa: "Cadastro fiscal incompleto.",
    comoResolver: "Revise o produto em Configurações → Dados fiscais.",
  },
  {
    teste: /certificado|a1|pfx/i,
    problema: "Problema com o certificado digital.",
    causa: "Certificado ausente, inválido ou vencido.",
    comoResolver: "Importe certificado A1 em Configuração Fiscal.",
  },
  {
    teste: /sefaz|cstat|rejei/i,
    problema: "A SEFAZ não autorizou a nota.",
    causa: "Serviço da SEFAZ indisponível ou rejeição.",
    comoResolver: "Aguarde e consulte Diagnóstico → Fila fiscal.",
  },
  {
    teste: /agente|offline|inacess|econn/i,
    problema: "Serviço local indisponível.",
    causa: "Margin Engine pode estar parado.",
    comoResolver: "Reinicie o serviço ou o computador do caixa.",
  },
];

function contemTermoTecnico(texto) {
  return TERMOS_TECNICOS.test(String(texto || ""));
}

function sanitizarTextoOperador(texto) {
  const t = String(texto || "").trim();
  if (!t || contemTermoTecnico(t) || t.length > 200) return "";
  return t;
}

function paraOperador(err) {
  const bruto = String(err?.message || err || "");
  for (const r of REGRAS) {
    if (r.teste.test(bruto)) return { ...r };
  }
  const sug = sugerirParaErro(bruto);
  if (sug.causa && !contemTermoTecnico(sug.causa)) {
    return {
      problema: sug.causa.endsWith(".") ? sug.causa : `${sug.causa}.`,
      causa: "Falha durante o processamento fiscal ou de impressão.",
      comoResolver: sug.acaoRecomendada || "Consulte Diagnóstico.",
    };
  }
  const limpo = sanitizarTextoOperador(bruto);
  if (limpo) {
    return {
      problema: limpo,
      causa: "A operação não foi concluída.",
      comoResolver: "Tente novamente ou consulte Diagnóstico.",
    };
  }
  return {
    problema: "Não foi possível concluir a operação.",
    causa: "Falha no serviço local.",
    comoResolver: "Consulte Diagnóstico ou contate o suporte.",
  };
}

function respostaErroOperador(err, status = 500) {
  const op = paraOperador(err);
  return {
    ok: false,
    status,
    problema: op.problema,
    causa: op.causa,
    comoResolver: op.comoResolver,
    erro: `${op.problema} ${op.comoResolver}`,
  };
}

function sanitizarErroFila(erro) {
  if (!erro) return null;
  const op = paraOperador({ message: String(erro) });
  return op.problema;
}

function nomeDriverProfissional(info) {
  if (!info) return "Emissor fiscal";
  if (info.mode === "parity" || info.fallback === true) return "Modo alternativo";
  if (info.native || info.mode === "native" || info.provider === "acbr-lib" || info.provider === "lib") {
    return "Emissor integrado";
  }
  if (info.mode === "monitor" || info.provider === "monitor") return "Modo compatibilidade";
  return "Emissor fiscal";
}

module.exports = {
  paraOperador,
  respostaErroOperador,
  sanitizarTextoOperador,
  sanitizarErroFila,
  contemTermoTecnico,
  nomeDriverProfissional,
};

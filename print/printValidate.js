/**
 * Validação pré-enfileiramento — etapa obrigatória do pipeline de impressão.
 */
const { normalizarCupomPayload } = require("./cupomValidate");

const OPS_CAIXA = new Set([
  "imprimirAbertura",
  "imprimirFechamento",
  "imprimirMovimentoCaixa",
]);

function validarAntesEnfileirar(op, args) {
  const payload = args?.[0];

  if (op === "imprimirTeste" || op === "abrirGaveta") {
    return { ok: true, args };
  }

  if (op === "imprimirSegundaVia") {
    if (!payload || typeof payload !== "object") {
      throw new Error("Dados insuficientes para segunda via.");
    }
    return { ok: true, args };
  }

  if (op === "imprimirCupom") {
    if (!payload || typeof payload !== "object") {
      throw new Error("Payload de cupom inválido.");
    }
    const relaxQr =
      payload.permitirSemQr === true ||
      payload.origem === "contingencia" ||
      payload.origem === "offline" ||
      payload.somenteDanfeTermico === true ||
      payload.danfeTermico === true;
    if (relaxQr) {
      return { ok: true, args: [payload] };
    }
    const normalizado = normalizarCupomPayload(payload);
    return { ok: true, args: [normalizado] };
  }

  if (OPS_CAIXA.has(op)) {
    if (!payload || typeof payload !== "object") {
      throw new Error("Dados do comprovante de caixa inválidos.");
    }
    if (!String(payload.operador || "").trim()) {
      throw new Error("Operador obrigatório para comprovante de caixa.");
    }
    return { ok: true, args: [payload] };
  }

  if (typeof op !== "string" || !op) {
    throw new Error("Operação de impressão inválida.");
  }

  return { ok: true, args: args || [] };
}

module.exports = { validarAntesEnfileirar, OPS_CAIXA };

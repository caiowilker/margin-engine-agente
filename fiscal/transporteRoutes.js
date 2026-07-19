"use strict";

/**
 * Handlers de contrato para CT-e/MDF-e.
 * Não executam ACBr até existir um driver com contrato específico para transporte.
 */
const { verificarCapacidadeTransporte } = require("./transporteCapability");
const {
  resolverAdapterTransporte,
  validarAdapter,
} = require("./transporteAdapter");

function correlationId(req) {
  return req.headers["x-correlation-id"] || req.body?.correlationId || null;
}

function criarHandlerTransporte(
  documento,
  operacao,
  detector = verificarCapacidadeTransporte,
  resolverAdapter = resolverAdapterTransporte,
  criarContexto = async () => ({}),
) {
  return async (req, res) => {
    const capacidade = detector(documento);
    if (!capacidade.ok) {
      return res.status(503).json({
        ok: false,
        codigo: "CAPABILITY_UNAVAILABLE",
        erro: `${capacidade.nome} indisponível neste agente.`,
        operacao,
        requisitosAusentes: capacidade.ausentes,
      });
    }

    const adapter = resolverAdapter(documento, operacao);
    if (!validarAdapter(adapter)) {
      // Fail closed: presença de artefatos não autoriza operações fiscais sem
      // adapter, validação de payload, persistência e callback próprios.
      return res.status(503).json({
        ok: false,
        codigo: "CAPABILITY_UNAVAILABLE",
        erro: `${capacidade.nome} não está habilitado para operação fiscal.`,
        operacao,
        requisitosAusentes: ["adaptador_fiscal"],
      });
    }

    const idCorrelacao = correlationId(req);
    if (!idCorrelacao) {
      return res.status(400).json({
        ok: false,
        codigo: "CORRELATION_ID_REQUIRED",
        erro: "X-Correlation-Id ou correlationId é obrigatório.",
        operacao,
      });
    }

    try {
      const contexto = await criarContexto();
      const comando = {
        documento,
        operacao,
        correlationId: idCorrelacao,
        payload: { ...(req.body || {}), correlationId: idCorrelacao },
        capacidade,
        contexto,
      };
      const preflight = await adapter.preflight(comando);
      if (!preflight?.ok) {
        return res.status(503).json({
          ok: false,
          codigo: "PREFLIGHT_FAILED",
          erro: preflight?.erro || `Preflight de ${capacidade.nome} indisponível.`,
          operacao,
        });
      }
      const resultado = await adapter.enqueue(comando);
      return res.status(202).json({
        ...resultado,
        async: resultado?.async ?? true,
        correlationId: idCorrelacao,
        status: resultado?.status || "PENDENTE",
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        codigo: "TRANSPORT_ADAPTER_ERROR",
        erro: error.message || `Falha ao enfileirar ${capacidade.nome}.`,
        operacao,
      });
    }
  };
}

function registrarRotasTransporte(app, middlewares = [], dependencies = {}) {
  const [privateNetworkHeaders, exigirAgentToken] = middlewares;
  const protegidas = [privateNetworkHeaders, exigirAgentToken].filter(Boolean);
  const {
    detector = verificarCapacidadeTransporte,
    resolverAdapter = resolverAdapterTransporte,
    criarContexto,
  } = dependencies;
  const handler = (documento, operacao) =>
    criarHandlerTransporte(
      documento,
      operacao,
      detector,
      resolverAdapter,
      criarContexto,
    );
  app.post(
    "/fiscal/emitir-cte",
    ...protegidas,
    handler("cte", "EMITIR_CTE"),
  );
  app.post(
    "/fiscal/cancelar-cte",
    ...protegidas,
    handler("cte", "CANCELAR_CTE"),
  );
  app.post(
    "/fiscal/emitir-mdfe",
    ...protegidas,
    handler("mdfe", "EMITIR_MDFE"),
  );
  app.post(
    "/fiscal/encerrar-mdfe",
    ...protegidas,
    handler("mdfe", "ENCERRAR_MDFE"),
  );
  app.post(
    "/fiscal/incluir-condutor-mdfe",
    ...protegidas,
    handler("mdfe", "INCLUIR_CONDUTOR_MDFE"),
  );
}

module.exports = {
  criarHandlerTransporte,
  registrarRotasTransporte,
};

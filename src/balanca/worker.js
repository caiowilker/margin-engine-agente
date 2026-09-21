"use strict";

const fetch = require("node-fetch");
const { ler: lerConfigBalanca } = require("./config");
const { processarLote } = require("./loteRunner");
const { limparTemporariosOrfaos } = require("./pasta");
const log = require("../../logger").child({ modulo: "balanca_worker" });

let timer = null;
let inFlight = false;
let ultimoLote = null;
let ultimoErro = null;
let lerConfigAgente = () => ({});

function configurar({ lerConfig } = {}) {
  if (typeof lerConfig === "function") lerConfigAgente = lerConfig;
}

function health() {
  const cfg = safeCfg();
  return {
    enabled: cfg.enabled === true,
    modoSombra: cfg.modoSombra !== false,
    gerenciadorId: cfg.gerenciadorId || null,
    pastaCarga: cfg.pastaCarga || null,
    encoding: cfg.encoding,
    workerAtivo: timer != null,
    inFlight,
    ultimoLote,
    ultimoErro,
  };
}

function safeCfg() {
  try {
    return lerConfigBalanca();
  } catch {
    return { enabled: false };
  }
}

function iniciarWorker() {
  pararWorker();
  const cfg = safeCfg();
  if (cfg.pastaCarga) {
    try {
      limparTemporariosOrfaos(cfg.pastaCarga);
    } catch {
      /* ignore */
    }
  }
  const ms = cfg.pollBackendMs || 15000;
  timer = setInterval(() => {
    void tick().catch((e) => {
      ultimoErro = e.message;
      log.warn({ err: e.message }, "tick balança falhou");
    });
  }, ms);
  if (typeof timer.unref === "function") timer.unref();
  log.info({ pollBackendMs: ms, enabled: cfg.enabled }, "Worker balança iniciado");
  void tick().catch(() => {});
}

function pararWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function tick() {
  if (inFlight) return;
  const cfg = safeCfg();
  if (!cfg.enabled || !cfg.gerenciadorId) return;

  const agente = lerConfigAgente() || {};
  const backendUrl = String(agente.backendUrl || process.env.BACKEND_URL || "").replace(/\/$/, "");
  const backendToken = agente.backendToken || process.env.BACKEND_TOKEN;
  if (!backendUrl || !backendToken) {
    ultimoErro = "Backend não configurado (backendUrl/backendToken)";
    return;
  }

  inFlight = true;
  try {
    const url = `${backendUrl}/pdv/agente/balanca/lotes/pendente?gerenciadorId=${encodeURIComponent(cfg.gerenciadorId)}`;
    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${backendToken}` },
      timeout: 20000,
    });
    if (resp.status === 204) {
      return;
    }
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      ultimoErro = `HTTP ${resp.status} ${txt.slice(0, 120)}`;
      return;
    }
    const lote = await resp.json();
    if (!lote || !lote.loteId) return;
    ultimoLote = {
      loteId: lote.loteId,
      em: new Date().toISOString(),
      modo: lote.modo,
    };
    log.info({ loteId: lote.loteId }, "Lote de balança recebido");

    const resultado = await processarLote(lote, cfg, {
      onEscrito: cfg.modoSombra
        ? undefined
        : async () => {
            // ENTREGUE somente após escrita atômica (estende lease durante poll .BAK)
            await enviarAck(backendUrl, backendToken, lote.loteId, {
              status: "ENTREGUE",
              detalhe: "Arquivos gravados na pasta de carga; aguardando .BAK",
              evidenciasBak: [],
            });
          },
    });
    await enviarAck(backendUrl, backendToken, lote.loteId, {
      status: resultado.status,
      detalhe: resultado.detalhe,
      evidenciasBak: resultado.evidenciasBak || [],
    });
    ultimoLote = { ...ultimoLote, ack: resultado.status };
    ultimoErro = resultado.status === "IMPORTADO" || resultado.status === "ENTREGUE"
      ? null
      : resultado.detalhe;
  } finally {
    inFlight = false;
  }
}

async function enviarAck(backendUrl, backendToken, loteId, body) {
  const resp = await fetch(`${backendUrl}/pdv/agente/balanca/lotes/${loteId}/ack`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${backendToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    timeout: 15000,
  });
  if (!resp.ok && resp.status !== 204) {
    const txt = await resp.text().catch(() => "");
    log.warn({ status: resp.status, body: txt.slice(0, 100) }, "ACK balança rejeitado");
  }
}

module.exports = {
  configurar,
  iniciarWorker,
  pararWorker,
  health,
  tick,
  enviarAck,
};

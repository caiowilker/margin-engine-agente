#!/usr/bin/env node
/**
 * Smoke real: POST /impressora/pedido com printType=entrega/bar
 * contra o agente local (default http://127.0.0.1:9100).
 *
 * Uso (no PC do caixa / PowerShell):
 *   node scripts/e2e-print-pedido-smoke.js
 *   set AGENT_URL=http://127.0.0.1:9100&& node scripts/e2e-print-pedido-smoke.js
 *
 * Falha se o agente recusar com PRINTER_STATION_ROUTE_MISSING (bug antigo)
 * ou se a impressora não aceitar o job.
 */
const http = require("http");
const https = require("https");

const BASE = String(process.env.AGENT_URL || "http://127.0.0.1:9100").replace(/\/$/, "");
const TOKEN = process.env.AGENT_TOKEN || process.env.X_AGENT_TOKEN || "";

function request(method, urlPath, body) {
  const u = new URL(urlPath, BASE);
  const lib = u.protocol === "https:" ? https : http;
  const payload = body != null ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(TOKEN ? { "X-Agent-Token": TOKEN } : {}),
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
        timeout: 45_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {}
          resolve({ status: res.statusCode, text, json });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function payload(printType, orderNumber) {
  return {
    printType,
    eventType: "ORDER_CREATED",
    orderNumber,
    orderId: `smoke-${printType}-${Date.now()}`,
    jobId: `smoke-job-${printType}-${Date.now()}`,
    customerName: "Smoke Test",
    customerPhone: "11999990000",
    deliveryAddress: printType === "entrega" ? "Rua Teste, 100" : null,
    total: 25.5,
    items: [{ code: "1", name: "Item smoke", quantity: 1, unit: "un" }],
    copies: 1,
    naoFiscal: true,
  };
}

async function main() {
  console.log(`==> Smoke pedido → ${BASE}`);
  const health = await request("GET", "/health");
  if (health.status >= 400) {
    console.error("Agente offline:", health.status, health.text.slice(0, 200));
    process.exit(2);
  }
  console.log("  ✓ health");

  for (const type of ["bar", "entrega"]) {
    const body = payload(type, `SMOKE-${type.toUpperCase()}`);
    const res = await request("POST", "/impressora/pedido", body);
    const msg = res.json?.mensagem || res.json?.error || res.text.slice(0, 300);
    if (res.status >= 400) {
      const lower = String(msg).toLowerCase();
      if (lower.includes("sem impressora") || lower.includes("route_missing")) {
        console.error(`  ✗ ${type}: rota parcial ainda bloqueia — ${msg}`);
        process.exit(3);
      }
      console.error(`  ✗ ${type}: HTTP ${res.status} — ${msg}`);
      process.exit(4);
    }
    console.log(`  ✓ ${type} HTTP ${res.status}`);
  }
  console.log("==> Smoke OK — bar + entrega aceitos pelo agente");
}

main().catch((err) => {
  console.error("Smoke falhou:", err.message || err);
  process.exit(1);
});

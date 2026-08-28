#!/usr/bin/env node
/**
 * Aguarda o agente Margin Engine ficar online (porta + /health).
 * Uso: node scripts/installer-wait-online.js [appDir] [--timeout=120000]
 */
const http = require("http");
const net = require("net");
const path = require("path");

const { INSTALL_WAIT_ONLINE_MS } = require("./installerSpeed");

const appDir = process.argv[2] || path.join(__dirname, "..");
const timeoutArg = process.argv.find((a) => a.startsWith("--timeout="));
const timeoutMs = timeoutArg ? parseInt(timeoutArg.split("=")[1], 10) : INSTALL_WAIT_ONLINE_MS;

process.env.MARGIN_ENGINE_AGENT_ROOT = appDir;

function readPort() {
  const fs = require("fs");
  const envPath = path.join(appDir, ".env");
  if (!fs.existsSync(envPath)) return Number(process.env.AGENT_PORT || process.env.PORT || 9100);
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^PORT=(\d+)/.exec(line.trim()) || /^AGENT_PORT=(\d+)/.exec(line.trim());
    if (m) return Number(m[1]);
  }
  return 9100;
}

/** Intervalo adaptativo: sondagem rápida no início, 2s após 30s (sucesso retorna antes). */
function pollDelayMs(elapsedMs) {
  if (elapsedMs < 10_000) return 300;
  if (elapsedMs < 30_000) return 750;
  return 2000;
}

function portOpen(port) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: "127.0.0.1", port, timeout: 2000 }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
    sock.on("timeout", () => {
      sock.destroy();
      resolve(false);
    });
  });
}

function healthOk(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 3000 }, (res) => {
      let body = "";
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => {
        resolve(res.statusCode === 200);
      });
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitOnline(customTimeoutMs = timeoutMs) {
  const port = readPort();
  const started = Date.now();
  while (Date.now() - started < customTimeoutMs) {
    if ((await portOpen(port)) && (await healthOk(port))) {
      return { ok: true, port, waitedMs: Date.now() - started };
    }
    await new Promise((r) => setTimeout(r, pollDelayMs(Date.now() - started)));
  }
  return { ok: false, port, waitedMs: Date.now() - started };
}

if (require.main === module) {
  waitOnline()
    .then((r) => {
      if (r.ok) {
        console.log(`[installer] Agente online na porta ${r.port} (${r.waitedMs} ms)`);
        process.exit(0);
      }
      console.error(`[installer] Agente não respondeu em ${timeoutMs} ms (porta ${r.port})`);
      process.exit(1);
    })
    .catch((err) => {
      console.error("[installer] wait-online:", err.message);
      process.exit(1);
    });
}

module.exports = { waitOnline, pollDelayMs, readPort, portOpen, healthOk };

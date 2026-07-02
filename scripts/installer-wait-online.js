#!/usr/bin/env node
/**
 * Aguarda o agente Margin Engine ficar online (porta + /health).
 * Uso: node scripts/installer-wait-online.js [appDir] [--timeout=90000]
 */
const http = require("http");
const net = require("net");

const appDir = process.argv[2] || require("path").join(__dirname, "..");
const timeoutArg = process.argv.find((a) => a.startsWith("--timeout="));
const timeoutMs = timeoutArg ? parseInt(timeoutArg.split("=")[1], 10) : 90_000;

process.env.MARGIN_ENGINE_AGENT_ROOT = appDir;

function readPort() {
  const fs = require("fs");
  const path = require("path");
  const envPath = path.join(appDir, ".env");
  if (!fs.existsSync(envPath)) return Number(process.env.AGENT_PORT || process.env.PORT || 9100);
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^PORT=(\d+)/.exec(line.trim()) || /^AGENT_PORT=(\d+)/.exec(line.trim());
    if (m) return Number(m[1]);
  }
  return 9100;
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

async function waitOnline() {
  const port = readPort();
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if ((await portOpen(port)) && (await healthOk(port))) {
      return { ok: true, port, waitedMs: Date.now() - started };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { ok: false, port, waitedMs: Date.now() - started };
}

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

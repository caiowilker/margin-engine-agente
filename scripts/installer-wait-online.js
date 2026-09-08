#!/usr/bin/env node
/**
 * Aguarda o agente Margin Engine ficar online (porta + /health).
 * Uso: node scripts/installer-wait-online.js [appDir] [--timeout=120000]
 *
 * Sucesso exige JSON com ok===true e ui.ok===true (não aceita body não-JSON).
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

/** Intervalo adaptativo: 150ms no início (update rápido), depois 300/750/2s. */
function pollDelayMs(elapsedMs) {
  if (elapsedMs < 5_000) return 150;
  if (elapsedMs < 15_000) return 300;
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

/**
 * Probe /health — fail-closed.
 * @returns {Promise<null|{ versao: string|null }>}
 */
function healthProbe(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 3000 }, (res) => {
      let body = "";
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }
        try {
          const json = JSON.parse(body);
          if (!json || json.ok !== true) {
            resolve(null);
            return;
          }
          // ui.ok obrigatório true — missing/false = tela preta / SPA quebrada.
          if (!json.ui || json.ui.ok !== true) {
            resolve(null);
            return;
          }
          resolve({ versao: json.versao != null ? String(json.versao) : null });
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

/** Compat: boolean — preferir healthProbe. */
async function healthOk(port) {
  const h = await healthProbe(port);
  return Boolean(h);
}

async function waitOnline(customTimeoutMs = timeoutMs) {
  const port = readPort();
  const started = Date.now();
  while (Date.now() - started < customTimeoutMs) {
    if (await portOpen(port)) {
      const h = await healthProbe(port);
      if (h) {
        return { ok: true, port, waitedMs: Date.now() - started, versao: h.versao };
      }
    }
    await new Promise((r) => setTimeout(r, pollDelayMs(Date.now() - started)));
  }
  return { ok: false, port, waitedMs: Date.now() - started, versao: null };
}

if (require.main === module) {
  waitOnline()
    .then((r) => {
      if (r.ok) {
        console.log(
          `[installer] Agente online na porta ${r.port} (${r.waitedMs} ms) v${r.versao || "?"}`,
        );
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

module.exports = { waitOnline, pollDelayMs, readPort, portOpen, healthOk, healthProbe };

#!/usr/bin/env node
/**
 * Benchmark hot path balança de checkout (H2.perf / H3.1–H3.2).
 *
 *   node scripts/scale-hot-bench.js --mock          # CI (transport mock in-process)
 *   node scripts/scale-hot-bench.js --live          # lab: HTTP contra agente :9100
 *
 * Live: SCALE_BENCH_TOKEN (ou AGENT_TOKEN), SCALE_BENCH_BASE (default http://127.0.0.1:9100)
 * Evidência: data/benchmark-scale.json
 */
"use strict";

const { performance } = require("perf_hooks");
const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");
const express = require("express");
const { STX, ETX, ENQ, ACK } = require("../src/scale/protocol/enqStx5");
const { createMockTransport } = require("../src/scale/transport/serialPort");
const scale = require("../src/scale");

const N = Number(process.env.SCALE_BENCH_N || 20);
const HOT_P95_BUDGET_MS = 400;
const HOT_P50_BUDGET_MS = 120;
const MOCK_P95_ABSURD_MS = 2000;

const args = new Set(process.argv.slice(2));
const LIVE = args.has("--live");
const MOCK = args.has("--mock") || !LIVE;

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = samples.reduce((a, b) => a + b, 0);
  const pct = (p) =>
    sorted.length
      ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] * 10) / 10
      : null;
  return {
    n: samples.length,
    avgMs: samples.length ? Math.round((sum / samples.length) * 10) / 10 : null,
    p50Ms: pct(0.5),
    p95Ms: pct(0.95),
    worstMs: sorted.length ? Math.round(sorted[sorted.length - 1] * 10) / 10 : null,
  };
}

function weightFrame(digits5) {
  return Buffer.from([STX, ...Buffer.from(digits5, "ascii"), ETX]);
}

function request(baseUrl, method, urlPath, { token, body } = {}) {
  const u = new URL(urlPath, baseUrl);
  return new Promise((resolve, reject) => {
    const payload = body != null ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "X-Agent-Token": token } : {}),
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => {
          data += c;
        });
        res.on("end", () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = { raw: data };
          }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function startMockServer() {
  const tmpConfig = path.join(os.tmpdir(), `scale-bench-${Date.now()}.json`);
  process.env.SCALE_CONFIG_OVERRIDE = tmpConfig;
  process.env.LOG_SILENT = process.env.LOG_SILENT || "true";
  fs.writeFileSync(
    tmpConfig,
    JSON.stringify({
      enabled: true,
      porta: "COM_BENCH",
      baud: 9600,
      protocol: "TOLEDO_PRIX3_ENQ_STX5",
    }),
  );

  const factory = () =>
    createMockTransport({
      respond: (written) => {
        if (written[0] === ENQ) return weightFrame("01250");
        if (written[0] === STX) return Buffer.from([ACK]);
        return null;
      },
    });

  const hooks = scale._testHooks();
  hooks.setTransportFactory(factory);
  hooks.resetDiag();

  const TOKEN = "bench-scale-token";
  const app = express();
  app.use(express.json());
  scale.registerRoutes(app, {
    privateNetworkHeaders: (_req, _res, next) => next(),
    exigirAgentToken: (req, res, next) => {
      if (req.get("X-Agent-Token") !== TOKEN) {
        return res.status(401).json({ erro: "Token inválido", codigo: "UNAUTHORIZED" });
      }
      next();
    },
  });

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    token: TOKEN,
    async close() {
      await new Promise((r) => server.close(r));
      try {
        fs.unlinkSync(tmpConfig);
      } catch (_) {
        /* ignore */
      }
      delete process.env.SCALE_CONFIG_OVERRIDE;
    },
  };
}

async function runBench({ baseUrl, token }) {
  const openSamples = [];
  const hotSamples = [];

  const tOpen0 = performance.now();
  const sess = await request(baseUrl, "POST", "/scale/sessao", {
    token,
    body: {},
  });
  openSamples.push(performance.now() - tOpen0);
  if (sess.status !== 200 || !sess.json?.sessionId) {
    throw new Error(
      `sessao falhou: HTTP ${sess.status} ${JSON.stringify(sess.json)}`,
    );
  }
  const sessionId = sess.json.sessionId;

  // warm
  await request(baseUrl, "POST", "/scale/peso", { token, body: { sessionId } });

  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    const p = await request(baseUrl, "POST", "/scale/peso", {
      token,
      body: { sessionId },
    });
    const dt = performance.now() - t0;
    if (p.status !== 200 || !p.json?.ok) {
      throw new Error(`peso #${i} falhou: HTTP ${p.status} ${JSON.stringify(p.json)}`);
    }
    hotSamples.push(dt);
  }

  await request(baseUrl, "POST", "/scale/sessao/fechar", {
    token,
    body: { sessionId },
  });

  const diag = await request(baseUrl, "GET", "/scale/diagnostico", { token });

  return {
    open: stats(openSamples),
    hot: stats(hotSamples),
    hotSamples: hotSamples.map((x) => Math.round(x)),
    diagnostico: diag.json
      ? {
          p50LatencyMs: diag.json.p50LatencyMs,
          p95LatencyMs: diag.json.p95LatencyMs,
          readsOk: diag.json.readsOk,
          overlapSkips: diag.json.overlapSkips,
        }
      : null,
  };
}

async function main() {
  let ctx;
  const mode = LIVE ? "live" : "mock";
  console.log(`\n=== scale-hot-bench mode=${mode} N=${N} ===\n`);

  if (MOCK) {
    ctx = await startMockServer();
  } else {
    const baseUrl = process.env.SCALE_BENCH_BASE || "http://127.0.0.1:9100";
    const token =
      process.env.SCALE_BENCH_TOKEN ||
      process.env.AGENT_TOKEN ||
      process.env.X_AGENT_TOKEN ||
      "";
    if (!token) {
      console.error("SCALE_BENCH_TOKEN (ou AGENT_TOKEN) obrigatório no modo --live");
      process.exit(2);
    }
    ctx = {
      baseUrl,
      token,
      async close() {},
    };
  }

  let report;
  try {
    const result = await runBench(ctx);
    report = {
      at: new Date().toISOString(),
      mode,
      n: N,
      budgets: {
        hotP50Ms: HOT_P50_BUDGET_MS,
        hotP95Ms: HOT_P95_BUDGET_MS,
      },
      ...result,
    };

    console.log("open cold:", report.open);
    console.log("hot peso:", report.hot);
    if (report.diagnostico) console.log("diagnostico:", report.diagnostico);

    const outDir = path.join(__dirname, "..", "data");
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, "benchmark-scale.json");
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log("\nescrito:", outPath);

    if (MOCK) {
      if (report.hot.p95Ms != null && report.hot.p95Ms > MOCK_P95_ABSURD_MS) {
        console.error(`FAIL mock p95 ${report.hot.p95Ms} > ${MOCK_P95_ABSURD_MS}`);
        process.exitCode = 1;
      } else {
        console.log("OK mock harness");
      }
    } else {
      const failP50 = report.hot.p50Ms != null && report.hot.p50Ms > HOT_P50_BUDGET_MS;
      const failP95 = report.hot.p95Ms != null && report.hot.p95Ms > HOT_P95_BUDGET_MS;
      if (failP50 || failP95) {
        console.error(
          `FAIL live budgets p50=${report.hot.p50Ms} (≤${HOT_P50_BUDGET_MS}) p95=${report.hot.p95Ms} (≤${HOT_P95_BUDGET_MS})`,
        );
        process.exitCode = 1;
      } else {
        console.log("OK live H2.perf budgets");
      }
    }
  } finally {
    await ctx.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

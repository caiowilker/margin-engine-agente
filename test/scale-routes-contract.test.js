"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { STX, ETX, ENQ, ACK } = require("../src/scale/protocol/enqStx5");
const { createMockTransport } = require("../src/scale/transport/serialPort");
const scale = require("../src/scale");

function weightFrame(digits5) {
  return Buffer.from([STX, ...Buffer.from(digits5, "ascii"), ETX]);
}

function request(server, method, urlPath, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const payload = body != null ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path: urlPath,
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

describe("scale routes contract", () => {
  let server;
  let tmpConfig;
  const TOKEN = "test-scale-token";

  before(async () => {
    tmpConfig = path.join(os.tmpdir(), `scale-routes-${Date.now()}.json`);
    process.env.SCALE_CONFIG_OVERRIDE = tmpConfig;
    fs.writeFileSync(
      tmpConfig,
      JSON.stringify({
        enabled: true,
        porta: "COM_TEST",
        baud: 9600,
        protocol: "ENQ_STX5",
      }),
    );

    const factory = () =>
      createMockTransport({
        respond: (written) => {
          if (written[0] === ENQ) return weightFrame("01000");
          if (written[0] === STX) return Buffer.from([ACK]);
          return null;
        },
      });

    const hooks = scale._testHooks();
    hooks.setTransportFactory(factory);
    hooks.resetDiag();

    const app = express();
    app.use(express.json());
    const privateNetworkHeaders = (_req, _res, next) => next();
    const exigirAgentToken = (req, res, next) => {
      if (req.get("X-Agent-Token") !== TOKEN) {
        return res.status(401).json({ erro: "Token inválido", codigo: "UNAUTHORIZED" });
      }
      next();
    };
    scale.registerRoutes(app, { privateNetworkHeaders, exigirAgentToken });
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    try {
      fs.unlinkSync(tmpConfig);
    } catch (_) {
      /* ignore */
    }
    delete process.env.SCALE_CONFIG_OVERRIDE;
  });

  it("exige token em /scale/status", async () => {
    const r = await request(server, "GET", "/scale/status");
    assert.equal(r.status, 401);
  });

  it("status com token retorna shape", async () => {
    const r = await request(server, "GET", "/scale/status", { token: TOKEN });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(typeof r.json.enabled, "boolean");
    assert.ok(r.json.health);
    assert.equal(typeof r.json.health.nativeOk, "boolean");
    assert.ok(["ok", "warn", "critical"].includes(r.json.health.level));
  });

  it("GET /scale/protocols lista presets", async () => {
    const r = await request(server, "GET", "/scale/protocols", { token: TOKEN });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.ok(Array.isArray(r.json.protocols));
    assert.ok(r.json.protocols.some((p) => p.id === "URANO_U12" && p.stopBits === 2));
  });

  it("PUT protocol inválido → SCALE_PROTOCOL_UNSUPPORTED", async () => {
    const r = await request(server, "PUT", "/scale/config", {
      token: TOKEN,
      body: { protocol: "XYZ_INEXISTENTE", porta: "COM_TEST", enabled: false },
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.codigo, "SCALE_PROTOCOL_UNSUPPORTED");
  });

  it("peso sem sessão → SCALE_SESSION_CLOSED", async () => {
    const r = await request(server, "POST", "/scale/peso", {
      token: TOKEN,
      body: {},
    });
    assert.equal(r.status, 409);
    assert.equal(r.json.codigo, "SCALE_SESSION_CLOSED");
    assert.ok(r.json.erro);
    assert.ok(r.json.acaoRecomendada);
  });

  it("sessao + peso ok", async () => {
    const s = await request(server, "POST", "/scale/sessao", {
      token: TOKEN,
      body: { porta: "COM_TEST", baud: 9600 },
    });
    assert.equal(s.status, 200);
    assert.ok(s.json.sessionId);
    const p = await request(server, "POST", "/scale/peso", {
      token: TOKEN,
      body: { sessionId: s.json.sessionId },
    });
    assert.equal(p.status, 200);
    assert.equal(p.json.ok, true);
    assert.equal(p.json.kg, 1);
    await request(server, "POST", "/scale/sessao/fechar", {
      token: TOKEN,
      body: { sessionId: s.json.sessionId },
    });
  });

  it("GET /scale/protocols marca Toledo GA e outros experimental", async () => {
    const r = await request(server, "GET", "/scale/protocols", { token: TOKEN });
    assert.equal(r.status, 200);
    const toledo = r.json.protocols.find((p) => p.id === "TOLEDO_PRIX3_ENQ_STX5");
    const urano = r.json.protocols.find((p) => p.id === "URANO_U12");
    const filizola = r.json.protocols.find((p) => p.id === "FILIZOLA_BP_ENQ_STX5");
    assert.equal(toledo.ga, true);
    assert.equal(toledo.tier, "ga");
    assert.equal(urano.ga, false);
    assert.equal(urano.tier, "experimental");
    assert.equal(filizola.ga, false);
    assert.equal(filizola.tier, "experimental");
  });

  it("fechar sem sessionId fecha sessão atual (orphan guard)", async () => {
    const s = await request(server, "POST", "/scale/sessao", {
      token: TOKEN,
      body: { porta: "COM_TEST", baud: 9600 },
    });
    assert.equal(s.status, 200);
    const st1 = await request(server, "GET", "/scale/status?fresh=1", { token: TOKEN });
    assert.ok(st1.json.session?.open);
    const f = await request(server, "POST", "/scale/sessao/fechar", {
      token: TOKEN,
      body: {},
    });
    assert.equal(f.status, 200);
    assert.equal(f.json.closed, true);
    const st2 = await request(server, "GET", "/scale/status?fresh=1", { token: TOKEN });
    assert.equal(st2.json.session, null);
  });

  it("diagnostico expõe rolling health após leitura", async () => {
    const hooks = scale._testHooks();
    hooks.resetDiag();
    const s = await request(server, "POST", "/scale/sessao", {
      token: TOKEN,
      body: { porta: "COM_TEST", baud: 9600 },
    });
    assert.equal(s.status, 200);
    await request(server, "POST", "/scale/peso", {
      token: TOKEN,
      body: { sessionId: s.json.sessionId },
    });
    const d = await request(server, "GET", "/scale/diagnostico", { token: TOKEN });
    assert.equal(d.status, 200);
    assert.equal(d.json.ok, true);
    assert.ok(d.json.health);
    assert.ok(d.json.readsOk >= 1);
    assert.equal(typeof d.json.p50LatencyMs, "number");
    await request(server, "POST", "/scale/sessao/fechar", {
      token: TOKEN,
      body: { sessionId: s.json.sessionId },
    });
  });
});

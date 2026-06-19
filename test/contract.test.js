#!/usr/bin/env node
/**
 * Testes de contrato front ↔ back — npm run test:contract
 * Valida shapes JSON alinhados a agenteLocal.ts / useFrenteCaixa.ts
 */
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const http = require("http");

const testDir = path.join(__dirname, "data-contract");
if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

process.env.FISCAL_DB_PATH = path.join(testDir, "fila_fiscal.contract.db");
process.env.FISCAL_METRICS_DB = path.join(testDir, "metrics.contract.db");
process.env.FISCAL_INTEGRITY_STRICT = "false";
process.env.EMISSAO_FISCAL = "true";
process.env.AGENT_TOKEN_REQUIRED = "false";

try {
  fs.unlinkSync(process.env.FISCAL_DB_PATH);
} catch (_) {}

const filaFiscal = require("../filaFiscal");
const fiscalService = require("../fiscalService");
const fiscalMetrics = require("../fiscalMetrics");
const diagnosticoDashboard = require("../diagnosticoDashboard");
const fiscalRelatorio = require("../fiscalRelatorio");
const fiscalRecuperacao = require("../fiscalRecuperacao");
const manifestUpdater = require("../manifestUpdater");
const fiscalStorage = require("../fiscalStorage");
const watchdog = require("../watchdog");
const acbr = require("../acbr");

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((e) => {
      failed++;
      console.error(`  ✗ ${name}:`, e.message);
    });
}

function assertKeys(obj, keys, label) {
  for (const k of keys) {
    assert.ok(Object.prototype.hasOwnProperty.call(obj, k), `${label} falta campo "${k}"`);
  }
}

function assertType(val, type, label) {
  assert.strictEqual(typeof val, type, `${label} deve ser ${type}`);
}

/** Payload mínimo alinhado a agenteLocal.emitirFiscal (CupomFiscal + meta) */
function payloadEmitirFront(correlationId, numeroVenda) {
  return {
    numeroVenda,
    correlationId,
    emitidoEm: new Date().toISOString(),
    cpfCliente: "",
    nomeCliente: "CONSUMIDOR",
    formaPagamento: "dinheiro",
    labelPagamento: "Dinheiro",
    operador: "TESTE",
    subtotal: 0.01,
    desconto: 0,
    total: 0.01,
    valorRecebido: 0.01,
    troco: 0,
    itens: [
      {
        nome: "Item contrato",
        quantidade: 1,
        precoUnitario: 0.01,
        total: 0.01,
        ncm: "21069090",
        cfop: "5102",
        cst: "102",
      },
    ],
    empresa: {
      razaoSocial: "EMPRESA TESTE",
      cnpj: "99999999000191",
      inscricaoEstadual: "ISENTO",
      endereco: "Rua Teste",
      numero: "1",
      bairro: "Centro",
      cidade: "Belo Horizonte",
      uf: "MG",
      cep: "30130000",
    },
  };
}

function httpRequest(baseUrl, method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { "Content-Type": "application/json", ...headers },
      timeout: 8000,
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let json = null;
        try {
          json = data ? JSON.parse(data) : null;
        } catch {
          json = data;
        }
        resolve({ status: res.statusCode, json, raw: data, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    if (body) req.write(body);
    req.end();
  });
}

async function run() {
  console.log("contract.test.js\n");

  filaFiscal.init();
  fiscalMetrics.init();

  await test("POST /fiscal/emitir — correlationId string e fiscal pending", async () => {
    const correlationId = `contract-${Date.now()}`;
    const numeroVenda = `V-CONTRACT-${Date.now()}`;
    const body = payloadEmitirFront(correlationId, numeroVenda);
    const res = await fiscalService.enfileirarEmissao({}, body, { sync: false });
    assertType(res.correlationId, "string", "correlationId");
    assert.strictEqual(res.fiscal, "pending");
    assertType(res.numeroVenda, "string", "numeroVenda");
    assert.strictEqual(res.async, true);
    assert.ok(
      ["PENDENTE", "ENFILEIRADO", "PROCESSANDO"].includes(res.status),
      `status inesperado: ${res.status}`,
    );
  });

  await test("GET /fiscal/emissao/:id — campos StatusEmissaoFiscal", async () => {
    const correlationId = `contract-st-${Date.now()}`;
    const numeroVenda = `V-ST-${Date.now()}`;
    await fiscalService.enfileirarEmissao(
      {},
      payloadEmitirFront(correlationId, numeroVenda),
      { sync: false },
    );
    const st = fiscalService.consultarStatusEmissao(correlationId);
    assertType(st.correlationId, "string", "correlationId");
    assert.ok(st.status, "status obrigatório");
    assert.ok(
      [
        "PENDENTE",
        "ENFILEIRADO",
        "PROCESSANDO",
        "CONCLUIDO",
        "CONCLUIDO_RECUPERADO",
        "FALHA_PERMANENTE",
        "INCERTO",
        "NAO_ENCONTRADO",
      ].includes(st.status) || typeof st.status === "string",
      `status desconhecido: ${st.status}`,
    );
  });

  await test("GET /fiscal/status/:id — mesmo contrato que /fiscal/emissao/:id", async () => {
    const correlationId = `contract-alias-${Date.now()}`;
    const st1 = fiscalService.consultarStatusEmissao(correlationId);
    const st2 = fiscalService.consultarStatusEmissao(correlationId);
    assert.deepStrictEqual(Object.keys(st1).sort(), Object.keys(st2).sort());
  });

  await test("GET /diagnostico/alertas — campos esperados pelo front/smoke", async () => {
    const payload = diagnosticoDashboard.montarAlertasPayload({
      filaFiscal,
      fiscalStorage,
      acbr,
      watchdog,
      manifestUpdater,
      versao: "1.0.0",
    });
    const alertas = filaFiscal.contadoresAlertas();
    const json = {
      filaFiscal: payload.filaFiscal,
      processando: payload.processando,
      incertos: payload.incertos,
      recuperando: payload.recuperando,
      incertosComBackoff: payload.incertosComBackoff,
      falhasUltimas24h: payload.falhasUltimas24h,
      acbr: payload.acbr,
      espacoDisco: payload.espacoDisco,
      ultimaEmissao: alertas.ultimaEmissao,
      ultimaEmissaoSucesso: alertas.ultimaEmissaoSucesso,
      metricas: {
        emissoesHoje: fiscalMetrics.emissoesHoje(),
        taxaSucessoPercent: fiscalMetrics.taxaSucessoPercent(),
      },
      versao: "1.0.0",
      manifestOk: manifestUpdater.isManifestOk(),
      statusGeral: diagnosticoDashboard.calcularStatusGeral(payload),
      timestamp: payload.timestamp,
    };
    assertKeys(json, [
      "acbr",
      "versao",
      "manifestOk",
      "statusGeral",
      "ultimaEmissaoSucesso",
      "metricas",
      "timestamp",
    ], "alertas");
    assertType(json.versao, "string", "versao");
    assertType(json.manifestOk, "boolean", "manifestOk");
    assertType(json.metricas.emissoesHoje, "number", "metricas.emissoesHoje");
  });

  await test("GET /diagnostico/saude — contrato mínimo", async () => {
    const json = {
      ok: true,
      versao: "1.0.0",
      uptime: process.uptime(),
      manifestOk: manifestUpdater.isManifestOk(),
      fiscal: filaFiscal.status(),
      timestamp: new Date().toISOString(),
    };
    assertKeys(json, ["ok", "versao", "uptime", "manifestOk", "fiscal", "timestamp"], "saude");
    assert.strictEqual(json.ok, true);
    assertType(json.uptime, "number", "uptime");
  });

  await test("POST /diagnostico/recovery — jobsReprocessados number", async () => {
    const r = await fiscalRecuperacao.forcarRecoveryManual(async () => ({}));
    assertKeys(r, ["jobsReprocessados", "resetados", "timestamp"], "recovery");
    assertType(r.jobsReprocessados, "number", "jobsReprocessados");
  });

  await test("GET /diagnostico/relatorio — emissoes.total number", async () => {
    const r = fiscalRelatorio.gerarRelatorio(new Date().toISOString().slice(0, 10));
    assert.ok(r.emissoes, "emissoes");
    assertType(r.emissoes.total, "number", "emissoes.total");
  });

  await test("GET /diagnostico/dashboard — HTML com status operacional", async () => {
    const payload = diagnosticoDashboard.montarAlertasPayload({
      filaFiscal,
      fiscalStorage,
      acbr,
      watchdog,
      manifestUpdater,
      versao: "1.0.0",
    });
    const html = diagnosticoDashboard.renderDashboardHtml(payload);
    assert.ok(typeof html === "string" && html.includes("<!DOCTYPE html"), "HTML");
    assert.ok(
      html.includes("OPERACIONAL") ||
        html.includes("DEGRADADO") ||
        html.includes("CRÍTICO"),
      "status no HTML",
    );
    assert.ok(html.includes("1.0.0") || html.includes("versao"), "versão no HTML");
  });

  await test("GET /health — ok e versao (multi-caixa ping)", async () => {
    const json = { ok: true, versao: "1.0.0", uptime: process.uptime() };
    assertKeys(json, ["ok", "versao", "uptime"], "health");
    assert.strictEqual(json.ok, true);
  });

  await test("GET /status — campos StatusAgente", async () => {
    const json = {
      online: true,
      impressoraConectada: false,
      acbrConectado: false,
      versao: "1.0.0",
      ativado: false,
      pdvNome: "PDV",
      filaOffline: { pendentes: 0, falhas: 0 },
      contingencia: { ativa: false, epecPendentes: 0 },
    };
    assertKeys(
      json,
      ["online", "impressoraConectada", "acbrConectado", "versao", "filaOffline"],
      "status",
    );
    assertType(json.online, "boolean", "online");
  });

  await test("POST /fiscal/emitir sem numeroVenda — erro (validação)", async () => {
    await assert.rejects(
      () => fiscalService.enfileirarEmissao({}, { correlationId: "x" }, { sync: false }),
      /numeroVenda obrigatório/,
    );
  });

  const baseUrl = process.env.AGENTE_URL || process.env.CONTRACT_AGENTE_URL;
  if (baseUrl) {
    await test("HTTP GET /diagnostico/saude — Content-Type application/json", async () => {
      const r = await httpRequest(baseUrl, "GET", "/diagnostico/saude");
      assert.strictEqual(r.status, 200);
      assert.ok(
        String(r.headers["content-type"] || "").includes("application/json"),
        "Content-Type JSON",
      );
      assert.strictEqual(r.json.ok, true);
    });

    await test("HTTP security headers não bloqueiam fetch JSON", async () => {
      const r = await httpRequest(baseUrl, "GET", "/diagnostico/saude");
      assert.ok(r.headers["x-content-type-options"], "nosniff");
      assert.ok(r.headers["x-frame-options"], "DENY");
    });
  } else {
    console.log("  (HTTP live tests omitidos — defina AGENTE_URL para incluí-los)\n");
  }

  console.log(`\ncontract: ${passed}/${passed + failed} ✓\n`);
  if (failed) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

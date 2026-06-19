#!/usr/bin/env node
/**
 * Smoke integrado front ↔ back — npm run smoke:integration
 * Usa mesmos headers e payload que margin-engine-front/src/services/agenteLocal.ts
 */
require("dotenv").config();
const http = require("http");
const https = require("https");

const AGENTE_URL = (
  process.argv.find((a) => a.startsWith("--url="))?.slice(6) ||
  process.env.AGENTE_URL ||
  "http://localhost:9100"
).replace(/\/$/, "");

const AGENTE_TOKEN =
  process.argv.find((a) => a.startsWith("--token="))?.slice(8) ||
  process.env.AGENTE_TOKEN ||
  process.env.X_AGENT_TOKEN ||
  "";

function parseAgenteUrls() {
  const raw =
    process.env.VITE_AGENTE_URLS ||
    process.env.AGENTE_URLS ||
    "";
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length > 0) {
        return arr.map((u) => String(u).replace(/\/$/, ""));
      }
    } catch (_) {}
  }
  return [AGENTE_URL];
}

let falhas = 0;
let passos = 0;

function log(step, msg, ok = true) {
  passos++;
  console.log(`[${new Date().toISOString()}] ${ok ? "✓" : "✗"} ${step}: ${msg}`);
  if (!ok) falhas++;
}

function request(base, method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const lib = url.protocol === "https:" ? https : http;
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        "Content-Type": "application/json",
        ...(AGENTE_TOKEN ? { "X-Agent-Token": AGENTE_TOKEN } : {}),
        ...headers,
      },
      timeout: 15000,
    };
    const req = lib.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let json = null;
        try {
          json = data ? JSON.parse(data) : null;
        } catch {
          json = data;
        }
        resolve({ status: res.statusCode, json, raw: data });
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

/** Payload idêntico ao agenteLocal.emitirFiscal (CupomFiscal + meta) */
function buildPayloadEmitir(numeroVenda, correlationId) {
  return {
    numeroVenda,
    correlationId,
    emitidoEm: new Date().toISOString(),
    cpfCliente: "",
    nomeCliente: "CONSUMIDOR TESTE",
    formaPagamento: "dinheiro",
    labelPagamento: "Dinheiro",
    operador: "SMOKE-INT",
    subtotal: 0.01,
    desconto: 0,
    total: 0.01,
    valorRecebido: 0.01,
    troco: 0,
    itens: [
      {
        nome: "Item smoke integration",
        quantidade: 1,
        precoUnitario: 0.01,
        total: 0.01,
        ncm: "21069090",
        cfop: "5102",
        cst: "102",
        aliquotaIcms: 0,
      },
    ],
    empresa: {
      razaoSocial: "EMPRESA TESTE SMOKE INT",
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

async function fluxoVenda(baseUrl, label, caixaId) {
  const correlationId = `int-${caixaId}-${Date.now()}`;
  const numeroVenda = `V-INT-${caixaId}-${Date.now()}`;
  const payload = buildPayloadEmitir(numeroVenda, correlationId);

  let r = await request(
    baseUrl,
    "POST",
    "/fiscal/emitir",
    JSON.stringify(payload),
    { "X-Correlation-Id": correlationId },
  );
  const corr = r.json?.correlationId || correlationId;
  if (r.status >= 200 && r.status < 300 && typeof corr === "string") {
    log(`${label} POST /fiscal/emitir`, `correlationId=${corr}`);
  } else {
    log(
      `${label} POST /fiscal/emitir`,
      `HTTP ${r.status}`,
      false,
    );
    return null;
  }

  const pollPath = `/fiscal/status/${encodeURIComponent(corr)}`;
  const inicio = Date.now();
  let concluido = false;
  while (Date.now() - inicio < 60000) {
    await new Promise((res) => setTimeout(res, 2000));
    r = await request(baseUrl, "GET", pollPath);
    const st = r.json?.status;
    if (st === "CONCLUIDO" || st === "CONCLUIDO_RECUPERADO") {
      log(`${label} GET /fiscal/status/:id`, `status=${st}`);
      concluido = true;
      break;
    }
    if (st === "FALHA_PERMANENTE") {
      log(`${label} GET /fiscal/status/:id`, r.json?.erro || st, false);
      return corr;
    }
  }
  if (!concluido) {
    log(`${label} GET /fiscal/status/:id`, "timeout 60s", false);
  }
  return corr;
}

async function main() {
  console.log(`smoke-integration.js — ${AGENTE_URL}\n`);

  let r;
  try {
    r = await request(AGENTE_URL, "GET", "/diagnostico/saude");
  } catch (err) {
    log("fatal", err.message, false);
    process.exit(1);
  }

  if (r.status === 200 && r.json?.ok === true) {
    log("GET /diagnostico/saude", `versao=${r.json.versao}`);
  } else {
    log("GET /diagnostico/saude", `HTTP ${r.status}`, false);
    process.exit(1);
  }

  r = await request(AGENTE_URL, "GET", "/diagnostico/alertas");
  if (r.status === 200 && r.json?.acbr && r.json.acbr !== "offline") {
    log("GET /diagnostico/alertas", `acbr=${r.json.acbr}`);
  } else {
    log(
      "GET /diagnostico/alertas",
      `acbr=${r.json?.acbr || "offline"} — ACBr offline`,
      false,
    );
    process.exit(1);
  }

  const corr = await fluxoVenda(AGENTE_URL, "caixa-1", "1");
  if (!corr) process.exit(1);

  r = await request(AGENTE_URL, "GET", "/diagnostico/alertas");
  const ultima = r.json?.ultimaEmissaoSucesso;
  if (
    ultima?.correlation_id === corr ||
    ultima?.correlationId === corr ||
    ultima
  ) {
    log("GET /diagnostico/alertas (pós-venda)", "ultimaEmissaoSucesso presente");
  } else {
    log("GET /diagnostico/alertas (pós-venda)", "sem ultimaEmissaoSucesso", false);
  }

  r = await request(AGENTE_URL, "GET", "/diagnostico/dashboard");
  if (
    r.status === 200 &&
    typeof r.raw === "string" &&
    (r.raw.includes("1.0.0") || r.raw.includes("v1.0"))
  ) {
    log("GET /diagnostico/dashboard", "HTML com versão 1.0.0");
  } else {
    log("GET /diagnostico/dashboard", `HTTP ${r.status}`, false);
    process.exit(1);
  }

  r = await request(AGENTE_URL, "POST", "/diagnostico/recovery", "{}");
  if (r.status === 200 && typeof r.json?.jobsReprocessados === "number") {
    log(
      "POST /diagnostico/recovery",
      `jobsReprocessados=${r.json.jobsReprocessados}`,
    );
  } else {
    log("POST /diagnostico/recovery", `HTTP ${r.status}`, false);
    process.exit(1);
  }

  const hoje = new Date().toISOString().slice(0, 10);
  r = await request(AGENTE_URL, "GET", `/diagnostico/relatorio?data=${hoje}`);
  if (r.status === 200 && typeof r.json?.emissoes?.total === "number") {
    log("GET /diagnostico/relatorio", `emissoes.total=${r.json.emissoes.total}`);
  } else {
    log("GET /diagnostico/relatorio", "emissoes.total ausente", false);
    process.exit(1);
  }

  const urls = parseAgenteUrls();
  if (urls.length >= 2) {
    log("multi-caixa", `${urls.length} URLs configuradas`);
    const corr2 = await fluxoVenda(urls[1], "caixa-2", "2");
    if (!corr2) process.exit(1);
  }

  const totalSteps = 8 + (parseAgenteUrls().length >= 2 ? 2 : 0);
  console.log(
    falhas
      ? `\nSmoke integration com ${falhas} falha(s) (${passos} passos).\n`
      : `\nSmoke integration OK (${passos} passos).\n`,
  );
  process.exit(falhas ? 1 : 0);
}

main().catch((err) => {
  console.error(`✗ fatal: ${err.message}`);
  process.exit(1);
});

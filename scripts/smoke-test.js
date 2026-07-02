#!/usr/bin/env node
/**
 * Smoke test de caixa real — npm run smoke
 * Requer agente rodando (AGENTE_URL) e ACBr online.
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

let falhas = 0;

function ts() {
  return new Date().toISOString();
}

function log(step, msg, ok = true) {
  console.log(`[${ts()}] ${ok ? "✓" : "✗"} ${step}: ${msg}`);
  if (!ok) falhas++;
}

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, AGENTE_URL);
    const lib = url.protocol === "https:" ? https : http;
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
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

async function main() {
  console.log(`smoke-test.js — ${AGENTE_URL}\n`);

  let r = await request("GET", "/diagnostico/saude");
  if (r.status === 200 && r.json?.ok) {
    log("GET /diagnostico/saude", `HTTP ${r.status}`);
  } else {
    log("GET /diagnostico/saude", `HTTP ${r.status}`, false);
    process.exit(1);
  }

  r = await request("GET", "/diagnostico/alertas");
  if (r.status === 200) {
    const acbr = r.json?.acbr;
    if (acbr && acbr !== "offline") {
      log("GET /diagnostico/alertas", `acbr=${acbr}`);
    } else {
      log(
        "GET /diagnostico/alertas",
        `acbr=${acbr || "unknown"} — ACBr offline (smoke fiscal abortado)`,
        false,
      );
      process.exit(1);
    }
  } else {
    log("GET /diagnostico/alertas", `HTTP ${r.status}`, false);
    process.exit(1);
  }

  const correlationId = `smoke-${Date.now()}`;
  const numeroVenda = `SMOKE-${Date.now()}`;
  const payload = {
    numeroVenda,
    correlationId,
    cpfCliente: "00000000191",
    nomeCliente: "CONSUMIDOR TESTE",
    formaPagamento: "dinheiro",
    total: 0.01,
    desconto: 0,
    subtotal: 0.01,
    itens: [
      {
        nome: "Item smoke test",
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
      razaoSocial: "EMPRESA TESTE SMOKE",
      cnpj: "99999999000191",
      ie: "ISENTO",
      endereco: "Rua Teste",
      numero: "1",
      bairro: "Centro",
      municipio: "Belo Horizonte",
      uf: "MG",
      cep: "30130000",
    },
  };

  r = await request(
    "POST",
    "/fiscal/emitir",
    JSON.stringify(payload),
    {
      "Content-Type": "application/json",
      "X-Correlation-Id": correlationId,
    },
  );
  const corr =
    r.json?.correlationId || correlationId;
  if (r.status >= 200 && r.status < 300 && corr) {
    log("POST /fiscal/emitir", `correlationId=${corr}`);
  } else {
    log(
      "POST /fiscal/emitir",
      `HTTP ${r.status} — ${JSON.stringify(r.json)?.slice(0, 200)}`,
      false,
    );
    process.exit(1);
  }

  const pollPath = `/fiscal/emissao/${encodeURIComponent(corr)}`;
  const inicio = Date.now();
  let concluido = false;
  while (Date.now() - inicio < 60000) {
    await new Promise((res) => setTimeout(res, 2000));
    r = await request("GET", pollPath);
    const st = r.json?.status;
    if (st === "CONCLUIDO" || st === "CONCLUIDO_RECUPERADO") {
      log("Polling emissão", `status=${st} em ${Math.round((Date.now() - inicio) / 1000)}s`);
      concluido = true;
      break;
    }
    if (st === "FALHA_PERMANENTE") {
      log("Polling emissão", r.json?.erro || st, false);
      process.exit(1);
    }
  }
  if (!concluido) {
    log("Polling emissão", "timeout 60s", false);
    process.exit(1);
  }

  r = await request("GET", "/diagnostico/alertas");
  const ultima = r.json?.ultimaEmissaoSucesso;
  if (ultima?.correlation_id === corr || ultima?.correlationId === corr) {
    log("ultimaEmissaoSucesso", "atualizado");
  } else if (ultima) {
    log(
      "ultimaEmissaoSucesso",
      `última=${ultima.correlation_id || ultima.correlationId} (esperado ${corr})`,
    );
  } else {
    log("ultimaEmissaoSucesso", "sem registro (pode estar OK se métricas vazias)");
  }

  r = await request("GET", "/diagnostico/painel");
  if (
    r.status === 200 &&
    typeof r.raw === "string" &&
    r.raw.includes("Margin Engine") &&
    r.raw.includes("Diagnóstico")
  ) {
    log("GET /diagnostico/painel", "HTML OK");
  } else {
    log("GET /diagnostico/painel", `HTTP ${r.status}`, false);
    process.exit(1);
  }

  r = await request("POST", "/diagnostico/recovery", "{}");
  if (r.status === 200 && typeof r.json?.jobsReprocessados === "number") {
    log(
      "POST /diagnostico/recovery",
      `jobsReprocessados=${r.json.jobsReprocessados}`,
    );
  } else {
    log(
      "POST /diagnostico/recovery",
      `HTTP ${r.status} — ${JSON.stringify(r.json)?.slice(0, 120)}`,
      false,
    );
    process.exit(1);
  }

  const hoje = new Date().toISOString().slice(0, 10);
  r = await request("GET", `/diagnostico/relatorio?data=${hoje}`);
  if (r.status === 200 && (r.json?.emissoes?.total ?? 0) >= 1) {
    log(
      "GET /diagnostico/relatorio",
      `emissoes.total=${r.json.emissoes.total}`,
    );
  } else {
    log(
      "GET /diagnostico/relatorio",
      `emissoes.total=${r.json?.emissoes?.total ?? "?"}`,
      false,
    );
    process.exit(1);
  }

  console.log(falhas ? "\nSmoke test com avisos.\n" : "\nSmoke test OK.\n");
  process.exit(falhas ? 1 : 0);
}

main().catch((err) => {
  console.error(`[${ts()}] ✗ fatal: ${err.message}`);
  process.exit(1);
});

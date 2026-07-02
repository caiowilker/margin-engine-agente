#!/usr/bin/env node
/**
 * Auditoria final HARDENING 1.0 — executável local/CI.
 * Não substitui homologação física Windows, mas valida todos os gates automatizáveis.
 */
const { execSync } = require("child_process");
const path = require("path");

const appDir = path.resolve(__dirname, "..");
const live = process.argv.includes("--live");
const agentUrl = process.env.AGENTE_URL || "http://127.0.0.1:9100";

const steps = [
  {
    id: "T01",
    nome: "Testes unitários agente (npm test)",
    cmd: "npm test",
    cwd: appDir,
    required: true,
  },
  {
    id: "T02",
    nome: "Hardening config SSOT",
    cmd: "node --test test/hardening-config-ssot.test.js",
    cwd: appDir,
    required: true,
  },
  {
    id: "T03",
    nome: "Hardening enterprise",
    cmd: "node --test test/hardening-enterprise.test.js",
    cwd: appDir,
    required: true,
  },
  {
    id: "T04",
    nome: "Diagnóstico instalador (offline)",
    cmd: "node scripts/installer-diagnostic.js",
    cwd: appDir,
    required: true,
  },
  {
    id: "T05",
    nome: "Homologação agente offline",
    cmd: "node scripts/homologacao-agente-1.0.js",
    cwd: appDir,
    required: true,
  },
  {
    id: "T06",
    nome: "Ícone instalador",
    cmd: "node scripts/build-installer-icon.js",
    cwd: appDir,
    required: true,
  },
  {
    id: "T07",
    nome: "Pre-deploy check",
    cmd: "node scripts/pre-deploy-check.js",
    cwd: appDir,
    required: false,
  },
];

if (live) {
  steps.push({
    id: "T08",
    nome: "Smoke test agente live",
    cmd: `node scripts/smoke-test.js --url=${agentUrl}`,
    cwd: appDir,
    required: false,
  });
  steps.push({
    id: "T09",
    nome: "Homologação agente live",
    cmd: `node scripts/homologacao-agente-1.0.js --live --url=${agentUrl}`,
    cwd: appDir,
    required: false,
  });
}

const results = [];
let failedRequired = 0;

console.log("=== Auditoria HARDENING 1.0 — Margin Engine ===\n");

for (const step of steps) {
  const t0 = Date.now();
  try {
    execSync(step.cmd, {
      cwd: step.cwd,
      stdio: "pipe",
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "test", LOG_SILENT: "true" },
    });
    results.push({ ...step, ok: true, ms: Date.now() - t0 });
    console.log(`✓ ${step.id} ${step.nome} (${Date.now() - t0}ms)`);
  } catch (err) {
    const ok = !step.required;
    results.push({
      ...step,
      ok,
      ms: Date.now() - t0,
      erro: (err.stderr || err.stdout || err.message || "").slice(0, 400),
    });
    if (step.required) failedRequired += 1;
    console.log(`${ok ? "!" : "✗"} ${step.id} ${step.nome}`);
    if (step.required) {
      console.log(String(err.stderr || err.stdout || err.message).slice(0, 500));
    }
  }
}

const outPath = path.join(appDir, "data", "auditoria-hardening-1.0.json");
try {
  const fs = require("fs");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        live,
        ok: failedRequired === 0,
        results,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\nRelatório: ${outPath}`);
} catch {
  /* ignore */
}

console.log(
  failedRequired === 0
    ? "\nAuditoria automatizada: APROVADA"
    : `\nAuditoria automatizada: REPROVADA (${failedRequired} bloqueador(es))`,
);

process.exit(failedRequired === 0 ? 0 : 1);

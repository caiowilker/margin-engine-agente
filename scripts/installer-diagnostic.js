#!/usr/bin/env node
/**
 * Diagnóstico rápido pós-instalação / reparo / atualização.
 * Linguagem voltada ao operador — sem expor componentes internos.
 *
 * Uso:
 *   node scripts/installer-diagnostic.js [appDir] [--json-only]
 *
 * Saída:
 *   ProgramData/MarginEngine/Diagnostics/install-last-report.json
 *   ProgramData/MarginEngine/Diagnostics/install-last-report.txt
 *
 * Exit: 0 = sem problemas bloqueantes | 1 = há problemas
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const net = require("net");

const appDir = path.resolve(process.argv[2] || path.join(__dirname, ".."));
const jsonOnly = process.argv.includes("--json-only");

process.env.MARGIN_ENGINE_AGENT_ROOT = appDir;
process.env.LOG_SILENT = "true";
process.env.LOG_PATCH_CONSOLE = "false";

const PORT = Number(process.env.AGENT_PORT || process.env.PORT || 9100);

function readEnvFile() {
  const envPath = path.join(appDir, ".env");
  if (!fs.existsSync(envPath)) return {};
  const map = {};
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    map[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return map;
}

function addIssue(report, severity, code, message, solution) {
  report.issues.push({ severity, code, message, solution });
  if (severity === "error") report.ok = false;
}

function checkPortOpen(port) {
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

function checkHealth() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}/health`, { timeout: 3000 }, (res) => {
      let body = "";
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => {
        try {
          resolve({ ok: res.statusCode === 200, data: JSON.parse(body) });
        } catch {
          resolve({ ok: res.statusCode === 200, data: null });
        }
      });
    });
    req.on("error", () => resolve({ ok: false, data: null }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, data: null });
    });
  });
}

async function runDiagnostic() {
  const started = Date.now();
  const report = {
    ok: true,
    product: "Margin Engine",
    version: null,
    checkedAt: new Date().toISOString(),
    durationMs: 0,
    checks: {},
    issues: [],
  };

  try {
    report.version = require(path.join(appDir, "package.json")).version;
  } catch {
    addIssue(
      report,
      "error",
      "ME-001",
      "Instalação incompleta: arquivos do agente não encontrados.",
      "Execute o instalador novamente em modo Reparar.",
    );
  }

  const env = readEnvFile();
  const nodeMajor = parseInt(String(process.version).split(".")[0].replace("v", ""), 10);
  report.checks.node = { version: process.version, ok: nodeMajor >= 18 };
  if (nodeMajor < 18) {
    addIssue(
      report,
      "error",
      "ME-002",
      "Versão do Node.js incompatível com o Margin Engine.",
      "Reinstale usando o pacote oficial do instalador.",
    );
  }

  const nm = path.join(appDir, "node_modules");
  report.checks.dependencies = { ok: fs.existsSync(nm) };
  if (!fs.existsSync(nm)) {
    addIssue(
      report,
      "error",
      "ME-003",
      "Dependências do agente não foram instaladas.",
      "Execute o instalador em modo Reparar.",
    );
  }

  try {
    require(path.join(appDir, "node_modules", "better-sqlite3"));
    report.checks.sqlite = { ok: true };
  } catch {
    report.checks.sqlite = { ok: false };
    addIssue(
      report,
      "error",
      "ME-004",
      "Banco de dados local não está disponível.",
      "Execute o instalador em modo Reparar.",
    );
  }

  let dm;
  try {
    const { getDirectoryManager } = require(path.join(appDir, "runtime", "directoryManager"));
    dm = getDirectoryManager();
    dm.ensureAll();
    report.checks.directories = { ok: true, root: dm.ROOT };
  } catch (err) {
    report.checks.directories = { ok: false };
    addIssue(
      report,
      "error",
      "ME-005",
      "Não foi possível preparar os diretórios de dados do Margin Engine.",
      `Verifique permissões na pasta de dados do Margin Engine (${dm?.ROOT || "dados locais"}). Detalhe: ${err.message}`,
    );
  }

  if (dm) {
    const logsDir = dm.dir("logs");
    report.checks.logs = { ok: fs.existsSync(logsDir) };
    if (!fs.existsSync(logsDir)) {
      addIssue(
        report,
        "warning",
        "ME-006",
        "Pasta de logs não foi criada.",
        "Execute modo Reparar ou reinicie o serviço.",
      );
    }
  }

  const manifestPath = path.join(appDir, "manifest.json");
  report.checks.integrity = { ok: fs.existsSync(manifestPath) };
  if (!fs.existsSync(manifestPath)) {
    addIssue(
      report,
      "warning",
      "ME-007",
      "Verificação de integridade dos arquivos pendente.",
      "Execute modo Reparar.",
    );
  }

  const frontend = path.join(appDir, "frontend-dist", "index.html");
  report.checks.offlinePdv = { ok: fs.existsSync(frontend) };
  if (!fs.existsSync(frontend)) {
    addIssue(
      report,
      "warning",
      "ME-008",
      "Interface do PDV offline não está incluída nesta instalação.",
      "O caixa precisará de internet para abrir o PDV até atualizar o pacote.",
    );
  }

  const fiscalModule = path.join(appDir, "acbrlib", "lib");
  let fiscalReady = false;
  if (fs.existsSync(fiscalModule)) {
    fiscalReady = fs.readdirSync(fiscalModule).some((f) => /\.dll$/i.test(f));
  }
  const emissao = String(env.EMISSAO_FISCAL || "").toLowerCase() === "true";
  report.checks.fiscal = { configured: emissao, modulePresent: fiscalReady };
  if (emissao) {
    const certPath = env.CERT_A1_PATH;
    const certFs = certPath ? certPath.replace(/\\\\/g, "\\") : "";
    if (!certFs || !fs.existsSync(certFs)) {
      addIssue(
        report,
        "warning",
        "ME-009",
        "Emissão fiscal ativada, mas o certificado digital não está configurado.",
        "Configure o certificado no painel do Margin Engine (http://localhost:9100).",
      );
    }
  } else if (!fiscalReady) {
    addIssue(
      report,
      "warning",
      "ME-010",
      "Módulo de documentos fiscais não está presente neste pacote.",
      "Reinstale o pacote completo do Margin Engine.",
    );
  }

  const printerModule = path.join(appDir, "posprinter", "lib");
  const printerReady = fs.existsSync(printerModule) && fs.readdirSync(printerModule).length > 0;
  report.checks.printer = { modulePresent: printerReady };
  if (!printerReady) {
    addIssue(
      report,
      "warning",
      "ME-011",
      "Módulo de impressão não encontrado na instalação.",
      "Reinstale o pacote completo ou conecte uma impressora compatível via painel.",
    );
  }

  const portOpen = await checkPortOpen(PORT);
  report.checks.agentPort = { port: PORT, listening: portOpen };
  if (!portOpen) {
    addIssue(
      report,
      "warning",
      "ME-012",
      `O agente Margin Engine não está respondendo na porta ${PORT}.`,
      "Inicie o serviço Windows «Margin Engine» (SCM: marginengine.exe). Legado: pdvmarginengine.exe. Ou execute Reparar no instalador.",
    );
  }

  const health = await checkHealth();
  report.checks.health = { ok: health.ok, data: health.data };
  if (portOpen && !health.ok) {
    addIssue(
      report,
      "warning",
      "ME-013",
      "O agente está na porta local, mas o diagnóstico de saúde falhou.",
      "Consulte os logs em Logs/application.log e execute modo Reparar.",
    );
  }

  report.durationMs = Date.now() - started;
  return report;
}

function writeReports(report, dmRoot) {
  const diagDir = dmRoot
    ? path.join(dmRoot, "Diagnostics")
    : path.join(appDir, "data", "diagnostics-fallback");
  fs.mkdirSync(diagDir, { recursive: true });

  const jsonPath = path.join(diagDir, "install-last-report.json");
  const txtPath = path.join(diagDir, "install-last-report.txt");

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");

  const lines = [
    "Margin Engine — Diagnóstico rápido",
    `Data: ${report.checkedAt}`,
    `Versão: ${report.version || "?"}`,
    `Resultado: ${report.ok ? "OK" : "ATENÇÃO NECESSÁRIA"}`,
    "",
  ];

  if (report.issues.length === 0) {
    lines.push("Nenhum problema detectado. O agente está pronto para ativação no painel.");
  } else {
    lines.push("Problemas encontrados:");
    for (const i of report.issues) {
      lines.push("");
      lines.push(`[${i.code}] ${i.message}`);
      lines.push(`Solução: ${i.solution}`);
    }
  }

  fs.writeFileSync(txtPath, lines.join("\n"), "utf8");
  return { jsonPath, txtPath, text: lines.join("\n") };
}

async function main() {
  let dmRoot = null;
  try {
    const { getDirectoryManager } = require(path.join(appDir, "runtime", "directoryManager"));
    dmRoot = getDirectoryManager().ROOT;
  } catch {
    /* fallback */
  }

  const report = await runDiagnostic();
  const { text } = writeReports(report, dmRoot);

  if (!jsonOnly) {
    console.log(text);
  }

  process.exit(report.ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Falha no diagnóstico:", err.message);
    process.exit(1);
  });
}

module.exports = { runDiagnostic, writeReports };

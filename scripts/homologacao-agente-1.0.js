#!/usr/bin/env node
/**
 * Checklist automatizado H1–H7 (agente local) — Margin Engine 1.0
 *
 * Uso:
 *   node scripts/homologacao-agente-1.0.js [appDir]
 *   node scripts/homologacao-agente-1.0.js --live --url=http://127.0.0.1:9100 [--token=...]
 *
 * Saída: ProgramData/MarginEngine/Diagnostics/homologacao-agente-1.0.json
 * Exit 0 = sem bloqueadores | 1 = há bloqueadores
 */
const fs = require("fs");
const path = require("path");
const http = require("http");

const args = process.argv.slice(2);
const live = args.includes("--live");
const appDir = path.resolve(
  args.find((a) => !a.startsWith("--")) || path.join(__dirname, ".."),
);
const agentUrl = (
  args.find((a) => a.startsWith("--url="))?.slice(6) ||
  process.env.AGENTE_URL ||
  "http://127.0.0.1:9100"
).replace(/\/$/, "");
const token =
  args.find((a) => a.startsWith("--token="))?.slice(8) ||
  process.env.AGENTE_TOKEN ||
  process.env.X_AGENT_TOKEN ||
  "";

process.env.MARGIN_ENGINE_AGENT_ROOT = appDir;
process.env.LOG_SILENT = "true";

function httpGet(urlPath, headers = {}) {
  return new Promise((resolve) => {
    const url = new URL(urlPath, agentUrl);
    const req = http.get(
      url,
      { timeout: 5000, headers: { ...(token ? { "X-Agent-Token": token } : {}), ...headers } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          let json = null;
          try {
            json = body ? JSON.parse(body) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, json, raw: body });
        });
      },
    );
    req.on("error", (err) => resolve({ status: 0, error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, error: "timeout" });
    });
  });
}

function item(id, grupo, titulo, ok, detalhe, bloqueador = false) {
  return { id, grupo, titulo, ok, detalhe, bloqueador };
}

async function runOfflineChecks() {
  const items = [];
  const { runDiagnostic } = require("./installer-diagnostic");
  const report = await runDiagnostic();

  items.push(
    item("H1-01", "H1", "Arquivos do agente presentes", !!report.version, report.version || "ausente", true),
    item("H1-02", "H1", "Node.js >= 18", report.checks.node?.ok === true, report.checks.node?.version),
    item("H1-03", "H1", "Dependências instaladas", report.checks.dependencies?.ok === true, null, true),
    item("H1-04", "H1", "SQLite nativo (better-sqlite3)", report.checks.sqlite?.ok === true, null, true),
    item("H1-05", "H1", "Diretórios Margin Engine", report.checks.directories?.ok === true, report.checks.directories?.root),
    item("H1-06", "H1", "Módulo fiscal presente", report.checks.fiscal?.modulePresent === true, null),
    item("H1-07", "H1", "Módulo impressora presente", report.checks.printer?.modulePresent === true, null),
    item("H1-08", "H1", "Integridade manifest.json", report.checks.integrity?.ok === true, null),
    item("H1-09", "H1", "PDV offline (frontend-dist)", report.checks.offlinePdv?.ok === true, null),
    item("H6-04", "H6", "Paths via DirectoryManager", report.checks.directories?.ok === true, "Sem paths hardcoded no diagnóstico"),
  );

  try {
    const { gerarConteudoIni } = require("../runtime/acbrIniGenerator");
    const ini = gerarConteudoIni({ uf: "MG", ambiente: "homologacao" });
    items.push(
      item(
        "H7-02",
        "H7",
        "INI gerado dinamicamente",
        !/C:\\ProgramData/i.test(ini),
        "acbrIniGenerator OK",
      ),
    );
  } catch (err) {
    items.push(item("H7-02", "H7", "INI gerado dinamicamente", false, err.message, true));
  }

  const ico = path.join(appDir, "assets", "margin-engine.ico");
  items.push(item("H1-10", "H1", "Ícone do instalador", fs.existsSync(ico), ico));

  return { items, installerReport: report };
}

async function runLiveChecks() {
  const items = [];

  const health = await httpGet("/health");
  items.push(
    item("H1-11", "H1", "Serviço respondendo (/health)", health.status === 200, `HTTP ${health.status}`, true),
  );

  const alertas = await httpGet("/diagnostico/alertas");
  const sg = alertas.json?.enterprise?.statusGeral || alertas.json?.statusGeral;
  items.push(
    item(
      "H3-00",
      "H3",
      "Status geral operacional",
      alertas.status === 200 && ["ONLINE", "DEGRADADO", "RECUPERANDO", "ATUALIZANDO", "CONTINGÊNCIA", "CONTINGENCIA"].includes(String(sg)),
      sg || `HTTP ${alertas.status}`,
    ),
  );

  if (token) {
    const diag = await httpGet("/diagnostico");
    items.push(
      item("H3-01", "H3", "Diagnóstico completo (token)", diag.status === 200, `HTTP ${diag.status}`),
      item(
        "H7-01",
        "H7",
        "Driver fiscal integrado",
        diag.json?.acbr?.mode === "native" || diag.json?.enterprise?.fiscal?.driver === "Integrado",
        diag.json?.enterprise?.fiscal?.driver || diag.json?.acbr?.mode,
      ),
      item(
        "H4-01",
        "H4",
        "Impressora detectada",
        diag.json?.impressora?.ok === true || diag.json?.enterprise?.impressora?.ok === true,
        diag.json?.impressora?.detectada || diag.json?.enterprise?.impressora?.modelo,
      ),
      item(
        "H6-01",
        "H6",
        "Banco local online",
        diag.json?.banco?.ok === true || diag.json?.enterprise?.banco?.ok === true,
        diag.json?.enterprise?.banco?.integridade,
      ),
    );

    const preflight = await httpGet("/diagnostico/fiscal");
    const pfOk = preflight.json?.preflight?.ok === true;
    items.push(
      item("H2-02", "H2", "Certificado/CSC preflight", pfOk, pfOk ? "OK" : "Pendente configuração"),
    );
  } else {
    items.push(
      item(
        "H3-01",
        "H3",
        "Diagnóstico completo (token)",
        false,
        "Informe --token= ou AGENTE_TOKEN para checagens completas",
      ),
    );
  }

  const painel = await httpGet("/diagnostico/painel", { Accept: "text/html" });
  items.push(
    item(
      "H3-99",
      "H3",
      "Painel diagnóstico HTML",
      painel.status === 200 && String(painel.raw || "").includes("Margin Engine"),
      `HTTP ${painel.status}`,
    ),
  );

  return items;
}

async function main() {
  const started = Date.now();
  const { items: offline, installerReport } = await runOfflineChecks();
  let items = [...offline];

  if (live) {
    items = items.concat(await runLiveChecks());
  }

  const bloqueadores = items.filter((i) => i.bloqueador && !i.ok);
  const avisos = items.filter((i) => !i.bloqueador && !i.ok);
  const ok = bloqueadores.length === 0;

  const report = {
    produto: "Margin Engine",
    versao: installerReport.version || null,
    modo: live ? "live" : "offline",
    agentUrl: live ? agentUrl : null,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    ok,
    resumo: {
      total: items.length,
      passou: items.filter((i) => i.ok).length,
      bloqueadores: bloqueadores.length,
      avisos: avisos.length,
    },
    items,
    bloqueadores: bloqueadores.map((b) => ({ id: b.id, titulo: b.titulo, detalhe: b.detalhe })),
  };

  let outDir = path.join(appDir, "data", "diagnostics-fallback");
  try {
    const { getDirectoryManager } = require(path.join(appDir, "runtime", "directoryManager"));
    outDir = path.join(getDirectoryManager().ROOT, "Diagnostics");
  } catch {
    /* fallback */
  }
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "homologacao-agente-1.0.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");

  console.log("Margin Engine — Homologação agente 1.0");
  console.log(`Modo: ${report.modo} | OK: ${report.resumo.passou}/${report.resumo.total}`);
  if (bloqueadores.length) {
    console.log("\nBloqueadores:");
    for (const b of bloqueadores) {
      console.log(`  ✗ [${b.id}] ${b.titulo}${b.detalhe ? ` — ${b.detalhe}` : ""}`);
    }
  }
  if (avisos.length) {
    console.log("\nAvisos:");
    for (const a of avisos) {
      console.log(`  ! [${a.id}] ${a.titulo}${a.detalhe ? ` — ${a.detalhe}` : ""}`);
    }
  }
  console.log(`\nRelatório: ${outPath}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("Falha:", err.message);
  process.exit(1);
});

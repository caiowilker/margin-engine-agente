#!/usr/bin/env node
// Gera manifest.json com SHA-256 de todos os módulos do agente
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const MANIFEST_PATH = path.join(ROOT, "manifest.json");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

const ARQUIVOS_PADRAO = [
  "index.js",
  "acbr.js",
  "fila.js",
  "filaFiscal.js",
  "fiscalService.js",
  "fiscalMetrics.js",
  "fiscalRateLimit.js",
  "diagnosticoRateLimit.js",
  "fiscalPurge.js",
  "fiscalRecuperacao.js",
  "fiscalStorage.js",
  "auditLog.js",
  "fiscalRetry.js",
  "fiscalPreflight.js",
  "fiscalNumeracao.js",
  "fiscalValidacao.js",
  "documentosFiscais.js",
  "reconciliacaoFiscal.js",
  "watchdog.js",
  "impressora.js",
  "credenciais.js",
  "marginPaths.js",
  "logger.js",
  "acbrNfceSetup.js",
  "manifestUpdater.js",
  "fiscalAlertas.js",
  "fiscalRelatorio.js",
  "diagnosticoDashboard.js",
];

function sha256(fp) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(fp));
  return h.digest("hex");
}

function listarArquivos() {
  const set = new Set(ARQUIVOS_PADRAO);
  if (fs.existsSync(MANIFEST_PATH)) {
    try {
      const existing = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
      if (Array.isArray(existing.arquivos)) {
        existing.arquivos.forEach((a) => set.add(a.arquivo));
      }
    } catch (_) {}
  }
  return [...set];
}

const lista = listarArquivos();
const ausentes = [];
const arquivos = [];

for (const arquivo of lista) {
  const fp = path.join(ROOT, arquivo);
  if (!fs.existsSync(fp)) {
    ausentes.push(arquivo);
    continue;
  }
  arquivos.push({
    arquivo,
    sha256: sha256(fp),
  });
}

if (ausentes.length) {
  console.error("ERRO: arquivos listados no manifest não encontrados no disco:");
  ausentes.forEach((a) => console.error(`  - ${a}`));
  process.exit(1);
}

if (!arquivos.length) {
  console.error("ERRO: nenhum arquivo para incluir no manifest.json");
  process.exit(1);
}

const manifest = {
  versao: pkg.version,
  geradoEm: new Date().toISOString(),
  arquivos,
};

fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
console.log(
  `manifest.json gerado — ${arquivos.length} arquivos v${pkg.version} (SHA-256 preenchido)`,
);

#!/usr/bin/env node
/**
 * Release operacional do update remoto — um comando, um checklist.
 *
 *   npm run release:update -- --url=https://cdn.../update.zip --changelog="QR NFC-e"
 *
 * Gera:
 *   dist/update.zip
 *   dist/update-release.json
 *   dist/update-release.env   ← colar no Render / secrets
 *
 * Depois: upload do ZIP na URL informada e setar as 4 env vars no backend.
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "dist");

function parseArgs(argv) {
  const out = { url: "", changelog: "" };
  for (const a of argv) {
    if (a.startsWith("--url=")) out.url = a.slice(6).trim();
    else if (a.startsWith("--changelog=")) out.changelog = a.slice(12).trim();
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Uso:
  npm run release:update -- --url=https://cdn.exemplo/agente/update-1.0.2.zip --changelog="texto"

Passos manuais após o script:
  1. Upload de dist/update.zip para a URL
  2. No Render (margin-engine): colar variáveis de dist/update-release.env
  3. Redeploy do backend
  4. No caixa: Diagnóstico → Verificar → Aplicar (com caixa ocioso)
`);
    process.exit(0);
  }

  console.log("\n[release:update] 1/3 — manifest\n");
  execSync("node scripts/generate-manifest.js", { cwd: ROOT, stdio: "inherit" });

  console.log("\n[release:update] 2/3 — package update.zip\n");
  const { main: packageUpdate } = require("./package-update-zip");
  const meta = packageUpdate();

  const url = args.url || meta.env.PDV_AGENTE_URL_DOWNLOAD || "";
  const changelog =
    args.changelog ||
    `Atualização do agente local v${meta.versao} (código + frontend-dist).`;

  meta.env.PDV_AGENTE_URL_DOWNLOAD = url;
  meta.env.PDV_AGENTE_CHANGELOG = changelog;
  meta.urlDownload = url;
  meta.changelog = changelog;
  meta.checklist = [
    "Fazer upload de dist/update.zip para a URL pública (HTTPS)",
    "Definir no backend: PDV_AGENTE_VERSAO, PDV_AGENTE_URL_DOWNLOAD, PDV_AGENTE_SHA256, PDV_AGENTE_CHANGELOG",
    "Redeploy do margin-engine (Render)",
    "No PDV: Diagnóstico → Verificar atualização → Aplicar (caixa ocioso)",
    "Confirmar versão em GET /health do agente após restart",
  ];

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, "update-release.json"),
    JSON.stringify(meta, null, 2),
  );

  const envBody = [
    `# Margin Engine — update remoto do agente v${meta.versao}`,
    `# Gerado em ${meta.geradoEm}`,
    `# Arquivo: dist/update.zip`,
    `# SHA-256: ${meta.sha256}`,
    ``,
    `PDV_AGENTE_VERSAO=${meta.versao}`,
    `PDV_AGENTE_SHA256=${meta.sha256}`,
    `PDV_AGENTE_URL_DOWNLOAD=${url || "<COLE_A_URL_HTTPS_DO_ZIP>"}`,
    `PDV_AGENTE_CHANGELOG=${JSON.stringify(changelog)}`,
    ``,
  ].join("\n");

  const envPath = path.join(OUT_DIR, "update-release.env");
  fs.writeFileSync(envPath, envBody);

  console.log("\n[release:update] 3/3 — metadados\n");
  console.log(`  ✓ dist/update.zip`);
  console.log(`  ✓ dist/update-release.json`);
  console.log(`  ✓ dist/update-release.env`);
  console.log(`\nChecklist:`);
  meta.checklist.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
  if (!url) {
    console.log(
      `\n⚠  Informe --url=... na próxima execução ou edite PDV_AGENTE_URL_DOWNLOAD em update-release.env`,
    );
  }
  console.log("");
}

main();

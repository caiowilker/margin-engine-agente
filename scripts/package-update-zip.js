#!/usr/bin/env node
/**
 * Empacota update.zip com manifest.json + todos os arquivos listados (agente + frontend-dist).
 * Uso: npm run manifest && npm run package:update
 * Saída: dist/update.zip (SHA-256 impresso no stdout)
 *
 * Política: scripts/manifestPolicy.js — não inclui nativos/DLLs/node_modules.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");
const {
  validarCoberturaObrigatoria,
  resumirPolitica,
} = require("./manifestPolicy");

const ROOT = path.join(__dirname, "..");
const MANIFEST_PATH = path.join(ROOT, "manifest.json");
const OUT_DIR = path.join(ROOT, "dist");
const OUT_ZIP = path.join(OUT_DIR, "update.zip");
const STAGING = path.join(ROOT, ".update-staging");

function sha256File(fp) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(fp));
  return h.digest("hex");
}

function rmrf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function main() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error("ERRO: manifest.json ausente — execute npm run manifest");
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  if (!manifest.arquivos?.length) {
    console.error("ERRO: manifest sem arquivos");
    process.exit(1);
  }

  const nomes = manifest.arquivos.map((a) => a.arquivo);
  const cobertura = validarCoberturaObrigatoria(nomes);
  if (!cobertura.ok) {
    console.error(
      "ERRO: manifest desatualizado — rode npm run manifest. Faltando:",
    );
    cobertura.faltando.forEach((a) => console.error(`  - ${a}`));
    process.exit(1);
  }

  const pkgVersion = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
  ).version;
  if (manifest.versao && manifest.versao !== pkgVersion) {
    console.error(
      `ERRO: manifest.versao (${manifest.versao}) ≠ package.json (${pkgVersion}) — rode npm run manifest`,
    );
    process.exit(1);
  }

  rmrf(STAGING);
  fs.mkdirSync(STAGING, { recursive: true });
  fs.writeFileSync(
    path.join(STAGING, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );

  const ausentes = [];
  for (const item of manifest.arquivos) {
    const src = path.join(ROOT, item.arquivo);
    const dest = path.join(STAGING, item.arquivo);
    if (!fs.existsSync(src)) {
      ausentes.push(item.arquivo);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
  if (ausentes.length) {
    console.error("ERRO: arquivos do manifest ausentes no disco:");
    ausentes.forEach((a) => console.error(`  - ${a}`));
    rmrf(STAGING);
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  rmrf(OUT_ZIP);

  try {
    execSync(`cd "${STAGING}" && zip -qr "${OUT_ZIP}" .`, { stdio: "pipe" });
  } catch {
    execSync(
      `powershell -Command "Compress-Archive -Path '${STAGING}\\*' -DestinationPath '${OUT_ZIP}' -Force"`,
      { stdio: "pipe" },
    );
  }

  const sha = sha256File(OUT_ZIP);
  const frontCount = manifest.arquivos.filter((a) =>
    String(a.arquivo).startsWith("frontend-dist/"),
  ).length;
  const agentCount = manifest.arquivos.length - frontCount;
  const politica = resumirPolitica();

  console.log(`update.zip gerado — ${manifest.arquivos.length} arquivos v${manifest.versao}`);
  console.log(`  agente: ${agentCount} · frontend-dist: ${frontCount}`);
  console.log(`  dirs: ${politica.includeDirs.join(", ")}`);
  console.log(`  SHA-256: ${sha}`);
  console.log(`  caminho: ${OUT_ZIP}`);
  console.log(
    `  requer instalador (não neste ZIP): ${politica.requerInstalador.length} categorias`,
  );

  rmrf(STAGING);
}

main();

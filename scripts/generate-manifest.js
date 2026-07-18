#!/usr/bin/env node
/**
 * Gera manifest.json com SHA-256 do pacote de update remoto.
 * Política: scripts/manifestPolicy.js (print/fiscal/runtime/storage + JS raiz + package.json + frontend-dist).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  listarArquivosUpdate,
  validarCoberturaObrigatoria,
} = require("./manifestPolicy");

const ROOT = path.join(__dirname, "..");
const MANIFEST_PATH = path.join(ROOT, "manifest.json");
const FRONTEND_DIST = "frontend-dist";
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

function sha256(fp) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(fp));
  return h.digest("hex");
}

const lista = listarArquivosUpdate(ROOT);
const cobertura = validarCoberturaObrigatoria(lista);
if (!cobertura.ok) {
  console.error("ERRO: manifest incompleto — faltam arquivos obrigatórios do update remoto:");
  cobertura.faltando.forEach((a) => console.error(`  - ${a}`));
  process.exit(1);
}

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

const frontCount = arquivos.filter((a) =>
  a.arquivo.startsWith(`${FRONTEND_DIST}/`),
).length;
const agentCount = arquivos.length - frontCount;

const manifest = {
  versao: pkg.version,
  geradoEm: new Date().toISOString(),
  arquivos,
};

fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
console.log(
  `manifest.json gerado — ${arquivos.length} arquivos v${pkg.version} ` +
    `(agente: ${agentCount}, frontend-dist: ${frontCount}, SHA-256 preenchido)`,
);

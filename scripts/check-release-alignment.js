#!/usr/bin/env node
/**
 * Valida alinhamento de versão 1.0.0 entre agente, instalador, front e backend.
 * Uso: npm run check:release-alignment
 */
const fs = require("fs");
const path = require("path");

const agentRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.dirname(agentRoot);

const agentVersion = require(path.join(agentRoot, "package.json")).version;

function read(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

const iss = read(path.join(agentRoot, "pdv-agente-installer.iss"));
const issVersion = iss.match(/#define MyAppVersion "([^"]+)"/)?.[1];

const appProps = read(
  path.join(workspaceRoot, "margin-engine/src/main/resources/application.properties"),
);
const backendDefault = appProps.match(
  /pdv\.agente\.versao=\$\{PDV_AGENTE_VERSAO:([^}]+)\}/,
)?.[1];

const envExample = read(path.join(workspaceRoot, "margin-engine/.env.example"));
const envVersion = envExample.match(/PDV_AGENTE_VERSAO=(.+)/)?.[1]?.trim();

const frontPkg = path.join(workspaceRoot, "margin-engine-front/package.json");
const frontVersion = fs.existsSync(frontPkg)
  ? require(frontPkg).version
  : null;

const pom = read(path.join(workspaceRoot, "margin-engine/pom.xml"));
const pomVersion = pom.match(
  /<artifactId>margin-engine<\/artifactId>\s*<version>([^<]+)<\/version>/,
)?.[1];

const checks = [
  ["agente-local/package.json", agentVersion],
  ["pdv-agente-installer.iss", issVersion],
  ["margin-engine application.properties (default)", backendDefault],
  ["margin-engine .env.example", envVersion],
  ["margin-engine-front/package.json", frontVersion],
  ["margin-engine/pom.xml", pomVersion],
];

let failed = 0;
console.log(`\n[check-release-alignment] versão canônica: ${agentVersion}\n`);

for (const [label, value] of checks) {
  if (!value) {
    console.log(`  ✗ ${label} — valor não encontrado`);
    failed += 1;
    continue;
  }
  if (value !== agentVersion) {
    console.log(`  ✗ ${label} — ${value} (esperado ${agentVersion})`);
    failed += 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
}

if (failed) {
  console.log(`\n${failed} desalinhamento(s). Corrija antes do build Windows.\n`);
  process.exit(1);
}

console.log("\nRelease alinhada para build Windows.\n");

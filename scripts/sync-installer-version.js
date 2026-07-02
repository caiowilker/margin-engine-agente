#!/usr/bin/env node
/**
 * Sincroniza #define MyAppVersion no pdv-agente-installer.iss com package.json.
 * Uso: node sync-installer-version.js [caminho/para/pdv-agente-installer.iss]
 */
const fs = require("fs");
const path = require("path");

const agentRoot = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(agentRoot, "package.json"), "utf8"));
const version = String(pkg.version || "1.0.0");
const issPath = path.resolve(process.argv[2] || path.join(agentRoot, "pdv-agente-installer.iss"));

if (!fs.existsSync(issPath)) {
  console.error("[sync-installer-version] .iss não encontrado:", issPath);
  process.exit(1);
}

let iss = fs.readFileSync(issPath, "utf8");
const next = iss.replace(/#define MyAppVersion "[^"]*"/, `#define MyAppVersion "${version}"`);

if (next === iss) {
  console.warn("[sync-installer-version] MyAppVersion não encontrado ou já atualizado");
} else {
  fs.writeFileSync(issPath, next, "utf8");
  console.log("[sync-installer-version]", path.basename(issPath), "→", version);
}

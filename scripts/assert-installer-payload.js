#!/usr/bin/env node
/**
 * Falha o prepare-build se o payload do instalador estiver incompleto ou incoerente.
 * Uso: node scripts/assert-installer-payload.js [appDir]
 */
const fs = require("fs");
const path = require("path");
const {
  manifestEntriesPresent,
} = require("./installerSpeed");

const root = path.resolve(process.argv[2] || path.join(__dirname, ".."));
const fail = [];

function mustExist(rel, label) {
  const fp = path.join(root, rel);
  if (!fs.existsSync(fp)) fail.push(`${label}: ${rel}`);
}

mustExist("scripts/installerSpeed.js", "bootstrap velocidade");
mustExist("scripts/installer-bootstrap.js", "bootstrap");
mustExist("scripts/installer-wait-online.js", "wait online");
mustExist("scripts/installer-service-control.js", "controle SCM");
mustExist("scripts/open-pdv.cmd", "atalho PDV");
mustExist("install-service.js", "serviço Windows");
mustExist("manifest.json", "manifest");
mustExist("BUILD_STAMP.json", "BUILD_STAMP");
mustExist("package.json", "package.json");
mustExist("frontend-dist/index.html", "PDV offline");
mustExist("frontend-dist/api-backend.json", "api-backend.json");
mustExist("acbrlib/lib/ACBrNFe64.dll", "DLL NFe");
mustExist("acbrlib/lib/ACBrNFSe64.dll", "DLL NFS-e");
mustExist("posprinter/lib/ACBrPosPrinter64.dll", "DLL PosPrinter");
mustExist("node_modules/better-sqlite3/build/Release/better_sqlite3.node", "sqlite nativo");
mustExist("node_modules/koffi/build/koffi/win32_x64/koffi.node", "koffi win32");

const front = path.join(root, "frontend-dist");
if (fs.existsSync(front)) {
  const compressed = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (/\.(br|gz)$/i.test(ent.name)) compressed.push(path.relative(root, abs));
    }
  };
  walk(front);
  if (compressed.length) {
    fail.push(`frontend-dist ainda tem ${compressed.length} .br/.gz (o agente não usa)`);
  }
}

if (!manifestEntriesPresent(root)) {
  fail.push("manifest.json lista arquivo ausente, vazio, ou ainda cita .br/.gz");
}

if (fail.length) {
  console.error("assert-installer-payload FALHOU:");
  fail.forEach((m) => console.error(`  - ${m}`));
  process.exit(1);
}

console.log("assert-installer-payload OK — payload coerente para o .exe");

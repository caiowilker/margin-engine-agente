#!/usr/bin/env node
/**
 * CLI: npm run validar-itensmgv -- <arquivo-ITENSMGV.TXT|pasta>
 * Delega ao validador Java do margin-engine (perfil ACBr-150).
 */
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const alvo = process.argv[2];
if (!alvo) {
  console.error("Uso: npm run validar-itensmgv -- <arquivo-ITENSMGV.TXT|pasta>");
  process.exit(2);
}
const abs = path.resolve(alvo);
if (!fs.existsSync(abs)) {
  console.error("Caminho inexistente:", abs);
  process.exit(2);
}

const engine = path.resolve(__dirname, "../../margin-engine");
if (!fs.existsSync(path.join(engine, "pom.xml"))) {
  console.error("margin-engine não encontrado em", engine);
  process.exit(2);
}

const r = spawnSync(
  "mvn",
  ["-q", "-Pvalidar-itensmgv", "exec:java", `-Dvalidar.itensmgv.path=${abs}`],
  { cwd: engine, stdio: "inherit", shell: false },
);
process.exit(r.status == null ? 1 : r.status);

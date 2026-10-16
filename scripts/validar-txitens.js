#!/usr/bin/env node
/**
 * CLI: npm run validar-txitens -- <arquivo-TXITENS.TXT|pasta>
 * Delega ao Maven profile validar-txitens do margin-engine.
 */
const { spawnSync } = require("child_process");
const path = require("path");

const alvo = process.argv[2];
if (!alvo) {
  console.error("Uso: npm run validar-txitens -- <arquivo-TXITENS.TXT|pasta>");
  process.exit(2);
}

const me = path.resolve(__dirname, "../../margin-engine");
const r = spawnSync(
  "mvn",
  ["-q", "-Pvalidar-txitens", "exec:java", `-Dvalidar.txitens.path=${path.resolve(alvo)}`],
  { cwd: me, stdio: "inherit", shell: false },
);
process.exit(r.status == null ? 1 : r.status);

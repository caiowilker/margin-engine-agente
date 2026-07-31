#!/usr/bin/env node
/**
 * Regenera o bloco PRINT_ENV_SCHEMA em .env.example a partir do schema.
 * Uso: node scripts/generate-print-env-example.js [--check]
 * --check: exit 1 se .env.example divergir (CI / pretest).
 */
const fs = require("fs");
const path = require("path");
const {
  PRINT_ENV_BLOCK_START,
  PRINT_ENV_BLOCK_END,
  wrapPrintEnvExampleBlock,
} = require("../config/printEnvSchema");

const ROOT = path.join(__dirname, "..");
const ENV_EXAMPLE = path.join(ROOT, ".env.example");
const checkOnly = process.argv.includes("--check");

function upsertBlock(content, block) {
  const start = content.indexOf(PRINT_ENV_BLOCK_START);
  const end = content.indexOf(PRINT_ENV_BLOCK_END);
  if (start >= 0 && end > start) {
    const afterEnd = end + PRINT_ENV_BLOCK_END.length;
    let tail = content.slice(afterEnd);
    if (!tail.startsWith("\n")) tail = "\n" + tail;
    return content.slice(0, start) + block.trimEnd() + "\n" + tail.replace(/^\n+/, "\n");
  }
  // Inserir antes do bloco "Tipo transporte" legado ou no fim da seção impressora
  const marker = "# Tipo transporte ESC/POS";
  const idx = content.indexOf(marker);
  if (idx >= 0) {
    return content.slice(0, idx) + block + "\n" + content.slice(idx);
  }
  return content.trimEnd() + "\n\n" + block;
}

function main() {
  if (!fs.existsSync(ENV_EXAMPLE)) {
    console.error(".env.example ausente");
    process.exit(1);
  }
  const current = fs.readFileSync(ENV_EXAMPLE, "utf8");
  const block = wrapPrintEnvExampleBlock();
  const next = upsertBlock(current, block);

  if (checkOnly) {
    if (current === next) {
      console.log("print-env-example OK (schema ≡ .env.example)");
      process.exit(0);
    }
    console.error("FAIL: .env.example divergiu do printEnvSchema — rode: npm run generate:print-env");
    process.exit(1);
  }

  fs.writeFileSync(ENV_EXAMPLE, next, "utf8");
  console.log("Atualizado:", ENV_EXAMPLE);
}

main();

/**
 * Testes hardening (legado) — node test/fiscal-hardening.test.js
 */
const assert = require("assert");
const path = require("path");
const fs = require("fs");

const testDir = path.join(__dirname, "data-test-h");
if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

process.env.FISCAL_RATE_LIMIT_MIN = "3";
process.env.FISCAL_RATE_LIMIT_HORA = "10";
process.env.FISCAL_DB_PATH = path.join(testDir, "fila_fiscal.test.db");
process.env.FISCAL_METRICS_DB = path.join(testDir, "metrics.test.db");

for (const f of fs.readdirSync(testDir)) {
  try {
    fs.unlinkSync(path.join(testDir, f));
  } catch (_) {}
}

const fiscalRateLimit = require("../fiscalRateLimit");
const fiscalMetrics = require("../fiscalMetrics");
const filaFiscal = require("../filaFiscal");

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}:`, e.message);
    process.exitCode = 1;
  }
}

console.log("fiscal-hardening.test.js\n");

test("rate limit bloqueia após limite por minuto", () => {
  const cnpj = "12345678000199";
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(fiscalRateLimit.podeEmitir(cnpj).ok, true);
    fiscalRateLimit.registrarTentativa(cnpj);
  }
  assert.strictEqual(fiscalRateLimit.podeEmitir(cnpj).ok, false);
});

test("dedup correlationId", () => {
  filaFiscal.init();
  const a = filaFiscal.enfileirar("EMISSAO", { numeroVenda: "V1" }, "corr-1", "V1");
  const b = filaFiscal.enfileirar("EMISSAO", { numeroVenda: "V1" }, "corr-1", "V1");
  assert.strictEqual(a.id, b.id);
});

test("dedup numeroVenda", () => {
  const a = filaFiscal.enfileirar("EMISSAO", {}, "ca", "V-DEDUP");
  const b = filaFiscal.enfileirar("EMISSAO", {}, "cb", "V-DEDUP");
  assert.strictEqual(a.id, b.id);
});

test("métricas snapshot", () => {
  fiscalMetrics.init();
  fiscalMetrics.registrarEnfileirada();
  fiscalMetrics.registrarEmissao(900, { ok: true, acbrMs: 400 });
  assert.ok(fiscalMetrics.snapshot({}).contadores.enfileiradas >= 1);
});

console.log("\nConcluído.");

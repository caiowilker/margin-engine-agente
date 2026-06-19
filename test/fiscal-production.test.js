/**
 * Testes de produção fiscal — node test/fiscal-production.test.js
 */
const assert = require("assert");
const path = require("path");
const fs = require("fs");

const testDir = path.join(__dirname, "data-test");
if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

process.env.FISCAL_RATE_LIMIT_MIN = "5";
process.env.FISCAL_RATE_LIMIT_HORA = "20";
process.env.FISCAL_DB_PATH = path.join(testDir, "fila_fiscal.prod.test.db");
process.env.FISCAL_METRICS_DB = path.join(testDir, "fiscal_metrics.test.db");
process.env.DB_PATH = path.join(testDir, "fila.prod.test.db");
process.env.FISCAL_INTEGRITY_STRICT = "false";

for (const f of fs.readdirSync(testDir)) {
  try {
    fs.unlinkSync(path.join(testDir, f));
  } catch (_) {}
}

const filaFiscal = require("../filaFiscal");
const fiscalMetrics = require("../fiscalMetrics");
const fiscalRateLimit = require("../fiscalRateLimit");
const fiscalRecuperacao = require("../fiscalRecuperacao");

function test(name, fn) {
  return (async () => {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (e) {
      console.error(`  ✗ ${name}:`, e.message);
      process.exitCode = 1;
    }
  })();
}

async function run() {
  console.log("fiscal-production.test.js\n");

  await test("dedup numero_venda coluna indexada", () => {
    filaFiscal.init();
    const a = filaFiscal.enfileirar(
      "EMISSAO",
      { numeroVenda: "V-100", correlationId: "c1" },
      "c1",
      "V-100",
    );
    const b = filaFiscal.enfileirar(
      "EMISSAO",
      { numeroVenda: "V-100", correlationId: "c2" },
      "c2",
      "V-100",
    );
    assert.strictEqual(a.deduplicado, false);
    assert.strictEqual(b.deduplicado, true);
    assert.strictEqual(b.correlationId, "c1");
  });

  await test("bloqueio job ativo por numeroVenda", () => {
    const ativo = filaFiscal.vendaTemJobAtivo("V-100");
    assert.ok(ativo);
    assert.strictEqual(ativo.status, "PENDENTE");
  });

  await test("payload sem backendToken", () => {
    const Database = require("better-sqlite3");
    const db = new Database(process.env.FISCAL_DB_PATH);
    const row = db.prepare(`SELECT payload FROM fila_fiscal LIMIT 1`).get();
    assert.ok(row);
    assert.ok(!row.payload.includes("backendToken"));
    db.close();
  });

  await test("idempotência _fiscalMeta no payload", () => {
    const r = filaFiscal.enfileirar(
      "EMISSAO",
      { numeroVenda: "V-200", correlationId: "c200" },
      "c200",
      "V-200",
    );
    filaFiscal.atualizarPayload(r.id, {
      _fiscalMeta: { numeroNfe: "42", serieNfe: "1", chave: null },
      numeroNfe: "42",
      serieNfe: "1",
    });
    const Database = require("better-sqlite3");
    const db = new Database(process.env.FISCAL_DB_PATH);
    const job = db.prepare(`SELECT payload FROM fila_fiscal WHERE id = ?`).get(r.id);
    db.close();
    const p = JSON.parse(job.payload);
    assert.strictEqual(p._fiscalMeta.numeroNfe, "42");
  });

  await test("status INCERTO em emissao_resultados", () => {
    filaFiscal.salvarResultadoEmissao("c-inc", "V-INC", "INCERTO", null, "timeout");
    const r = filaFiscal.obterResultadoEmissao("c-inc");
    assert.strictEqual(r.status, "INCERTO");
  });

  await test("CONCLUIDO_RECUPERADO persistido", () => {
    filaFiscal.salvarResultadoEmissao(
      "c-rec",
      "V-REC",
      "CONCLUIDO_RECUPERADO",
      { fiscal: true, chave: "123" },
      null,
    );
    const r = filaFiscal.consultarStatusEmissao("c-rec");
    assert.strictEqual(r.status, "CONCLUIDO_RECUPERADO");
  });

  await test("métricas persistem em SQLite", () => {
    fiscalMetrics.init();
    fiscalMetrics.registrarEmissao(1500, { ok: true, acbrMs: 800, sefazMs: 700 });
    const snap = fiscalMetrics.snapshot({});
    assert.ok(snap.latenciaMs.p50 !== null || snap.contadores.autorizadas >= 1);
  });

  await test("prioridade EMISSAO antes GERAR_PDF", () => {
    filaFiscal.enfileirar("GERAR_PDF", { chave: "ch1" }, "cpdf", "V-300");
    filaFiscal.enfileirar(
      "EMISSAO",
      { numeroVenda: "V-300", correlationId: "c300" },
      "c300",
      "V-300",
    );
    const Database = require("better-sqlite3");
    const db = new Database(process.env.FISCAL_DB_PATH);
    const job = db
      .prepare(
        `SELECT tipo FROM fila_fiscal WHERE status = 'PENDENTE' ORDER BY prioridade ASC, id ASC LIMIT 1`,
      )
      .get();
    assert.strictEqual(job.tipo, "EMISSAO");
    db.close();
  });

  await test("verificarAntesDeEmitir usa documento local", async () => {
    filaFiscal.salvarDocumento({
      chave: "35260612345678901234567890123456789012345678",
      numeroVenda: "V-DOC",
      cStat: "100",
      protocolo: "p1",
      xmlPath: null,
    });
    const r = await fiscalRecuperacao.verificarAntesDeEmitir({ numeroVenda: "V-DOC" });
    assert.ok(r.recuperado);
    assert.ok(r.chave);
  });

  await test("purge fila concluida", () => {
    const Database = require("better-sqlite3");
    const db = new Database(process.env.FISCAL_DB_PATH);
    db.prepare(
      `INSERT INTO fila_fiscal (tipo, payload, status, criado_em, prioridade)
       VALUES ('EMISSAO', '{}', 'CONCLUIDO', datetime('now', '-90 days'), 1)`,
    ).run();
    db.close();
    const r = filaFiscal.purgeAntigos(30, 180);
    assert.ok(r.filaRemovidos >= 1);
  });

  console.log("\nConcluído.");
}

run();

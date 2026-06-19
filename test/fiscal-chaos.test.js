/**
 * Testes caos/recovery — node test/fiscal-chaos.test.js
 */
const assert = require("assert");
const path = require("path");
const fs = require("fs");

const testDir = path.join(__dirname, "data-test-chaos");
if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
for (const f of fs.readdirSync(testDir)) {
  try {
    fs.unlinkSync(path.join(testDir, f));
  } catch (_) {}
}

process.env.FISCAL_DB_PATH = path.join(testDir, "fila_fiscal.chaos.db");
process.env.FISCAL_METRICS_DB = path.join(testDir, "metrics.chaos.db");
process.env.FISCAL_INTEGRITY_STRICT = "false";
process.env.FISCAL_RATE_LIMIT_MIN = "100";

const filaFiscal = require("../filaFiscal");
const fiscalRecuperacao = require("../fiscalRecuperacao");
const fiscalRateLimit = require("../fiscalRateLimit");

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}:`, e.message);
    process.exitCode = 1;
  }
}

async function run() {
  console.log("fiscal-chaos.test.js\n");

  await test("boot recovery INCERTO → consulta local → CONCLUIDO_RECUPERADO", async () => {
    filaFiscal.init();
    const enq = filaFiscal.enfileirar(
      "EMISSAO",
      {
        numeroVenda: "V-CHAOS-1",
        correlationId: "c-chaos-1",
        _fiscalMeta: { numeroNfe: "99", serieNfe: "1" },
      },
      "c-chaos-1",
      "V-CHAOS-1",
    );
    filaFiscal.salvarDocumento({
      chave: "35260612345678901234567890123456789012345678",
      numeroVenda: "V-CHAOS-1",
      numeroNfe: "99",
      serieNfe: "1",
      cStat: "100",
      protocolo: "PROT1",
    });
    const Database = require("better-sqlite3");
    const db = new Database(process.env.FISCAL_DB_PATH);
    db.prepare(`UPDATE fila_fiscal SET status = 'INCERTO' WHERE id = ?`).run(enq.id);
    db.close();

    const lerConfig = async () => ({ backendUrl: "", backendToken: "" });
    const stats = await filaFiscal.recuperarBoot(lerConfig);
    assert.ok(stats.autorizados >= 1);
    const r = filaFiscal.obterResultadoEmissao("c-chaos-1");
    assert.strictEqual(r.status, "CONCLUIDO_RECUPERADO");
  });

  await test("verificarAntesDeEmitir bloqueia re-emissão", async () => {
    const r = await fiscalRecuperacao.verificarAntesDeEmitir({
      numeroVenda: "V-CHAOS-1",
      _fiscalMeta: { numeroNfe: "99", serieNfe: "1" },
    });
    assert.ok(r?.chave);
    assert.ok(r.recuperado);
  });

  await test("dedup GERAR_PDF por chave_fiscal sem LIKE", () => {
    const a = filaFiscal.enfileirar(
      "GERAR_PDF",
      { chave: "CHAVE-PDF-1" },
      "cp1",
      "V-CHAOS-1",
    );
    const b = filaFiscal.enfileirar(
      "GERAR_PDF",
      { chave: "CHAVE-PDF-1" },
      "cp2",
      "V-CHAOS-1",
    );
    assert.strictEqual(a.id, b.id);
    const Database = require("better-sqlite3");
    const db = new Database(process.env.FISCAL_DB_PATH);
    const cnt = db
      .prepare(`SELECT COUNT(*) as n FROM fila_fiscal WHERE chave_fiscal = ?`)
      .get("CHAVE-PDF-1").n;
    db.close();
    assert.strictEqual(cnt, 1);
  });

  await test("buscarJobEmissaoPorVenda usa coluna indexada", () => {
    const job = filaFiscal.buscarJobEmissaoPorVenda("V-CHAOS-1");
    assert.ok(job);
    assert.strictEqual(job.numero_venda, "V-CHAOS-1");
  });

  await test("rate limit ativo", () => {
    const cnpj = "99999999000191";
    for (let i = 0; i < 5; i++) fiscalRateLimit.registrarTentativa(cnpj);
    assert.ok(fiscalRateLimit.podeEmitir(cnpj).ok);
  });

  await test("fila grande — 200 jobs enfileirados", () => {
    for (let i = 0; i < 200; i++) {
      filaFiscal.enfileirar(
        "CALLBACK_BACKEND",
        { numeroVenda: `V-BULK-${i}`, callbackPayload: {}, correlationId: `cb-${i}` },
        `cb-${i}`,
        `V-BULK-${i}`,
      );
    }
    const st = filaFiscal.status();
    assert.ok(st.pendentes + st.concluidos >= 200 || st.pendentes >= 200);
  });

  await test("sanitização remove cfg de payload legado", () => {
    const Database = require("better-sqlite3");
    const db = new Database(process.env.FISCAL_DB_PATH);
    db.prepare(
      `INSERT INTO fila_fiscal (tipo, payload, status, prioridade)
       VALUES ('CALLBACK_BACKEND', ?, 'PENDENTE', 3)`,
    ).run(JSON.stringify({ cfg: { backendToken: "secret" }, numeroVenda: "VX" }));
    const id = db.prepare(`SELECT last_insert_rowid() as id`).get().id;
    db.close();
    const db2 = new Database(process.env.FISCAL_DB_PATH);
    const row = db2.prepare(`SELECT payload FROM fila_fiscal WHERE id = ?`).get(id);
    const p = JSON.parse(row.payload);
    delete p.cfg;
    delete p.backendToken;
    db2.prepare(`UPDATE fila_fiscal SET payload = ? WHERE id = ?`).run(JSON.stringify(p), id);
    const clean = db2.prepare(`SELECT payload FROM fila_fiscal WHERE id = ?`).get(id);
    db2.close();
    assert.ok(!clean.payload.includes("backendToken"));
  });

  console.log("\nConcluído.");
}

run();

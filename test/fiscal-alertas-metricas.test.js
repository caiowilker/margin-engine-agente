// Testes — métricas cStat e alertas operacionais
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "me-alertas-"));

process.env.FISCAL_METRICS_DB = path.join(tmpDir, "fiscal_metrics.db");
process.env.FILA_PENDENTE_ALERTA_THRESHOLD = "3";
process.env.FILA_PENDENTE_IDADE_MIN = "5";
process.env.CSTAT_999_RATE_WINDOW_MIN = "60";
process.env.CSTAT_999_RATE_MAX = "2";
process.env.NODE_ENV = "test";

const fiscalMetrics = require("../fiscalMetrics");
const fiscalAlertas = require("../fiscalAlertas");

test("emissoesPorCStat — conta sucesso e falha", () => {
  fiscalMetrics.init();
  fiscalMetrics.registrarEmissao(100, { ok: true, cStat: "100" });
  fiscalMetrics.registrarEmissao(200, { falha: true, cStat: "999" });
  const snap = fiscalMetrics.snapshot();
  assert.ok(snap.contadores.emissoesPorCStat["100"] >= 1);
  assert.ok(snap.contadores.emissoesPorCStat["999"] >= 1);
  assert.ok(snap.contadores.rejeicoesPorCStat["999"] >= 1);
});

test("contarCStatNaJanela — amostras recentes", () => {
  fiscalMetrics.init();
  fiscalMetrics.registrarEmissao(50, { falha: true, cStat: "999" });
  fiscalMetrics.registrarEmissao(50, { falha: true, cStat: "999" });
  const n = fiscalMetrics.contarCStatNaJanela("999", 60);
  assert.ok(n >= 2);
});

test("verificarFilaPendenteSustentada — dispara estado alertado", () => {
  fiscalAlertas.verificarFilaPendenteSustentada("fila_fiscal", {
    pendentes: 10,
    total: 10,
    oldestAgeMinutes: 20,
  });
  const st = fiscalAlertas.obterEstadoAlertas();
  assert.strictEqual(st.filasSustentadas.fila_fiscal.alertado, true);
});

test("verificarTaxaCStat999 — ativa quando limite excedido", () => {
  fiscalMetrics.registrarEmissao(10, { falha: true, cStat: "999" });
  fiscalAlertas.verificarTaxaCStat999();
  const st = fiscalAlertas.obterEstadoAlertas();
  assert.strictEqual(st.cStat999.alertado, true);
  assert.ok(st.cStat999.contagem >= 2);
});

test("obterConfigAlertas — defaults expostos", () => {
  const cfg = fiscalAlertas.obterConfigAlertas();
  assert.strictEqual(cfg.filaPendenteThreshold, 3);
  assert.strictEqual(cfg.filaPendenteIdadeMin, 5);
  assert.strictEqual(cfg.cStat999RateMax, 2);
});

test.after(() => {
  fiscalMetrics.close();
  fiscalAlertas.pararMonitorPeriodico();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {}
});

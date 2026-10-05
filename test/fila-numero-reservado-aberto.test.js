/**
 * Piso de numeração: nNF reservado por job aberto nunca pode voltar ao contador.
 */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

const DB_PATH = path.join(__dirname, `data-num-reservado-${Date.now()}.db`);
const METRICS_DB = path.join(__dirname, `data-num-reservado-metrics-${Date.now()}.db`);
process.env.FISCAL_DB_PATH = DB_PATH;
process.env.FISCAL_METRICS_DB = METRICS_DB;
process.env.SEFAZ_RL_UF_HABILITADO = "false";

const filaFiscal = require("../filaFiscal");

after(() => {
  filaFiscal.fecharDb?.();
  for (const f of [DB_PATH, METRICS_DB]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignora */
    }
  }
});

function jobComNumero(venda, numero, { serie = "1", modelo = "65" } = {}) {
  const { id } = filaFiscal.enfileirar("EMISSAO", { numeroVenda: venda }, `corr-${venda}`, venda);
  filaFiscal.atualizarPayload(id, {
    _fiscalMeta: { numeroNfe: String(numero), serieNfe: serie, modeloDocumento: modelo },
    numeroNfe: String(numero),
    serieNfe: serie,
    modeloDocumento: modelo,
  });
  return id;
}

test("maiorNumeroReservadoAberto considera só jobs abertos da mesma série e modelo", () => {
  const incerto = jobComNumero("V-1", 41);
  filaFiscal.marcarJob(incerto, "INCERTO", "cStat 104");
  const concluido = jobComNumero("V-2", 90);
  filaFiscal.marcarJob(concluido, "CONCLUIDO");
  jobComNumero("V-3", 700, { modelo: "55" });
  jobComNumero("V-4", 800, { serie: "2" });
  jobComNumero("V-5", 37);

  assert.equal(filaFiscal.maiorNumeroReservadoAberto("1", "65"), 41);
  assert.equal(filaFiscal.maiorNumeroReservadoAberto("001", "65"), 41);
  assert.equal(filaFiscal.maiorNumeroReservadoAberto("1", "55"), 700);
  assert.equal(filaFiscal.maiorNumeroReservadoAberto("2", "65"), 800);
  assert.equal(filaFiscal.maiorNumeroReservadoAberto("3", "65"), 0);
});

function lerJob(id) {
  return filaFiscal.buscarJobEmissaoPorVenda(id);
}

test("reabrirJobEmissao mantém nNF reservado e troca o INI", () => {
  const id = jobComNumero("V-R1", 55);
  filaFiscal.atualizarPayload(id, { documentIni: "INI-ANTIGO" });
  filaFiscal.marcarJob(id, "FALHA_PERMANENTE", "NFC-e rejeitada (cStat 778)");

  assert.equal(
    filaFiscal.reabrirJobEmissao(id, {
      numeroVenda: "V-R1",
      correlationId: "corr-novo",
      documentIni: "INI-NOVO",
      _fiscalMeta: { numeroNfe: "999" },
    }),
    true,
  );
  const job = lerJob("V-R1");
  const p = JSON.parse(job.payload);
  assert.equal(job.status, "PENDENTE");
  assert.equal(job.tentativas, 0);
  assert.equal(job.correlation_id, "corr-novo");
  assert.equal(p.documentIni, "INI-NOVO");
  assert.equal(p._fiscalMeta.numeroNfe, "55", "número reservado não muda");
  assert.equal(filaFiscal.contarEmissoesAtivas() >= 1, true);
});

test("reabrir só age sobre FALHA_PERMANENTE", () => {
  const id = jobComNumero("V-R2", 56);
  assert.equal(filaFiscal.reabrirJobEmissao(id, { documentIni: "X" }), false);
  assert.equal(filaFiscal.reabrirParaConsulta(id), false);
});

test("reabrirParaConsulta volta para INCERTO sem tocar no payload", () => {
  const id = jobComNumero("V-R3", 57);
  filaFiscal.marcarJob(id, "FALHA_PERMANENTE", "ACBr_OFFLINE_TIMEOUT");
  assert.equal(filaFiscal.reabrirParaConsulta(id), true);
  const job = lerJob("V-R3");
  assert.equal(job.status, "INCERTO");
  assert.equal(job.tentativas_consulta, 0);
  assert.equal(JSON.parse(job.payload)._fiscalMeta.numeroNfe, "57");
});

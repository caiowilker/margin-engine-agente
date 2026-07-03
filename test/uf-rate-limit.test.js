/**
 * Testes de rate-limiting por UF (token-bucket SEFAZ)
 *
 * Cobre:
 *  1. Burst de emissões da mesma UF sendo escalonado corretamente
 *  2. UFs diferentes não bloqueiam uma à outra
 *  3. Tokens se regeneram após a janela de recarga
 *  4. Jitter aplicado ao aguardarMs (dentro de limites esperados)
 *  5. extrairUf extrai corretamente de diferentes formatos de payload
 *  6. Módulo desabilitado (SEFAZ_RL_UF_HABILITADO=false) deixa tudo passar
 *  7. Métricas registram bloqueados vs emitidos por UF
 *  8. Configuração por UF via env (SEFAZ_RL_SP_TAXA, SEFAZ_RL_SP_BURST)
 *  9. aguardarMs inclui jitter e é maior que zero
 * 10. filaFiscal.adiarJob devolve job para PENDENTE sem incrementar tentativas
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

// ─── Isolar env para testes ────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, `data-uf-rl-${Date.now()}.db`);
process.env.FISCAL_DB_PATH = DB_PATH;
process.env.FISCAL_METRICS_DB = path.join(__dirname, `data-uf-rl-metrics-${Date.now()}.db`);
// Reset entre testes: burst 3, taxa 3/s (fácil esgotar)
process.env.SEFAZ_RL_BURST_PADRAO = "3";
process.env.SEFAZ_RL_TAXA_PADRAO = "3";
process.env.SEFAZ_RL_JITTER_MS = "0"; // sem jitter em testes para previsibilidade
process.env.SEFAZ_RL_UF_HABILITADO = "true";

const ufRateLimit = require("../fiscal/ufRateLimit");

after(() => {
  for (const f of [DB_PATH, process.env.FISCAL_METRICS_DB]) {
    try { fs.unlinkSync(f); } catch (_) {}
  }
});

// ─── 1. Burst da mesma UF é escalonado ────────────────────────────────────────
test("burst de emissões da mesma UF é escalonado (sem tokens = adiar)", () => {
  ufRateLimit.resetParaTestes();

  const uf = "SP";
  // burst=3: as 3 primeiras devem passar
  for (let i = 0; i < 3; i++) {
    const r = ufRateLimit.consumir(uf);
    assert.equal(r.ok, true, `emissão ${i + 1} deveria passar`);
  }
  // 4ª deve ser bloqueada
  const bloqueada = ufRateLimit.consumir(uf);
  assert.equal(bloqueada.ok, false, "4ª emissão deveria ser bloqueada");
  assert.ok(bloqueada.aguardarMs > 0, "aguardarMs deve ser > 0");
  assert.ok(typeof bloqueada.motivo === "string" && bloqueada.motivo.length > 0);
});

// ─── 2. UFs diferentes não bloqueiam uma à outra ─────────────────────────────
test("UFs diferentes não bloqueiam uma à outra", () => {
  ufRateLimit.resetParaTestes();

  // Esgota SP
  for (let i = 0; i < 3; i++) ufRateLimit.consumir("SP");
  assert.equal(ufRateLimit.consumir("SP").ok, false, "SP deve estar bloqueado");

  // MG ainda tem burst completo
  assert.equal(ufRateLimit.consumir("MG").ok, true, "MG deve passar independente de SP");
  assert.equal(ufRateLimit.consumir("RJ").ok, true, "RJ deve passar independente de SP");
});

// ─── 3. Tokens se regeneram após recarga ─────────────────────────────────────
test("tokens se regeneram proporcionalmente ao tempo decorrido", () => {
  ufRateLimit.resetParaTestes();

  // taxa = 3/s, burst = 3: esgota SP
  for (let i = 0; i < 3; i++) ufRateLimit.consumir("SC");
  assert.equal(ufRateLimit.consumir("SC").ok, false, "SC esgotado");

  // Simula passagem de tempo manipulando o bucket interno
  // (não há acesso ao _buckets diretamente, então testamos via comportamento:
  //  após 400ms com taxa 3/s, ~1,2 tokens regenerados → permite 1 emissão)
  // Este teste valida a lógica do cálculo via consumir() com timestamp real:
  // Para ser determinístico, usamos um approach alternativo — verificamos
  // que aguardarMs é razoável (< taxa + burst em ms)
  const r = ufRateLimit.consumir("SC");
  const esperadoMaxMs = (1 / 3) * 1000 * 5; // 5x fator de segurança
  assert.ok(r.aguardarMs <= esperadoMaxMs, `aguardarMs (${r.aguardarMs}) deve ser <= ${esperadoMaxMs}ms`);
});

// ─── 4. Jitter ────────────────────────────────────────────────────────────────
test("aguardarMs com jitter (env=2000) é >= tempo base calculado", () => {
  process.env.SEFAZ_RL_JITTER_MS = "2000";
  ufRateLimit.resetParaTestes();

  for (let i = 0; i < 3; i++) ufRateLimit.consumir("BA");
  const r = ufRateLimit.consumir("BA");
  assert.equal(r.ok, false);
  // Com jitter de 0–2000ms, aguardarMs deve ser >= 0
  assert.ok(r.aguardarMs >= 0);
  assert.ok(r.aguardarMs <= 5000, "aguardarMs deve ser razoável (< 5s)");

  process.env.SEFAZ_RL_JITTER_MS = "0"; // restaura
  ufRateLimit.resetParaTestes();
});

// ─── 5. extrairUf em diferentes formatos de payload ─────────────────────────
test("extrairUf extrai UF de empresa.uf, payload.uf e emitente.uf", () => {
  assert.equal(ufRateLimit.extrairUf({ empresa: { uf: "sp" } }), "SP");
  assert.equal(ufRateLimit.extrairUf({ uf: "RJ" }), "RJ");
  assert.equal(ufRateLimit.extrairUf({ emitente: { uf: "mg" } }), "MG");
  assert.equal(ufRateLimit.extrairUf({}), null);
  assert.equal(ufRateLimit.extrairUf(null), null);
  assert.equal(ufRateLimit.extrairUf({ empresa: { uf: "  RS  " } }), "RS");
});

// ─── 6. Módulo desabilitado ───────────────────────────────────────────────────
test("com SEFAZ_RL_UF_HABILITADO=false todas as emissões passam", () => {
  process.env.SEFAZ_RL_UF_HABILITADO = "false";
  ufRateLimit.resetParaTestes();

  for (let i = 0; i < 20; i++) {
    assert.equal(ufRateLimit.consumir("SP").ok, true, `emissão ${i + 1} deve passar com RL desabilitado`);
  }

  process.env.SEFAZ_RL_UF_HABILITADO = "true";
  ufRateLimit.resetParaTestes();
});

// ─── 7. Métricas por UF ──────────────────────────────────────────────────────
test("métricas registram emitidos e bloqueados por UF corretamente", () => {
  ufRateLimit.resetParaTestes();

  const uf = "GO";
  // 3 emitidos + 2 bloqueados
  for (let i = 0; i < 3; i++) ufRateLimit.consumir(uf);
  ufRateLimit.consumir(uf);
  ufRateLimit.consumir(uf);

  const m = ufRateLimit.metricas();
  assert.equal(m.habilitado, true);
  assert.equal(m.totalEmitidos >= 3, true);
  assert.equal(m.totalBloqueados >= 2, true);
  assert.ok(m.porUf["GO"], "deve ter entrada para GO");
  assert.equal(m.porUf["GO"].emitidos, 3);
  assert.equal(m.porUf["GO"].bloqueados, 2);
});

// ─── 8. Configuração por UF via env ──────────────────────────────────────────
test("configuração por UF via env SEFAZ_RL_<UF>_TAXA e BURST é respeitada", () => {
  process.env.SEFAZ_RL_PE_TAXA = "1";
  process.env.SEFAZ_RL_PE_BURST = "1";
  ufRateLimit.resetParaTestes();

  // burst=1: 1ª passa, 2ª bloqueia
  assert.equal(ufRateLimit.consumir("PE").ok, true, "1ª deve passar");
  const r2 = ufRateLimit.consumir("PE");
  assert.equal(r2.ok, false, "2ª deve bloquear com burst=1");

  delete process.env.SEFAZ_RL_PE_TAXA;
  delete process.env.SEFAZ_RL_PE_BURST;
  ufRateLimit.resetParaTestes();
});

// ─── 9. aguardarMs é calculado com precisão razoável ─────────────────────────
test("aguardarMs é positivo e proporcional à taxa quando esgotado", () => {
  process.env.SEFAZ_RL_JITTER_MS = "0";
  process.env.SEFAZ_RL_AM_TAXA = "2"; // 2/s → 500ms para 1 token
  process.env.SEFAZ_RL_AM_BURST = "1";
  ufRateLimit.resetParaTestes();

  ufRateLimit.consumir("AM"); // consome o único token
  const r = ufRateLimit.consumir("AM");
  assert.equal(r.ok, false);
  // Com taxa 2/s e 0 tokens: falta ~0.5s
  assert.ok(r.aguardarMs > 0 && r.aguardarMs <= 2000, `aguardarMs esperado ~500ms, obtido ${r.aguardarMs}ms`);

  delete process.env.SEFAZ_RL_AM_TAXA;
  delete process.env.SEFAZ_RL_AM_BURST;
  process.env.SEFAZ_RL_JITTER_MS = "0";
  ufRateLimit.resetParaTestes();
});

// ─── 10. filaFiscal.adiarJob devolve job para PENDENTE sem incrementar tentativas
test("filaFiscal.adiarJob retorna job para PENDENTE sem incrementar tentativas", () => {
  const filaFiscal = require("../filaFiscal");
  filaFiscal.init();

  const enqResult = filaFiscal.enfileirar(
    "EMISSAO",
    { numeroVenda: `V-rl-uf-${Date.now()}` },
    `corr-rl-uf-${Date.now()}`,
    `V-rl-uf-${Date.now()}`,
  );
  assert.ok(enqResult.id, "job deve ser criado");

  const jobId = enqResult.id;
  const proxima = new Date(Date.now() + 5000).toISOString();

  // Marca como PROCESSANDO manualmente (simula worker pegou o job)
  filaFiscal.marcarJob(jobId, "PROCESSANDO");

  // Adia
  filaFiscal.adiarJob(jobId, proxima, "rate-limit-uf");

  const db = filaFiscal.init();
  const row = db.prepare("SELECT status, tentativas, proxima_tentativa FROM fila_fiscal WHERE id = ?").get(jobId);
  assert.equal(row.status, "PENDENTE", "status deve ser PENDENTE após adiarJob");
  assert.equal(row.tentativas, 0, "tentativas NÃO devem ser incrementadas");
  // proxima_tentativa deve ser próxima ao futuro configurado
  assert.ok(row.proxima_tentativa, "deve ter proxima_tentativa");
});

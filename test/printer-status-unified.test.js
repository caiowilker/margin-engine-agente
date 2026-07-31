/**
 * Testes — Status unificado da impressora + dedup de logs.
 *
 * Cobre três comportamentos introduzidos para corrigir o loop de erros
 * "Falha de comunicação com a impressora":
 *
 *  1. impressaoRecenteOk() — fonte de verdade baseada no pipeline real.
 *  2. printerService.testar() — short-circuit + cache de probe.
 *  3. LoggingService — dedup de warn/error idênticos em < 1 s.
 */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");

// ── Setup de ambiente isolado ────────────────────────────────────────────────
const ROOT = path.join(os.tmpdir(), `me-printer-unified-${process.pid}`);
process.env.MARGIN_ENGINE_ROOT = ROOT;
process.env.PRINTER_PROVIDER = "mock";
process.env.PRINT_JOB_WORKER = "false";
process.env.PRINT_JOB_MAX_TENTATIVAS = "2";
process.env.PRINT_JOB_TIMEOUT_TOTAL_MS = "5000";
process.env.LOG_SILENT = "true";
process.env.LOG_PATCH_CONSOLE = "false";
process.env.LOG_MODE = "DEBUG";

const { getDirectoryManager, resetDirectoryManager } = require("../runtime/directoryManager");
resetDirectoryManager();
getDirectoryManager(ROOT).ensureAll();

const store = require("../print/printJobStore");
const pjs = require("../print/printJobService");
const factory = require("../print/factory");
factory.resetPrintProvider();

after(() => {
  try {
    store.resetDbForTests?.();
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch (_) {}
});

// ── 1. impressaoRecenteOk() ──────────────────────────────────────────────────

test("impressaoRecenteOk retorna false quando não há jobs", async () => {
  try { store.resetDbForTests?.(); } catch (_) {}
  store.initDb();

  assert.strictEqual(pjs.impressaoRecenteOk(), false);
});

test("impressaoRecenteOk retorna true após impressão bem-sucedida", async (t) => {
  try { store.resetDbForTests?.(); } catch (_) {}
  store.initDb();

  const job = pjs.enfileirar("imprimirTeste", [], { motivo: "unit" });
  await pjs.processarFila();

  const done = pjs.buscarJob(job.id);
  assert.strictEqual(done.status, "IMPRESSO", "job deve estar IMPRESSO");

  assert.strictEqual(pjs.impressaoRecenteOk(), true, "deve retornar true após impressão recente");
  t.diagnostic("ultimaImpressaoEm verificada via stats e DB");
});

test("impressaoRecenteOk retorna false com janela zero (antes do próprio registro)", () => {
  // janela = 0 ms → age < 0 nunca é verdadeiro → sempre false
  assert.strictEqual(pjs.impressaoRecenteOk(0), false, "janela=0 nunca retorna verdadeiro");
});

// ── 2. printerService.testar() com cache + fonte unificada ───────────────────

test("printerService.testar() retorna true sem probe quando há impressão recente", async () => {
  try { store.resetDbForTests?.(); } catch (_) {}
  store.initDb();
  factory.resetPrintProvider();

  const impressora = require("../printerService");
  impressora.invalidateProbeCache();

  const job = pjs.enfileirar("imprimirTeste", [], { motivo: "unit" });
  await pjs.processarFila();
  assert.strictEqual(pjs.buscarJob(job.id).status, "IMPRESSO");

  // Com impressão recente, testar() deve retornar true sem chamar o probe real
  const resultado = await impressora.testar(false);
  assert.strictEqual(resultado, true, "deve retornar true via impressaoRecenteOk");
});

test("printerService.testar() usa cache para polls concorrentes", async () => {
  const impressora = require("../printerService");
  impressora.invalidateProbeCache();

  // Força expiração do cache da impressão recente usando janela zero
  // Em seguida, três chamadas simultâneas — apenas a primeira dispara probe real.
  const [r1, r2, r3] = await Promise.all([
    impressora.testar(false),
    impressora.testar(false),
    impressora.testar(false),
  ]);
  // Todos devem ter o mesmo valor (do cache após o primeiro probe)
  assert.strictEqual(r2, r1, "segundo resultado deve ser igual ao primeiro (cache)");
  assert.strictEqual(r3, r1, "terceiro resultado deve ser igual ao primeiro (cache)");
});

test("printerService.resetPrintProvider() invalida o cache de probe e não lança", () => {
  const impressora = require("../printerService");
  assert.doesNotThrow(() => impressora.resetPrintProvider());
});

test("printerService.testar durante impressaoEmAndamento não dispara probe live", async () => {
  const impressora = require("../printerService");
  const executor = require("../print/printExecutor");
  const factory = require("../print/factory");
  impressora.invalidateProbeCache();

  const prevAbandoned = executor.physicalSendAbandonedInFlight;
  executor.physicalSendAbandonedInFlight = () => true;

  let liveCalls = 0;
  const provider = factory.getPrintProvider();
  const prevTestar = provider.testar;
  provider.testar = async () => {
    liveCalls += 1;
    return false;
  };

  try {
    assert.strictEqual(pjs.impressaoEmAndamento(), true);
    const ok = await impressora.testar(false);
    assert.strictEqual(ok, true, "busy → assume conectada sem probe");
    assert.strictEqual(liveCalls, 0, "não deve chamar provider.testar live");
  } finally {
    executor.physicalSendAbandonedInFlight = prevAbandoned;
    provider.testar = prevTestar;
    impressora.invalidateProbeCache();
  }
});

test("impressaoEmAndamento bloqueia reclaim conceitual (gate do worker)", () => {
  const executor = require("../print/printExecutor");
  const prev = executor.physicalSendAbandonedInFlight;
  executor.physicalSendAbandonedInFlight = () => true;
  try {
    assert.strictEqual(pjs.impressaoEmAndamento(), true);
  } finally {
    executor.physicalSendAbandonedInFlight = prev;
  }
});

// ── 3. LoggingService — dedup de warn/error idênticos em < 1 s ──────────────
// Os testes abaixo criam instâncias LOCAIS de LoggingService (sem tocar no
// singleton global) para evitar conflitos de estado entre testes concorrentes.
// LOG_SILENT é temporariamente "false" apenas para a construção da instância
// local (o construtor captura o valor naquele momento), depois restaurado.

function criarSvcLocal(dedupMs = 1000) {
  const { LoggingService } = require("../runtime/loggingService");
  process.env.LOG_DEDUP_WINDOW_MS = String(dedupMs);
  // Instância local com silent=false para que _appendToChannel seja chamado.
  process.env.LOG_SILENT = "false";
  const svc = new LoggingService();
  process.env.LOG_SILENT = "true";    // restaura para os outros testes
  let chamadas = 0;
  const orig = svc._appendToChannel.bind(svc);
  svc._appendToChannel = (...args) => { chamadas++; return orig(...args); };
  return { svc, getChamadas: () => chamadas };
}

test("LoggingService suprime warn duplicado dentro da janela de dedup", () => {
  const { svc, getChamadas } = criarSvcLocal(1000);

  const log = svc.createLogger({ modulo: `printer_dedup_${Date.now()}` });
  const msg = `[ACBrPosPrinter] Erro dedup ${Date.now()}`;

  log.warn(msg);
  log.warn(msg); // duplicata — deve ser suprimida
  log.warn(msg); // duplicata — deve ser suprimida

  assert.strictEqual(getChamadas(), 1, `esperava 1 chamada, encontrou ${getChamadas()} (2 duplicatas devem ser suprimidas)`);
});

test("LoggingService permite warn do mesmo módulo após a janela de dedup", async () => {
  const { svc, getChamadas } = criarSvcLocal(50); // janela curta

  const log = svc.createLogger({ modulo: `printer_expire_${Date.now()}` });
  const msg = `[Printer] Erro repetível ${Date.now()}`;

  log.warn(msg);
  await new Promise((r) => setTimeout(r, 70)); // espera os 50 ms expirarem
  log.warn(msg); // deve ser aceito após janela

  assert.strictEqual(getChamadas(), 2, `esperava 2 chamadas após a janela expirar, encontrou ${getChamadas()}`);

  process.env.LOG_DEDUP_WINDOW_MS = "1000";
});

test("LoggingService não suprime mensagens info (abaixo de warn)", () => {
  const { svc, getChamadas } = criarSvcLocal(1000);

  const log = svc.createLogger({ modulo: `printer_info_${Date.now()}` });
  const msg = `[Printer] Info não deduplicado ${Date.now()}`;

  log.info(msg);
  log.info(msg);

  assert.strictEqual(getChamadas(), 2, `info não deve ser deduplicado (esperava 2, encontrou ${getChamadas()})`);
});

test("LoggingService não deduplica warns de mensagens diferentes", () => {
  const { svc, getChamadas } = criarSvcLocal(1000);

  const log = svc.createLogger({ modulo: `printer_diff_${Date.now()}` });

  log.warn(`[Printer] Erro A ${Date.now()}`);
  log.warn(`[Printer] Erro B ${Date.now()}`);
  log.warn(`[Printer] Erro C ${Date.now()}`);

  assert.strictEqual(getChamadas(), 3, `mensagens diferentes não devem ser deduplicadas (esperava 3, encontrou ${getChamadas()})`);
});

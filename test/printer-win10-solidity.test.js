/**
 * Solidez Win10 — status impressora + persistência ProgramData.
 * Win11 costuma listar Get-Printer rápido; Win10 oscila/timeout → UI “some”.
 */
const { test, after, before } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");

const ROOT = path.join(os.tmpdir(), `me-win10-print-${process.pid}`);
const AGENT_ROOT = path.resolve(__dirname, "..");

before(() => {
  process.env.MARGIN_ENGINE_ROOT = ROOT;
  process.env.LOG_SILENT = "true";
  delete process.env.ACBR_POSPRINTER_INI;
  const { getDirectoryManager, resetDirectoryManager } = require("../runtime/directoryManager");
  resetDirectoryManager();
  getDirectoryManager(ROOT).ensureAll();
});

after(() => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch (_) {}
  delete process.env.MARGIN_ENGINE_ROOT;
  delete process.env.ACBR_POSPRINTER_INI;
  try {
    require("../runtime/directoryManager").resetDirectoryManager();
  } catch (_) {}
});

test("resolveIniPath migra legacy install-dir → ProgramData", () => {
  const runtime = require("../print/acbrPosPrinterRuntime");
  const { getDirectoryManager } = require("../runtime/directoryManager");
  const dm = getDirectoryManager(ROOT);
  const programDataIni = path.join(dm.PATHS.config, "posprinter.ini");
  const legacyIni = path.join(AGENT_ROOT, "data", "posprinter.ini");
  const legacyBak = legacyIni + `.bak-test-${process.pid}`;
  let hadLegacy = false;

  fs.mkdirSync(path.dirname(legacyIni), { recursive: true });
  if (fs.existsSync(legacyIni)) {
    hadLegacy = true;
    fs.copyFileSync(legacyIni, legacyBak);
  }
  fs.writeFileSync(
    legacyIni,
    "[PosPrinter]\nPorta=RAW:Win10TestPrinter\nModelo=0\n",
    "utf8",
  );
  try {
    if (fs.existsSync(programDataIni)) fs.unlinkSync(programDataIni);
  } catch (_) {}

  process.env.ACBR_POSPRINTER_INI = legacyIni;

  try {
    const resolved = runtime.resolveIniPath();
    assert.strictEqual(
      path.normalize(resolved).toLowerCase(),
      path.normalize(programDataIni).toLowerCase(),
    );
    assert.ok(fs.existsSync(programDataIni), "deve copiar conteúdo para ProgramData");
    assert.match(fs.readFileSync(programDataIni, "utf8"), /Win10TestPrinter/);
    assert.strictEqual(
      path.normalize(process.env.ACBR_POSPRINTER_INI).toLowerCase(),
      path.normalize(programDataIni).toLowerCase(),
    );
  } finally {
    try {
      fs.unlinkSync(legacyIni);
    } catch (_) {}
    if (hadLegacy && fs.existsSync(legacyBak)) {
      fs.copyFileSync(legacyBak, legacyIni);
      try {
        fs.unlinkSync(legacyBak);
      } catch (_) {}
    } else {
      try {
        fs.unlinkSync(legacyBak);
      } catch (_) {}
    }
  }
});

test("resolveIniPath respeita override de teste fora de ProgramData/AGENT_ROOT", () => {
  const runtime = require("../print/acbrPosPrinterRuntime");
  const tmp = path.join(os.tmpdir(), `pos-override-${process.pid}.ini`);
  fs.writeFileSync(tmp, "[PosPrinter]\nPorta=TCP:1.2.3.4:9100\n", "utf8");
  process.env.ACBR_POSPRINTER_INI = tmp;
  try {
    assert.strictEqual(
      path.normalize(runtime.resolveIniPath()),
      path.normalize(tmp),
    );
  } finally {
    delete process.env.ACBR_POSPRINTER_INI;
    try {
      fs.unlinkSync(tmp);
    } catch (_) {}
  }
});

test("resolverConectada — porta SSOT vale mesmo com probe false/timeout (Win10)", () => {
  delete process.env.ACBR_POSPRINTER_INI;
  const runtime = require("../print/acbrPosPrinterRuntime");
  const ini = runtime.resolveIniPath();
  fs.mkdirSync(path.dirname(ini), { recursive: true });
  fs.writeFileSync(
    ini,
    "[PosPrinter]\nPorta=RAW:EPSON TM-T20\nModelo=1\nColunasFonteNormal=48\n",
    "utf8",
  );

  // limpa cache de ler()
  const plc = require("../print/printerLocalConfig");
  plc.ler({ fresh: true });

  const { resolverConectada, portaPersistidaValida } = require("../print/printerBootstrap");
  assert.equal(portaPersistidaValida(), true);

  const st = resolverConectada({
    probeOk: false,
    timedOut: true,
    skipped: true,
  });
  assert.equal(st.conectada, true);
  assert.equal(st.fonte, "configurada");
  assert.equal(st.assumida, true);

  const busy = resolverConectada({ printBusy: true, probeOk: false });
  assert.equal(busy.conectada, true);
  assert.equal(busy.fonte, "busy");

  const recente = resolverConectada({ recente: true, probeOk: false });
  assert.equal(recente.conectada, true);
  assert.equal(recente.fonte, "recente");
});

test("resolverConectada — sem porta e probe false → desconectada", () => {
  delete process.env.ACBR_POSPRINTER_INI;
  const runtime = require("../print/acbrPosPrinterRuntime");
  const ini = runtime.resolveIniPath();
  fs.mkdirSync(path.dirname(ini), { recursive: true });
  fs.writeFileSync(ini, "[PosPrinter]\nPorta=\nModelo=0\n", "utf8");
  require("../print/printerLocalConfig").ler({ fresh: true });

  const { resolverConectada } = require("../print/printerBootstrap");
  const st = resolverConectada({ probeOk: false });
  assert.equal(st.conectada, false);
  assert.equal(st.fonte, "probe");
});

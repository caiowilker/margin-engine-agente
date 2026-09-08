const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  nodeWindowsServiceId,
  nodeWindowsServiceScmName,
  scmNameVariants,
  SERVICE_SCM_NAME,
  LEGACY_SCM_NAMES,
} = require("../scripts/installer-service-control");

describe("installer-service-control — nomes SCM node-windows", () => {
  it("deriva ID base sem espaços", () => {
    assert.equal(nodeWindowsServiceId("Margin Engine"), "marginengine");
    assert.equal(nodeWindowsServiceId("PDV Margin Engine"), "pdvmarginengine");
  });

  it("usa sufixo .exe no SCM (winsw id)", () => {
    assert.equal(nodeWindowsServiceScmName("Margin Engine"), "marginengine.exe");
    assert.equal(nodeWindowsServiceScmName("PDV Margin Engine"), "pdvmarginengine.exe");
    assert.equal(SERVICE_SCM_NAME, "marginengine.exe");
    assert.deepEqual(LEGACY_SCM_NAMES, ["pdvmarginengine.exe"]);
  });

  it("tenta .exe antes do nome sem sufixo", () => {
    assert.deepEqual(scmNameVariants("Margin Engine"), ["marginengine.exe", "marginengine"]);
  });

  it("exporta startService como função", () => {
    const ctl = require("../scripts/installer-service-control");
    assert.equal(typeof ctl.startService, "function");
  });

  it("sleep usa Atomics global (não worker_threads)", () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "..", "scripts", "installer-service-control.js"),
      "utf8",
    );
    assert.match(src, /Atomics\.wait/);
    assert.doesNotMatch(src, /require\(["']worker_threads["']\)/);
    assert.doesNotMatch(src, /execFileSync\(process\.execPath, \["-e", `setTimeout/);
  });

  it("sleep runtime não lança e poll SCM é ≤200ms", () => {
    const ctl = require("../scripts/installer-service-control");
    assert.equal(ctl.POLL_MS, 200);
    const t0 = Date.now();
    ctl.sleep(30);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 20, `sleep curto demais: ${elapsed}ms`);
    assert.ok(elapsed < 200, `sleep sem Atomics (spawn/spin lento): ${elapsed}ms`);
  });

  it("parseScQueryOutput reconhece EN STATE e PT-BR ESTADO", () => {
    const { parseScQueryOutput, isScMissingError } = require("../scripts/installer-service-control");
    const en = `
SERVICE_NAME: marginengine.exe
        TYPE               : 10  WIN32_OWN_PROCESS
        STATE              : 4  RUNNING
                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)
`;
    const pt = `
NOME_DO_SERVICO: marginengine.exe
        TIPO                       : 10  WIN32_OWN_PROCESS
        ESTADO                     : 4  RUNNING
                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)
`;
    const stoppedPt = `
        ESTADO                     : 1  STOPPED
`;
    const pending = `
        STATE              : 2  START_PENDING
`;
    assert.equal(parseScQueryOutput(en), "running");
    assert.equal(parseScQueryOutput(pt), "running");
    assert.equal(parseScQueryOutput(stoppedPt), "stopped");
    assert.equal(parseScQueryOutput(pending), "starting");
    assert.equal(parseScQueryOutput(""), "unknown");
    assert.equal(
      isScMissingError(1060, "[SC] EnumQueryServicesStatus:OpenService FALHA 1060:"),
      true,
    );
    assert.equal(isScMissingError(36, "FAILED 1060"), true);
    assert.equal(isScMissingError(1, "access denied"), false);
  });

  it("budgets de stop/start sao curtos (estilo grande instalador)", () => {
    const ctl = require("../scripts/installer-service-control");
    assert.ok(ctl.DEFAULT_START_WAIT_MS <= 10_000);
    assert.ok(ctl.FORCE_STOP_POLL_MS <= 10_000);
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "..", "scripts", "installer-service-control.js"),
      "utf8",
    );
    assert.match(src, /ESTADO/);
    assert.match(src, /healthDeferred/);
    assert.match(src, /queryStateViaServiceController/);
    assert.match(src, /\b1060\b/);
  });

  it("queryStateForScm reconhece RUNNING/STOPPED em saída tipica do sc", () => {
    const ctl = require("../scripts/installer-service-control");
    assert.equal(typeof ctl.queryStateForScm, "function");
    assert.equal(typeof ctl.parseScQueryOutput, "function");
    // Fora do Windows: unknown/missing; no Linux do CI só garante export.
    if (process.platform !== "win32") {
      assert.equal(ctl.queryStateForScm("marginengine.exe"), "unknown");
    }
  });

  it("expõe stop-preinstall e parada forçada", () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "..", "scripts", "installer-service-control.js"),
      "utf8",
    );
    assert.match(src, /stop-preinstall/);
    assert.match(src, /function forceStopScm/);
    assert.match(src, /process\.exit\(0\)/);
  });
});

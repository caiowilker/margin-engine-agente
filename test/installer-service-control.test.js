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

  it("sleep usa Atomics.wait (sem spawn Node a cada poll)", () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "..", "scripts", "installer-service-control.js"),
      "utf8",
    );
    assert.match(src, /Atomics\.wait/);
    assert.doesNotMatch(src, /execFileSync\(process\.execPath, \["-e", `setTimeout/);
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

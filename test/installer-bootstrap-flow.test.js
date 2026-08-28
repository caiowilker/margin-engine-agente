const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  INSTALL_BOOTSTRAP_MAX_MS,
  INSTALL_WAIT_ONLINE_MS,
  INSTALL_WAIT_RETRY_MS,
  remainingBootstrapBudgetMs,
  clampWaitMs,
} = require("../scripts/installerSpeed");

describe("installerSpeed — orçamento de espera do bootstrap", () => {
  it("remainingBootstrapBudgetMs respeita teto com mínimo de 5s", () => {
    const start = 1_000_000;
    assert.equal(remainingBootstrapBudgetMs(start, start), INSTALL_BOOTSTRAP_MAX_MS);
    assert.equal(
      remainingBootstrapBudgetMs(start, start + INSTALL_BOOTSTRAP_MAX_MS),
      5_000,
    );
    assert.equal(
      remainingBootstrapBudgetMs(start, start + INSTALL_BOOTSTRAP_MAX_MS + 60_000),
      5_000,
    );
  });

  it("clampWaitMs limita ao orçamento restante", () => {
    const start = 0;
    assert.equal(clampWaitMs(INSTALL_WAIT_ONLINE_MS, start, 10_000), INSTALL_WAIT_ONLINE_MS);
    assert.equal(
      clampWaitMs(INSTALL_WAIT_ONLINE_MS, start, INSTALL_BOOTSTRAP_MAX_MS - 30_000),
      30_000,
    );
    assert.equal(
      clampWaitMs(INSTALL_WAIT_RETRY_MS, start, INSTALL_BOOTSTRAP_MAX_MS + 1),
      5_000,
    );
  });

  it("1ª passagem + retry cabem no teto quando completos", () => {
    assert.ok(INSTALL_WAIT_ONLINE_MS + INSTALL_WAIT_RETRY_MS <= INSTALL_BOOTSTRAP_MAX_MS);
  });
});

describe("installer-bootstrap.js — contratos de solidez", () => {
  const fs = require("fs");
  const path = require("path");
  const bootstrap = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "installer-bootstrap.js"),
    "utf8",
  );

  it("limpa marcadores stale no início", () => {
    assert.match(bootstrap, /function clearBootstrapMarkers\(/);
    assert.match(bootstrap, /clearBootstrapMarkers\(\)/);
    assert.match(bootstrap, /install-bootstrap-exit\.txt/);
  });

  it("aguarda health in-process (sem subprocess wait-online)", () => {
    assert.match(bootstrap, /async function waitForOnlineAsync/);
    assert.match(bootstrap, /require\(path\.join\(appDir, "scripts", "installer-wait-online"\)\)/);
    assert.doesNotMatch(bootstrap, /installer-wait-online\.js.*execSync/);
  });

  it("auto-reparo re-registra serviço se ausente no SCM", () => {
    assert.match(bootstrap, /auto_repair_register/);
    assert.match(bootstrap, /verifyServiceRegistered\(\)\.ok/);
  });

  it("sucesso exige agentOnline via health", () => {
    assert.match(bootstrap, /!online\.ok\)[\s\S]*writeBootstrapExit\(1\)/);
  });
});

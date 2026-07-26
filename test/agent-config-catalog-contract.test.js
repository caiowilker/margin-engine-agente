/**
 * Contrato catálogo operacional — paridade env Java ↔ agente bundled.
 * Golden: margin-engine/src/test/resources/contracts/agent-config-catalog-env.json
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const catalog = require("../agentConfigCatalog");

const GOLDEN_PATH = path.join(
  __dirname,
  "../../margin-engine/src/test/resources/contracts/agent-config-catalog-env.json",
);

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    throw e;
  }
}

console.log("agent-config-catalog-contract.test.js\n");

test("golden file existe", () => {
  assert.ok(fs.existsSync(GOLDEN_PATH), `golden ausente: ${GOLDEN_PATH}`);
});

test("exportEnvContrato bate com golden Java", () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8"));
  const local = catalog.exportEnvContrato();
  assert.strictEqual(Object.keys(local).length, Object.keys(golden).length);
  for (const [chave, env] of Object.entries(golden)) {
    assert.strictEqual(
      local[chave],
      env,
      `divergência env em ${chave}: JS=${local[chave]} golden=${env}`,
    );
  }
});

test("chaves especiais alinhadas", () => {
  assert.strictEqual(catalog.chaveToEnv("nfeSerie55"), "NFE_SERIE_55");
  assert.strictEqual(catalog.chaveToEnv("cStat999RateWindowMin"), "CSTAT_999_RATE_WINDOW_MIN");
  assert.strictEqual(catalog.chaveToEnv("cStat999RateMax"), "CSTAT_999_RATE_MAX");
  assert.strictEqual(catalog.chaveToEnv("exibirImagensPdv"), "PDV_EXIBIR_IMAGENS");
  assert.strictEqual(catalog.chaveToEnv("lanStaffAccess"), "AGENT_LAN_ENABLED");
});

console.log("\nOK");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const catalog = require("../agentConfigCatalog");
const runtimeConfig = require("../runtimeConfig");

test("mesclarComDefaults aplica overrides validos", () => {
  const merged = catalog.mesclarComDefaults({ maxTentativasConsulta: 20 });
  assert.equal(merged.maxTentativasConsulta, 20);
  assert.equal(merged.diskMinMbXml, 50);
});

test("filtrarSomenteOverrides remove defaults", () => {
  const out = catalog.filtrarSomenteOverrides({
    maxTentativasConsulta: 12,
    diskMinMbXml: 50,
  });
  assert.deepEqual(out, {});
});

test("runtimeConfig mantem ultimo conhecido apos aplicar remoto", () => {
  runtimeConfig.aplicarRemoto({ diskMinMbXml: 75 });
  assert.equal(runtimeConfig.get("diskMinMbXml"), 75);
  runtimeConfig.manterUltimoConhecido();
  assert.equal(runtimeConfig.getFonte(), "ultimo_conhecido");
  assert.equal(runtimeConfig.get("diskMinMbXml"), 75);
});

test("catalogo nao inclui segredos", () => {
  const keys = Object.keys(catalog.CATALOGO);
  assert.ok(!keys.some((k) => /token|secret|password|cert|webhook/i.test(k)));
});

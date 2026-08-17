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

test("printerDrawer omitido ou default remoto não desliga gaveta do .env", () => {
  const prev = process.env.PRINTER_DRAWER;
  process.env.PRINTER_DRAWER = "true";
  try {
    catalog.carregarCatalogoRemoto({
      catalogVersion: "test-drawer",
      defs: [
        {
          chave: "printerDrawer",
          padrao: false,
          tipo: "boolean",
          env: "PRINTER_DRAWER",
        },
      ],
    });
    const omitted = catalog.mesclarComDefaults({});
    assert.equal(omitted.printerDrawer, true);
    const fullBackendPayload = catalog.mesclarComDefaults({
      printerDrawer: false,
      diskMinMbXml: 80,
    });
    assert.equal(fullBackendPayload.printerDrawer, false);
    runtimeConfig.initFromEnv();
    runtimeConfig.aplicarRemoto({ printerDrawer: false, diskMinMbXml: 80 });
    assert.equal(process.env.PRINTER_DRAWER, "true");
    assert.equal(runtimeConfig.get("printerDrawer"), true);
    assert.equal(runtimeConfig.get("diskMinMbXml"), 80);
  } finally {
    catalog.resetCatalogoBundled();
    if (prev === undefined) delete process.env.PRINTER_DRAWER;
    else process.env.PRINTER_DRAWER = prev;
    runtimeConfig.initFromEnv();
  }
});

test("catalogo nao inclui segredos", () => {
  const keys = Object.keys(catalog.CATALOGO);
  assert.ok(!keys.some((k) => /token|secret|password|webhook/i.test(k)));
  assert.ok(!keys.some((k) => /\bcert\b/i.test(k)));
});

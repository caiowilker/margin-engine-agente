// Mapeamento sólido: SEFAZ tpAmb (1/2) ≠ ACBrLib/Monitor Ambiente (0/1)
const assert = require("assert");
const path = require("path");

process.chdir(path.join(__dirname, ".."));

const acbr = require("../acbr");
const fiscalPreflight = require("../fiscalPreflight");
const fiscalLocalConfig = require("../fiscalLocalConfig");

let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL ${name}: ${e.message}`);
  }
}

console.log("ambiente-sefaz-vs-lib");

test("ACBrLib: produção=0 · homologação=1", () => {
  assert.strictEqual(fiscalLocalConfig.ambienteToAmbienteLib("producao"), "0");
  assert.strictEqual(fiscalLocalConfig.ambienteToAmbienteLib("homologacao"), "1");
  assert.strictEqual(fiscalLocalConfig.ambienteToAmbienteLib("1"), "0"); // legado SEFAZ prod
});

test("SEFAZ tpAmb no documento: produção=1 · homologação=2", () => {
  const prev = process.env.AMBIENTE_SEFAZ;
  process.env.AMBIENTE_SEFAZ = "producao";
  assert.strictEqual(acbr.resolverTpAmb(), "1");
  process.env.AMBIENTE_SEFAZ = "homologacao";
  assert.strictEqual(acbr.resolverTpAmb(), "2");
  process.env.AMBIENTE_SEFAZ = prev;
});

test("Monitor SetAmbiente: produção=0 · homologação=1", () => {
  const prev = process.env.AMBIENTE_SEFAZ;
  process.env.AMBIENTE_SEFAZ = "producao";
  assert.strictEqual(acbr.resolverTpAmbAcbr(), "0");
  process.env.AMBIENTE_SEFAZ = "1";
  assert.strictEqual(acbr.resolverTpAmbAcbr(), "0");
  process.env.AMBIENTE_SEFAZ = "homologacao";
  assert.strictEqual(acbr.resolverTpAmbAcbr(), "1");
  process.env.AMBIENTE_SEFAZ = "2";
  assert.strictEqual(acbr.resolverTpAmbAcbr(), "1");
  process.env.AMBIENTE_SEFAZ = prev;
});

test("preflight: tpAmb SEFAZ 1/2", () => {
  assert.strictEqual(
    fiscalPreflight.interpretarAmbienteResposta("1", "tpAmb"),
    "producao",
  );
  assert.strictEqual(
    fiscalPreflight.interpretarAmbienteResposta("2", "tpAmb"),
    "homologacao",
  );
});

test("preflight: Ambiente Lib/Monitor 0/1", () => {
  assert.strictEqual(
    fiscalPreflight.interpretarAmbienteResposta("0", "Ambiente"),
    "producao",
  );
  assert.strictEqual(
    fiscalPreflight.interpretarAmbienteResposta("1", "Ambiente"),
    "homologacao",
  );
});

test("preflight: Ambiente=1 (Lib homolog) não confunde com produção", () => {
  assert.doesNotThrow(() =>
    fiscalPreflight.validarAmbiente("homologacao", "Ambiente=1\n", {}),
  );
  assert.throws(
    () => fiscalPreflight.validarAmbiente("producao", "Ambiente=1\n", {}),
    /homologação/,
  );
});

test("preflight: tpAmb=1 (SEFAZ prod) não confunde com homolog", () => {
  assert.doesNotThrow(() =>
    fiscalPreflight.validarAmbiente("producao", "tpAmb=1\n", {}),
  );
  assert.throws(
    () => fiscalPreflight.validarAmbiente("homologacao", "tpAmb=1\n", {}),
    /produção/,
  );
});

process.exit(failed > 0 ? 1 : 0);

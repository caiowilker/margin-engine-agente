/**
 * Testes — autoridade local de config fiscal (SSOT).
 */
const test = require("node:test");
const assert = require("node:assert/strict");

test("fiscalConfigAuthority respeita timestamp local sobre backend", () => {
  const authority = require("../fiscalConfigAuthority");
  authority.marcarAutoridadeLocal(true);
  assert.equal(authority.temAutoridadeLocalSobreBackend(null), true);
  assert.equal(
    authority.temAutoridadeLocalSobreBackend("2020-01-01T00:00:00.000Z"),
    true,
  );
  assert.equal(
    authority.temAutoridadeLocalSobreBackend("2099-01-01T00:00:00.000Z"),
    false,
  );
});

test("acbrIniGenerator não contém paths hardcoded ProgramData", () => {
  const { gerarConteudoIni } = require("../runtime/acbrIniGenerator");
  const content = gerarConteudoIni({ uf: "SP", ambiente: "homologacao" });
  assert.match(content, /\[ACBrNFe\]/);
  assert.doesNotMatch(content, /C:\\ProgramData/i);
});

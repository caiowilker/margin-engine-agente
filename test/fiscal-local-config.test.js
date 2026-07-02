#!/usr/bin/env node
/**
 * Testes fiscalLocalConfig — npm run test:fiscal-local-config
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fiscal-cfg-"));
const INI = path.join(TMP, "acbrlib.ini");
const ENV = path.join(TMP, ".env");

fs.writeFileSync(
  INI,
  `[ACBrNFe]
Ambiente=2
ModeloDF=65

[Certificado]
Arquivo=..\\cert\\cert.pfx
Senha=1234

[DFe]
UF=MG

[NFCe]
IdCSC=000001
CSC=TOKEN123
`,
  "utf8",
);

fs.writeFileSync(
  ENV,
  `EMISSAO_FISCAL=false
ACBR_DRIVER=lib
AMBIENTE_SEFAZ=homologacao
`,
  "utf8",
);

process.env.ACBR_LIB_INI = INI;
process.env.FISCAL_LOCAL_ENV_OVERRIDE = ENV;

const fiscalLocalConfig = require("../fiscalLocalConfig");

const origEnvPath = fiscalLocalConfig.resolveAgentEnvPath;

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}:`, e.message);
  }
}

async function run() {
  await test("ler retorna ambiente homologacao", () => {
    const cfg = fiscalLocalConfig.ler();
    assert.strictEqual(cfg.ambienteSefaz, "homologacao");
    assert.strictEqual(cfg.tpAmb, "2");
    assert.strictEqual(cfg.uf, "MG");
    assert.strictEqual(cfg.certificado.senhaConfigurada, true);
    assert.strictEqual(cfg.nfce.cscConfigurado, true);
  });

  await test("salvar alterna para producao no INI e .env", async () => {
    await fiscalLocalConfig.salvar({ ambienteSefaz: "producao" });
    const raw = fs.readFileSync(INI, "utf8");
    assert.match(raw, /Ambiente=1/);
    assert.match(fs.readFileSync(ENV, "utf8"), /AMBIENTE_SEFAZ=producao/);
    const cfg = fiscalLocalConfig.ler();
    assert.strictEqual(cfg.ambienteSefaz, "producao");
    assert.strictEqual(cfg.tpAmb, "1");
  });

  await test("salvar certificado e senha no cofre fiscal", async () => {
    await fiscalLocalConfig.salvar({
      certificadoArquivo: "C:\\cert\\meu.pfx",
      certificadoSenha: "novaSenha",
    });
    const raw = fs.readFileSync(INI, "utf8");
    assert.match(raw, /Arquivo=C:\\cert\\meu.pfx/);
    assert.match(raw, /Senha=__VAULT__/);
    const cfg = fiscalLocalConfig.ler();
    assert.strictEqual(cfg.certificado.senhaConfigurada, true);
  });

  await test("ambienteToTpAmb", () => {
    assert.strictEqual(fiscalLocalConfig.ambienteToTpAmb("producao"), "1");
    assert.strictEqual(fiscalLocalConfig.ambienteToTpAmb("homologacao"), "2");
  });

  fiscalLocalConfig.resolveAgentEnvPath = origEnvPath;
  delete process.env.FISCAL_LOCAL_ENV_OVERRIDE;

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

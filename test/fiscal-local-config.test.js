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

  await test("reconciliarEmissaoComEnv prioriza .env editado após autoridade local", () => {
    const authority = require("../fiscalConfigAuthority");
    authority.resetAutoridadeLocal();
    authority.marcarAutoridadeLocal(false);

    fs.writeFileSync(
      ENV,
      `EMISSAO_FISCAL=true
ACBR_DRIVER=lib
AMBIENTE_SEFAZ=homologacao
`,
      "utf8",
    );
    const envMaisRecente = Date.now() + 5000;
    fs.utimesSync(ENV, envMaisRecente / 1000, envMaisRecente / 1000);
    const reconciliado = fiscalLocalConfig.reconciliarEmissaoComEnv();
    assert.strictEqual(reconciliado, true);
    assert.strictEqual(authority.obterStatus().ativo, true);
    assert.strictEqual(authority.obterStatus().localEmissaoFiscal, true);
    assert.strictEqual(process.env.EMISSAO_FISCAL, "true");
  });

  await test("reconciliarEmissaoComEnv alinha .env=true mesmo sem mtime mais recente", () => {
    const authority = require("../fiscalConfigAuthority");
    authority.resetAutoridadeLocal();
    authority.marcarAutoridadeLocal(false);

    fs.writeFileSync(
      ENV,
      `EMISSAO_FISCAL=true
ACBR_DRIVER=lib
AMBIENTE_SEFAZ=homologacao
`,
      "utf8",
    );
    const reconciliado = fiscalLocalConfig.reconciliarEmissaoComEnv();
    assert.strictEqual(reconciliado, true);
    assert.strictEqual(authority.obterStatus().localEmissaoFiscal, true);
    assert.strictEqual(fiscalLocalConfig.lerEmissaoFiscalRuntime(), true);
  });

  await test("sincronizarSegredosDoEnv migra senha e CSC do .env para INI/cofre", async () => {
    const fiscalSecrets = require("../fiscalSecrets");
    await fiscalSecrets.limpar();

    fs.writeFileSync(
      INI,
      `[ACBrNFe]
Ambiente=2
ModeloDF=65

[Certificado]
Arquivo=
Senha=

[DFe]
UF=MG

[NFCe]
IdCSC=
CSC=
`,
      "utf8",
    );

    fs.writeFileSync(
      ENV,
      `EMISSAO_FISCAL=true
ACBR_DRIVER=lib
AMBIENTE_SEFAZ=homologacao
CERT_A1_PASS=senhaEnv123
NFE_CSC_TOKEN=tokenEnv456
CERT_A1_PATH=C:\\\\cert\\\\meu.pfx
NFE_CSC_ID=000002
`,
      "utf8",
    );

    const result = fiscalLocalConfig.sincronizarSegredosDoEnv();
    assert.strictEqual(result.aplicado, true);

    const raw = fs.readFileSync(INI, "utf8");
    assert.match(raw, /Senha=__VAULT__/);
    assert.match(raw, /CSC=__VAULT__/);
    assert.match(raw, /Arquivo=C:\\cert\\meu\.pfx/);
    assert.match(raw, /IdCSC=000002/);
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

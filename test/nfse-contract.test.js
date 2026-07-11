#!/usr/bin/env node
/**
 * Contrato NFS-e — validação de payload e enfileiramento (modelo 99).
 */
const assert = require("assert");
const path = require("path");
const fs = require("fs");

const testDir = path.join(__dirname, "data-contract-nfse");
if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
for (const f of fs.readdirSync(testDir)) {
  try {
    fs.unlinkSync(path.join(testDir, f));
  } catch (_) {}
}

process.env.FISCAL_DB_PATH = path.join(testDir, "fila_nfse.contract.db");
process.env.FISCAL_METRICS_DB = path.join(testDir, "metrics_nfse.contract.db");
process.env.FISCAL_INTEGRITY_STRICT = "false";
process.env.EMISSAO_FISCAL = "true";
process.env.NFSE_ENABLED = "true";
process.env.ACBR_NFE_ENABLED = "true";
process.env.AGENT_TOKEN_REQUIRED = "false";

const { validarPayloadNfse } = require("../fiscal/nfse/nfseValidate");
const fiscalService = require("../fiscalService");
const acbr = require("../acbr");

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((e) => {
      failed++;
      console.error(`  ✗ ${name}:`, e.message);
    });
}

const tomadorOk = {
  cpfCnpj: "12345678901",
  nome: "Tomador Teste NFS-e",
  email: "tomador@teste.local",
  endereco: {
    logradouro: "Rua A",
    numero: "100",
    bairro: "Centro",
    cep: "30130000",
    municipio: "Belo Horizonte",
    uf: "MG",
    codigoIbge: "3106200",
  },
};

const servicoOk = {
  itemListaServico: "01.01",
  discriminacao: "Serviço de consultoria em informática — período mensal",
  valorServico: 150.0,
  aliquotaIss: 2.0,
  issRetido: false,
};

const documentIniMinimo = `[IdentificacaoRps]
Numero=1
Serie=1
Tipo=1
`;

(async () => {
  console.log("\nNFSe contract tests\n");

  await test("validarPayloadNfse — aceita payload com documentIni", () => {
    const out = validarPayloadNfse({
      numeroRps: "1",
      correlationId: "corr-nfse-1",
      documentIni: documentIniMinimo,
      tomador: tomadorOk,
      servico: servicoOk,
    });
    assert.strictEqual(out.numeroRps, "1");
    assert.ok(out.tomador.nome);
  });

  await test("validarPayloadNfse — rejeita tomador incompleto", () => {
    assert.throws(
      () =>
        validarPayloadNfse({
          numeroRps: "2",
          correlationId: "corr-nfse-2",
          documentIni: documentIniMinimo,
          tomador: { cpfCnpj: "123", nome: "" },
          servico: servicoOk,
        }),
      /incompleto/i,
    );
  });

  await test("validarPayloadNfse — aceita tomador/serviço no formato do backend", () => {
    const out = validarPayloadNfse({
      numeroRps: "3",
      correlationId: "corr-nfse-3",
      documentIni: documentIniMinimo,
      tomador: {
        cpfCnpj: "12345678901",
        razaoSocial: "Tomador Backend",
        logradouro: "Rua A",
        numero: "100",
        bairro: "Centro",
        cep: "30130000",
        municipio: "Belo Horizonte",
        uf: "MG",
        codigoIbge: "3106200",
      },
      servico: {
        itemListaServico: "01.01",
        discriminacao: "Serviço de consultoria em informática — período mensal",
        valorServicos: 150.0,
        aliquotaIss: 2.0,
        issRetido: false,
      },
    });
    assert.strictEqual(out.tomador.nome, "Tomador Backend");
    assert.strictEqual(out.servico.valorServico, 150.0);
  });

  await test("montarCallbackBackendNfse — inclui chaveNfe para o backend", () => {
    const { montarCallbackBackendNfse } = require("../fiscal/nfse/nfseCallback");
    const payload = montarCallbackBackendNfse(
      { chave: "CHAVE-NFSE-1", numero: "12345", cStat: "100", protocolo: "PROT-1" },
      "corr-cb-1",
      "<xml/>",
    );
    assert.strictEqual(payload.chaveNfe, "CHAVE-NFSE-1");
    assert.strictEqual(payload.chaveNfse, "CHAVE-NFSE-1");
    assert.strictEqual(payload.numeroNfe, "12345");
    assert.strictEqual(payload.statusFiscal, "AUTORIZADA");
    assert.strictEqual(payload.modeloDocumento, "99");
  });

  await test("enfileirarEmissaoNfse — fiscal pending e modeloDocumento 99", async () => {
    acbr.setRuntimeEmissaoFiscal(true);
    const correlationId = `contract-nfse-${Date.now()}`;
    const body = {
      numeroRps: "42",
      correlationId,
      documentIni: documentIniMinimo,
      tomador: tomadorOk,
      servico: servicoOk,
      empresa: { cnpj: "00000000000191", razaoSocial: "Empresa Teste" },
    };
    const res = await fiscalService.enfileirarEmissaoNfse({}, body, { sync: false });
    assert.strictEqual(res.fiscal, "pending");
    assert.strictEqual(res.modeloDocumento, "99");
    assert.strictEqual(res.correlationId, correlationId);
    assert.strictEqual(res.numeroVenda, "42");
  });

  await test("enfileirarEmissaoNfse — desabilitada quando NFSE_ENABLED=false", async () => {
    process.env.NFSE_ENABLED = "false";
    await assert.rejects(
      () =>
        fiscalService.enfileirarEmissaoNfse(
          {},
          {
            numeroRps: "99",
            correlationId: "x",
            documentIni: documentIniMinimo,
            tomador: tomadorOk,
            servico: servicoOk,
          },
          { sync: false },
        ),
      /NFS-e desabilitada/,
    );
    process.env.NFSE_ENABLED = "true";
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();

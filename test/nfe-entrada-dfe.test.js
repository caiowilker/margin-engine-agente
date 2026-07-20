#!/usr/bin/env node
/**
 * NF-e entrada — Distribuição DFe + Manifestação do Destinatário (ACBr)
 */
const assert = require("assert");
const acbr = require("../acbr");

const CHAVE =
  "35260611222333000181550010000000301025012345";
const CNPJ = "11222333000181";

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

async function run() {
  console.log("nfe-entrada-dfe.test.js\n");

  await test("resolverUfIbgeDestinatario — sigla SP", () => {
    assert.strictEqual(acbr.resolverUfIbgeDestinatario("SP", CHAVE), "35");
  });

  await test("resolverUfIbgeDestinatario — código numérico", () => {
    assert.strictEqual(acbr.resolverUfIbgeDestinatario("31", CHAVE), "31");
  });

  await test("montarIniManifestacaoCiencia — CNPJ, cOrgao 91, tpAmb, dhEvento BR", () => {
    const ini = acbr.montarIniManifestacaoCiencia(CHAVE, CNPJ);
    assert.ok(ini.includes("cOrgao=91"), "cOrgao deve ser 91 (Ambiente Nacional)");
    assert.ok(ini.includes(`CNPJ=${CNPJ}`), "CNPJ do destinatário obrigatório");
    assert.ok(ini.includes("tpEvento=210210"), "tpEvento ciência da operação");
    assert.ok(/tpAmb=[12]/.test(ini), "tpAmb conforme AMBIENTE_SEFAZ");
    assert.ok(/dhEvento=\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}/.test(ini), "dhEvento formato ACBr");
    assert.ok(!ini.includes("CNPJ=\n"), "CNPJ não pode estar vazio");
  });

  await test("montarIniManifestacaoCiencia rejeita CNPJ ausente", () => {
    assert.throws(
      () => acbr.montarIniManifestacaoCiencia(CHAVE, ""),
      /CNPJ do destinatário obrigatório/,
    );
  });

  await test("isCStatManifestacaoOk — 573 duplicidade", () => {
    assert.strictEqual(acbr.isCStatManifestacaoOk("573", ""), true);
    assert.strictEqual(acbr.isCStatManifestacaoOk("135", ""), true);
    assert.strictEqual(acbr.isCStatManifestacaoOk("204", ""), false);
  });

  await test("distribuicaoDFePorChave rejeita CNPJ ausente", async () => {
    await assert.rejects(
      () => acbr.distribuicaoDFePorChave(CHAVE, "", "SP"),
      /CNPJ do destinatário obrigatório/,
    );
  });

  await test("montarIniManifestacaoEvento — Confirmação 210200", () => {
    const ini = acbr.montarIniManifestacaoEvento(CHAVE, CNPJ, "210200", null);
    assert.ok(ini.includes("tpEvento=210200"));
    assert.ok(ini.includes("[EVENTO001]"));
    assert.ok(!ini.includes("xJust="), "Confirmação não exige xJust");
  });

  await test("montarIniManifestacaoEvento — Não realizada exige justificativa", () => {
    assert.throws(
      () => acbr.montarIniManifestacaoEvento(CHAVE, CNPJ, "210240", "curta"),
      /15 caracteres/,
    );
    const ini = acbr.montarIniManifestacaoEvento(
      CHAVE,
      CNPJ,
      "210240",
      "Mercadoria nao entregue pelo transportador",
    );
    assert.ok(ini.includes("tpEvento=210240"));
    assert.ok(ini.includes("xJust="));
  });

  await test("parseResumoNfe extrai chave e emitente", () => {
    const manifesto = require("../manifestoDestinatario");
    const xml = `<resNFe><chNFe>${CHAVE}</chNFe><CNPJ>12345678000190</CNPJ><xNome>FORN</xNome><vNF>10.00</vNF></resNFe>`;
    const parsed = manifesto.parseResumoNfe(xml);
    assert.strictEqual(parsed.chaveAcesso, CHAVE);
    assert.strictEqual(parsed.cnpjEmitente, "12345678000190");
    assert.strictEqual(parsed.valorTotal, 10);
  });

  await test("cienciaRegistradaOk — rejeição cStat não marca ciência", () => {
    const manifesto = require("../manifestoDestinatario");
    assert.strictEqual(
      manifesto.cienciaRegistradaOk({ ok: false, cStat: "204" }, acbr),
      false,
    );
    assert.strictEqual(
      manifesto.cienciaRegistradaOk({ ok: true, cStat: "135" }, acbr),
      true,
    );
    assert.strictEqual(
      manifesto.cienciaRegistradaOk({ ok: false, cStat: "573" }, acbr),
      true,
    );
  });

  await test("avaliarPaginaDist — 138 sem docs não avança NSU", () => {
    const manifesto = require("../manifestoDestinatario");
    const r = manifesto.avaliarPaginaDist({ cStat: "138", xmls: [], resumos: [] });
    assert.strictEqual(r.parar, true);
    assert.ok(r.naoAvancarNsu);
    assert.ok(r.erro);
  });

  await test("avaliarPaginaDist — 137 encerra sem erro", () => {
    const manifesto = require("../manifestoDestinatario");
    const r = manifesto.avaliarPaginaDist({ cStat: "137", xmls: [], resumos: [] });
    assert.strictEqual(r.parar, true);
    assert.strictEqual(r.erro, null);
  });

  await test("avaliarPaginaDist — 656 consumo indevido", () => {
    const manifesto = require("../manifestoDestinatario");
    const r = manifesto.avaliarPaginaDist({ cStat: "656", xmls: [], resumos: [] });
    assert.ok(r.erro);
    assert.ok(/consumo indevido/i.test(r.erro));
  });

  await test("executarSincronizacao sem token retorna ignorado com erro", async () => {
    const manifesto = require("../manifestoDestinatario");
    manifesto.configurar({ lerConfig: async () => ({}) });
    manifesto.limparCacheEmpresa();
    const r = await manifesto.executarSincronizacao(true);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.ignorado, true);
    assert.strictEqual(r.motivo, "agente_nao_ativado");
    assert.ok(r.erro);
  });

  await test("resolverEmpresaFiscal busca CNPJ em /pdv/empresa", async () => {
    const manifesto = require("../manifestoDestinatario");
    manifesto.limparCacheEmpresa();
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      if (String(url).includes("/pdv/empresa")) {
        return {
          ok: true,
          json: async () => ({ cnpj: "11.222.333/0001-81", uf: "SP" }),
        };
      }
      throw new Error(`fetch inesperado: ${url}`);
    };
    try {
      const emp = await manifesto.resolverEmpresaFiscal({
        backendUrl: "http://localhost:8080",
        backendToken: "token",
      });
      assert.strictEqual(emp.cnpj, "11222333000181");
      assert.strictEqual(emp.uf, "SP");
      assert.strictEqual(emp.fonte, "backend");
    } finally {
      global.fetch = originalFetch;
      manifesto.limparCacheEmpresa();
    }
  });

  await test("executarSincronizacao sem CNPJ retorna motivo claro", async () => {
    const manifesto = require("../manifestoDestinatario");
    manifesto.limparCacheEmpresa();
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      if (String(url).includes("/pdv/empresa")) {
        return {
          ok: true,
          json: async () => ({ cnpj: "", uf: "MG" }),
        };
      }
      throw new Error(`fetch inesperado: ${url}`);
    };
    try {
      manifesto.configurar({
        lerConfig: async () => ({
          backendUrl: "http://localhost:8080",
          backendToken: "token-teste",
        }),
      });
      const r = await manifesto.executarSincronizacao(true);
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.motivo, "cnpj_empresa_nao_configurado");
      assert.ok(r.erro);
    } finally {
      global.fetch = originalFetch;
      manifesto.limparCacheEmpresa();
    }
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run();

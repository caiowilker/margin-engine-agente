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

  await test("parseDistribuicaoDFeUltNsuResposta extrai xmls e resumos", () => {
    const acbr = require("../acbr");
    const chave = CHAVE;
    const raw =
      `cStat=138\nxMotivo=Documento localizado\nultNSU=5\nmaxNSU=9\n` +
      `<nfeProc><NFe Id="NFe${chave}"></NFe></nfeProc>` +
      `<resNFe><chNFe>${chave}</chNFe><CNPJ>12345678000190</CNPJ></resNFe>`;
    const parsed = acbr.parseDistribuicaoDFeUltNsuResposta(raw, "0");
    assert.strictEqual(parsed.cStat, "138");
    assert.strictEqual(parsed.xmls.length, 1);
    assert.strictEqual(parsed.resumos.length, 1);
    assert.strictEqual(parsed.ultNsuFinal, "5");
    assert.strictEqual(parsed.maxNsu, "9");
  });

  await test("parseDistribuicaoDFeUltNsuResposta — JSON DistribuicaoDFe (TipoResposta=2)", () => {
    const chave = CHAVE;
    const raw = JSON.stringify({
      DistribuicaoDFe: {
        CStat: 137,
        XMotivo: "Nenhum documento localizado",
        ultNSU: "000000000000000",
        maxNSU: "000000000000000",
        tpAmb: 1,
      },
      ResDFe001: {
        chDFe: chave,
        CNPJCPF: "12345678000190",
        xNome: "FORN",
        vNF: "10.00",
      },
    });
    const parsed = acbr.parseDistribuicaoDFeUltNsuResposta(raw, "0");
    assert.strictEqual(parsed.cStat, "137");
    assert.match(parsed.xMotivo || "", /Nenhum documento/i);
    assert.strictEqual(parsed.ultNsuFinal, "000000000000000");
    assert.ok(parsed.resumos.some((r) => r.includes(chave)));
  });

  await test("consultarChaveEntrada rejeita DV inválido sem SEFAZ", async () => {
    const bad = "35260612345678000190550010000000019999999990";
    await assert.rejects(
      () => acbr.consultarChaveEntrada(bad, CNPJ, "SP"),
      /verificador/i,
    );
  });

  await test("consultarChaveEntrada rejeita modelo 65", async () => {
    // chave válida fixture back com modelo forçado 65 + DV recalculado
    const ok = "35260612345678000190550010000000011000000011";
    const b43 = ok.slice(0, 20) + "65" + ok.slice(22, 43);
    let peso = 2;
    let soma = 0;
    for (let i = b43.length - 1; i >= 0; i--) {
      soma += Number(b43[i]) * peso;
      peso = peso === 9 ? 2 : peso + 1;
    }
    const resto = soma % 11;
    const dv = resto < 2 ? 0 : 11 - resto;
    const chave65 = b43 + String(dv);
    await assert.rejects(
      () => acbr.consultarChaveEntrada(chave65, CNPJ, "SP"),
      /modelo 55/i,
    );
  });

  await test("consultarChaveEntrada obtém XML via DistDFe (deps mock)", async () => {
    const manifesto = require("../manifestoDestinatario");
    manifesto.limparCooldown656();
    const ok = "35260612345678000190550010000000011000000011";
    const xml = `<nfeProc><NFe Id="NFe${ok}"><infNFe/></NFe></nfeProc>`;
    const r = await acbr.consultarChaveEntrada(ok, CNPJ, "SP", {
      consultarChave: async () => {
        throw new Error("não deveria ConsultarNFe se DistDFe já trouxe XML");
      },
      distribuicaoDFePorChave: async () => ({
        cStat: "138",
        xml,
        xMotivo: "Documento localizado",
      }),
      manifestarCienciaOperacao: async () => {
        throw new Error("não deveria chamar ciência se DistDFe já trouxe XML");
      },
    });
    assert.strictEqual(r.ok, true);
    assert.ok(r.xml && r.xml.includes("<NFe"));
    assert.strictEqual(r.fonteConsulta, "DISTRIBUICAO_DFE");
  });

  await test("consultarChaveEntrada trata cStat 656 sem loop", async () => {
    const manifesto = require("../manifestoDestinatario");
    manifesto.limparCooldown656();
    const ok = "35260612345678000190550010000000011000000011";
    const r = await acbr.consultarChaveEntrada(ok, CNPJ, "SP", {
      consultarChave: async () => ({
        cStat: "100",
        situacao: "AUTORIZADA",
        raw: "",
      }),
      distribuicaoDFePorChave: async () => ({
        cStat: "656",
        xml: null,
        xMotivo: "Consumo Indevido",
      }),
      manifestarCienciaOperacao: async () => ({ ok: true }),
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.cStat, "656");
    assert.ok(/consumo indevido|656/i.test(r.mensagem || ""));
    assert.ok(manifesto.restanteCooldown656Ms() > 0, "656 deve registrar cooldown");
    manifesto.limparCooldown656();
  });

  await test("consultarChaveEntrada ciência falha ainda tenta DistDFe", async () => {
    const manifesto = require("../manifestoDestinatario");
    manifesto.limparCooldown656();
    const ok = "35260612345678000190550010000000011000000011";
    const xml = `<nfeProc><NFe Id="NFe${ok}"><infNFe/></NFe></nfeProc>`;
    let distCalls = 0;
    const r = await acbr.consultarChaveEntrada(ok, CNPJ, "SP", {
      consultarChave: async () => {
        throw new Error("não deveria ConsultarNFe se DistDFe pós-ciência trouxe XML");
      },
      distribuicaoDFePorChave: async () => {
        distCalls += 1;
        if (distCalls === 1) return { cStat: "137", xml: null, xMotivo: "Nenhum documento" };
        return { cStat: "138", xml, xMotivo: "Documento localizado" };
      },
      manifestarCienciaOperacao: async () => {
        throw new Error("ciência já registrada");
      },
    });
    assert.strictEqual(r.ok, true);
    assert.ok(r.xml && r.xml.includes("<NFe"));
    assert.strictEqual(distCalls, 2, "DistDFe → ciência → DistDFe");
  });

  await test("consultarChaveEntrada AUTORIZADA sem XML não usa xMotivo cru", async () => {
    const manifesto = require("../manifestoDestinatario");
    manifesto.limparCooldown656();
    const ok = "35260612345678000190550010000000011000000011";
    const r = await acbr.consultarChaveEntrada(ok, CNPJ, "SP", {
      consultarChave: async () => ({
        cStat: "100",
        situacao: "AUTORIZADA",
        xMotivo: "Autorizado o uso da NF-e",
        raw: "",
      }),
      distribuicaoDFePorChave: async () => ({
        cStat: "137",
        xml: null,
        xMotivo: "Nenhum documento",
      }),
      manifestarCienciaOperacao: async () => ({ ok: true }),
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.situacao, "AUTORIZADA_SEM_XML");
    assert.ok(!/^Autorizado/i.test(r.mensagem || ""));
    assert.ok(/XML completo|DistDFe|Manifesto/i.test(r.mensagem || ""));
    assert.strictEqual(r.precisaRetry, true);
  });

  await test("validarXmlConsultaEntrada rejeita protocolo cancelado", () => {
    const ok = "35260612345678000190550010000000011000000011";
    const xml =
      `<nfeProc><NFe Id="NFe${ok}"><infNFe Id="NFe${ok}"/></NFe>` +
      `<protNFe><infProt><cStat>101</cStat><xMotivo>Cancelamento</xMotivo>` +
      `<chNFe>${ok}</chNFe></infProt></protNFe></nfeProc>`;
    const v = acbr.validarXmlConsultaEntrada(xml, ok);
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.situacao, "CANCELADA");
  });

  await test("validarXmlConsultaEntrada aceita cStat 100", () => {
    const ok = "35260612345678000190550010000000011000000011";
    const xml =
      `<nfeProc><NFe Id="NFe${ok}"><infNFe Id="NFe${ok}"/></NFe>` +
      `<protNFe><infProt><cStat>100</cStat><xMotivo>Autorizado</xMotivo>` +
      `<chNFe>${ok}</chNFe></infProt></protNFe></nfeProc>`;
    const v = acbr.validarXmlConsultaEntrada(xml, ok);
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.comProtocolo, true);
  });

  await test("validarXmlConsultaEntrada rejeita chave divergente", () => {
    const ok = "35260612345678000190550010000000011000000011";
    const outra = "35260612345678000190550010000000021000000018";
    const xml = `<nfeProc><NFe Id="NFe${outra}"><infNFe Id="NFe${outra}"/></NFe></nfeProc>`;
    const v = acbr.validarXmlConsultaEntrada(xml, ok);
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.situacao, "XML_DIVERGENTE");
  });

  await test("consultarChaveEntrada single-flight coalesces", async () => {
    const manifesto = require("../manifestoDestinatario");
    manifesto.limparCooldown656();
    const ok = "35260612345678000190550010000000011000000011";
    const xml = `<nfeProc><NFe Id="NFe${ok}"><infNFe/></NFe></nfeProc>`;
    let distCalls = 0;
    const deps = {
      consultarChave: async () => {
        throw new Error("não deveria");
      },
      distribuicaoDFePorChave: async () => {
        distCalls += 1;
        await new Promise((r) => setTimeout(r, 50));
        return { cStat: "138", xml, xMotivo: "ok" };
      },
      manifestarCienciaOperacao: async () => ({ ok: true }),
    };
    const [a, b] = await Promise.all([
      acbr.consultarChaveEntrada(ok, CNPJ, "SP", deps),
      acbr.consultarChaveEntrada(ok, CNPJ, "SP", deps),
    ]);
    assert.strictEqual(a.ok, true);
    assert.strictEqual(b.ok, true);
    assert.strictEqual(distCalls, 1, "duas consultas paralelas = uma DistDFe");
  });

  await test("consultarChaveEntrada respeita cooldown 656 persistido", async () => {
    const manifesto = require("../manifestoDestinatario");
    manifesto.limparCooldown656();
    process.env.MANIFESTO_656_COOLDOWN_MS = "3600000";
    manifesto.registrarCooldown656();
    const ok = "35260612345678000190550010000000011000000011";
    let distCalls = 0;
    const r = await acbr.consultarChaveEntrada(ok, CNPJ, "SP", {
      consultarChave: async () => ({ cStat: "100", situacao: "AUTORIZADA", raw: "" }),
      distribuicaoDFePorChave: async () => {
        distCalls += 1;
        return { cStat: "138", xml: null };
      },
      manifestarCienciaOperacao: async () => ({ ok: true }),
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.situacao, "CONSUMO_INDEVIDO");
    assert.strictEqual(distCalls, 0);
    manifesto.limparCooldown656();
    delete process.env.MANIFESTO_656_COOLDOWN_MS;
  });

  await test("acbrLibDriver exporta DistDFe e manifesto nativos", () => {
    const lib = require("../fiscal/drivers/acbrLibDriver");
    assert.strictEqual(typeof lib.distribuicaoDFePorUltNsu, "function");
    assert.strictEqual(typeof lib.distribuicaoDFePorChave, "function");
    assert.strictEqual(typeof lib.manifestarEventoDestinatario, "function");
    assert.strictEqual(typeof lib.manifestarCienciaOperacao, "function");
    assert.strictEqual(typeof lib.consultarChaveEntrada, "function");
  });

  await test("aplicarModeloDfNfeParaDistDfe força moNFe (evita NFCe_AN_H)", () => {
    const lib = require("../fiscal/drivers/acbrLibDriver");
    const calls = [];
    const inst = {
      configGravarValor(sec, key, val) {
        calls.push([sec, key, val]);
      },
    };
    lib.aplicarModeloDfNfeParaDistDfe(inst);
    assert.ok(calls.some((c) => c[0] === "NFe" && c[1] === "ModeloDF" && c[2] === "0"));
    assert.ok(calls.some((c) => c[0] === "ACBrNFe" && c[1] === "ModeloDF" && c[2] === "55"));
    lib.restaurarModeloDfNfce(inst);
    assert.ok(calls.some((c) => c[0] === "NFe" && c[1] === "ModeloDF" && c[2] === "1"));
    assert.ok(calls.some((c) => c[0] === "ACBrNFe" && c[1] === "ModeloDF" && c[2] === "65"));
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
    assert.strictEqual(r.consumoIndevido, true);
    assert.strictEqual(r.naoAvancarNsu, true);
  });

  await test("cooldown 656 bloqueia sync sem bater na SEFAZ", async () => {
    const manifesto = require("../manifestoDestinatario");
    manifesto.limparCooldown656();
    process.env.MANIFESTO_656_COOLDOWN_MS = "3600000";
    manifesto.registrarCooldown656();
    manifesto.configurar({
      lerConfig: async () => ({
        backendUrl: "http://localhost:9999",
        backendToken: "t",
      }),
    });
    manifesto.limparCacheEmpresa();
    const r = await manifesto.executarSincronizacao(true);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.ignorado, true);
    assert.strictEqual(r.motivo, "consumo_indevido_cooldown");
    assert.ok(r.cooldownMs > 0);
    manifesto.limparCooldown656();
    delete process.env.MANIFESTO_656_COOLDOWN_MS;
  });

  await test("avaliarPaginaDist — sem cStat é erro (não Sucesso falso)", () => {
    const manifesto = require("../manifestoDestinatario");
    const r = manifesto.avaliarPaginaDist({ cStat: null, xmls: [], resumos: [] });
    assert.strictEqual(r.parar, true);
    assert.ok(r.erro);
    assert.strictEqual(r.naoAvancarNsu, true);
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

  await test("DistDFe vazio + backend 500 persiste só o cursor NSU", async () => {
    const manifesto = require("../manifestoDestinatario");
    manifesto.limparCooldown656();
    manifesto.limparCacheEmpresa();
    const fiscalPath = require.resolve("../fiscalDriver");
    const originalFiscal = require.cache[fiscalPath];
    require.cache[fiscalPath] = {
      id: fiscalPath,
      filename: fiscalPath,
      loaded: true,
      exports: {
        getDriverInfo: () => ({ provider: "mock" }),
        distribuicaoDFePorUltNsu: async () => ({
          cStat: "137",
          ultNsuFinal: "000000000000042",
          maxNsu: "000000000000042",
          xmls: [],
          resumos: [],
          xMotivo: "Nenhum documento localizado",
        }),
      },
    };
    const originalFetch = global.fetch;
    const posts = [];
    global.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes("/pdv/empresa")) {
        return { ok: true, json: async () => ({ cnpj: "11222333000181", uf: "SP" }) };
      }
      if (u.includes("/manifesto/config")) {
        return { ok: true, json: async () => ({ ultNsu: "0" }) };
      }
      if (u.includes("/manifesto/sync")) {
        const body = JSON.parse(init.body);
        posts.push(body);
        if (posts.length <= 2) {
          return { ok: false, text: async () => "duplicate key uq_manifesto_doc_tenant_chave" };
        }
        return { ok: true, json: async () => ({ status: "SUCESSO", notasImportadas: 0 }) };
      }
      throw new Error(`fetch inesperado: ${u}`);
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
      assert.ok(posts.length >= 3, `esperava retry + cursor, posts=${posts.length}`);
      const cursor = posts[posts.length - 1];
      assert.strictEqual(cursor.ultNsuFinal, "000000000000042");
      assert.deepStrictEqual(cursor.notas, []);
      assert.match(String(cursor.mensagem || ""), /Cursor DistDFe persistido/);
      assert.deepStrictEqual(posts[0].notas, []);
    } finally {
      global.fetch = originalFetch;
      if (originalFiscal) require.cache[fiscalPath] = originalFiscal;
      else delete require.cache[fiscalPath];
      manifesto.limparCacheEmpresa();
      manifesto.limparCooldown656();
    }
  });

  await test("DistDFe com notas + backend 500 NÃO avança cursor", async () => {
    const manifesto = require("../manifestoDestinatario");
    manifesto.limparCooldown656();
    manifesto.limparCacheEmpresa();
    const fiscalPath = require.resolve("../fiscalDriver");
    const originalFiscal = require.cache[fiscalPath];
    const chaveDoc = "35260611222333000181550010000000301025012345";
    require.cache[fiscalPath] = {
      id: fiscalPath,
      filename: fiscalPath,
      loaded: true,
      exports: {
        getDriverInfo: () => ({ provider: "mock" }),
        distribuicaoDFePorUltNsu: async () => ({
          cStat: "138",
          ultNsuFinal: "000000000000042",
          maxNsu: "000000000000042",
          xmls: [],
          resumos: [
            {
              chaveAcesso: chaveDoc,
              cnpjEmitente: "12345678000190",
              nomeEmitente: "FORN",
              valorTotal: 10,
              nsu: "42",
            },
          ],
          xMotivo: "Documento localizado",
        }),
        manifestarCienciaOperacao: async () => ({ ok: true, cStat: "135" }),
        consultarChave: async () => ({ cStat: "100" }),
        distribuicaoDFePorChave: async () => ({ xml: null }),
        isCStatManifestacaoOk: () => true,
      },
    };
    const originalFetch = global.fetch;
    const posts = [];
    global.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes("/pdv/empresa")) {
        return { ok: true, json: async () => ({ cnpj: "11222333000181", uf: "SP" }) };
      }
      if (u.includes("/manifesto/config")) {
        return { ok: true, json: async () => ({ ultNsu: "0" }) };
      }
      if (u.includes("/manifesto/sync")) {
        const body = JSON.parse(init.body);
        posts.push(body);
        return { ok: false, text: async () => "HTTP 500" };
      }
      throw new Error(`fetch inesperado: ${u}`);
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
      assert.strictEqual(posts.length, 2, `só tentativa + retry, sem cursor vazio; posts=${posts.length}`);
      assert.ok(posts.every((p) => p.notas && p.notas.length === 1));
      assert.strictEqual(r.ultNsuFinal, "0");
    } finally {
      global.fetch = originalFetch;
      if (originalFiscal) require.cache[fiscalPath] = originalFiscal;
      else delete require.cache[fiscalPath];
      manifesto.limparCacheEmpresa();
      manifesto.limparCooldown656();
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

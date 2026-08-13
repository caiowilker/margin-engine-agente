#!/usr/bin/env node
"use strict";

const assert = require("assert");
const {
  normalizarFormatoPdfNfce,
  suffixPdfModelo,
  paramsImprimirDanfePdfMonitor,
  deveAplicarLogoDanfe,
  MARCA_DAGUA_MARGIN,
  TIPO_RELATORIO_BOBINA_NFCE,
  TIPO_DANFE_ACBR,
  nfceLayoutAcbrParams,
} = require("../fiscalPdfFormato");

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    return false;
  }
}

async function main() {
  console.log("fiscal-pdf-formato.test.js");
  let ok = 0;
  let fail = 0;

  const cases = [
    [
      "normalizarFormatoPdfNfce — NFC-e térmico padrão",
      () => {
        assert.strictEqual(normalizarFormatoPdfNfce(undefined, "65"), "termico");
        assert.strictEqual(normalizarFormatoPdfNfce("termico", "65"), "termico");
      },
    ],
    [
      "normalizarFormatoPdfNfce — NFC-e A4",
      () => {
        assert.strictEqual(normalizarFormatoPdfNfce("a4", "65"), "a4");
        assert.strictEqual(normalizarFormatoPdfNfce("pagamento", "65"), "a4");
      },
    ],
    [
      "normalizarFormatoPdfNfce — NF-e sempre A4",
      () => {
        assert.strictEqual(normalizarFormatoPdfNfce("termico", "55"), "a4");
      },
    ],
    [
      "suffixPdfModelo — sufixos distintos",
      () => {
        assert.strictEqual(suffixPdfModelo("65", "termico"), "danfce");
        assert.strictEqual(suffixPdfModelo("65", "a4"), "danfce-a4");
        assert.strictEqual(suffixPdfModelo("55", "termico"), "danfe");
      },
    ],
    [
      "paramsImprimirDanfePdfMonitor — NFC-e A4 vs térmico",
      () => {
        const termico = paramsImprimirDanfePdfMonitor("65", "termico");
        const a4 = paramsImprimirDanfePdfMonitor("65", "a4");
        assert.strictEqual(termico.simplificado, "1");
        assert.strictEqual(termico.viaConsumidor, "1");
        assert.strictEqual(a4.simplificado, "0");
        assert.strictEqual(a4.viaConsumidor, "0");
        assert.strictEqual(termico.marcaDagua, MARCA_DAGUA_MARGIN);
        const layoutTermico = nfceLayoutAcbrParams("termico");
        const layoutA4 = nfceLayoutAcbrParams("a4");
        assert.strictEqual(layoutTermico.tipoRelatorioBobina, TIPO_RELATORIO_BOBINA_NFCE.ESCPOS);
        assert.strictEqual(layoutA4.tipoRelatorioBobina, TIPO_RELATORIO_BOBINA_NFCE.FORTES_A4);
        assert.strictEqual(layoutTermico.tipoDANFE, TIPO_DANFE_ACBR.NFCE);
        assert.strictEqual(layoutA4.tipoDANFE, TIPO_DANFE_ACBR.RETRATO_A4);
        assert.strictEqual(layoutA4.formulario, "0");
        assert.strictEqual(layoutA4.impressora, "");
      },
    ],
    [
      "paramsImprimirDanfePdfMonitor — NF-e A4",
      () => {
        const nfe = paramsImprimirDanfePdfMonitor("55", "a4");
        assert.strictEqual(nfe.simplificado, "0");
      },
    ],
    [
      "deveAplicarLogoDanfe — só A4",
      () => {
        assert.strictEqual(deveAplicarLogoDanfe("55", "termico"), true);
        assert.strictEqual(deveAplicarLogoDanfe("65", "a4"), true);
        assert.strictEqual(deveAplicarLogoDanfe("65", "termico"), false);
      },
    ],
    [
      "logoDanfeAcbrSets — caixa oficial do emitente",
      () => {
        const { logoDanfeAcbrSets } = require("../fiscalPdfFormato");
        const sets = logoDanfeAcbrSets("/tmp/logo.png");
        const map = Object.fromEntries(sets.map(([s, k, v]) => [`${s}.${k}`, v]));
        assert.strictEqual(map["DANFE.PathLogo"], "/tmp/logo.png");
        assert.strictEqual(map["DANFE.ExpandeLogoMarca"], "0");
        assert.strictEqual(map["DANFE.ExpandeLogoMarca.Esticar"], "0");
        assert.strictEqual(map["DANFENFe.LogoemCima"], "0");
        assert.ok(!map["DANFE.ExpandeLogoMarca.Largura"]);
        assert.ok(!map["DANFENFe.TamanhoLogoWidth"]);
      },
    ],
    [
      "danfeEmitenteFonteAcbrSets — MOC 12pt razão social",
      () => {
        const {
          danfeEmitenteFonteAcbrSets,
          DANFE_FONTE_RAZAO_SOCIAL,
          DANFE_FONTE_EMITENTE_DEMAIS,
          applyDanfeEmitenteFonteAcbrLib,
          danfeEmitenteFonteMonitorComandos,
        } = require("../fiscalPdfFormato");
        const map = Object.fromEntries(
          danfeEmitenteFonteAcbrSets().map(([s, k, v]) => [`${s}.${k}`, v]),
        );
        assert.strictEqual(map["DANFENFe.Fonte.TamanhoFonteRazaoSocial"], "12");
        assert.strictEqual(map["DANFENFe.Fonte.TamanhoFonteEndereco"], "8");
        assert.strictEqual(map["DANFENFe.Fonte.TamanhoFonteDemaisCampos"], "8");
        assert.strictEqual(map["DANFENFe.Fonte.Negrito"], "1");
        assert.strictEqual(DANFE_FONTE_RAZAO_SOCIAL, "12");
        assert.strictEqual(DANFE_FONTE_EMITENTE_DEMAIS, "8");
        const calls = [];
        applyDanfeEmitenteFonteAcbrLib({
          configGravarValor: (s, k, v) => calls.push([s, k, v]),
        });
        assert.ok(calls.some((c) => c[1] === "Fonte.TamanhoFonteRazaoSocial" && c[2] === "12"));
        const cmds = danfeEmitenteFonteMonitorComandos();
        assert.ok(cmds.some((c) => c.includes("Fonte.TamanhoFonteRazaoSocial") && c.includes("12")));
      },
    ],
  ];

  for (const [name, fn] of cases) {
    if (await test(name, fn)) ok++;
    else fail++;
  }

  console.log(`\n${ok}/${ok + fail} testes passaram`);
  process.exit(fail > 0 ? 1 : 0);
}

main();

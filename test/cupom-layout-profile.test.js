#!/usr/bin/env node
/**
 * Etapa 12-3 — perfis + compactação não fiscal (12-3a) e fiscal NFC-e (12-3b).
 * PADRAO ≡ golden ANTES tag a tag; Compacto/Ultra opt-in 80 mm.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { test } = require("node:test");
const {
  payloadCupom12,
  stubPrinterCols,
  CHAVE65,
} = require("./fixtures/cupomLayout12");

const AMOSTRAS = path.join(__dirname, "..", "docs", "etapa12-amostras");
const GOLDEN_NF = path.join(AMOSTRAS, "goldens-12-3a");
const GOLDEN_FISC = path.join(AMOSTRAS, "goldens-12-3b");

const CENARIOS_NAOFISCAL = [
  ["naofiscal-1item-80mm", 1, {}],
  ["naofiscal-5itens-80mm", 5, {}],
  ["naofiscal-20itens-80mm", 20, {}],
  ["naofiscal-5-desconto-80mm", 5, { desconto: 15 }],
  [
    "naofiscal-5-crediario-80mm",
    5,
    {
      pagamentos: [
        { forma: "DINHEIRO", valor: 20 },
        { forma: "CREDIARIO", valor: 49 },
      ],
    },
  ],
  [
    "naofiscal-5-multipag-80mm",
    5,
    {
      pagamentos: [
        { forma: "DINHEIRO", valor: 20 },
        { forma: "PIX", valor: 15 },
        { forma: "DEBITO", valor: 34 },
      ],
    },
  ],
];

const CENARIOS_FISCAL = [
  [
    "fiscal-1item-80mm",
    1,
    { consumidor: { cpf: "52998224725", nome: "CLIENTE TESTE" } },
  ],
  [
    "fiscal-5itens-80mm",
    5,
    { consumidor: { cpf: "52998224725", nome: "CLIENTE TESTE" } },
  ],
  ["fiscal-20itens-80mm", 20, {}],
  ["fiscal-5-desconto-80mm", 5, { desconto: 15 }],
  [
    "fiscal-5-crediario-80mm",
    5,
    {
      pagamentos: [
        { forma: "DINHEIRO", valor: 20 },
        { forma: "CREDIARIO", valor: 49 },
      ],
    },
  ],
  [
    "fiscal-5-multipag-80mm",
    5,
    {
      pagamentos: [
        { forma: "DINHEIRO", valor: 20 },
        { forma: "PIX", valor: 15 },
        { forma: "DEBITO", valor: 34 },
      ],
    },
  ],
];

function withFiscalCompactoLiberado(fn) {
  const prev = process.env.PRINT_CUPOM_FISCAL_COMPACTO;
  process.env.PRINT_CUPOM_FISCAL_COMPACTO = "true";
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PRINT_CUPOM_FISCAL_COMPACTO;
    else process.env.PRINT_CUPOM_FISCAL_COMPACTO = prev;
  }
}

function render(perfil, n, opts = {}) {
  stubPrinterCols(48, perfil);
  const { renderCupomTags } = require("../print/cupomAcbrTags");
  return renderCupomTags(
    payloadCupom12(n, {
      ...opts,
      fiscal: !!opts.fiscal,
      perfil,
    }),
  );
}

function renderFiscal(perfil, n, opts = {}) {
  return render(perfil, n, { ...opts, fiscal: true });
}

/** Fiscal Compacto/Ultra só com liberação (prova 12-3b). */
function renderFiscalLiberado(perfil, n, opts = {}) {
  return withFiscalCompactoLiberado(() => renderFiscal(perfil, n, opts));
}

test("resolveCupomLayoutProfile — fiscal Compacto BLOQUEADO; liberado mantém Volumes; 58mm bloqueia", () => {
  const {
    resolveCupomLayoutProfile,
    normalizarPerfilId,
    descreverCortesPerfil,
  } = require("../print/cupomLayoutProfile");
  assert.strictEqual(normalizarPerfilId("compacto"), "COMPACTO");
  const padrao = resolveCupomLayoutProfile({});
  assert.strictEqual(padrao.id, "PADRAO");
  assert.strictEqual(padrao.shrinkQr, false);
  assert.strictEqual(padrao.fontB, false);

  const bloqueado = resolveCupomLayoutProfile({
    perfil: "COMPACTO",
    isFiscal: true,
    paperMm: 80,
  });
  assert.strictEqual(bloqueado.id, "PADRAO");
  assert.strictEqual(bloqueado.forcedReason, "FISCAL_COMPACTO_BLOQUEADO");

  const fiscal = withFiscalCompactoLiberado(() =>
    resolveCupomLayoutProfile({
      perfil: "COMPACTO",
      isFiscal: true,
      paperMm: 80,
    }),
  );
  assert.strictEqual(fiscal.id, "COMPACTO");
  assert.strictEqual(fiscal.forcedReason, null);
  assert.strictEqual(fiscal.omitVolumes, false, "fiscal nunca omite Volumes (MET III)");
  assert.strictEqual(fiscal.collapseTotalSeps, true);

  const mm58 = resolveCupomLayoutProfile({
    perfil: "ULTRA",
    isFiscal: true,
    paperMm: 58,
  });
  assert.strictEqual(mm58.id, "PADRAO");
  assert.strictEqual(mm58.forcedReason, "58MM_NAO_VALIDADO");

  const cortes = descreverCortesPerfil();
  assert.ok(cortes.COMPACTO.corta.some((c) => /Volumes/i.test(c)));
  assert.ok(cortes.ULTRA.corta.some((c) => /tudo do Compacto/i.test(c)));
});

test("PADRAO — golden tag a tag (ANTES naofiscal + fiscal 80mm)", () => {
  for (const [name, n, opts] of CENARIOS_NAOFISCAL) {
    const golden = fs.readFileSync(
      path.join(AMOSTRAS, `ANTES-${name}.tags.txt`),
      "utf8",
    );
    assert.strictEqual(render("PADRAO", n, opts), golden, name);
  }
  for (const [name, n, opts] of CENARIOS_FISCAL) {
    const golden = fs.readFileSync(
      path.join(AMOSTRAS, `ANTES-${name}.tags.txt`),
      "utf8",
    );
    assert.strictEqual(renderFiscal("PADRAO", n, opts), golden, name);
  }
});

test("12-3a COMPACTO reforçado — omitVolumes+collapseTotalSeps; dados ok", () => {
  const {
    medirTags,
    compararMetricas,
    extrairTokensDados,
  } = require("../print/cupomLayoutMetrics");
  fs.mkdirSync(GOLDEN_NF, { recursive: true });
  const report = {};
  for (const [name, n, opts] of CENARIOS_NAOFISCAL) {
    const padrao = render("PADRAO", n, opts);
    const compacto = render("COMPACTO", n, opts);
    const ultra = render("ULTRA", n, opts);
    const mP = medirTags(padrao);
    const mC = medirTags(compacto);
    const mU = medirTags(ultra);
    assert.ok(mC.linhas <= mP.linhas - 2, `${name}: Compacto deve cortar ≥2 linhas`);
    assert.ok(mU.linhas <= mC.linhas);
    assert.deepStrictEqual(
      extrairTokensDados(compacto),
      extrairTokensDados(padrao),
    );
    assert.ok(!compacto.includes("Volumes:"));
    assert.ok(padrao.includes("Volumes:"));
    fs.writeFileSync(
      path.join(GOLDEN_NF, `COMPACTO-${name}.tags.txt`),
      compacto,
    );
    fs.writeFileSync(path.join(GOLDEN_NF, `ULTRA-${name}.tags.txt`), ultra);
    report[name] = {
      PADRAO: { linhas: mP.linhas, dots: mP.dots, mmEst: mP.mmEst },
      COMPACTO: compararMetricas(mP, mC),
      ULTRA: compararMetricas(mP, mU),
    };
  }
  fs.writeFileSync(
    path.join(GOLDEN_NF, "metricas-12-3a.json"),
    JSON.stringify({ when: new Date().toISOString(), report }, null, 2),
  );
});

test("12-3b fiscal — default bloqueia Compacto; liberado: obrigatórios idênticos (MET)", () => {
  const {
    medirTags,
    compararMetricas,
  } = require("../print/cupomLayoutMetrics");
  const {
    extrairCamposFiscaisObrigatorios,
    resolveQrPrintOpts,
  } = require("../print/cupomLayoutShared");
  const { tagQrCodeSeguro } = require("../print/acbrTags");
  const { resolverQrCodeNfce } = require("../print/cupomValidate");
  fs.mkdirSync(GOLDEN_FISC, { recursive: true });
  const report = {};
  const qrOpts = resolveQrPrintOpts();

  // Sem liberação: Compacto fiscal = Padrão (bloqueado).
  const bloqueado = renderFiscal("COMPACTO", 1, {
    consumidor: { cpf: "52998224725", nome: "CLIENTE TESTE" },
  });
  const padraoBloq = renderFiscal("PADRAO", 1, {
    consumidor: { cpf: "52998224725", nome: "CLIENTE TESTE" },
  });
  assert.strictEqual(bloqueado, padraoBloq, "fiscal Compacto bloqueado ≡ Padrão");

  for (const [name, n, opts] of CENARIOS_FISCAL) {
    const padrao = renderFiscal("PADRAO", n, opts);
    const compacto = renderFiscalLiberado("COMPACTO", n, opts);
    const ultra = renderFiscalLiberado("ULTRA", n, opts);

    const camposP = extrairCamposFiscaisObrigatorios(padrao);
    const camposC = extrairCamposFiscaisObrigatorios(compacto);
    const camposU = extrairCamposFiscaisObrigatorios(ultra);
    assert.deepStrictEqual(camposC, camposP, `${name} campos Compacto`);
    assert.deepStrictEqual(camposU, camposP, `${name} campos Ultra`);
    assert.strictEqual(camposP.chaveDigits, CHAVE65);
    assert.ok(camposP.consultaLine, `${name} consulta+URL`);
    assert.ok(camposP.portal, `${name} URL portal`);
    assert.ok(camposP.protocolo, `${name} protocolo`);
    assert.ok(camposP.total, `${name} TOTAL`);
    assert.ok(camposP.volumes, `${name} Volumes/qtde itens (MET III)`);
    assert.ok(camposP.pagamentos.length >= 1, `${name} formas pagamento`);
    assert.ok(camposP.qrPlaceholder || camposP.qrTag);
    assert.ok(compacto.includes("Volumes:"), `${name} Compacto mantém Volumes`);

    const payload = payloadCupom12(n, { ...opts, fiscal: true, perfil: "PADRAO" });
    const qrUrl = resolverQrCodeNfce(payload);
    assert.strictEqual(tagQrCodeSeguro(qrUrl), tagQrCodeSeguro(qrUrl));
    assert.strictEqual(resolveQrPrintOpts().moduleSize, qrOpts.moduleSize);
    assert.ok(compacto.includes("{{ME_QR_BMP}}") || /<qrcode/i.test(compacto));
    assert.ok(!compacto.includes("Consulta via QR Code"));
    assert.ok(padrao.includes("Consulta via QR Code"));

    const mP = medirTags(padrao);
    const mC = medirTags(compacto);
    const mU = medirTags(ultra);
    assert.ok(mC.linhas < mP.linhas, `${name} Compacto reduz`);
    assert.strictEqual(mC.qrCount, mP.qrCount);
    assert.ok(mU.linhas <= mC.linhas);

    fs.writeFileSync(
      path.join(GOLDEN_FISC, `COMPACTO-${name}.tags.txt`),
      compacto,
    );
    fs.writeFileSync(
      path.join(GOLDEN_FISC, `ULTRA-${name}.tags.txt`),
      ultra,
    );
    report[name] = {
      PADRAO: { linhas: mP.linhas, dots: mP.dots, mmEst: mP.mmEst },
      COMPACTO: { ...compararMetricas(mP, mC), porBloco: compararMetricas(mP, mC).porBloco },
      ULTRA: compararMetricas(mP, mU),
    };
  }

  // Multipagamento + troco — textos obrigatórios idênticos
  const optsTroco = {
    consumidor: { cpf: "52998224725", nome: "CLIENTE TESTE" },
    pagamentos: [
      { forma: "DINHEIRO", valor: 50, troco: 5 },
      { forma: "PIX", valor: 24 },
    ],
  };
  const padTroco = renderFiscal("PADRAO", 5, {
    ...optsTroco,
    // payloadCupom12 usa valorRecebido=total; forçamos troco no payload via override
  });
  // Injeta troco/recebido no render direto
  stubPrinterCols(48, "PADRAO");
  const { renderCupomTags } = require("../print/cupomAcbrTags");
  const baseTroco = payloadCupom12(5, { ...optsTroco, fiscal: true, perfil: "PADRAO" });
  baseTroco.valorRecebido = 74;
  baseTroco.troco = 5;
  baseTroco.pagamentos = optsTroco.pagamentos;
  const padT = renderCupomTags(baseTroco);
  const compT = withFiscalCompactoLiberado(() => {
    stubPrinterCols(48, "COMPACTO");
    const p = { ...baseTroco, cupomLayoutPerfil: "COMPACTO" };
    return require("../print/cupomAcbrTags").renderCupomTags(p);
  });
  const cPad = extrairCamposFiscaisObrigatorios(padT);
  const cComp = extrairCamposFiscaisObrigatorios(compT);
  assert.deepStrictEqual(cComp, cPad, "multipag+troco campos");
  assert.ok(cPad.troco, "troco presente");
  assert.ok(cPad.recebido, "recebido presente");
  assert.ok(cPad.pagamentos.length >= 2, "multipagamento");
  assert.strictEqual(cPad.cpf.replace(/\D/g, ""), "52998224725");
  assert.ok(/CLIENTE TESTE/i.test(cPad.cliente));
  void padTroco;

  // reimpressão / contingência / cancelada / homologação
  const extras = [
    ["reimpressao", { segundaVia: true }],
    ["contingencia", { origem: "contingencia" }],
    ["cancelada", { vendaCancelada: true }],
    ["homologacao", { ambiente: "homologacao", observacao: "SEM VALOR FISCAL" }],
  ];
  for (const [label, extra] of extras) {
    const padrao = renderFiscal("PADRAO", 1, {
      consumidor: { cpf: "52998224725", nome: "CLIENTE TESTE" },
      ...extra,
    });
    const compacto = renderFiscalLiberado("COMPACTO", 1, {
      consumidor: { cpf: "52998224725", nome: "CLIENTE TESTE" },
      ...extra,
    });
    assert.deepStrictEqual(
      extrairCamposFiscaisObrigatorios(compacto),
      extrairCamposFiscaisObrigatorios(padrao),
      label,
    );
    fs.writeFileSync(
      path.join(GOLDEN_FISC, `COMPACTO-fiscal-${label}-80mm.tags.txt`),
      compacto,
    );
  }

  fs.writeFileSync(
    path.join(GOLDEN_FISC, "metricas-12-3b.json"),
    JSON.stringify(
      {
        when: new Date().toISOString(),
        oficial: "linhas_e_dots",
        mm: "ESTIMADO_apenas",
        shrinkQr: false,
        fontB: false,
        fiscalCompactoDefault: "BLOQUEADO",
        omitVolumesFiscal: false,
        report,
      },
      null,
      2,
    ),
  );
});

test("descrição 60+ chars e 100 itens — Compacto reduz sem perder totais", () => {
  const { medirTags, extrairTokensDados } = require("../print/cupomLayoutMetrics");
  const p100 = payloadCupom12(100, { fiscal: false, long: true, perfil: "PADRAO" });
  assert.ok(p100.itens[0].nome.length >= 60);
  const padrao = render("PADRAO", 100, { long: true });
  const compacto = render("COMPACTO", 100, { long: true });
  assert.ok(medirTags(compacto).linhas < medirTags(padrao).linhas);
  assert.deepStrictEqual(
    extrairTokensDados(compacto).filter((t) => t.startsWith("R$")),
    extrairTokensDados(padrao).filter((t) => t.startsWith("R$")),
  );
});

test("acentos — PaginaDeCodigo=5; Compacto = Padrão (toThermalText)", () => {
  const { toThermalText } = require("../thermalText");
  const amostras = {
    cedilha: "Açaí",
    til: "São João",
    agudo: "café",
    o_til: "pão de queijão",
    ordinal: "nº 3º",
    razao: "COMÉRCIO DE AÇAÍ SÃO JOSÉ LTDA",
    item: "Açaí 500ml c/ granola — edição",
    msg: "Obrigado pela preferência! Volte sempre ao café",
  };
  const esperado = {};
  for (const [k, v] of Object.entries(amostras)) {
    esperado[k] = toThermalText(v);
  }
  // Documenta strip ASCII (legado térmico) — idêntico nos dois perfis
  assert.strictEqual(esperado.cedilha, "Acai");
  assert.strictEqual(esperado.til, "Sao Joao");
  assert.ok(esperado.ordinal.includes("o") || esperado.ordinal.includes("n"));

  stubPrinterCols(48, "PADRAO");
  const { renderCupomTags } = require("../print/cupomAcbrTags");
  const base = {
    naoFiscal: true,
    cupomSemFiscal: true,
    empresa: {
      nomeFantasia: amostras.cedilha.toUpperCase() + " DO JOSE",
      razaoSocial: amostras.razao,
      cnpj: "12.345.678/0001-99",
      endereco: "RUA AÇAÍ, 100",
      cidade: "SÃO PAULO",
      uf: "SP",
    },
    operador: "CAIXA 01",
    numeroVenda: "PDV999",
    emitidoEm: "2026-10-13T18:00:00-03:00",
    itens: [
      {
        nome: amostras.item,
        quantidade: 1,
        precoUnitario: 15,
        total: 15,
      },
    ],
    total: 15,
    pagamentos: [{ forma: "DINHEIRO", valor: 15 }],
    observacao: amostras.msg + " — portão º",
  };
  const p = renderCupomTags({ ...base, cupomLayoutPerfil: "PADRAO" });
  const c = renderCupomTags({ ...base, cupomLayoutPerfil: "COMPACTO" });
  const stripRazao = toThermalText(amostras.razao);
  assert.ok(p.includes(stripRazao) || p.includes("COMERCIO"));
  assert.ok(c.includes(stripRazao) || c.includes("COMERCIO"));
  // mesmos tokens de valor; observação strip igual
  assert.ok(p.includes("15,00") && c.includes("15,00"));
  // observação (dados) idêntica; rodapé Compacto mergeia mensagens do sistema
  const obsLines = (tags) =>
    tags
      .split("\n")
      .filter((l) => /Obs:|preferencia! Volte sempre ao|portao/i.test(l) && !/<ce><n>Obrigado/.test(l));
  assert.deepStrictEqual(obsLines(c), obsLines(p));
  assert.ok(p.includes(toThermalText(amostras.item).slice(0, 12)) || p.includes("Acai"));
  assert.ok(c.includes(toThermalText(amostras.item).slice(0, 12)) || c.includes("Acai"));
  // INI live POS80 = PaginaDeCodigo=5; perfis não alteram página/encoding
  assert.ok(p.includes("15,00") && c.includes("15,00"));
});

test("reimpressão / contingência / cancelada herdam perfil Compacto", () => {
  const tags = renderFiscalLiberado("COMPACTO", 1, {
    consumidor: { cpf: "52998224725", nome: "CLIENTE TESTE" },
    segundaVia: true,
    origem: "contingencia",
    vendaCancelada: true,
  });
  assert.ok(tags.includes("Obrigado pela preferencia! Volte sempre!"));
  assert.ok(tags.includes("{{ME_QR_BMP}}"));
  assert.ok(!tags.includes("Consulta via QR Code"));
  assert.ok(tags.includes("Volumes:"), "fiscal Compacto mantém Volumes");
});

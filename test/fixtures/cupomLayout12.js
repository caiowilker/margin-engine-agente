/**
 * Payloads canônicos Etapa 12 (mesmos da geração dos ANTES-*.tags.txt).
 */
const CHAVE65 = "35261012345678000199650010000001231000001234";

function item(i, long) {
  const nome = long
    ? `PRODUTO DESCRICAO MUITO LONGA PARA TESTE DE QUEBRA DE LINHA NUMERO ${i} MARCA XYZ EMBALAGEM 500G`
    : `Produto Teste ${i}`;
  return {
    codigo: String(1000 + i),
    nome,
    quantidade: i % 3 === 0 ? 2 : 1,
    unidade: "UN",
    precoUnitario: 10 + i * 0.5,
    total: (i % 3 === 0 ? 2 : 1) * (10 + i * 0.5),
  };
}

function payloadCupom12(n, opts = {}) {
  const itens = Array.from({ length: n }, (_, i) => item(i + 1, opts.long));
  const subtotal = itens.reduce((s, x) => s + x.total, 0);
  const desconto = opts.desconto || 0;
  const total = Math.max(0, subtotal - desconto);
  const pags = opts.pagamentos || [{ forma: "DINHEIRO", valor: total }];
  return {
    empresa: {
      razaoSocial: opts.razaoSocial || "LOJA DEMO LTDA",
      nomeFantasia: opts.nomeFantasia || "LOJA DEMO",
      cnpj: "12.345.678/0001-99",
      ie: "123456789",
      endereco: "RUA EXEMPLO, 100",
      cidade: "SAO PAULO",
      uf: "SP",
      cep: "01001-000",
    },
    operador: "CAIXA 01",
    numeroVenda: "PDV123456",
    emitidoEm: "2026-10-13T18:00:00-03:00",
    itens,
    subtotal,
    desconto,
    total,
    pagamentos: pags,
    valorRecebido: total,
    troco: 0,
    cupomLayoutPerfil: opts.perfil || "PADRAO",
    ...(opts.fiscal
      ? {
          chaveNfe: CHAVE65,
          numeroNfe: "123",
          serieNfe: "1",
          protocolo: "135260000012345",
          dataAutorizacao: "2026-10-13T18:00:05-03:00",
          qrcodeNfe:
            "https://www.nfce.fazenda.sp.gov.br/qrcode?p=" +
            CHAVE65 +
            "|2|1|1|HASH",
          cpfCliente: opts.consumidor && opts.consumidor.cpf,
          nomeCliente: opts.consumidor && opts.consumidor.nome,
        }
      : { naoFiscal: true, cupomSemFiscal: true }),
  };
}

/** Instala stub de printerLocalConfig (cols + perfil) e limpa cache dos módulos de layout. */
function stubPrinterCols(cols, perfil = "PADRAO") {
  const cfgPath = require.resolve("../../print/printerLocalConfig");
  require.cache[cfgPath] = {
    id: cfgPath,
    filename: cfgPath,
    loaded: true,
    exports: {
      ler: () => ({
        colunas: cols,
        paperMm: cols <= 32 ? 58 : 80,
        cupomLayoutPerfil: perfil,
        modelo: "1",
        porta: "RAW:POSPrinter POS80",
        pageCode: "5",
      }),
      salvar: () => ({}),
      lerCupomLayoutPerfil: () => perfil,
    },
  };
  for (const k of Object.keys(require.cache)) {
    if (
      k.includes("/print/thermalCols") ||
      k.includes("/print/cupomAcbrTags") ||
      k.includes("/print/cupomLayoutShared") ||
      k.includes("/print/cupomLayoutProfile") ||
      k.includes("/print/cupomLayoutMetrics") ||
      k.includes("/print/acbrTags") ||
      k.includes("/print/cupomContraste") ||
      k.includes("/print/empresaCabecalhoTermico") ||
      k.includes("/documentosFiscais") ||
      k.includes("/fiscalIbpt")
    ) {
      delete require.cache[k];
    }
  }
}

module.exports = {
  CHAVE65,
  payloadCupom12,
  stubPrinterCols,
};

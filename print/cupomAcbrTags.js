/**
 * Renderiza cupom PDV em tags ACBr PosPrinter.
 * Paridade visual com print/escpos/impressoraCore.js — QR sempre via tag ACBr.
 */
const { toThermalText, toThermalDoc } = require("../thermalText");
const { normalizarCupomPayload, resolverQrCodeNfce } = require("./cupomValidate");
const { isNfeModelo55 } = require("../documentosFiscais");
const {
  tagQrCode,
  tagBarcode,
  tagLogoHeader,
  tagSegundaViaBanner,
  tagCorte,
  tagBarcodesList,
} = require("./acbrTags");

const COLS = 48;

const LABEL_PGTO = {
  dinheiro: "DINHEIRO",
  pix: "PIX",
  debito: "CARTAO DEBITO",
  credito: "CARTAO CREDITO",
  fiado: "FIADO",
  voucher: "VOUCHER",
};

function padR(txt, len) {
  return String(txt).slice(0, len).padEnd(len);
}
function padL(txt, len) {
  return String(txt).slice(0, len).padStart(len);
}
function col2(esq, dir) {
  const e = String(esq);
  const d = String(dir);
  const esp = Math.max(1, COLS - e.length - d.length);
  return e + " ".repeat(esp) + d;
}
function sepEq() {
  return "=".repeat(COLS);
}
function sepDash() {
  return "-".repeat(COLS);
}
function fmtR$(v) {
  return (
    "R$ " +
    Number(v || 0).toLocaleString("pt-BR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}
function tx(v) {
  return toThermalText(v);
}

function formatarLinhaEndereco(empresa) {
  const e = empresa || {};
  const log = (e.logradouro || "").trim();
  if (log) {
    return tx([log, e.numero, e.bairro].filter(Boolean).join(", "));
  }
  return e.endereco ? tx(String(e.endereco)) : "";
}

function formatarChave(chave) {
  const d = String(chave || "").replace(/\D/g, "");
  if (d.length !== 44) return [d];
  const parts = [];
  for (let i = 0; i < 44; i += 4) parts.push(d.slice(i, i + 4));
  return parts;
}

function renderBarcodesPayload(payload) {
  const out = [];
  if (payload.ean13) {
    const bc = tagBarcode("EAN13", String(payload.ean13).replace(/\D/g, ""));
    if (bc) out.push(bc);
  }
  if (payload.ean8) {
    const bc = tagBarcode("EAN8", String(payload.ean8).replace(/\D/g, ""));
    if (bc) out.push(bc);
  }
  if (payload.code128) {
    const bc = tagBarcode("CODE128", payload.code128);
    if (bc) out.push(bc);
  }
  if (payload.pdf417) {
    const bc = tagBarcode("PDF417", payload.pdf417);
    if (bc) out.push(bc);
  }
  out.push(...tagBarcodesList(payload.barcodes));
  return out;
}

/**
 * @param {object} rawPayload
 * @returns {string}
 */
function renderCupomTags(rawPayload) {
  const payload = normalizarCupomPayload(rawPayload);
  const empresa = payload.empresa || {};
  const itens = payload.itens || [];
  const isFiscal = !!(payload.chaveNfe && String(payload.chaveNfe).trim());
  const isOffline = payload.origem === "offline" || payload.origem === "local";
  const lines = [];

  lines.push("</zera>");
  const logoHdr = tagLogoHeader();
  if (logoHdr) lines.push(logoHdr);
  if (payload.segundaVia || payload.reimpressao) lines.push(tagSegundaViaBanner());
  lines.push("<ce>");
  lines.push(
    `<n>${tx((empresa.nomeFantasia || empresa.razaoSocial || "ESTABELECIMENTO").toUpperCase())}</n>`,
  );
  if (empresa.razaoSocial && empresa.razaoSocial !== empresa.nomeFantasia) {
    lines.push(tx(empresa.razaoSocial));
  }
  if (empresa.cnpj) lines.push(`CNPJ: ${toThermalDoc(empresa.cnpj)}`);
  const end = formatarLinhaEndereco(empresa);
  if (end) lines.push(end.slice(0, COLS));
  if (empresa.cidade) {
    lines.push(tx(`${empresa.cidade}${empresa.uf ? " - " + empresa.uf : ""}`).slice(0, COLS));
  }
  if (empresa.telefone) lines.push(`Tel: ${toThermalDoc(empresa.telefone)}`);
  lines.push("</ce>");
  lines.push("</linha_dupla>");

  lines.push(`<ce><n>${isFiscal ? "CUPOM FISCAL NFC-e" : "CUPOM NAO FISCAL"}</n></ce>`);
  if (isOffline) lines.push("<ce>*** MODO OFFLINE ***</ce>");
  lines.push(sepEq());

  const dt = new Date(payload.emitidoEm || Date.now());
  lines.push(col2("Nro:", payload.numeroVenda || ""));
  lines.push(col2("Data:", `${dt.toLocaleDateString("pt-BR")} ${dt.toLocaleTimeString("pt-BR")}`));
  if (payload.operador) lines.push(col2("Operador:", tx(payload.operador)));
  if (payload.nomeCliente && payload.nomeCliente !== "Consumidor") {
    lines.push(col2("Cliente:", tx(payload.nomeCliente).slice(0, 28)));
  }
  if (payload.cpfCliente) lines.push(col2("CPF:", toThermalDoc(payload.cpfCliente)));
  if (payload.cnpjCliente) lines.push(col2("CNPJ:", toThermalDoc(payload.cnpjCliente)));

  lines.push(sepDash());
  lines.push(padR("DESCRICAO", 26) + padL("UNIT", 8) + padL("TOTAL", 8));
  lines.push(sepDash());

  itens.forEach((item, idx) => {
    const num = String(idx + 1).padStart(2, "0");
    const nome = tx(String(item.nome || "")).slice(0, 24);
    const total = item.total ?? Number(item.precoUnitario) * Number(item.quantidade);
    const valUnit = Number(item.precoUnitario).toLocaleString("pt-BR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const valTotal = Number(total).toLocaleString("pt-BR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    lines.push(num + " " + padR(nome, 23) + padL(valUnit, 9) + padL(valTotal, 9));
    if (item.porPeso) {
      const kg = Number(item.quantidade).toLocaleString("pt-BR", {
        minimumFractionDigits: 3,
        maximumFractionDigits: 3,
      });
      lines.push(`   ${kg} kg x ${fmtR$(item.precoUnitario)}/kg`);
    } else if (Number(item.quantidade) > 1) {
      lines.push(`   ${item.quantidade} un x ${fmtR$(item.precoUnitario)}`);
    }
  });

  const desconto = Number(payload.desconto || 0);
  const totalFinal = Number(payload.total || 0);
  const subtotal = totalFinal + desconto;
  const pagamentos =
    Array.isArray(payload.pagamentos) && payload.pagamentos.length > 0
      ? payload.pagamentos
      : [
          {
            forma: payload.formaPagamento || "dinheiro",
            valor: Number(payload.valorRecebido || 0) > 0 ? Number(payload.valorRecebido) : totalFinal,
            troco: Number(payload.troco || 0),
            pixCopiaCola: payload.pixCopiaCola,
          },
        ];
  const valorRecebido = Number(
    payload.valorRecebido ||
      pagamentos.reduce((s, pg) => s + Number(pg.valor || 0), 0),
  );
  let troco = Number(payload.troco ?? 0);
  if (!troco) {
    troco = pagamentos.reduce((s, pg) => s + Number(pg.troco || 0), 0);
  }
  if (!troco && valorRecebido > totalFinal) {
    troco = valorRecebido - totalFinal;
  }

  lines.push(sepDash());
  if (desconto > 0) {
    lines.push(col2("Subtotal:", fmtR$(subtotal)));
    lines.push(`<n>${col2("Desconto:", "- " + fmtR$(desconto))}</n>`);
  }
  lines.push(sepEq());
  lines.push(`<ce><n>TOTAL: ${fmtR$(totalFinal)}</n></ce>`);
  lines.push(sepEq());

  for (const pg of pagamentos) {
    const label = LABEL_PGTO[pg.forma] || String(pg.forma || "").toUpperCase();
    const aplicado = Number(pg.valor || 0) - Number(pg.troco || 0);
    if (label) lines.push(col2("Pagamento:", `${label} ${fmtR$(aplicado)}`));
    if (pg.forma === "pix" && pg.pixCopiaCola) {
      lines.push("</linha_simples>");
      lines.push("<ce>PIX Copia e Cola</ce>");
      lines.push(tagQrCode(String(pg.pixCopiaCola)));
    }
  }

  if (troco > 0) {
    lines.push(col2("Recebido:", fmtR$(valorRecebido)));
    lines.push(sepDash());
    lines.push(`<ce><n>TROCO: ${fmtR$(troco)}</n></ce>`);
    lines.push(sepDash());
  }

  const totalVols = itens.reduce((s, i) => s + Number(i.quantidade || 0), 0);
  lines.push(col2("Volumes:", `${Math.round(totalVols)} item(ns)`));

  if (isFiscal) {
    lines.push(sepDash());
    const titulo = isNfeModelo55(payload.chaveNfe) ? "DOCUMENTO FISCAL NF-e" : "DOCUMENTO FISCAL NFC-e";
    lines.push(`<ce><n>${titulo}</n></ce>`);
    if (payload.numeroNfe) {
      lines.push(`NF-e: ${payload.numeroNfe}  Serie: ${payload.serieNfe || "1"}`);
    }
    if (payload.protocolo) lines.push(`Protocolo: ${String(payload.protocolo).slice(0, 30)}`);
    lines.push("Chave de acesso:");
    formatarChave(payload.chaveNfe).forEach((g) => lines.push(g));

    const qr = resolverQrCodeNfce(payload);
    if (qr) {
      lines.push("</linha_simples>");
      lines.push("<ce>Consulta NFC-e — QR Code</ce>");
      lines.push(tagQrCode(qr));
    }
    renderBarcodesPayload(payload).forEach((bc) => lines.push(bc));
    lines.push("Consulte pela chave ou QR Code");
  } else {
    const extras = renderBarcodesPayload(payload);
    if (extras.length) {
      lines.push(sepDash());
      extras.forEach((bc) => lines.push(bc));
    }
  }

  lines.push("</linha_simples>");
  lines.push("<ce>Obrigado pela preferencia!</ce>");
  lines.push("<ce>Volte sempre!</ce>");
  lines.push("<ce>PDV Margin Engine</ce>");

  lines.push(tagCorte());

  return lines.join("\n") + "\n";
}

function renderPaginaTeste() {
  const cfg = require("./printerLocalConfig").ler();
  const logo = require("./printerLogo").ler();
  const logoLine = logo.ativo ? "Logo: configurado (BMP)" : "Logo: nao configurado";
  let versao = "1.0.0";
  try {
    versao = require("../../package.json").version || versao;
  } catch (_) {}
  const factory = require("./factory");
  const driver = factory.getDriverInfo?.() || {};
  return `</zera>
</linha_dupla>
${tagLogoHeader()}<ce><n>TESTE IMPRESSORA</n></ce>
<ce>Margin Engine v${versao}</ce>
</linha_simples>
Driver: ${driver.label || driver.provider || "PosPrinter"}
Modelo: ${cfg.modelo}
Porta: ${cfg.porta}
Largura: ${cfg.colunas || 48} colunas
${logoLine}
</linha_simples>
Texto — Ç Ã Á É Ê Ó Ú ° R$ acentuação UTF-8
<n>NEGRITO</n>  <e>EXPANDIDO</e>  <c>CONDENSADO</c>
</linha_simples>
<ce>QR Code NFC-e teste</ce>
${tagQrCode("https://marginengine.com.br/teste-impressora")}
</linha_simples>
<ce>PIX Copia e Cola teste</ce>
${tagQrCode("00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-426655440000")}
</linha_simples>
<ce>Codigos de barras</ce>
${tagBarcode("EAN13", "7894900011517") || ""}
${tagBarcode("EAN8", "96385074") || ""}
${tagBarcode("CODE128", "MARGIN-TESTE-128") || ""}
</linha_simples>
<ce>Gaveta + corte parcial abaixo</ce>
${tagCorte("partial")}
`;
}

module.exports = {
  renderCupomTags,
  renderPaginaTeste,
  renderBarcodesPayload,
  tagQrCode,
  COLS,
};

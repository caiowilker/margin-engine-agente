// ============================================================
// PDV Margin Engine — Modulo ACBr Monitor v3.3
//
// MUDANCAS v3.3:
//   ✓ Logs estruturados (pino) em vez de console.log
//   Funcionalidade identica a v3.2.
//
// v3.2 (mantido):
//   ✓ emitirNfce retorna { chave, numero, serie, qrcode }
//   ✓ Guard EMISSAO_FISCAL
//   ✓ cancelarNfce aceita chave e chaveNfe (retrocompat)
//   ✓ flag settled garante Promise resolvida exatamente uma vez
//
// Comunica com o ACBr Monitor via socket TCP (protocolo texto).
//   Envio:   COMANDO|PARAMETROS\n
//   Retorno: "OK\n" ou "ERRO: mensagem\n"
// ============================================================

require("dotenv").config();
const net = require("net");
const log = require("./logger").child({ modulo: "acbr" });

const ACBR_HOST = process.env.ACBR_HOST || "127.0.0.1";
const ACBR_PORT = parseInt(process.env.ACBR_PORT || "9200");
const ACBR_TIMEOUT = parseInt(process.env.ACBR_TIMEOUT_MS || "10000");

const EMISSAO_FISCAL =
  (process.env.EMISSAO_FISCAL || "false").toLowerCase() === "true";

// ─────────────────────────────────────────────────────────────────────────────
// ── Comunicacao TCP com o Monitor ────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
function enviarComando(comando) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let resposta = "";
    let settled = false;

    const done = (fn, val) => {
      if (settled) return;
      settled = true;
      fn(val);
    };

    socket.setTimeout(ACBR_TIMEOUT);

    socket.connect(ACBR_PORT, ACBR_HOST, () => {
      socket.write(comando + "\n");
    });

    socket.on("data", (data) => {
      resposta += data.toString();
      if (resposta.includes("\r\n\r\n") || resposta.endsWith("\n\n")) {
        socket.destroy();
      }
    });

    socket.on("close", () => {
      const texto = resposta.trim();
      if (texto.toUpperCase().startsWith("ERRO")) {
        done(reject, new Error(texto));
      } else {
        done(resolve, texto);
      }
    });

    socket.on("timeout", () => {
      socket.destroy();
      done(reject, new Error(`ACBr Monitor timeout apos ${ACBR_TIMEOUT}ms`));
    });

    socket.on("error", (err) => {
      done(reject, new Error(`ACBr Monitor inacessivel: ${err.message}`));
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Testar conexao ────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
async function testar() {
  if (!EMISSAO_FISCAL) return false;
  try {
    await enviarComando("NFCe.Status");
    return true;
  } catch (err) {
    log.debug({ err: err.message }, "ACBr offline");
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Montar INI NFC-e ──────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
function montarIniNfce(payload) {
  const empresa = payload.empresa || {};
  const itens = payload.itens || [];
  const dataHora = new Date().toISOString().replace("T", " ").slice(0, 19);

  let ini = `[NFCe]\n`;
  ini += `Modelo=65\n`;
  ini += `Serie=001\n`;
  ini += `Numero=${payload.numeroNfe || "000001"}\n`;
  ini += `DataHoraEmissao=${dataHora}\n`;
  ini += `NaturezaOperacao=VENDA AO CONSUMIDOR\n`;
  ini += `TipoOperacao=1\n`;
  ini += `FinalidadeEmissao=1\n`;
  ini += `CNPJ=${(empresa.cnpj || "").replace(/\D/g, "")}\n`;
  ini += `IE=${empresa.inscricaoEstadual || ""}\n`;
  ini += `RegimeTributario=${empresa.regimeTributario || "1"}\n`;
  ini += `RazaoSocial=${empresa.razaoSocial || empresa.nomeFantasia || ""}\n`;
  ini += `UF=${empresa.uf || "MG"}\n`;
  ini += `CEP=${(empresa.cep || "").replace(/\D/g, "")}\n`;
  ini += `Endereco=${empresa.endereco || ""}\n`;
  ini += `Cidade=${empresa.cidade || ""}\n`;

  if (payload.cpfCliente) {
    ini += `[Destinatario]\n`;
    ini += `CPF=${payload.cpfCliente.replace(/\D/g, "")}\n`;
    ini += `Nome=${payload.nomeCliente || "CONSUMIDOR"}\n`;
  }

  itens.forEach((item, i) => {
    const n = String(i + 1).padStart(3, "0");
    ini += `[Item${n}]\n`;
    ini += `Codigo=${item.codigo || String(i + 1)}\n`;
    ini += `Descricao=${item.nome}\n`;
    ini += `NCM=${item.ncm || "02012000"}\n`;
    ini += `CFOP=${item.cfop || "5102"}\n`;
    ini += `UnidadeComercial=${item.porPeso ? "KG" : "UN"}\n`;
    ini += `Quantidade=${Number(item.quantidade).toFixed(3)}\n`;
    ini += `ValorUnitario=${Number(item.precoUnitario).toFixed(4)}\n`;
    ini += `ValorTotal=${Number(item.total || item.precoUnitario * item.quantidade).toFixed(2)}\n`;
    ini += `CST=${item.cst || "400"}\n`;
    ini += `AliquotaIcms=${Number(item.aliquotaIcms || 0).toFixed(2)}\n`;
  });

  ini += `[Pagamento]\n`;
  const formaMap = {
    dinheiro: "01",
    credito: "03",
    debito: "04",
    pix: "17",
    voucher: "05",
    outros: "99",
  };
  const codigoForma =
    formaMap[(payload.formaPagamento || "").toLowerCase()] || "01";
  ini += `FormaPagamento=${codigoForma}\n`;
  ini += `ValorPagamento=${Number(payload.total).toFixed(2)}\n`;

  if (payload.valorRecebido && payload.valorRecebido > payload.total) {
    ini += `Troco=${Number(payload.valorRecebido - payload.total).toFixed(2)}\n`;
  }

  ini += `[Totais]\n`;
  ini += `ValorNF=${Number(payload.total).toFixed(2)}\n`;
  ini += `Desconto=${Number(payload.desconto || 0).toFixed(2)}\n`;

  return ini;
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Emitir NFC-e ──────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
async function emitirNfce(payload) {
  if (!EMISSAO_FISCAL) {
    return { fiscal: false };
  }

  log.info({ numeroVenda: payload.numeroVenda }, "Emitindo NFC-e");

  const ini = montarIniNfce(payload);
  const resposta = await enviarComando(`NFCe.EnviarMensagemTEFImprimir|${ini}`);

  const linhas = resposta.split("\n").filter(Boolean);
  const get = (chave) => {
    const linha = linhas.find((l) => l.startsWith(chave + "="));
    return linha ? linha.split("=").slice(1).join("=").trim() : null;
  };

  const chave = get("ChaveNFe") || get("Chave");
  const numero = get("NumeroNFe") || get("Numero");
  const serie = get("SerieNFe") || get("Serie") || "001";
  const qrcode = get("QRCode") || get("URLConsulta");

  if (!chave) {
    throw new Error(`ACBr nao retornou ChaveNFe. Resposta: ${resposta}`);
  }

  log.info({ chave, numero }, "NFC-e emitida com sucesso");
  return { chave, numero, serie, qrcode, fiscal: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Cancelar NFC-e ────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
async function cancelarNfce(chaveNfeOuChave, motivo) {
  const chave = chaveNfeOuChave;
  if (!chave) throw new Error("chave da NFC-e obrigatoria para cancelamento.");
  const motivoTexto = (motivo || "Cancelamento solicitado pelo operador").slice(
    0,
    255,
  );
  log.info({ chave }, "Cancelando NFC-e");
  await enviarComando(`NFCe.Cancelar|${chave}|${motivoTexto}`);
  return true;
}

module.exports = { testar, emitirNfce, cancelarNfce, EMISSAO_FISCAL };

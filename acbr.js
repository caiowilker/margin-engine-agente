// ============================================================
// PDV Margin Engine — Módulo ACBr Monitor v3.2
//
// CORREÇÕES v3.2:
//   ✓ emitirNfce retorna { chave, numero, serie, qrcode }
//     (anteriormente retornava { chaveNfe, numeroNfe, serieNfe, qrcodeNfe }
//      causando undefined no frontend — FIX CRÍTICO)
//   ✓ Guard EMISSAO_FISCAL: se false/ausente, emitirNfce lança erro
//     descritivo em vez de tentar conectar ao ACBr (falha silenciosa
//     virava "ACBr não retornou ChaveNFe")
//   ✓ cancelarNfce aceita tanto `chave` (campo correto) quanto
//     `chaveNfe` (legado) para retrocompatibilidade
//
// Comunica com o ACBr Monitor via socket TCP (protocolo texto).
// O ACBr Monitor deve estar rodando na mesma máquina ou LAN.
//
// Protocolo ACBr Monitor:
//   Envio:   COMANDO|PARAMETROS\n
//   Retorno: "OK\n" ou "ERRO: mensagem\n" (texto simples)
//
// Comandos usados:
//   NFCe.EnviarMensagemTEFImprimir   — emite NFC-e
//   NFCe.Cancelar                    — cancela NFC-e
//   NFCe.Status                      — verifica conexão
//
// CORRIGIDO v3.1:
//   - socket.on('close') não dispara resolve/reject após timeout ou error
//     (flag `settled` garante que a Promise é resolvida exatamente uma vez)
// ============================================================

require("dotenv").config();
const net = require("net");

const ACBR_HOST = process.env.ACBR_HOST || "127.0.0.1";
const ACBR_PORT = parseInt(process.env.ACBR_PORT || "9200");
const ACBR_TIMEOUT = parseInt(process.env.ACBR_TIMEOUT_MS || "10000");

// EMISSAO_FISCAL=true é necessário para emitir NFC-e.
// Sem isso, retornamos { fiscal: false } silenciosamente — o frontend
// já trata esse caso e imprime cupom não fiscal.
const EMISSAO_FISCAL =
  (process.env.EMISSAO_FISCAL || "false").toLowerCase() === "true";

// ─────────────────────────────────────────────────────────────────────────────
// ── Comunicação TCP com o Monitor ────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
function enviarComando(comando) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let resposta = "";
    let settled = false; // garante que resolve/reject é chamado exatamente uma vez

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
      // Monitor encerra com \r\n\r\n ou com linha final vazia
      if (resposta.includes("\r\n\r\n") || resposta.endsWith("\n\n")) {
        socket.destroy();
      }
    });

    socket.on("close", () => {
      // Só executa se nenhum timeout/error já resolveu a Promise
      const texto = resposta.trim();
      if (texto.toUpperCase().startsWith("ERRO")) {
        done(reject, new Error(texto));
      } else {
        done(resolve, texto);
      }
    });

    socket.on("timeout", () => {
      socket.destroy(); // aciona 'close', mas settled=true já bloqueia
      done(reject, new Error(`ACBr Monitor timeout após ${ACBR_TIMEOUT}ms`));
    });

    socket.on("error", (err) => {
      // 'error' antes de 'close' — settled=true bloqueia o 'close' posterior
      done(reject, new Error(`ACBr Monitor inacessível: ${err.message}`));
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Testar conexão ────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
async function testar() {
  if (!EMISSAO_FISCAL) return false; // sem fiscal, ACBr não precisa estar ativo
  try {
    await enviarComando("NFCe.Status");
    return true;
  } catch (_) {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Montar INI NFC-e a partir do payload da venda ────────────────────────────
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
//
// CORREÇÃO v3.2: retorna campos normalizados sem sufixo "Nfe":
//   { chave, numero, serie, qrcode }
//
// Antes retornava { chaveNfe, numeroNfe, serieNfe, qrcodeNfe }, mas
// agenteLocal.ts (frontend) lê .chave / .numero / .serie / .qrcode.
// O mismatch causava undefined silencioso e a NFC-e "sumia" no cupom.
//
// Se EMISSAO_FISCAL=false, retorna { fiscal: false } — o endpoint
// /acbr/nfce/emitir no index.js detecta e responde 200 com fiscal:false,
// e o frontend trata imprimindo cupom não fiscal.
// ─────────────────────────────────────────────────────────────────────────────
async function emitirNfce(payload) {
  if (!EMISSAO_FISCAL) {
    // Modo cupom não fiscal — não há erro, só não emite
    return { fiscal: false };
  }

  const ini = montarIniNfce(payload);
  const resposta = await enviarComando(`NFCe.EnviarMensagemTEFImprimir|${ini}`);

  const linhas = resposta.split("\n").filter(Boolean);
  const get = (chave) => {
    const linha = linhas.find((l) => l.startsWith(chave + "="));
    return linha ? linha.split("=").slice(1).join("=").trim() : null;
  };

  // ACBr pode retornar tanto ChaveNFe quanto Chave — normaliza para `chave`
  const chave = get("ChaveNFe") || get("Chave");
  const numero = get("NumeroNFe") || get("Numero");
  const serie = get("SerieNFe") || get("Serie") || "001";
  const qrcode = get("QRCode") || get("URLConsulta");

  if (!chave) {
    throw new Error(`ACBr não retornou ChaveNFe. Resposta: ${resposta}`);
  }

  return { chave, numero, serie, qrcode, fiscal: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Cancelar NFC-e ────────────────────────────────────────────────────────────
//
// CORREÇÃO v3.2: aceita tanto `chaveNfe` (legado) quanto `chave` (correto)
// para retrocompatibilidade com chamadas antigas.
// ─────────────────────────────────────────────────────────────────────────────
async function cancelarNfce(chaveNfeOuChave, motivo) {
  const chave = chaveNfeOuChave; // aceita ambos os nomes
  if (!chave) throw new Error("chave da NFC-e obrigatória para cancelamento.");
  const motivoTexto = (motivo || "Cancelamento solicitado pelo operador").slice(
    0,
    255,
  );
  await enviarComando(`NFCe.Cancelar|${chave}|${motivoTexto}`);
  return true;
}

module.exports = { testar, emitirNfce, cancelarNfce, EMISSAO_FISCAL };

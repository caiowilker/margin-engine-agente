// PDV Margin Engine — Módulo ACBr Monitor (mutex global + consultas fiscais)
require("dotenv").config();
const net = require("net");

const ACBR_HOST = process.env.ACBR_HOST || "127.0.0.1";
const ACBR_PORT = parseInt(process.env.ACBR_PORT || "9200");
const ACBR_TIMEOUT = parseInt(process.env.ACBR_TIMEOUT_MS || "10000");
const ACBR_TIMEOUT_EMISSAO = parseInt(
  process.env.ACBR_TIMEOUT_EMISSAO_MS || "120000",
);
const EMISSAO_FISCAL =
  (process.env.EMISSAO_FISCAL || "false").toLowerCase() === "true";
const { PATHS } = require("./marginPaths");
const path = require("path");
const fs = require("fs");

let acbrLock = Promise.resolve();

function withAcbrLock(fn, label = "acbr") {
  const run = acbrLock.then(() => fn());
  acbrLock = run.catch(() => {});
  return run;
}

function enviarComandoRaw(comando, timeoutMs = ACBR_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let resposta = "";
    let settled = false;

    const done = (fn, val) => {
      if (settled) return;
      settled = true;
      fn(val);
    };

    socket.setTimeout(timeoutMs);
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
      const err = new Error(`ACBr Monitor timeout após ${timeoutMs}ms`);
      err.incerto = true;
      const chaveParcial =
        resposta.match(/ChaveNFe=(\d{44})/i)?.[1] ||
        resposta.match(/Chave=(\d{44})/i)?.[1];
      if (chaveParcial) err.chaveConsulta = chaveParcial;
      done(reject, err);
    });
    socket.on("error", (err) => {
      const e = new Error(`ACBr Monitor inacessível: ${err.message}`);
      e.incerto = true;
      done(reject, e);
    });
  });
}

function enviarComando(comando, timeoutMs) {
  return withAcbrLock(
    () => enviarComandoRaw(comando, timeoutMs),
    comando.split("|")[0],
  );
}

function parseResposta(resposta) {
  const linhas = resposta.split("\n").filter(Boolean);
  const get = (chave) => {
    const linha = linhas.find((l) => l.startsWith(chave + "="));
    return linha ? linha.split("=").slice(1).join("=").trim() : null;
  };
  return {
    raw: resposta,
    cStat: get("cStat") || get("CStat"),
    xMotivo: get("xMotivo") || get("XMotivo"),
    chave: get("ChaveNFe") || get("Chave"),
    numero: get("NumeroNFe") || get("Numero"),
    serie: get("SerieNFe") || get("Serie"),
    qrcode: get("QRCode") || get("URLConsulta"),
    protocolo: get("nProt") || get("Protocolo"),
    pathPdf: get("PathPDF") || get("ArquivoPDF") || get("PDF"),
  };
}

async function testar() {
  if (!EMISSAO_FISCAL) return false;
  try {
    await enviarComando("NFCe.Status");
    return true;
  } catch (_) {
    return false;
  }
}

async function statusServico() {
  const resposta = await enviarComando("NFCe.StatusServico");
  const p = parseResposta(resposta);
  return {
    operacional: !resposta.toUpperCase().startsWith("ERRO"),
    cStat: p.cStat,
    xMotivo: p.xMotivo,
    raw: resposta,
  };
}

async function consultarChave(chave) {
  if (!chave || String(chave).length !== 44) {
    throw new Error("Chave NFC-e deve ter 44 dígitos.");
  }
  const resposta = await enviarComando(`NFCe.Consultar|${chave}`);
  const p = parseResposta(resposta);
  return {
    chave,
    cStat: p.cStat,
    xMotivo: p.xMotivo,
    protocolo: p.protocolo,
    situacao: inferirSituacao(p.cStat, resposta),
    raw: resposta,
  };
}

function inferirSituacao(cStat, raw) {
  const t = (raw || "").toUpperCase();
  if (t.includes("CANCEL")) return "CANCELADA";
  if (cStat === "100" || t.includes("AUTORIZ")) return "AUTORIZADA";
  if (cStat === "101") return "CANCELADA";
  if (cStat === "110") return "DENEGADA";
  if (cStat && cStat.startsWith("2")) return "REJEITADA";
  return "DESCONHECIDA";
}

function montarIniNfce(payload) {
  const empresa = payload.empresa || {};
  const itens = payload.itens || [];
  const dataHora = new Date().toISOString().replace("T", " ").slice(0, 19);

  let ini = `[NFCe]\n`;
  ini += `Modelo=65\n`;
  ini += `Versao=4.00\n`;
  ini += `Serie=${payload.serieNfe || "001"}\n`;
  ini += `Numero=${payload.numeroNfe || "000001"}\n`;
  ini += `DataHoraEmissao=${dataHora}\n`;
  ini += `NaturezaOperacao=VENDA AO CONSUMIDOR\n`;
  ini += `TipoOperacao=1\n`;
  ini += `FinalidadeEmissao=1\n`;
  ini += `CNPJ=${(empresa.cnpj || "").replace(/\D/g, "")}\n`;
  ini += `IE=${empresa.inscricaoEstadual || ""}\n`;
  ini += `RegimeTributario=${empresa.regimeTributario || empresa.regimeTributarioCodigo || "1"}\n`;
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

async function emitirNfce(payload) {
  if (!EMISSAO_FISCAL) return { fiscal: false };

  if (payload?.xml || payload?.xmlEpec || payload?.modoEpec) {
    const xml = payload.xml || payload.xmlEpec;
    if (!xml) throw new Error("XML EPEC ausente para retransmissao.");
    const resposta = await enviarComando(`NFCe.EnviarEPEC|${xml}`);
    const p = parseResposta(resposta);
    if (!p.chave) {
      throw new Error(`ACBr EPEC nao retornou chave. Resposta: ${resposta}`);
    }
    return normalizarResultado(p, resposta);
  }

  const ini = montarIniNfce(payload);
  const resposta = await enviarComando(
    `NFCe.EnviarMensagemTEFImprimir|${ini}`,
    ACBR_TIMEOUT_EMISSAO,
  );
  const p = parseResposta(resposta);
  if (!p.chave) {
    const err = new Error(`ACBr não retornou ChaveNFe. Resposta: ${resposta}`);
    if (resposta.includes("539")) err.permanente = true;
    throw err;
  }
  return normalizarResultado(p, resposta);
}

function normalizarResultado(p, resposta) {
  return {
    chave: p.chave,
    numero: p.numero,
    serie: p.serie || "001",
    qrcode: p.qrcode,
    protocolo: p.protocolo,
    cStat: p.cStat,
    xMotivo: p.xMotivo,
    xml: require("./documentosFiscais").extrairXmlDaResposta(resposta),
    fiscal: true,
    chaveNfe: p.chave,
    numeroNfe: p.numero,
    serieNfe: p.serie || "001",
    qrcodeNfe: p.qrcode,
  };
}

async function cancelarNfce(chaveNfeOuChave, motivo) {
  const chave = chaveNfeOuChave;
  if (!chave) throw new Error("chave da NFC-e obrigatória para cancelamento.");
  const motivoTexto = (motivo || "Cancelamento solicitado pelo operador").slice(
    0,
    255,
  );
  const resposta = await enviarComando(`NFCe.Cancelar|${chave}|${motivoTexto}`);
  const p = parseResposta(resposta);
  return {
    ok: true,
    protocolo: p.protocolo,
    cStat: p.cStat,
    xml: require("./documentosFiscais").extrairXmlDaResposta(resposta),
    raw: resposta,
  };
}

async function inutilizarNfce(params) {
  const {
    ano,
    cnpj,
    modelo = "65",
    serie,
    numeroInicial,
    numeroFinal,
    motivo,
  } = params;
  const motivoTexto = (motivo || "Inutilizacao solicitada").slice(0, 255);
  const cmd = `NFCe.Inutilizar|${ano}|${String(cnpj).replace(/\D/g, "")}|${modelo}|${serie}|${numeroInicial}|${numeroFinal}|${motivoTexto}`;
  const resposta = await enviarComando(cmd);
  const p = parseResposta(resposta);
  return {
    ok: true,
    protocolo: p.protocolo,
    cStat: p.cStat,
    xMotivo: p.xMotivo,
    xml: require("./documentosFiscais").extrairXmlDaResposta(resposta),
    raw: resposta,
  };
}

async function gerarPdfDanfce(chave, xmlPath) {
  const destino = path.join(PATHS.pdf, `${chave}-danfce.pdf`);
  const comandos = [
    `NFCe.SalvarPDF|${chave}|${destino}`,
    `NFCe.ImprimirPDF|${chave}|${destino}`,
    xmlPath ? `NFCe.ImprimirPDF|${xmlPath}|${destino}` : null,
    `NFCe.ImprimirDANFCE|${chave}`,
  ].filter(Boolean);

  for (const cmd of comandos) {
    try {
      const resposta = await enviarComando(cmd, ACBR_TIMEOUT_EMISSAO);
      const p = parseResposta(resposta);
      const candidato =
        (p.pathPdf && fs.existsSync(p.pathPdf) && p.pathPdf) ||
        (fs.existsSync(destino) && destino);
      if (candidato && fs.statSync(candidato).size > 128) {
        if (candidato !== destino) fs.copyFileSync(candidato, destino);
        return destino;
      }
    } catch (_) {
      /* tenta próximo comando */
    }
  }

  for (const dir of [PATHS.saida, PATHS.pdf, PATHS.xml]) {
    if (!fs.existsSync(dir)) continue;
    const arquivos = fs.readdirSync(dir);
    const match = arquivos.find(
      (f) => f.includes(chave) && f.toLowerCase().endsWith(".pdf"),
    );
    if (match) {
      const origem = path.join(dir, match);
      fs.copyFileSync(origem, destino);
      return destino;
    }
  }

  throw new Error(
    `ACBr não gerou PDF DANFC-e para chave ${chave}. Verifique PathPDF no ACBr Monitor.`,
  );
}

async function imprimirDanfce(chave) {
  return enviarComando(`NFCe.ImprimirDANFCE|${chave}`, ACBR_TIMEOUT);
}

module.exports = {
  testar,
  statusServico,
  consultarChave,
  emitirNfce,
  cancelarNfce,
  inutilizarNfce,
  gerarPdfDanfce,
  imprimirDanfce,
  enviarComando,
  withAcbrLock,
  EMISSAO_FISCAL,
  parseResposta,
};

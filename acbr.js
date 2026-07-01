// PDV Margin Engine — Módulo ACBr Monitor (mutex global + consultas fiscais)
require("dotenv").config();
const net = require("net");
const { unidadeFiscalDoItem } = require("./unidadeFiscal");

const ACBR_HOST = process.env.ACBR_HOST || "127.0.0.1";
const ACBR_PORT = parseInt(process.env.ACBR_PORT || "9200");
const ACBR_TIMEOUT = parseInt(process.env.ACBR_TIMEOUT_MS || "10000");
const ACBR_BANNER_MS = parseInt(process.env.ACBR_BANNER_MS || "80", 10);
const ACBR_IDLE_MS = parseInt(process.env.ACBR_IDLE_MS || "180", 10);
const ACBR_TIMEOUT_EMISSAO = parseInt(
  process.env.ACBR_TIMEOUT_EMISSAO_MS || "120000",
);
/** MOC 5.2.3 — mínimo 15s entre envio assíncrono e consulta do recibo. */
const FISCAL_CONSULTA_POS_104_MS = parseInt(
  process.env.FISCAL_CONSULTA_POS_104_MS || "15000",
  10,
);
/** MOC AP03a — indSinc=1: uma NF-e por lote, resposta com protNFe (evita cStat 104). */
const FISCAL_ACBR_SINCRONO =
  (process.env.FISCAL_ACBR_SINCRONO || "true").toLowerCase() !== "false";
const EMISSAO_FISCAL_ENV =
  (process.env.EMISSAO_FISCAL || "false").toLowerCase() === "true";
/** Runtime override via configSync (Parte D); null = usar env */
let runtimeEmissaoFiscal = null;

function lerEmissaoFiscalEnv() {
  return (process.env.EMISSAO_FISCAL || "false").toLowerCase() === "true";
}

function getEmissaoFiscalAtivo() {
  if (runtimeEmissaoFiscal !== null) return runtimeEmissaoFiscal;
  return lerEmissaoFiscalEnv();
}

function setRuntimeEmissaoFiscal(valor) {
  if (valor === null || valor === undefined) {
    runtimeEmissaoFiscal = null;
    return;
  }
  runtimeEmissaoFiscal = !!valor;
}

/** NF-e modelo 55 — mesmo certificado/ambiente do NFC-e por padrão (ACBr Monitor). */
const NFE_MODELO_55_ENABLED =
  (process.env.ACBR_NFE_ENABLED || "true").toLowerCase() === "true";

function isNfeModelo55Habilitado() {
  return getEmissaoFiscalAtivo() && NFE_MODELO_55_ENABLED;
}
// Protocolo TCP do ACBr Monitor: cada comando termina com CR+LF+'.'+CR+LF
// https://acbr.sourceforge.io/ACBrMonitor/Apresentacao.html
const ACBR_TERMINADOR = "\r\n.\r\n";
const { PATHS } = require("./marginPaths");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const fiscalNumeracao = require("./fiscalNumeracao");
const fiscalDhEmiIni = require("./fiscal/fiscalDhEmiIni");
const { validarPayloadNfce } = require("./fiscalValidacao");
const { validarPayloadNfe, normalizarDestinatario } = require("./fiscalValidacaoNfe");
const {
  coalescerRespostaAcbr,
  resolverCStatFinal,
  isCStatAutorizado,
  CSTAT_LOTE_OK,
  extrairProtocoloBruto,
} = require("./acbrResposta");

let acbrLock = Promise.resolve();
/** Profundidade do mutex — >0 enquanto emissão/PDF/consulta ACBr está em andamento. */
let acbrBusyDepth = 0;
let ultimoModeloSessao = null;
let ultimoStatusMemoria = { estado: "offline", atualizadoEm: null };

function atualizarStatusMemoria(ok) {
  const anterior = ultimoStatusMemoria.estado;
  ultimoStatusMemoria = {
    estado: ok ? "online" : "offline",
    atualizadoEm: new Date().toISOString(),
  };
  try {
    const fiscalAlertas = require("./fiscalAlertas");
    fiscalAlertas.onAcbrStatusChange(ultimoStatusMemoria.estado);
  } catch (_) {}
}

function obterStatusMemoria(watchdogDegraded = false) {
  if (!getEmissaoFiscalAtivo()) return "offline";
  if (watchdogDegraded) return "degradado";
  return ultimoStatusMemoria.estado;
}

function obterStatusDetalhe(watchdogDegraded = false) {
  return {
    estado: obterStatusMemoria(watchdogDegraded),
    atualizadoEm: ultimoStatusMemoria.atualizadoEm,
  };
}

function qAcbr(valor) {
  return `"${String(valor).replace(/"/g, '""')}"`;
}

function extrairCnpjDaChave(chave) {
  const digits = String(chave).replace(/\D/g, "");
  if (digits.length !== 44) return null;
  return digits.slice(6, 20);
}

function resolverXmlChave(chave, xmlPath) {
  const docs = require("./documentosFiscais");
  const resolved = docs.resolverXmlParaImpressao(chave, xmlPath);
  if (resolved) return resolved;
  const k = String(chave || "").replace(/\D/g, "");
  return path.join(PATHS.xml, `${k}-nfe.xml`);
}

function extrairPathPdfOk(resposta) {
  const m = coalescerRespostaAcbr(resposta).match(/Arquivo criado em:\s*(.+)/i);
  return m ? m[1].trim() : null;
}

function withAcbrLock(fn, label = "acbr") {
  const run = acbrLock.then(async () => {
    acbrBusyDepth++;
    try {
      return await fn();
    } finally {
      acbrBusyDepth--;
    }
  });
  acbrLock = run.catch(() => {});
  return run;
}

function isAcbrBusy() {
  return acbrBusyDepth > 0;
}

function resolverTpAmbAcbr() {
  const amb = String(process.env.AMBIENTE_SEFAZ || "homologacao").toLowerCase();
  if (amb === "producao" || amb === "1") return "1";
  return "2";
}

function melhorarErroAcbr(err) {
  const msg = String(err?.message || "");
  if (/URL-QRCode|URL para o serviço/i.test(msg)) {
    const e = new Error(
      "ACBr rejeitou a emissão (URL-QRCode). O ACBrNFeServicos.ini no disco pode estar correto — " +
        "feche e abra o ACBr Monitor Demo para recarregar o INI. " +
        "Confirme Homologação (tpAmb 2) no Monitor, igual a AMBIENTE_SEFAZ=homologacao no agente.",
    );
    e.cStat = err.cStat;
    e.permanente = err.permanente;
    e.incerto = err.incerto;
    e.reiniciarAcbr = true;
    return e;
  }
  return err;
}

function respostaTcpCompleta(texto) {
  return texto.includes("\r\n.\r\n") || /\r\n\r\n\s*$/.test(texto);
}

const RUIDO_ACBR =
  /^(Conectado em:|Maquina:|Esperando por comandos|ACBrMonitor)/i;

function limparRespostaAcbr(texto) {
  let t = String(texto || "");
  const termIdx = t.indexOf("\r\n.\r\n");
  if (termIdx >= 0) t = t.slice(0, termIdx);
  t = t.replace(/\r\n\r\n\s*$/, "");
  return t
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !RUIDO_ACBR.test(l))
    .join("\n")
    .trim();
}

function respostaComandoPronta(buffer) {
  if (respostaTcpCompleta(buffer)) return true;
  const limpo = limparRespostaAcbr(buffer);
  if (/^ERRO:/im.test(limpo) || /\nERRO:/i.test(buffer)) return true;
  if (/^OK:/im.test(limpo)) return true;
  if (/cStat\s*[=:]\s*\d+/i.test(buffer)) return true;
  if (/CStat\s*=/i.test(buffer)) return true;
  if (/xMotivo\s*[=:]/i.test(buffer)) return true;
  // SetModeloDF costuma responder só com cabeçalho de conexão
  if (!limpo && /Maquina:\s*127/i.test(buffer)) return true;
  return false;
}

function enviarSessaoRaw(comandos, timeoutMs = ACBR_TIMEOUT) {
  const lista = Array.isArray(comandos) ? comandos : [comandos];
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let buffer = "";
    let fase = "banner";
    let cmdIdx = 0;
    const respostas = [];
    let settled = false;
    let envioAgendado = null;
    let idleTimer = null;

    const done = (fn, val) => {
      if (settled) return;
      settled = true;
      if (envioAgendado) clearTimeout(envioAgendado);
      if (idleTimer) clearTimeout(idleTimer);
      try {
        socket.destroy();
      } catch (_) {}
      fn(val);
    };

    const finalizarComando = () => {
      const texto = limparRespostaAcbr(buffer);
      if (/ERRO:/i.test(texto || buffer)) {
        done(reject, new Error(texto || buffer.trim()));
        return;
      }
      respostas.push(texto);
      buffer = "";
      enviarProximo();
    };

    const enviarProximo = () => {
      if (cmdIdx >= lista.length) {
        done(resolve, respostas.length === 1 ? respostas[0] : respostas);
        return;
      }
      fase = "aguardando";
      buffer = "";
      socket.write(lista[cmdIdx++] + ACBR_TERMINADOR);
    };

    const agendarIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (fase === "aguardando" && respostaComandoPronta(buffer)) {
          finalizarComando();
        }
      }, ACBR_IDLE_MS);
    };

    socket.setTimeout(timeoutMs);
    socket.connect(ACBR_PORT, ACBR_HOST, () => {
      envioAgendado = setTimeout(() => {
        if (fase === "banner") {
          fase = "preparado";
          enviarProximo();
        }
      }, ACBR_BANNER_MS);
    });

    socket.on("data", (data) => {
      buffer += data.toString();

      if (fase === "banner") {
        if (/ACBrMonitor/i.test(buffer) || buffer.includes("\n")) {
          if (envioAgendado) clearTimeout(envioAgendado);
          fase = "preparado";
          enviarProximo();
        }
        return;
      }

      if (fase === "aguardando") {
        if (respostaComandoPronta(buffer)) {
          if (idleTimer) clearTimeout(idleTimer);
          finalizarComando();
        } else {
          agendarIdle();
        }
      }
    });

    socket.on("close", () => {
      if (fase === "aguardando" && buffer.trim() && !settled) {
        finalizarComando();
        return;
      }
      if (!settled) {
        done(reject, new Error("ACBr Monitor encerrou a conexão sem resposta"));
      }
    });

    socket.on("timeout", () => {
      if (fase === "aguardando" && buffer.trim()) {
        finalizarComando();
        return;
      }
      const err = new Error(`ACBr Monitor timeout após ${timeoutMs}ms`);
      err.incerto = true;
      const chaveParcial =
        buffer.match(/ChaveNFe=(\d{44})/i)?.[1] ||
        buffer.match(/Chave=(\d{44})/i)?.[1];
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

function enviarComandoRaw(comando, timeoutMs = ACBR_TIMEOUT) {
  return enviarSessaoRaw(comando, timeoutMs);
}

function enviarComando(comando, timeoutMs) {
  return withAcbrLock(
    () => enviarComandoRaw(comando, timeoutMs),
    comando.split("(")[0].split("|")[0],
  );
}

/** Comandos NFE/NFC-e na mesma sessão TCP com modelo explícito (55 ou 65). */
async function enviarNfeModelo(comando, modeloDF = 65, timeoutMs = ACBR_TIMEOUT) {
  const modelo = Number(modeloDF) === 55 ? 55 : 65;
  return withAcbrLock(async () => {
    const sessao =
      ultimoModeloSessao === modelo
        ? [comando]
        : [
            `NFE.SetModeloDF(${modelo})`,
            'NFE.SetVersaoDF("4.00")',
            `NFE.SetAmbiente(${resolverTpAmbAcbr()})`,
            comando,
          ];
    try {
      const resultado = await enviarSessaoRaw(sessao, timeoutMs);
      ultimoModeloSessao = modelo;
      return resultado;
    } catch (err) {
      ultimoModeloSessao = null;
      throw melhorarErroAcbr(err);
    }
  }, comando.split("(")[0]);
}

/** NFC-e modelo 65 — compatibilidade com código existente. */
async function enviarNfe(comando, timeoutMs = ACBR_TIMEOUT) {
  return enviarNfeModelo(comando, 65, timeoutMs);
}

/** Vários comandos NFE na mesma sessão TCP (ex.: ConfigGravarValor + ConfigGravar). */
async function enviarNfeComandos(comandos, timeoutMs = ACBR_TIMEOUT) {
  const lista = Array.isArray(comandos) ? comandos : [comandos];
  return withAcbrLock(async () => {
    const sessao =
      ultimoModeloSessao === 65
        ? lista
        : [
            "NFE.SetModeloDF(65)",
            'NFE.SetVersaoDF("4.00")',
            `NFE.SetAmbiente(${resolverTpAmbAcbr()})`,
            ...lista,
          ];
    try {
      const resultado = await enviarSessaoRaw(sessao, timeoutMs);
      ultimoModeloSessao = 65;
      return resultado;
    } catch (err) {
      ultimoModeloSessao = null;
      throw err;
    }
  }, lista[0]?.split("(")[0] || "NFE");
}

function parseResposta(resposta) {
  const docs = require("./documentosFiscais");
  const bruto = coalescerRespostaAcbr(resposta);

  let jsonEnvio = null;
  try {
    const j = JSON.parse(bruto);
    jsonEnvio =
      j?.Envio ||
      j?.envio ||
      j?.Status ||
      j?.status ||
      j?.Consulta ||
      j?.consulta ||
      null;
  } catch (_) {
    jsonEnvio = null;
  }

  const linhas = bruto
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const todosCStat = [];
  for (const m of bruto.matchAll(/cStat\s*[=:]\s*(\d+)/gi)) {
    todosCStat.push(m[1]);
  }

  const get = (chave) => {
    const re = new RegExp(`^${chave}\\s*[=:]\\s*(.+)$`, "i");
    for (const linha of linhas) {
      if (/^\[/.test(linha)) continue;
      const m = linha.match(re);
      if (m) return m[1].trim();
    }
    const reIni = new RegExp(`^${chave}\\s*=\\s*(.+)$`, "i");
    for (const linha of linhas) {
      const m = linha.match(reIni);
      if (m) return m[1].trim();
    }
    return null;
  };

  const xml = docs.extrairXmlDaResposta(resposta);
  const prot = docs.extrairProtNFe(xml);

  const cStat = jsonEnvio
    ? String(jsonEnvio.CStat ?? jsonEnvio.cStat ?? "")
    : resolverCStatFinal({ todosCStat, prot, get });

  const chave =
    jsonEnvio?.chNFe ||
    prot.chNFe ||
    get("ChaveNFe") ||
    get("Chave") ||
    get("chDFe") ||
    get("ChNFe") ||
    get("ChDFe") ||
    bruto.match(/\b(\d{44})\b/)?.[1] ||
    null;

  let qrcode =
    get("QRCode") ||
    get("URLConsulta") ||
    get("qrCode") ||
    bruto.match(/https?:\/\/[^\s"']+qrcode[^\s"']*/i)?.[0];
  if (!qrcode && xml) qrcode = docs.extrairQrCodeDoXml(xml);

  return {
    raw: resposta,
    cStat,
    todosCStat,
    xMotivo:
      jsonEnvio?.XMotivo ||
      jsonEnvio?.Msg ||
      jsonEnvio?.xMotivo ||
      prot.xMotivo ||
      get("xMotivo") ||
      get("XMotivo"),
    tpAmb: get("tpAmb") || get("TpAmb"),
    chave,
    numero: get("NumeroNFe") || get("Numero") || get("nNF"),
    serie: get("SerieNFe") || get("Serie"),
    qrcode,
    protocolo:
      jsonEnvio?.NProt ||
      jsonEnvio?.nProt ||
      prot.nProt ||
      get("nProt") ||
      get("Protocolo") ||
      extrairProtocoloBruto(bruto),
    xml,
    pathPdf:
      get("PathPDF") ||
      get("ArquivoPDF") ||
      get("PDF") ||
      extrairPathPdfOk(resposta),
  };
}

function sefazOperacional(cStat, resposta) {
  if (cStat === "107" || cStat === "108") return true;
  const t = coalescerRespostaAcbr(resposta).toUpperCase();
  return (
    t.includes("SERVICO EM OPERACAO") ||
    t.includes("SERVIÇO EM OPERAÇÃO") ||
    t.includes("CSTAT=107") ||
    t.includes("CSTAT: 107")
  );
}

async function testar() {
  if (!getEmissaoFiscalAtivo()) {
    atualizarStatusMemoria(false);
    return false;
  }
  try {
    const resposta = await enviarNfe("NFE.StatusServico");
    const p = parseResposta(resposta);
    const ok = sefazOperacional(p.cStat, resposta);
    atualizarStatusMemoria(ok);
    return ok;
  } catch (err) {
    console.warn("[ACBr] testar() falhou:", err.message);
    atualizarStatusMemoria(false);
    return false;
  }
}

async function statusServico() {
  const resposta = await enviarNfe("NFE.StatusServico");
  const p = parseResposta(resposta);
  return {
    operacional: sefazOperacional(p.cStat, resposta),
    cStat: p.cStat,
    xMotivo: p.xMotivo,
    tpAmb: p.tpAmb,
    raw: resposta,
  };
}

async function consultarChave(chave) {
  if (!chave || String(chave).length !== 44) {
    throw new Error("Chave NFC-e deve ter 44 dígitos.");
  }
  const modelo = parseInt(inferirModeloDaChave(chave), 10);
  const resposta = await enviarNfeModelo(
    `NFE.ConsultarNFe(${qAcbr(chave)})`,
    modelo,
  );
  let p = parseResposta(resposta);
  p = enrichParsePosEmissao(p, resposta);
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
  const t = coalescerRespostaAcbr(raw).toUpperCase();
  const protocolo =
    t.match(/NPROT[=:]\s*(\d+)/i)?.[1] ||
    t.match(/<NPROT>(\d+)<\/NPROT>/i)?.[1] ||
    null;
  const chave =
    t.match(/\b(\d{44})\b/)?.[1] ||
    t.match(/CHNFE[=:]\s*(\d{44})/i)?.[1] ||
    null;
  if (t.includes("CANCEL")) return "CANCELADA";
  if (isCStatAutorizado(cStat) || t.includes("AUTORIZ")) {
    return "AUTORIZADA";
  }
  if (cStat === "101") return "CANCELADA";
  if (cStat === "110") return "DENEGADA";
  if (cStat === "103") return "DESCONHECIDA";
  if (cStat && cStat.startsWith("2")) return "REJEITADA";
  return "DESCONHECIDA";
}

function limparTexto(v) {
  return String(v ?? "").trim();
}

/** ACBr rejeita acentos/caracteres de controle no INI ("Unable to Parse"). */
function sanitizeAcbrText(val, maxLen = 120) {
  return String(val ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\r\n\t=]/g, " ")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function gerarCodigoNumerico() {
  return String(crypto.randomInt(10000000, 99999999));
}

function formatarDhEmi(data = new Date()) {
  return fiscalDhEmiIni.formatarDhEmiAcbrIni(data);
}

function resolverTpAmb() {
  const amb = String(process.env.AMBIENTE_SEFAZ || "homologacao").toLowerCase();
  if (amb === "producao" || amb === "1") return "1";
  return "2";
}

/** Aplica série/número reservados pelo agente em INI montado no backend (Onda B.4). */
function patchNumeracaoIni(ini, numeracao) {
  if (!ini || !numeracao) return ini;
  const serie = numeracao.serie ?? fiscalNumeracao.SERIE_PADRAO;
  const numero = numeracao.numero;
  const cNf = gerarCodigoNumerico();
  const lines = String(ini).split(/\r?\n/);
  let inIdent = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (line === "[Identificacao]") {
      inIdent = true;
      continue;
    }
    if (inIdent && line.startsWith("[")) {
      break;
    }
    if (!inIdent) continue;
    if (line.startsWith("serie=")) lines[i] = `serie=${serie}`;
    else if (line.startsWith("nNF=")) lines[i] = `nNF=${numero}`;
    else if (line.startsWith("cNF=")) lines[i] = `cNF=${cNf}`;
  }
  return fiscalDhEmiIni.prepararIniParaEmissao(lines.join("\n"));
}

function crtUsaSimples(crt) {
  const c = String(crt || "1");
  return c === "1" || c === "4";
}

function fmtMoney(n) {
  return Number(n).toFixed(2);
}

function fmtQty(n) {
  return Number(n).toFixed(4);
}

function resolverGtin(item) {
  const candidatos = [
    item.gtin,
    item.codigoBarras,
    item.ean,
    item.codigo,
  ];
  for (const raw of candidatos) {
    const gtin = String(raw || "").replace(/\D/g, "");
    if (gtin.length >= 8 && gtin.length <= 14) return gtin;
  }
  return "";
}

/** Distribui vTotTrib (IBPT) proporcionalmente entre itens — último item absorve centavos. */
function distribuirIbptItens(itens, totalVenda, ibptTotal) {
  const cupom = Number.isFinite(ibptTotal) && ibptTotal > 0 ? ibptTotal : 0;
  if (cupom <= 0 || !Array.isArray(itens) || itens.length === 0) {
    return itens.map(() => 0);
  }
  const total = Number(totalVenda) > 0 ? Number(totalVenda) : 0;
  let acum = 0;
  return itens.map((item, i) => {
    const itemTotal = Number(
      item.total ?? Number(item.quantidade) * Number(item.precoUnitario),
    );
    if (i === itens.length - 1) {
      return Math.round((cupom - acum) * 100) / 100;
    }
    const parte =
      total > 0
        ? Math.round(((cupom * itemTotal) / total) * 100) / 100
        : 0;
    acum += parte;
    return parte;
  });
}

function resolverNatOpNfe(payload) {
  if (payload.natOp) return sanitizeAcbrText(payload.natOp, 60);
  if (payload.tipoEmissaoNfe === "POS_NFCE") {
    return "5929/ VENDA JA REGIST. NO NFC-E D/UF";
  }
  if (payload.tipoEmissaoNfe === "SUBSTITUICAO_TRIBUTARIA") {
    return "VENDA MERC. SUBSTITUICAO TRIBUTARIA";
  }
  return "VENDA DE MERCADORIA";
}

function montarSecaoTributosItem(item, n, crt, vTotTribItem = 0) {
  const usaSimples = crtUsaSimples(crt);
  const nn = String(n).padStart(3, "0");
  const qtd = Number(item.quantidade);
  const pu = Number(item.precoUnitario);
  const total = Number(item.total ?? qtd * pu);
  const desc = Number(item.desconto || 0);
  const brutoLinha = desc > 0 ? total + desc : total;
  const un = unidadeFiscalDoItem(item);
  const gtin = resolverGtin(item);
  const ncm = String(item.ncm || "00000000")
    .replace(/\D/g, "")
    .padStart(8, "0")
    .slice(0, 8);
  const cfop = String(item.cfop || "5102")
    .replace(/\D/g, "")
    .slice(0, 4);
  const nome = sanitizeAcbrText(item.nome, 120);

  let bloco = `[Produto${nn}]\n`;
  bloco += `CFOP=${cfop}\n`;
  bloco += `cProd=${sanitizeAcbrText(item.codigo || String(n), 60)}\n`;
  bloco += `cEAN=${gtin || "SEM GTIN"}\n`;
  bloco += `cEANTrib=${gtin || "SEM GTIN"}\n`;
  bloco += `xProd=${nome}\n`;
  bloco += `NCM=${ncm}\n`;
  const cest = String(item.cest || "")
    .replace(/\D/g, "")
    .slice(0, 7);
  if (cest.length === 7) bloco += `CEST=${cest}\n`;
  bloco += `uCom=${un}\n`;
  bloco += `qCom=${fmtQty(qtd)}\n`;
  bloco += `vUnCom=${fmtQty(pu)}\n`;
  bloco += `vProd=${fmtMoney(brutoLinha)}\n`;
  bloco += `uTrib=${un}\n`;
  bloco += `qTrib=${fmtQty(qtd)}\n`;
  bloco += `vUnTrib=${fmtQty(pu)}\n`;
  if (desc > 0) bloco += `vDesc=${fmtMoney(desc)}\n`;
  if (Number(vTotTribItem) > 0) {
    bloco += `vTotTrib=${fmtMoney(vTotTribItem)}\n`;
  }
  bloco += `indTot=1\n\n`;

  bloco += `[ICMS${nn}]\n`;
  if (usaSimples) {
    bloco += `CSOSN=${String(item.csosn || item.cst || "102")
      .replace(/\D/g, "")
      .slice(0, 3)}\n`;
  } else {
    bloco += `CST=${String(item.cst || "00")
      .replace(/\D/g, "")
      .slice(0, 2)}\n`;
  }
  bloco += `orig=${String(item.origem || item.orig || "0")
    .replace(/\D/g, "")
    .slice(0, 1) || "0"}\n`;
  if (!usaSimples) {
    bloco += `modBC=3\n`;
  }
  bloco += `vBC=0.00\n`;
  bloco += `pICMS=${fmtMoney(usaSimples ? 0 : item.aliquotaIcms || 0)}\n`;
  bloco += `vICMS=0.00\n\n`;

  bloco += `[PIS${nn}]\n`;
  if (usaSimples) {
    bloco += `CST=99\nvBC=0.00\npPIS=0.00\nvPIS=0.00\n\n`;
  } else {
    bloco += `CST=01\nvBC=0.00\npPIS=0.65\nvPIS=0.00\n\n`;
  }

  bloco += `[COFINS${nn}]\n`;
  if (usaSimples) {
    bloco += `CST=99\nvBC=0.00\npCOFINS=0.00\nvCOFINS=0.00\n\n`;
  } else {
    bloco += `CST=01\nvBC=0.00\npCOFINS=3.00\nvCOFINS=0.00\n\n`;
  }

  return { bloco, total: brutoLinha, desc, vTotTrib: Number(vTotTribItem) || 0 };
}

function montarSecaoDestinatario(payload, tpAmb) {
  const cpf = String(payload.cpfCliente || "").replace(/\D/g, "");
  const cnpj = String(payload.cnpjCliente || "").replace(/\D/g, "");
  const doc = cpf.length === 11 ? cpf : cnpj.length === 14 ? cnpj : "";
  if (!doc) return "";
  let nome = sanitizeAcbrText(payload.nomeCliente || "CONSUMIDOR", 60);
  if (tpAmb === "2") {
    nome = "NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL";
  }
  return `[Destinatario]\nCNPJCPF=${doc}\nxNome=${nome}\nindIEDest=9\n\n`;
}

function resolverIndIeDestNfe(dest, doc) {
  if (dest.indIEDest != null && dest.indIEDest !== "") {
    return Number(dest.indIEDest);
  }
  if (limparTexto(dest.inscricaoEstadual)) return 1;
  if (doc.length === 14) return 1;
  return 9;
}

function cfopItemNfe(itemCfop, cfopDefault, idDest) {
  let cfop = String(itemCfop || cfopDefault || "5102")
    .replace(/\D/g, "")
    .slice(0, 4);
  if (!cfop) cfop = cfopDefault;
  if (idDest === "2" && cfop.startsWith("5")) return `6${cfop.slice(1)}`;
  if (idDest === "1" && cfop.startsWith("6")) return `5${cfop.slice(1)}`;
  return cfop;
}

function montarSecaoDestinatarioNfe(dest, tpAmb) {
  const doc = String(dest.cpfCnpj || "").replace(/\D/g, "");
  const end = dest.endereco || {};
  let nome = sanitizeAcbrText(dest.razaoSocial, 60);
  if (tpAmb === "2") {
    nome = "NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL";
  }
  const indIE = resolverIndIeDestNfe(dest, doc);
  const logradouro = sanitizeAcbrText(end.logradouro, 60);
  const numero = sanitizeAcbrText(end.numero, 10) || "SN";
  const complemento = sanitizeAcbrText(end.complemento, 60);
  const bairro = sanitizeAcbrText(end.bairro, 60);
  const cidade = sanitizeAcbrText(end.municipio, 60);
  const uf = sanitizeAcbrText(end.uf, 2).toUpperCase();
  const cep = String(end.cep || "").replace(/\D/g, "");
  const codMun = normalizarIbge(end.codigoMunicipio || end.codigoIbge);

  let ini = `[Destinatario]\n`;
  ini += `CNPJCPF=${doc}\n`;
  ini += `xNome=${nome}\n`;
  ini += `indIEDest=${indIE}\n`;
  if (indIE === 1 && dest.inscricaoEstadual) {
    ini += `IE=${sanitizeAcbrText(dest.inscricaoEstadual, 20)}\n`;
  } else if (indIE === 2 && dest.inscricaoEstadual) {
    ini += `IE=${sanitizeAcbrText(dest.inscricaoEstadual, 20)}\n`;
  }
  ini += `xLgr=${logradouro}\n`;
  ini += `nro=${numero}\n`;
  if (complemento) ini += `xCpl=${complemento}\n`;
  ini += `xBairro=${bairro}\n`;
  ini += `cMun=${codMun}\n`;
  ini += `xMun=${cidade}\n`;
  ini += `UF=${uf}\n`;
  ini += `CEP=${cep}\n`;
  ini += `cPais=1058\n`;
  ini += `xPais=BRASIL\n`;
  if (dest.email) ini += `email=${sanitizeAcbrText(dest.email, 60)}\n`;
  ini += `\n`;
  return ini;
}

function montarSecaoInfRespTec() {
  const cnpj = String(process.env.NFCE_RESP_TEC_CNPJ || "").replace(/\D/g, "");
  if (cnpj.length !== 14) return "";
  let s = `[INFRESPTEC]\n`;
  s += `CNPJ=${cnpj}\n`;
  s += `xContato=${sanitizeAcbrText(process.env.NFCE_RESP_TEC_CONTATO || "SUPORTE", 60)}\n`;
  const email = sanitizeAcbrText(process.env.NFCE_RESP_TEC_EMAIL || "", 60);
  if (email) s += `email=${email}\n`;
  const fone = String(process.env.NFCE_RESP_TEC_FONE || "")
    .replace(/\D/g, "")
    .slice(0, 14);
  if (fone) s += `fone=${fone}\n`;
  const idCsrt = String(process.env.NFCE_RESP_TEC_ID_CSRT || "").replace(/\D/g, "");
  const csrt = String(process.env.NFCE_RESP_TEC_CSRT || "").trim();
  if (idCsrt) s += `idcsrt=${idCsrt}\n`;
  if (csrt) s += `csrt=${csrt}\n`;
  return `${s}\n`;
}

function normalizarIbge(codigo) {
  const digits = String(codigo || "").replace(/\D/g, "");
  if (digits.length === 7) return digits;
  if (digits.length === 6) return digits.padStart(7, "0");
  return digits || null;
}

const viacepCache = new Map();
const VIACEP_TTL_MS = 24 * 60 * 60 * 1000;

async function enriquecerEmpresa(empresa = {}) {
  const e = { ...empresa };
  if (!limparTexto(e.logradouro) && limparTexto(e.endereco)) {
    e.logradouro = e.endereco;
  }
  if (!limparTexto(e.endereco) && limparTexto(e.logradouro)) {
    e.endereco = e.logradouro;
  }

  const cep = String(e.cep || "").replace(/\D/g, "");
  const precisaCep =
    !limparTexto(e.cidade) ||
    !limparTexto(e.codigoIbge || e.codigoMunicipio || e.cMun);

  if (precisaCep && cep.length === 8) {
    const cached = viacepCache.get(cep);
    if (cached && Date.now() - cached.em < VIACEP_TTL_MS) {
      Object.assign(e, cached.data);
    } else {
      try {
        const fetch = require("node-fetch");
        const res = await fetch(`https://viacep.com.br/ws/${cep}/json/`, {
          timeout: 5000,
        });
        const data = await res.json();
        if (!data.erro) {
          const patch = {};
          if (!limparTexto(e.cidade)) patch.cidade = data.localidade;
          if (!limparTexto(e.uf)) patch.uf = data.uf;
          if (!limparTexto(e.bairro) && data.bairro) patch.bairro = data.bairro;
          if (!limparTexto(e.logradouro) && data.logradouro) {
            patch.logradouro = data.logradouro;
            patch.endereco = data.logradouro;
          }
          if (!limparTexto(e.codigoIbge || e.codigoMunicipio) && data.ibge) {
            patch.codigoIbge = data.ibge;
          }
          Object.assign(e, patch);
          viacepCache.set(cep, { em: Date.now(), data: patch });
        }
      } catch {
        /* ViaCEP indisponível — segue com dados locais */
      }
    }
  }

  e.codigoMunicipio =
    normalizarIbge(
      e.codigoIbge || e.codigoMunicipio || e.cMun || e.cidadeCod,
    ) || null;
  return e;
}

function validarEmpresaFiscal(empresa) {
  const faltando = [];
  if (String(empresa.cnpj || "").replace(/\D/g, "").length !== 14) {
    faltando.push("CNPJ");
  }
  if (!limparTexto(empresa.inscricaoEstadual)) faltando.push("Inscrição Estadual");
  if (!limparTexto(empresa.cidade)) faltando.push("Cidade");
  const uf = limparTexto(empresa.uf).toUpperCase();
  if (!uf || uf.length !== 2) faltando.push("UF");
  if (!limparTexto(empresa.logradouro || empresa.endereco)) {
    faltando.push("Logradouro");
  }
  const ibge = normalizarIbge(empresa.codigoMunicipio);
  if (!ibge || ibge.length !== 7) {
    faltando.push("Código IBGE do município (7 dígitos — salve o CEP em Dados Fiscais)");
  }
  const cep = String(empresa.cep || "").replace(/\D/g, "");
  if (cep.length !== 8) {
    faltando.push("CEP (8 dígitos)");
  }
  if (faltando.length) {
    const err = new Error(
      `Dados fiscais incompletos: ${faltando.join(", ")}. Atualize em Configurações → Dados Fiscais.`,
    );
    err.permanente = true;
    throw err;
  }
}

function montarIniNfce(payload, numeracao) {
  const empresa = payload.empresa || {};
  const itens = payload.itens || [];
  const tpAmb = resolverTpAmb();
  const cnpj = String(empresa.cnpj || "").replace(/\D/g, "");
  const crt = String(
    empresa.regimeTributario || empresa.regimeTributarioCodigo || "1",
  ).slice(0, 1);
  const logradouro = sanitizeAcbrText(
    empresa.logradouro || empresa.endereco,
    60,
  );
  const numero = sanitizeAcbrText(empresa.numero, 10) || "SN";
  const complemento = sanitizeAcbrText(empresa.complemento, 60);
  const bairro = sanitizeAcbrText(empresa.bairro, 60) || "CENTRO";
  const cidade = sanitizeAcbrText(empresa.cidade, 60);
  const uf = sanitizeAcbrText(empresa.uf, 2).toUpperCase();
  const cep = String(empresa.cep || "").replace(/\D/g, "");
  const codMun = normalizarIbge(empresa.codigoMunicipio);
  const razao = sanitizeAcbrText(
    empresa.razaoSocial || empresa.nomeFantasia,
    60,
  );
  const fantasia = sanitizeAcbrText(
    empresa.nomeFantasia || empresa.razaoSocial,
    60,
  );
  const serie = String(
    numeracao?.serie || payload.serieNfe || fiscalNumeracao.SERIE_PADRAO,
  );
  const nNF = String(numeracao?.numero || payload.numeroNfe || "1");
  const cNF = gerarCodigoNumerico();
  const descontoGeral = Number(payload.desconto || 0);
  const totalVenda = Number(payload.total);

  let vProd = 0;
  let vTotTrib = 0;
  let blocoItens = "";
  const ibptTotal = Number(payload.ibpt?.total);
  const ibptCupom =
    Number.isFinite(ibptTotal) && ibptTotal > 0 ? ibptTotal : 0;
  let ibptAcum = 0;

  itens.forEach((item, i) => {
    const itemTotal = Number(item.total ?? Number(item.quantidade) * Number(item.precoUnitario));
    let vTotTribItem = 0;
    if (ibptCupom > 0 && totalVenda > 0) {
      if (i === itens.length - 1) {
        vTotTribItem = Math.round((ibptCupom - ibptAcum) * 100) / 100;
      } else {
        vTotTribItem =
          Math.round(((ibptCupom * itemTotal) / totalVenda) * 100) / 100;
        ibptAcum += vTotTribItem;
      }
    }
    const { bloco, total, desc, vTotTrib: vTribItem } = montarSecaoTributosItem(
      item,
      i + 1,
      crt,
      vTotTribItem,
    );
    blocoItens += bloco;
    vProd += total - desc;
    vTotTrib += vTribItem;
  });
  vTotTrib = Math.round(vTotTrib * 100) / 100;

  let ini = `[infNFe]\nversao=4.00\n\n`;

  ini += `[Identificacao]\n`;
  ini += `cNF=${cNF}\n`;
  ini += `natOp=VENDA AO CONSUMIDOR\n`;
  ini += `mod=65\n`;
  ini += `serie=${serie}\n`;
  ini += `nNF=${nNF}\n`;
  ini += `dhEmi=${formatarDhEmi()}\n`;
  ini += `tpNF=1\n`;
  ini += `indFinal=1\n`;
  ini += `idDest=1\n`;
  ini += `indPres=1\n`;
  ini += `tpImp=4\n`;
  ini += `tpAmb=${tpAmb}\n`;
  ini += `finNFe=1\n`;
  ini += `tpEmis=1\n`;
  ini += `procEmi=0\n`;
  ini += `verProc=MarginEnginePDV/5.3\n`;
  if (codMun) ini += `cMunFG=${codMun}\n`;
  ini += `\n`;

  ini += `[Emitente]\n`;
  ini += `CNPJCPF=${cnpj}\n`;
  ini += `xNome=${razao}\n`;
  ini += `xFant=${fantasia}\n`;
  ini += `IE=${sanitizeAcbrText(empresa.inscricaoEstadual, 20)}\n`;
  ini += `CRT=${crt}\n`;
  ini += `xLgr=${logradouro}\n`;
  ini += `nro=${numero}\n`;
  if (complemento) ini += `xCpl=${complemento}\n`;
  ini += `xBairro=${bairro}\n`;
  ini += `cMun=${codMun}\n`;
  ini += `xMun=${cidade}\n`;
  ini += `UF=${uf}\n`;
  ini += `CEP=${cep}\n`;
  ini += `cUF=${ibgeUfParaCodigo(uf)}\n`;
  ini += `cPais=1058\n`;
  ini += `xPais=BRASIL\n`;
  if (empresa.telefone) {
    ini += `Fone=${String(empresa.telefone).replace(/\D/g, "").slice(0, 14)}\n`;
  }
  ini += `\n`;

  ini += montarSecaoDestinatario(payload, tpAmb);

  ini += blocoItens;

  ini += `[Total]\n`;
  ini += `vNF=${fmtMoney(totalVenda)}\n`;
  ini += `vBC=0.00\n`;
  ini += `vICMS=0.00\n`;
  ini += `vProd=${fmtMoney(vProd)}\n`;
  ini += `vDesc=${fmtMoney(descontoGeral)}\n`;
  ini += `vPIS=0.00\n`;
  ini += `vCOFINS=0.00\n`;
  ini += `vTotTrib=${fmtMoney(vTotTrib)}\n\n`;

  ini += `[Transportador]\nmodFrete=9\n\n`;

  const formaMap = {
    dinheiro: "01",
    credito: "03",
    debito: "04",
    pix: "17",
    voucher: "05",
    fiado: "99",
    outros: "99",
  };

  const pagamentosLista =
    Array.isArray(payload.pagamentos) && payload.pagamentos.length > 0
      ? payload.pagamentos
      : [
          {
            forma: payload.formaPagamento || "dinheiro",
            valor: Number(payload.valorRecebido || totalVenda),
            troco: Number(payload.troco || 0),
          },
        ];

  let vTrocoTotal = 0;
  pagamentosLista.forEach((pg, idx) => {
    const forma = (pg.forma || "dinheiro").toLowerCase();
    const codigoForma = formaMap[forma] || "01";
    const valorPg = Number(pg.valor || 0);
    const trocoPg = Number(pg.troco || 0);
    const vPagNum =
      codigoForma === "01" && trocoPg > 0
        ? valorPg
        : Math.max(0, valorPg);
    const vTrocoNum = codigoForma === "01" ? trocoPg : 0;
    if (vTrocoNum > 0) vTrocoTotal += vTrocoNum;

    const seq = String(idx + 1).padStart(3, "0");
    ini += `[PAG${seq}]\n`;
    ini += `tPag=${codigoForma}\n`;
    ini += `vPag=${fmtMoney(vPagNum)}\n`;
    ini += `indPag=0\n`;
    if (codigoForma === "03" || codigoForma === "04" || codigoForma === "17") {
      ini += `tpIntegra=2\n`;
    }
    if (idx === pagamentosLista.length - 1) {
      ini += `vTroco=${fmtMoney(vTrocoTotal)}\n`;
    }
    if (codigoForma === "99") {
      const labels = {
        fiado: "FIADO",
        crediario: "CREDIARIO",
        outros: "OUTROS",
      };
      ini += `xPag=${sanitizeAcbrText(
        payload.labelPagamento || labels[forma] || "OUTROS",
        60,
      )}\n`;
    }
    ini += `\n`;
  });

  ini += montarSecaoInfRespTec();

  if (payload.numeroVenda) {
    ini += `[DadosAdicionais]\n`;
    ini += `infCpl=VENDA ${sanitizeAcbrText(String(payload.numeroVenda), 40)}\n\n`;
  }

  return ini;
}

function cfopPadraoNfe(payload, emitenteUf, destUf) {
  if (payload.cfopPadrao) return String(payload.cfopPadrao).replace(/\D/g, "").slice(0, 4);
  const envCfop = process.env.NFE_CFOP_PADRAO;
  if (envCfop) return String(envCfop).replace(/\D/g, "").slice(0, 4);
  const eu = String(emitenteUf || "").toUpperCase();
  const du = String(destUf || "").toUpperCase();
  if (eu && du && eu !== du) return "6102";
  return "5102";
}

function montarIniNfe(payload, numeracao, destinatario) {
  const empresa = payload.empresa || {};
  const itens = payload.itens || [];
  const tpAmb = resolverTpAmb();
  const cnpj = String(empresa.cnpj || "").replace(/\D/g, "");
  const crt = String(
    empresa.regimeTributario || empresa.regimeTributarioCodigo || "1",
  ).slice(0, 1);
  const logradouro = sanitizeAcbrText(empresa.logradouro || empresa.endereco, 60);
  const numero = sanitizeAcbrText(empresa.numero, 10) || "SN";
  const complemento = sanitizeAcbrText(empresa.complemento, 60);
  const bairro = sanitizeAcbrText(empresa.bairro, 60) || "CENTRO";
  const cidade = sanitizeAcbrText(empresa.cidade, 60);
  const ufEmit = sanitizeAcbrText(empresa.uf, 2).toUpperCase();
  const cep = String(empresa.cep || "").replace(/\D/g, "");
  const codMun = normalizarIbge(empresa.codigoMunicipio);
  const razao = sanitizeAcbrText(empresa.razaoSocial || empresa.nomeFantasia, 60);
  const fantasia = sanitizeAcbrText(empresa.nomeFantasia || empresa.razaoSocial, 60);
  const serie = String(numeracao?.serie || payload.serieNfe || fiscalNumeracao.SERIE_NFE_55);
  const nNF = String(numeracao?.numero || payload.numeroNfe || "1");
  const cNF = gerarCodigoNumerico();
  const descontoGeral = Number(payload.desconto || 0);
  const totalVenda = Number(payload.total);
  const destUf = sanitizeAcbrText(destinatario.endereco?.uf, 2).toUpperCase();
  const idDest = ufEmit && destUf && ufEmit !== destUf ? "2" : "1";
  const cfopDefault = cfopPadraoNfe(payload, ufEmit, destUf);
  const ibptTotal = Number(payload.ibpt?.total);
  const ibptCupom =
    Number.isFinite(ibptTotal) && ibptTotal > 0 ? ibptTotal : 0;

  let vProd = 0;
  let vTotTrib = 0;
  let blocoItens = "";
  const ibptPorItem = distribuirIbptItens(itens, totalVenda, ibptCupom);

  itens.forEach((item, i) => {
    let cfopItem = cfopItemNfe(item.cfop, cfopDefault, idDest);
    if (payload.tipoEmissaoNfe === "POS_NFCE") {
      cfopItem = "5929";
    }
    const itemComCfop = {
      ...item,
      cfop: cfopItem,
      csosn: item.csosn || item.CSOSN,
      cest: item.cest || item.CEST,
    };
    const itemTotal = Number(item.total ?? Number(item.quantidade) * Number(item.precoUnitario));
    const { bloco, total, desc, vTotTrib: vTribItem } = montarSecaoTributosItem(
      itemComCfop,
      i + 1,
      crt,
      ibptPorItem[i] || 0,
    );
    blocoItens += bloco;
    vProd += total - desc;
    vTotTrib += vTribItem;
  });
  vTotTrib = Math.round(vTotTrib * 100) / 100;

  const dhEmi = formatarDhEmi();
  const natOp = resolverNatOpNfe(payload);

  let ini = `[infNFe]\nversao=4.00\n\n`;
  ini += `[Identificacao]\n`;
  ini += `cNF=${cNF}\n`;
  ini += `natOp=${natOp}\n`;
  ini += `mod=55\n`;
  ini += `serie=${serie}\n`;
  ini += `nNF=${nNF}\n`;
  ini += `dhEmi=${dhEmi}\n`;
  ini += `dhSaiEnt=${dhEmi}\n`;
  ini += `tpNF=1\n`;
  ini += `idDest=${idDest}\n`;
  ini += `indFinal=${payload.indFinal != null ? payload.indFinal : 0}\n`;
  ini += `indPres=${payload.indPres != null ? payload.indPres : 1}\n`;
  ini += `tpImp=1\n`;
  ini += `tpAmb=${tpAmb}\n`;
  ini += `finNFe=1\n`;
  ini += `tpEmis=1\n`;
  ini += `procEmi=0\n`;
  ini += `verProc=MarginEnginePDV/5.3\n`;
  if (codMun) ini += `cMunFG=${codMun}\n`;
  const nfRef = String(payload.nfRefChave || payload.chaveNfceReferencia || "")
    .replace(/\D/g, "");
  if (nfRef.length === 44) {
    ini += `\n[NFRef001]\nrefNFe=${nfRef}\n`;
  }
  ini += `\n`;

  ini += `[Emitente]\n`;
  ini += `CNPJCPF=${cnpj}\n`;
  ini += `xNome=${razao}\n`;
  ini += `xFant=${fantasia}\n`;
  ini += `IE=${sanitizeAcbrText(empresa.inscricaoEstadual, 20)}\n`;
  ini += `CRT=${crt}\n`;
  ini += `xLgr=${logradouro}\n`;
  ini += `nro=${numero}\n`;
  if (complemento) ini += `xCpl=${complemento}\n`;
  ini += `xBairro=${bairro}\n`;
  ini += `cMun=${codMun}\n`;
  ini += `xMun=${cidade}\n`;
  ini += `UF=${ufEmit}\n`;
  ini += `CEP=${cep}\n`;
  ini += `cUF=${ibgeUfParaCodigo(ufEmit)}\n`;
  ini += `cPais=1058\n`;
  ini += `xPais=BRASIL\n`;
  if (empresa.telefone) {
    ini += `Fone=${String(empresa.telefone).replace(/\D/g, "").slice(0, 14)}\n`;
  }
  ini += `\n`;

  ini += montarSecaoDestinatarioNfe(destinatario, tpAmb);
  ini += blocoItens;

  ini += `[Total]\n`;
  ini += `vNF=${fmtMoney(totalVenda)}\n`;
  ini += `vBC=0.00\n`;
  ini += `vICMS=0.00\n`;
  ini += `vProd=${fmtMoney(vProd)}\n`;
  ini += `vDesc=${fmtMoney(descontoGeral)}\n`;
  ini += `vPIS=0.00\n`;
  ini += `vCOFINS=0.00\n`;
  ini += `vTotTrib=${fmtMoney(vTotTrib)}\n\n`;

  ini += `[Transportador]\nmodFrete=9\n\n`;

  const formaMap = {
    dinheiro: "01",
    credito: "03",
    debito: "04",
    pix: "17",
    voucher: "05",
    fiado: "99",
    outros: "99",
  };
  const pagamentosLista =
    Array.isArray(payload.pagamentos) && payload.pagamentos.length > 0
      ? payload.pagamentos
      : [
          {
            forma: payload.formaPagamento || "dinheiro",
            valor: Number(payload.valorRecebido || totalVenda),
            troco: Number(payload.troco || 0),
          },
        ];

  pagamentosLista.forEach((pg, idx) => {
    const forma = (pg.forma || "dinheiro").toLowerCase();
    const codigoForma = formaMap[forma] || "01";
    const valorPg = Number(pg.valor || 0);
    const seq = String(idx + 1).padStart(3, "0");
    ini += `[PAG${seq}]\n`;
    ini += `tPag=${codigoForma}\n`;
    ini += `vPag=${fmtMoney(valorPg)}\n`;
    ini += `indPag=0\n\n`;
  });

  ini += montarSecaoInfRespTec();

  const infCplParts = [];
  if (payload.numeroVenda) {
    infCplParts.push(`NF-E VENDA ${sanitizeAcbrText(String(payload.numeroVenda), 40)}`);
  }
  if (payload.infCpl) {
    infCplParts.push(sanitizeAcbrText(String(payload.infCpl), 200));
  }
  if (ibptCupom > 0) {
    const pct =
      totalVenda > 0 ? ((ibptCupom / totalVenda) * 100).toFixed(2) : "0.00";
    infCplParts.push(
      `Trib. aprox.: R$ ${fmtMoney(ibptCupom)} (${pct}%) Fonte: IBPT`,
    );
  }
  if (nfRef.length === 44) {
    infCplParts.push(`Nota fiscal referente a NFC-e chave ${nfRef.slice(0, 10)}…`);
  }
  if (infCplParts.length > 0) {
    ini += `[DadosAdicionais]\n`;
    ini += `infCpl=${infCplParts.join(" | ")}\n\n`;
  }

  return ini;
}

function ibgeUfParaCodigo(uf) {
  const map = {
    AC: "12", AL: "27", AM: "13", AP: "16", BA: "29", CE: "23", DF: "53",
    ES: "32", GO: "52", MA: "21", MG: "31", MS: "50", MT: "51", PA: "15",
    PB: "25", PE: "26", PI: "22", PR: "41", RJ: "33", RN: "24", RO: "11",
    RR: "14", RS: "43", SC: "42", SE: "28", SP: "35", TO: "17",
  };
  return map[String(uf || "").toUpperCase()] || "";
}

function enrichParsePosEmissao(p, resposta) {
  const docs = require("./documentosFiscais");
  const bruto = coalescerRespostaAcbr(resposta);
  let xml = p.xml;
  let prot = docs.extrairProtNFe(xml);
  if (p.chave) {
    const local = docs.localizarXmlPorChave(p.chave);
    if (local?.xml) {
      xml = local.xml;
      if (local.prot?.cStat || local.prot?.nProt) prot = local.prot;
    } else if (!xml) {
      const xmlPath = resolverXmlChave(p.chave);
      if (fs.existsSync(xmlPath)) {
        try {
          xml = fs.readFileSync(xmlPath, "utf8");
          prot = docs.extrairProtNFe(xml);
        } catch (_) {}
      }
    }
  }
  const protocolo = prot.nProt || p.protocolo || extrairProtocoloBruto(bruto);
  const todosCStat = [...(p.todosCStat || [])];
  if (prot.cStat && !todosCStat.includes(prot.cStat)) todosCStat.push(prot.cStat);

  const get = (chave) => {
    const re = new RegExp(`^${chave}\\s*[=:]\\s*(.+)$`, "im");
    const m = bruto.match(re);
    return m ? m[1].trim() : null;
  };

  const resolved = resolverCStatFinal({ todosCStat, prot, get });
  const cStat = resolved ?? p.cStat ?? null;
  return {
    ...p,
    xml: xml || p.xml,
    protocolo,
    cStat,
    todosCStat,
    xMotivo: prot.xMotivo || p.xMotivo,
  };
}

async function enrichParsePosEmissaoAsync(p, resposta) {
  let atual = enrichParsePosEmissao(p, resposta);
  if (isCStatAutorizado(atual.cStat)) return atual;

  if (CSTAT_LOTE_OK.has(String(atual.cStat)) && atual.chave) {
    const esperaMs = FISCAL_CONSULTA_POS_104_MS;
    if (esperaMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, esperaMs));
    }
    try {
      const consulta = await consultarChave(atual.chave);
      const cs = String(consulta.cStat || "");
      if (
        consulta.situacao === "AUTORIZADA" ||
        cs === "100" ||
        cs === "150"
      ) {
        return {
          ...atual,
          cStat: cs || "100",
          protocolo: consulta.protocolo || atual.protocolo,
          xMotivo: consulta.xMotivo || atual.xMotivo,
          xml:
            require("./documentosFiscais").extrairXmlDaResposta(consulta.raw) ||
            atual.xml,
        };
      }
      // 217/137 na consulta após lote 104 = chave ainda não indexada, não rejeição da nota
    } catch (_) {
      /* consulta indisponível — segue com parse enriquecido */
    }
  }
  return atual;
}

function assertAutorizada(p, resposta, modeloDF = 65) {
  const cStat = String(p.cStat || "");
  if (isCStatAutorizado(cStat)) return;
  const tipo = Number(modeloDF) === 55 ? "NF-e" : "NFC-e";
  const motivo =
    p.xMotivo ||
    (CSTAT_LOTE_OK.has(cStat) ? "Lote processado" : coalescerRespostaAcbr(resposta).slice(0, 500));
  const err = new Error(
    CSTAT_LOTE_OK.has(cStat)
      ? `${tipo} aguardando confirmação SEFAZ (cStat ${cStat}): ${motivo}`
      : `${tipo} rejeitada (cStat ${cStat || "?"}): ${motivo}`,
  );
  err.cStat = cStat;
  err.acbrRaw = coalescerRespostaAcbr(resposta).slice(0, 4000);
  if (p.chave) err.chaveConsulta = p.chave;
  if (CSTAT_LOTE_OK.has(cStat)) {
    err.incerto = true;
    err.permanente = false;
    err.mensagemAcao =
      "Lote aceito pela SEFAZ (cStat 104) — consulta de protocolo em andamento; não reemitir.";
  } else if (cStat === "217" && /nao consta|não consta/i.test(String(p.xMotivo || ""))) {
    err.incerto = true;
    err.permanente = false;
    err.mensagemAcao =
      "A chave ainda não aparece na consulta SEFAZ — pode ser atraso de indexação, não rejeição imediata.";
  } else if (cStat === "999") {
    err.incerto = true;
    err.permanente = false;
    err.sefazIntermitente = true;
  } else {
    err.permanente = true;
  }
  throw err;
}

async function criarEnviarIni(iniPath) {
  return criarEnviarIniModelo(iniPath, 65);
}

async function criarEnviarIniModelo(iniPath, modeloDF = 65, opts = {}) {
  const sincrono = opts.sincrono !== undefined ? !!opts.sincrono : FISCAL_ACBR_SINCRONO;
  const flagSinc = sincrono ? 1 : 0;
  const respostaBruta = await enviarNfeModelo(
    `NFE.CriarEnviarNFe(${qAcbr(iniPath)},1,0,${flagSinc},0,0,0,0)`,
    modeloDF,
    ACBR_TIMEOUT_EMISSAO,
  );
  const resposta = coalescerRespostaAcbr(respostaBruta);
  let p = parseResposta(resposta);
  if (!p.chave) {
    const err = new Error(`ACBr não retornou ChaveNFe. Resposta: ${resposta.slice(0, 500)}`);
    if (/539|duplic/i.test(resposta)) err.permanente = true;
    if (p.cStat === "539") err.permanente = true;
    throw err;
  }
  p = await enrichParsePosEmissaoAsync(p, resposta);
  if (!opts.eventoFiscal) {
    assertAutorizada(p, resposta, modeloDF);
  }
  return { p, resposta };
}

/** cStat de evento fiscal registrado na SEFAZ (CCe, manifestação, etc.). */
function isCStatEventoOk(cStat) {
  const cs = String(cStat || "");
  return cs === "135" || cs === "128" || cs === "136";
}

async function enviarEventoFiscal(payload) {
  if (!getEmissaoFiscalAtivo()) {
    throw new Error("Emissão fiscal desabilitada (EMISSAO_FISCAL)");
  }
  const documentIni = payload?.documentIni;
  if (!documentIni || !String(documentIni).trim()) {
    throw new Error("documentIni obrigatório para evento fiscal");
  }
  const chave = payload?.chave || payload?.chaveNfe || null;
  const modeloRaw =
    payload?.modeloDocumento || (chave ? inferirModeloDaChave(chave) : null) || "65";
  const modelo = parseInt(String(modeloRaw).replace(/\D/g, ""), 10) || 65;
  const iniPath = path.join(
    PATHS.ini,
    `evento-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ini`,
  );
  fs.writeFileSync(iniPath, String(documentIni), "utf8");
  const { p, resposta } = await criarEnviarIniModelo(iniPath, modelo, {
    sincrono: true,
    eventoFiscal: true,
  });
  const cStat = String(p.cStat || "");
  if (!isCStatAutorizado(cStat) && !isCStatEventoOk(cStat) && !CSTAT_LOTE_OK.has(cStat)) {
    assertAutorizada(p, resposta, modelo);
  }
  return {
    ok: isCStatAutorizado(cStat) || isCStatEventoOk(cStat),
    cStat: p.cStat,
    protocolo: p.protocolo,
    chave: p.chave || chave,
    xMotivo: p.xMotivo,
    raw: resposta,
    tipoEvento: payload?.tipoEvento || payload?.tipo || null,
    modeloDocumento: String(modelo),
  };
}

async function emitirNfce(payload) {
  if (!getEmissaoFiscalAtivo()) return { fiscal: false };

  if (payload?.xml || payload?.xmlEpec || payload?.modoEpec) {
    const xml = payload.xml || payload.xmlEpec;
    if (!xml) throw new Error("XML EPEC ausente para retransmissao.");
    const xmlPath = path.join(PATHS.temp, `epec-${Date.now()}.xml`);
    fs.writeFileSync(xmlPath, xml, "utf8");
    const resposta = await enviarNfe(
      `NFE.EnviarNFe(${qAcbr(xmlPath)})`,
      ACBR_TIMEOUT_EMISSAO,
    );
    const p = parseResposta(resposta);
    if (!p.chave) {
      throw new Error(`ACBr EPEC nao retornou chave. Resposta: ${resposta}`);
    }
    assertAutorizada(p, resposta);
    return normalizarResultado(p, resposta);
  }

  validarPayloadNfce(payload);
  const empresa = await enriquecerEmpresa(payload.empresa || {});
  validarEmpresaFiscal(empresa);

  const serie = payload.serieNfe || fiscalNumeracao.SERIE_PADRAO;
  let numeracao = payload.numeroNfe
    ? {
        serie: payload.serieNfe || serie,
        numero: parseInt(String(payload.numeroNfe).replace(/\D/g, ""), 10),
      }
    : payload._fiscalMeta?.numeroNfe
      ? {
          serie: payload._fiscalMeta.serieNfe || serie,
          numero: parseInt(String(payload._fiscalMeta.numeroNfe).replace(/\D/g, ""), 10),
        }
      : fiscalNumeracao.reservarProximoNumero(serie);

  let iniPath;
  let resultado;

  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const fiscalIniPolicy = require("./fiscal/fiscalIniPolicy");
    let iniBase;
    if (payload.documentIni && String(payload.documentIni).trim()) {
      iniBase = patchNumeracaoIni(payload.documentIni, numeracao);
    } else {
      fiscalIniPolicy.requireDocumentIniOrAllowLocal(payload, "NFC-e");
      iniBase = montarIniNfce({ ...payload, empresa }, numeracao);
    }
    const ini = iniBase;
    iniPath = path.join(
      PATHS.ini,
      `nfce-${payload.numeroVenda || Date.now()}-${numeracao.numero}.ini`,
    );
    fs.writeFileSync(iniPath, ini, "utf8");

    try {
      const { p, resposta } = await criarEnviarIni(iniPath);
      fiscalNumeracao.sincronizarNumeroAutorizado(
        numeracao.serie,
        p.numero || numeracao.numero,
      );
      resultado = normalizarResultado(p, resposta);
      break;
    } catch (err) {
      if (
        err.cStat === "539" &&
        tentativa === 0 &&
        !payload.numeroNfe &&
        !payload._fiscalMeta?.numeroNfe
      ) {
        numeracao = fiscalNumeracao.reservarProximoNumero(serie);
        continue;
      }
      throw err;
    }
  }

  return resultado;
}

async function emitirNfe(payload) {
  if (!isNfeModelo55Habilitado()) return { fiscal: false };

  const destinatario = validarPayloadNfe(payload);
  const empresa = await enriquecerEmpresa(payload.empresa || {});
  validarEmpresaFiscal(empresa);

  const serie = payload.serieNfe || fiscalNumeracao.SERIE_NFE_55;
  const modeloNum = "55";
  let numeracao = payload.numeroNfe
    ? {
        serie: payload.serieNfe || serie,
        numero: parseInt(String(payload.numeroNfe).replace(/\D/g, ""), 10),
        modelo: modeloNum,
      }
    : payload._fiscalMeta?.numeroNfe
      ? {
          serie: payload._fiscalMeta.serieNfe || serie,
          numero: parseInt(String(payload._fiscalMeta.numeroNfe).replace(/\D/g, ""), 10),
          modelo: modeloNum,
        }
      : fiscalNumeracao.reservarProximoNumero(serie, modeloNum);

  let iniPath;
  let resultado;

  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const fiscalIniPolicy = require("./fiscal/fiscalIniPolicy");
    let iniBase;
    if (payload.documentIni && String(payload.documentIni).trim()) {
      iniBase = patchNumeracaoIni(payload.documentIni, numeracao);
    } else {
      fiscalIniPolicy.requireDocumentIniOrAllowLocal(payload, "NF-e");
      iniBase = montarIniNfe({ ...payload, empresa }, numeracao, destinatario);
    }
    const ini = iniBase;
    iniPath = path.join(
      PATHS.ini,
      `nfe-${payload.numeroVenda || Date.now()}-${numeracao.numero}.ini`,
    );
    fs.writeFileSync(iniPath, ini, "utf8");

    try {
      const { p, resposta } = await criarEnviarIniModelo(iniPath, 55);
      fiscalNumeracao.sincronizarNumeroAutorizado(
        numeracao.serie,
        p.numero || numeracao.numero,
        modeloNum,
      );
      resultado = normalizarResultado(p, resposta, "55");
      break;
    } catch (err) {
      if (
        err.cStat === "539" &&
        tentativa === 0 &&
        !payload.numeroNfe &&
        !payload._fiscalMeta?.numeroNfe
      ) {
        numeracao = fiscalNumeracao.reservarProximoNumero(serie, modeloNum);
        continue;
      }
      throw err;
    }
  }

  return resultado;
}

function normalizarResultado(p, resposta, modeloDocumento = "65") {
  const docs = require("./documentosFiscais");
  const xml = docs.extrairXmlDaResposta(resposta);
  const qrcode = p.qrcode || (xml ? docs.extrairQrCodeDoXml(xml) : null);
  return {
    chave: p.chave,
    numero: p.numero,
    serie: p.serie || "001",
    qrcode,
    protocolo: p.protocolo,
    cStat: p.cStat,
    xMotivo: p.xMotivo,
    xml,
    fiscal: true,
    modeloDocumento,
    chaveNfe: p.chave,
    numeroNfe: p.numero,
    serieNfe: p.serie || "001",
    qrcodeNfe: qrcode,
  };
}

async function cancelarNfce(chaveNfeOuChave, motivo, cnpj) {
  const chave = chaveNfeOuChave;
  if (!chave) throw new Error("chave da NFC-e obrigatória para cancelamento.");
  const motivoTexto = (motivo || "Cancelamento solicitado pelo operador").slice(
    0,
    255,
  );
  const cnpjEmit = String(cnpj || extrairCnpjDaChave(chave) || "").replace(
    /\D/g,
    "",
  );
  if (!cnpjEmit) {
    throw new Error("CNPJ do emitente obrigatório para cancelamento.");
  }
  const resposta = await enviarNfe(
    `NFE.CancelarNFe(${qAcbr(chave)},${qAcbr(motivoTexto)},${qAcbr(cnpjEmit)})`,
  );
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
  const cnpjLimpo = String(cnpj).replace(/\D/g, "");
  const resposta = await enviarNfe(
    `NFE.InutilizarNFe(${qAcbr(cnpjLimpo)},${qAcbr(motivoTexto)},${ano},${modelo},${serie},${numeroInicial},${numeroFinal})`,
  );
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

function suffixPdfModelo(modeloDocumento = "65") {
  return String(modeloDocumento) === "55" ? "danfe" : "danfce";
}

function destinoPdfFiscal(chave, modeloDocumento = "65") {
  return path.join(PATHS.pdf, `${chave}-${suffixPdfModelo(modeloDocumento)}.pdf`);
}

function inferirModeloDaChave(chave) {
  const k = String(chave || "").replace(/\D/g, "");
  if (k.length >= 22) {
    const mod = k.substring(20, 22);
    if (mod === "55" || mod === "65") return mod;
  }
  return "65";
}

async function gerarPdfFiscal(chave, xmlPath, modeloDocumento = "65") {
  const modelo = String(modeloDocumento || "65");
  const destino = destinoPdfFiscal(chave, modelo);
  const docs = require("./documentosFiscais");
  const existente = docs.localizarPdfPorChave(chave, modelo);
  if (existente && docs.isPdfValid(existente)) {
    if (path.resolve(existente) !== path.resolve(destino)) {
      fs.copyFileSync(existente, destino);
    }
    return destino;
  }
  const xml = resolverXmlChave(chave, xmlPath);
  const larguraCod = process.env.DANFE_LARGURA_COD_PROD || "72";
  const layoutDanfe =
    modelo === "55"
      ? [
          'NFE.ConfigGravarValor("DANFE","ImprimeCodigoEan","0")',
          'NFE.ConfigGravarValor("DANFENFe","ExibeEAN","0")',
          `NFE.ConfigGravarValor("DANFENFe","LarguraCodProd","${larguraCod}")`,
          "NFE.ConfigGravar()",
        ]
      : [];
  // Somente ImprimirDANFEPDF — ImprimirDanfe envia à impressora física (reimpressão usa imprimirDanfce).
  const comandos =
    modelo === "55"
      ? [...layoutDanfe, `NFE.ImprimirDANFEPDF(${qAcbr(xml)},,,"1","0")`]
      : [`NFE.ImprimirDANFEPDF(${qAcbr(xml)},,,"1","1")`];

  for (const cmd of comandos) {
    try {
      const enviar = modelo === "55" ? (c) => enviarNfeModelo(c, 55, ACBR_TIMEOUT_EMISSAO) : enviarNfe;
      const resposta = await enviar(cmd);
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

  const achadoAninhado = docs.localizarPdfPorChave(chave, modelo);
  if (achadoAninhado && docs.isPdfValid(achadoAninhado)) {
    if (path.resolve(achadoAninhado) !== path.resolve(destino)) {
      fs.copyFileSync(achadoAninhado, destino);
    }
    return destino;
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

  const rotulo = modelo === "55" ? "DANFE NF-e" : "DANFC-e";
  throw new Error(
    `ACBr não gerou PDF ${rotulo} para chave ${chave}. Verifique PathPDF no ACBr Monitor.`,
  );
}

async function gerarPdfDanfce(chave, xmlPath) {
  return gerarPdfFiscal(chave, xmlPath, "65");
}

async function gerarPdfDanfe(chave, xmlPath) {
  return gerarPdfFiscal(chave, xmlPath, "55");
}

async function imprimirDanfce(chave, xmlPath) {
  const xml = resolverXmlChave(chave, xmlPath);
  return enviarNfe(
    `NFE.ImprimirDanfe(${qAcbr(xml)},,,,0,,1,1)`,
    ACBR_TIMEOUT,
  );
}

module.exports = {
  testar,
  statusServico,
  consultarChave,
  emitirNfce,
  emitirNfe,
  isNfeModelo55Habilitado,
  montarIniNfe,
  criarEnviarIniModelo,
  enviarEventoFiscal,
  isCStatEventoOk,
  enviarNfeModelo,
  cancelarNfce,
  inutilizarNfce,
  gerarPdfFiscal,
  gerarPdfDanfce,
  gerarPdfDanfe,
  inferirModeloDaChave,
  imprimirDanfce,
  enviarComando: enviarNfe,
  enviarNfe,
  enviarNfeComandos,
  withAcbrLock,
  isAcbrBusy,
  setRuntimeEmissaoFiscal,
  getRuntimeEmissaoFiscal: getEmissaoFiscalAtivo,
  get EMISSAO_FISCAL() {
    return getEmissaoFiscalAtivo();
  },
  parseResposta,
  montarIniNfce,
  enriquecerEmpresa,
  validarEmpresaFiscal,
  obterStatusMemoria,
  obterStatusDetalhe,
  atualizarStatusMemoria,
  patchNumeracaoIni,
  normalizarResultado,
  enrichParsePosEmissaoAsync,
  assertAutorizada,
};

// PDV Margin Engine — Módulo ACBr Monitor (mutex global + consultas fiscais)
require("dotenv").config();
const net = require("net");

const ACBR_HOST = process.env.ACBR_HOST || "127.0.0.1";
const ACBR_PORT = parseInt(process.env.ACBR_PORT || "9200");
const ACBR_TIMEOUT = parseInt(process.env.ACBR_TIMEOUT_MS || "10000");
const ACBR_BANNER_MS = parseInt(process.env.ACBR_BANNER_MS || "80", 10);
const ACBR_IDLE_MS = parseInt(process.env.ACBR_IDLE_MS || "180", 10);
const ACBR_TIMEOUT_EMISSAO = parseInt(
  process.env.ACBR_TIMEOUT_EMISSAO_MS || "120000",
);
const EMISSAO_FISCAL =
  (process.env.EMISSAO_FISCAL || "false").toLowerCase() === "true";
// Protocolo TCP do ACBr Monitor: cada comando termina com CR+LF+'.'+CR+LF
// https://acbr.sourceforge.io/ACBrMonitor/Apresentacao.html
const ACBR_TERMINADOR = "\r\n.\r\n";
const { PATHS } = require("./marginPaths");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const fiscalNumeracao = require("./fiscalNumeracao");
const { validarPayloadNfce } = require("./fiscalValidacao");

let acbrLock = Promise.resolve();
let nfceModeloConfigurado = false;

function qAcbr(valor) {
  return `"${String(valor).replace(/"/g, '""')}"`;
}

function extrairCnpjDaChave(chave) {
  const digits = String(chave).replace(/\D/g, "");
  if (digits.length !== 44) return null;
  return digits.slice(6, 20);
}

function resolverXmlChave(chave, xmlPath) {
  if (xmlPath && fs.existsSync(xmlPath)) return xmlPath;
  for (const dir of [PATHS.xml, PATHS.saida, PATHS.backup]) {
    if (!fs.existsSync(dir)) continue;
    const match = fs.readdirSync(dir).find(
      (f) => f.includes(chave) && f.toLowerCase().endsWith(".xml"),
    );
    if (match) return path.join(dir, match);
  }
  return path.join(PATHS.xml, `${chave}-nfe.xml`);
}

function extrairPathPdfOk(resposta) {
  const m = String(resposta || "").match(/Arquivo criado em:\s*(.+)/i);
  return m ? m[1].trim() : null;
}

function withAcbrLock(fn, label = "acbr") {
  const run = acbrLock.then(() => fn());
  acbrLock = run.catch(() => {});
  return run;
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

/** Comandos NFE/NFC-e na mesma sessão TCP (modelo 65 + versão 4.00 + comando). */
async function enviarNfe(comando, timeoutMs = ACBR_TIMEOUT) {
  return withAcbrLock(async () => {
    const sessao = nfceModeloConfigurado
      ? [comando]
      : [
          "NFE.SetModeloDF(65)",
          'NFE.SetVersaoDF("4.00")',
          comando,
        ];
    try {
      const resultado = await enviarSessaoRaw(sessao, timeoutMs);
      nfceModeloConfigurado = true;
      return resultado;
    } catch (err) {
      nfceModeloConfigurado = false;
      throw err;
    }
  }, comando.split("(")[0]);
}

/** Vários comandos NFE na mesma sessão TCP (ex.: ConfigGravarValor + ConfigGravar). */
async function enviarNfeComandos(comandos, timeoutMs = ACBR_TIMEOUT) {
  const lista = Array.isArray(comandos) ? comandos : [comandos];
  return withAcbrLock(async () => {
    const sessao = nfceModeloConfigurado
      ? lista
      : ["NFE.SetModeloDF(65)", 'NFE.SetVersaoDF("4.00")', ...lista];
    try {
      const resultado = await enviarSessaoRaw(sessao, timeoutMs);
      nfceModeloConfigurado = true;
      return resultado;
    } catch (err) {
      nfceModeloConfigurado = false;
      throw err;
    }
  }, lista[0]?.split("(")[0] || "NFE");
}

function parseResposta(resposta) {
  const bruto = String(resposta || "");
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

  let cStat =
    get("cStat") ||
    get("CStat") ||
    todosCStat.find((s) => s === "100" || s === "150") ||
    todosCStat.find((s) => s.startsWith("2")) ||
    todosCStat[todosCStat.length - 1] ||
    null;

  const chave =
    get("ChaveNFe") ||
    get("Chave") ||
    get("chDFe") ||
    get("ChNFe") ||
    get("ChDFe") ||
    bruto.match(/\b(\d{44})\b/)?.[1] ||
    null;

  return {
    raw: resposta,
    cStat,
    todosCStat,
    xMotivo: get("xMotivo") || get("XMotivo"),
    tpAmb: get("tpAmb") || get("TpAmb"),
    chave,
    numero: get("NumeroNFe") || get("Numero") || get("nNF"),
    serie: get("SerieNFe") || get("Serie"),
    qrcode:
      get("QRCode") ||
      get("URLConsulta") ||
      get("qrCode") ||
      bruto.match(/https?:\/\/[^\s"']+qrcode[^\s"']*/i)?.[0],
    protocolo: get("nProt") || get("Protocolo"),
    pathPdf:
      get("PathPDF") ||
      get("ArquivoPDF") ||
      get("PDF") ||
      extrairPathPdfOk(resposta),
  };
}

function sefazOperacional(cStat, resposta) {
  if (cStat === "107" || cStat === "108") return true;
  const t = String(resposta || "").toUpperCase();
  return (
    t.includes("SERVICO EM OPERACAO") ||
    t.includes("SERVIÇO EM OPERAÇÃO") ||
    t.includes("CSTAT=107") ||
    t.includes("CSTAT: 107")
  );
}

async function testar() {
  if (!EMISSAO_FISCAL) return false;
  try {
    const resposta = await enviarNfe("NFE.StatusServico");
    const p = parseResposta(resposta);
    return sefazOperacional(p.cStat, resposta);
  } catch (err) {
    console.warn("[ACBr] testar() falhou:", err.message);
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
  const resposta = await enviarNfe(`NFE.ConsultarNFe(${qAcbr(chave)})`);
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
  const p = (n) => String(n).padStart(2, "0");
  return `${p(data.getDate())}/${p(data.getMonth() + 1)}/${data.getFullYear()} ${p(data.getHours())}:${p(data.getMinutes())}:${p(data.getSeconds())}`;
}

function resolverTpAmb() {
  const amb = String(process.env.AMBIENTE_SEFAZ || "homologacao").toLowerCase();
  if (amb === "producao" || amb === "1") return "1";
  return "2";
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
  const gtin = String(item.gtin || item.codigoBarras || item.ean || "").replace(
    /\D/g,
    "",
  );
  if (gtin.length >= 8 && gtin.length <= 14) return gtin;
  return "";
}

function montarSecaoTributosItem(item, n, crt) {
  const usaSimples = crtUsaSimples(crt);
  const nn = String(n).padStart(3, "0");
  const qtd = Number(item.quantidade);
  const pu = Number(item.precoUnitario);
  const total = Number(item.total ?? qtd * pu);
  const desc = Number(item.desconto || 0);
  const un = item.porPeso ? "KG" : "UN";
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
  if (gtin) {
    bloco += `cEAN=${gtin}\n`;
    bloco += `cEANTrib=${gtin}\n`;
  }
  bloco += `xProd=${nome}\n`;
  bloco += `NCM=${ncm}\n`;
  bloco += `uCom=${un}\n`;
  bloco += `qCom=${fmtQty(qtd)}\n`;
  bloco += `vUnCom=${fmtQty(pu)}\n`;
  bloco += `vProd=${fmtMoney(total)}\n`;
  bloco += `uTrib=${un}\n`;
  bloco += `qTrib=${fmtQty(qtd)}\n`;
  bloco += `vUnTrib=${fmtQty(pu)}\n`;
  if (desc > 0) bloco += `vDesc=${fmtMoney(desc)}\n`;
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
  bloco += usaSimples ? `modBC=\n` : `modBC=3\n`;
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

  return { bloco, total, desc };
}

function montarSecaoDestinatario(payload, tpAmb) {
  const cpf = String(payload.cpfCliente || "").replace(/\D/g, "");
  if (cpf.length !== 11) return "";
  let nome = sanitizeAcbrText(payload.nomeCliente || "CONSUMIDOR", 60);
  if (tpAmb === "2") {
    nome = "NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL";
  }
  return `[Destinatario]\nCNPJCPF=${cpf}\nxNome=${nome}\nindIEDest=9\n\n`;
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
  let blocoItens = "";
  itens.forEach((item, i) => {
    const { bloco, total, desc } = montarSecaoTributosItem(item, i + 1, crt);
    blocoItens += bloco;
    vProd += total - desc;
  });

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
  ini += `vTotTrib=0.00\n\n`;

  ini += `[Transportador]\nmodFrete=9\n\n`;

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
  const troco =
    payload.valorRecebido && payload.valorRecebido > totalVenda
      ? payload.valorRecebido - totalVenda
      : 0;

  ini += `[PAG001]\n`;
  ini += `tpag=${codigoForma}\n`;
  ini += `vPag=${fmtMoney(totalVenda)}\n`;
  ini += `indPag=0\n`;
  ini += `vTroco=${fmtMoney(troco)}\n`;
  if (codigoForma === "99") {
    ini += `xPag=${sanitizeAcbrText(payload.labelPagamento || "OUTROS", 60)}\n`;
  }
  ini += `\n`;

  ini += montarSecaoInfRespTec();

  if (payload.numeroVenda) {
    ini += `[DadosAdicionais]\n`;
    ini += `infCpl=VENDA ${sanitizeAcbrText(String(payload.numeroVenda), 40)}\n\n`;
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

function assertAutorizada(p, resposta) {
  const cStat = String(p.cStat || "");
  if (cStat === "100" || cStat === "150") return;
  const err = new Error(
    `NFC-e rejeitada (cStat ${cStat || "?"}): ${p.xMotivo || resposta}`,
  );
  err.cStat = cStat;
  if (cStat.startsWith("2") || cStat === "539") err.permanente = true;
  throw err;
}

async function criarEnviarIni(iniPath) {
  const resposta = await enviarNfe(
    `NFE.CriarEnviarNFe(${qAcbr(iniPath)},1,0,0,0,0,0,0)`,
    ACBR_TIMEOUT_EMISSAO,
  );
  const p = parseResposta(resposta);
  if (!p.chave) {
    const err = new Error(`ACBr não retornou ChaveNFe. Resposta: ${resposta}`);
    if (/539|duplic/i.test(resposta)) err.permanente = true;
    if (p.cStat === "539") err.permanente = true;
    throw err;
  }
  assertAutorizada(p, resposta);
  return { p, resposta };
}

async function emitirNfce(payload) {
  if (!EMISSAO_FISCAL) return { fiscal: false };

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
    ? { serie, numero: parseInt(String(payload.numeroNfe).replace(/\D/g, ""), 10) }
    : fiscalNumeracao.reservarProximoNumero(serie);

  let iniPath;
  let resultado;

  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const ini = montarIniNfce({ ...payload, empresa }, numeracao);
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
      if (err.cStat === "539" && tentativa === 0 && !payload.numeroNfe) {
        numeracao = fiscalNumeracao.reservarProximoNumero(serie);
        continue;
      }
      throw err;
    }
  }

  return resultado;
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

async function gerarPdfDanfce(chave, xmlPath) {
  const destino = path.join(PATHS.pdf, `${chave}-danfce.pdf`);
  const xml = resolverXmlChave(chave, xmlPath);
  const comandos = [
    `NFE.ImprimirDANFEPDF(${qAcbr(xml)},,,"1","1")`,
    `NFE.ImprimirDanfe(${qAcbr(xml)},,,,0,,1,1)`,
  ];

  for (const cmd of comandos) {
    try {
      const resposta = await enviarNfe(cmd, ACBR_TIMEOUT_EMISSAO);
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
  cancelarNfce,
  inutilizarNfce,
  gerarPdfDanfce,
  imprimirDanfce,
  enviarComando: enviarNfe,
  enviarNfe,
  enviarNfeComandos,
  withAcbrLock,
  EMISSAO_FISCAL,
  parseResposta,
  montarIniNfce,
  enriquecerEmpresa,
  validarEmpresaFiscal,
};

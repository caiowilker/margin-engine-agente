// Validação operacional NFC-e — o agente NÃO configura o ACBr por padrão.
// Certificado, CSC, URLs SEFAZ e ambiente devem estar no ACBr Monitor (aba DFe/WebServices).
// Patch/CSC automático só com ACBR_AUTO_PATCH=true ou ACBR_AUTO_CSC=true no .env.
const fs = require("fs");
const path = require("path");
const os = require("os");
const acbr = require("./acbr");
const log = require("./logger");

const NFE_UF = (process.env.NFE_UF || "MG").toUpperCase();
const AMBIENTE = (process.env.AMBIENTE_SEFAZ || "homologacao").toLowerCase();
const CSC_ID = process.env.NFE_CSC_ID || process.env.NFE_ID_CSC || "";
const CSC_TOKEN = process.env.NFE_CSC_TOKEN || process.env.NFE_CSC || "";
const AUTO_PATCH =
  (process.env.ACBR_AUTO_PATCH || "false").toLowerCase() === "true";
const AUTO_CSC =
  (process.env.ACBR_AUTO_CSC || "false").toLowerCase() === "true";

/** URLs oficiais MG (referência — configurar no ACBr Monitor / ACBrNFeServicos.ini). */
const URLS_MG = {
  H: {
    "URL-QRCode":
      "https://portalsped.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml",
    "URL-ConsultaNFCe": "https://hportalsped.fazenda.mg.gov.br/portalnfce",
    "URL-Consulta": "https://hportalsped.fazenda.mg.gov.br/portalnfce",
  },
  P: {
    "URL-QRCode":
      "https://portalsped.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml",
    "URL-ConsultaNFCe": "https://portalsped.fazenda.mg.gov.br/portalnfce",
    "URL-Consulta": "https://portalsped.fazenda.mg.gov.br/portalnfce",
  },
};

let ultimaValidacao = null;

function qAcbr(valor) {
  return `"${String(valor).replace(/"/g, '""')}"`;
}

function secaoNfce(uf, ambiente) {
  const sufixo = ambiente === "producao" ? "P" : "H";
  return `NFCe_${uf}_${sufixo}`;
}

function candidatosServicosIni() {
  const lista = [];
  if (process.env.ACBR_NFE_SERVICOS_INI) {
    lista.push(process.env.ACBR_NFE_SERVICOS_INI);
  }
  const bases = [
    process.env.ACBR_HOME,
    process.env.ACBrMonitorPath,
    "C:\\ACBrMonitorPLUS",
    "C:\\ACBrMonitor",
    "C:\\Program Files\\ACBrMonitorPLUS",
    "C:\\Program Files (x86)\\ACBrMonitorPLUS",
    path.join(os.homedir(), "ACBrMonitorPLUS"),
  ].filter(Boolean);

  for (const base of bases) {
    lista.push(path.join(base, "ACBrNFeServicos.ini"));
    lista.push(path.join(base, "ACBrLib", "ACBrNFeServicos.ini"));
  }
  return [...new Set(lista)];
}

function localizarServicosIni() {
  for (const p of candidatosServicosIni()) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      /* ignora */
    }
  }
  return null;
}

function lerSecaoIni(conteudo, secao) {
  const re = new RegExp(`\\[${secao}\\]([\\s\\S]*?)(?=\\n\\[|$)`, "i");
  const m = conteudo.match(re);
  return m ? m[1] : "";
}

function secaoTemChave(bloco, chave) {
  return new RegExp(`^${chave}\\s*=`, "im").test(bloco);
}

function patchServicosIni(iniPath, secao, urls) {
  let conteudo = fs.readFileSync(iniPath, "utf8");
  const normalizado = conteudo.replace(/\r\n/g, "\n");
  let bloco = lerSecaoIni(normalizado, secao);
  let alterado = false;

  if (!bloco) {
    let append = `\n[${secao}]\n`;
    for (const [chave, valor] of Object.entries(urls)) {
      append += `${chave}=${valor}\n`;
    }
    conteudo = normalizado.trimEnd() + append;
    alterado = true;
  } else {
    let novoBloco = bloco;
    for (const [chave, valor] of Object.entries(urls)) {
      if (!secaoTemChave(novoBloco, chave)) {
        novoBloco += `${chave}=${valor}\n`;
        alterado = true;
      }
    }
    if (alterado) {
      conteudo = normalizado.replace(
        new RegExp(`(\\[${secao}\\][\\s\\S]*?)(?=\\n\\[|$)`, "i"),
        `[${secao}]${novoBloco}`,
      );
    }
  }

  if (alterado) {
    const backup = `${iniPath}.bak-${Date.now()}`;
    fs.copyFileSync(iniPath, backup);
    fs.writeFileSync(iniPath, conteudo.replace(/\n/g, "\r\n"), "utf8");
    log.info(
      { modulo: "acbr_setup", iniPath, secao, backup },
      "ACBrNFeServicos.ini atualizado (ACBR_AUTO_PATCH=true)",
    );
  }
  return alterado;
}

function verificarUrlsIni() {
  const iniPath = localizarServicosIni();
  const secao = secaoNfce(NFE_UF, AMBIENTE);

  if (!iniPath) {
    return {
      ok: false,
      iniPath: null,
      secao,
      temQr: false,
      patched: false,
      motivo:
        "ACBrNFeServicos.ini não encontrado. Configure CSC/URLs no ACBr Monitor ou defina ACBR_NFE_SERVICOS_INI.",
    };
  }

  let conteudo = fs.readFileSync(iniPath, "utf8");
  let bloco = lerSecaoIni(conteudo, secao);
  let temQr = secaoTemChave(bloco, "URL-QRCode");
  let patched = false;

  if (!temQr && AUTO_PATCH && NFE_UF === "MG") {
    const urls = URLS_MG[AMBIENTE === "producao" ? "P" : "H"];
    patched = patchServicosIni(iniPath, secao, urls);
    conteudo = fs.readFileSync(iniPath, "utf8");
    bloco = lerSecaoIni(conteudo, secao);
    temQr = secaoTemChave(bloco, "URL-QRCode");
  }

  return {
    ok: temQr,
    iniPath,
    secao,
    temQr,
    patched,
    motivo: temQr
      ? null
      : `Seção [${secao}] sem URL-QRCode — configure no ACBr Monitor (WebServices) ou habilite ACBR_AUTO_PATCH=true.`,
  };
}

async function aplicarCscNoAcbr() {
  if (!CSC_ID || !CSC_TOKEN) {
    return {
      ok: false,
      motivo: "NFE_CSC_ID e NFE_CSC_TOKEN não definidos no .env do agente.",
    };
  }

  const idLimpo = String(CSC_ID).replace(/\D/g, "").padStart(6, "0");
  await acbr.enviarNfeComandos([
    `NFE.ConfigGravarValor(${qAcbr("NFCe")},${qAcbr("IdCSC")},${qAcbr(idLimpo)})`,
    `NFE.ConfigGravarValor(${qAcbr("NFCe")},${qAcbr("CSC")},${qAcbr(CSC_TOKEN)})`,
    "NFE.ConfigGravar()",
  ]);

  return { ok: true, idCsc: idLimpo };
}

/** Validação read-only (+ patch/CSC opcional). Não bloqueia emissão se ACBr já estiver OK. */
function validar(opcoes = {}) {
  const { aplicarAuto = false } = opcoes;
  const urls = verificarUrlsIni();
  const checklist = {
    uf: NFE_UF,
    ambiente: AMBIENTE,
    servicosIni: urls.iniPath,
    secao: urls.secao,
    urlQrCodeOk: urls.temQr,
    urlPatchAplicado: urls.patched,
    autoPatchHabilitado: AUTO_PATCH,
    autoCscHabilitado: AUTO_CSC,
    cscNoEnv: !!(CSC_ID && CSC_TOKEN),
    acoes: [],
  };

  if (!urls.ok) {
    checklist.acoes.push(urls.motivo);
  }

  if (!CSC_ID || !CSC_TOKEN) {
    checklist.acoes.push(
      "CSC: configure Id Token + CSC na aba WebServices/NFC-e do ACBr Monitor (homologação: SIARE-MG).",
    );
  }

  checklist.pronto = urls.ok;
  checklist.ok = urls.ok;

  ultimaValidacao = {
    ...checklist,
    em: new Date().toISOString(),
  };

  return ultimaValidacao;
}

async function validarAsync(opcoes = {}) {
  const base = validar(opcoes);
  let csc = { ok: true, aviso: "CSC gerenciado pelo ACBr Monitor" };

  if (AUTO_CSC && CSC_ID && CSC_TOKEN) {
    try {
      csc = await aplicarCscNoAcbr();
    } catch (err) {
      csc = { ok: false, motivo: err.message };
      base.acoes.push(`Falha ao gravar CSC via TCP: ${err.message}`);
    }
  }

  base.csc = csc;
  base.pronto = base.urlQrCodeOk && (csc.ok !== false);
  base.ok = base.pronto;
  ultimaValidacao = { ...base, em: new Date().toISOString() };
  return ultimaValidacao;
}

/** Boot: apenas diagnostica — nunca impede o agente de subir. */
async function inicializar() {
  if (!acbr.EMISSAO_FISCAL) return { ok: true, fiscal: false };
  const r = await validarAsync();
  if (r.pronto) {
    log.info({ modulo: "acbr_setup" }, "ACBr NFC-e — configuração OK");
  } else {
    log.warn(
      { modulo: "acbr_setup", acoes: r.acoes },
      "ACBr NFC-e — pendências de configuração (configure no ACBr Monitor)",
    );
  }
  return r;
}

/** Compat: preflight chama validação sem patch forçado. */
async function garantirPronto() {
  const r = await validarAsync({ aplicarAuto: AUTO_PATCH || AUTO_CSC });
  if (!r.urlQrCodeOk) {
    throw new Error(
      r.acoes[0] ||
        `Seção [${r.secao}] sem URL-QRCode. Configure no ACBr Monitor.`,
    );
  }
  return r;
}

function status() {
  return ultimaValidacao || validar();
}

module.exports = {
  validar,
  validarAsync,
  garantirPronto,
  inicializar,
  status,
  localizarServicosIni,
  secaoNfce,
  AUTO_PATCH,
  AUTO_CSC,
};

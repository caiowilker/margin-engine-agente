// Diagnóstico NFC-e — o agente NÃO altera ACBrNFeServicos.ini (configuração = ACBr Monitor).
// Certificado, CSC, URLs SEFAZ e ambiente ficam no ACBr Monitor.
const fs = require("fs");
const path = require("path");
const os = require("os");
const fiscalDriver = require("./fiscalDriver");
const log = require("./logger");

const NFE_UF = (process.env.NFE_UF || "MG").toUpperCase();
const AMBIENTE = (process.env.AMBIENTE_SEFAZ || "homologacao").toLowerCase();
const CSC_ID = process.env.NFE_CSC_ID || process.env.NFE_ID_CSC || "";
const CSC_TOKEN = process.env.NFE_CSC_TOKEN || process.env.NFE_CSC || "";
const AUTO_CSC =
  (process.env.ACBR_AUTO_CSC || "false").toLowerCase() === "true";

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
  const m = String(conteudo || "").match(re);
  return m ? m[1] : "";
}

function obterValorChave(bloco, chave) {
  const esc = chave.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = bloco.match(new RegExp(`^${esc}\\s*=\\s*(.+)$`, "im"));
  return m ? m[1].trim() : null;
}

/** Somente leitura — não grava nada no INI do ACBr. */
function lerDiagnosticoServicosIni() {
  const iniPath = localizarServicosIni();
  const secao = secaoNfce(NFE_UF, AMBIENTE);

  if (!iniPath) {
    return {
      ok: false,
      iniPath: null,
      secao,
      motivo:
        "ACBrNFeServicos.ini não encontrado pelo agente (informacional). " +
        "O ACBr Monitor usa o arquivo configurado na GUI — defina ACBR_NFE_SERVICOS_INI se quiser espelhar o caminho aqui.",
    };
  }

  const bloco = lerSecaoIni(
    fs.readFileSync(iniPath, "utf8").replace(/\r\n/g, "\n"),
    secao,
  );
  const urlQr = obterValorChave(bloco, "URL-QRCode");
  const urlQr200 = obterValorChave(bloco, "URL-QRCode_2.00");
  const urlConsulta =
    obterValorChave(bloco, "URL-ConsultaNFCe") ||
    obterValorChave(bloco, "URL-ConsultaNFCe_2.00");

  return {
    ok: !!(urlQr || urlQr200),
    iniPath,
    secao,
    urlQrCode: urlQr || null,
    urlQrCode200: urlQr200 || null,
    urlConsultaNfce: urlConsulta || null,
    observacao:
      "Diagnóstico local do agente. Se o ACBr ainda acusar URL-QRCode, reinicie o Monitor para recarregar o INI.",
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
  await fiscalDriver.enviarNfeComandos([
    `NFE.ConfigGravarValor(${qAcbr("NFCe")},${qAcbr("IdCSC")},${qAcbr(idLimpo)})`,
    `NFE.ConfigGravarValor(${qAcbr("NFCe")},${qAcbr("CSC")},${qAcbr(CSC_TOKEN)})`,
    "NFE.ConfigGravar()",
  ]);

  return { ok: true, idCsc: idLimpo };
}

function validar() {
  const diag = lerDiagnosticoServicosIni();
  const checklist = {
    uf: NFE_UF,
    ambiente: AMBIENTE,
    servicosIni: diag.iniPath,
    secao: diag.secao,
    urlQrCodeOk: diag.ok,
    urlQrCode: diag.urlQrCode,
    urlQrCode200: diag.urlQrCode200,
    urlConsultaNfce: diag.urlConsultaNfce,
    autoCscHabilitado: AUTO_CSC,
    cscNoEnv: !!(CSC_ID && CSC_TOKEN),
    acoes: [],
    observacao: diag.observacao,
  };

  if (!diag.ok && diag.motivo) {
    checklist.acoes.push(diag.motivo);
  }
  if (!CSC_ID || !CSC_TOKEN) {
    checklist.acoes.push(
      "CSC: configure Id Token + CSC no ACBr Monitor (homologação MG: SIARE).",
    );
  }

  checklist.pronto = true;
  checklist.ok = true;

  ultimaValidacao = { ...checklist, em: new Date().toISOString() };
  return ultimaValidacao;
}

async function validarAsync() {
  const base = validar();
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
  ultimaValidacao = { ...base, em: new Date().toISOString() };
  return ultimaValidacao;
}

async function inicializar() {
  if (!fiscalDriver.EMISSAO_FISCAL) return { ok: true, fiscal: false };
  const r = await validarAsync();
  log.info(
    { modulo: "fiscalDriver_setup", servicosIni: r.servicosIni, secao: r.secao },
    "ACBr NFC-e — diagnóstico INI (somente leitura)",
  );
  return r;
}

async function garantirPronto() {
  return validarAsync();
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
  lerDiagnosticoServicosIni,
  secaoNfce,
  AUTO_CSC,
};

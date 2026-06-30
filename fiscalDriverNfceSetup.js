/**
 * Setup NFC-e — diagnóstico A1/CSC/URLs para Monitor e emissor integrado (Lib).
 */
const fs = require("fs");
const path = require("path");
const acbrNfceSetup = require("./acbrNfceSetup");
const fiscalLocalConfig = require("./fiscalLocalConfig");
const factory = require("./fiscal/factory");

function driverAtual() {
  return String(process.env.ACBR_DRIVER || factory.resolveDriverName() || "monitor")
    .toLowerCase()
    .replace("acbr-lib", "lib");
}

function isLibDriver() {
  return driverAtual() === "lib";
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

function secaoNfce(uf, ambiente) {
  const sufixo = ambiente === "producao" ? "P" : "H";
  return `NFCe_${uf}_${sufixo}`;
}

function resolverServicosIniLib(cfg) {
  const iniPath = cfg.paths?.iniPath;
  if (!iniPath) return null;
  const iniDir = path.dirname(iniPath);
  const raw = fs.existsSync(iniPath) ? fs.readFileSync(iniPath, "utf8") : "";
  const rel =
    raw.match(/^ArquivoServicos=(.+)$/m)?.[1]?.trim() ||
    raw.match(/^IniServicos=(.+)$/m)?.[1]?.trim() ||
    "ACBrNFeServicos.ini";
  const candidatos = [
    path.isAbsolute(rel) ? rel : path.resolve(iniDir, rel),
    path.join(iniDir, "ACBrNFeServicos.ini"),
    path.join(path.dirname(iniDir), "config", "ACBrNFeServicos.ini"),
  ];
  return candidatos.find((p) => p && fs.existsSync(p)) || null;
}

function lerDiagnosticoLib() {
  const cfg = fiscalLocalConfig.ler();
  const uf = cfg.uf || "MG";
  const ambiente = cfg.ambienteSefaz || "homologacao";
  const secao = secaoNfce(uf, ambiente);
  const iniPath = resolverServicosIniLib(cfg);

  if (!iniPath) {
    return {
      ok: false,
      iniPath: null,
      secao,
      motivo:
        "Arquivo de serviços NFC-e não encontrado junto à configuração fiscal local. " +
        "Verifique Configuração fiscal no agente.",
    };
  }

  const bloco = lerSecaoIni(fs.readFileSync(iniPath, "utf8").replace(/\r\n/g, "\n"), secao);
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
    observacao: "Diagnóstico do emissor integrado (configuração fiscal local).",
  };
}

function validarLib() {
  const cfg = fiscalLocalConfig.ler();
  const diag = lerDiagnosticoLib();
  const checklist = {
    uf: cfg.uf,
    ambiente: cfg.ambienteSefaz,
    driver: "lib",
    servicosIni: diag.iniPath,
    secao: diag.secao,
    urlQrCodeOk: diag.ok,
    urlQrCode: diag.urlQrCode,
    urlQrCode200: diag.urlQrCode200,
    urlConsultaNfce: diag.urlConsultaNfce,
    certificadoArquivo: cfg.certificado?.arquivo || null,
    certificadoExiste: cfg.certificado?.arquivoExiste === true,
    senhaConfigurada: cfg.certificado?.senhaConfigurada === true,
    cscConfigurado: cfg.nfce?.cscConfigurado === true,
    idCsc: cfg.nfce?.idCsc || null,
    acoes: [],
    observacao: diag.observacao,
  };

  if (!cfg.certificado?.arquivoExiste) {
    checklist.acoes.push(
      "Certificado A1: informe o caminho do .pfx em Configuração fiscal.",
    );
  }
  if (!cfg.certificado?.senhaConfigurada) {
    checklist.acoes.push("Certificado A1: configure a senha em Configuração fiscal.");
  }
  if (!cfg.nfce?.cscConfigurado) {
    checklist.acoes.push("CSC NFC-e: configure Id CSC e token em Configuração fiscal.");
  }
  if (!diag.ok && diag.motivo) {
    checklist.acoes.push(diag.motivo);
  }

  checklist.pronto =
    checklist.certificadoExiste &&
    checklist.senhaConfigurada &&
    checklist.cscConfigurado &&
    diag.ok;
  checklist.ok = checklist.acoes.length === 0 || checklist.pronto;
  return checklist;
}

async function validarAsyncLib() {
  return validarLib();
}

function validar() {
  if (isLibDriver()) return validarLib();
  return acbrNfceSetup.validar();
}

async function validarAsync() {
  if (isLibDriver()) return validarAsyncLib();
  return acbrNfceSetup.validarAsync();
}

async function garantirPronto() {
  return validarAsync();
}

async function inicializar() {
  const fiscalDriver = require("./fiscalDriver");
  if (!fiscalDriver.EMISSAO_FISCAL) return { ok: true, fiscal: false };
  return validarAsync();
}

function status() {
  if (isLibDriver()) return validarLib();
  return acbrNfceSetup.status();
}

module.exports = {
  validar,
  validarAsync,
  garantirPronto,
  inicializar,
  status,
  isLibDriver,
  lerDiagnosticoLib,
  secaoNfce,
};

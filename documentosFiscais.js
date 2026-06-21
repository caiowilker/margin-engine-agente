// Persistência local de XML/PDF fiscal
const fs = require("fs");
const path = require("path");
const { PATHS } = require("./marginPaths");
const fiscalStorage = require("./fiscalStorage");
const auditLog = require("./auditLog");
const log = require("./logger").child({ modulo: "documentos_fiscais" });

function salvarComVerificacaoDisco(tipo, dir, salvarFn) {
  const minMap = {
    xml: fiscalStorage.MIN_MB_XML,
    pdf: fiscalStorage.MIN_MB_PDF,
    backup: fiscalStorage.MIN_MB_BACKUP,
  };
  const minMB = minMap[tipo] || 50;
  const check = fiscalStorage.checkDiskSpace(dir, minMB);
  if (!check.ok) {
    auditLog.registrar("DISK_SPACE_INSUFICIENTE", {
      tipo,
      livresMB: check.livresMB,
      minimoMB: minMB,
      path: dir,
    });
    log.warn(
      { tipo, livresMB: check.livresMB, minimoMB: minMB },
      "Salvamento local ignorado — disco insuficiente (emissão continua)",
    );
    fiscalStorage.setModoDegradado(true);
    return null;
  }
  return salvarFn();
}

function salvarXmlAutorizado(chave, xmlContent) {
  return salvarComVerificacaoDisco("xml", PATHS.xml, () => {
    const file = path.join(PATHS.xml, `${chave}-nfe.xml`);
    fs.writeFileSync(file, xmlContent, "utf8");
    backup(file);
    return file;
  });
}

function salvarXmlCancelamento(chave, xmlContent) {
  return salvarComVerificacaoDisco("xml", PATHS.cancelamentos, () => {
    const file = path.join(PATHS.cancelamentos, `${chave}-canc.xml`);
    fs.writeFileSync(file, xmlContent, "utf8");
    backup(file);
    return file;
  });
}

function salvarXmlInutilizacao(serie, ini, fim, xmlContent) {
  return salvarComVerificacaoDisco("xml", PATHS.xml, () => {
    const file = path.join(PATHS.xml, `inutilizacao-${serie}-${ini}-${fim}.xml`);
    fs.writeFileSync(file, xmlContent, "utf8");
    backup(file);
    return file;
  });
}

function salvarPdfDanfce(chave, pdfBuffer) {
  return salvarComVerificacaoDisco("pdf", PATHS.pdf, () => {
    const file = path.join(PATHS.pdf, `${chave}-danfce.pdf`);
    fs.writeFileSync(file, pdfBuffer);
    backup(file);
    return file;
  });
}

function salvarPdfPlaceholder(chave, texto) {
  return salvarComVerificacaoDisco("pdf", PATHS.pdf, () => {
    const file = path.join(PATHS.pdf, `${chave}-danfce.txt`);
    fs.writeFileSync(
      file,
      texto || `DANFC-e ${chave} — gerar via ACBr se PDF indisponível`,
      "utf8",
    );
    return file;
  });
}

function lerArquivo(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath);
}

function lerArquivoBase64(filePath) {
  const buf = lerArquivo(filePath);
  return buf ? buf.toString("base64") : null;
}

function isPdfValid(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  if (!filePath.toLowerCase().endsWith(".pdf")) return false;
  const buf = fs.readFileSync(filePath);
  return buf.length > 128 && buf.slice(0, 4).toString() === "%PDF";
}

function backup(sourceFile) {
  try {
    const check = fiscalStorage.checkDiskSpace(
      PATHS.backup,
      fiscalStorage.MIN_MB_BACKUP,
    );
    if (!check.ok) {
      auditLog.registrar("DISK_SPACE_INSUFICIENTE", {
        tipo: "backup",
        livresMB: check.livresMB,
        minimoMB: fiscalStorage.MIN_MB_BACKUP,
        path: PATHS.backup,
      });
      log.warn(
        { livresMB: check.livresMB },
        "Backup local ignorado — disco insuficiente",
      );
      fiscalStorage.setModoDegradado(true);
      return null;
    }
    const base = path.basename(sourceFile);
    const dest = path.join(PATHS.backup, `${Date.now()}-${base}`);
    fs.copyFileSync(sourceFile, dest);
    return dest;
  } catch (_) {
    return null;
  }
}

function extrairXmlDaResposta(resposta) {
  if (!resposta) return null;
  const idx = resposta.indexOf("<?xml");
  if (idx >= 0) return resposta.slice(idx).trim();
  const xmlMatch = resposta.match(
    /<(?:nfeProc|NFe|procEventoNFe)[\s\S]*<\/(?:nfeProc|NFe|procEventoNFe)>/i,
  );
  return xmlMatch ? xmlMatch[0] : null;
}

/** URL/payload do QR Code NFC-e (tag infNFeSupl/qrCode no XML autorizado). */
function extrairQrCodeDoXml(xml) {
  if (!xml || typeof xml !== "string") return null;
  const cdata = xml.match(/<qrCode>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/qrCode>/i);
  if (cdata?.[1]) return cdata[1].trim();
  const simples = xml.match(/<qrCode>([^<]+)<\/qrCode>/i);
  return simples?.[1]?.trim() || null;
}

module.exports = {
  salvarXmlAutorizado,
  salvarXmlCancelamento,
  salvarXmlInutilizacao,
  salvarPdfDanfce,
  salvarPdfPlaceholder,
  lerArquivo,
  lerArquivoBase64,
  isPdfValid,
  extrairXmlDaResposta,
  extrairQrCodeDoXml,
};

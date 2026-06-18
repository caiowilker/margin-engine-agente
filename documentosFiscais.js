// Persistência local de XML/PDF fiscal
const fs = require("fs");
const path = require("path");
const { PATHS } = require("./marginPaths");

function salvarXmlAutorizado(chave, xmlContent) {
  const file = path.join(PATHS.xml, `${chave}-nfe.xml`);
  fs.writeFileSync(file, xmlContent, "utf8");
  backup(file);
  return file;
}

function salvarXmlCancelamento(chave, xmlContent) {
  const file = path.join(PATHS.cancelamentos, `${chave}-canc.xml`);
  fs.writeFileSync(file, xmlContent, "utf8");
  backup(file);
  return file;
}

function salvarXmlInutilizacao(serie, ini, fim, xmlContent) {
  const file = path.join(
    PATHS.xml,
    `inutilizacao-${serie}-${ini}-${fim}.xml`,
  );
  fs.writeFileSync(file, xmlContent, "utf8");
  backup(file);
  return file;
}

function salvarPdfDanfce(chave, pdfBuffer) {
  const file = path.join(PATHS.pdf, `${chave}-danfce.pdf`);
  fs.writeFileSync(file, pdfBuffer);
  backup(file);
  return file;
}

function salvarPdfPlaceholder(chave, texto) {
  const file = path.join(PATHS.pdf, `${chave}-danfce.txt`);
  fs.writeFileSync(
    file,
    texto || `DANFC-e ${chave} — gerar via ACBr se PDF indisponível`,
    "utf8",
  );
  return file;
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
    const base = path.basename(sourceFile);
    const dest = path.join(PATHS.backup, `${Date.now()}-${base}`);
    fs.copyFileSync(sourceFile, dest);
  } catch (_) {
    /* backup best-effort */
  }
}

function extrairXmlDaResposta(resposta) {
  if (!resposta) return null;
  const idx = resposta.indexOf("<?xml");
  if (idx >= 0) return resposta.slice(idx).trim();
  const xmlMatch = resposta.match(/<(?:nfeProc|NFe|procEventoNFe)[\s\S]*<\/(?:nfeProc|NFe|procEventoNFe)>/i);
  return xmlMatch ? xmlMatch[0] : null;
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
};

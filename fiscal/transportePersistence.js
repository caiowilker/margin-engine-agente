"use strict";

const fs = require("fs");
const path = require("path");
const { PATHS, ensureDirs } = require("../marginPaths");

function safeKey(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "");
}

function documentDirectories(documento) {
  ensureDirs();
  const key = documento === "mdfe" ? "mdfe" : "cte";
  const xml = path.join(PATHS.xml, key);
  const pdf = path.join(PATHS.pdf, key);
  fs.mkdirSync(xml, { recursive: true });
  fs.mkdirSync(pdf, { recursive: true });
  return { xml, pdf };
}

function persistirArtefatosTransporte(documento, chave, resultado) {
  const dirs = documentDirectories(documento);
  const key = safeKey(chave || resultado?.chave);
  if (!key) throw new Error("Chave do documento de transporte ausente.");
  let xmlPath = resultado?.xmlPath || null;
  let pdfPath = resultado?.pdfPath || null;

  if (resultado?.xml && String(resultado.xml).trim()) {
    xmlPath = path.join(dirs.xml, `${key}-proc${documento === "mdfe" ? "MDFe" : "CTe"}.xml`);
    fs.writeFileSync(xmlPath, String(resultado.xml), "utf8");
  }
  if (resultado?.pdf && Buffer.isBuffer(resultado.pdf)) {
    pdfPath = path.join(dirs.pdf, `${key}-${documento}.pdf`);
    fs.writeFileSync(pdfPath, resultado.pdf);
  } else if (resultado?.pdfBase64) {
    pdfPath = path.join(dirs.pdf, `${key}-${documento}.pdf`);
    fs.writeFileSync(pdfPath, Buffer.from(resultado.pdfBase64, "base64"));
  }
  if (pdfPath && fs.existsSync(pdfPath) && path.dirname(path.resolve(pdfPath)) !== path.resolve(dirs.pdf)) {
    const canonical = path.join(dirs.pdf, `${key}-${documento}.pdf`);
    fs.copyFileSync(pdfPath, canonical);
    pdfPath = canonical;
  }
  if (!xmlPath || !fs.existsSync(xmlPath)) {
    const error = new Error(`XML autorizado de ${documento.toUpperCase()} não foi persistido.`);
    error.incerto = true;
    error.chaveConsulta = key;
    throw error;
  }
  return { xmlPath, pdfPath };
}

module.exports = { documentDirectories, persistirArtefatosTransporte };

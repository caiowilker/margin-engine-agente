"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const iconv = require("iconv-lite");
const { exigirPermitido, TMP_PREFIX } = require("./allowlist");
const { comRetry, enriquecerErroRede } = require("./pasta");
const log = require("../../logger").child({ modulo: "balanca_write" });

function encodeConteudo(bufferOrString, encoding) {
  if (Buffer.isBuffer(bufferOrString)) {
    return bufferOrString;
  }
  const enc = encoding || "windows-1252";
  if (!iconv.encodingExists(enc)) {
    const err = new Error(
      `Encoding não suportado: ${enc}. Use windows-1252 ou utf-8. PRECISA CONFIRMAR EM BALANÇA REAL.`,
    );
    err.code = "BALANCA_ENCODING";
    throw err;
  }
  return iconv.encode(String(bufferOrString), enc);
}

function garantirCrLf(buf) {
  if (!buf || buf.length === 0) return Buffer.alloc(0);
  // Se já termina com CR+LF, ok; não reescreve linhas internas (backend já gera CR+LF)
  return buf;
}

/**
 * Escrita atômica na mesma pasta: tmp → fsync → rename.
 * Nunca apaga arquivos do MGV.
 */
function escreverAtomico(pasta, nomeFinal, conteudo, encoding) {
  exigirPermitido(nomeFinal);
  const dest = path.join(pasta, nomeFinal);
  const tmp = path.join(
    pasta,
    `${TMP_PREFIX}${nomeFinal}.${process.pid}.${Date.now()}.tmp`,
  );
  const data = garantirCrLf(encodeConteudo(conteudo, encoding));

  return comRetry(() => {
    fs.writeFileSync(tmp, data, { flag: "w" });
    const fd = fs.openSync(tmp, "r+");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmp, dest);
    } catch (err) {
      // Windows: destino pode existir em race — não sobrescrever arquivos MGV sem ser nosso tmp
      if (fs.existsSync(dest)) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
        throw enriquecerErroRede(err);
      }
      fs.copyFileSync(tmp, dest);
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
    log.info({ nome: nomeFinal, bytes: data.length }, "Arquivo escrito atomicamente");
    return { nome: nomeFinal, caminho: dest, bytes: data.length, sha256: sha256(data) };
  });
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function validarSha256(conteudoBase64, sha256Esperado) {
  const buf = Buffer.from(conteudoBase64 || "", "base64");
  const dig = sha256(buf);
  if (
    sha256Esperado &&
    String(sha256Esperado).toLowerCase() !== dig.toLowerCase()
  ) {
    const err = new Error(
      `SHA-256 divergente para o arquivo (esperado ${sha256Esperado}, obtido ${dig}).`,
    );
    err.code = "BALANCA_SHA256";
    throw err;
  }
  return buf;
}

/**
 * Ordem: ITENSMGV, EXCLITEM, PRECOMGV, ARQSOK por último.
 */
function ordenarArquivos(arquivos) {
  const ordem = {
    "ITENSMGV.TXT": 1,
    "Itensmgv.txt": 1,
    "EXCLITEM.TXT": 2,
    "Exclitem.txt": 2,
    "PRECOMGV.TXT": 3,
    "Precomgv.txt": 3,
    "ARQSOK.TXT": 99,
    "Arqsok.txt": 99,
  };
  return [...arquivos].sort(
    (a, b) => (ordem[a.nome] || 50) - (ordem[b.nome] || 50),
  );
}

module.exports = {
  encodeConteudo,
  escreverAtomico,
  validarSha256,
  ordenarArquivos,
  sha256,
};

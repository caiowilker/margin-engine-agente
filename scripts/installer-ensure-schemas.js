#!/usr/bin/env node
/**
 * Garante schemas XSD (NFe + raiz + NFSe) no destino do instalador / ProgramData.
 *
 * Fonte canônica: `{appDir}/acbrlib/data/Schemas`
 * Destino operacional: `%ProgramData%/MarginEngine/acbr/schemas/NFe` (e espelho NFSe).
 *
 * Deve rodar em toda instalação/reparo/update — independente de emissaoFiscal.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const MIN_NFE_XSD = 10;
const MIN_NFSE_XSD = 50;

function contarXsd(dir) {
  if (!dir || !fs.existsSync(dir)) return 0;
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) n += contarXsd(p);
    else if (entry.isFile() && /\.xsd$/i.test(entry.name)) n += 1;
  }
  return n;
}

/**
 * Copia árvore de .xsd origem → destino.
 * Atualiza se tamanho divergir; `onlyIfMissing` pula existentes.
 */
function copiarSchemas(origem, destino, opts = {}) {
  if (!origem || !fs.existsSync(origem)) return 0;
  const onlyIfMissing = opts.onlyIfMissing === true;
  fs.mkdirSync(destino, { recursive: true });
  let copiados = 0;
  for (const entry of fs.readdirSync(origem, { withFileTypes: true })) {
    const src = path.join(origem, entry.name);
    const dst = path.join(destino, entry.name);
    if (entry.isDirectory()) {
      copiados += copiarSchemas(src, dst, opts);
      continue;
    }
    if (!entry.isFile() || !/\.xsd$/i.test(entry.name)) continue;
    if (onlyIfMissing && fs.existsSync(dst)) continue;
    if (fs.existsSync(dst)) {
      try {
        if (fs.statSync(src).size === fs.statSync(dst).size) continue;
      } catch (_) {
        /* regrava */
      }
    }
    fs.copyFileSync(src, dst);
    copiados += 1;
  }
  return copiados;
}

function bundledSchemasRoot(appDir) {
  return path.join(appDir, "acbrlib", "data", "Schemas");
}

function contarXsdRaiz(dir) {
  if (!dir || !fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((n) => /\.xsd$/i.test(n)).length;
}

/**
 * @param {string} appDir — pasta {app}\app do instalador
 * @param {string} marginRoot — ProgramData\MarginEngine
 * @param {{ logger?: (msg: string) => void, onlyIfMissing?: boolean, requireNfse?: boolean }} [opts]
 */
function ensureInstallerSchemas(appDir, marginRoot, opts = {}) {
  const log = typeof opts.logger === "function" ? opts.logger : () => {};
  const bundledRoot = bundledSchemasRoot(appDir);
  const bundledNfe = path.join(bundledRoot, "NFe");
  const bundledNfse = path.join(bundledRoot, "NFSe");
  const destNfe = path.join(marginRoot, "acbr", "schemas", "NFe");
  const destNfse = path.join(marginRoot, "acbr", "schemas", "NFSe");
  const copyOpts = { onlyIfMissing: opts.onlyIfMissing === true };

  const bundledCount = contarXsd(bundledRoot);
  if (bundledCount < MIN_NFE_XSD) {
    const error =
      `schemas XSD insuficientes no payload (${bundledCount}) em ${bundledRoot} — ` +
      "o build precisa incluir acbrlib/data/Schemas (NFe).";
    log(`[installer] ERRO: ${error}`);
    return {
      ok: false,
      totalNfe: 0,
      totalNfse: 0,
      copiados: 0,
      bundledRoot,
      destNfe,
      error,
    };
  }

  let copiados = 0;
  fs.mkdirSync(destNfe, { recursive: true });

  if (fs.existsSync(bundledNfe)) {
    copiados += copiarSchemas(bundledNfe, destNfe, copyOpts);
  }

  // XSDs soltos na raiz Schemas (layout legado ACBr) → pasta NFe operacional
  if (fs.existsSync(bundledRoot)) {
    for (const entry of fs.readdirSync(bundledRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.xsd$/i.test(entry.name)) continue;
      const src = path.join(bundledRoot, entry.name);
      const dst = path.join(destNfe, entry.name);
      if (copyOpts.onlyIfMissing && fs.existsSync(dst)) continue;
      if (fs.existsSync(dst)) {
        try {
          if (fs.statSync(src).size === fs.statSync(dst).size) continue;
        } catch (_) {
          /* regrava */
        }
      }
      fs.copyFileSync(src, dst);
      copiados += 1;
    }
  }

  if (fs.existsSync(bundledNfse)) {
    copiados += copiarSchemas(bundledNfse, destNfse, copyOpts);
  }

  const totalNfe = contarXsd(destNfe);
  const totalNfse = contarXsd(destNfse);
  const requireNfse = opts.requireNfse !== false && fs.existsSync(bundledNfse);

  if (totalNfe < MIN_NFE_XSD) {
    const error =
      `schemas NFe insuficientes após cópia (${totalNfe}) → ${destNfe}. Origem: ${bundledRoot}`;
    log(`[installer] ERRO: ${error}`);
    return { ok: false, totalNfe, totalNfse, copiados, bundledRoot, destNfe, error };
  }

  if (requireNfse && totalNfse < MIN_NFSE_XSD) {
    const error =
      `schemas NFS-e insuficientes após cópia (${totalNfse}) → ${destNfse}. ` +
      `Esperado >= ${MIN_NFSE_XSD}. Origem: ${bundledNfse}`;
    log(`[installer] ERRO: ${error}`);
    return { ok: false, totalNfe, totalNfse, copiados, bundledRoot, destNfe, error };
  }

  log(
    `[installer] schemas OK — NFe=${totalNfe} NFSe=${totalNfse} novos/atualizados=${copiados} dest=${destNfe}`,
  );
  return { ok: true, totalNfe, totalNfse, copiados, bundledRoot, destNfe };
}

/** Valida só o payload (sem ProgramData) — assert-installer-payload / sync. */
function assertBundledSchemas(appDir, opts = {}) {
  const root = bundledSchemasRoot(appDir);
  const nfe = path.join(root, "NFe");
  const nfse = path.join(root, "NFSe");
  const total = contarXsd(root);
  const totalNfe = contarXsd(nfe) + contarXsdRaiz(root);
  const totalNfse = contarXsd(nfse);
  const errors = [];
  if (total < MIN_NFE_XSD && totalNfe < MIN_NFE_XSD) {
    errors.push(`Schemas incompletos (${total} .xsd) em ${root}`);
  }
  if (opts.requireNfse !== false && totalNfse < MIN_NFSE_XSD) {
    errors.push(`Schemas NFS-e incompletos (${totalNfse} .xsd) em ${nfse}`);
  }
  return { ok: errors.length === 0, total, totalNfe, totalNfse, root, errors };
}

module.exports = {
  MIN_NFE_XSD,
  MIN_NFSE_XSD,
  contarXsd,
  copiarSchemas,
  bundledSchemasRoot,
  ensureInstallerSchemas,
  assertBundledSchemas,
};

"use strict";

/** Allowlist alinhada ao backend (BalancaCargaArquivoAllowlist). */
const NOMES_PERMITIDOS = new Set([
  "ITENSMGV.TXT",
  "PRECOMGV.TXT",
  "EXCLITEM.TXT",
  "ARQSOK.TXT",
  "Itensmgv.txt",
  "Precomgv.txt",
  "Exclitem.txt",
  "Arqsok.txt",
  "CADTXT.TXT",
  "Cadtxt.txt",
  "RAMUZA_ORIGINAL.TXT",
  "Ramuza_original.txt",
  "PRODUTOS.TXT",
  "Produtos.txt",
]);

const NOMES_OCUPACAO = [
  "ITENSMGV.TXT",
  "PRECOMGV.TXT",
  "EXCLITEM.TXT",
  "ARQSOK.TXT",
  "Itensmgv.txt",
  "Precomgv.txt",
  "Exclitem.txt",
  "Arqsok.txt",
  "CADTXT.TXT",
  "RAMUZA_ORIGINAL.TXT",
  "PRODUTOS.TXT",
];

const TMP_PREFIX = ".me-balanca-";

function nomePermitido(nome) {
  if (typeof nome !== "string") return false;
  if (NOMES_PERMITIDOS.has(nome)) return true;
  const up = nome.toUpperCase();
  for (const n of NOMES_PERMITIDOS) {
    if (n.toUpperCase() === up) return true;
  }
  return false;
}

function exigirPermitido(nome) {
  if (!nomePermitido(nome)) {
    const err = new Error(
      `Nome de arquivo não permitido: ${nome}.`,
    );
    err.code = "BALANCA_ALLOWLIST";
    throw err;
  }
}

module.exports = {
  NOMES_PERMITIDOS,
  NOMES_OCUPACAO,
  TMP_PREFIX,
  nomePermitido,
  exigirPermitido,
};

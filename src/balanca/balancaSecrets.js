/**
 * Cofre de credenciais MGV7 WS — espelho do padrão fiscalSecrets.
 * Nunca grava usuario/senha/palavraChave em balanca-carga.json nem no backend.
 */
"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const log = require("../../logger").child({ modulo: "balanca_secrets" });
const { getDirectoryManager } = require("../../runtime/directoryManager");

const SERVICE_NAME = "PDVMarginEngine";
const ACCOUNT_NAME = "balanca-ws-secrets";

function fallbackVaultPath() {
  if (process.env.BALANCA_VAULT_OVERRIDE) {
    return process.env.BALANCA_VAULT_OVERRIDE;
  }
  return getDirectoryManager().file("agent", ".balanca-vault");
}

let KeyringEntry = null;
try {
  const keyring = require("@napi-rs/keyring");
  KeyringEntry = keyring.Entry;
} catch (_) {}

function getEntry() {
  if (!KeyringEntry) return null;
  try {
    return new KeyringEntry(SERVICE_NAME, ACCOUNT_NAME);
  } catch (_) {
    return null;
  }
}

function derivarChaveMaquina() {
  const seed = [os.hostname(), os.platform(), os.arch(), "balanca-ws"].join("|");
  return crypto.createHash("sha256").update(seed).digest();
}

function encriptar(texto) {
  const chave = derivarChaveMaquina();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", chave, iv);
  const enc = Buffer.concat([cipher.update(texto, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decriptar(base64) {
  const buf = Buffer.from(base64, "base64");
  const chave = derivarChaveMaquina();
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", chave, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc) + decipher.final("utf8");
}

function lerArquivoVault() {
  if (!fs.existsSync(fallbackVaultPath())) return {};
  try {
    return JSON.parse(decriptar(fs.readFileSync(fallbackVaultPath(), "utf8")));
  } catch (err) {
    log.error({ err: err.message }, "Falha ao decriptar vault balança");
    return {};
  }
}

function gravarArquivoVault(dados) {
  const dir = path.dirname(fallbackVaultPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fallbackVaultPath(), encriptar(JSON.stringify(dados || {})), "utf8");
}

function lerKeyring() {
  const entry = getEntry();
  if (!entry) return null;
  try {
    const json = entry.getPassword();
    if (json) return JSON.parse(json);
  } catch (err) {
    if (!String(err.message || "").includes("No entry")) {
      log.warn({ err: err.message }, "keyring balança falhou ao ler");
    }
  }
  return null;
}

function gravarKeyring(dados) {
  const entry = getEntry();
  if (!entry) return false;
  try {
    entry.setPassword(JSON.stringify(dados || {}));
    return true;
  } catch (err) {
    log.warn({ err: err.message }, "keyring balança falhou ao salvar");
    return false;
  }
}

function mergeSecrets(a, b) {
  const left = a && typeof a === "object" ? a : {};
  const right = b && typeof b === "object" ? b : {};
  return {
    usuario: left.usuario || right.usuario || "",
    senha: left.senha || right.senha || "",
    palavraChave: left.palavraChave || right.palavraChave || "",
  };
}

function lerSync() {
  return mergeSecrets(lerKeyring(), lerArquivoVault());
}

function salvarSync(dados) {
  const merged = mergeSecrets(dados || {}, lerSync());
  gravarArquivoVault(merged);
  gravarKeyring(merged);
  return { ok: true };
}

/** Máscara para logs — nunca expõe segredo. */
function resumoSeguro() {
  const s = lerSync();
  return {
    temUsuario: !!s.usuario,
    temSenha: !!s.senha,
    temPalavraChave: !!s.palavraChave,
  };
}

module.exports = {
  fallbackVaultPath,
  lerSync,
  salvarSync,
  resumoSeguro,
};

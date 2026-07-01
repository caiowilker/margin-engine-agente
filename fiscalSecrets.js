/**
 * Cofre de segredos fiscais (senha A1, CSC) — fora de .env/INI em texto puro.
 * Usa o mesmo backend do credenciais.js (@napi-rs/keyring ou vault criptografado).
 */
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const log = require("./logger").child({ modulo: "fiscal_secrets" });
const { getDirectoryManager } = require("./runtime/directoryManager");

const SERVICE_NAME = "PDVMarginEngine";
const ACCOUNT_NAME = "fiscal-secrets";

function fallbackVaultPath() {
  return getDirectoryManager().file("agent", ".fiscal-vault");
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
  const seed = [os.hostname(), os.platform(), os.arch(), "fiscal"].join("|");
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

async function salvar(dados) {
  const json = JSON.stringify(dados || {});
  const entry = getEntry();
  if (entry) {
    try {
      entry.setPassword(json);
      return;
    } catch (err) {
      log.warn({ err: err.message }, "keyring fiscal falhou ao salvar");
    }
  }
  const dir = path.dirname(fallbackVaultPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fallbackVaultPath(), encriptar(json), "utf8");
}

async function ler() {
  const entry = getEntry();
  if (entry) {
    try {
      const json = entry.getPassword();
      if (json) return JSON.parse(json);
    } catch (err) {
      if (!err.message?.includes("No entry")) {
        log.warn({ err: err.message }, "keyring fiscal falhou ao ler");
      }
    }
  }
  if (fs.existsSync(fallbackVaultPath())) {
    try {
      return JSON.parse(decriptar(fs.readFileSync(fallbackVaultPath(), "utf8")));
    } catch (err) {
      log.error({ err: err.message }, "Falha ao decriptar vault fiscal");
    }
  }
  return {};
}

async function limpar() {
  const entry = getEntry();
  if (entry) {
    try {
      entry.deletePassword();
    } catch (_) {}
  }
  if (fs.existsSync(fallbackVaultPath())) {
    fs.unlinkSync(fallbackVaultPath());
  }
}

function salvarSync(dados) {
  const atual = lerSync();
  const merged = { ...atual, ...(dados || {}) };
  const json = JSON.stringify(merged);
  const entry = getEntry();
  if (entry) {
    try {
      entry.setPassword(json);
      return merged;
    } catch (err) {
      log.warn({ err: err.message }, "keyring fiscal falhou ao salvar (sync)");
    }
  }
  const dir = path.dirname(fallbackVaultPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fallbackVaultPath(), encriptar(json), "utf8");
  return merged;
}

function lerSync() {
  if (!fs.existsSync(fallbackVaultPath())) return {};
  try {
    return JSON.parse(decriptar(fs.readFileSync(fallbackVaultPath(), "utf8")));
  } catch (_) {
    return {};
  }
}

module.exports = { salvar, salvarSync, ler, lerSync, limpar };

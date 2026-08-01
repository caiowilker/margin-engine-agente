/**
 * Cofre de segredos fiscais (senha A1, CSC) — fora de .env/INI em texto puro.
 *
 * IMPORTANTE (serviço Windows):
 * - @napi-rs/keyring é por usuário. O SCM costuma rodar como LocalSystem.
 * - Senha salva no keyring do usuário interativo NÃO aparece no serviço.
 * - Por isso SEMPRE espelhamos no arquivo .fiscal-vault (ProgramData) e
 *   na leitura fazemos merge keyring + arquivo.
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

function lerArquivoVault() {
  if (!fs.existsSync(fallbackVaultPath())) return {};
  try {
    return JSON.parse(decriptar(fs.readFileSync(fallbackVaultPath(), "utf8")));
  } catch (err) {
    log.error({ err: err.message }, "Falha ao decriptar vault fiscal");
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
    if (!err.message?.includes("No entry")) {
      log.warn({ err: err.message }, "keyring fiscal falhou ao ler");
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
    log.warn({ err: err.message }, "keyring fiscal falhou ao salvar");
    return false;
  }
}

/** Prefere o lado que tem senha/CSC preenchidos. */
function mergeSecrets(a, b) {
  const left = a && typeof a === "object" ? a : {};
  const right = b && typeof b === "object" ? b : {};
  return {
    ...right,
    ...left,
    certificadoSenha: left.certificadoSenha || right.certificadoSenha || "",
    nfceCsc: left.nfceCsc || right.nfceCsc || "",
  };
}

async function salvar(dados) {
  const merged = mergeSecrets(dados || {}, lerSync());
  const okKeyring = gravarKeyring(merged);
  gravarArquivoVault(merged);
  if (!okKeyring) {
    log.info({ metric: "fiscal_secrets.file_only" }, "Segredos fiscais gravados só no arquivo (sem keyring)");
  }
}

async function ler() {
  return lerSync();
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
  const merged = mergeSecrets(dados || {}, lerSync());
  const okKeyring = gravarKeyring(merged);
  gravarArquivoVault(merged);
  if (!okKeyring) {
    log.info({ metric: "fiscal_secrets.file_only" }, "Segredos fiscais gravados só no arquivo (sem keyring)");
  }
  return merged;
}

function lerSync() {
  const fromKeyring = lerKeyring();
  const fromFile = lerArquivoVault();
  const merged = mergeSecrets(fromKeyring || {}, fromFile);
  if (!merged.certificadoSenha && (fromKeyring || Object.keys(fromFile).length)) {
    log.warn(
      {
        keyring: !!fromKeyring?.certificadoSenha,
        fileVault: !!fromFile.certificadoSenha,
        metric: "fiscal_secrets.senha_ausente",
      },
      "Cofre fiscal sem senha do certificado — serviço Windows pode não ver o keyring do usuário",
    );
  }
  return merged;
}

module.exports = { salvar, salvarSync, ler, lerSync, limpar, fallbackVaultPath };

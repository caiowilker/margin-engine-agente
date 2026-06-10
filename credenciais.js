// ============================================================
// PDV Margin Engine - Cofre de Credenciais v2.0
//
// MUDANCA v2.0:
//   - Troca keytar (abandonado, sem suporte Node 24) por
//     @napi-rs/keyring — mesma funcionalidade, mantido
//     ativamente, prebuilds para Node 18/20/22/24.
//
// Armazena o token JWT e backendUrl no Windows Credential Manager
// completamente fora do sistema de arquivos.
// Nenhum arquivo no disco contem o token em texto puro.
//
// Fallback: se @napi-rs/keyring nao estiver disponivel (Linux/dev),
// criptografa as credenciais com AES-256-GCM usando uma chave
// derivada de identificadores fixos da maquina.
//
// API publica:
//   await credenciais.salvar({ backendUrl, backendToken, ... })
//   await credenciais.ler()   -> objeto ou null
//   await credenciais.limpar()
// ============================================================

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const log = require("./logger").child({ modulo: "credenciais" });

const SERVICE_NAME = "PDVMarginEngine";
const ACCOUNT_NAME = "agente-local";
const FALLBACK_PATH = path.join(__dirname, "data", ".vault");

// -- Tenta carregar @napi-rs/keyring ------------------------------------------
// API: Entry.setPassword / Entry.getPassword / Entry.deletePassword
// (compativel com keytar, mas com instanciacao diferente)
let KeyringEntry = null;
try {
  const keyring = require("@napi-rs/keyring");
  // @napi-rs/keyring exporta uma classe Entry
  KeyringEntry = keyring.Entry;
  log.info("Cofre: usando @napi-rs/keyring (Windows Credential Manager)");
} catch (_) {
  log.warn(
    "@napi-rs/keyring indisponivel - usando fallback criptografado em arquivo",
  );
}

// Cria uma entrada do keyring para o servico/conta
function getEntry() {
  if (!KeyringEntry) return null;
  try {
    return new KeyringEntry(SERVICE_NAME, ACCOUNT_NAME);
  } catch (_) {
    return null;
  }
}

// -- Chave de criptografia para o fallback ------------------------------------
// Derivada de informacoes fixas da maquina para que o arquivo so funcione
// na mesma maquina onde foi gerado.
function derivarChaveMaquina() {
  const seed = [os.hostname(), os.platform(), os.arch()].join("|");
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

// -- API publica --------------------------------------------------------------

/**
 * Salva as credenciais no cofre.
 * @param {object} dados - { backendUrl, backendToken, tenantId, pdvNome, dispositivoId, ativado }
 */
async function salvar(dados) {
  const json = JSON.stringify(dados);
  const entry = getEntry();

  if (entry) {
    try {
      entry.setPassword(json);
      log.info("Credenciais salvas no Windows Credential Manager");
      return;
    } catch (err) {
      log.warn(
        { err: err.message },
        "keyring falhou ao salvar - usando fallback",
      );
    }
  }

  // Fallback: arquivo criptografado
  const dir = path.dirname(FALLBACK_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FALLBACK_PATH, encriptar(json), "utf8");
  log.info("Credenciais salvas em arquivo criptografado (fallback)");
}

/**
 * Le as credenciais do cofre.
 * @returns {object|null}
 */
async function ler() {
  const entry = getEntry();

  if (entry) {
    try {
      const json = entry.getPassword();
      if (json) return JSON.parse(json);
    } catch (err) {
      // Erro "no entry" e esperado quando ainda nao foi ativado
      if (!err.message?.includes("No entry")) {
        log.warn(
          { err: err.message },
          "keyring falhou ao ler - tentando fallback",
        );
      }
    }
  }

  // Fallback: arquivo criptografado
  if (fs.existsSync(FALLBACK_PATH)) {
    try {
      const json = decriptar(fs.readFileSync(FALLBACK_PATH, "utf8"));
      return JSON.parse(json);
    } catch (err) {
      log.error(
        { err: err.message },
        "Falha ao decriptar vault - credenciais perdidas",
      );
      return null;
    }
  }

  // Migracao: se ainda existir o antigo config.json em texto puro, migra
  const legadoPath = path.join(__dirname, "data", "config.json");
  if (fs.existsSync(legadoPath)) {
    try {
      const legado = JSON.parse(fs.readFileSync(legadoPath, "utf8"));
      if (legado.backendToken) {
        log.warn("Migrando credenciais de config.json para cofre seguro...");
        await salvar(legado);
        legado.backendToken = "[migrado para cofre seguro]";
        fs.writeFileSync(legadoPath, JSON.stringify(legado, null, 2), "utf8");
        log.info("Migracao concluida. Token removido do config.json.");
        return legado;
      }
    } catch (_) {}
  }

  return null;
}

/**
 * Remove as credenciais do cofre (usado no desativamento).
 */
async function limpar() {
  const entry = getEntry();
  if (entry) {
    try {
      entry.deletePassword();
    } catch (_) {}
  }
  if (fs.existsSync(FALLBACK_PATH)) {
    fs.unlinkSync(FALLBACK_PATH);
  }
  log.info("Credenciais removidas do cofre");
}

module.exports = { salvar, ler, limpar };

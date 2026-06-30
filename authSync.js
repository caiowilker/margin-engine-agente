/**
 * Códigos de sincronização efêmeros para troca segura do X-Agent-Token.
 */
const crypto = require("crypto");

const TTL_MS = 120_000;
const codes = new Map();

function issueSyncCode(agentToken) {
  const code = crypto.randomBytes(16).toString("hex");
  codes.set(code, { agentToken, expires: Date.now() + TTL_MS });
  return code;
}

function consumeSyncCode(code) {
  if (!code) return null;
  const entry = codes.get(code);
  codes.delete(code);
  if (!entry || entry.expires < Date.now()) return null;
  return entry.agentToken;
}

function purgeExpired() {
  const now = Date.now();
  for (const [k, v] of codes) {
    if (v.expires < now) codes.delete(k);
  }
}

module.exports = { issueSyncCode, consumeSyncCode, purgeExpired };

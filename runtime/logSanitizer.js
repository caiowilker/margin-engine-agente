/**
 * Remove dados sensíveis antes de persistir logs.
 */
const SENSITIVE_KEYS = new Set([
  "senha",
  "password",
  "passwd",
  "token",
  "jwt",
  "bearertoken",
  "authorization",
  "certificado",
  "certificate",
  "cert",
  "pfx",
  "privatekey",
  "private_key",
  "secret",
  "csc",
  "apikey",
  "api_key",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "backendtoken",
  "agenttoken",
]);

const JWT_RE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const REDACTED = "[REDACTED]";

function isSensitiveKey(key) {
  if (!key) return false;
  const k = String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (SENSITIVE_KEYS.has(k)) return true;
  return /senha|password|token|secret|cert|jwt|authorization|csc/i.test(String(key));
}

function scrubString(value) {
  const s = String(value);
  if (JWT_RE.test(s.trim())) return REDACTED;
  if (s.length > 20 && /Bearer\s+/i.test(s)) return "Bearer [REDACTED]";
  return s;
}

function sanitizeValue(value, depth = 0, seen = null) {
  if (value == null) return value;
  if (depth > 8) return "[MAX_DEPTH]";
  if (typeof value === "string") return scrubString(value);
  if (typeof value !== "object") return value;

  const tracker = seen || new WeakSet();
  if (tracker.has(value)) return "[CIRCULAR]";
  tracker.add(value);

  if (Array.isArray(value)) {
    return value.map((v) => sanitizeValue(v, depth + 1, tracker));
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message),
      stack: value.stack,
    };
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (isSensitiveKey(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = sanitizeValue(v, depth + 1, tracker);
    }
  }
  return out;
}

function sanitizeRecord(record) {
  return sanitizeValue(record);
}

module.exports = {
  sanitizeRecord,
  isSensitiveKey,
  REDACTED,
};

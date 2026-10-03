"use strict";

/**
 * Urano "Urano 12" (UDC/UBB checkout) — enquire 0x05, serial 9600 8N2.
 * Respostas comuns no mercado BR (ACBr-like):
 *   - STX + 5 dígitos gramas + ETX (alguns firmwares)
 *   - texto com "kg" / peso decimal
 *   - IIIII / NNNNN / SSSSS em frame STX/ETX
 */

const { STATUS } = require("./types");
const STX = 0x02;
const ETX = 0x03;
const ENQ = 0x05;

function parseStx5(buf) {
  let stxIdx = -1;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === STX) {
      stxIdx = i;
      break;
    }
  }
  if (stxIdx < 0) return null;
  if (buf.length < stxIdx + 7) {
    return { ok: false, needMore: true, error: "waiting_frame", consumed: stxIdx };
  }
  if (buf[stxIdx + 6] !== ETX) return null;
  const raw = buf.subarray(stxIdx + 1, stxIdx + 6).toString("ascii");
  const consumed = stxIdx + 7;
  if (raw === "IIIII" || raw === "IIIIII".slice(0, 5)) {
    return {
      ok: true,
      status: STATUS.UNSTABLE,
      stable: false,
      grams: null,
      kg: null,
      raw,
      consumed,
    };
  }
  if (raw.startsWith("NNNNN") || raw === "NNNNN") {
    return {
      ok: true,
      status: STATUS.NEGATIVE,
      stable: false,
      grams: null,
      kg: null,
      raw,
      consumed,
    };
  }
  if (raw.startsWith("SSSSS") || raw === "SSSSS") {
    return {
      ok: true,
      status: STATUS.OVERLOAD,
      stable: false,
      grams: null,
      kg: null,
      raw,
      consumed,
    };
  }
  const digits = raw.replace(/^ /, "0");
  if (!/^\d{5}$/.test(digits)) {
    return {
      ok: false,
      needMore: false,
      error: "invalid_payload",
      raw,
      consumed,
    };
  }
  const grams = parseInt(digits, 10);
  return {
    ok: true,
    status: STATUS.STABLE,
    stable: true,
    grams,
    kg: grams / 1000,
    raw,
    consumed,
  };
}

function parseTextKg(buf) {
  const text = buf.toString("latin1");
  if (/I{3,}/i.test(text) && !/\d/.test(text.replace(/I/gi, ""))) {
    return {
      ok: true,
      status: STATUS.UNSTABLE,
      stable: false,
      grams: null,
      kg: null,
      raw: "IIIII",
      consumed: buf.length,
    };
  }
  if (/-/.test(text) && /kg/i.test(text) && !/\d/.test(text.replace(/[^\d.-]/g, ""))) {
    return {
      ok: true,
      status: STATUS.NEGATIVE,
      stable: false,
      grams: null,
      kg: null,
      raw: "NNNNN",
      consumed: buf.length,
    };
  }
  // "PESO: 1,250kg" | " 1.250 kg" | "01250"
  const m =
    text.match(/(-?\d+)[.,](\d{1,3})\s*kg/i) ||
    text.match(/:\s*(-?\d+)[.,](\d{1,3})/) ||
    text.match(/(?:^|\s)(-?\d{1,5})(?:\s*kg)?\s*$/i);
  if (!m) {
    if (buf.length < 4) {
      return { ok: false, needMore: true, error: "waiting_text" };
    }
    return null;
  }
  let kg;
  if (m[2] != null) {
    const whole = m[1];
    const frac = m[2].padEnd(3, "0").slice(0, 3);
    kg = parseFloat(`${whole}.${frac}`);
  } else {
    const n = parseInt(m[1], 10);
    kg = Math.abs(n) >= 100 ? n / 1000 : n;
  }
  if (!Number.isFinite(kg)) return null;
  if (kg < 0) {
    return {
      ok: true,
      status: STATUS.NEGATIVE,
      stable: false,
      grams: null,
      kg: null,
      raw: String(kg),
      consumed: buf.length,
    };
  }
  const grams = Math.round(kg * 1000);
  return {
    ok: true,
    status: STATUS.STABLE,
    stable: true,
    grams,
    kg: grams / 1000,
    raw: String(grams).padStart(5, "0"),
    consumed: buf.length,
  };
}

function parseFrame(input) {
  const buf = Buffer.isBuffer(input)
    ? input
    : typeof input === "string"
      ? Buffer.from(input, "latin1")
      : Buffer.from(input || []);
  if (buf.length === 0) {
    return { ok: false, needMore: true, error: "empty" };
  }
  const stx = parseStx5(buf);
  if (stx) return stx;
  const text = parseTextKg(buf);
  if (text) return text;
  return { ok: false, needMore: true, error: "waiting_frame" };
}

const PROTOCOL = Object.freeze({
  id: "URANO_U12",
  label: "Urano 12 (ENQ, 8N2)",
  protocol: "URANO_U12",
  /** Lab only até H2.8 live. */
  tier: "experimental",
  ga: false,
  baudDefault: 9600,
  serial: Object.freeze({
    dataBits: 8,
    parity: "none",
    stopBits: 2,
  }),
  encodeEnquire() {
    return Buffer.from([ENQ]);
  },
  encodePricePerKg() {
    return null;
  },
  parseFrame,
  STATUS,
  ACK: 0x06,
  NACK: 0x21,
});

module.exports = PROTOCOL;

"use strict";

/**
 * Protocolo Toledo ENQ_STX5 (Prt3 / P05A / leitura Prt5).
 * Puro — sem I/O. Frame: STX + 5 ASCII + ETX.
 */

const STX = 0x02;
const ETX = 0x03;
const ENQ = 0x05;
const ACK = 0x06;
const NACK = 0x21;

const STATUS = Object.freeze({
  STABLE: "stable",
  UNSTABLE: "unstable",
  NEGATIVE: "negative",
  OVERLOAD: "overload",
});

/**
 * @param {Buffer|Uint8Array|string} input
 * @returns {{
 *   ok: boolean,
 *   status?: string,
 *   stable?: boolean,
 *   grams?: number,
 *   kg?: number,
 *   raw?: string,
 *   consumed?: number,
 *   error?: string,
 *   needMore?: boolean,
 * }}
 */
function parseFrame(input) {
  const buf = Buffer.isBuffer(input)
    ? input
    : typeof input === "string"
      ? Buffer.from(input, "latin1")
      : Buffer.from(input || []);

  if (buf.length === 0) {
    return { ok: false, needMore: true, error: "empty" };
  }

  let stxIdx = -1;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === STX) {
      stxIdx = i;
      break;
    }
  }
  if (stxIdx < 0) {
    return { ok: false, needMore: true, error: "waiting_stx" };
  }
  if (buf.length < stxIdx + 7) {
    return { ok: false, needMore: true, error: "waiting_frame", consumed: stxIdx };
  }

  const payload = buf.subarray(stxIdx + 1, stxIdx + 6);
  const etx = buf[stxIdx + 6];
  if (etx !== ETX) {
    return {
      ok: false,
      needMore: false,
      error: "invalid_etx",
      consumed: stxIdx + 1,
    };
  }

  const raw = payload.toString("ascii");
  const consumed = stxIdx + 7;

  if (raw === "IIIII") {
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
  if (raw === "NNNNN") {
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
  if (raw === "SSSSS") {
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

  // Digits or leading space / minus for some firmware variants
  const normalized = raw.replace(/ /g, "0");
  if (!/^-?\d{5}$/.test(normalized) && !/^\d{5}$/.test(normalized)) {
    // Allow first char space already handled; reject non-digit payload
    if (!/^\d{5}$/.test(raw.replace(/^ /, "0"))) {
      return {
        ok: false,
        needMore: false,
        error: "invalid_payload",
        raw,
        consumed,
      };
    }
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
  if (!Number.isFinite(grams)) {
    return {
      ok: false,
      needMore: false,
      error: "invalid_payload",
      raw,
      consumed,
    };
  }

  const kg = grams / 1000;
  return {
    ok: true,
    status: STATUS.STABLE,
    stable: true,
    grams,
    kg,
    raw,
    consumed,
  };
}

/**
 * Extrai o primeiro frame completo de um buffer acumulado.
 * @param {Buffer} buffer
 */
function extractFrame(buffer) {
  const parsed = parseFrame(buffer);
  if (parsed.needMore) {
    return { parsed, rest: buffer };
  }
  const consumed = parsed.consumed || 0;
  const rest = buffer.subarray(consumed);
  return { parsed, rest };
}

/**
 * Monta frame de preço/kg (6 dígitos = reais×100).
 * @param {number} pricePerKg
 * @returns {Buffer}
 */
function encodePricePerKg(pricePerKg) {
  const n = Number(pricePerKg);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error("pricePerKg inválido");
  }
  const centavos = Math.round(n * 100);
  if (centavos > 999999) {
    throw new Error("pricePerKg acima do limite (9999.99)");
  }
  const body = String(centavos).padStart(6, "0");
  return Buffer.from([STX, ...Buffer.from(body, "ascii"), ETX]);
}

function enqByte() {
  return Buffer.from([ENQ]);
}

module.exports = {
  STX,
  ETX,
  ENQ,
  ACK,
  NACK,
  STATUS,
  parseFrame,
  extractFrame,
  encodePricePerKg,
  enqByte,
};

"use strict";

const toledo = require("./toledoEnqStx5");
const filizolaBp = require("./filizolaBp");
const urano12 = require("./urano12");
const { ScaleError } = require("../errors");

const BY_ID = Object.freeze({
  [toledo.id]: toledo,
  ENQ_STX5: toledo,
  TOLEDO_PRIX3_ENQ_STX5: toledo,
  [filizolaBp.id]: filizolaBp,
  FILIZOLA_BP: filizolaBp,
  [urano12.id]: urano12,
  URANO12: urano12,
});

function listProtocols() {
  return [toledo, filizolaBp, urano12].map((p) => ({
    id: p.id,
    label: p.label,
    protocol: p.protocol,
    tier: p.tier === "ga" ? "ga" : "experimental",
    ga: p.ga === true,
    baudDefault: p.baudDefault,
    dataBits: p.serial.dataBits,
    parity: p.serial.parity,
    stopBits: p.serial.stopBits,
    supportsPriceDisplay: typeof p.encodePricePerKg === "function" && p.encodePricePerKg(1) != null,
  }));
}

/**
 * @param {string} [protocolOrId]
 * @param {{ strict?: boolean }} [opts]
 */
function resolveProtocol(protocolOrId, opts = {}) {
  const key = String(protocolOrId || "ENQ_STX5").trim().toUpperCase();
  const aliases = {
    ENQ_STX5: "TOLEDO_PRIX3_ENQ_STX5",
    TOLEDO: "TOLEDO_PRIX3_ENQ_STX5",
    TOLEDO_PRIX3_ENQ_STX5: "TOLEDO_PRIX3_ENQ_STX5",
    FILIZOLA_BP_ENQ_STX5: "FILIZOLA_BP_ENQ_STX5",
    FILIZOLA_BP: "FILIZOLA_BP_ENQ_STX5",
    FILIZOLA: "FILIZOLA_BP_ENQ_STX5",
    URANO_U12: "URANO_U12",
    URANO12: "URANO_U12",
    URANO: "URANO_U12",
  };
  const id = aliases[key] || key;
  const proto = BY_ID[id] || BY_ID[key];
  if (!proto) {
    if (opts.strict) {
      throw new ScaleError("SCALE_PROTOCOL_UNSUPPORTED", { detail: key });
    }
    return toledo;
  }
  return proto;
}

function isSupportedProtocol(protocolOrId) {
  try {
    resolveProtocol(protocolOrId, { strict: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  listProtocols,
  resolveProtocol,
  isSupportedProtocol,
  TOLEDO: toledo,
  FILIZOLA_BP: filizolaBp,
  URANO_U12: urano12,
};

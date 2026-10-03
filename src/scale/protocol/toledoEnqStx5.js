"use strict";

/**
 * Adapter Toledo Prix 3 — ENQ → STX+5+ETX (Prt3 / P05A).
 */

const enq = require("./enqStx5");
const { STATUS } = require("./types");

const PROTOCOL = Object.freeze({
  id: "TOLEDO_PRIX3_ENQ_STX5",
  label: "Toledo Prix 3 (ENQ → STX+5)",
  protocol: "ENQ_STX5",
  /** Produção GA — homologado. */
  tier: "ga",
  ga: true,
  baudDefault: 9600,
  serial: Object.freeze({
    dataBits: 8,
    parity: "none",
    stopBits: 1,
  }),
  encodeEnquire() {
    return enq.enqByte();
  },
  encodePricePerKg(pricePerKg) {
    return enq.encodePricePerKg(pricePerKg);
  },
  parseFrame(buf) {
    return enq.parseFrame(buf);
  },
  STATUS,
  ACK: enq.ACK,
  NACK: enq.NACK,
});

module.exports = PROTOCOL;

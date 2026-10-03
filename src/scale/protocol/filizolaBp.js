"use strict";

/**
 * Filizola linha BP — ENQ → STX+5+ETX (mercado BR / ACBr-like).
 * Frame estável: espaço ou '-' no 1º dígito; IIIII / NNNNN / SSSSS.
 * Reutiliza parser Toledo (mesmo contrato binário).
 */

const enq = require("./enqStx5");
const { STATUS } = require("./types");

const PROTOCOL = Object.freeze({
  id: "FILIZOLA_BP_ENQ_STX5",
  label: "Filizola BP (ENQ → STX+5)",
  protocol: "FILIZOLA_BP_ENQ_STX5",
  /** Lab only até H2.7 live. */
  tier: "experimental",
  ga: false,
  baudDefault: 2400,
  serial: Object.freeze({
    dataBits: 8,
    parity: "none",
    stopBits: 1,
  }),
  encodeEnquire() {
    return enq.enqByte();
  },
  encodePricePerKg() {
    return null;
  },
  parseFrame(buf) {
    return enq.parseFrame(buf);
  },
  STATUS,
  ACK: enq.ACK,
  NACK: enq.NACK,
});

module.exports = PROTOCOL;

"use strict";

const { listProtocols, resolveProtocol } = require("./protocol/registry");

function resolvePreset(protocol) {
  const p = resolveProtocol(protocol);
  return Object.freeze({
    id: p.id,
    label: p.label,
    protocol: p.protocol || p.id,
    baudDefault: p.baudDefault,
    dataBits: p.serial.dataBits,
    parity: p.serial.parity,
    stopBits: p.serial.stopBits,
  });
}

module.exports = {
  listProtocols,
  resolvePreset,
  resolveProtocol,
};

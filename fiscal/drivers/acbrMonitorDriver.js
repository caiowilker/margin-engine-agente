/**
 * Driver fiscal via ACBr Monitor (TCP :9200) — implementação em produção.
 * Delega integralmente para acbr.js (não duplicar lógica).
 */
const acbr = require("../../acbr");

const DRIVER_INFO = {
  provider: "acbr-monitor",
  label: "ACBr Monitor (TCP)",
  ready: true,
  transport: "tcp",
};

function getDriverInfo() {
  return { ...DRIVER_INFO };
}

module.exports = Object.assign({}, acbr, {
  getDriverInfo,
  DRIVER_INFO,
});

/**
 * Ponto único de acesso ao driver fiscal (Monitor ou ACBrLib).
 * Módulos do agente devem importar este arquivo — nunca acbr.js diretamente.
 *
 *   const fiscal = require("./fiscalDriver");
 *   await fiscal.emitirNfce(payload);
 *
 * Driver ativo via factory: ACBR_DRIVER=lib (padrão 1.0) | monitor (fallback).
 */
const factory = require("./fiscal/factory");

const fiscalDriverApi = {
  getDriverName: factory.getDriverName,
  getDriverInfo: factory.getDriverInfo,
  resetFiscalDriver: factory.resetFiscalDriver,
  resolveDriverName: factory.resolveDriverName,
};

module.exports = new Proxy(fiscalDriverApi, {
  get(target, prop, receiver) {
    if (prop in target) {
      const val = Reflect.get(target, prop, receiver);
      return typeof val === "function" ? val.bind(target) : val;
    }
    const driver = factory.getFiscalDriver();
    if (prop in driver) {
      const val = driver[prop];
      if (typeof val === "function") return val.bind(driver);
      return val;
    }
    return undefined;
  },
});

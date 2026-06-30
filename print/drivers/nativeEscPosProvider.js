/**
 * NativeEscPosProvider — engine ESC/POS legado (escpos + spooler + rede).
 */
const core = require("../escpos/impressoraCore");

const DRIVER_INFO = {
  provider: "native-escpos",
  label: "ESC/POS nativo (escpos)",
  ready: true,
  transport: "escpos",
  mode: "native",
};

module.exports = {
  getProviderName: () => "native",
  getDriverInfo: () => ({ ...DRIVER_INFO }),
  testar: (force) => core.testar(force),
  getInfo: (force) => core.getInfo(force),
  listar: () => core.listar(),
  detectar: () => core.detectar(),
  imprimirCupom: (p) => core.imprimirCupom(p),
  imprimirSegundaVia: (payload) => core.imprimirCupom(payload),
  imprimirAbertura: (p) => core.imprimirAbertura(p),
  imprimirFechamento: (p) => core.imprimirFechamento(p),
  imprimirMovimentoCaixa: (p) => core.imprimirMovimentoCaixa(p),
  abrirGaveta: () => core.abrirGaveta(),
  imprimirTeste: () => core.imprimirTeste(),
};

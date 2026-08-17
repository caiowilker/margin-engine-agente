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
  imprimirPedido: (p) => {
    const routes = require("../printerStationRoutes");
    const porta = routes.requirePortaForPrintType(p?.printType ?? p?.print_type);
    return routes.withPortaOverride(porta, () => core.imprimirPedido(p));
  },
  imprimirRelatorio: (p) => core.imprimirRelatorio(p),
  imprimirVasilhame: (p) => core.imprimirVasilhame(p),
  imprimirCrediario: (p) => core.imprimirCrediario(p),
  /** ZPL/PPLA — bytes raw, nunca ACBr tags. */
  imprimirRaw: (p) => require("../rawLabelPrint").imprimirRaw(p),
  abrirGaveta: (opts) => core.abrirGaveta(opts || {}),
  imprimirTeste: () => core.imprimirTeste(),
  imprimirTesteBarcode: (opts) => core.imprimirTesteBarcode(opts),
};

/**
 * Defaults de produção ACBrLib PosPrinter (RAW Windows).
 *
 * Fonte de verdade para -10 / hang ~120s:
 * - ControlePorta=0 em RAW (spooler gerencia a porta; evita ativação exclusiva -10)
 * - BytesCount/BytesInterval fragmentam o fluxo e evitam saturar o spooler
 * - LogNivel=0 / ArqLog vazio em produção (log em HD trava PDV lento)
 *
 * @see docs/ACBRLIB-POSPRINTER.md
 * @see .ai/decisions/ADR-posprinter-raw-ini-20260731.md
 */

function resolveLogNivel() {
  const v = process.env.PRINTER_ACBR_LOG_NIVEL;
  if (v != null && String(v).trim() !== "") {
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 4) return String(n);
  }
  // Produção: silencioso. Debug: PRINTER_ACBR_LOG_NIVEL=4
  return "0";
}

function resolveBytesCount() {
  const n = parseInt(process.env.PRINTER_BYTES_COUNT || "512", 10);
  return String(Number.isFinite(n) && n >= 64 && n <= 8192 ? n : 512);
}

function resolveBytesInterval() {
  const n = parseInt(process.env.PRINTER_BYTES_INTERVAL_MS || "10", 10);
  return String(Number.isFinite(n) && n >= 0 && n <= 200 ? n : 10);
}

function resolveDeviceTimeout() {
  // SSOT: Device TimeOut (s) ≤ soft call timeout − 1s (evita FFI órfã > Promise.race)
  const callMs = parseInt(process.env.ACBR_POS_CALL_TIMEOUT_MS || "5000", 10);
  const aligned = Math.max(
    1,
    Math.min(30, Math.floor((Number.isFinite(callMs) ? callMs : 5000) / 1000) - 1),
  );
  const n = parseInt(
    process.env.PRINTER_DEVICE_TIMEOUT_S ||
      process.env.PRINTER_SERIAL_TIMEOUT ||
      String(aligned),
    10,
  );
  return String(Number.isFinite(n) && n >= 1 && n <= 30 ? n : aligned);
}

/**
 * Bloco [PosPrinter_Device] — sempre presente (RAW/TCP/COM).
 * Serial acrescenta Baud/Parity/etc.
 */
function buildDeviceSection(vals = {}, opts = {}) {
  const isSerial = /^COM\d/i.test(String(vals.porta || opts.porta || ""));
  const lines = [
    "[PosPrinter_Device]",
    `BytesCount=${resolveBytesCount()}`,
    `BytesInterval=${resolveBytesInterval()}`,
    `TimeOut=${vals.timeout || resolveDeviceTimeout()}`,
  ];
  if (isSerial) {
    lines.push(
      `Baud=${vals.baud || process.env.PRINTER_SERIAL_BAUD || "9600"}`,
      `Parity=${vals.parity || process.env.PRINTER_SERIAL_PARITY || "0"}`,
      `Stop=${vals.stopBits || process.env.PRINTER_SERIAL_STOP || "0"}`,
      `HandShake=${vals.handshake || process.env.PRINTER_SERIAL_HANDSHAKE || "0"}`,
      `SoftFlow=${process.env.PRINTER_SERIAL_SOFTFLOW || "0"}`,
      `HardFlow=${process.env.PRINTER_SERIAL_HARDFLOW || "0"}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Valores runtime para POS_ConfigGravarValor (seção PosPrinter_Device). */
function buildDeviceRuntimeValues(vals = {}, porta = "") {
  const isSerial = /^COM\d/i.test(String(porta || vals.porta || ""));
  const device = {
    BytesCount: resolveBytesCount(),
    BytesInterval: resolveBytesInterval(),
    TimeOut: String(vals.timeout || resolveDeviceTimeout()),
  };
  if (isSerial) {
    device.Baud = String(vals.baud || process.env.PRINTER_SERIAL_BAUD || "9600");
    device.Parity = String(vals.parity || process.env.PRINTER_SERIAL_PARITY || "0");
    device.Stop = String(vals.stopBits || process.env.PRINTER_SERIAL_STOP || "0");
    device.HandShake = String(
      vals.handshake || process.env.PRINTER_SERIAL_HANDSHAKE || "0",
    );
    device.SoftFlow = process.env.PRINTER_SERIAL_SOFTFLOW || "0";
    device.HardFlow = process.env.PRINTER_SERIAL_HARDFLOW || "0";
  }
  return device;
}

/** DLLs que devem acompanhar ACBrPosPrinter64.dll no mesmo diretório. */
const POSPRINTER_SIDE_DLLS = [
  "libcrypto-1_1-x64.dll",
  "libssl-1_1-x64.dll",
  "libxml2.dll",
  "libiconv.dll",
  "libexslt.dll",
  "libxslt.dll",
];

module.exports = {
  resolveLogNivel,
  resolveBytesCount,
  resolveBytesInterval,
  resolveDeviceTimeout,
  buildDeviceSection,
  buildDeviceRuntimeValues,
  POSPRINTER_SIDE_DLLS,
};

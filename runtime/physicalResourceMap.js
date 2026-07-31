/**
 * Mapeia operações de impressão/fiscal para keys do physicalResourceLock.
 * PHYSICAL_USB_TOPOLOGY=shared|separate (default separate).
 */
function getTopology() {
  const v = String(process.env.PHYSICAL_USB_TOPOLOGY || "separate")
    .trim()
    .toLowerCase();
  return v === "shared" ? "shared" : "separate";
}

function isSharedUsbTopology() {
  return getTopology() === "shared";
}

/** Key para PosPrinter + native RAW (mesmo cabo USB / spooler). */
function resolvePosprinterKey() {
  return isSharedUsbTopology() ? "usb-shared" : "posprinter";
}

/** Key para emissão NFC-e / NF-e (cert + SEFAZ via ACBr NFe). */
function resolveNfeKey() {
  return isSharedUsbTopology() ? "usb-shared" : "nfe";
}

module.exports = {
  getTopology,
  isSharedUsbTopology,
  resolvePosprinterKey,
  resolveNfeKey,
};

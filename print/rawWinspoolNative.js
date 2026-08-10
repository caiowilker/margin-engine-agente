/**
 * WinSpool RAW via koffi — sem PowerShell por cupom.
 * Carrega winspool.drv uma vez no processo; OpenPrinter→WritePrinter→Close.
 *
 * Fallback: caller usa persistent PS / spawn legado se este módulo falhar.
 */
const log = require("../logger").child({ modulo: "raw_winspool_koffi" });

let api = null;
let loadError = null;

function isWindows() {
  return process.platform === "win32";
}

function loadApi() {
  if (api) return api;
  if (loadError) throw loadError;
  if (!isWindows()) {
    loadError = new Error("WinSpool koffi só no Windows");
    loadError.code = "RAW_KOFFI_UNSUPPORTED";
    throw loadError;
  }
  try {
    const koffi = require("koffi");
    const winspool = koffi.load("winspool.drv");
    const kernel32 = koffi.load("kernel32.dll");

    // DOC_INFO_1A — StartDocPrinter level 1
    const DOC_INFO_1A = koffi.struct("DOC_INFO_1A", {
      pDocName: "str",
      pOutputFile: "str",
      pDatatype: "str",
    });

    const OpenPrinterA = winspool.func(
      "bool __stdcall OpenPrinterA(str pPrinterName, _Out_ void **phPrinter, void *pDefault)",
    );
    const ClosePrinter = winspool.func("bool __stdcall ClosePrinter(void *hPrinter)");
    const StartDocPrinterA = winspool.func(
      "uint32 __stdcall StartDocPrinterA(void *hPrinter, uint32 Level, DOC_INFO_1A *pDocInfo)",
    );
    const EndDocPrinter = winspool.func("bool __stdcall EndDocPrinter(void *hPrinter)");
    const StartPagePrinter = winspool.func("bool __stdcall StartPagePrinter(void *hPrinter)");
    const EndPagePrinter = winspool.func("bool __stdcall EndPagePrinter(void *hPrinter)");
    const WritePrinter = winspool.func(
      "bool __stdcall WritePrinter(void *hPrinter, void *pBuf, uint32 cbBuf, _Out_ uint32 *pcWritten)",
    );
    const GetLastError = kernel32.func("uint32 __stdcall GetLastError()");

    api = {
      koffi,
      DOC_INFO_1A,
      OpenPrinterA,
      ClosePrinter,
      StartDocPrinterA,
      EndDocPrinter,
      StartPagePrinter,
      EndPagePrinter,
      WritePrinter,
      GetLastError,
    };
    log.info({ metric: "print.raw_koffi_loaded" }, "[RawWinspool] winspool.drv via koffi");
    return api;
  } catch (err) {
    loadError = err;
    loadError.code = loadError.code || "RAW_KOFFI_LOAD_FAIL";
    log.warn(
      { err: err.message, metric: "print.raw_koffi_load_fail" },
      "[RawWinspool] koffi/winspool indisponível",
    );
    throw loadError;
  }
}

/**
 * Envia buffer RAW para a impressora Windows.
 * @returns {{ ok: true, backend: 'koffi', timings: object }}
 */
function writeRaw(printerName, buffer) {
  const t0 = Date.now();
  const timings = {
    backend: "koffi",
    printer: String(printerName || ""),
    bytes: buffer?.length || 0,
  };
  const mark = (name, since) => {
    timings[name] = Date.now() - since;
  };

  const a = loadApi();
  let t = Date.now();
  const hPtr = [null];
  const opened = a.OpenPrinterA(String(printerName), hPtr, null);
  mark("OpenPrinter", t);
  if (!opened || !hPtr[0]) {
    const err = new Error(
      `OpenPrinter falhou: ${printerName} (GetLastError=${a.GetLastError()})`,
    );
    err.code = "RAW_OPEN_PRINTER";
    throw err;
  }
  const h = hPtr[0];

  try {
    const doc = {
      pDocName: "PDV Cupom",
      pOutputFile: null,
      pDatatype: "RAW",
    };
    t = Date.now();
    const jobId = a.StartDocPrinterA(h, 1, doc);
    mark("StartDocPrinter", t);
    if (!jobId) {
      const err = new Error(`StartDocPrinter falhou (GetLastError=${a.GetLastError()})`);
      err.code = "RAW_START_DOC";
      throw err;
    }

    try {
      t = Date.now();
      if (!a.StartPagePrinter(h)) {
        const err = new Error(`StartPagePrinter falhou (GetLastError=${a.GetLastError()})`);
        err.code = "RAW_START_PAGE";
        throw err;
      }
      mark("StartPagePrinter", t);

      const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      const writtenOut = [0];
      t = Date.now();
      const ok = a.WritePrinter(h, buf, buf.length, writtenOut);
      mark("WritePrinter", t);
      timings.written = writtenOut[0] || 0;
      timings.AllocCopy = 0; // in-process — sem AllocHGlobal
      timings.AddType = 0; // sem PowerShell
      if (!ok) {
        const err = new Error(`WritePrinter falhou (GetLastError=${a.GetLastError()})`);
        err.code = "RAW_WRITE";
        throw err;
      }

      t = Date.now();
      a.EndPagePrinter(h);
      mark("EndPagePrinter", t);
    } finally {
      t = Date.now();
      a.EndDocPrinter(h);
      mark("EndDocPrinter", t);
    }
  } finally {
    t = Date.now();
    a.ClosePrinter(h);
    mark("ClosePrinter", t);
  }

  timings.totalMs = Date.now() - t0;
  let slowest = null;
  let slowestMs = -1;
  for (const k of [
    "OpenPrinter",
    "StartDocPrinter",
    "StartPagePrinter",
    "WritePrinter",
    "EndPagePrinter",
    "EndDocPrinter",
    "ClosePrinter",
  ]) {
    if (typeof timings[k] === "number" && timings[k] > slowestMs) {
      slowestMs = timings[k];
      slowest = k;
    }
  }
  timings.slowest = slowest;
  timings.slowestMs = slowestMs;
  return { ok: true, backend: "koffi", timings };
}

function isAvailable() {
  if (!isWindows()) return false;
  try {
    loadApi();
    return true;
  } catch (_) {
    return false;
  }
}

function resetForTests() {
  api = null;
  loadError = null;
}

module.exports = {
  writeRaw,
  isAvailable,
  loadApi,
  resetForTests,
};

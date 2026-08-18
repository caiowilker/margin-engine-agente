/**
 * WinSpool RAW via koffi — sem PowerShell por cupom.
 * Carrega winspool.drv uma vez; OpenPrinter→WritePrinter→Close.
 *
 * writeRawSync é síncrono (bloqueia o thread em que roda).
 * writeRaw despacha para worker_threads — o event loop do agente não congela
 * se o spooler USB dormir (14–50s). HANDLE fica no mesmo worker (não cruzar
 * threads koffi.async).
 *
 * Fallback: caller usa persistent PS / spawn legado se este módulo falhar.
 */
const { Worker, isMainThread } = require("worker_threads");
const path = require("path");
const log = require("../logger").child({ modulo: "raw_winspool_koffi" });

let api = null;
let loadError = null;
let worker = null;
let seq = 0;
/** @type {Map<number, { resolve: Function, reject: Function, timer?: NodeJS.Timeout }>} */
const pending = new Map();
/** ids no worker — permanece após timeout do Promise (WritePrinter ainda pode estar rodando). */
const inflight = new Set();

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

function makeTimeoutError(ms) {
  const err = new Error(`Timeout WinSpool RAW (${ms}ms) — WritePrinter/OpenPrinter não concluiu`);
  err.code = "RAW_PRINT_TIMEOUT";
  err.printTimedOut = true;
  return err;
}

/**
 * HANDLE WinSpool reutilizado no worker.
 * OpenPrinter após USB dormir é o que atrasa “alguns” cupons (2–5s);
 * ClosePrinter a cada job deixava o USB suspender de novo.
 */
let heldHandle = null;
let heldPrinterName = "";

function closeHeldHandle(apiRef) {
  if (!heldHandle) return;
  try {
    (apiRef || loadApi()).ClosePrinter(heldHandle);
  } catch (_) {}
  heldHandle = null;
  heldPrinterName = "";
}

function acquireHandle(a, printerName) {
  const name = String(printerName || "");
  if (heldHandle && heldPrinterName === name) {
    return { handle: heldHandle, reused: true, openMs: 0 };
  }
  closeHeldHandle(a);
  const t = Date.now();
  const hPtr = [null];
  const opened = a.OpenPrinterA(name, hPtr, null);
  const openMs = Date.now() - t;
  if (!opened || !hPtr[0]) {
    const err = new Error(
      `OpenPrinter falhou: ${name} (GetLastError=${a.GetLastError()})`,
    );
    err.code = "RAW_OPEN_PRINTER";
    throw err;
  }
  heldHandle = hPtr[0];
  heldPrinterName = name;
  return { handle: heldHandle, reused: false, openMs };
}

/**
 * Envia buffer RAW na thread atual (bloqueante).
 * Usado pelo worker isolado — NÃO chamar no event loop do agente.
 * HANDLE permanece aberto após sucesso (USB não dorme). Close só em erro.
 * Retry de HANDLE velho só em StartDoc/StartPage — nunca após WritePrinter (anti-dupla).
 */
function writeRawSync(printerName, buffer) {
  const t0 = Date.now();
  const timings = {
    backend: "koffi",
    printer: String(printerName || ""),
    bytes: buffer?.length || 0,
    written: 0,
    AllocCopy: 0,
    AddType: 0,
  };
  const mark = (name, since) => {
    timings[name] = Date.now() - since;
  };

  const sendOn = (a, h) => {
    const doc = {
      pDocName: "PDV Cupom",
      pOutputFile: null,
      pDatatype: "RAW",
    };
    let t = Date.now();
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
  };

  const a = loadApi();
  let acquired = acquireHandle(a, printerName);
  timings.OpenPrinter = acquired.openMs;
  timings.handleReused = acquired.reused;

  try {
    try {
      sendOn(a, acquired.handle);
    } catch (err) {
      const staleBeforeWrite =
        acquired.reused &&
        (err?.code === "RAW_START_DOC" || err?.code === "RAW_START_PAGE");
      if (!staleBeforeWrite) throw err;
      closeHeldHandle(a);
      acquired = acquireHandle(a, printerName);
      timings.OpenPrinter = acquired.openMs;
      timings.handleReused = false;
      timings.handleReopened = true;
      sendOn(a, acquired.handle);
    }
  } catch (err) {
    closeHeldHandle(a);
    throw err;
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

/** Mantém o HANDLE aberto — Open+Close a cada ping deixava o USB dormir de novo. */
function pingPrinterSync(printerName) {
  const a = loadApi();
  const t0 = Date.now();
  const acquired = acquireHandle(a, printerName);
  return {
    ok: true,
    pingMs: Date.now() - t0,
    handleReused: acquired.reused,
  };
}

function rejectAll(err) {
  inflight.clear();
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(err);
    pending.delete(id);
  }
}

function workerBusy() {
  return inflight.size > 0;
}

function ensureWorker() {
  if (!isMainThread) {
    const err = new Error("WinSpool worker só no processo principal");
    err.code = "RAW_KOFFI_WORKER";
    throw err;
  }
  if (worker) return worker;
  const workerPath = path.join(__dirname, "rawWinspoolWorker.js");
  worker = new Worker(workerPath);
  worker.on("message", (msg) => {
    inflight.delete(msg.id);
    const p = pending.get(msg.id);
    if (!p) {
      log.info(
        {
          id: msg.id,
          ok: !!msg.ok,
          metric: "print.raw_koffi_late_result",
        },
        "[RawWinspool] resultado tardio ignorado (timeout já falhou o job; anti-dupla)",
      );
      return;
    }
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) {
      p.resolve(msg.result);
      return;
    }
    const err = new Error(msg.error || "WinSpool worker falhou");
    err.code = msg.code || "RAW_KOFFI_WORKER";
    p.reject(err);
  });
  worker.on("error", (err) => {
    log.warn({ err: err?.message, metric: "print.raw_koffi_worker_error" }, "[RawWinspool] worker error");
    const wrap = err instanceof Error ? err : new Error(String(err));
    wrap.code = wrap.code || "RAW_KOFFI_WORKER";
    rejectAll(wrap);
    worker = null;
  });
  worker.on("exit", (code) => {
    worker = null;
    if (pending.size === 0 && inflight.size === 0) return;
    const err = new Error(`WinSpool worker saiu (${code})`);
    err.code = "RAW_KOFFI_WORKER";
    rejectAll(err);
  });
  return worker;
}

function postToWorker(payload, timeoutMs) {
  ensureWorker();
  const id = ++seq;
  inflight.add(id);
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, timer: null };
    if (timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        log.warn(
          {
            timeoutMs,
            op: payload.op || "write",
            printer: payload.printer,
            inflight: inflight.size,
            metric: "print.raw_koffi_worker_timeout",
          },
          "[RawWinspool] timeout — event loop livre; worker continua (anti-dupla: sem segundo envio)",
        );
        reject(makeTimeoutError(timeoutMs));
      }, timeoutMs);
    }
    pending.set(id, entry);
    try {
      worker.postMessage({ ...payload, id });
    } catch (err) {
      inflight.delete(id);
      pending.delete(id);
      clearTimeout(entry.timer);
      reject(err);
    }
  });
}

function defaultTimeoutMs(opts = {}) {
  const n = parseInt(
    opts.timeoutMs != null
      ? opts.timeoutMs
      : process.env.PRINTER_RAW_TIMEOUT_MS || "4000",
    10,
  );
  return Number.isFinite(n) && n > 0 ? n : 4000;
}

/**
 * Envia buffer RAW sem bloquear o event loop (worker isolado).
 * Timeout: falha o job; o worker NÃO é morto no meio do WritePrinter (anti-dupla).
 */
async function writeRaw(printerName, buffer, opts = {}) {
  const timeoutMs = defaultTimeoutMs(opts);
  if (!isMainThread) {
    return writeRawSync(printerName, buffer);
  }
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  return postToWorker(
    {
      op: "write",
      printer: String(printerName || ""),
      b64: buf.toString("base64"),
    },
    timeoutMs,
  );
}

async function pingPrinter(printerName, opts = {}) {
  const timeoutMs =
    opts.timeoutMs != null ? opts.timeoutMs : Math.min(2000, defaultTimeoutMs(opts));
  if (!isMainThread) {
    return pingPrinterSync(printerName);
  }
  return postToWorker({ op: "ping", printer: String(printerName || "") }, timeoutMs);
}

/**
 * Porta de decisão no processo HTTP: só Windows.
 * loadApi/koffi NÃO rodam aqui — OpenPrinter no event loop congelava o caixa.
 * Falha real de koffi aparece no worker e cai no fallback persistente.
 */
function isAvailable() {
  return isWindows();
}

function resetForTests() {
  closeHeldHandle();
  api = null;
  loadError = null;
  rejectAll(new Error("resetForTests"));
  if (worker) {
    try {
      worker.terminate();
    } catch (_) {}
    worker = null;
  }
}

module.exports = {
  writeRaw,
  writeRawSync,
  pingPrinter,
  pingPrinterSync,
  isAvailable,
  workerBusy,
  loadApi,
  resetForTests,
};

/**
 * Worker isolado — OpenPrinter/WritePrinter/Close no mesmo thread.
 * koffi.async NÃO serve aqui: o HANDLE não pode cruzar threads do libuv.
 */
const { parentPort } = require("worker_threads");
const { writeRawSync, pingPrinterSync } = require("./rawWinspoolNative");

parentPort.on("message", (msg) => {
  const id = msg && msg.id;
  try {
    if (msg.op === "ping") {
      const result = pingPrinterSync(msg.printer);
      parentPort.postMessage({ id, ok: true, result });
      return;
    }
    const buf = Buffer.from(String(msg.b64 || ""), "base64");
    const result = writeRawSync(msg.printer, buf);
    parentPort.postMessage({ id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({
      id,
      ok: false,
      error: err?.message || String(err),
      code: err?.code || null,
    });
  }
});

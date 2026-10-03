"use strict";

const {
  SCALE_OPEN_TIMEOUT_MS,
  SCALE_RX_BUFFER_MAX_BYTES,
} = require("../constants");
const { ScaleError } = require("../errors");
const log = require("../../../logger").child({ modulo: "scale_transport" });

let SerialPortCtor = null;
let serialNativeError = null;

function loadSerialport() {
  if (SerialPortCtor) return SerialPortCtor;
  if (serialNativeError) return null;
  try {
    // Require isolado — falha de bind nativo não derruba o agente
    // eslint-disable-next-line global-require
    const mod = require("serialport");
    SerialPortCtor = mod.SerialPort || mod;
    return SerialPortCtor;
  } catch (err) {
    serialNativeError = err;
    log.warn(
      { metric: "scale.native_missing", err: err.message },
      "[Scale] serialport indisponível",
    );
    return null;
  }
}

function isNativeAvailable() {
  return Boolean(loadSerialport());
}

function getNativeError() {
  return serialNativeError;
}

/**
 * @typedef {object} ScaleTransport
 * @property {() => Promise<void>} open
 * @property {() => Promise<void>} close
 * @property {(data: Buffer) => Promise<void>} write
 * @property {() => Promise<void>} flush
 * @property {() => boolean} isOpen
 * @property {(cb: (chunk: Buffer) => void) => void} onData
 * @property {(cb: (err: Error) => void) => void} onError
 * @property {(cb: () => void) => void} onClose
 * @property {() => void} removeAllListeners
 */

/**
 * @param {{
 *   path: string,
 *   baudRate?: number,
 *   openTimeoutMs?: number,
 *   dataBits?: number,
 *   parity?: string,
 *   stopBits?: number,
 * }} opts
 * @returns {ScaleTransport}
 */
function createSerialTransport(opts) {
  const SerialPort = loadSerialport();
  if (!SerialPort) {
    throw new ScaleError("SCALE_NATIVE_MISSING", {
      detail: serialNativeError?.message,
    });
  }

  const path = String(opts.path || "").trim();
  if (!path) throw new ScaleError("SCALE_NOT_CONFIGURED");

  const baudRate = Number(opts.baudRate) || 9600;
  const openTimeoutMs = Number(opts.openTimeoutMs) || SCALE_OPEN_TIMEOUT_MS;
  const dataBits = Number(opts.dataBits) || 8;
  const parity = opts.parity || "none";
  const stopBits = Number(opts.stopBits) || 1;

  /** @type {import('serialport').SerialPort|null} */
  let port = null;
  let rxBytes = 0;
  const dataListeners = new Set();
  const errorListeners = new Set();
  const closeListeners = new Set();

  function attach() {
    if (!port) return;
    port.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      rxBytes += buf.length;
      if (rxBytes > SCALE_RX_BUFFER_MAX_BYTES) {
        log.warn(
          { metric: "scale.rx_overrun", bytes: rxBytes },
          "[Scale] RX overrun — reset contador",
        );
        rxBytes = 0;
        try {
          port.flush();
        } catch (_) {
          /* ignore */
        }
      }
      for (const cb of dataListeners) {
        try {
          cb(buf);
        } catch (_) {
          /* ignore */
        }
      }
    });
    port.on("error", (err) => {
      for (const cb of errorListeners) {
        try {
          cb(err);
        } catch (_) {
          /* ignore */
        }
      }
    });
    port.on("close", () => {
      for (const cb of closeListeners) {
        try {
          cb();
        } catch (_) {
          /* ignore */
        }
      }
    });
  }

  return {
    async open() {
      if (port && port.isOpen) return;
      const t0 = Date.now();
      port = new SerialPort({
        path,
        baudRate,
        dataBits,
        parity,
        stopBits,
        autoOpen: false,
      });
      attach();
      await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            port.close(() => {});
          } catch (_) {
            /* ignore */
          }
          reject(new ScaleError("SCALE_OPEN_FAILED", { detail: "open_timeout" }));
        }, openTimeoutMs);
        port.open((err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) {
            log.warn(
              { metric: "scale.open_fail", path, err: err.message, ms: Date.now() - t0 },
              "[Scale] Falha ao abrir COM",
            );
            reject(err);
            return;
          }
          log.info(
            { metric: "scale.open_cold", path, baudRate, ms: Date.now() - t0 },
            "[Scale] Porta aberta",
          );
          resolve();
        });
      });
    },

    async close() {
      if (!port) return;
      const p = port;
      port = null;
      rxBytes = 0;
      await new Promise((resolve) => {
        if (!p.isOpen) {
          resolve();
          return;
        }
        p.close(() => resolve());
      });
    },

    async write(data) {
      if (!port || !port.isOpen) {
        throw new ScaleError("SCALE_SESSION_CLOSED");
      }
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      await new Promise((resolve, reject) => {
        port.write(buf, (err) => {
          if (err) reject(err);
          else port.drain((err2) => (err2 ? reject(err2) : resolve()));
        });
      });
    },

    async flush() {
      if (!port || !port.isOpen) return;
      await new Promise((resolve) => {
        port.flush(() => resolve());
      });
      rxBytes = 0;
    },

    isOpen() {
      return Boolean(port && port.isOpen);
    },

    onData(cb) {
      dataListeners.add(cb);
      return () => dataListeners.delete(cb);
    },
    onError(cb) {
      errorListeners.add(cb);
      return () => errorListeners.delete(cb);
    },
    onClose(cb) {
      closeListeners.add(cb);
      return () => closeListeners.delete(cb);
    },
    removeAllListeners() {
      dataListeners.clear();
      errorListeners.clear();
      closeListeners.clear();
    },
  };
}

/**
 * Transport em memória para testes (mock).
 * @param {{ respond?: (written: Buffer) => Buffer|null|Promise<Buffer|null> }} [opts]
 */
function createMockTransport(opts = {}) {
  let open = false;
  const dataListeners = new Set();
  const errorListeners = new Set();
  const closeListeners = new Set();
  const respond = opts.respond || (() => null);

  return {
    async open() {
      open = true;
    },
    async close() {
      open = false;
      for (const cb of closeListeners) cb();
    },
    async write(data) {
      if (!open) throw new ScaleError("SCALE_SESSION_CLOSED");
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const reply = await respond(buf);
      if (reply) {
        const chunk = Buffer.isBuffer(reply) ? reply : Buffer.from(reply);
        setImmediate(() => {
          for (const cb of dataListeners) cb(chunk);
        });
      }
    },
    async flush() {},
    isOpen() {
      return open;
    },
    onData(cb) {
      dataListeners.add(cb);
      return () => dataListeners.delete(cb);
    },
    onError(cb) {
      errorListeners.add(cb);
      return () => errorListeners.delete(cb);
    },
    onClose(cb) {
      closeListeners.add(cb);
      return () => closeListeners.delete(cb);
    },
    removeAllListeners() {
      dataListeners.clear();
      errorListeners.clear();
      closeListeners.clear();
    },
    /** @internal */
    emitData(buf) {
      for (const cb of dataListeners) cb(Buffer.from(buf));
    },
    emitError(err) {
      for (const cb of errorListeners) cb(err);
    },
  };
}

async function listPorts() {
  const SerialPort = loadSerialport();
  if (!SerialPort) {
    throw new ScaleError("SCALE_NATIVE_MISSING");
  }
  const listFn = SerialPort.list || (require("serialport").SerialPort && require("serialport").SerialPort.list);
  // Prefer serialport package list
  let list;
  try {
    // eslint-disable-next-line global-require
    const sp = require("serialport");
    list = sp.SerialPort?.list || sp.list;
  } catch (_) {
    list = null;
  }
  if (typeof list !== "function") {
    return [];
  }
  const ports = await list();
  return (ports || []).map((p) => ({
    path: p.path,
    manufacturer: p.manufacturer || null,
    vendorId: p.vendorId || null,
    productId: p.productId || null,
    friendlyName: p.friendlyName || p.path,
  }));
}

module.exports = {
  loadSerialport,
  isNativeAvailable,
  getNativeError,
  createSerialTransport,
  createMockTransport,
  listPorts,
};

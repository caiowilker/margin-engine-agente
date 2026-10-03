"use strict";

const {
  SCALE_ENQ_TIMEOUT_MS,
  SCALE_FRAME_TIMEOUT_MS,
  SCALE_READ_BUDGET_MS,
  SCALE_HOT_READ_BUDGET_MS,
  SCALE_SOFT_RETRIES,
  SCALE_SOFT_RETRY_MS,
  SCALE_HOT_SOFT_RETRY_MS,
  SCALE_REOPEN_BACKOFF_MS,
  SCALE_REOPEN_BACKOFF_MAX_MS,
  SCALE_MAX_REOPEN_ATTEMPTS,
  SCALE_LOCK_WAIT_MS,
  SCALE_RX_BUFFER_MAX_BYTES,
} = require("./constants");
const { resolveProtocol } = require("./protocol/registry");
const { STATUS } = require("./protocol/types");
const { ScaleError } = require("./errors");
const physicalLock = require("../../runtime/physicalResourceLock");
const log = require("../../logger").child({ modulo: "scale_driver" });

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {{ sessionManager: any, createTransport?: Function }} deps
 */
function createDriver(deps) {
  const { sessionManager } = deps;
  let readMutex = Promise.resolve();

  async function withReadMutex(fn) {
    let release;
    const prev = readMutex;
    readMutex = new Promise((r) => {
      release = r;
    });
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
    }
  }

  function protocolForSession(sess) {
    return resolveProtocol(sess?.protocol);
  }

  async function sendPricePerKg(pricePerKg) {
    const sess = sessionManager.requireSession();
    if (sess.priceSent) return { ok: true, skipped: true };
    const proto = protocolForSession(sess);
    const frame =
      typeof proto.encodePricePerKg === "function"
        ? proto.encodePricePerKg(pricePerKg)
        : null;
    if (!frame) return { ok: false, skipped: true };
    const transport = sess.transport;
    const ACK = proto.ACK ?? 0x06;
    const NACK = proto.NACK ?? 0x21;

    return new Promise((resolve) => {
      let buf = Buffer.alloc(0);
      let unsub = () => {};
      const timer = setTimeout(() => {
        unsub();
        resolve({ ok: false, timeout: true });
      }, SCALE_ENQ_TIMEOUT_MS);

      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (let i = 0; i < buf.length; i++) {
          if (buf[i] === ACK) {
            clearTimeout(timer);
            unsub();
            sessionManager.markPriceSent();
            resolve({ ok: true });
            return;
          }
          if (buf[i] === NACK) {
            clearTimeout(timer);
            unsub();
            resolve({ ok: false, nack: true });
            return;
          }
        }
      };

      unsub = transport.onData(onData) || (() => {});
      transport.write(frame).catch(() => {
        clearTimeout(timer);
        unsub();
        resolve({ ok: false });
      });
    });
  }

  async function readOnceOnTransport(transport, proto, { budgetMs } = {}) {
    const budget = budgetMs || SCALE_READ_BUDGET_MS;
    let buf = Buffer.alloc(0);
    let firstByteAt = null;
    const parseFrame = proto.parseFrame.bind(proto);
    const enquire = proto.encodeEnquire();

    return new Promise((resolve, reject) => {
      let settled = false;
      let unsub = () => {};

      function finish(result) {
        if (settled) return;
        settled = true;
        clearTimeout(enqTimer);
        clearTimeout(budgetTimer);
        clearInterval(frameTick);
        unsub();
        resolve(result);
      }
      function fail(err) {
        if (settled) return;
        settled = true;
        clearTimeout(enqTimer);
        clearTimeout(budgetTimer);
        clearInterval(frameTick);
        unsub();
        reject(err);
      }

      const onData = (chunk) => {
        if (settled) return;
        if (!firstByteAt) firstByteAt = Date.now();
        buf = Buffer.concat([buf, chunk]);
        if (buf.length > SCALE_RX_BUFFER_MAX_BYTES) {
          buf = buf.subarray(buf.length - SCALE_RX_BUFFER_MAX_BYTES);
        }
        const parsed = parseFrame(buf);
        if (parsed.needMore) return;
        if (!parsed.ok) {
          log.warn(
            {
              metric: "scale.frame_invalid",
              detail: parsed.error,
              protocol: proto.id,
            },
            "[Scale] Frame inválido",
          );
          fail(new ScaleError("SCALE_INVALID_FRAME", { detail: parsed.error }));
          return;
        }
        log.info(
          { metric: "scale.protocol_parse_ok", protocol: proto.id, status: parsed.status },
          "[Scale] Frame OK",
        );
        finish(parsed);
      };

      unsub = transport.onData(onData) || (() => {});
      transport.write(enquire).catch((err) => fail(err));

      const enqTimer = setTimeout(() => {
        if (settled || firstByteAt) return;
        log.warn({ metric: "scale.enq_timeout", protocol: proto.id }, "[Scale] Sem byte após ENQ");
        fail(new ScaleError("SCALE_TIMEOUT", { detail: "enq_timeout" }));
      }, SCALE_ENQ_TIMEOUT_MS);
      if (enqTimer.unref) enqTimer.unref();

      const budgetTimer = setTimeout(() => {
        if (settled) return;
        log.warn({ metric: "scale.enq_timeout", protocol: proto.id }, "[Scale] Orçamento esgotado");
        fail(new ScaleError("SCALE_TIMEOUT", { detail: "read_budget" }));
      }, budget);
      if (budgetTimer.unref) budgetTimer.unref();

      const frameTick = setInterval(() => {
        if (settled || !firstByteAt) return;
        if (Date.now() - firstByteAt > SCALE_FRAME_TIMEOUT_MS) {
          fail(new ScaleError("SCALE_TIMEOUT", { detail: "frame_timeout" }));
        }
      }, 40);
      if (frameTick.unref) frameTick.unref();
    });
  }

  function mapParsedToResult(parsed, meta) {
    if (parsed.status === STATUS.UNSTABLE) {
      return {
        ok: false,
        codigo: "SCALE_UNSTABLE",
        status: "unstable",
        stable: false,
        kg: null,
        grams: null,
        erro: "Peso instável — aguarde parar.",
        acaoRecomendada: "Espere estabilizar.",
        recuperavel: true,
        ...meta,
      };
    }
    if (parsed.status === STATUS.NEGATIVE) {
      throw new ScaleError("SCALE_ZERO_OR_NEGATIVE");
    }
    if (parsed.status === STATUS.OVERLOAD) {
      throw new ScaleError("SCALE_OVER_CAPACITY");
    }
    return {
      ok: true,
      kg: parsed.kg,
      grams: parsed.grams,
      stable: true,
      status: "stable",
      unidade: "kg",
      ...meta,
    };
  }

  async function reopenSession(sessSnap) {
    const { porta, baud, protocol, pricePerKg } = sessSnap;
    await sessionManager.closeSession({ reason: "reopen" });
    await sessionManager.openSession({ porta, baud, protocol, pricePerKg });
    log.info({ metric: "scale.reopen", porta, protocol }, "[Scale] Reopen");
  }

  async function readWeight({ sessionId, hot = true } = {}) {
    return withReadMutex(async () => {
      const sessCheck = sessionManager.get();
      if (!sessCheck || (sessionId && sessCheck.sessionId !== sessionId)) {
        throw new ScaleError("SCALE_SESSION_CLOSED");
      }
      if (sessCheck.reading) {
        log.info({ metric: "scale.poll_overlap_skip", porta: sessCheck.porta }, "[Scale] Leitura em andamento");
        throw new ScaleError("SCALE_BUSY");
      }

      const porta = sessCheck.porta;
      const lockKey = `scale:${porta}`;
      const t0 = Date.now();
      const budgetMs = hot ? SCALE_HOT_READ_BUDGET_MS : SCALE_READ_BUDGET_MS;
      const softRetryMs = hot ? SCALE_HOT_SOFT_RETRY_MS : SCALE_SOFT_RETRY_MS;

      try {
        return await physicalLock.run(
          lockKey,
          async () => {
            sessionManager.setReading(true);
            try {
              const live = sessionManager.requireSession(sessionId);
              const proto = protocolForSession(live);
              if (live.pricePerKg != null && !live.priceSent) {
                await sendPricePerKg(live.pricePerKg).catch(() => {});
              }

              let lastErr = null;
              let reopenAttempts = 0;

              for (let soft = 0; soft <= SCALE_SOFT_RETRIES; soft++) {
                try {
                  const transport = sessionManager.requireSession(sessionId).transport;
                  // Hot path: flush só se necessário — best-effort leve
                  if (!hot) await transport.flush?.();
                  const parsed = await readOnceOnTransport(transport, proto, {
                    budgetMs,
                  });
                  const latencyMs = Date.now() - t0;
                  if (latencyMs > (hot ? 400 : 1000)) {
                    log.warn(
                      { metric: "scale.slow", latencyMs, hot: Boolean(hot) },
                      "[Scale] Leitura lenta",
                    );
                  }

                  if (parsed.status === STATUS.UNSTABLE) {
                    log.info({ metric: "scale.unstable", protocol: proto.id }, "[Scale] Peso instável");
                    if (soft < SCALE_SOFT_RETRIES) {
                      await sleep(softRetryMs);
                      continue;
                    }
                    return mapParsedToResult(parsed, {
                      at: Date.now(),
                      porta,
                      latencyMs,
                      hot: Boolean(hot),
                      protocol: proto.id,
                    });
                  }

                  const result = mapParsedToResult(parsed, {
                    at: Date.now(),
                    porta,
                    latencyMs,
                    hot: Boolean(hot),
                    protocol: proto.id,
                  });
                  log.info(
                    {
                      metric: "scale.read_ok",
                      kg: result.kg,
                      latencyMs,
                      hot: Boolean(hot),
                      protocol: proto.id,
                    },
                    "[Scale] Leitura OK",
                  );
                  return result;
                } catch (err) {
                  lastErr = err;
                  const hard =
                    err instanceof ScaleError &&
                    (err.codigo === "SCALE_INVALID_FRAME" ||
                      err.codigo === "SCALE_TIMEOUT" ||
                      err.codigo === "SCALE_USB_GONE" ||
                      err.codigo === "SCALE_OPEN_FAILED");

                  if (hard && reopenAttempts < SCALE_MAX_REOPEN_ATTEMPTS) {
                    reopenAttempts += 1;
                    const backoff = Math.min(
                      SCALE_REOPEN_BACKOFF_MS * reopenAttempts,
                      SCALE_REOPEN_BACKOFF_MAX_MS,
                    );
                    await sleep(backoff);
                    const snap = sessionManager.get();
                    if (!snap) throw new ScaleError("SCALE_SESSION_CLOSED");
                    await reopenSession(snap);
                    continue;
                  }
                  throw err;
                }
              }
              throw lastErr || new ScaleError("SCALE_TIMEOUT");
            } finally {
              sessionManager.setReading(false);
              sessionManager.touch();
            }
          },
          "scale.read",
          { waitMs: SCALE_LOCK_WAIT_MS },
        );
      } catch (err) {
        if (err && err.code === "PHYSICAL_LOCK_WAIT_TIMEOUT") {
          log.warn({ metric: "scale.lock_wait_timeout", porta }, "[Scale] Lock wait timeout");
          throw new ScaleError("SCALE_LOCK_WAIT_TIMEOUT");
        }
        throw err;
      }
    });
  }

  async function testOnce({ porta, baud, protocol }) {
    if (!porta) throw new ScaleError("SCALE_NOT_CONFIGURED");
    const createTransport = deps.createTransport;
    if (typeof createTransport !== "function") {
      throw new ScaleError("SCALE_NATIVE_MISSING");
    }
    const proto = resolveProtocol(protocol);

    const lockKey = `scale:${porta}`;
    try {
      return await physicalLock.run(
        lockKey,
        async () => {
          const transport = createTransport({
            path: porta,
            baudRate: baud || proto.baudDefault,
            dataBits: proto.serial.dataBits,
            parity: proto.serial.parity,
            stopBits: proto.serial.stopBits,
          });
          const t0 = Date.now();
          try {
            await transport.open();
            await transport.flush?.();
            const parsed = await readOnceOnTransport(transport, proto, {
              budgetMs: SCALE_READ_BUDGET_MS,
            });
            if (parsed.status === STATUS.UNSTABLE) {
              throw new ScaleError("SCALE_UNSTABLE");
            }
            if (parsed.status === STATUS.NEGATIVE) {
              throw new ScaleError("SCALE_ZERO_OR_NEGATIVE");
            }
            if (parsed.status === STATUS.OVERLOAD) {
              throw new ScaleError("SCALE_OVER_CAPACITY");
            }
            return {
              ok: true,
              kg: parsed.kg,
              grams: parsed.grams,
              stable: true,
              status: "stable",
              unidade: "kg",
              at: Date.now(),
              porta,
              latencyMs: Date.now() - t0,
              protocol: proto.id,
            };
          } finally {
            try {
              transport.removeAllListeners?.();
              await transport.close();
            } catch (_) {
              /* ignore */
            }
          }
        },
        "scale.test",
        { waitMs: SCALE_LOCK_WAIT_MS },
      );
    } catch (err) {
      if (err && err.code === "PHYSICAL_LOCK_WAIT_TIMEOUT") {
        throw new ScaleError("SCALE_LOCK_WAIT_TIMEOUT");
      }
      throw err;
    }
  }

  return {
    sendPricePerKg,
    readWeight,
    testOnce,
    readOnceOnTransport,
  };
}

module.exports = {
  createDriver,
};

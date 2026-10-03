"use strict";

const crypto = require("crypto");
const { SCALE_SESSION_IDLE_MS } = require("./constants");
const { ScaleError } = require("./errors");
const { resolveProtocol } = require("./protocol/registry");
const log = require("../../logger").child({ modulo: "scale_session" });

/**
 * Sessão held-handle: open once por modal, idle GC, generation.
 * closeSession({ sessionId }) só fecha se bater com a sessão atual (anti orphan cruzado).
 */
function createSessionManager(opts = {}) {
  const idleMs = Number(opts.idleMs) || SCALE_SESSION_IDLE_MS;
  const createTransport = opts.createTransport;
  /** @type {(info: { sessionId: string, porta: string }) => void}|null */
  const onUnexpectedClose =
    typeof opts.onUnexpectedClose === "function" ? opts.onUnexpectedClose : null;

  /** @type {{
   *   sessionId: string,
   *   generation: number,
   *   porta: string,
   *   baud: number,
   *   protocol: string,
   *   transport: any,
   *   openedAt: number,
   *   lastActivityAt: number,
   *   priceSent: boolean,
   *   reading: boolean,
   *   pricePerKg: number|null,
   * }|null} */
  let current = null;
  let idleTimer = null;
  let generation = 0;
  /** @type {Promise<any>|null} */
  let openingPromise = null;
  /** Gerações canceladas antes do open concluir (cliente abortou). */
  const cancelledGenerations = new Set();

  function touch() {
    if (!current) return;
    current.lastActivityAt = Date.now();
    scheduleIdle();
  }

  function scheduleIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    if (!current) return;
    idleTimer = setTimeout(() => {
      if (!current) return;
      const idle = Date.now() - current.lastActivityAt;
      if (idle >= idleMs) {
        log.info(
          { metric: "scale.session_idle_close", sessionId: current.sessionId, porta: current.porta },
          "[Scale] Sessão fechada por idle",
        );
        closeSession({ reason: "idle" }).catch(() => {});
      } else {
        scheduleIdle();
      }
    }, Math.min(idleMs, 5000));
    if (idleTimer.unref) idleTimer.unref();
  }

  function get() {
    return current
      ? {
          sessionId: current.sessionId,
          generation: current.generation,
          porta: current.porta,
          baud: current.baud,
          protocol: current.protocol,
          openedAt: current.openedAt,
          lastActivityAt: current.lastActivityAt,
          priceSent: current.priceSent,
          reading: current.reading,
          open: current.transport?.isOpen?.() === true,
        }
      : null;
  }

  function requireSession(sessionId) {
    if (!current || !current.transport?.isOpen?.()) {
      throw new ScaleError("SCALE_SESSION_CLOSED");
    }
    if (sessionId && current.sessionId !== sessionId) {
      throw new ScaleError("SCALE_SESSION_CLOSED");
    }
    touch();
    return current;
  }

  async function openSession({ porta, baud, protocol, pricePerKg }) {
    if (openingPromise) {
      await openingPromise.catch(() => {});
    }
    if (current) {
      await closeSession({ reason: "reopen" });
    }
    if (!porta) throw new ScaleError("SCALE_NOT_CONFIGURED");
    if (typeof createTransport !== "function") {
      throw new ScaleError("SCALE_NATIVE_MISSING");
    }

    generation += 1;
    const myGen = generation;
    const proto = resolveProtocol(protocol);
    const transport = createTransport({
      path: porta,
      baudRate: baud || proto.baudDefault,
      dataBits: proto.serial.dataBits,
      parity: proto.serial.parity,
      stopBits: proto.serial.stopBits,
    });
    const sessionId = crypto.randomBytes(8).toString("hex");

    transport.onClose(() => {
      if (current && current.sessionId === sessionId) {
        log.warn(
          { metric: "scale.usb_disconnect", porta, sessionId },
          "[Scale] Porta fechou inesperadamente",
        );
        current = null;
        try {
          onUnexpectedClose?.({ sessionId, porta });
        } catch (_) {
          /* ignore */
        }
      }
    });
    transport.onError((err) => {
      log.warn(
        { metric: "scale.transport_error", porta, err: err?.message },
        "[Scale] Erro no transport",
      );
    });

    const work = (async () => {
      await transport.open();

      if (cancelledGenerations.has(myGen) || myGen !== generation) {
        cancelledGenerations.delete(myGen);
        try {
          transport.removeAllListeners?.();
          await transport.close();
        } catch (_) {
          /* ignore */
        }
        log.info(
          { metric: "scale.session_open_aborted", sessionId, porta, generation: myGen },
          "[Scale] Open abortado — COM fechada",
        );
        throw new ScaleError("SCALE_SESSION_CLOSED");
      }

      current = {
        sessionId,
        generation: myGen,
        porta,
        baud: baud || proto.baudDefault,
        protocol: proto.id,
        transport,
        openedAt: Date.now(),
        lastActivityAt: Date.now(),
        priceSent: false,
        reading: false,
        pricePerKg: pricePerKg != null ? Number(pricePerKg) : null,
      };

      scheduleIdle();
      log.info(
        {
          metric: "scale.session_open",
          sessionId,
          porta,
          baud: current.baud,
          protocol: proto.id,
          stopBits: proto.serial.stopBits,
          generation: myGen,
        },
        "[Scale] Sessão aberta",
      );
      return get();
    })();

    openingPromise = work.finally(() => {
      if (openingPromise === work) openingPromise = null;
    });
    return openingPromise;
  }

  /**
   * @param {{ reason?: string, sessionId?: string }} [opts]
   * - sem sessionId: fecha a sessão atual (orphan recovery)
   * - com sessionId: só fecha se for a sessão atual (não derruba COM de outro modal)
   */
  async function closeSession({ reason, sessionId } = {}) {
    // Cancela open em voo se o cliente pediu fechar (qualquer / essa gen)
    if (openingPromise) {
      cancelledGenerations.add(generation);
      try {
        await openingPromise.catch(() => {});
      } catch (_) {
        /* ignore */
      }
    }

    if (sessionId && current && current.sessionId !== sessionId) {
      log.info(
        {
          metric: "scale.session_close_skip",
          requested: sessionId,
          current: current.sessionId,
          reason: reason || "mismatch",
        },
        "[Scale] Fechar ignorado — sessionId não é a sessão atual",
      );
      return { closed: false, skipped: true, sessionId: current.sessionId };
    }

    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    const snap = current;
    current = null;
    if (!snap) return { closed: false };
    try {
      snap.transport.removeAllListeners?.();
      await snap.transport.flush?.();
      await snap.transport.close();
    } catch (err) {
      log.warn({ err: err.message, reason }, "[Scale] Erro ao fechar sessão");
    }
    log.info(
      {
        metric: "scale.session_close",
        sessionId: snap.sessionId,
        porta: snap.porta,
        reason: reason || "manual",
      },
      "[Scale] Sessão fechada",
    );
    return { closed: true, sessionId: snap.sessionId };
  }

  function markPriceSent() {
    if (current) current.priceSent = true;
  }

  function setReading(v) {
    if (current) current.reading = Boolean(v);
  }

  return {
    get,
    requireSession,
    openSession,
    closeSession,
    markPriceSent,
    setReading,
    touch,
    /** @internal testes */
    _reset() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      current = null;
      generation = 0;
      openingPromise = null;
      cancelledGenerations.clear();
    },
  };
}

module.exports = {
  createSessionManager,
};

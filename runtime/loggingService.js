/**
 * LoggingService — único ponto de logging do agente.
 *
 * Canais: application, fiscal, acbr, printer, installer, updater, diagnostic, performance
 * Modos: DEBUG (TRACE+) | PRODUCTION (INFO+ em arquivo, WARN+ no console)
 */
const fs = require("fs");
const path = require("path");
const { AsyncLocalStorage } = require("async_hooks");
const { getDirectoryManager } = require("./directoryManager");
const { sanitizeRecord } = require("./logSanitizer");
const { afterAppend, getOrCreateState } = require("./logRotation");

const LEVELS = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const CHANNEL_FILES = {
  application: "application.log",
  fiscal: "fiscal.log",
  acbr: "acbr.log",
  printer: "printer.log",
  installer: "installer.log",
  updater: "updater.log",
  diagnostic: "diagnostic.log",
  performance: "performance.log",
};

const asyncStore = new AsyncLocalStorage();
let singleton = null;
let consolePatched = false;
let originalConsole = null;

function resolveLogMode() {
  const explicit = String(process.env.LOG_MODE || "").toUpperCase();
  if (explicit === "DEBUG" || explicit === "PRODUCTION") return explicit;
  return process.env.NODE_ENV === "production" ? "PRODUCTION" : "DEBUG";
}

function resolveMinLevel(mode) {
  const override = process.env.LOG_LEVEL;
  if (override && LEVELS[override.toLowerCase()]) {
    return LEVELS[override.toLowerCase()];
  }
  return mode === "PRODUCTION" ? LEVELS.info : LEVELS.trace;
}

function resolveConsoleMinLevel(mode) {
  if (process.env.LOG_CONSOLE_LEVEL && LEVELS[process.env.LOG_CONSOLE_LEVEL.toLowerCase()]) {
    return LEVELS[process.env.LOG_CONSOLE_LEVEL.toLowerCase()];
  }
  return mode === "PRODUCTION" ? LEVELS.warn : LEVELS.debug;
}

function resolveChannel(bindings = {}) {
  if (bindings.channel && CHANNEL_FILES[bindings.channel]) {
    return bindings.channel;
  }
  const m = String(bindings.modulo || bindings.module || "").toLowerCase();
  if (bindings.performance) return "performance";
  if (m.includes("updater") || m.includes("manifest")) return "updater";
  if (m.includes("install")) return "installer";
  if (m.includes("diagnostico") || m.includes("diagnostic")) return "diagnostic";
  if (m.includes("metric") || m.includes("performance")) return "performance";
  if (m.includes("acbr")) return "acbr";
  if (m.includes("printer") || m.includes("print") || m.includes("impressora") || m.includes("escpos")) {
    return "printer";
  }
  if (m.includes("fiscal")) return "fiscal";
  return "application";
}

function timezoneLabel() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function extractErrorFields(merging) {
  const err = merging.err || merging.error;
  if (!err) return { erro: null, stack: null };
  if (err instanceof Error) {
    return { erro: err.message, stack: err.stack || null };
  }
  if (typeof err === "object") {
    return {
      erro: err.message || JSON.stringify(sanitizeRecord(err)),
      stack: err.stack || null,
    };
  }
  return { erro: String(err), stack: null };
}

class Logger {
  constructor(service, bindings = {}) {
    this._service = service;
    this._bindings = { ...bindings };
  }

  child(bindings) {
    return new Logger(this._service, { ...this._bindings, ...bindings });
  }

  trace(...args) {
    this._write("trace", args);
  }
  debug(...args) {
    this._write("debug", args);
  }
  info(...args) {
    this._write("info", args);
  }
  warn(...args) {
    this._write("warn", args);
  }
  error(...args) {
    this._write("error", args);
  }
  fatal(...args) {
    this._write("fatal", args);
  }

  _write(level, args) {
    this._service.write(level, this._bindings, args);
  }
}

class LoggingService {
  constructor() {
    this.mode = resolveLogMode();
    this.minLevel = resolveMinLevel(this.mode);
    this.consoleMinLevel = resolveConsoleMinLevel(this.mode);
    this.silent = process.env.LOG_SILENT === "true";
    this._staticContext = {
      versao: process.env.AGENT_VERSION || null,
    };
    this._streams = new Map();
  }

  getRootLogger() {
    return new Logger(this, { modulo: "application" });
  }

  createLogger(bindings) {
    return new Logger(this, bindings);
  }

  setStaticContext(ctx) {
    this._staticContext = { ...this._staticContext, ...ctx };
  }

  runWithContext(ctx, fn) {
    const parent = asyncStore.getStore() || {};
    return asyncStore.run({ ...parent, ...ctx }, fn);
  }

  setContext(ctx) {
    const parent = asyncStore.getStore() || {};
    asyncStore.enterWith({ ...parent, ...ctx });
  }

  getContext() {
    return { ...(asyncStore.getStore() || {}), ...this._staticContext };
  }

  ensureLogDir() {
    const dm = getDirectoryManager();
    return dm.ensurePath(dm.dir("logs"), "logs");
  }

  filePath(channel) {
    const file = CHANNEL_FILES[channel] || CHANNEL_FILES.application;
    return path.join(this.ensureLogDir(), file);
  }

  write(level, bindings, args) {
    const levelNum = LEVELS[level];
    if (!levelNum || levelNum < this.minLevel) return;

    const record = this._buildRecord(level, bindings, args);
    const channel = resolveChannel({ ...bindings, ...record });
    const line = `${JSON.stringify(record)}\n`;

    if (!this.silent) {
      this._appendToChannel(channel, line);
    }

    if (levelNum >= this.consoleMinLevel) {
      this._emitConsole(level, record);
    }
  }

  _buildRecord(level, bindings, args) {
    let merging = {};
    let message = "";

    if (args.length === 0) {
      message = "";
    } else if (typeof args[0] === "object" && args[0] !== null && !Array.isArray(args[0])) {
      merging = { ...args[0] };
      message = args[1] != null ? String(args[1]) : String(merging.msg || "");
      delete merging.msg;
    } else {
      message = String(args[0]);
      if (args.length > 1 && typeof args[1] === "object") {
        merging = { ...args[1] };
      }
    }

    const { erro, stack } = extractErrorFields(merging);
    delete merging.err;
    delete merging.error;

    const ctx = this.getContext();
    const sanitized = sanitizeRecord(merging);

    const record = {
      timestamp: new Date().toISOString(),
      timezone: timezoneLabel(),
      thread: "main",
      correlationId: sanitized.correlationId ?? ctx.correlationId ?? null,
      tenant: sanitized.tenant ?? ctx.tenant ?? ctx.tenantId ?? null,
      empresa: sanitized.empresa ?? ctx.empresa ?? null,
      caixa: sanitized.caixa ?? ctx.caixa ?? ctx.pdvId ?? ctx.dispositivoId ?? null,
      usuario: sanitized.usuario ?? ctx.usuario ?? null,
      versao: ctx.versao ?? null,
      modulo: bindings.modulo || bindings.module || sanitized.modulo || "application",
      acao: sanitized.acao ?? sanitized.action ?? null,
      tempo: sanitized.tempo ?? sanitized.durationMs ?? sanitized.ms ?? null,
      resultado: sanitized.resultado ?? sanitized.result ?? null,
      level: level.toUpperCase(),
      message,
      erro,
      stack,
    };

    for (const [k, v] of Object.entries(sanitized)) {
      if (k in record) continue;
      record[k] = v;
    }

    return record;
  }

  _appendToChannel(channel, line) {
    const fp = this.filePath(channel);
    try {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.appendFileSync(fp, line, "utf8");
      const state = getOrCreateState(fp);
      afterAppend(fp, state);
    } catch {
      /* disco indisponível — não interromper agente */
    }
  }

  _emitConsole(level, record) {
    const text = `[${record.timestamp}] ${record.level} [${record.modulo}] ${record.message}`;
    const out = originalConsole || console;
    if (level === "error" || level === "fatal") {
      out.error(text, record.erro ? { erro: record.erro } : "");
    } else if (level === "warn") {
      out.warn(text);
    } else {
      out.log(text);
    }
  }

  patchConsole() {
    if (consolePatched || process.env.LOG_PATCH_CONSOLE === "false") return;
    if (!originalConsole) {
      originalConsole = {
        log: console.log.bind(console),
        info: console.info.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
        debug: console.debug.bind(console),
      };
    }
    consolePatched = true;

    const script = path.basename(process.argv[1] || "");
    let modulo = "console";
    let channel = "application";
    if (script === "install-service.js") {
      modulo = "install_service";
      channel = "installer";
    } else if (script.includes("manifest") || script.includes("updater")) {
      modulo = "updater";
      channel = "updater";
    }

    const route = (level, args) => {
      const msg = args
        .map((a) => (typeof a === "object" ? JSON.stringify(sanitizeRecord(a)) : String(a)))
        .join(" ");
      this.write(level, { modulo, channel }, [msg]);
    };

    console.log = (...args) => route("info", args);
    console.info = (...args) => route("info", args);
    console.warn = (...args) => route("warn", args);
    console.error = (...args) => route("error", args);
    console.debug = (...args) => route("debug", args);
  }

  unpatchConsole() {
    if (!consolePatched || !originalConsole) return;
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    console.debug = originalConsole.debug;
    consolePatched = false;
  }

  listChannels() {
    return Object.keys(CHANNEL_FILES);
  }
}

function getLoggingService() {
  if (!singleton) {
    singleton = new LoggingService();
  }
  return singleton;
}

function resetLoggingService() {
  if (singleton) {
    singleton.unpatchConsole();
  }
  singleton = null;
}

function initLogging(options = {}) {
  const svc = getLoggingService();
  if (options.versao) svc.setStaticContext({ versao: options.versao });
  if (options.context) svc.setStaticContext(options.context);
  if (options.patchConsole) svc.patchConsole();
  return svc;
}

module.exports = {
  LoggingService,
  Logger,
  getLoggingService,
  resetLoggingService,
  initLogging,
  LEVELS,
  CHANNEL_FILES,
  resolveChannel,
  resolveLogMode,
};

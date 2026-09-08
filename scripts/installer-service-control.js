#!/usr/bin/env node
/**
 * Controle do serviço Windows Margin Engine — instalador (stop/start/wait).
 *
 * node-windows registra no SCM pelo ID do winsw: `{base}.exe` (não pelo nome exibido).
 *   "PDV Margin Engine" → pdvmarginengine.exe
 *   "Margin Engine"     → marginengine.exe
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
// Atomics é global do Node — NÃO vem de worker_threads (import errado →
// "Cannot read properties of undefined (reading 'wait')" e SCM start/stop quebra).

const SERVICE_DISPLAY_NAME = "Margin Engine";
const LEGACY_DISPLAY_NAMES = ["PDV Margin Engine"];

const SERVICE_SCM_NAME = nodeWindowsServiceScmName(SERVICE_DISPLAY_NAME);
const LEGACY_SCM_NAMES = LEGACY_DISPLAY_NAMES.map(nodeWindowsServiceScmName);

const STOP_WAIT_MS = parseInt(process.env.INSTALLER_STOP_WAIT_MS || "12000", 10);
/** PrepareToInstall: cap curto — bootstrap completa a parada sem congelar o wizard. */
const PREINSTALL_STOP_WAIT_MS = parseInt(process.env.INSTALLER_PREINSTALL_STOP_MS || "8000", 10);
/** Após taskkill — grandes instaladores não ficam 15s no SCM. */
const FORCE_STOP_POLL_MS = parseInt(process.env.INSTALLER_FORCE_STOP_MS || "8000", 10);
/** Start: health do agente é a verdade; SCM RUNNING é bônus rápido. */
const DEFAULT_START_WAIT_MS = parseInt(process.env.INSTALLER_START_WAIT_MS || "8000", 10);
/** Poll SCM rápido — Atomics.wait global (nunca worker_threads). */
const POLL_MS = 200;

function nodeWindowsServiceId(displayName) {
  return String(displayName).replace(/[^\w]/gi, "").toLowerCase();
}

function nodeWindowsServiceScmName(displayName) {
  return `${nodeWindowsServiceId(displayName)}.exe`;
}

/** Variantes possíveis no SCM (node-windows usa .exe; instalações antigas podem diferir). */
function scmNameVariants(displayName) {
  const base = nodeWindowsServiceId(displayName);
  const withExe = `${base}.exe`;
  return withExe === base ? [base] : [withExe, base];
}

function isWindows() {
  return process.platform === "win32";
}

function scDeleteService(scmName) {
  if (!isWindows()) return { ok: true, skipped: true, scmName };
  const sc = "sc.exe";
  try {
    try {
      execSync(`${sc} stop "${scmName}"`, { stdio: "pipe", encoding: "utf8" });
    } catch {
      /* já parado */
    }
    execSync(`${sc} delete "${scmName}"`, { stdio: "pipe", encoding: "utf8" });
    if (queryStateForScm(scmName) !== "missing") {
      return {
        ok: false,
        scmName,
        error: "Serviço ainda listado após sc delete — execute como Administrador",
      };
    }
    return { ok: true, scmName, removed: true };
  } catch (err) {
    return { ok: false, scmName, error: err.message };
  }
}

function uninstallViaWinsw(appDir, scmName) {
  if (!isWindows() || !appDir) return { ok: false, skipped: true, scmName };
  const base = scmName.endsWith(".exe") ? scmName.slice(0, -4) : scmName;
  const exe = path.join(appDir, "daemon", `${base}.exe`);
  if (!fs.existsSync(exe)) {
    return { ok: false, skipped: true, scmName, reason: "winsw ausente" };
  }
  try {
    execSync(`"${exe}" uninstall`, { stdio: "pipe", encoding: "utf8", cwd: path.dirname(exe) });
    return { ok: true, scmName, method: "winsw" };
  } catch (err) {
    return { ok: false, scmName, method: "winsw", error: err.message };
  }
}

function removeLegacyServices(appDir) {
  const roots = [];
  if (appDir) roots.push(appDir);
  const envRoot = process.env.MARGIN_ENGINE_AGENT_ROOT;
  if (envRoot && !roots.includes(envRoot)) roots.push(envRoot);

  const results = [];
  for (const displayName of LEGACY_DISPLAY_NAMES) {
    const variants = scmNameVariants(displayName);
    const existing = variants.filter((scm) => queryStateForScm(scm) !== "missing");
    if (existing.length === 0) continue;

    for (const scmName of existing) {
      let r = scDeleteService(scmName);
      if (!r.ok) {
        for (const root of roots) {
          const w = uninstallViaWinsw(root, scmName);
          if (w.ok) {
            r = w;
            break;
          }
        }
      }
      results.push(r);
    }
  }
  return results;
}

/**
 * Interpreta saída de `sc.exe query`.
 * Locale-proof: o dígito STATE/ESTADO é estável (1–4). Rótulos EN/PT são fallback.
 * @see https://learn.microsoft.com/windows/win32/api/winsvc/ns-winsvc-service_status
 */
function parseScQueryOutput(out) {
  if (!out || typeof out !== "string") return "unknown";
  // UTF-16 mal decodificado como utf8 deixa NULs; strip evita regex cego.
  const text = out.replace(/\0/g, "");
  // Preferir código numérico (idioma-independente).
  const num =
    /(?:STATE|ESTADO)\s*:\s*(\d+)/i.exec(text) ||
    /:\s*([1-7])\s+(?:RUNNING|STOPPED|START_PENDING|STOP_PENDING|CONTINUE_PENDING|PAUSE_PENDING|PAUSED)\b/i.exec(
      text,
    );
  if (num) {
    switch (num[1]) {
      case "1":
        return "stopped";
      case "2":
        return "starting";
      case "3":
        return "stopping";
      case "4":
        return "running";
      case "5": // CONTINUE_PENDING
        return "starting";
      case "6": // PAUSE_PENDING
        return "stopping";
      case "7": // PAUSED
        return "stopped";
      default:
        break;
    }
  }
  const hasLabel = /(?:STATE|ESTADO)\b/i.test(text);
  if (/\bRUNNING\b/i.test(text) && hasLabel) return "running";
  if (/\bSTOPPED\b/i.test(text) && hasLabel) return "stopped";
  if (/\bSTART_PENDING\b/i.test(text)) return "starting";
  if (/\bSTOP_PENDING\b/i.test(text)) return "stopping";
  return "unknown";
}

/** 1060 = ERROR_SERVICE_DOES_NOT_EXIST (dígito estável; texto localiza: FALHA/FAILED). */
function isScMissingError(status, blob) {
  if (status === 1060) return true;
  // Bun/alguns hosts truncam exit code a 8 bits: 1060 % 256 = 36
  if (status === 36 && /\b1060\b/.test(blob)) return true;
  return /\b1060\b/.test(blob);
}

/**
 * Fallback .NET ServiceController — Status.ToString() é EN independente do UI language.
 * Mais lento (~100–400ms); só quando sc.exe parse falha.
 */
function queryStateViaServiceController(scmName) {
  if (!isWindows() || !scmName) return "unknown";
  const safe = String(scmName);
  if (!/^[a-zA-Z0-9._-]+$/.test(safe)) return "unknown";
  try {
    const ps = [
      "$ErrorActionPreference='Stop'",
      `try { (Get-Service -Name '${safe}').Status.ToString() }`,
      "catch { if ($_.Exception.Message -match 'Cannot find|n.o encontra|1060') { 'Missing' } else { 'Unknown' } }",
    ].join("; ");
    const out = execSync(
      `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${ps}"`,
      {
        encoding: "utf8",
        timeout: 4_000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
      .toString()
      .trim();
    const map = {
      Running: "running",
      Stopped: "stopped",
      StartPending: "starting",
      StopPending: "stopping",
      ContinuePending: "starting",
      PausePending: "stopping",
      Paused: "stopped",
      Missing: "missing",
    };
    return map[out] || "unknown";
  } catch {
    return "unknown";
  }
}

function queryStateForScm(scmName) {
  if (!isWindows()) return "unknown";
  let out = "";
  try {
    out = execSync(`sc.exe query "${scmName}"`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (err) {
    const stdout = String(err.stdout || "");
    const stderr = String(err.stderr || "");
    const blob = `${stdout}\n${stderr}\n${err.message || ""}`;
    if (isScMissingError(err.status, blob)) return "missing";
    // Serviço pode existir mas sc falhou (ACL/timeout) — tenta .NET.
    const viaPs = queryStateViaServiceController(scmName);
    if (viaPs !== "unknown") return viaPs;
    return "unknown";
  }
  const parsed = parseScQueryOutput(out);
  if (parsed !== "unknown") return parsed;
  return queryStateViaServiceController(scmName);
}

function resolveActiveScmName(displayName) {
  for (const scm of scmNameVariants(displayName)) {
    if (queryStateForScm(scm) !== "missing") return scm;
  }
  return scmNameVariants(displayName)[0];
}

function queryState() {
  return queryStateForScm(resolveActiveScmName(SERVICE_DISPLAY_NAME));
}

function sleep(ms) {
  if (ms <= 0) return;
  // Atomics é global do V8/Node — não importar de worker_threads.
  if (typeof Atomics !== "undefined" && typeof SharedArrayBuffer !== "undefined") {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      return;
    } catch {
      /* fall through */
    }
  }
  // Fallback raro (SAB off) — spin só para polls curtos; sem spawn Node.
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* busy-wait */
  }
}

function allKnownScmNames() {
  return [
    ...scmNameVariants(SERVICE_DISPLAY_NAME),
    ...LEGACY_SCM_NAMES,
    ...LEGACY_DISPLAY_NAMES.flatMap(scmNameVariants),
  ];
}

function forceStopScm(scmName) {
  if (!isWindows() || !scmName) return { ok: false, scmName, skipped: true };
  const tried = [];
  const killTargets = [scmName];
  if (scmName.endsWith(".exe")) {
    killTargets.push(scmName.slice(0, -4));
  } else {
    killTargets.push(`${scmName}.exe`);
  }
  for (const target of killTargets) {
    try {
      execSync(`taskkill /F /IM "${target}" /T`, { stdio: "pipe", encoding: "utf8" });
      tried.push(`taskkill:${target}`);
    } catch {
      /* processo pode já ter encerrado */
    }
  }
  try {
    execSync(`sc.exe stop "${scmName}"`, { stdio: "pipe", encoding: "utf8" });
    tried.push("sc:stop");
  } catch {
    /* ignore */
  }
  const deadline = Date.now() + FORCE_STOP_POLL_MS;
  while (Date.now() < deadline) {
    const st = queryStateForScm(scmName);
    if (st === "stopped" || st === "missing") {
      return { ok: true, scmName, state: st, forced: true, tried };
    }
    sleep(POLL_MS);
  }
  return {
    ok: false,
    scmName,
    state: queryStateForScm(scmName),
    forced: true,
    tried,
    error: "Serviço ainda ativo após parada forçada",
  };
}

function forceStopAllMarginServices() {
  const results = [];
  for (const scmName of allKnownScmNames()) {
    if (queryStateForScm(scmName) === "missing") continue;
    results.push(forceStopScm(scmName));
  }
  return results;
}

function stopService(opts = {}) {
  if (!isWindows()) return { ok: true, skipped: true, state: "skipped" };
  const waitMs = parseInt(
    String(opts.waitMs || process.env.INSTALLER_STOP_WAIT_MS || STOP_WAIT_MS),
    10,
  );
  const force = Boolean(opts.force);
  const scmName = resolveActiveScmName(SERVICE_DISPLAY_NAME);
  const before = queryStateForScm(scmName);
  if (before === "missing" || before === "stopped") {
    return { ok: true, state: before, scmName };
  }
  try {
    execSync(`sc.exe stop "${scmName}"`, { stdio: "pipe", encoding: "utf8" });
  } catch (err) {
    const st = queryStateForScm(scmName);
    if (st === "stopped" || st === "missing") {
      return { ok: true, state: st, scmName };
    }
    if (!force) {
      return { ok: false, state: st, scmName, error: err.message };
    }
  }
  const deadline = Date.now() + Math.max(5000, waitMs);
  /** Se o parser/locale falhar (unknown), não queimar o budget inteiro — força cedo. */
  const unknownForceAfterMs = Math.min(3_000, Math.max(1_000, Math.floor(waitMs / 4)));
  const unknownForceAt = Date.now() + unknownForceAfterMs;
  while (Date.now() < deadline) {
    const st = queryStateForScm(scmName);
    if (st === "stopped" || st === "missing") {
      return { ok: true, state: st, scmName };
    }
    if (force && st === "unknown" && Date.now() >= unknownForceAt) {
      break;
    }
    sleep(POLL_MS);
  }
  let state = queryStateForScm(scmName);
  if (force && state !== "stopped" && state !== "missing") {
    const forced = forceStopScm(scmName);
    if (forced.ok) return { ...forced, graceful: false };
    forceStopAllMarginServices();
    state = queryStateForScm(scmName);
    if (state === "stopped" || state === "missing") {
      return { ok: true, state, scmName, forced: true, graceful: false };
    }
    return forced;
  }
  return {
    ok: false,
    state,
    scmName,
    error: "Timeout aguardando parada do serviço",
  };
}

function startService(opts = {}) {
  if (!isWindows()) return { ok: true, skipped: true };
  const waitMs = parseInt(String(opts.waitMs || DEFAULT_START_WAIT_MS), 10);
  const scmName = resolveActiveScmName(SERVICE_DISPLAY_NAME);
  let st = queryStateForScm(scmName);
  if (st === "running") return { ok: true, state: st, scmName };

  if (st === "missing") {
    // Tenta variantes legadas / sem .exe antes de desistir
    for (const alt of [
      ...scmNameVariants(SERVICE_DISPLAY_NAME),
      ...LEGACY_SCM_NAMES,
      ...LEGACY_DISPLAY_NAMES.flatMap(scmNameVariants),
    ]) {
      if (queryStateForScm(alt) !== "missing") {
        return startServiceForScm(alt, waitMs);
      }
    }
    return {
      ok: false,
      state: "missing",
      scmName,
      error: `Serviço "${SERVICE_DISPLAY_NAME}" (${scmName}) não encontrado no SCM`,
    };
  }

  return startServiceForScm(scmName, waitMs);
}

function startServiceForScm(scmName, waitMs) {
  let st = queryStateForScm(scmName);
  if (st === "running") return { ok: true, state: st, scmName };

  let startIssued = false;
  try {
    execSync(`sc.exe start "${scmName}"`, {
      stdio: "pipe",
      encoding: "utf8",
      windowsHide: true,
    });
    startIssued = true;
  } catch (err) {
    const msg = String(err.stdout || "") + String(err.stderr || "") + String(err.message || "");
    // 1056 = já em start; 1053 = não respondeu a tempo (ainda pode subir)
    const soft =
      /1056|already been started|PENDING|1053|did not respond|não respondeu|\b1056\b/i.test(msg);
    st = queryStateForScm(scmName);
    if (soft || st === "running" || st === "starting") {
      startIssued = true;
    } else if (!soft) {
      return { ok: false, state: st, scmName, error: err.message };
    }
  }

  const deadline = Date.now() + Math.max(2_000, waitMs);
  while (Date.now() < deadline) {
    st = queryStateForScm(scmName);
    if (st === "running") return { ok: true, state: st, scmName };
    sleep(POLL_MS);
  }
  st = queryStateForScm(scmName);
  // Grande instalador: se o start foi aceito, health decide — não queimar minutos no SCM.
  if (startIssued && (st === "starting" || st === "unknown" || st === "running")) {
    return {
      ok: st === "running",
      state: st,
      scmName,
      healthDeferred: true,
      startIssued: true,
    };
  }
  return {
    ok: false,
    state: st,
    scmName,
    error: `Timeout aguardando início do serviço (${waitMs}ms)`,
  };
}

if (require.main === module) {
  const cmd = process.argv[2];
  const appDir = process.argv[3] || process.env.MARGIN_ENGINE_AGENT_ROOT || null;
  if (cmd === "stop" || cmd === "stop-preinstall") {
    const preinstall = cmd === "stop-preinstall";
    const r = stopService({
      waitMs: preinstall ? PREINSTALL_STOP_WAIT_MS : STOP_WAIT_MS,
      force: preinstall,
    });
    console.log(JSON.stringify(r));
    const finalState = r.scmName ? queryStateForScm(r.scmName) : queryState();
    if (preinstall) {
      process.exit(0);
    }
    const acceptable = r.ok || finalState === "stopped" || finalState === "missing";
    process.exit(acceptable ? 0 : 1);
  }
  if (cmd === "start") {
    const r = startService();
    console.log(JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  }
  if (cmd === "status") {
    console.log(
      JSON.stringify({
        displayName: SERVICE_DISPLAY_NAME,
        scmName: SERVICE_SCM_NAME,
        state: queryState(),
        legacyScmNames: LEGACY_SCM_NAMES,
      }),
    );
    process.exit(0);
  }
  if (cmd === "remove-legacy") {
    const results = removeLegacyServices(appDir);
    console.log(JSON.stringify(results, null, 2));
    const failed = results.some((r) => r && r.ok === false);
    process.exit(failed ? 1 : 0);
  }
  console.error("Uso: installer-service-control.js stop|stop-preinstall|start|status|remove-legacy [appDir]");
  process.exit(2);
}

module.exports = {
  SERVICE_NAME: SERVICE_DISPLAY_NAME,
  SERVICE_SCM_NAME,
  SERVICE_ID: nodeWindowsServiceId(SERVICE_DISPLAY_NAME),
  LEGACY_SERVICE_NAMES: LEGACY_DISPLAY_NAMES,
  LEGACY_SCM_NAMES,
  LEGACY_SERVICE_IDS: LEGACY_DISPLAY_NAMES.map(nodeWindowsServiceId),
  nodeWindowsServiceId,
  nodeWindowsServiceScmName,
  scmNameVariants,
  stopService,
  startService,
  queryState,
  queryStateForScm,
  parseScQueryOutput,
  isScMissingError,
  queryStateViaServiceController,
  sleep,
  POLL_MS,
  DEFAULT_START_WAIT_MS,
  FORCE_STOP_POLL_MS,
  removeLegacyServices,
  forceStopScm,
  forceStopAllMarginServices,
};

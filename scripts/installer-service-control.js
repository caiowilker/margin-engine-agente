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
const { execSync, execFileSync } = require("child_process");

const SERVICE_DISPLAY_NAME = "Margin Engine";
const LEGACY_DISPLAY_NAMES = ["PDV Margin Engine"];

const SERVICE_SCM_NAME = nodeWindowsServiceScmName(SERVICE_DISPLAY_NAME);
const LEGACY_SCM_NAMES = LEGACY_DISPLAY_NAMES.map(nodeWindowsServiceScmName);

const STOP_WAIT_MS = parseInt(process.env.INSTALLER_STOP_WAIT_MS || "45000", 10);
const POLL_MS = 500;

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

function queryStateForScm(scmName) {
  if (!isWindows()) return "unknown";
  try {
    const out = execSync(`sc.exe query "${scmName}"`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (/STATE\s*:\s*\d+\s+STOPPED/i.test(out)) return "stopped";
    if (/STATE\s*:\s*\d+\s+RUNNING/i.test(out)) return "running";
    if (/STATE\s*:\s*\d+\s+START_PENDING/i.test(out)) return "starting";
    if (/STATE\s*:\s*\d+\s+STOP_PENDING/i.test(out)) return "stopping";
    return "unknown";
  } catch {
    return "missing";
  }
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
  execFileSync(process.execPath, ["-e", `setTimeout(()=>{}, ${ms})`], { stdio: "ignore" });
}

function stopService() {
  if (!isWindows()) return { ok: true, skipped: true, state: "skipped" };
  const scmName = resolveActiveScmName(SERVICE_DISPLAY_NAME);
  const before = queryStateForScm(scmName);
  if (before === "missing" || before === "stopped") {
    return { ok: true, state: before, scmName };
  }
  try {
    execSync(`sc.exe stop "${scmName}"`, { stdio: "pipe", encoding: "utf8" });
  } catch (err) {
    return { ok: false, state: queryStateForScm(scmName), scmName, error: err.message };
  }
  const deadline = Date.now() + STOP_WAIT_MS;
  while (Date.now() < deadline) {
    const st = queryStateForScm(scmName);
    if (st === "stopped" || st === "missing") {
      return { ok: true, state: st, scmName };
    }
    sleep(POLL_MS);
  }
  return {
    ok: false,
    state: queryStateForScm(scmName),
    scmName,
    error: "Timeout aguardando parada do serviço",
  };
}

function startService() {
  if (!isWindows()) return { ok: true, skipped: true };
  const scmName = resolveActiveScmName(SERVICE_DISPLAY_NAME);
  const st = queryStateForScm(scmName);
  if (st === "running") return { ok: true, state: st, scmName };
  try {
    execSync(`sc.exe start "${scmName}"`, { stdio: "pipe", encoding: "utf8" });
    return { ok: true, state: queryStateForScm(scmName), scmName };
  } catch (err) {
    return { ok: false, state: queryStateForScm(scmName), scmName, error: err.message };
  }
}

if (require.main === module) {
  const cmd = process.argv[2];
  const appDir = process.argv[3] || process.env.MARGIN_ENGINE_AGENT_ROOT || null;
  if (cmd === "stop") {
    const r = stopService();
    console.log(JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
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
  console.error("Uso: installer-service-control.js stop|start|status|remove-legacy [appDir]");
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
  removeLegacyServices,
};

#!/usr/bin/env node
/**
 * Controle do serviço Windows Margin Engine — instalador (stop/start/wait).
 */
const { execSync, execFileSync } = require("child_process");

const SERVICE_NAME = "Margin Engine";
const STOP_WAIT_MS = parseInt(process.env.INSTALLER_STOP_WAIT_MS || "45000", 10);
const POLL_MS = 500;

function isWindows() {
  return process.platform === "win32";
}

function queryState() {
  if (!isWindows()) return "unknown";
  try {
    const out = execSync(`sc query "${SERVICE_NAME}"`, {
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

function sleep(ms) {
  execFileSync(process.execPath, ["-e", `setTimeout(()=>{}, ${ms})`], { stdio: "ignore" });
}

function stopService() {
  if (!isWindows()) return { ok: true, skipped: true, state: "skipped" };
  const before = queryState();
  if (before === "missing" || before === "stopped") {
    return { ok: true, state: before };
  }
  try {
    execSync(`sc stop "${SERVICE_NAME}"`, { stdio: "pipe", encoding: "utf8" });
  } catch (err) {
    return { ok: false, state: queryState(), error: err.message };
  }
  const deadline = Date.now() + STOP_WAIT_MS;
  while (Date.now() < deadline) {
    const st = queryState();
    if (st === "stopped" || st === "missing") {
      return { ok: true, state: st };
    }
    sleep(POLL_MS);
  }
  return { ok: false, state: queryState(), error: "Timeout aguardando parada do serviço" };
}

function startService() {
  if (!isWindows()) return { ok: true, skipped: true };
  const st = queryState();
  if (st === "running") return { ok: true, state: st };
  try {
    execSync(`sc start "${SERVICE_NAME}"`, { stdio: "pipe", encoding: "utf8" });
    return { ok: true, state: queryState() };
  } catch (err) {
    return { ok: false, state: queryState(), error: err.message };
  }
}

if (require.main === module) {
  const cmd = process.argv[2];
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
    console.log(JSON.stringify({ state: queryState() }));
    process.exit(0);
  }
  console.error("Uso: installer-service-control.js stop|start|status");
  process.exit(2);
}

module.exports = { SERVICE_NAME, stopService, startService, queryState };

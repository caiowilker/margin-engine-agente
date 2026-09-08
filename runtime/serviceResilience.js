/**
 * Resiliência do serviço Windows (SCM) + self-heal pós-update/reboot.
 *
 * Caso de campo: update aplicou, UI abriu; pediu reiniciar PC; após reboot
 * :9100 morto. Causas típicas:
 * 1) exit code 0 no AUTO_UPDATE → SCM não aplica recovery restart
 * 2) start type manual / recovery ausente
 * 3) frontend-dist inconsistente após cópia (tela preta)
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const SCM_NAME = "marginengine.exe";
const MARKER_NAME = "post-update-heal.json";

function isWindows() {
  return process.platform === "win32";
}

function agentDataDir() {
  try {
    return require("./directoryManager").getDirectoryManager().dir("agent");
  } catch {
    return path.join(process.env.ProgramData || "/tmp", "MarginEngine", "agent");
  }
}

function markerPath() {
  return path.join(agentDataDir(), MARKER_NAME);
}

function sc(cmd) {
  if (!isWindows()) return { ok: false, skipped: true };
  try {
    const out = execSync(`sc.exe ${cmd}`, {
      stdio: "pipe",
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    });
    return { ok: true, out: String(out || "") };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      out: String(err.stdout || "") + String(err.stderr || ""),
    };
  }
}

/** start= auto — PDV precisa de :9100 imediatamente após reboot (delayed-auto atrasava 1–2 min). */
function ensureAutostart(scmName = SCM_NAME) {
  if (!isWindows()) return { ok: true, skipped: true };
  const r = sc(`config "${scmName}" start= auto`);
  if (r.ok) return { ok: true, scmName, start: "auto" };
  const r2 = sc(`config "${scmName}" start= delayed-auto`);
  return {
    ok: r2.ok,
    scmName,
    start: r2.ok ? "delayed-auto" : null,
    error: r2.ok ? undefined : r.error || r2.error,
  };
}

function ensureFailureRecovery(scmName = SCM_NAME) {
  if (!isWindows()) return { ok: true, skipped: true };
  const fail = sc(
    `failure "${scmName}" reset=86400 actions=restart/1000/restart/3000/restart/15000`,
  );
  const flag = sc(`failureflag "${scmName}" 1`);
  return {
    ok: fail.ok && flag.ok,
    scmName,
    error: fail.ok && flag.ok ? undefined : fail.error || flag.error,
  };
}

/**
 * Configura autostart + recovery. Best-effort (sem admin pode falhar — não derruba boot).
 */
function hardenScm(scmName = SCM_NAME) {
  const autostart = ensureAutostart(scmName);
  const recovery = ensureFailureRecovery(scmName);
  return { ok: autostart.ok && recovery.ok, autostart, recovery };
}

function marcarPosUpdate(payload = {}) {
  try {
    const dir = agentDataDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      markerPath(),
      JSON.stringify(
        {
          ...payload,
          marcadoEm: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
    return true;
  } catch {
    return false;
  }
}

function lerMarcadorPosUpdate() {
  try {
    const p = markerPath();
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function limparMarcadorPosUpdate() {
  try {
    const p = markerPath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

/**
 * No boot: se UI quebrada e há backup, rollback automático (evita tela preta eterna).
 * Não exige marcador pós-update — crash mid-apply também deixa SPA inválida.
 * @returns {{ healed: boolean, action?: string, detail?: string }}
 */
function healFrontendOnBoot(agentRoot) {
  const frontendIntegrity = require("./frontendIntegrity");
  const frontDist = path.join(agentRoot, "frontend-dist");
  const check = frontendIntegrity.verificarFrontendDist(frontDist, { skipCache: true });
  if (check.ok) {
    limparMarcadorPosUpdate();
    return { healed: false, action: "ok", detail: "ui íntegra" };
  }

  const marker = lerMarcadorPosUpdate();
  let rolled = false;
  let rollbackErr = null;
  try {
    const manifestUpdater = require("../manifestUpdater");
    if (manifestUpdater.rollbackDisponivel()) {
      manifestUpdater.rollbackUltimo();
      rolled = true;
      frontendIntegrity.invalidateFrontendIntegrityCache();
    }
  } catch (err) {
    rollbackErr = err.message;
  }

  const after = frontendIntegrity.verificarFrontendDist(frontDist, { skipCache: true });
  if (after.ok) {
    limparMarcadorPosUpdate();
    return {
      healed: true,
      action: "rollback",
      detail: marker
        ? `UI restaurada do backup (update ${marker.versao || "?"})`
        : "UI restaurada do backup",
    };
  }

  return {
    healed: false,
    action: "failed",
    detail:
      check.motivo +
      (rolled ? `; rollback não recuperou` : "") +
      (rollbackErr ? `; ${rollbackErr}` : ""),
    faltando: check.faltando,
  };
}

/**
 * Exit code para reinício pelo SCM após update.
 * Windows: exit 0 deixa o serviço STOPPED; recovery só age em falha → use 1.
 */
function exitCodeParaScmRestart() {
  return 1;
}

module.exports = {
  SCM_NAME,
  ensureAutostart,
  ensureFailureRecovery,
  hardenScm,
  marcarPosUpdate,
  lerMarcadorPosUpdate,
  limparMarcadorPosUpdate,
  healFrontendOnBoot,
  exitCodeParaScmRestart,
};

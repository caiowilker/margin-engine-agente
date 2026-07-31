/**
 * Kill de árvore de processo no Windows (taskkill /F /T) com confirmação.
 *
 * Contrato P2a:
 * - Sempre tenta matar o wrapper (PowerShell) no soft/hard timeout.
 * - Mede se o PID sumiu de verdade (taskkill ≠ spooler parou).
 * - Matar o PowerShell NÃO garante abortar job já no spooler/driver USB —
 *   papel ainda pode sair minutos depois (late_abandoned). Métrica deixa isso explícito.
 */
const { execFile } = require("child_process");
const log = require("../logger").child({ modulo: "win_process_kill" });

const IS_WIN = process.platform === "win32";

/**
 * @param {number|undefined|null} pid
 * @returns {boolean}
 */
function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    // ESRCH / EINVAL → morto; EPERM → vivo sem permissão de sinal
    if (err && (err.code === "EPERM" || err.errno === "EPERM")) return true;
    return false;
  }
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function isAlreadyGoneMessage(text) {
  return /not found|não encontrado|nao encontrado|no se encontró|no such process|processo.*não|cannot find/i.test(
    String(text || ""),
  );
}

/**
 * Mata árvore do PID e confirma se sumiu.
 * @param {number} pid
 * @param {{ reason?: string, metric?: string, logResult?: boolean }} [opts]
 * @returns {Promise<{
 *   attempted: boolean,
 *   pid: number|null,
 *   platform: string,
 *   reason: string,
 *   taskkillExitOk: boolean|null,
 *   taskkillAlreadyGone: boolean,
 *   confirmedDead: boolean,
 *   stillAlive: boolean,
 *   stdout: string,
 *   stderr: string,
 *   errMessage: string|null,
 *   durationMs: number,
 * }>}
 */
/** Teto absoluto — execFile timeout no Windows às vezes não dispara sob carga. */
const KILL_HARD_DEADLINE_MS = Math.max(
  1000,
  parseInt(process.env.PRINTER_TASKKILL_HARD_MS || "6000", 10) || 6000,
);

function killProcessTree(pid, opts = {}) {
  const t0 = Date.now();
  const reason = String(opts.reason || "unspecified");
  const metric = opts.metric || "print.taskkill_attempt";
  const logResult = opts.logResult !== false;
  const hardMs = Math.max(
    1000,
    Number(opts.hardDeadlineMs) || KILL_HARD_DEADLINE_MS,
  );
  const n = Number(pid);

  if (!Number.isFinite(n) || n <= 0) {
    const empty = {
      attempted: false,
      pid: null,
      platform: process.platform,
      reason,
      taskkillExitOk: null,
      taskkillAlreadyGone: false,
      confirmedDead: true,
      stillAlive: false,
      stdout: "",
      stderr: "",
      errMessage: null,
      durationMs: 0,
    };
    return Promise.resolve(empty);
  }

  const withHardDeadline = (inner) =>
    Promise.race([
      inner,
      new Promise((resolve) => {
        setTimeout(() => {
          const stillAlive = isPidAlive(n);
          const result = {
            attempted: true,
            pid: n,
            platform: process.platform,
            reason,
            taskkillExitOk: null,
            taskkillAlreadyGone: false,
            confirmedDead: !stillAlive,
            stillAlive,
            stdout: "",
            stderr: "",
            errMessage: `taskkill hard deadline ${hardMs}ms`,
            durationMs: Date.now() - t0,
            hardDeadline: true,
          };
          if (logResult) {
            log.warn(
              { metric, ...result },
              "[WinKill] taskkill hard deadline — liberando sem esperar callback",
            );
          }
          resolve(result);
        }, hardMs);
      }),
    ]);

  if (!IS_WIN) {
    return withHardDeadline(
      new Promise((resolve) => {
        let errMessage = null;
        try {
          process.kill(n, "SIGKILL");
        } catch (err) {
          errMessage = err?.message || String(err);
        }
        // Zombie/reap: PID pode responder a kill(0) por alguns ms
        const deadline = Date.now() + 500;
        const tick = () => {
          const stillAlive = isPidAlive(n);
          if (stillAlive && Date.now() < deadline) {
            setTimeout(tick, 20);
            return;
          }
          const result = {
            attempted: true,
            pid: n,
            platform: process.platform,
            reason,
            taskkillExitOk: !stillAlive,
            taskkillAlreadyGone: false,
            confirmedDead: !stillAlive,
            stillAlive,
            stdout: "",
            stderr: "",
            errMessage,
            durationMs: Date.now() - t0,
          };
          if (logResult) {
            log.warn({ metric, ...result }, "[WinKill] SIGKILL (non-Windows)");
          }
          resolve(result);
        };
        setTimeout(tick, 20);
      }),
    );
  }

  return withHardDeadline(
    new Promise((resolve) => {
      execFile(
        "taskkill",
        ["/F", "/T", "/PID", String(n)],
        { windowsHide: true, timeout: 4000, encoding: "utf8", killSignal: "SIGKILL" },
        (err, stdout, stderr) => {
          const out = String(stdout || "");
          const errOut = String(stderr || "");
          const combined = `${out}\n${errOut}\n${err?.message || ""}`;
          const alreadyGone = isAlreadyGoneMessage(combined);
          const taskkillExitOk = !err || alreadyGone;
          const deadline = Date.now() + 400;
          const tick = () => {
            const stillAlive = isPidAlive(n);
            if (stillAlive && Date.now() < deadline) {
              setTimeout(tick, 40);
              return;
            }
            const result = {
              attempted: true,
              pid: n,
              platform: "win32",
              reason,
              taskkillExitOk,
              taskkillAlreadyGone: alreadyGone,
              confirmedDead: !stillAlive,
              stillAlive,
              stdout: out.slice(0, 400),
              stderr: errOut.slice(0, 400),
              errMessage: err && !alreadyGone ? err.message || String(err) : null,
              durationMs: Date.now() - t0,
            };
            if (logResult) {
              const level = result.stillAlive ? "error" : "warn";
              log[level](
                {
                  metric,
                  ...result,
                  note: result.stillAlive
                    ? "PID ainda vivo após taskkill — handle/driver pode continuar"
                    : "wrapper morto; spooler Windows ainda pode drenar buffer (late paper)",
                },
                result.stillAlive
                  ? "[WinKill] taskkill NÃO confirmou morte do PID"
                  : "[WinKill] taskkill confirmado (wrapper morto)",
              );
            }
            resolve(result);
          };
          setTimeout(tick, 40);
        },
      );
    }),
  );
}

module.exports = {
  killProcessTree,
  isPidAlive,
  isAlreadyGoneMessage,
  KILL_HARD_DEADLINE_MS,
};

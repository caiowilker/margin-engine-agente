/**
 * ACK de update remoto solicitado pelo cloud — persistência entre restarts.
 *
 * Fluxo:
 * 1. Apply cloud OK → grava pending em ProgramData
 * 2. Tenta ACK imediato (best-effort)
 * 3. Após restart → flushPendingAck confirma versão e ACK (idempotente)
 */
const fs = require("fs");
const path = require("path");
const { isSameVersion } = require("./updaterVersion");

const PENDING_NAME = "pending-cloud-update-ack.json";

function pendingPath(deps = {}) {
  if (deps.path) return deps.path;
  try {
    const { getDirectoryManager } = require("./runtime/directoryManager");
    return getDirectoryManager().file("agent", PENDING_NAME);
  } catch {
    return path.join(process.cwd(), "data", PENDING_NAME);
  }
}

function lerPending(deps = {}) {
  const p = pendingPath(deps);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    try {
      fs.unlinkSync(p);
    } catch (_) {}
    return null;
  }
}

function limparPending(deps = {}) {
  const p = pendingPath(deps);
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (_) {}
}

/**
 * Marca que um apply cloud foi gravado no disco e o processo vai reiniciar.
 * @param {{ versaoAlvo: string, origem?: string }} opts
 */
function marcarAposApplyCloud(opts, deps = {}) {
  if ((opts.origem || "") !== "cloud") return false;
  const versaoAlvo = String(opts.versaoAlvo || "").trim();
  if (!versaoAlvo) return false;

  const p = pendingPath(deps);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    p,
    JSON.stringify(
      {
        versaoAlvo,
        appliedAt: new Date().toISOString(),
        origem: "cloud",
      },
      null,
      2,
    ),
    "utf8",
  );
  return true;
}

/**
 * Envia ACK pendente se existir. Idempotente no backend.
 * @returns {Promise<'nenhum'|'ok'|'falha_ack'|'divergente'>}
 */
async function flushPendingAck(opts = {}) {
  const {
    enviarAck,
    lerVersaoAtual,
    log = null,
    deps = {},
  } = opts;

  const pending = lerPending(deps);
  if (!pending?.versaoAlvo) return "nenhum";
  if (typeof enviarAck !== "function") return "nenhum";

  const atual =
    typeof lerVersaoAtual === "function"
      ? String(lerVersaoAtual() || "").trim()
      : "";
  const ok =
    !!atual &&
    (isSameVersion(atual, pending.versaoAlvo) || atual === pending.versaoAlvo);

  try {
    await enviarAck({
      ok,
      agentVersion: atual || pending.versaoAlvo,
      erro: ok
        ? ""
        : `Versão pós-update divergente (esperado ${pending.versaoAlvo}, atual ${atual || "desconhecida"})`,
    });
    limparPending(deps);
    log?.info?.(
      { versaoAlvo: pending.versaoAlvo, agentVersion: atual, ok },
      "ACK cloud pós-restart enviado",
    );
    return ok ? "ok" : "divergente";
  } catch (err) {
    log?.warn?.(
      { err: err.message, versaoAlvo: pending.versaoAlvo },
      "ACK cloud pós-restart falhou — reintentará",
    );
    return "falha_ack";
  }
}

module.exports = {
  PENDING_NAME,
  pendingPath,
  lerPending,
  limparPending,
  marcarAposApplyCloud,
  flushPendingAck,
};

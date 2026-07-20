/**
 * Autoridade local sobre emissão fiscal — SSOT no agente (disco + runtime).
 * O polling do backend nunca sobrescreve emissão após PUT /config/fiscal.
 */
const fs = require("fs");
const path = require("path");
const log = require("./logger").child({ modulo: "fiscal_config_authority" });
const { getDirectoryManager } = require("./runtime/directoryManager");
const { writeJsonAtomicSync } = require("./runtime/atomicWrite");

let localAuthorityAt = null;
let localEmissaoFiscal = null;

function authorityPath() {
  return getDirectoryManager().file("agent", "fiscal-authority.json");
}

function carregarPersistido() {
  try {
    const p = authorityPath();
    if (!fs.existsSync(p)) return;
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    if (raw?.atualizadoEm) localAuthorityAt = raw.atualizadoEm;
    if (typeof raw?.emissaoFiscal === "boolean") {
      localEmissaoFiscal = raw.emissaoFiscal;
    }
  } catch (err) {
    log.warn({ err: err.message }, "[FiscalAuthority] Falha ao carregar persistência");
  }
}

function persistir() {
  if (!localAuthorityAt) return;
  writeJsonAtomicSync(
    authorityPath(),
    {
      atualizadoEm: localAuthorityAt,
      emissaoFiscal: localEmissaoFiscal,
    },
    {
      ensureDir: (dir) => getDirectoryManager().ensurePath(dir, "agentData"),
    },
  );
}

carregarPersistido();

function marcarAutoridadeLocal(emissaoFiscal) {
  localAuthorityAt = new Date().toISOString();
  localEmissaoFiscal = !!emissaoFiscal;
  persistir();
  log.info(
    { emissaoFiscal: localEmissaoFiscal, em: localAuthorityAt },
    "[FiscalAuthority] Config local registrada",
  );
  return { atualizadoEm: localAuthorityAt, emissaoFiscal: localEmissaoFiscal };
}

function temAutoridadeLocal() {
  return localAuthorityAt != null;
}

function temAutoridadeLocalSobreBackend(configAtualizadaEm) {
  if (!localAuthorityAt) return false;
  if (!configAtualizadaEm) return true;
  return new Date(localAuthorityAt).getTime() >= new Date(configAtualizadaEm).getTime();
}

function obterStatus() {
  return {
    localAuthorityAt,
    localEmissaoFiscal,
    ativo: localAuthorityAt != null,
  };
}

async function propagarFiscalAoBackend(lerConfigFn, opts = {}) {
  try {
    const cfg = typeof lerConfigFn === "function" ? await lerConfigFn() : {};
    const backendUrl = cfg.backendUrl || process.env.BACKEND_URL || "";
    const backendToken = cfg.backendToken || process.env.BACKEND_TOKEN || "";
    if (!backendUrl || !backendToken) {
      return { ok: false, reason: "backend_nao_configurado" };
    }

    const bodyObj = {};
    if (typeof opts.fiscalEnabled === "boolean") {
      bodyObj.fiscalEnabled = opts.fiscalEnabled;
    }
    if (opts.ambienteSefaz != null) {
      const amb = String(opts.ambienteSefaz).toLowerCase();
      if (amb === "producao" || amb === "homologacao") {
        bodyObj.ambienteSefaz = amb;
      }
    }
    if (Object.keys(bodyObj).length === 0) {
      return { ok: false, reason: "nada_para_sincronizar" };
    }

    const fetch = require("node-fetch");
    const body = JSON.stringify(bodyObj);
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${backendToken}`,
    };

    let resp = await fetch(`${backendUrl}/pdv/agente/config/sync-fiscal`, {
      method: "POST",
      headers,
      body,
    });

    if (resp.status === 404 && typeof bodyObj.fiscalEnabled === "boolean") {
      resp = await fetch(`${backendUrl}/pdv/agente/config/bootstrap-fiscal`, {
        method: "POST",
        headers,
        body: JSON.stringify({ fiscalEnabled: bodyObj.fiscalEnabled }),
      });
    }

    if (resp.ok) {
      const payload = await resp.json().catch(() => ({}));
      log.info(
        {
          fiscalEnabled: payload.fiscalEnabled ?? bodyObj.fiscalEnabled,
          ambienteSefaz: bodyObj.ambienteSefaz || null,
        },
        "[FiscalAuthority] Backend espelho sincronizado",
      );
      return {
        ok: true,
        fiscalEnabled: payload.fiscalEnabled ?? bodyObj.fiscalEnabled,
        ambienteSefaz: bodyObj.ambienteSefaz || null,
      };
    }

    if (resp.status === 409 || resp.status === 400) {
      return { ok: false, reason: "backend_rejeitou_sync" };
    }

    const txt = await resp.text().catch(() => "");
    return { ok: false, reason: `http_${resp.status}`, detalhe: txt.slice(0, 120) };
  } catch (err) {
    log.debug({ err: err.message }, "[FiscalAuthority] Sync backend falhou");
    return { ok: false, reason: err.message };
  }
}

/** @deprecated use propagarFiscalAoBackend */
async function propagarEmissaoAoBackend(lerConfigFn, fiscalEnabled) {
  return propagarFiscalAoBackend(lerConfigFn, { fiscalEnabled: !!fiscalEnabled });
}

function resetAutoridadeLocal() {
  localAuthorityAt = null;
  localEmissaoFiscal = null;
  try {
    const p = authorityPath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (_) {}
}

module.exports = {
  marcarAutoridadeLocal,
  temAutoridadeLocal,
  temAutoridadeLocalSobreBackend,
  obterStatus,
  propagarEmissaoAoBackend,
  propagarFiscalAoBackend,
  carregarPersistido,
  resetAutoridadeLocal,
};

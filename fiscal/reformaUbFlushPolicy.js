/**
 * REFORMA_UB_FLUSH_REVALIDATION=1
 *
 * Invariante AUD-18 / fila offline:
 * O agente só pode ficar isento de revalidação de kill switch enquanto o
 * montador legado (acbr.montarIniNfce/Nfe) NÃO gerar grupo IBSCBS.
 * Com documentIni do backend (caminho produção), o flush/emissão DEVE
 * revalidar UB antes de enviar à SEFAZ e sanitizar se kill/regime mudou.
 *
 * Espelha FiscalReformaIniUbSanitizer (Java) no agente.
 */
"use strict";

const MARKER = "REFORMA_UB_FLUSH_REVALIDATION=1";

let _cfgReader = null;

function setConfigReader(fn) {
  _cfgReader = typeof fn === "function" ? fn : null;
}

async function resolverCfg(explicit) {
  if (explicit && (explicit.backendUrl || explicit.backendToken)) {
    return explicit;
  }
  if (_cfgReader) {
    try {
      return await _cfgReader();
    } catch (_) {
      /* fall through */
    }
  }
  return {
    backendUrl: process.env.BACKEND_URL || "",
    backendToken: process.env.BACKEND_TOKEN || "",
  };
}

function contemGrupoUb(ini) {
  if (!ini || !String(ini).trim()) return false;
  const s = String(ini);
  return (
    s.includes("[IBSCBS") ||
    s.includes("[gIBSCBS") ||
    s.includes("[gCBS") ||
    s.includes("[gIBS]") ||
    s.includes("[gIBSUF") ||
    s.includes("[gIBSMun")
  );
}

function isSecaoUb(headerLine) {
  const end = headerLine.indexOf("]");
  const nome = end > 1 ? headerLine.slice(1, end) : headerLine.slice(1);
  return (
    nome === "IBSCBSTot" ||
    nome === "gIBS" ||
    nome === "gIBSUFTot" ||
    nome === "gIBSMunTot" ||
    nome === "gCBSTot" ||
    nome.startsWith("IBSCBS") ||
    nome.startsWith("gIBSCBS") ||
    nome.startsWith("gIBSUF") ||
    nome.startsWith("gIBSMun") ||
    nome.startsWith("gCBS")
  );
}

function removerGrupoUb(ini) {
  if (!contemGrupoUb(ini)) return ini;
  const lines = String(ini).split("\n");
  const out = [];
  let emSecaoUb = false;
  for (const line of lines) {
    const header = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (header.startsWith("[")) {
      emSecaoUb = isSecaoUb(header);
      if (emSecaoUb) continue;
    } else if (emSecaoUb) {
      continue;
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Consulta leve GET /pdv/fiscal/reforma/ub-status.
 * @returns {Promise<boolean|null>} true/false se soube; null se backend inacessível
 */
async function consultarUbPermitido(cfg) {
  if (!cfg?.backendUrl || !cfg?.backendToken) return null;
  const base = String(cfg.backendUrl).replace(/\/$/, "");
  const url = `${base}/pdv/fiscal/reforma/ub-status`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${cfg.backendToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (typeof body?.ubPermitido === "boolean") return body.ubPermitido;
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Antes de enviar INI à SEFAZ: se houver IBSCBS e UB não for mais permitido
 * (kill switch / flag off / regime), remove o grupo.
 * Fail-closed: se backend inacessível e INI tem IBSCBS, sanitiza (Dia D).
 *
 * @returns {{ ini: string, sanitizado: boolean, motivo: string|null }}
 */
async function aplicarPoliticaLiveFlush(cfgExplicit, documentIni) {
  const ini = documentIni == null ? "" : String(documentIni);
  if (!contemGrupoUb(ini)) {
    return { ini, sanitizado: false, motivo: null };
  }
  const cfg = await resolverCfg(cfgExplicit);
  const ub = await consultarUbPermitido(cfg);
  if (ub === true) {
    return { ini, sanitizado: false, motivo: null };
  }
  const limpo = removerGrupoUb(ini);
  const motivo =
    ub === false
      ? "ub_nao_permitido_live"
      : "backend_inacessivel_fail_closed";
  return { ini: limpo, sanitizado: true, motivo };
}

module.exports = {
  MARKER,
  setConfigReader,
  contemGrupoUb,
  removerGrupoUb,
  consultarUbPermitido,
  aplicarPoliticaLiveFlush,
};

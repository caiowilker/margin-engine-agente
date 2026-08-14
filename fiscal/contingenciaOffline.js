/**
 * Contingência off-line NFC-e (tpEmis=9 / teOffLine) — isolada da emissão normal
 * e da contingência EPEC (tpEmis=4).
 *
 * Flag: CONTINGENCIA_OFFLINE_AUTO=true
 * Probe: Timeout ACBr 3–5s + 1 retry rápido (não confunde SEFAZ lenta com queda).
 * FormaEmissao só na sessão; never persiste teOffLine no INI.
 */
const fs = require("fs");
const path = require("path");
const fiscalDhEmiIni = require("./fiscalDhEmiIni");
const { writeFileAtomicSync } = require("../runtime/atomicWrite");

const FORMA_NORMAL = "0";
const FORMA_OFFLINE = "9";
const JUSTIFICATIVA_PADRAO = "Falha de comunicacao com a SEFAZ no momento da emissao";

function isEnabled() {
  const raw = String(process.env.CONTINGENCIA_OFFLINE_AUTO || "").trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") return false;
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

function probeTimeoutMs() {
  const n = parseInt(process.env.CONTINGENCIA_OFFLINE_PROBE_MS || "4000", 10);
  return Math.min(5000, Math.max(3000, Number.isFinite(n) ? n : 4000));
}

function probeRetryDelayMs() {
  const n = parseInt(process.env.CONTINGENCIA_OFFLINE_PROBE_RETRY_MS || "700", 10);
  return Math.min(1500, Math.max(300, Number.isFinite(n) ? n : 700));
}

function alertaIdadeHoras() {
  const n = parseFloat(process.env.CONTINGENCIA_OFFLINE_ALERTA_HORAS || "2");
  return Number.isFinite(n) && n > 0 ? n : 2;
}

function isModeloNfce(modelo) {
  return String(modelo || "65") === "65";
}

function statusServicoOperacional(parsed, respostaBruta) {
  const cStat = String(parsed?.cStat || "");
  if (cStat === "107" || cStat === "108") return true;
  const t = String(parsed?.xMotivo || respostaBruta || "").toUpperCase();
  return t.includes("SERVICO EM OPERACAO");
}

function aplicarTpEmisOffline(iniContent, opts = {}) {
  const dhCont = fiscalDhEmiIni.formatarDhEmiAcbrIni(opts.dhCont || new Date());
  let xJust = String(opts.xJust || JUSTIFICATIVA_PADRAO).trim().slice(0, 255);
  if (xJust.length < 15) xJust = JUSTIFICATIVA_PADRAO;

  const lines = String(iniContent || "").split(/\r?\n/);
  let hasTpEmis = false;
  let hasDhCont = false;
  let hasXJust = false;
  const out = lines.map((line) => {
    if (/^tpEmis=/i.test(line)) {
      hasTpEmis = true;
      return "tpEmis=9";
    }
    if (/^dhCont=/i.test(line)) {
      hasDhCont = true;
      return `dhCont=${dhCont}`;
    }
    if (/^xJust=/i.test(line) && !/^xJustificativa=/i.test(line)) {
      hasXJust = true;
      return `xJust=${xJust}`;
    }
    return line;
  });
  if (!hasTpEmis) out.push("tpEmis=9");
  if (!hasDhCont) out.push(`dhCont=${dhCont}`);
  if (!hasXJust) out.push(`xJust=${xJust}`);
  return out.join("\n");
}

function escreverIniOffline(iniPath, opts = {}) {
  const original = fs.readFileSync(iniPath, "utf8");
  const patched = aplicarTpEmisOffline(original, opts);
  const dest = iniPath.replace(/(\.ini)?$/i, "-offline.ini");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  writeFileAtomicSync(dest, patched, { encoding: "utf8" });
  return dest;
}

function lerFormaEmissao(inst) {
  try {
    const v = inst.configLerValor("NFe", "FormaEmissao");
    if (v != null && String(v).trim() !== "") return String(v).trim();
  } catch (_) {}
  try {
    const v = inst.configLerValor("ACBrNFe", "FormaEmissao");
    if (v != null && String(v).trim() !== "") return String(v).trim();
  } catch (_) {}
  return FORMA_NORMAL;
}

function gravarFormaEmissao(inst, valor, log) {
  const v = String(valor ?? FORMA_NORMAL);
  inst.configGravarValor("NFe", "FormaEmissao", v);
  try {
    inst.configGravarValor("ACBrNFe", "FormaEmissao", v);
  } catch (_) {}
  if (log) {
    log.info({ formaEmissao: v }, "[ContingenciaOffline] FormaEmissao alterada (somente sessão)");
  }
}

function lerTimeoutNfe(inst) {
  try {
    const v = inst.configLerValor("NFe", "Timeout");
    if (v != null && String(v).trim() !== "") return String(v).trim();
  } catch (_) {}
  try {
    const v = inst.configLerValor("ACBrNFe", "Timeout");
    if (v != null && String(v).trim() !== "") return String(v).trim();
  } catch (_) {}
  return "30000";
}

function gravarTimeoutNfe(inst, ms) {
  const v = String(ms);
  inst.configGravarValor("NFe", "Timeout", v);
  try {
    inst.configGravarValor("ACBrNFe", "Timeout", v);
  } catch (_) {}
}

function executarProbeOnce(inst, acbrLibResposta) {
  const resposta = inst.statusServico();
  const parsed = acbrLibResposta.parseRespostaLib(resposta);
  const ok = statusServicoOperacional(parsed, resposta);
  return {
    ok,
    cStat: parsed?.cStat || null,
    xMotivo: parsed?.xMotivo || null,
  };
}

/**
 * StatusServico com Timeout ACBr curto. Restaura Timeout imediatamente.
 * Não usa Promise.race no FFI (evita overlap com NFE_Enviar).
 */
function probeStatusServico(inst, acbrLibResposta, log) {
  const timeoutMs = probeTimeoutMs();
  const prevTimeout = lerTimeoutNfe(inst);
  gravarTimeoutNfe(inst, timeoutMs);
  try {
    const r = executarProbeOnce(inst, acbrLibResposta);
    if (!r.ok && log) {
      log.warn(
        { cStat: r.cStat, xMotivo: r.xMotivo, timeoutMs },
        "[ContingenciaOffline] SEFAZ indisponível no probe",
      );
    }
    return { ...r, timeoutMs, tentativas: 1 };
  } catch (err) {
    if (log) {
      log.warn({ err: err.message, timeoutMs }, "[ContingenciaOffline] Probe StatusServico falhou");
    }
    return { ok: false, erro: err.message, timeoutMs, tentativas: 1 };
  } finally {
    gravarTimeoutNfe(inst, prevTimeout);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 1 retry rápido: SEFAZ lenta (timeout pontual) não entra em off-line.
 * Timeout ACBr permanece curto nas duas tentativas; restaura no finally.
 */
async function probeStatusServicoComRetry(inst, acbrLibResposta, log) {
  const timeoutMs = probeTimeoutMs();
  const prevTimeout = lerTimeoutNfe(inst);
  gravarTimeoutNfe(inst, timeoutMs);
  try {
    let first;
    try {
      first = { ...executarProbeOnce(inst, acbrLibResposta), timeoutMs };
    } catch (err) {
      first = { ok: false, erro: err.message, timeoutMs };
    }
    if (first.ok) return { ...first, tentativas: 1 };
    if (log) {
      log.warn(
        { cStat: first.cStat, erro: first.erro, timeoutMs },
        "[ContingenciaOffline] Probe 1/2 falhou — retry rápido antes de off-line",
      );
    }
    await sleep(probeRetryDelayMs());
    let second;
    try {
      second = { ...executarProbeOnce(inst, acbrLibResposta), timeoutMs };
    } catch (err) {
      second = { ok: false, erro: err.message, timeoutMs };
    }
    if (second.ok && log) {
      log.info("[ContingenciaOffline] Probe 2/2 OK — emissão normal (SEFAZ lenta, não queda)");
    } else if (!second.ok && log) {
      log.warn(
        { cStat: second.cStat, erro: second.erro, timeoutMs },
        "[ContingenciaOffline] Probe 2/2 falhou — emissão off-line",
      );
    }
    return { ...second, tentativas: 2, probeAnterior: first };
  } finally {
    gravarTimeoutNfe(inst, prevTimeout);
  }
}

function xmlTemChave(xml, chave) {
  const k = String(chave || "").replace(/\D/g, "");
  if (!xml || k.length !== 44) return false;
  return xml.includes(k) || /Id="NFe\d{44}"/i.test(xml);
}

/**
 * Grava o XML assinado em disco (NFE_GravarXML + fallback atômico) e só então
 * o chamador pode imprimir o DANFE. Nunca imprime sem arquivo verificado.
 */
function gravarXmlAssinado(inst, destDir, chave) {
  const k = String(chave || "").replace(/\D/g, "");
  if (k.length !== 44) {
    throw new Error("[ContingenciaOffline] chave inválida para GravarXML");
  }
  fs.mkdirSync(destDir, { recursive: true });
  const nome = `${k}-nfe.xml`;
  const destino = path.join(destDir, nome);

  let xmlMem = "";
  try {
    xmlMem = String(inst.obterXml(0) || "");
  } catch (_) {}

  let gravouLib = false;
  try {
    if (typeof inst.gravarXml === "function") {
      inst.gravarXml(0, nome, destDir);
      gravouLib = true;
    } else if (typeof inst.gravarXML === "function") {
      inst.gravarXML(0, nome, destDir);
      gravouLib = true;
    }
  } catch (err) {
    gravouLib = false;
    if (!xmlMem) {
      throw new Error(`[ContingenciaOffline] NFE_GravarXML falhou: ${err.message}`);
    }
  }

  let xmlDisco = "";
  if (fs.existsSync(destino)) {
    xmlDisco = fs.readFileSync(destino, "utf8");
  }
  const xml = xmlTemChave(xmlDisco, k) ? xmlDisco : xmlMem;
  if (!xmlTemChave(xml, k)) {
    throw new Error("[ContingenciaOffline] XML assinado vazio ou sem chave após GravarXML");
  }
  writeFileAtomicSync(destino, xml, { encoding: "utf8" });
  const verificado = fs.readFileSync(destino, "utf8");
  if (!xmlTemChave(verificado, k)) {
    throw new Error("[ContingenciaOffline] XML não persistiu no disco — abortando antes da impressão");
  }
  return { xmlPath: destino, xml: verificado, gravouLib };
}

function metaDoXml(xml) {
  const docs = require("../documentosFiscais");
  const chave = docs.extrairChaveDoXml(xml);
  const nNF = xml.match(/<nNF>(\d+)<\/nNF>/i)?.[1] || null;
  const serie = xml.match(/<serie>(\d+)<\/serie>/i)?.[1] || null;
  return { chave, numero: nNF, serie };
}

/**
 * Rede/timeout → reter na fila. Rejeição SEFAZ (cStat 2xx/schema) → intervenção.
 */
function classificarResultadoSync(err) {
  const fiscalRetry = require("../fiscalRetry");
  const cStat = fiscalRetry.extrairCStat(err);
  const n = cStat ? parseInt(cStat, 10) : NaN;

  if (fiscalRetry.isTransient(err) || fiscalRetry.isIncerto(err)) {
    return { tipo: "REDE", reter: true, cStat };
  }
  if (cStat === "103" || cStat === "104" || cStat === "108" || cStat === "109" || cStat === "999" || cStat === "656") {
    return { tipo: "REDE", reter: true, cStat };
  }
  if (cStat === "204" || cStat === "539") {
    return { tipo: "DUPLICIDADE", reter: false, consultar: true, cStat };
  }
  if (fiscalRetry.isPermanente(err)) {
    return { tipo: "REJEICAO", reter: false, cStat };
  }
  if (Number.isFinite(n) && n >= 200 && n < 900 && n !== 656) {
    return { tipo: "REJEICAO", reter: false, cStat };
  }
  if (!cStat) return { tipo: "REDE", reter: true, cStat: null };
  return { tipo: "REJEICAO", reter: false, cStat };
}

function terminalId() {
  return String(
    process.env.PDV_DISPOSITIVO_ID ||
      process.env.CONTINGENCIA_OFFLINE_TERMINAL ||
      "local",
  ).slice(0, 80);
}

module.exports = {
  FORMA_NORMAL,
  FORMA_OFFLINE,
  JUSTIFICATIVA_PADRAO,
  isEnabled,
  probeTimeoutMs,
  probeRetryDelayMs,
  alertaIdadeHoras,
  isModeloNfce,
  statusServicoOperacional,
  aplicarTpEmisOffline,
  escreverIniOffline,
  lerFormaEmissao,
  gravarFormaEmissao,
  probeStatusServico,
  probeStatusServicoComRetry,
  gravarXmlAssinado,
  xmlTemChave,
  metaDoXml,
  classificarResultadoSync,
  terminalId,
};

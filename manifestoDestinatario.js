// Manifesto do Destinatário — sincronização periódica via Distribuição DFe
const log = require("./logger").child({ modulo: "manifesto_destinatario" });

let intervalHandle = null;
let getCfgFn = async () => ({});

function configurar(deps) {
  if (deps?.lerConfig) getCfgFn = deps.lerConfig;
}

async function obterUltNsuBackend(cfg) {
  const url = `${String(cfg.backendUrl || "").replace(/\/$/, "")}/pdv/agente/manifesto/config`;
  const token = cfg.backendToken;
  if (!url || !token) return "0";
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!resp.ok) {
    throw new Error(`Backend manifesto/config HTTP ${resp.status}`);
  }
  const json = await resp.json();
  return json.ultNsu || "0";
}

async function enviarSyncBackend(cfg, payload) {
  const url = `${String(cfg.backendUrl || "").replace(/\/$/, "")}/pdv/agente/manifesto/sync`;
  const token = cfg.backendToken;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Backend manifesto/sync HTTP ${resp.status}: ${txt.slice(0, 200)}`);
  }
  return resp.json();
}

function extrairChaveDoXml(xml) {
  const m =
    xml.match(/Id="NFe(\d{44})"/i) ||
    xml.match(/<chNFe>(\d{44})<\/chNFe>/i) ||
    xml.match(/\b(\d{44})\b/);
  return m ? m[1] : null;
}

async function resolverEmpresaFiscal() {
  try {
    const fiscalLocalConfig = require("./fiscalLocalConfig");
    const snap = fiscalLocalConfig.lerSnapshot?.() || fiscalLocalConfig.lerConfig?.();
    return snap?.empresa || snap || {};
  } catch {
    return {};
  }
}

async function executarSincronizacao(forcar = false) {
  const cfg = await getCfgFn();
  if (!cfg.backendUrl || !cfg.backendToken) {
    return { ignorado: true, motivo: "agente_nao_ativado" };
  }

  const acbr = require("./acbr");
  const empresa = await resolverEmpresaFiscal();
  const cnpj = String(empresa.cnpj || cfg.cnpj || "").replace(/\D/g, "");
  const uf = String(empresa.uf || cfg.uf || "").trim();

  if (cnpj.length !== 14) {
    return { ignorado: true, motivo: "cnpj_empresa_nao_configurado" };
  }

  let ultNsuInicial = "0";
  try {
    ultNsuInicial = await obterUltNsuBackend(cfg);
  } catch (err) {
    log.warn({ err: err.message }, "Falha ao obter ultNSU — usando 0");
  }

  let ultNsuAtual = ultNsuInicial;
  let maxNsu = null;
  const notas = [];
  const limitePaginas = Math.max(1, parseInt(process.env.MANIFESTO_MAX_PAGINAS || "20", 10));

  try {
    for (let pagina = 0; pagina < limitePaginas; pagina++) {
      const nsuAntes = ultNsuAtual;
      const dist = await acbr.distribuicaoDFePorUltNsu(ultNsuAtual, cnpj, uf);
      maxNsu = dist.maxNsu || maxNsu;

      for (const xml of dist.xmls || []) {
        const chave = extrairChaveDoXml(xml);
        if (!chave) continue;
        try {
          await acbr.manifestarCienciaOperacao(chave, cnpj);
        } catch (manifestErr) {
          log.debug({ chave, err: manifestErr.message }, "Manifestação ciência ignorada");
        }
        notas.push({ chaveAcesso: chave, xml });
      }

      ultNsuAtual = dist.ultNsuFinal || ultNsuAtual;
      const cStat = String(dist.cStat || "");
      if (cStat === "137" || !(dist.xmls || []).length) break;
      if (maxNsu && ultNsuAtual === maxNsu) break;
      if (ultNsuAtual === nsuAntes && pagina > 0) break;
    }
  } catch (err) {
    const msg = String(err.message || err);
    const certificado = /certific|expirad|senha|a1|a3/i.test(msg);
    const timeout = /timeout|timed out|ETIMEDOUT/i.test(msg);
    await enviarSyncBackend(cfg, {
      ultNsuInicial,
      ultNsuFinal: ultNsuAtual,
      maxNsu,
      notas,
      mensagem: msg,
      erroCertificado: certificado,
      timeout,
    }).catch((e) => log.warn({ err: e.message }, "Falha ao reportar erro manifesto"));
    return { ok: false, erro: msg };
  }

  const resultado = await enviarSyncBackend(cfg, {
    ultNsuInicial,
    ultNsuFinal: ultNsuAtual,
    maxNsu,
    notas,
    mensagem: `${notas.length} nota(s) processada(s)`,
    erroCertificado: false,
    timeout: false,
  });

  log.info(
    { encontradas: notas.length, importadas: resultado?.notasImportadas },
    "Manifesto do destinatário sincronizado",
  );
  return { ok: true, notas: notas.length, resultado };
}

function iniciarAgendamento() {
  if (intervalHandle) return;
  if ((process.env.MANIFESTO_DESTINATARIO_ENABLED || "true").toLowerCase() === "false") {
    return;
  }
  const horas = parseInt(process.env.MANIFESTO_INTERVAL_HOURS || "4", 10);
  const ms = Math.max(1, horas) * 60 * 60 * 1000;
  intervalHandle = setInterval(() => {
    executarSincronizacao().catch((err) => {
      log.warn({ err: err.message }, "Erro no job manifesto destinatário");
    });
  }, ms);
  log.info({ intervaloHoras: horas }, "Job manifesto do destinatário agendado");
}

function pararAgendamento() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

module.exports = {
  configurar,
  executarSincronizacao,
  iniciarAgendamento,
  pararAgendamento,
};

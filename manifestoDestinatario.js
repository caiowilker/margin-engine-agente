// Manifesto do Destinatário — sincronização DistDFe (NSU) + Ciência + XML completo
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

async function enviarEventoBackend(cfg, payload) {
  const url = `${String(cfg.backendUrl || "").replace(/\/$/, "")}/pdv/agente/manifesto/evento`;
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
    throw new Error(`Backend manifesto/evento HTTP ${resp.status}: ${txt.slice(0, 200)}`);
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

function parseResumoNfe(xmlResumo) {
  const chave =
    xmlResumo.match(/<chNFe>(\d{44})<\/chNFe>/i)?.[1] ||
    xmlResumo.match(/\b(\d{44})\b/)?.[1] ||
    null;
  const cnpjEmitente =
    xmlResumo.match(/<CNPJ>(\d{14})<\/CNPJ>/i)?.[1] ||
    xmlResumo.match(/<CPF>(\d{11})<\/CPF>/i)?.[1] ||
    null;
  const nomeEmitente = xmlResumo.match(/<xNome>([^<]+)<\/xNome>/i)?.[1] || null;
  const valorRaw = xmlResumo.match(/<vNF>([^<]+)<\/vNF>/i)?.[1];
  const dataEmissao =
    xmlResumo.match(/<dhEmi>([^<]+)<\/dhEmi>/i)?.[1] ||
    xmlResumo.match(/<dEmi>([^<]+)<\/dEmi>/i)?.[1] ||
    null;
  return {
    chaveAcesso: chave,
    cnpjEmitente,
    nomeEmitente,
    valorTotal: valorRaw != null ? Number(valorRaw) : null,
    dataEmissao,
    xmlResumo,
  };
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

async function processarDocumentoDist(acbr, item, cnpj, uf, notasOut) {
  const chave = item.chaveAcesso || extrairChaveDoXml(item.xml || item.xmlResumo || "");
  if (!chave || String(chave).length !== 44) return;
  if (notasOut.some((n) => n.chaveAcesso === chave)) return;

  let cienciaOk = false;
  let cienciaCStat = null;
  try {
    const ciencia = await acbr.manifestarCienciaOperacao(chave, cnpj);
    cienciaOk = !!(ciencia && (ciencia.ok || ciencia.cStat));
    cienciaCStat = ciencia?.cStat != null ? String(ciencia.cStat) : null;
  } catch (manifestErr) {
    log.debug({ chave, err: manifestErr.message }, "Manifestação ciência — tentativa registrada");
    // 573 duplicidade = já tinha ciência
    if (/573|duplicidade/i.test(String(manifestErr.message || ""))) {
      cienciaOk = true;
      cienciaCStat = "573";
    }
  }

  let xmlCompleto = item.xml && item.xml.includes("<NFe") ? item.xml : null;
  if (!xmlCompleto) {
    try {
      const dist = await acbr.distribuicaoDFePorChave(chave, cnpj, uf);
      if (dist.xml && dist.xml.includes("<NFe")) {
        xmlCompleto = dist.xml;
      }
    } catch (err) {
      log.debug({ chave, err: err.message }, "DistDFe por chave sem XML completo");
    }
  }

  notasOut.push({
    chaveAcesso: chave,
    tipo: xmlCompleto ? "XML" : "RESUMO",
    xml: xmlCompleto || null,
    nsu: item.nsu || null,
    cnpjEmitente: item.cnpjEmitente || null,
    nomeEmitente: item.nomeEmitente || null,
    valorTotal: item.valorTotal != null ? item.valorTotal : null,
    dataEmissao: item.dataEmissao || null,
    cnpjDestinatario: cnpj,
    cienciaRegistrada: cienciaOk,
    cienciaCStat,
    ultimoTpEvento: cienciaOk ? "210210" : null,
  });
}

async function executarSincronizacao(forcar = false) {
  const cfg = await getCfgFn();
  if (!cfg.backendUrl || !cfg.backendToken) {
    return { ok: false, ignorado: true, motivo: "agente_nao_ativado", notasImportadas: 0, notasEncontradas: 0 };
  }

  const acbr = require("./acbr");
  const empresa = await resolverEmpresaFiscal();
  const cnpj = String(empresa.cnpj || cfg.cnpj || "").replace(/\D/g, "");
  const uf = String(empresa.uf || cfg.uf || "").trim();

  if (cnpj.length !== 14) {
    return { ok: false, ignorado: true, motivo: "cnpj_empresa_nao_configurado", notasImportadas: 0, notasEncontradas: 0 };
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
  const limitePaginas = Math.max(1, parseInt(process.env.MANIFESTO_MAX_PAGINAS || "50", 10));

  try {
    for (let pagina = 0; pagina < limitePaginas; pagina++) {
      const nsuAntes = ultNsuAtual;
      const dist = await acbr.distribuicaoDFePorUltNsu(ultNsuAtual, cnpj, uf);
      maxNsu = dist.maxNsu || maxNsu;

      for (const xml of dist.xmls || []) {
        await processarDocumentoDist(
          acbr,
          { xml, chaveAcesso: extrairChaveDoXml(xml) },
          cnpj,
          uf,
          notas,
        );
      }

      for (const resumo of dist.resumos || []) {
        const parsed = typeof resumo === "string" ? parseResumoNfe(resumo) : resumo;
        if (!parsed?.chaveAcesso) continue;
        // Evita duplicar se já veio XML completo da mesma chave nesta sync
        if (notas.some((n) => n.chaveAcesso === parsed.chaveAcesso)) continue;
        await processarDocumentoDist(acbr, parsed, cnpj, uf, notas);
      }

      ultNsuAtual = dist.ultNsuFinal || ultNsuAtual;
      const cStat = String(dist.cStat || "");
      if (cStat === "137" || (!(dist.xmls || []).length && !(dist.resumos || []).length)) break;
      if (maxNsu && ultNsuAtual === maxNsu) break;
      if (ultNsuAtual === nsuAntes && pagina > 0) break;
    }
  } catch (err) {
    const msg = String(err.message || err);
    const certificado = /certific|expirad|senha|a1|a3/i.test(msg);
    const timeout = /timeout|timed out|ETIMEDOUT/i.test(msg);
    const resultadoErro = await enviarSyncBackend(cfg, {
      ultNsuInicial,
      ultNsuFinal: ultNsuAtual,
      maxNsu,
      notas,
      mensagem: msg,
      erroCertificado: certificado,
      timeout,
    }).catch((e) => {
      log.warn({ err: e.message }, "Falha ao reportar erro manifesto");
      return null;
    });
    return {
      ok: false,
      erro: msg,
      notasEncontradas: notas.length,
      notasImportadas: resultadoErro?.notasImportadas ?? 0,
      notasResumo: resultadoErro?.notasResumo ?? 0,
      resultado: resultadoErro,
    };
  }

  const resultado = await enviarSyncBackend(cfg, {
    ultNsuInicial,
    ultNsuFinal: ultNsuAtual,
    maxNsu,
    notas,
    mensagem: `${notas.length} documento(s) processado(s)`,
    erroCertificado: false,
    timeout: false,
  });

  log.info(
    { encontradas: notas.length, importadas: resultado?.notasImportadas, resumos: resultado?.notasResumo },
    "Manifesto do destinatário sincronizado",
  );

  return {
    ok: true,
    notas: notas.length,
    notasEncontradas: resultado?.notasEncontradas ?? notas.length,
    notasImportadas: resultado?.notasImportadas ?? 0,
    notasResumo: resultado?.notasResumo ?? 0,
    mensagem: resultado?.mensagem,
    resultado,
  };
}

async function executarEventoManifestacao(tpEvento, chaveAcesso, xJust) {
  const cfg = await getCfgFn();
  if (!cfg.backendUrl || !cfg.backendToken) {
    throw new Error("Agente não ativado — configure o token do backend.");
  }
  const acbr = require("./acbr");
  const empresa = await resolverEmpresaFiscal();
  const cnpj = String(empresa.cnpj || cfg.cnpj || "").replace(/\D/g, "");
  if (cnpj.length !== 14) {
    throw new Error("CNPJ da empresa não configurado no agente.");
  }
  const chave = String(chaveAcesso || "").replace(/\D/g, "");
  const resultado = await acbr.manifestarEventoDestinatario(chave, cnpj, tpEvento, xJust);
  const backend = await enviarEventoBackend(cfg, {
    chaveAcesso: chave,
    tpEvento: String(tpEvento),
    justificativa: xJust || null,
    ok: !!resultado.ok,
    cStat: resultado.cStat != null ? String(resultado.cStat) : null,
    xMotivo: resultado.xMotivo || null,
  });
  return { ok: !!resultado.ok, ...resultado, documento: backend };
}

function iniciarAgendamento() {
  if (intervalHandle) return;
  if ((process.env.MANIFESTO_DESTINATARIO_ENABLED || "true").toLowerCase() === "false") {
    return;
  }
  const horas = Math.max(1, parseInt(process.env.MANIFESTO_INTERVAL_HOURS || "4", 10));
  const ms = horas * 60 * 60 * 1000;
  intervalHandle = setInterval(() => {
    executarSincronizacao(false).catch((err) =>
      log.warn({ err: err.message }, "Falha no job de manifesto"),
    );
  }, ms);
  log.info({ horas }, "Job Manifesto do Destinatário agendado");
}

module.exports = {
  configurar,
  executarSincronizacao,
  executarEventoManifestacao,
  iniciarAgendamento,
  parseResumoNfe,
};

// Manifesto do Destinatário — sincronização DistDFe (NSU) + Ciência + XML completo
const log = require("./logger").child({ modulo: "manifesto_destinatario" });

let intervalHandle = null;
let getCfgFn = async () => ({});

/** Cache curto do cadastro fiscal (evita martelar /pdv/empresa no job). */
let empresaCache = { at: 0, data: null };
const EMPRESA_CACHE_MS = 5 * 60 * 1000;

function configurar(deps) {
  if (deps?.lerConfig) getCfgFn = deps.lerConfig;
}

function ambienteSefazAtual() {
  try {
    const fiscalLocalConfig = require("./fiscalLocalConfig");
    const snap = fiscalLocalConfig.lerSnapshot?.() || {};
    return String(snap.ambienteSefaz || process.env.AMBIENTE_SEFAZ || "homologacao").toLowerCase();
  } catch {
    return String(process.env.AMBIENTE_SEFAZ || "homologacao").toLowerCase();
  }
}

async function obterUltNsuBackend(cfg) {
  const url = `${String(cfg.backendUrl || "").replace(/\/$/, "")}/pdv/agente/manifesto/config`;
  const token = cfg.backendToken;
  if (!url || !token) return "0";
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!resp.ok) {
    const err = new Error(`Backend manifesto/config HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
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

/**
 * Resolve CNPJ/UF do destinatário.
 * Emissão fiscal traz empresa no payload da venda; DistDFe não tem payload —
 * por isso busca GET /pdv/empresa (SSOT do tenant) com fallbacks locais.
 */
async function resolverEmpresaFiscal(cfg) {
  const agora = Date.now();
  if (empresaCache.data && agora - empresaCache.at < EMPRESA_CACHE_MS) {
    return empresaCache.data;
  }

  let fromBackend = null;
  if (cfg?.backendUrl && cfg?.backendToken) {
    try {
      const url = `${String(cfg.backendUrl).replace(/\/$/, "")}/pdv/empresa`;
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${cfg.backendToken}`, Accept: "application/json" },
      });
      if (resp.ok) {
        fromBackend = await resp.json();
      } else {
        log.warn({ status: resp.status }, "Falha ao obter /pdv/empresa para DistDFe");
      }
    } catch (err) {
      log.warn({ err: err.message }, "Erro de rede ao obter /pdv/empresa para DistDFe");
    }
  }

  let snap = {};
  try {
    const fiscalLocalConfig = require("./fiscalLocalConfig");
    snap = fiscalLocalConfig.lerSnapshot?.() || fiscalLocalConfig.lerConfig?.() || {};
  } catch {
    snap = {};
  }

  const cnpj = String(
    fromBackend?.cnpj ||
      snap?.empresa?.cnpj ||
      cfg?.cnpj ||
      process.env.NFE_CNPJ ||
      "",
  ).replace(/\D/g, "");

  const uf = String(
    fromBackend?.uf || snap?.empresa?.uf || snap?.uf || cfg?.uf || process.env.NFE_UF || "",
  )
    .trim()
    .toUpperCase();

  const data = {
    cnpj,
    uf,
    razaoSocial: fromBackend?.razaoSocial || snap?.empresa?.razaoSocial || null,
    fonte: fromBackend?.cnpj ? "backend" : cnpj ? "local" : "ausente",
  };
  if (cnpj.length === 14) {
    empresaCache = { at: agora, data };
  }
  return data;
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

function cienciaRegistradaOk(ciencia, acbr) {
  if (!ciencia) return false;
  if (ciencia.ok === true) return true;
  const cs = ciencia.cStat != null ? String(ciencia.cStat) : "";
  if (typeof acbr.isCStatManifestacaoOk === "function") {
    return acbr.isCStatManifestacaoOk(cs, ciencia.raw || "");
  }
  return cs === "135" || cs === "136" || cs === "573";
}

async function processarDocumentoDist(fiscalApi, item, cnpj, uf, notasOut) {
  const chave = item.chaveAcesso || extrairChaveDoXml(item.xml || item.xmlResumo || "");
  if (!chave || String(chave).length !== 44) return;
  if (notasOut.some((n) => n.chaveAcesso === chave)) return;

  let cienciaOk = false;
  let cienciaCStat = null;
  try {
    const ciencia = await fiscalApi.manifestarCienciaOperacao(chave, cnpj);
    cienciaOk = cienciaRegistradaOk(ciencia, fiscalApi);
    cienciaCStat = ciencia?.cStat != null ? String(ciencia.cStat) : null;
  } catch (manifestErr) {
    log.debug({ chave, err: manifestErr.message }, "Manifestação ciência — tentativa registrada");
    // 573 duplicidade = já tinha ciência
    if (/573|duplicidade/i.test(String(manifestErr.message || ""))) {
      cienciaOk = true;
      cienciaCStat = "573";
    }
  }

  let xmlCompleto = item.xml && /<NFe[\s>]/i.test(item.xml) ? item.xml : null;
  if (!xmlCompleto) {
    try {
      const dist = await fiscalApi.distribuicaoDFePorChave(chave, cnpj, uf);
      if (dist.xml && /<NFe[\s>]/i.test(dist.xml)) {
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

function respostaIgnorada(motivo, extras = {}) {
  return {
    ok: false,
    ignorado: true,
    motivo,
    erro: extras.erro || mensagemMotivo(motivo),
    notasImportadas: 0,
    notasEncontradas: 0,
    notasResumo: 0,
    ambiente: ambienteSefazAtual(),
    ...extras,
  };
}

function mensagemMotivo(motivo) {
  switch (motivo) {
    case "agente_nao_ativado":
      return "Agente sem backendUrl/token — DistDFe não executado.";
    case "cnpj_empresa_nao_configurado":
      return "CNPJ da empresa não encontrado (cadastro do tenant / NFE_CNPJ).";
    case "uf_empresa_nao_configurada":
      return "UF da empresa não configurada — necessária para DistDFe.";
    default:
      return `Sincronização ignorada: ${motivo}`;
  }
}

/**
 * Decide se a página DistDFe encerra o loop e se o NSU pode avançar.
 * cStat 138/139 sem docs parseáveis = falha de extração (não avançar NSU).
 */
function avaliarPaginaDist(dist) {
  const cStat = String(dist?.cStat || "");
  const xMotivo = dist?.xMotivo || "";
  const hasDocs = (dist?.xmls || []).length > 0 || (dist?.resumos || []).length > 0;

  if (["656"].includes(cStat)) {
    return {
      parar: true,
      naoAvancarNsu: true,
      erro: xMotivo || `DistDFe consumo indevido (cStat ${cStat}). Aguarde antes de nova consulta.`,
    };
  }
  if (cStat === "137") {
    return { parar: true, erro: null };
  }
  if (hasDocs) {
    return { parar: false, erro: null };
  }
  if (cStat === "138" || cStat === "139") {
    return {
      parar: true,
      erro:
        xMotivo ||
        `DistDFe cStat ${cStat} sem nfeProc/resNFe parseáveis — NSU não avançará nesta execução.`,
      naoAvancarNsu: true,
    };
  }
  return { parar: true, erro: null };
}

async function executarSincronizacao(_forcar = false) {
  const cfg = await getCfgFn();
  const ambiente = ambienteSefazAtual();

  if (!cfg.backendUrl || !cfg.backendToken) {
    return respostaIgnorada("agente_nao_ativado");
  }

  const empresa = await resolverEmpresaFiscal(cfg);
  const cnpj = String(empresa.cnpj || "").replace(/\D/g, "");
  const uf = String(empresa.uf || "").trim();

  if (cnpj.length !== 14) {
    return respostaIgnorada("cnpj_empresa_nao_configurado", {
      erro:
        "CNPJ da empresa não configurado. Cadastre o CNPJ do tenant (GET /pdv/empresa) ou NFE_CNPJ no agente.",
    });
  }
  if (!uf) {
    return respostaIgnorada("uf_empresa_nao_configurada");
  }

  const fiscalDriver = require("./fiscalDriver");

  let ultNsuInicial = "0";
  try {
    ultNsuInicial = await obterUltNsuBackend(cfg);
  } catch (err) {
    const status = err.status || 0;
    if (status === 401 || status === 403) {
      return {
        ok: false,
        erro: `Token do agente sem acesso ao manifesto/config (HTTP ${status}). Reative o dispositivo.`,
        notasImportadas: 0,
        notasEncontradas: 0,
        ambiente,
      };
    }
    log.warn({ err: err.message }, "Falha ao obter ultNSU — usando 0");
  }

  let ultNsuAtual = ultNsuInicial;
  let maxNsu = null;
  let ultimoCStat = null;
  let ultimoXMotivo = null;
  const notas = [];
  const limitePaginas = Math.max(1, parseInt(process.env.MANIFESTO_MAX_PAGINAS || "50", 10));
  let nsuTravado = false;
  const driverInfo = typeof fiscalDriver.getDriverInfo === "function" ? fiscalDriver.getDriverInfo() : null;

  try {
    for (let pagina = 0; pagina < limitePaginas; pagina++) {
      const nsuAntes = ultNsuAtual;
      const dist = await fiscalDriver.distribuicaoDFePorUltNsu(ultNsuAtual, cnpj, uf);
      maxNsu = dist.maxNsu || maxNsu;
      ultimoCStat = dist.cStat != null ? String(dist.cStat) : ultimoCStat;
      ultimoXMotivo = dist.xMotivo || ultimoXMotivo;

      for (const xml of dist.xmls || []) {
        await processarDocumentoDist(
          fiscalDriver,
          { xml, chaveAcesso: extrairChaveDoXml(xml) },
          cnpj,
          uf,
          notas,
        );
      }

      for (const resumo of dist.resumos || []) {
        const parsed = typeof resumo === "string" ? parseResumoNfe(resumo) : resumo;
        if (!parsed?.chaveAcesso) continue;
        if (notas.some((n) => n.chaveAcesso === parsed.chaveAcesso)) continue;
        await processarDocumentoDist(fiscalDriver, parsed, cnpj, uf, notas);
      }

      const avaliacao = avaliarPaginaDist(dist);
      if (avaliacao.naoAvancarNsu) {
        nsuTravado = true;
        ultNsuAtual = nsuAntes;
        throw new Error(avaliacao.erro);
      }

      if (!nsuTravado) {
        ultNsuAtual = dist.ultNsuFinal || ultNsuAtual;
      }

      if (avaliacao.erro && !avaliacao.naoAvancarNsu) {
        throw new Error(avaliacao.erro);
      }
      if (avaliacao.parar) break;
      if (maxNsu && ultNsuAtual === maxNsu) break;
      if (ultNsuAtual === nsuAntes && pagina > 0) break;
    }
  } catch (err) {
    const msg = String(err.message || err);
    const certificado = /certific|expirad|senha|a1|a3/i.test(msg);
    const timeout = /timeout|timed out|ETIMEDOUT/i.test(msg);
    const resultadoErro = await enviarSyncBackend(cfg, {
      ultNsuInicial,
      ultNsuFinal: nsuTravado ? ultNsuInicial : ultNsuAtual,
      maxNsu,
      notas,
      mensagem: msg,
      erroCertificado: certificado,
      timeout,
      falha: true,
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
      ambiente,
      cStat: ultimoCStat,
      xMotivo: ultimoXMotivo,
      cnpjDestinatario: cnpj,
      fonteEmpresa: empresa.fonte,
    };
  }

  let resultado;
  try {
    resultado = await enviarSyncBackend(cfg, {
      ultNsuInicial,
      ultNsuFinal: ultNsuAtual,
      maxNsu,
      notas,
      mensagem:
        notas.length > 0
          ? `${notas.length} documento(s) processado(s)`
          : ultimoXMotivo ||
            `Nenhum documento DistDFe (cStat ${ultimoCStat || "—"}; ambiente ${ambiente})`,
      erroCertificado: false,
      timeout: false,
      falha: false,
    });
  } catch (err) {
    log.error({ err: err.message, notas: notas.length }, "DistDFe ok mas falha ao gravar sync no backend");
    return {
      ok: false,
      erro: err.message,
      notasEncontradas: notas.length,
      notasImportadas: 0,
      notasResumo: 0,
      ambiente,
      cStat: ultimoCStat,
      cnpjDestinatario: cnpj,
    };
  }

  log.info(
    {
      encontradas: notas.length,
      importadas: resultado?.notasImportadas,
      resumos: resultado?.notasResumo,
      cStat: ultimoCStat,
      ambiente,
      cnpj: cnpj.slice(0, 8) + "******",
      fonteEmpresa: empresa.fonte,
      driver: driverInfo?.provider || driverInfo?.mode || null,
      native: driverInfo?.native === true,
    },
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
    ambiente,
    cStat: ultimoCStat,
    xMotivo: ultimoXMotivo,
    cnpjDestinatario: cnpj,
    fonteEmpresa: empresa.fonte,
    ultNsuFinal: ultNsuAtual,
    driver: driverInfo?.provider || null,
    native: driverInfo?.native === true,
  };
}

async function executarEventoManifestacao(tpEvento, chaveAcesso, xJust) {
  const cfg = await getCfgFn();
  if (!cfg.backendUrl || !cfg.backendToken) {
    throw new Error("Agente não ativado — configure o token do backend.");
  }
  const fiscalDriver = require("./fiscalDriver");
  const empresa = await resolverEmpresaFiscal(cfg);
  const cnpj = String(empresa.cnpj || "").replace(/\D/g, "");
  if (cnpj.length !== 14) {
    throw new Error(
      "CNPJ da empresa não configurado. Cadastre o CNPJ do tenant ou NFE_CNPJ no agente.",
    );
  }
  const chave = String(chaveAcesso || "").replace(/\D/g, "");
  const resultado = await fiscalDriver.manifestarEventoDestinatario(chave, cnpj, tpEvento, xJust);
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

/** Invalida cache de empresa (testes / após alteração cadastral). */
function limparCacheEmpresa() {
  empresaCache = { at: 0, data: null };
}

module.exports = {
  configurar,
  executarSincronizacao,
  executarEventoManifestacao,
  iniciarAgendamento,
  parseResumoNfe,
  resolverEmpresaFiscal,
  avaliarPaginaDist,
  cienciaRegistradaOk,
  limparCacheEmpresa,
};

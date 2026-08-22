// Manifesto do Destinatário — sincronização DistDFe (NSU) + Ciência + XML completo
const fs = require("fs");
const log = require("./logger").child({ modulo: "manifesto_destinatario" });

let intervalHandle = null;
let getCfgFn = async () => ({});

/** Cache curto do cadastro fiscal (evita martelar /pdv/empresa no job). */
let empresaCache = { at: 0, data: null };
const EMPRESA_CACHE_MS = 5 * 60 * 1000;

/** Após cStat 656 a SEFAZ exige ~1h sem nova DistDFe no mesmo CNPJ. */
let cooldown656AteMs = 0;
const COOLDOWN_656_MS_DEFAULT = 60 * 60 * 1000;

function cooldown656MsConfig() {
  const n = parseInt(process.env.MANIFESTO_656_COOLDOWN_MS || "", 10);
  return Number.isFinite(n) && n >= 60_000 ? n : COOLDOWN_656_MS_DEFAULT;
}

function cooldown656Path() {
  try {
    return require("./runtime/directoryManager").getDirectoryManager().file(
      "agent",
      "manifesto-dist-cooldown.json",
    );
  } catch {
    return null;
  }
}

function carregarCooldown656() {
  const p = cooldown656Path();
  if (!p || !fs.existsSync(p)) return;
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const ate = Number(j?.ateMs);
    if (Number.isFinite(ate) && ate > Date.now()) {
      cooldown656AteMs = ate;
    } else {
      cooldown656AteMs = 0;
    }
  } catch {
    /* ignore */
  }
}

function persistirCooldown656(ateMs) {
  cooldown656AteMs = ateMs;
  const p = cooldown656Path();
  if (!p) return;
  try {
    const { writeJsonAtomicSync } = require("./runtime/atomicWrite");
    writeJsonAtomicSync(
      p,
      { ateMs, registradoEm: new Date().toISOString(), cStat: "656" },
      {
        ensureDir: (dir) =>
          require("./runtime/directoryManager").getDirectoryManager().ensurePath(dir, "agentData"),
      },
    );
  } catch (err) {
    log.debug({ err: err.message }, "Falha ao persistir cooldown DistDFe 656");
  }
}

function registrarCooldown656() {
  persistirCooldown656(Date.now() + cooldown656MsConfig());
}

function restanteCooldown656Ms() {
  carregarCooldown656();
  return Math.max(0, cooldown656AteMs - Date.now());
}

function mensagemConsumoIndevido(xMotivo) {
  const base =
    xMotivo ||
    "Rejeição: Consumo Indevido (utilize o ultNSU nas solicitações subsequentes. Tente após 1 hora)";
  return (
    `${base}. ` +
    "A SEFAZ bloqueia DistDFe por ~1h quando há consultas demais ou outro sistema " +
    "(Sieg, Arquivei, Domínio, etc.) consulta o mesmo CNPJ. Não clique em sincronizar de novo agora."
  );
}

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

/** Zera cursor DistDFe no backend (fallback se o sync de erro não corrigir). */
async function zerarNsuBackend(cfg, motivo) {
  const base = String(cfg.backendUrl || "").replace(/\/$/, "");
  const token = cfg.backendToken;
  if (!base || !token) return null;
  const q = motivo ? `?motivo=${encodeURIComponent(String(motivo).slice(0, 200))}` : "";
  const resp = await fetch(`${base}/pdv/agente/manifesto/nsu/zerar${q}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Backend manifesto/nsu/zerar HTTP ${resp.status}: ${txt.slice(0, 200)}`);
  }
  return resp.json();
}

/**
 * DistDFe já avançou o cursor na SEFAZ. Se o POST /sync falhar depois disso,
 * o backend fica no NSU antigo e a próxima execução reconsulta o mesmo lote
 * (causa raiz típica de uq_manifesto_doc_tenant_chave). Persiste só o cursor.
 */
async function persistirCursorNsu(cfg, { ultNsuInicial, ultNsuFinal, maxNsu, mensagem }) {
  if (!ultNsuFinal) return null;
  return enviarSyncBackend(cfg, {
    ultNsuInicial: ultNsuInicial || "0",
    ultNsuFinal,
    maxNsu: maxNsu || null,
    notas: [],
    mensagem: mensagem || `Cursor DistDFe persistido (ultNSU=${ultNsuFinal})`,
    erroCertificado: false,
    timeout: false,
    falha: false,
  });
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
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2500);
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${cfg.backendToken}`, Accept: "application/json" },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
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

  // Após ciência, consultar situação da NF-e para obter cStat de AUTORIZAÇÃO (100/101/etc)
  // — necessário para escrituração fiscal (cStat de ciência 135/136 não é autorização).
  let autorizacaoCStat = null;
  let autorizacaoXMotivo = null;
  let autorizacaoSituacao = null;
  try {
    const consulta = await fiscalApi.consultarChave(chave, cnpj, uf);
    if (consulta?.cStat != null) {
      autorizacaoCStat = String(consulta.cStat);
      autorizacaoXMotivo = consulta.xMotivo || consulta.situacao || null;
      autorizacaoSituacao = consulta.situacao || null;
    }
  } catch (consultaErr) {
    log.debug(
      { chave, err: consultaErr.message },
      "Consulta autorização opcional — tentativa registrada (não bloqueia sync)",
    );
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
    autorizacaoCStat,
    autorizacaoXMotivo,
    autorizacaoSituacao,
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
    case "consumo_indevido_cooldown":
      return "SEFAZ bloqueou DistDFe (consumo indevido). Aguarde o cooldown antes de nova consulta.";
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

  if (["656"].includes(cStat) || /consumo indevido/i.test(xMotivo)) {
    return {
      parar: true,
      naoAvancarNsu: true,
      consumoIndevido: true,
      erro: mensagemConsumoIndevido(xMotivo),
    };
  }
  // cStat 589 — NSU informado superior ao maior NSU do Ambiente Nacional
  if (
    cStat === "589" ||
    /nsu.*superior.*maior|superior ao maior nsu|nsu informado superior/i.test(xMotivo)
  ) {
    return {
      parar: true,
      naoAvancarNsu: true,
      nsuSuperiorMax: true,
      erro:
        xMotivo ||
        "Rejeicao: Numero do NSU informado superior ao maior NSU da base de dados do Ambiente Nacional (cStat 589)",
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
  if (!cStat) {
    return {
      parar: true,
      naoAvancarNsu: true,
      erro:
        xMotivo ||
        "DistDFe sem cStat na resposta ACBr — verifique logs em acbr/logs e Ambiente/certificado.",
    };
  }
  return { parar: true, erro: null };
}

/** Evita sync DistDFe concorrente (manual + job) no mesmo processo. */
let syncInFlight = null;

async function executarSincronizacao(_forcar = false) {
  if (syncInFlight) {
    return syncInFlight;
  }
  syncInFlight = executarSincronizacaoCore(_forcar).finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

async function executarSincronizacaoCore(_forcar = false) {
  const cfg = await getCfgFn();
  const ambiente = ambienteSefazAtual();

  if (!cfg.backendUrl || !cfg.backendToken) {
    return respostaIgnorada("agente_nao_ativado");
  }

  const restCooldown = restanteCooldown656Ms();
  if (restCooldown > 0) {
    const min = Math.max(1, Math.ceil(restCooldown / 60_000));
    return respostaIgnorada("consumo_indevido_cooldown", {
      erro:
        `SEFAZ bloqueou DistDFe (consumo indevido cStat 656). Aguarde ${min} min antes de nova consulta. ` +
        "Se o contador usa Sieg/Arquivei/Domínio no mesmo CNPJ, peça para espaçar ou pausar a busca automática.",
      cooldownMs: restCooldown,
      cStat: "656",
    });
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

  let ultNsuInicial = null;
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
    log.warn({ err: err.message }, "Falha ao obter ultNSU — abortando sync (não reinicia NSU em 0)");
    return respostaIgnorada("ult_nsu_indisponivel", {
      erro:
        `Não foi possível obter o último NSU do backend (${err.message}). ` +
        "Sync DistDFe abortado para evitar reconsulta completa e cStat 656.",
    });
  }
  if (ultNsuInicial == null || ultNsuInicial === "") {
    ultNsuInicial = "0";
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
      if (avaliacao.consumoIndevido) {
        registrarCooldown656();
      }
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
    if (/consumo indevido|cStat\s*656/i.test(msg)) {
      registrarCooldown656();
    }
    const certificado = /certific|expirad|senha|a1|a3/i.test(msg);
    const timeout = /timeout|timed out|ETIMEDOUT/i.test(msg);
    const nsuSuperior =
      String(ultimoCStat || "") === "589" ||
      /nsu.*superior.*maior|superior ao maior nsu|cStat\s*589/i.test(msg);
    const resultadoErro = await enviarSyncBackend(cfg, {
      ultNsuInicial,
      // ultNsuAtual já volta para o NSU da página anterior quando nsuTravado.
      // Mandar ultNsuInicial aqui apagava o avanço das páginas que deram certo.
      ultNsuFinal: ultNsuAtual,
      maxNsu,
      notas,
      mensagem: msg,
      erroCertificado: certificado,
      timeout,
      falha: true,
      cStat: ultimoCStat || (nsuSuperior ? "589" : null),
    }).catch((e) => {
      log.warn({ err: e.message }, "Falha ao reportar erro manifesto");
      return null;
    });
    // Se o POST /sync falhou ou não resetou, zera o cursor via endpoint dedicado.
    if (nsuSuperior && !(resultadoErro && resultadoErro.nsuResetado === true)) {
      await zerarNsuBackend(
        cfg,
        msg.slice(0, 180) || "Agente: cStat 589 NSU superior ao máximo do AN",
      ).catch((e) => {
        log.warn({ err: e.message }, "Falha ao zerar NSU após cStat 589");
      });
    }
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
    let retry = null;
    try {
      retry = await enviarSyncBackend(cfg, {
        ultNsuInicial,
        ultNsuFinal: ultNsuAtual,
        maxNsu,
        notas,
        mensagem:
          notas.length > 0
            ? `${notas.length} documento(s) processado(s) (retry)`
            : ultimoXMotivo || `Retry sync DistDFe (cStat ${ultimoCStat || "—"})`,
        erroCertificado: false,
        timeout: false,
        falha: false,
      });
    } catch (errRetry) {
      // Só avança o cursor se não há notas a gravar. Com notas, avançar aqui
      // descarta o lote na SEFAZ para sempre. Reconsultar é seguro (upsert).
      if (notas.length === 0) {
        log.warn(
          { err: errRetry.message, ultNsuFinal: ultNsuAtual },
          "Retry de sync vazio falhou — persistindo cursor NSU (nada a perder)",
        );
        await persistirCursorNsu(cfg, {
          ultNsuInicial,
          ultNsuFinal: ultNsuAtual,
          maxNsu,
          mensagem: `Cursor DistDFe persistido após falha no sync vazio: ${errRetry.message}`,
        }).catch((e) => {
          log.warn({ err: e.message, ultNsuFinal: ultNsuAtual }, "Falha ao persistir cursor NSU após erro de sync");
          return null;
        });
      } else {
        log.warn(
          { err: errRetry.message, notas: notas.length, ultNsuFinal: ultNsuAtual },
          "Retry de sync falhou com notas — cursor NÃO avança; próxima execução reconsulta (idempotente)",
        );
      }
      return {
        ok: false,
        erro: errRetry.message,
        notasEncontradas: notas.length,
        notasImportadas: 0,
        notasResumo: 0,
        ambiente,
        cStat: ultimoCStat,
        cnpjDestinatario: cnpj,
        ultNsuFinal: notas.length === 0 ? ultNsuAtual : ultNsuInicial,
      };
    }
    resultado = retry;
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

function limparCooldown656() {
  cooldown656AteMs = 0;
  const p = cooldown656Path();
  if (p && fs.existsSync(p)) {
    try {
      fs.unlinkSync(p);
    } catch (_) {
      /* ignore */
    }
  }
}

module.exports = {
  configurar,
  executarSincronizacao,
  persistirCursorNsu,
  executarEventoManifestacao,
  iniciarAgendamento,
  parseResumoNfe,
  resolverEmpresaFiscal,
  avaliarPaginaDist,
  cienciaRegistradaOk,
  limparCacheEmpresa,
  limparCooldown656,
  restanteCooldown656Ms,
  registrarCooldown656,
};

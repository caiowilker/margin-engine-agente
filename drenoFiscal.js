// Dreno de NFC-e devidas — vendas fiscais deste terminal que nenhuma tentativa levou à fila
// (cupom de segurança no F12, agente fora, prepare falhou, cadastro corrigido depois).
//
// Segurança fiscal:
// - prepare do backend é idempotente pela correlation da venda; a fila deduplica por venda;
// - venda em voo no backend (INCERTO/PROCESSANDO…) sem job local nunca ganha número novo;
// - consulta esgotada volta para CONSULTA antes de qualquer reemissão;
// - FALHA_PERMANENTE reabre o mesmo job (mesmo nNF): transitória com o INI antigo,
//   rejeição só com INI novo (cadastro corrigido); duplicidade 539/204 fica para o operador.
const crypto = require("crypto");
const log = require("./logger");

const INTERVAL_MS = parseInt(process.env.FISCAL_DRENO_MS || "60000", 10);
const LIMITE_POR_CICLO = parseInt(process.env.FISCAL_DRENO_LIMITE || "3", 10);
const PAGINA = parseInt(process.env.FISCAL_DRENO_PAGINA || "20", 10);
const MAX_EMISSOES_ATIVAS = parseInt(process.env.FISCAL_DRENO_MAX_ATIVAS || "2", 10);
const HTTP_TIMEOUT_MS = parseInt(process.env.FISCAL_DRENO_HTTP_TIMEOUT_MS || "20000", 10);
const BACKOFF_MS = [60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];
const STATUS_JOB_ATIVO = new Set(["PENDENTE", "PROCESSANDO", "INCERTO", "FALHA_TEMPORARIA", "RECUPERANDO"]);
const STATUS_BACKEND_DEVIDA = new Set(["", "PENDENTE", "PENDENTE_FISCAL", "NAO_EMITIDA"]);
const ACOES_SILENCIOSAS = new Set(["em_fila", "aguardando_backoff"]);
// Decisões só locais (sem HTTP nem emissão) não consomem a cota do ciclo.
const ACOES_BARATAS = new Set([...ACOES_SILENCIOSAS, "sem_job_local", "aguardando_operador", "ignorado"]);
const CSTAT_LOTE_OU_AUTORIZADO = new Set(["100", "103", "104", "105", "150"]);
// SEFAZ fora/paralisada, nota não consta (reemitir o mesmo nNF é seguro), consumo indevido.
const CSTAT_TRANSITORIO = new Set(["108", "109", "217", "656", "999"]);

const tentativas = new Map();
let timer = null;
let cicloEmAndamento = false;
let cursorApos = null;

function resetParaTestes() {
  tentativas.clear();
  cicloEmAndamento = false;
  cursorApos = null;
}

/**
 * @returns {"consulta_esgotada"|"duplicidade"|"transitoria"|"definitiva"}
 */
function classificarFalha(erro) {
  const msg = String(erro || "");
  if (/ACBr_OFFLINE_TIMEOUT/.test(msg)) return "consulta_esgotada";
  const cStat = msg.match(/cStat[=:]?\s*(\d{3})/i)?.[1] || null;
  if (cStat === "539" || cStat === "204" || /duplicidade/i.test(msg)) return "duplicidade";
  if (/cancelad/i.test(msg)) return "definitiva";
  if (cStat && CSTAT_TRANSITORIO.has(cStat)) return "transitoria";
  if (cStat && !CSTAT_LOTE_OU_AUTORIZADO.has(cStat)) return "definitiva";
  try {
    if (require("./fiscalRetry").isPermanente({ message: msg })) return "definitiva";
    const motivo = require("./fiscal/fiscalMotivo").classificarDeMensagem(msg);
    return motivo.recuperavel ? "transitoria" : "definitiva";
  } catch (_) {
    return "definitiva";
  }
}

function payloadDoJob(job) {
  try {
    return JSON.parse(job.payload) || null;
  } catch (_) {
    return null;
  }
}

function podeTentar(numeroVenda, agora) {
  const t = tentativas.get(numeroVenda);
  return !t || t.proximaEm <= agora;
}

function registrarTentativa(numeroVenda, agora, extra = {}) {
  const anterior = tentativas.get(numeroVenda);
  const n = (anterior?.n || 0) + 1;
  const espera = BACKOFF_MS[Math.min(n - 1, BACKOFF_MS.length - 1)];
  tentativas.set(numeroVenda, { ...anterior, ...extra, n, proximaEm: agora + espera });
  if (tentativas.size > 500) tentativas.delete(tentativas.keys().next().value);
}

/** INI sem as datas (o agente reescreve dhEmi na emissão) — detecta cadastro corrigido. */
function hashIni(ini) {
  const semDatas = String(ini || "")
    .split(/\r?\n/)
    .filter((l) => !/^(dhEmi|dhSaiEnt|dhCont)=/i.test(l.trim()))
    .join("\n");
  return crypto.createHash("sha256").update(semDatas).digest("hex");
}

async function httpJson(url, { method = "GET", token, body } = {}) {
  const fetch = require("node-fetch");
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const t = controller ? setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS) : null;
  try {
    const resp = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller?.signal,
    });
    const texto = await resp.text();
    let json = null;
    try {
      json = texto ? JSON.parse(texto) : null;
    } catch (_) {}
    if (!resp.ok) {
      const err = new Error(json?.message || json?.erro || texto.slice(0, 300) || `HTTP ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    return json;
  } finally {
    if (t) clearTimeout(t);
  }
}

function montarPayloadAgente(cupom, numeroVenda) {
  return {
    ...cupom,
    numeroVenda,
    correlationId: cupom.correlationId,
    itens: Array.isArray(cupom.itens)
      ? cupom.itens.map((i) => ({ ...i, id: i.id || i.codigo }))
      : cupom.itens,
    origem: "dreno_agente",
  };
}

/**
 * @returns {Promise<{ acao: string, numeroVenda: string, motivo?: string }>}
 */
async function processarItem(item, ctx) {
  const { cfg, deps, agora } = ctx;
  const numeroVenda = String(item.numeroVenda || "");
  if (!numeroVenda) return { acao: "ignorado", numeroVenda, motivo: "sem_numero" };
  if (!podeTentar(numeroVenda, agora)) return { acao: "aguardando_backoff", numeroVenda };

  const fila = deps.filaFiscal;

  const doc = fila.buscarDocumentoPorVenda(numeroVenda);
  if (doc?.chave) {
    registrarTentativa(numeroVenda, agora);
    const ok = await deps.recuperarDocumentoLocal(cfg, numeroVenda, item.correlationId);
    return { acao: ok ? "callback_reenviado" : "ignorado", numeroVenda };
  }

  const job = fila.buscarJobEmissaoPorVenda(numeroVenda);
  if (job && STATUS_JOB_ATIVO.has(job.status)) {
    return { acao: "em_fila", numeroVenda, motivo: job.status };
  }
  if (job && (job.status === "CONCLUIDO" || job.status === "CONCLUIDO_RECUPERADO")) {
    registrarTentativa(numeroVenda, agora);
    await deps.sincronizarVenda(cfg, numeroVenda);
    return { acao: "callback_reenviado", numeroVenda, motivo: job.status };
  }

  const statusBackend = String(item.statusFiscal || "").trim().toUpperCase();
  if (!job) {
    registrarTentativa(numeroVenda, agora);
    if (!STATUS_BACKEND_DEVIDA.has(statusBackend)) {
      // Em voo no backend sem job aqui: pode ter sido emitida por outro caminho — número novo duplicaria.
      return { acao: "sem_job_local", numeroVenda, motivo: statusBackend };
    }
    const preparado = await prepararPayload(cfg, deps, numeroVenda);
    if (preparado.falha) return preparado.falha;
    const r = await deps.enfileirarEmissao(cfg, preparado.payload);
    if (r && r.fiscal === false) return { acao: "emissao_desligada", numeroVenda };
    return { acao: r?.deduplicado ? "em_fila" : "enfileirado", numeroVenda };
  }

  if (job.status !== "FALHA_PERMANENTE") {
    registrarTentativa(numeroVenda, agora);
    return { acao: "ignorado", numeroVenda, motivo: `job_${job.status}` };
  }

  const tipo = classificarFalha(job.erro);
  if (tipo === "duplicidade") {
    registrarTentativa(numeroVenda, agora);
    return { acao: "aguardando_operador", numeroVenda, motivo: job.erro };
  }
  // 1ª vez: só consulta de novo (ACBr pode ter voltado). Esgotou de novo: reemite com o MESMO nNF —
  // se a nota existir, a SEFAZ responde duplicidade (539/204) e o fluxo 539 recupera a chave.
  if (tipo === "consulta_esgotada" && !tentativas.get(numeroVenda)?.consultaReaberta) {
    registrarTentativa(numeroVenda, agora, { consultaReaberta: true });
    fila.reabrirParaConsulta(job.id);
    return { acao: "reaberto_consulta", numeroVenda };
  }

  registrarTentativa(numeroVenda, agora);
  const antigo = payloadDoJob(job);
  if (tipo !== "definitiva" && antigo?.documentIni) {
    fila.reabrirJobEmissao(job.id, antigo);
    fila.dispararProcessamento();
    return { acao: "reemissao_reaberta", numeroVenda, motivo: tipo };
  }

  // Rejeição: reenviar o mesmo INI daria a mesma rejeição — só com documento corrigido.
  const preparado = await prepararPayload(cfg, deps, numeroVenda);
  if (preparado.falha) return preparado.falha;
  if (antigo?.documentIni && hashIni(antigo.documentIni) === hashIni(preparado.payload.documentIni)) {
    return { acao: "aguardando_correcao_cadastro", numeroVenda, motivo: job.erro };
  }
  fila.reabrirJobEmissao(job.id, preparado.payload);
  fila.dispararProcessamento();
  return { acao: "reemissao_reaberta", numeroVenda, motivo: "documento_corrigido" };
}

async function prepararPayload(cfg, deps, numeroVenda) {
  let cupom;
  try {
    cupom = await deps.preparar(cfg, numeroVenda);
  } catch (err) {
    return { falha: { acao: "prepare_falhou", numeroVenda, motivo: err.message, status: err.status } };
  }
  if (!cupom || !cupom.documentIni) {
    return { falha: { acao: "prepare_sem_ini", numeroVenda } };
  }
  return { payload: montarPayloadAgente(cupom, numeroVenda) };
}

function depsPadrao() {
  const filaFiscal = require("./filaFiscal");
  const fiscalService = require("./fiscalService");
  const reconciliacao = require("./reconciliacaoFiscal");
  return {
    filaFiscal,
    fiscalDriver: require("./fiscalDriver"),
    acbr: require("./acbr"),
    recuperarDocumentoLocal: reconciliacao.recuperarDocumentoLocal,
    enfileirarEmissao: (cfg, payload) => fiscalService.enfileirarEmissao(cfg, payload),
    sincronizarVenda: (cfg, numeroVenda) => fiscalService.sincronizarVendaFiscal(cfg, numeroVenda),
    listarPendentes: (cfg, limite, apos) =>
      httpJson(
        `${cfg.backendUrl.replace(/\/$/, "")}/pdv/agente/fiscal/pendentes-emissao?limite=${limite}` +
          (apos ? `&apos=${encodeURIComponent(apos)}` : ""),
        { token: cfg.backendToken },
      ),
    preparar: (cfg, numeroVenda) =>
      httpJson(
        `${cfg.backendUrl.replace(/\/$/, "")}/pdv/vendas/${encodeURIComponent(numeroVenda)}/fiscal/preparar-emissao-nfce`,
        { method: "POST", token: cfg.backendToken, body: {} },
      ),
  };
}

async function executarCiclo(lerConfigFn, depsOverride = null) {
  if (cicloEmAndamento) return { executado: false, motivo: "ciclo_em_andamento" };
  const deps = depsOverride || depsPadrao();
  if (!deps.fiscalDriver.EMISSAO_FISCAL) return { executado: false, motivo: "emissao_desligada" };
  if (deps.acbr?.isAcbrBusy?.() || deps.filaFiscal.acbrOcupado?.()) {
    return { executado: false, motivo: "acbr_ocupado" };
  }
  const ativas = deps.filaFiscal.contarEmissoesAtivas();
  if (ativas >= MAX_EMISSOES_ATIVAS) return { executado: false, motivo: "fila_cheia" };

  cicloEmAndamento = true;
  try {
    const cfg = await lerConfigFn();
    if (!cfg?.backendUrl || !cfg?.backendToken) return { executado: false, motivo: "sem_backend" };

    let resp;
    try {
      resp = await deps.listarPendentes(cfg, PAGINA, cursorApos);
    } catch (err) {
      log.debug({ err: err.message }, "[DrenoFiscal] backend indisponível");
      return { executado: false, motivo: "backend_indisponivel" };
    }
    const itens = Array.isArray(resp?.itens) ? resp.itens : [];
    const resultados = [];
    const agora = typeof deps.agora === "function" ? deps.agora() : Date.now();
    let trabalho = 0;
    let ultimoVisto = null;
    for (const item of itens) {
      if (trabalho >= LIMITE_POR_CICLO) break;
      if (deps.filaFiscal.contarEmissoesAtivas() >= MAX_EMISSOES_ATIVAS) break;
      ultimoVisto = item.emitidoEm || ultimoVisto;
      try {
        const r = await processarItem(item, { cfg, deps, agora });
        resultados.push(r);
        if (!ACOES_BARATAS.has(r.acao)) trabalho += 1;
        if (!ACOES_SILENCIOSAS.has(r.acao)) {
          log.info(
            { numeroVenda: r.numeroVenda, acao: r.acao, motivo: r.motivo, statusBackend: item.statusFiscal },
            "[DrenoFiscal] NFC-e devida processada",
          );
        }
      } catch (err) {
        trabalho += 1;
        registrarTentativa(String(item.numeroVenda || ""), agora);
        resultados.push({ acao: "erro", numeroVenda: item.numeroVenda, motivo: err.message });
        log.warn({ numeroVenda: item.numeroVenda, err: err.message }, "[DrenoFiscal] falha no item");
      }
    }
    // Página inteira percorrida e cheia: próxima começa depois dela; senão volta ao início.
    const percorreuTudo = resultados.length === itens.length;
    cursorApos = percorreuTudo && itens.length >= PAGINA ? ultimoVisto : percorreuTudo ? null : cursorApos;
    return { executado: true, resultados, cursor: cursorApos };
  } finally {
    cicloEmAndamento = false;
  }
}

function iniciar(lerConfigFn) {
  if (timer || INTERVAL_MS <= 0) return;
  timer = setInterval(() => {
    executarCiclo(lerConfigFn).catch((err) =>
      log.warn({ err: err.message }, "[DrenoFiscal] erro no ciclo"),
    );
  }, INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  const primeiro = setTimeout(() => executarCiclo(lerConfigFn).catch(() => {}), 45_000);
  if (typeof primeiro.unref === "function") primeiro.unref();
}

function parar() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { iniciar, parar, executarCiclo, hashIni, classificarFalha, resetParaTestes };

// ============================================================
// PDV Margin Engine — Agente Local v5.0
//
// PATCH DE SEGURANÇA (pós v5.0):
//   ✓ Página "/" reformulada: agora é um status básico, somente
//     leitura e sem dados sensíveis (sem backendUrl, tenantId,
//     dispositivoId, tokens). Serve apenas para confirmar
//     visualmente que o agente está rodando após a instalação.
//     Alimentada por GET /status-basico (também público).
//   ✓ GET /diagnostico, /status, /fila, /contingencia/status,
//     /contingencia/epec/pendentes, /updater/status,
//     /impressora/status e /impressora/listar agora exigem
//     X-Agent-Token (via exigirAgentToken) quando o PDV está
//     ativado — antes vazavam dados do tenant para qualquer
//     requisição. Gestão completa fica em /pdv/diagnostico no
//     painel web, autenticado.
//
// NOVIDADES v5.0:
//   ✓ Auto-updater: verifica nova versão no backend a cada hora
//     GET /pdv/agente/versao → { versao, urlDownload, changelog }
//     Se versão diferente da atual, baixa o novo index.js + módulos
//     e reinicia o serviço automaticamente
//   ✓ Painel de diagnóstico: GET /diagnostico
//     Retorna JSON estruturado com status de todos os subsistemas
//     para o frontend renderizar o painel visual
//   ✓ Endpoint de auto-update manual: POST /updater/verificar
//   ✓ Credenciais seguras: backendToken nunca em texto puro no disco
//     — armazenado via credenciais.js (Windows Credential Manager /
//     AES-256-GCM em arquivo criptografado como fallback)
//
// Funcionalidades mantidas:
//   ✓ Serve frontend React estático
//   ✓ Ativação por código de painel
//   ✓ Fila offline SQLite
//   ✓ Impressora térmica ESC/POS
//   ✓ ACBr Monitor via socket TCP
//   ✓ Contingência EPEC: ativação automática via watchdog SEFAZ + sync pelo agente
// ============================================================

require("dotenv").config();

const { initLogging } = require("./runtime/loggingService");
const { version: VERSAO_BOOT } = require("./package.json");
initLogging({
  versao: VERSAO_BOOT,
  patchConsole: process.env.LOG_PATCH_CONSOLE !== "false",
});

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const os = require("os");
const crypto = require("crypto");
const impressora = require("./impressora");
const fiscalDriver = require("./fiscalDriver");
const fila = require("./fila");
const configSync = require("./configSync");
const credenciais = require("./credenciais");
const marginPaths = require("./marginPaths");
const { getDirectoryManager } = require("./runtime/directoryManager");
const { writeJsonAtomicSync } = require("./runtime/atomicWrite");
const fiscalTraceLog = require("./fiscalTraceLog");
const filaFiscal = require("./filaFiscal");
const acbrNfceSetup = require("./acbrNfceSetup");
const fiscalService = require("./fiscalService");
const reconciliacaoFiscal = require("./reconciliacaoFiscal");
const fiscalPreflight = require("./fiscalPreflight");
const fiscalNumeracao = require("./fiscalNumeracao");
const watchdog = require("./watchdog");
const fiscalMetrics = require("./fiscalMetrics");
const fiscalRateLimit = require("./fiscalRateLimit");
const fiscalPurge = require("./fiscalPurge");
const fiscalStorage = require("./fiscalStorage");
const auditLog = require("./auditLog");
const manifestUpdater = require("./manifestUpdater");
const fiscalAlertas = require("./fiscalAlertas");
const fiscalRelatorio = require("./fiscalRelatorio");
const diagnosticoDashboard = require("./diagnosticoDashboard");
const diagnosticoPainel = require("./diagnosticoPainel");
const fiscalRecuperacao = require("./fiscalRecuperacao");
const diagnosticoRateLimit = require("./diagnosticoRateLimit");
const log = require("./logger").child({ modulo: "agente" });
const { execFile } = require("child_process");

const app = express();
const PORT = Number(process.env.PORT || process.env.AGENT_PORT || 9100);
const AGENT_PUBLIC_BASE = (
  process.env.AGENT_PUBLIC_HOST || `http://127.0.0.1:${PORT}`
).replace(/\/$/, "");

// ── Versão atual do agente (fonte: package.json — alinhada ao instalador 1.0.0) ──
const { version: VERSAO_ATUAL } = require("./package.json");

// ── Config persistida ─────────────────────────────────────────────────────────
// Apenas dados NÃO-SENSÍVEIS ficam no config.json (url, nome, ids, flags).
// O backendToken é lido exclusivamente do cofre (credenciais.js).
function configPath() {
  return getDirectoryManager().file("agent", "config.json");
}

function contingenciaPath() {
  return getDirectoryManager().file("agent", "contingencia.json");
}

function filaDbPath() {
  return process.env.DB_PATH || getDirectoryManager().file("agent", "fila.db");
}

let httpServer = null;
let encerrando = false;
const runtimeTimers = [];

function trackInterval(fn, ms) {
  const t = setInterval(fn, ms);
  if (typeof t.unref === "function") t.unref();
  runtimeTimers.push(t);
  return t;
}

function pararRuntimeTimers() {
  for (const t of runtimeTimers) clearInterval(t);
  runtimeTimers.length = 0;
}

async function encerrarGracefully(signal, code = 0) {
  if (encerrando) return;
  encerrando = true;
  console.log(`[Agente] Encerrando (${signal})...`);
  auditLog.registrar("AGENTE_SHUTDOWN", { signal });
  configSync.parar();
  reconciliacaoFiscal.parar();

  await new Promise((resolve) => {
    if (!httpServer) return resolve();
    httpServer.close(() => {
      console.log("[Agente] HTTP server fechado — novas conexões recusadas");
      resolve();
    });
  });

  const waitJobs = await filaFiscal.aguardarJobsAtivos(30000);
  if (!waitJobs.ok) {
    console.error(
      "[Agente] Timeout 30s aguardando jobs fiscais:",
      JSON.stringify(waitJobs),
    );
    code = 1;
  }

  try {
    filaFiscal.pararWorkers();
    fiscalPurge.parar();
    watchdog.parar();
    pararRuntimeTimers();
    try {
      const { getLoggingService } = require("./runtime/loggingService");
      getLoggingService().flushSync();
    } catch (_) {}
    try {
      const docs = require("./documentosFiscais");
      if (typeof docs.pararBackupRetryScheduler === "function") {
        docs.pararBackupRetryScheduler();
      }
    } catch (_) {}
    try {
      const libDriver = require("./fiscal/drivers/acbrLibDriver");
      if (typeof libDriver.invalidateNativeSession === "function") {
        await libDriver.invalidateNativeSession("shutdown");
      }
    } catch (_) {}
    filaFiscal.close();
    fiscalMetrics.close();
    auditLog.close();
    if (db) db.close();
  } catch (_) {}
  process.exit(code);
}

function backupPreUpdateDir() {
  return getDirectoryManager().file("agent", "backup-pre-update");
}

// Cache em memória — evita chamar o cofre a cada request.
let _configCache = null;
let _configPublicCache = null;
let _configPublicMtime = 0;

function invalidarConfigPublicaCache() {
  _configPublicCache = null;
  _configPublicMtime = 0;
}

function lerConfigPublica() {
  try {
    const p = configPath();
    if (!fs.existsSync(p)) return {};
    const st = fs.statSync(p);
    if (_configPublicCache && st.mtimeMs === _configPublicMtime) {
      return _configPublicCache;
    }
    _configPublicCache = JSON.parse(fs.readFileSync(p, "utf8"));
    _configPublicMtime = st.mtimeMs;
    return _configPublicCache;
  } catch {}
  return {};
}

function salvarConfigPublica(dados) {
  const seguro = { ...dados };
  delete seguro.backendToken;
  writeJsonAtomicSync(configPath(), seguro, {
    ensureDir: (dir) => getDirectoryManager().ensurePath(dir, "agentData"),
  });
  _configPublicCache = { ...seguro };
  try {
    _configPublicMtime = fs.statSync(configPath()).mtimeMs;
  } catch {
    _configPublicMtime = Date.now();
  }
}

function sincronizarContextoLog(cfg) {
  try {
    const { getLoggingService } = require("./runtime/loggingService");
    const c = cfg || lerConfigSync();
    let driver = null;
    try {
      const info = fiscalDriver.getDriverInfo?.();
      driver = info?.provider || info?.mode || null;
    } catch (_) {}
    getLoggingService().setStaticContext({
      tenant: c.tenantId || c.tenant || null,
      empresa: c.empresaNome || c.empresa || c.pdvNome || null,
      caixa: c.dispositivoId || c.pdvId || process.env.PDV_DISPOSITIVO_ID || null,
      driver,
    });
  } catch (_) {}
}

/**
 * Lê a config completa (dados públicos + token do cofre).
 * É async porque o cofre pode ser assíncrono.
 */
async function lerConfig() {
  const pub = lerConfigPublica();
  const creds = await credenciais.ler();

  const backendUrl =
    pub.backendUrl || creds?.backendUrl || process.env.BACKEND_URL || "";
  const backendToken = creds?.backendToken || process.env.BACKEND_TOKEN || "";

  const cfg = {
    backendUrl,
    backendToken,
    tenantId: pub.tenantId || creds?.tenantId || process.env.TENANT_ID || "",
    pdvNome:
      pub.pdvNome || creds?.pdvNome || process.env.PDV_NOME || "PDV Principal",
    dispositivoId: pub.dispositivoId || creds?.dispositivoId || null,
    agentToken: pub.agentToken || null,
    frontendOrigin: pub.frontendOrigin || null,
    ativado:
      pub.ativado === true ||
      !!(backendUrl && backendToken) ||
      !!(process.env.BACKEND_URL && process.env.BACKEND_TOKEN),
  };

  _configCache = cfg;
  return cfg;
}

/**
 * Versão síncrona que usa o cache em memória.
 * Segura para usar dentro de rotas depois do boot (lerConfig já rodou ao menos uma vez).
 */
function lerConfigSync() {
  if (_configCache) return _configCache;
  // Fallback: apenas dados públicos + env (sem token do cofre — não ideal,
  // mas nunca acontece em produção pois lerConfig() é chamado no boot).
  const pub = lerConfigPublica();
  return {
    backendUrl: pub.backendUrl || process.env.BACKEND_URL || "",
    backendToken: process.env.BACKEND_TOKEN || "",
    tenantId: pub.tenantId || process.env.TENANT_ID || "",
    pdvNome: pub.pdvNome || process.env.PDV_NOME || "PDV Principal",
    dispositivoId: pub.dispositivoId || null,
    agentToken: pub.agentToken || null,
    frontendOrigin: pub.frontendOrigin || null,
    ativado: !!(process.env.BACKEND_URL && process.env.BACKEND_TOKEN),
  };
}

/**
 * Salva config: dados não-sensíveis em config.json, token no cofre.
 */
async function salvarConfig(cfg) {
  // 1. Persiste dados públicos (sem token)
  salvarConfigPublica(cfg);

  // 2. Persiste token + dados sensíveis no cofre
  await credenciais.salvar({
    backendUrl: cfg.backendUrl,
    backendToken: cfg.backendToken,
    tenantId: cfg.tenantId,
    pdvNome: cfg.pdvNome,
    dispositivoId: cfg.dispositivoId,
    ativado: cfg.ativado,
  });

  // 3. Atualiza env vars (para módulos que leem process.env diretamente)
  process.env.BACKEND_URL = cfg.backendUrl;
  process.env.BACKEND_TOKEN = cfg.backendToken;

  // 4. Invalida cache para forçar releitura na próxima lerConfig()
  _configCache = null;
  invalidarConfigPublicaCache();
}

// ── Boot: carrega config completa (inclui cofre) ──────────────────────────────
// Usamos uma IIFE async para aguardar o cofre antes de iniciar os módulos.
let config = {};

async function boot() {
  config = await lerConfig();
  sincronizarContextoLog(config);

  if (config.backendUrl) process.env.BACKEND_URL = config.backendUrl;
  if (config.backendToken) process.env.BACKEND_TOKEN = config.backendToken;
  if (config.backendUrl && config.backendToken) {
    fila.atualizarConfig(config.backendUrl, config.backendToken);
  }

  getDirectoryManager().ensureAll();
  marginPaths.ensureDirs();
  fiscalNumeracao.init();
  fiscalMetrics.init();
  auditLog.init();
  try {
    require("./fiscalConfigAuthority").carregarPersistido();
  } catch (_) {}
  try {
    fiscalStorage.recoverCorruptedBootDbs(
      (process.env.FISCAL_INTEGRITY_STRICT || "true").toLowerCase() === "true",
    );
  } catch (err) {
    console.error("[Boot] Falha integrity_check:", err.message);
    throw err;
  }
  const disco = fiscalStorage.verificarEspacoDisco();
  if (disco.degradado) {
    console.warn(`[Boot] Modo degradado — disco: ${disco.livreMb}MB livres`);
  }
  const sqliteRecovery = fiscalStorage.getRecoveryState?.();
  if (sqliteRecovery?.ativo) {
    console.warn(
      `[Boot] Modo degradado — SQLite recuperado automaticamente (${sqliteRecovery.quarantined.length} arquivo(s) quarentenado(s))`,
    );
  }
  setImmediate(() => {
    try {
      const check = manifestUpdater.verificarManifestBoot();
      if (!check.ok) {
        console.error(
          `[Boot] CRÍTICO: ${check.motivo}. Auto-update bloqueado. Execute: npm run manifest`,
        );
      }
    } catch (err) {
      console.error("[Boot] Verificação de manifest falhou:", err.message);
    }
  });
  filaFiscal.init();
  fiscalService.registrarHandlersFila(lerConfig);
  registrarHandlerEpecFila();

  // HTTP na porta 9100 antes de recovery fiscal — evita agente "offline" durante
  // consultas SEFAZ/ACBr (ex.: cStat 104) e impede loop de crash no boot.
  iniciarServidor();

  filaFiscal.iniciarWorker();
  try {
    require("./print/printJobService").iniciarWorker();
  } catch (err) {
    console.warn("[PrintJob] Worker não iniciado:", err.message);
  }
  watchdog.iniciar(reiniciarEmissorFiscal, {
    onDegraded: (err) =>
      ativarContingencia(err?.message || "SEFAZ indisponível — fila fiscal pausada"),
    onRestored: async () => {
      if (!estadoContingencia.ativa) return;
      filaFiscal.retomarFila();
      await tentarSincronizarEpecs();
      await verificarEncerrarContingenciaEpec();
    },
  });
  fiscalPurge.iniciar();
  reconciliacaoFiscal.iniciar(lerConfig);
  try {
    const docs = require("./documentosFiscais");
    if (typeof docs.iniciarBackupRetryScheduler === "function") {
      docs.iniciarBackupRetryScheduler();
    }
  } catch (_) {}
  fiscalAlertas.iniciarRelatorioAutomatico(fiscalRelatorio.gerarRelatorio);

  if (fiscalDriver.EMISSAO_FISCAL) {
    acbrNfceSetup.inicializar().then((r) => {
      if (r.pronto || r.ok) {
        console.log("[Margin Engine] Configuração fiscal validada");
      } else {
        console.warn(
          "[Margin Engine] Pendências fiscais:",
          (r.acoes || []).join(" | ") || r.erro || "verifique certificado e CSC no painel",
        );
      }
    });
  }

  const bootCancel =
    (process.env.FISCAL_BOOT_CANCEL || "false").toLowerCase() === "true";
  if (bootCancel) {
    const cancelados = filaFiscal.cancelarEmissaoPendente(
      "Cancelado no boot — refaça a emissão após atualizar dados fiscais no painel",
    );
    if (cancelados > 0) {
      console.log(
        `[Fila fiscal] ${cancelados} job(s) de emissão pendente(s) cancelado(s) no boot`,
      );
    }
  } else {
    setImmediate(() => {
      filaFiscal
        .recuperarBoot(lerConfig)
        .then((rec) => {
          console.log(
            `[Fila fiscal] Boot recovery: ${rec.recuperados} job(s), ${rec.autorizados} autorizado(s)`,
          );
        })
        .catch((err) => {
          console.error(
            "[Fila fiscal] Boot recovery falhou (agente continua online):",
            err.message,
          );
          log.warn(
            { err: err.message },
            "Boot recovery falhou — reconciliação tentará novamente",
          );
        });
    });
  }
}

async function reiniciarAcbrMonitor() {
  const exe = process.env.ACBR_MONITOR_EXE;
  if (!exe) {
    console.warn("[Margin Engine] Serviço auxiliar fiscal não configurado — reinício automático desativado");
    return;
  }
  const procName = process.env.ACBR_MONITOR_PROC || "ACBrMonitor.exe";
  await new Promise((resolve, reject) => {
    execFile("taskkill", ["/F", "/IM", procName], () => {
      setTimeout(() => {
        execFile(exe, [], (err) => (err ? reject(err) : resolve()));
      }, 3000);
    });
  });
  console.log("[Margin Engine] Serviço auxiliar fiscal reiniciado");
}

async function reiniciarEmissorFiscal() {
  const driver = String(process.env.ACBR_DRIVER || "lib").toLowerCase();
  if (driver === "lib" || driver === "acbr-lib") {
    try {
      const libDriver = require("./fiscal/drivers/acbrLibDriver");
      if (typeof libDriver.invalidateNativeSession === "function") {
        await libDriver.invalidateNativeSession("watchdog_restart");
      }
      await fiscalDriver.testar().catch(() => false);
      console.log("[Margin Engine] Emissor fiscal integrado reinicializado");
    } catch (err) {
      console.warn("[Margin Engine] Falha ao reiniciar emissor integrado:", err.message);
    }
    return;
  }
  await reiniciarAcbrMonitor();
}

const AUTO_UPDATE =
  (process.env.AUTO_UPDATE || "false").toLowerCase() === "true";

// ── Contingência EPEC ─────────────────────────────────────────────────────────
function lerContingencia() {
  try {
    const p = contingenciaPath();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {}
  return {
    ativa: false,
    contingenciaId: null,
    iniciadaEm: null,
    epecPendentes: 0,
  };
}

function salvarContingencia(estado) {
  writeJsonAtomicSync(contingenciaPath(), estado, {
    ensureDir: (dir) => getDirectoryManager().ensurePath(dir, "agentData"),
  });
}

let estadoContingencia = lerContingencia();

// ── SQLite ────────────────────────────────────────────────────────────────────
const Database = require("better-sqlite3");
let db;

function inicializarDb() {
  const dbPath = filaDbPath();
  getDirectoryManager().ensurePath(path.dirname(dbPath), "agentData");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS epec_pendentes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      epec_id      TEXT    NOT NULL UNIQUE,
      numero_venda TEXT    NOT NULL,
      xml_epec     TEXT    NOT NULL,
      status       TEXT    NOT NULL DEFAULT 'PENDENTE',
      tentativas   INTEGER NOT NULL DEFAULT 0,
      ultimo_erro  TEXT,
      criado_em    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_epec_status ON epec_pendentes(status);
  `);
}

// ── Segurança: CORS controlado ────────────────────────────────────────────────
const CORS_ORIGINS_RAW =
  process.env.CORS_ORIGINS ||
  process.env.AGENTE_CORS_ORIGENS ||
  "";
const CORS_ORIGENS_ENV = CORS_ORIGINS_RAW.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const LOCALHOST_RX = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

const corsMiddleware = cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (LOCALHOST_RX.test(origin)) return callback(null, true);
    if (CORS_ORIGENS_ENV.includes(origin)) return callback(null, true);
    // Lê do cache — seguro após boot
    const cfg = lerConfigSync();
    if (cfg.frontendOrigin && origin === cfg.frontendOrigin) {
      return callback(null, true);
    }
    if (CORS_ORIGENS_ENV.length === 0 && !cfg.frontendOrigin) {
      console.warn(
        `[CORS] Origem "${origin}" permitida (agente ainda sem CORS_ORIGINS / frontendOrigin configurado). ` +
          "Ative o terminal pelo painel ou defina CORS_ORIGINS para restringir.",
      );
      return callback(null, true);
    }
    console.warn(`[CORS] Origem bloqueada: ${origin}`);
    return callback(null, false);
  },
  allowedHeaders: [
    "Content-Type",
    "X-Agent-Token",
    "X-Correlation-Id",
    "X-Fiscal-Sync",
  ],
});

// ── Private Network Access (Chrome 94+) ──────────────────────────────────────
// Browsers modernos bloqueiam requisições de origens HTTPS (ex: app no painel
// em https://app.marginengine.com.br) para localhost HTTP sem este header.
// O browser envia um preflight OPTIONS com Access-Control-Request-Private-Network
// e o agente deve responder com Access-Control-Allow-Private-Network: true.
// Sem isso, o fetch falha com ERR_FAILED antes mesmo de chegar ao agente,
// e o frontend interpreta incorretamente como "agente offline".
function privateNetworkHeaders(req, res, next) {
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Agent-Token, X-Correlation-Id, X-Fiscal-Sync",
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
}

function isLocalhost(req) {
  const ip = String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
  return ip === "127.0.0.1" || ip === "::1";
}

function exigirLocalhost(req, res, next) {
  if (isLocalhost(req)) return next();
  return res.status(403).json({
    erro: "Acesso permitido apenas via localhost (127.0.0.1).",
  });
}

function exigirLocalhostOuToken(req, res, next) {
  if (isLocalhost(req)) return next();
  return exigirAgentToken(req, res, next);
}

function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  next();
}

// ── Segurança: token do agente ────────────────────────────────────────────────
function exigirAgentToken(req, res, next) {
  const cfg = lerConfigSync();
  const obrigatorio =
    (process.env.AGENT_TOKEN_REQUIRED || "false").toLowerCase() === "true" ||
    !!cfg.agentToken ||
    !!cfg.ativado;
  if (!obrigatorio) return next();
  const recebido = req.headers["x-agent-token"];
  if (recebido && cfg.agentToken && recebido === cfg.agentToken) return next();
  return res.status(401).json({
    erro: "Token do agente ausente ou inválido. Reative o terminal pelo painel para sincronizar o token.",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ── AUTO-UPDATER ──────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

let updaterState = {
  ultimaVerificacao: null,
  versaoDisponivel: null,
  changelog: null,
  atualizando: false,
  ultimoErro: null,
};

const logUpdater = log.child({ modulo: "updater" });

async function verificarAtualizacao() {
  if (!AUTO_UPDATE) return;
  if (!manifestUpdater.isManifestOk()) {
    updaterState.ultimoErro =
      manifestUpdater.getManifestBootMotivo() ||
      "manifest.json com SHA-256 incompleto";
    logUpdater.error(
      { acao: "verificar_atualizacao", resultado: "recusado", err: updaterState.ultimoErro },
      "Auto-update recusado — manifest incompleto",
    );
    return;
  }
  const cfg = await lerConfig();
  if (!cfg.backendUrl || !cfg.backendToken) return;

  const fetch = require("node-fetch");

  try {
    const resp = await fetch(`${cfg.backendUrl}/pdv/agente/versao`, {
      headers: { Authorization: `Bearer ${cfg.backendToken}` },
      timeout: 8000,
    });

    if (!resp.ok) return;

    const { versao, urlDownload, changelog, sha256 } = await resp.json();
    updaterState.ultimaVerificacao = new Date().toISOString();

    if (!versao || versao === VERSAO_ATUAL) {
      updaterState.versaoDisponivel = null;
      updaterState.changelog = null;
      console.log(`[Updater] ✓ Versão ${VERSAO_ATUAL} — up to date.`);
      return;
    }

    console.log(
      `[Updater] ⬆  Nova versão disponível: ${versao} (atual: ${VERSAO_ATUAL})`,
    );
    updaterState.versaoDisponivel = versao;
    updaterState.changelog = changelog || null;

    if (urlDownload) {
      await aplicarAtualizacao(urlDownload, versao, sha256);
    }
  } catch (err) {
    updaterState.ultimoErro = err.message;
    logUpdater.warn(
      { acao: "verificar_atualizacao", resultado: "falha", err },
      "Falha ao verificar atualização",
    );
  }
}

async function aplicarAtualizacao(urlDownload, novaVersao, shaEsperado) {
  if (updaterState.atualizando) return;
  updaterState.atualizando = true;
  const t0 = Date.now();

  const tmpDir = path.join(os.tmpdir(), `pdv-update-${Date.now()}`);
  const tmpZip = path.join(tmpDir, "update.zip");

  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    console.log(`[Updater] Baixando atualização ${novaVersao}...`);

    await downloadFile(urlDownload, tmpZip);

    if (!shaEsperado) {
      throw new Error(
        "Backend não informou sha256 para esta versão — atualização recusada por segurança.",
      );
    }
    const shaCalculado = await calcularSha256(tmpZip);
    if (shaCalculado.toLowerCase() !== String(shaEsperado).toLowerCase()) {
      throw new Error(
        `Hash SHA-256 do pacote não confere (esperado ${shaEsperado}, obtido ${shaCalculado}) — atualização recusada.`,
      );
    }
    console.log(`[Updater] ✓ SHA-256 do pacote verificado.`);

    const { execSync } = require("child_process");
    try {
      execSync(`unzip -q "${tmpZip}" -d "${tmpDir}"`, { timeout: 30000 });
    } catch {
      execSync(
        `powershell -Command "Expand-Archive -Path '${tmpZip}' -DestinationPath '${tmpDir}' -Force"`,
        { timeout: 30000 },
      );
    }

    const novoIndex = path.join(tmpDir, "index.js");
    const manifestNoPacote = path.join(tmpDir, "manifest.json");
    if (!fs.existsSync(manifestNoPacote) && !fs.existsSync(novoIndex)) {
      throw new Error("Pacote inválido: manifest.json ou index.js ausente");
    }

    const backupDir = backupPreUpdateDir();
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    if (fs.existsSync(manifestNoPacote)) {
      await manifestUpdater.aplicarPacote(tmpDir, shaEsperado, novaVersao);
    } else {
      const jsFiles = ["index.js", "impressora.js", "fiscalDriver.js", "fila.js", "credenciais.js"];
      manifestUpdater.backupArquivos(jsFiles);
      for (const f of jsFiles) {
        const src = path.join(tmpDir, f);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(__dirname, f));
          console.log(`[Updater] ✓ ${f} atualizado (legado)`);
        }
      }
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });

    console.log(
      `[Updater] ✅ Atualização ${novaVersao} aplicada. Reiniciando agente...`,
    );
    updaterState.atualizando = false;

    setTimeout(() => {
      encerrarGracefully("AUTO_UPDATE", 0).catch(() => process.exit(0));
    }, 1500);
  } catch (err) {
    updaterState.atualizando = false;
    updaterState.ultimoErro = err.message;
    logUpdater.error(
      {
        acao: "aplicar_atualizacao",
        resultado: "falha",
        tempo: Date.now() - t0,
        err,
      },
      "Falha ao aplicar atualização",
    );
    try {
      manifestUpdater.rollbackUltimo();
      logUpdater.warn({ acao: "rollback", resultado: "ok" }, "Backup restaurado após falha");
    } catch (rollbackErr) {
      logUpdater.warn(
        { acao: "rollback", resultado: "indisponivel", err: rollbackErr },
        "Rollback indisponível",
      );
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function downloadFile(url, destPath, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(destPath);
    let settled = false;

    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      fn(val);
    };

    const timer = setTimeout(() => {
      try {
        file.destroy();
      } catch (_) {}
      finish(reject, new Error(`Download timeout apos ${timeoutMs}ms`));
    }, timeoutMs);

    const request = (targetUrl, redirects = 0) => {
      if (redirects > 5) {
        clearTimeout(timer);
        return finish(reject, new Error("Muitos redirects no download."));
      }

      protocol
        .get(targetUrl, (res) => {
          if (
            [301, 302, 307, 308].includes(res.statusCode) &&
            res.headers.location
          ) {
            request(res.headers.location, redirects + 1);
            return;
          }
          if (res.statusCode !== 200) {
            clearTimeout(timer);
            return finish(
              reject,
              new Error(`Download falhou: HTTP ${res.statusCode}`),
            );
          }
          res.pipe(file);
          file.on("finish", () => {
            clearTimeout(timer);
            file.close(() => finish(resolve, true));
          });
        })
        .on("error", (err) => {
          clearTimeout(timer);
          finish(reject, err);
        });
    };

    request(url);
  });
}

function calcularSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ── ROTAS ─────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

let _diagImpressoraCache = { ok: null, info: null, at: 0 };

function impressoraParaEnterprise() {
  if (Date.now() - _diagImpressoraCache.at < 120_000) {
    return {
      ok: _diagImpressoraCache.ok,
      info: _diagImpressoraCache.info,
    };
  }
  try {
    const factory = require("./print/factory");
    return {
      ok: null,
      info: { driver: factory.getDriverInfo?.() || null, ultimaUsada: null },
    };
  } catch {
    return { ok: null, info: null };
  }
}

function coletarDadosAlertas() {
  const payload = diagnosticoDashboard.montarAlertasPayload({
    filaFiscal,
    fiscalStorage,
    acbr: fiscalDriver,
    watchdog,
    manifestUpdater,
    versao: VERSAO_ATUAL,
  });
  try {
    fiscalAlertas.verificarIncertos(
      (payload.incertos || 0) + (payload.recuperando || 0),
    );
    fiscalAlertas.verificarDiscoCritico(payload.espacoDisco);
  } catch (_) {}
  payload.statusGeral = diagnosticoDashboard.calcularStatusGeral(payload);
  payload.configSync = configSync.getStatus();

  try {
    const diagnosticoEnterprise = require("./diagnosticoEnterprise");
    const imp = impressoraParaEnterprise();
    const logsEnterprise = diagnosticoEnterprise.lerUltimosLogsEnterprise(15);
    const enterprise = diagnosticoEnterprise.coletarContextoEnterprise({
      fila,
      filaFiscal,
      fiscalStorage,
      acbr: fiscalDriver,
      watchdog,
      manifestUpdater,
      versao: VERSAO_ATUAL,
      configSync,
      updater: {
        ...updaterState,
        rollbackDisponivel: manifestUpdater.rollbackDisponivel(),
      },
      db,
      dbPath: filaDbPath(),
      impressoraOk: imp.ok,
      impressoraInfo: imp.info,
      contingencia: lerContingencia(),
      metricas: fiscalMetrics.snapshot?.(filaFiscal.status()) || null,
      backup: diagnosticoEnterprise.coletarInfoBackup(),
      logs: logsEnterprise,
    });
    payload.enterprise = enterprise;
    payload.statusGeral = enterprise.statusGeral;
    payload.logsEnterprise = logsEnterprise;
  } catch (err) {
    payload.enterpriseErro = err.message;
  }

  return payload;
}

function iniciarServidor() {
  // ── FIX CRÍTICO: ordem dos middlewares de CORS ────────────────────────────
  // O pacote `cors` (preflightContinue=false por padrão) responde sozinho a
  // requisições OPTIONS (preflight) com 204 e ENCERRA a resposta ali mesmo.
  // Quando `app.use(corsMiddleware)` vinha ANTES do `app.options("*", ...)`,
  // o preflight nunca chegava no `privateNetworkHeaders` — saía sem o header
  // "Access-Control-Allow-Private-Network: true".
  //
  // Resultado: o Chrome bloqueia a requisição real com ERR_FAILED (Private
  // Network Access) ANTES mesmo de chegar no agente. O frontend recebe um
  // erro de rede no fetch e marca o agente como "offline" — mesmo com o
  // processo Node rodando perfeitamente na porta 9100.
  //
  // Solução: tratar o preflight OPTIONS com privateNetworkHeaders ANTES do
  // corsMiddleware, garantindo que o header Private-Network sempre vá na
  // resposta 204 do preflight.
  app.options("*", privateNetworkHeaders, (req, res) => res.status(204).end());

  app.use(securityHeaders);
  app.use(corsMiddleware);
  app.use(express.json({ limit: "2mb" }));

  const { getLoggingService } = require("./runtime/loggingService");
  app.use((req, res, next) => {
    const cfg = lerConfigPublica();
    getLoggingService().runWithContext(
      {
        correlationId:
          req.headers["x-correlation-id"] ||
          req.headers["x-request-id"] ||
          req.headers["x-correlationid"] ||
          null,
        tenant: cfg.tenantId || cfg.tenant || null,
        caixa: cfg.dispositivoId || cfg.pdvId || process.env.PDV_DISPOSITIVO_ID || null,
        empresa: cfg.empresaNome || cfg.empresa || cfg.pdvNome || null,
        usuario:
          req.headers["x-usuario"] ||
          req.headers["x-operador"] ||
          (req.body && (req.body.usuario || req.body.operador)) ||
          null,
      },
      () => next(),
    );
  });

  const { criarApiProxy } = require("./apiProxy");
  app.use("/api-proxy", privateNetworkHeaders, exigirLocalhost, criarApiProxy({ lerConfigSync }));

  // ── Diagnóstico HTML (antes do SPA — evita 404 do frontend-dist) ───────────
  app.get("/diagnostico/painel", privateNetworkHeaders, exigirLocalhostOuToken, (req, res) => {
    const payload = coletarDadosAlertas();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(diagnosticoPainel.renderPainelHtml(payload));
  });

  app.get("/diagnostico/painel/fila", privateNetworkHeaders, (req, res) => {
    res.redirect(302, "/diagnostico/painel#fila");
  });

  app.get("/diagnostico", privateNetworkHeaders, (req, res, next) => {
    const accept = String(req.headers.accept || "");
    if (req.query.painel === "1" || (accept.includes("text/html") && !accept.includes("application/json"))) {
      const hash = req.query.aba ? `#${req.query.aba}` : "";
      return res.redirect(302, `/diagnostico/painel${hash}`);
    }
    next();
  });

  // ── Diagnóstico (API JSON) ─────────────────────────────────────────────────
  // Expõe dados sensíveis (backendUrl, tenantId, dispositivoId, hostname,
  // caminho do banco etc.) — exige X-Agent-Token quando o PDV está ativado.
  // Consumido pela tela /pdv/diagnostico do painel web.
  app.get(
    "/diagnostico",
    privateNetworkHeaders,
    exigirAgentToken,
    async (req, res) => {
      config = await lerConfig();

      const [impressoraOk, impressoraInfo, acbrOk] = await Promise.all([
        impressora.testar().catch(() => false),
        impressora.getInfo().catch(() => null),
        fiscalDriver.EMISSAO_FISCAL
          ? fiscalDriver.testar().catch(() => false)
          : Promise.resolve(false),
      ]);
      _diagImpressoraCache = { ok: impressoraOk, info: impressoraInfo, at: Date.now() };

      const { pendentes: filaOffline, falhas: filaFalhas } = await fila.contadores();
      const filaOfflineMetricas =
        typeof fila.metricas === "function" ? fila.metricas() : null;
      const contingencia = lerContingencia();

      let epecPendentes = 0;
      let dbOk = false;
      let dbSize = 0;
      if (db) {
        try {
          const row = db
            .prepare(
              "SELECT COUNT(*) as n FROM epec_pendentes WHERE status='PENDENTE'",
            )
            .get();
          epecPendentes = row ? row.n : 0;
          dbOk = true;
          const stat = fs.statSync(filaDbPath());
          dbSize = stat.size;
        } catch {}
      }

      const uptime = process.uptime();
      const memUsed = process.memoryUsage().heapUsed;
      const cpuArch = os.arch();
      const platform = os.platform();
      const hostname = os.hostname();
      const nodeVersao = process.version;

      res.json({
        versao: VERSAO_ATUAL,
        timestamp: new Date().toISOString(),
        uptime,

        agente: {
          ok: true,
          ativado: config.ativado === true,
          pdvNome: config.pdvNome || "PDV",
          tenantId: config.tenantId || null,
          dispositivoId: config.dispositivoId || null,
          backendUrl: config.backendUrl || null,
          temFrontend: fs.existsSync(FRONTEND_INDEX),
          porta: PORT,
        },

        impressora: (() => {
          const printerBootstrap = require("./print/printerBootstrap");
          const impSt = printerBootstrap.resolverStatusExibicao(impressoraInfo);
          return {
            ok: impressoraOk,
            tipo: impSt.metodo || process.env.PRINTER_TYPE || "auto",
            host: impSt.host,
            porta: impSt.porta,
            nome: impSt.nome,
            metodo: impSt.metodo,
            acbrPorta: impSt.acbrPorta,
            provider:
              typeof impressora.getProviderName === "function"
                ? impressora.getProviderName()
                : null,
            requestedProvider:
              typeof impressora.getRequestedProviderName === "function"
                ? impressora.getRequestedProviderName()
                : null,
            driver:
              typeof impressora.getDriverInfo === "function"
                ? impressora.getDriverInfo()
                : null,
            detectada: impressoraInfo?.impressora || impSt.detectada || null,
            candidatos: impressoraInfo?.candidatos?.length || 0,
            ultimaUsada: impressoraInfo?.ultimaUsada || null,
          };
        })(),

        acbr: {
          ok: acbrOk,
          emissaoFiscal: fiscalDriver.EMISSAO_FISCAL,
          host: process.env.ACBR_HOST || "127.0.0.1",
          porta: process.env.ACBR_PORT || "9200",
          driver:
            typeof fiscalDriver.getDriverInfo === "function"
              ? fiscalDriver.getDriverInfo().provider
              : "monitor",
          mode:
            typeof fiscalDriver.getDriverInfo === "function"
              ? fiscalDriver.getDriverInfo().mode
              : "monitor",
          native:
            typeof fiscalDriver.getDriverInfo === "function"
              ? fiscalDriver.getDriverInfo().native === true
              : false,
        },

        banco: {
          ok: dbOk,
          tamanho: dbSize,
          path: filaDbPath(),
        },

        fila: {
          pendentes: filaOffline,
          falhas: filaFalhas,
          auth: fila.statusAuth ? fila.statusAuth() : undefined,
          metricas: filaOfflineMetricas,
        },

        contingencia: {
          ativa: contingencia.ativa,
          iniciadaEm: contingencia.iniciadaEm || null,
          epecPendentes,
        },

        updater: {
          versaoAtual: VERSAO_ATUAL,
          versaoDisponivel: updaterState.versaoDisponivel,
          ultimaVerificacao: updaterState.ultimaVerificacao,
          atualizando: updaterState.atualizando,
          ultimoErro: updaterState.ultimoErro,
          changelog: updaterState.changelog,
        },

        sistema: {
          platform,
          arch: cpuArch,
          hostname,
          nodeVersao,
          memUsedMb: Math.round(memUsed / 1024 / 1024),
          uptimeHuman: formatUptime(uptime),
        },

        enterprise: (() => {
          try {
            const diagnosticoEnterprise = require("./diagnosticoEnterprise");
            const logsEnterprise = diagnosticoEnterprise.lerUltimosLogsEnterprise(20);
            return diagnosticoEnterprise.coletarContextoEnterprise({
              fila,
              filaFiscal,
              fiscalStorage,
              acbr: fiscalDriver,
              watchdog,
              manifestUpdater,
              versao: VERSAO_ATUAL,
              configSync,
              updater: {
                ...updaterState,
                rollbackDisponivel: manifestUpdater.rollbackDisponivel(),
              },
              db,
              dbPath: filaDbPath(),
              impressoraOk: impressoraOk,
              impressoraInfo,
              contingencia,
              metricas: fiscalMetrics.snapshot?.(filaFiscal.status()) || null,
              backup: diagnosticoEnterprise.coletarInfoBackup(),
              logs: logsEnterprise,
            });
          } catch {
            return null;
          }
        })(),

        logs: (() => {
          try {
            const diagnosticoEnterprise = require("./diagnosticoEnterprise");
            return diagnosticoEnterprise.lerUltimosLogsEnterprise(20);
          } catch {
            return null;
          }
        })(),
      });
    },
  );

  // ── Updater ─────────────────────────────────────────────────────────────────
  app.post(
    "/updater/verificar",
    privateNetworkHeaders,
    exigirAgentToken,
    async (req, res) => {
      auditLog.registrar("UPDATER_VERIFICAR", {}, req);
      if (updaterState.atualizando) {
        return res.json({
          ok: false,
          mensagem: "Atualização já em andamento.",
        });
      }
      verificarAtualizacao().catch(() => {});
      res.json({
        ok: true,
        mensagem: "Verificação iniciada.",
        estado: updaterState,
      });
    },
  );

  app.post(
    "/updater/rollback",
    privateNetworkHeaders,
    exigirAgentToken,
    (req, res) => {
      try {
        auditLog.registrar("UPDATER_ROLLBACK", {}, req);
        const dir = manifestUpdater.rollbackUltimo();
        res.json({ ok: true, backup: dir });
      } catch (err) {
        res.status(500).json({ erro: err.message });
      }
    },
  );

  // Estado detalhado do updater (changelog, erros) — protegido.
  app.get(
    "/updater/status",
    privateNetworkHeaders,
    exigirAgentToken,
    (req, res) => {
      res.json({ versaoAtual: VERSAO_ATUAL, ...updaterState });
    },
  );

  // ── Rotas básicas ────────────────────────────────────────────────────────────
  app.get("/health", privateNetworkHeaders, (req, res) => {
    res.json({ ok: true, versao: VERSAO_ATUAL, uptime: process.uptime() });
  });

  /** Probe fiscal leve — não bloqueia no mutex ACBr durante emissão/PDF. */
  async function probeStatusFiscal() {
    const acbrOcupado = fiscalDriver.isAcbrBusy() || filaFiscal.estaProcessando();
    const wd = watchdog.statusWatchdog();
    if (acbrOcupado) {
      const mem = fiscalDriver.obterStatusMemoria(wd.degraded);
      return {
        acbrOk: mem === "online" || mem === "degradado",
        acbrOcupado: true,
        fiscalProcessando: filaFiscal.estaProcessando(),
        acbrEstadoMemoria: mem,
      };
    }
    const acbrOk = fiscalDriver.EMISSAO_FISCAL
      ? await fiscalDriver.testar().catch(() => false)
      : false;
    return {
      acbrOk,
      acbrOcupado: false,
      fiscalProcessando: filaFiscal.estaProcessando(),
      acbrEstadoMemoria: fiscalDriver.obterStatusMemoria(wd.degraded),
    };
  }

  // Status reduzido e PÚBLICO — alimenta a página "/" (status.html).
  // Mostra apenas informações não sensíveis (sem backendUrl, tenantId,
  // dispositivoId, hostname ou caminhos de arquivo). Pensado para o instalador
  // confirmar visualmente que o agente está rodando, sem expor dados do tenant.
  app.get("/status-basico", privateNetworkHeaders, async (req, res) => {
    config = await lerConfig();

    // Durante emissão/PDF fiscal, não bloqueia em testar() da impressora —
    // resposta rápida evita falso "agente offline" no painel.
    const fiscalOcupado =
      fiscalDriver.isAcbrBusy() || filaFiscal.estaProcessando();
    const [impressoraOk, impressoraInfo, fiscalProbe] = fiscalOcupado
      ? [
          null,
          null,
          await probeStatusFiscal(),
        ]
      : await Promise.all([
          impressora.testar().catch(() => false),
          impressora.getInfo().catch(() => null),
          probeStatusFiscal(),
        ]);

    const { pendentes, falhas } = await fila.contadores();
    const contingencia = lerContingencia();
    const uptime = process.uptime();

    let epecPendentes = 0;
    let dbOk = false;
    if (db) {
      try {
        const row = db
          .prepare(
            "SELECT COUNT(*) as n FROM epec_pendentes WHERE status='PENDENTE'",
          )
          .get();
        epecPendentes = row ? row.n : 0;
        dbOk = true;
      } catch {}
    }

    res.json({
      ok: true,
      versao: VERSAO_ATUAL,
      timestamp: new Date().toISOString(),
      uptime,
      uptimeHuman: formatUptime(uptime),
      ativado: config.ativado === true,
      pdvNome: config.pdvNome || "PDV",

      impressora: (() => {
        const printerBootstrap = require("./print/printerBootstrap");
        const impSt = printerBootstrap.resolverStatusExibicao(impressoraInfo);
        return {
          ok: impressoraOk === null ? null : impressoraOk,
          tipo: impSt.metodo || process.env.PRINTER_TYPE || "auto",
          detectada: impressoraInfo?.impressora || impSt.detectada || null,
          host: impSt.host,
          porta: impSt.porta,
          nome: impSt.nome,
          metodo: impSt.metodo,
          acbrPorta: impSt.acbrPorta,
        };
      })(),

      fiscal: {
        emissaoFiscal: fiscalDriver.EMISSAO_FISCAL,
        ok: fiscalDriver.EMISSAO_FISCAL ? fiscalProbe.acbrOk : null,
        ocupado: fiscalProbe.acbrOcupado,
        processando: fiscalProbe.fiscalProcessando,
        ambienteSefaz: (() => {
          if (!fiscalDriver.EMISSAO_FISCAL) return null;
          try {
            const flc = require("./fiscalLocalConfig");
            return flc.ler().ambienteSefaz || null;
          } catch {
            const amb = String(process.env.ACBR_AMBIENTE || "").toLowerCase();
            if (amb === "producao" || amb === "1") return "producao";
            if (amb === "homologacao" || amb === "2") return "homologacao";
            return null;
          }
        })(),
      },

      banco: { ok: dbOk },

      fila: { pendentes, falhas },

      contingencia: {
        ativa: contingencia.ativa,
        epecPendentes,
      },

      auth: {
        requerToken: !!config.agentToken,
      },

      sistema: {
        platform: os.platform(),
        arch: os.arch(),
        nodeVersao: process.version,
        memUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      },
    });
  });

  // Status completo — usado pelo painel web autenticado (frente de caixa,
  // diagnóstico). Inclui tenantId/dispositivoId, por isso exige token quando
  // o PDV está ativado.
  app.get(
    "/status",
    privateNetworkHeaders,
    exigirAgentToken,
    async (req, res) => {
      config = await lerConfig();
      const [impressoraOk, fiscalProbe] = await Promise.all([
        impressora.testar().catch(() => false),
        probeStatusFiscal(),
      ]);
      const { pendentes, falhas } = await fila.contadores();
      const contingencia = lerContingencia();

      let epecPendentes = 0;
      if (db) {
        const row = db
          .prepare(
            "SELECT COUNT(*) as n FROM epec_pendentes WHERE status='PENDENTE'",
          )
          .get();
        epecPendentes = row ? row.n : 0;
      }

      res.json({
        online: true,
        impressoraConectada: impressoraOk,
        acbrConectado: fiscalDriver.EMISSAO_FISCAL ? fiscalProbe.acbrOk : false,
        acbrOcupado: fiscalProbe.acbrOcupado,
        fiscalProcessando: fiscalProbe.fiscalProcessando,
        emissaoFiscal: fiscalDriver.EMISSAO_FISCAL,
        versao: VERSAO_ATUAL,
        timestamp: new Date().toISOString(),
        ativado: config.ativado === true,
        pdvNome: config.pdvNome || "PDV",
        tenantId: config.tenantId || null,
        dispositivoId: config.dispositivoId || null,
        temFrontend: fs.existsSync(path.join(__dirname, "frontend-dist", "index.html")),
        filaOffline: { pendentes, falhas },
        contingencia: { ativa: contingencia.ativa, epecPendentes },
      });
    },
  );

  app.get("/config", privateNetworkHeaders, exigirAgentToken, async (req, res) => {
    config = await lerConfig();
    res.json({
      ativado: config.ativado === true,
      pdvNome: config.pdvNome || "",
      emissaoFiscal: fiscalDriver.EMISSAO_FISCAL,
    });
  });

  /** Pré-preenchimento da tela de ativação — somente localhost */
  app.get("/config/ativacao", privateNetworkHeaders, exigirLocalhost, async (req, res) => {
    config = await lerConfig();
    res.json({
      ativado: config.ativado === true,
      pdvNome: config.pdvNome || "",
      backendUrl: config.backendUrl || "",
    });
  });

  /** Config fiscal local (ACBrLib) — leitura protegida; segredos não expostos */
  app.get("/config/fiscal", privateNetworkHeaders, exigirAgentToken, (req, res) => {
    try {
      const fiscalLocalConfig = require("./fiscalLocalConfig");
      res.json(fiscalLocalConfig.ler());
    } catch (e) {
      res.status(500).json({ erro: e.message || "Erro ao ler config fiscal" });
    }
  });

  /** Grava config fiscal local (certificado, ambiente, CSC) — persiste acbrlib.ini + .env */
  app.put("/config/fiscal", privateNetworkHeaders, exigirAgentToken, async (req, res) => {
    try {
      const fiscalLocalConfig = require("./fiscalLocalConfig");
      const saved = await fiscalLocalConfig.salvar(req.body || {});
      fiscalPreflight.invalidarCache();

      let syncBackend = null;
      if (typeof req.body?.emissaoFiscal === "boolean") {
        const fiscalConfigAuthority = require("./fiscalConfigAuthority");
        syncBackend = await fiscalConfigAuthority
          .propagarEmissaoAoBackend(lerConfig, req.body.emissaoFiscal)
          .catch((err) => ({ ok: false, reason: err.message }));
      }

      res.json({ ok: true, config: saved, syncBackend });
    } catch (e) {
      res.status(400).json({ erro: e.message || "Erro ao salvar config fiscal" });
    }
  });

  /** Config impressora local (ACBr PosPrinter + env) — leitura */
  app.get("/config/impressora", privateNetworkHeaders, (req, res) => {
    try {
      const printerLocalConfig = require("./print/printerLocalConfig");
      res.json(printerLocalConfig.ler());
    } catch (e) {
      res.status(500).json({ erro: e.message || "Erro ao ler config impressora" });
    }
  });

  /** Grava config impressora local — persiste posprinter.ini + .env */
  app.put("/config/impressora", privateNetworkHeaders, exigirAgentToken, (req, res) => {
    try {
      const printerLocalConfig = require("./print/printerLocalConfig");
      const saved = printerLocalConfig.salvar(req.body || {});
      impressora.resetPrintProvider?.();
      res.json({ ok: true, config: saved });
    } catch (e) {
      res.status(400).json({ erro: e.message || "Erro ao salvar config impressora" });
    }
  });

  // Sincroniza X-Agent-Token no browser (localhost ou código efêmero pós-ativação).
  app.get("/auth/local-token", privateNetworkHeaders, exigirLocalhost, async (req, res) => {
    const authSync = require("./authSync");
    const syncCode = req.query.syncCode || req.headers["x-sync-code"];
    if (syncCode) {
      const token = authSync.consumeSyncCode(String(syncCode));
      if (token) return res.json({ agentToken: token });
      return res.status(401).json({ erro: "Código de sincronização inválido ou expirado." });
    }
    const cfg = await lerConfig();
    if (!cfg.ativado || !cfg.agentToken) {
      return res.status(404).json({ erro: "Agente não ativado ou sem token." });
    }
    res.json({ agentToken: cfg.agentToken });
  });

  app.post("/auth/exchange-sync", privateNetworkHeaders, (req, res) => {
    const authSync = require("./authSync");
    const code = req.body?.syncCode || req.headers["x-sync-code"];
    const token = authSync.consumeSyncCode(code ? String(code) : "");
    if (!token) {
      return res.status(401).json({ erro: "Código de sincronização inválido ou expirado." });
    }
    res.json({ agentToken: token });
  });

  // ── Ativação ─────────────────────────────────────────────────────────────────
  app.post("/ativar", privateNetworkHeaders, async (req, res) => {
    const { codigo, codigoAtivacao, backendUrl, pdvNome } = req.body || {};
    const codigoFinal = codigoAtivacao || codigo;
    if (!codigoFinal || !backendUrl)
      return res
        .status(400)
        .json({ erro: "codigoAtivacao e backendUrl são obrigatórios." });

    const fetch = require("node-fetch");
    try {
      const resp = await fetch(`${backendUrl}/pdv/ativar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          codigoAtivacao: codigoFinal,
          ...(pdvNome ? { pdvNome } : {}),
          emissaoFiscal: fiscalDriver.EMISSAO_FISCAL,
        }),
      });
      if (!resp.ok) {
        const texto = await resp.text();
        return res.status(400).json({ erro: texto || "Falha na ativação." });
      }
      const dados = await resp.json();

      const agentToken = crypto.randomBytes(24).toString("hex");
      const frontendOrigin =
        req.headers.origin || config.frontendOrigin || null;

      const novoConfig = {
        backendUrl,
        backendToken: dados.token,
        tenantId: dados.tenantId,
        pdvNome: dados.pdvNome || "PDV",
        dispositivoId: dados.pdvId || dados.dispositivoId || null,
        agentToken,
        frontendOrigin,
        ativado: true,
      };

      // salvarConfig persiste token no cofre e demais dados em config.json
      await salvarConfig(novoConfig);
      config = novoConfig;
      _configCache = novoConfig;
      sincronizarContextoLog(novoConfig);

      fila.atualizarConfig(backendUrl, dados.token);
      void configSync.sincronizar(lerConfig).catch(() => {});
      const authSync = require("./authSync");
      const syncCode = authSync.issueSyncCode(agentToken);
      console.log(
        `[Agente PDV] Ativado — tenant=${dados.tenantId} pdv=${dados.pdvNome}`,
      );
      res.json({
        ok: true,
        pdvNome: dados.pdvNome,
        tenantId: dados.tenantId,
        agentToken,
        syncCode,
      });
    } catch (err) {
      res.status(500).json({ erro: err.message });
    }
  });

  // ── ACBr / Fiscal ────────────────────────────────────────────────────────────
  app.post("/acbr/nfce/emitir", privateNetworkHeaders, exigirAgentToken, async (req, res) => {
    auditLog.registrar(
      "ACBR_NFCE_EMITIR_TENTATIVA",
      {
        numeroVenda: req.body?.numeroVenda || null,
        correlationId:
          req.headers["x-correlation-id"] || req.body?.correlationId || null,
      },
      req,
    );
    if (!fiscalDriver.EMISSAO_FISCAL) return res.json({ fiscal: false });
    const numeroVenda = req.body?.numeroVenda;
    if (!numeroVenda) {
      auditLog.registrar(
        "ACBR_NFCE_EMITIR_DESCONTINUADA",
        { motivo: "sem numeroVenda" },
        req,
      );
      return res.status(410).json({
        erro: "rota descontinuada",
        usar: "/fiscal/emitir",
      });
    }
    try {
      const cfg = await lerConfig();
      const sync =
        req.query.sync === "1" ||
        req.headers["x-fiscal-sync"] === "1" ||
        (process.env.FISCAL_EMITIR_SYNC || "false").toLowerCase() === "true";
      const resultado = await fiscalService.enfileirarEmissao(
        cfg,
        {
          ...req.body,
          correlationId:
            req.headers["x-correlation-id"] || req.body.correlationId,
        },
        { sync },
      );
      if (!resultado || resultado.fiscal === false)
        return res.json({ fiscal: false });
      if (estadoContingencia.ativa && resultado.chave)
        await encerrarContingenciaAutomatico(
          "SEFAZ voltou — emissão normal restaurada.",
        );
      return res.json(resultado);
    } catch (err) {
      return res.status(500).json({ erro: err.message || "Erro ao enfileirar NFC-e" });
    }
  });

  app.post("/fiscal/emitir", privateNetworkHeaders, exigirAgentToken, async (req, res) => {
    const forcarEmissao = req.body?.forcarEmissao === true;
    if (!fiscalDriver.EMISSAO_FISCAL && !forcarEmissao) return res.json({ fiscal: false });
    try {
      const cfg = await lerConfig();
      const correlationId =
        req.headers["x-correlation-id"] || req.body.correlationId;
      const sync =
        req.query.sync === "1" ||
        req.query.sync === "true" ||
        req.headers["x-fiscal-sync"] === "1";
      const resultado = await fiscalService.enfileirarEmissao(
        cfg,
        {
          ...req.body,
          correlationId,
        },
        { sync },
      );
      res.json(resultado);
    } catch (err) {
      const body = { erro: err.message };
      const cStat =
        err.cStat || String(err.message || "").match(/cStat\s*(\d{3})/i)?.[1];
      if (cStat) body.cStat = cStat;
      if (cStat === "999" || err.sefazIntermitente) {
        body.sefazIntermitente = true;
        body.dica =
          "Erro genérico da SEFAZ (cStat 999). Aguarde 1–2 minutos e tente novamente; homologação MG costuma ser instável.";
      }
      if (process.env.FISCAL_DEBUG === "1" && err.acbrRaw) {
        body.acbrRaw = err.acbrRaw;
      }
      res.status(500).json(body);
    }
  });

  app.post("/fiscal/emitir-nfe", privateNetworkHeaders, exigirAgentToken, async (req, res) => {
    if (!fiscalDriver.isNfeModelo55Habilitado()) {
      return res.status(503).json({
        erro: "NF-e modelo 55 desabilitada (ACBR_NFE_ENABLED ou EMISSAO_FISCAL)",
      });
    }
    try {
      const cfg = await lerConfig();
      const correlationId =
        req.headers["x-correlation-id"] || req.body.correlationId;
      const sync =
        req.query.sync === "1" ||
        req.query.sync === "true" ||
        req.headers["x-fiscal-sync"] === "1" ||
        (process.env.FISCAL_EMITIR_SYNC || "false").toLowerCase() === "true";
      const resultado = await fiscalService.enfileirarEmissaoNfe(
        cfg,
        {
          ...req.body,
          correlationId,
        },
        { sync },
      );
      res.json(resultado);
    } catch (err) {
      const status = err.permanente ? 400 : 500;
      const body = { erro: err.message, camposFaltando: err.camposFaltando || undefined, permanente: !!err.permanente };
      const cStat =
        err.cStat || String(err.message || "").match(/cStat\s*(\d{3})/i)?.[1];
      if (cStat) body.cStat = cStat;
      if (cStat === "999" || err.sefazIntermitente) {
        body.sefazIntermitente = true;
        body.dica =
          "Erro genérico da SEFAZ (cStat 999). Aguarde 1–2 minutos e tente novamente.";
      }
      if (process.env.FISCAL_DEBUG === "1" && err.acbrRaw) {
        body.acbrRaw = err.acbrRaw;
      }
      res.status(status).json(body);
    }
  });

  app.post("/fiscal/lib/emitir", privateNetworkHeaders, exigirAgentToken, async (req, res) => {
    req.body = { ...(req.body || {}), acbrDriver: "lib" };
    const forcarEmissao = req.body?.forcarEmissao === true;
    if (!fiscalDriver.EMISSAO_FISCAL && !forcarEmissao) return res.json({ fiscal: false });
    try {
      const cfg = await lerConfig();
      const correlationId = req.headers["x-correlation-id"] || req.body.correlationId;
      const sync =
        req.query.sync === "1" ||
        req.query.sync === "true" ||
        req.headers["x-fiscal-sync"] === "1";
      const resultado = await fiscalService.enfileirarEmissao(
        cfg,
        { ...req.body, correlationId },
        { sync },
      );
      res.json(resultado);
    } catch (err) {
      const body = { erro: err.message };
      const cStat = err.cStat || String(err.message || "").match(/cStat\s*(\d{3})/i)?.[1];
      if (cStat) body.cStat = cStat;
      res.status(500).json(body);
    }
  });

  app.post("/fiscal/lib/emitir-nfe", privateNetworkHeaders, exigirAgentToken, async (req, res) => {
    if (!fiscalDriver.isNfeModelo55Habilitado()) {
      return res.status(503).json({ erro: "NF-e modelo 55 desabilitada" });
    }
    try {
      const cfg = await lerConfig();
      const correlationId = req.headers["x-correlation-id"] || req.body.correlationId;
      const sync =
        req.query.sync === "1" ||
        req.query.sync === "true" ||
        req.headers["x-fiscal-sync"] === "1";
      const resultado = await fiscalService.enfileirarEmissaoNfe(
        cfg,
        { ...req.body, correlationId, acbrDriver: "lib" },
        { sync },
      );
      res.json(resultado);
    } catch (err) {
      res.status(err.permanente ? 400 : 500).json({ erro: err.message });
    }
  });

  app.post("/fiscal/lib/cancelar", privateNetworkHeaders, exigirAgentToken, async (req, res) => {
    try {
      const cfg = await lerConfig();
      const resultado = await fiscalService.cancelarCompleto(cfg, { ...req.body, acbrDriver: "lib" });
      res.json(resultado);
    } catch (err) {
      res.status(500).json({ erro: err.message });
    }
  });

  app.post("/fiscal/lib/inutilizar", privateNetworkHeaders, exigirAgentToken, async (req, res) => {
    try {
      const cfg = await lerConfig();
      const resultado = await fiscalService.inutilizarCompleto(cfg, { ...req.body, acbrDriver: "lib" });
      res.json(resultado);
    } catch (err) {
      res.status(500).json({ erro: err.message });
    }
  });

  app.get("/fiscal/lib/consultar/:chave", privateNetworkHeaders, exigirAgentToken, async (req, res) => {
    try {
      const factory = require("./fiscal/factory");
      const lib = factory.createDriver("lib");
      res.json(await lib.consultarChave(req.params.chave));
    } catch (err) {
      res.status(500).json({ erro: err.message });
    }
  });

  app.get(
    "/fiscal/documento/pdf",
    privateNetworkHeaders,
    exigirAgentToken,
    async (req, res) => {
      const { chave, numeroVenda } = req.query || {};
      try {
        const doc = await fiscalService.obterPdfDocumento(
          chave ? String(chave) : null,
          numeroVenda ? String(numeroVenda) : null,
        );
        const suffix = doc.modeloDocumento === "55" ? "danfe" : "danfce";
        const nome = `${doc.chave || numeroVenda || "documento"}-${suffix}.pdf`;
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
        res.setHeader("Content-Disposition", `attachment; filename="${nome}"`);
        res.send(doc.buffer);
      } catch (err) {
        res.status(404).json({ erro: err.message });
      }
    },
  );

  app.get(
    "/fiscal/documento/xml",
    privateNetworkHeaders,
    exigirAgentToken,
    async (req, res) => {
      const { chave, numeroVenda } = req.query || {};
      try {
        const doc = await fiscalService.obterXmlDocumento(
          chave ? String(chave) : null,
          numeroVenda ? String(numeroVenda) : null,
        );
        res.json({
          xmlContent: doc.xmlContent,
          chave: doc.chave,
          qrcode: doc.qrcode || null,
          modeloDocumento: doc.modeloDocumento,
        });
      } catch (err) {
        res.status(404).json({ erro: err.message });
      }
    },
  );

  app.get(
    "/fiscal/emissao/venda/:numeroVenda",
    privateNetworkHeaders,
    exigirAgentToken,
    (req, res) => {
      res.json(
        fiscalService.consultarStatusEmissaoPorVenda(
          decodeURIComponent(req.params.numeroVenda),
        ),
      );
    },
  );

  app.post(
    "/fiscal/sincronizar-venda",
    privateNetworkHeaders,
    exigirAgentToken,
    async (req, res) => {
      try {
        const numeroVenda = req.body?.numeroVenda;
        if (!numeroVenda) {
          return res.status(400).json({ erro: "numeroVenda obrigatório." });
        }
        const cfg = await lerConfig();
        res.json(await fiscalService.sincronizarVendaFiscal(cfg, String(numeroVenda)));
      } catch (err) {
        res.status(500).json({ erro: err.message });
      }
    },
  );

  app.get(
    "/fiscal/emissao/:correlationId",
    privateNetworkHeaders,
    exigirAgentToken,
    (req, res) => {
      res.json(fiscalService.consultarStatusEmissao(req.params.correlationId));
    },
  );

  app.get(
    "/fiscal/status/:correlationId",
    privateNetworkHeaders,
    exigirAgentToken,
    (req, res) => {
      res.json(fiscalService.consultarStatusEmissao(req.params.correlationId));
    },
  );

  app.get("/acbr/fiscal/preflight", privateNetworkHeaders, exigirAgentToken, async (req, res) => {
    try {
      const completo =
        req.query.completo === "1" || req.query.completo === "true";
      res.json(await fiscalPreflight.validarEmissao({ completo }));
    } catch (err) {
      res.status(400).json({ ok: false, erro: err.message });
    }
  });

  app.post("/fiscal/cancelar", privateNetworkHeaders, exigirAgentToken, async (req, res) => {
    try {
      const cfg = await lerConfig();
      const resultado = await fiscalService.cancelarCompleto(cfg, req.body);
      res.json(resultado);
    } catch (err) {
      res.status(500).json({ erro: err.message });
    }
  });

  app.post("/fiscal/evento", privateNetworkHeaders, exigirAgentToken, async (req, res) => {
    try {
      const cfg = await lerConfig();
      const resultado = await fiscalService.enviarEventoCompleto(cfg, req.body);
      res.json(resultado);
    } catch (err) {
      const status = err.permanente ? 400 : 500;
      res.status(status).json({ erro: err.message, cStat: err.cStat });
    }
  });

  app.post("/acbr/nfce/cancelar", privateNetworkHeaders, exigirAgentToken, async (req, res) => {
    const chave = req.body?.chave || req.body?.chaveNfe;
    if (!chave) return res.status(400).json({ erro: "chave é obrigatória." });
    try {
      const cfg = await lerConfig();
      if (req.body?.numeroVenda) {
        const resultado = await fiscalService.cancelarCompleto(cfg, {
          chave,
          motivo: req.body.motivo,
          numeroVenda: req.body.numeroVenda,
          correlationId: req.headers["x-correlation-id"],
        });
        return res.json(resultado);
      }
      res.json(await fiscalDriver.cancelarNfce(chave, req.body?.motivo));
    } catch (err) {
      res.status(500).json({ erro: err.message });
    }
  });

  app.get("/acbr/sefaz/status", privateNetworkHeaders, exigirAgentToken, async (req, res) => {
    try {
      res.json(await fiscalDriver.statusServico());
    } catch (err) {
      res.status(500).json({ erro: err.message });
    }
  });

  app.get("/acbr/nfce/consultar/:chave", privateNetworkHeaders, exigirAgentToken, async (req, res) => {
    try {
      res.json(await fiscalDriver.consultarChave(req.params.chave));
    } catch (err) {
      res.status(500).json({ erro: err.message });
    }
  });

  app.post("/acbr/nfce/inutilizar", privateNetworkHeaders, exigirAgentToken, async (req, res) => {
    try {
      const cfg = await lerConfig();
      const body = req.body || {};
      const ano = body.ano || new Date().getFullYear();
      const empresa = body.empresa || {};
      const resultado = await fiscalService.inutilizarCompleto(cfg, {
        ...body,
        ano,
        cnpj: body.cnpj || empresa.cnpj,
      });
      res.json(resultado);
    } catch (err) {
      res.status(500).json({ erro: err.message });
    }
  });

  app.post("/acbr/nfce/reimprimir", privateNetworkHeaders, exigirAgentToken, async (req, res) => {
    const { chave, numeroVenda } = req.body || {};
    try {
      const resultado = await fiscalService.reimprimirDanfceCompleto(
        chave,
        numeroVenda,
      );
      res.json(resultado);
    } catch (err) {
      res.status(500).json({ erro: err.message });
    }
  });

  app.get("/fila/fiscal", privateNetworkHeaders, exigirAgentToken, (req, res) => {
    const accept = String(req.headers.accept || "");
    if (accept.includes("text/html") && !accept.includes("application/json")) {
      return res.redirect(302, "/diagnostico/painel#fila");
    }
    const limit = Math.min(parseInt(req.query.limit || "50", 10) || 50, 200);
    const status = req.query.status ? String(req.query.status) : null;
    res.json({
      ...filaFiscal.status(),
      itens: filaFiscal.listar(limit, status),
      ultimasEmissoes: filaFiscal.listarUltimasEmissoes(15),
    });
  });

  app.post("/fila/fiscal/reprocessar", privateNetworkHeaders, exigirAgentToken, async (req, res) => {
    filaFiscal.retomarFila();
    let recovery = null;
    if (req.body?.recoveryIncertos) {
      recovery = await fiscalRecuperacao.forcarRecoveryManual(lerConfig).catch((err) => ({
        erro: err.message,
      }));
    }
    res.json({ ok: true, ...filaFiscal.status(), recovery });
  });

  app.post("/fila/fiscal/pausar", privateNetworkHeaders, exigirAgentToken, (req, res) => {
    auditLog.registrar("FILA_FISCAL_PAUSAR", {}, req);
    filaFiscal.pausarFila();
    res.json({ ok: true, pausada: true, ...filaFiscal.status() });
  });

  app.post("/fila/fiscal/limpar", privateNetworkHeaders, exigirAgentToken, (req, res) => {
    auditLog.registrar("FILA_FISCAL_LIMPAR", { motivo: req.body?.motivo }, req);
    const n = filaFiscal.cancelarEmissaoPendente(
      req.body?.motivo || "Cancelado manualmente pelo operador",
    );
    res.json({ ok: true, cancelados: n, ...filaFiscal.status() });
  });

  app.post(
    "/fila/fiscal/purge",
    privateNetworkHeaders,
    exigirAgentToken,
    diagnosticoRateLimit.middleware(),
    (req, res) => {
      auditLog.registrar("FILA_FISCAL_PURGE", {}, req);
      const r = fiscalPurge.executarPurge();
      res.json({ ok: true, ...r, fila: filaFiscal.status() });
    },
  );

  app.post(
    "/diagnostico/preflight/refresh",
    privateNetworkHeaders,
    exigirAgentToken,
    (req, res) => {
      fiscalPreflight.invalidarCache();
      res.json({ ok: true, timestamp: new Date().toISOString() });
    },
  );

  app.get("/diagnostico/fiscal", privateNetworkHeaders, exigirAgentToken, async (req, res) => {
    let preflight = null;
    try {
      preflight = await fiscalPreflight.validarEmissao({ completo: true });
    } catch (err) {
      preflight = { ok: false, erro: err.message };
    }
    res.json({
      filaFiscal: filaFiscal.status(),
      watchdog: watchdog.statusWatchdog(),
      paths: marginPaths.PATHS,
      emissaoFiscal: fiscalDriver.EMISSAO_FISCAL,
      numeracao: {
        serie: fiscalNumeracao.SERIE_PADRAO,
        ultimoNumero: fiscalNumeracao.consultarUltimo(),
      },
      nfceSetup: acbrNfceSetup.status(),
      preflight,
    });
  });

  app.get(
    "/diagnostico/metricas",
    privateNetworkHeaders,
    exigirAgentToken,
    (req, res) => {
      res.json({
        metricas: fiscalMetrics.snapshot(filaFiscal.status()),
        rateLimit: fiscalRateLimit.status(req.query.cnpj),
        watchdog: watchdog.statusWatchdog(),
        storage: fiscalStorage.verificarEspacoDisco(),
        degradado: fiscalStorage.isModoDegradado(),
      });
    },
  );

  app.get("/diagnostico/logs/fiscal", privateNetworkHeaders, exigirAgentToken, (req, res) => {
    const lines = Math.min(
      500,
      Math.max(1, parseInt(req.query.lines || "500", 10) || 500),
    );
    const apenas = String(req.query.fonte || "todos").toLowerCase();
    if (apenas === "trace") {
      res.json({
        limit: lines,
        maxLines: fiscalTraceLog.MAX_LINES,
        lines: fiscalTraceLog.tail(lines),
        sources: { trace: fiscalTraceLog.tail(lines).length },
      });
      return;
    }
    if (apenas === "acbr") {
      const acbr = fiscalTraceLog.tailAcbrLib(lines);
      res.json({
        limit: lines,
        maxLines: fiscalTraceLog.MAX_LINES,
        lines: acbr.lines,
        sources: { acbrFiles: acbr.files },
      });
      return;
    }
    res.json(fiscalTraceLog.snapshot(lines));
  });

  app.get("/diagnostico/alertas", privateNetworkHeaders, exigirLocalhostOuToken, (req, res) => {
    const payload = coletarDadosAlertas();
    const alertas = filaFiscal.contadoresAlertas();
    res.json({
      filaFiscal: payload.filaFiscal,
      processando: payload.processando,
      incertos: payload.incertos,
      recuperando: payload.recuperando,
      incertosComBackoff: payload.incertosComBackoff,
      falhasUltimas24h: payload.falhasUltimas24h,
      acbr: payload.acbr,
      espacoDisco: payload.espacoDisco,
      ultimaEmissao: alertas.ultimaEmissao,
      ultimaEmissaoSucesso: alertas.ultimaEmissaoSucesso,
      ultimasEmissoes: filaFiscal.listarUltimasEmissoes(10),
      metricas: {
        emissoesHoje: fiscalMetrics.emissoesHoje(),
        taxaSucessoPercent: fiscalMetrics.taxaSucessoPercent(),
      },
      versao: VERSAO_ATUAL,
      manifestOk: manifestUpdater.isManifestOk(),
      statusGeral: payload.statusGeral,
      timestamp: payload.timestamp,
      configSync: payload.configSync,
    });
  });

  app.get("/diagnostico/dashboard", privateNetworkHeaders, (req, res) => {
    res.redirect(302, "/diagnostico/painel");
  });

  app.get("/diagnostico/dashboard/legado", privateNetworkHeaders, exigirLocalhostOuToken, (req, res) => {
    const payload = coletarDadosAlertas();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(diagnosticoDashboard.renderDashboardHtml(payload));
  });

  app.post(
    "/diagnostico/recovery",
    privateNetworkHeaders,
    exigirAgentToken,
    diagnosticoRateLimit.middleware(),
    async (req, res) => {
      try {
        auditLog.registrar("RECOVERY_MANUAL", {}, req);
        const r = await fiscalRecuperacao.forcarRecoveryManual(lerConfig);
        res.json({
          ok: true,
          jobsReprocessados: r.jobsReprocessados,
          resetados: r.resetados,
          timestamp: r.timestamp,
        });
      } catch (err) {
        res.status(500).json({ erro: err.message });
      }
    },
  );

  app.get(
    "/diagnostico/relatorio",
    privateNetworkHeaders,
    exigirAgentToken,
    diagnosticoRateLimit.middleware(),
    (req, res) => {
      const data = req.query.data || new Date().toISOString().slice(0, 10);
      res.json(fiscalRelatorio.gerarRelatorio(String(data)));
    },
  );

  app.get(
    "/diagnostico/pacote",
    privateNetworkHeaders,
    exigirAgentToken,
    diagnosticoRateLimit.middleware(),
    async (req, res) => {
      try {
        config = await lerConfig();
        const driverInfo =
          typeof fiscalDriver.getDriverInfo === "function"
            ? fiscalDriver.getDriverInfo()
            : { provider: "monitor" };
        const alertasPayload = coletarDadosAlertas();
        const diagnosticoEnterprise = require("./diagnosticoEnterprise");
        const logsSuporte = diagnosticoEnterprise.lerUltimosLogsEnterprise(30);
        const pacote = {
          tipo: "margin-diagnostico-pacote",
          versao: VERSAO_ATUAL,
          geradoEm: new Date().toISOString(),
          agente: {
            versao: VERSAO_ATUAL,
            uptime: process.uptime(),
            platform: os.platform(),
            arch: os.arch(),
            hostname: os.hostname(),
            node: process.version,
            memoriaMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          },
          fiscal: {
            driver: driverInfo,
            fila: filaFiscal.status(),
            alertas: alertasPayload,
            metricas: {
              emissoesHoje: fiscalMetrics.emissoesHoje(),
              taxaSucessoPercent: fiscalMetrics.taxaSucessoPercent(),
            },
            ultimasEmissoes: filaFiscal.listarUltimasEmissoes(10),
          },
          filaComercial: await fila.contadores(),
          config: {
            ativado: config.ativado === true,
            pdvNome: config.pdvNome || null,
            tenantId: config.tenantId || null,
            dispositivoId: config.dispositivoId || null,
            backendUrl: config.backendUrl || null,
            emissaoFiscal: fiscalDriver.EMISSAO_FISCAL,
          },
          watchdog: watchdog.statusWatchdog(),
          storage: fiscalStorage.verificarEspacoDisco(),
          updater: { ...updaterState, versaoAtual: VERSAO_ATUAL },
          manifestOk: manifestUpdater.isManifestOk(),
          logs: logsSuporte,
        };
        const nome = `margin-diagnostico-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
        res.setHeader("Content-Disposition", `attachment; filename="${nome}"`);
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.json(pacote);
      } catch (err) {
        res.status(500).json({ erro: err.message });
      }
    },
  );

  app.get("/diagnostico/saude", privateNetworkHeaders, (req, res) => {
    res.json({
      ok: true,
      versao: VERSAO_ATUAL,
      uptime: process.uptime(),
      manifestOk: manifestUpdater.isManifestOk(),
      fiscal: filaFiscal.status(),
      timestamp: new Date().toISOString(),
    });
  });

  app.post(
    "/diagnostico/logs/abrir-pasta",
    privateNetworkHeaders,
    exigirAgentToken,
    (req, res) => {
      try {
        const diagnosticoEnterprise = require("./diagnosticoEnterprise");
        const logs = diagnosticoEnterprise.lerUltimosLogsEnterprise(1);
        const pasta = logs.pastaLogsReal;
        if (!pasta || !fs.existsSync(pasta)) {
          return res.status(404).json({ ok: false, erro: "Pasta de logs não encontrada." });
        }
        const { spawn } = require("child_process");
        if (process.platform === "win32") {
          spawn("explorer.exe", [pasta], { detached: true, stdio: "ignore" }).unref();
        } else if (process.platform === "darwin") {
          spawn("open", [pasta], { detached: true, stdio: "ignore" }).unref();
        } else {
          spawn("xdg-open", [pasta], { detached: true, stdio: "ignore" }).unref();
        }
        res.json({ ok: true, pasta: logs.pastaLogs, pastaReal: pasta });
      } catch (err) {
        res.status(500).json({ ok: false, erro: err.message });
      }
    },
  );

  // ── Contingência ──────────────────────────────────────────────────────────────
  app.post("/contingencia/epec/salvar", exigirAgentToken, async (req, res) => {
    const { numeroVenda, xmlEpec, epecId } = req.body || {};
    if (!numeroVenda || !xmlEpec)
      return res
        .status(400)
        .json({ erro: "numeroVenda e xmlEpec são obrigatórios." });
    try {
      const cfg = await lerConfig();
      let backendEpecId = epecId || null;
      if (cfg.backendUrl && cfg.backendToken) {
        try {
          backendEpecId = await registrarEpecNoBackend(
            cfg,
            numeroVenda,
            xmlEpec,
          );
        } catch (syncErr) {
          console.warn(
            "[EPEC] Falha ao registrar no backend:",
            syncErr.message,
          );
        }
      }
      const idLocal = backendEpecId || `local:${numeroVenda}:${Date.now()}`;
      if (db) {
        db.prepare(
          `INSERT OR REPLACE INTO epec_pendentes (epec_id, numero_venda, xml_epec) VALUES (?, ?, ?)`,
        ).run(idLocal, numeroVenda, xmlEpec);
      }
      res.json({
        ok: true,
        epecId: idLocal,
        aguardandoBackend: !backendEpecId,
      });
    } catch (err) {
      res.status(500).json({ erro: err.message });
    }
  });

  app.get("/contingencia/status", exigirAgentToken, async (req, res) => {
    estadoContingencia = lerContingencia();
    let epecPendentes = 0;
    if (db) {
      const row = db
        .prepare(
          "SELECT COUNT(*) as n FROM epec_pendentes WHERE status='PENDENTE'",
        )
        .get();
      epecPendentes = row ? row.n : 0;
    }
    res.json({
      ativa: estadoContingencia.ativa,
      iniciadaEm: estadoContingencia.iniciadaEm,
      motivo: estadoContingencia.motivo,
      epecPendentes,
    });
  });

  app.post("/contingencia/encerrar", exigirAgentToken, async (req, res) => {
    try {
      await encerrarContingenciaAutomatico("Encerrado pelo operador.");
      await tentarSincronizarEpecs();
      const row = db
        ? db
            .prepare(
              "SELECT COUNT(*) as n FROM epec_pendentes WHERE status='PENDENTE'",
            )
            .get()
        : { n: 0 };
      res.json({ ok: true, epecPendentesRestantes: row ? row.n : 0 });
    } catch (err) {
      res.status(500).json({ erro: err.message });
    }
  });

  app.get("/contingencia/epec/pendentes", exigirAgentToken, (req, res) => {
    if (!db) return res.json([]);
    const rows = db
      .prepare(
        `SELECT epec_id, numero_venda, tentativas, ultimo_erro, criado_em FROM epec_pendentes WHERE status='PENDENTE' ORDER BY id`,
      )
      .all();
    res.json(rows);
  });

  // ── Impressora ────────────────────────────────────────────────────────────────
  const { formatarErroHttpImpressao } = require("./print/printOperador");
  function responderErroImpressao(res, err) {
    res.status(500).json(formatarErroHttpImpressao(err));
  }

  async function imprimirCupomHandler(req, res) {
    try {
      const resultado = await impressora.imprimirCupom(req.body);
      if (resultado?.queued) {
        return res.status(202).json({
          ok: false,
          fila: true,
          mensagem: resultado.message,
          jobId: resultado.jobId,
          job: resultado.job,
        });
      }
      res.json({ ok: true, jobId: resultado.jobId, ...resultado });
    } catch (err) {
      responderErroImpressao(res, err);
    }
  }

  app.post("/impressora/imprimir", privateNetworkHeaders, exigirAgentToken, imprimirCupomHandler);
  app.post("/impressora/cupom", privateNetworkHeaders, exigirAgentToken, imprimirCupomHandler);

  app.post("/impressora/abertura", privateNetworkHeaders, exigirAgentToken, async (req, res) => {
    try {
      await impressora.imprimirAbertura(req.body);
      res.json({ ok: true });
    } catch (err) {
      responderErroImpressao(res, err);
    }
  });

  app.post("/impressora/fechamento", privateNetworkHeaders, exigirAgentToken, async (req, res) => {
    try {
      await impressora.imprimirFechamento(req.body);
      res.json({ ok: true });
    } catch (err) {
      responderErroImpressao(res, err);
    }
  });

  app.post(
    "/impressora/movimento-caixa",
    privateNetworkHeaders,
    exigirAgentToken,
    async (req, res) => {
      try {
        await impressora.imprimirMovimentoCaixa(req.body);
        res.json({ ok: true });
      } catch (err) {
        responderErroImpressao(res, err);
      }
    },
  );

  app.post("/impressora/gaveta", privateNetworkHeaders, exigirAgentToken, async (req, res) => {
    try {
      await impressora.abrirGaveta();
      res.json({ ok: true });
    } catch (err) {
      responderErroImpressao(res, err);
    }
  });

  app.get("/impressora/status", privateNetworkHeaders, exigirAgentToken, async (req, res) => {
    const forceDetect =
      req.query.detect === "1" ||
      req.query.detect === "true" ||
      req.query.auto === "1";
    if (forceDetect) {
      try {
        await impressora.detectar(true);
      } catch (_) {}
    }
    const [ok, info] = await Promise.all([
      impressora.testar().catch(() => false),
      impressora.getInfo().catch(() => null),
    ]);
    res.json({
      conectada: ok,
      tipo: process.env.PRINTER_TYPE || "auto",
      provider: typeof impressora.getProviderName === "function" ? impressora.getProviderName() : null,
      requestedProvider:
        typeof impressora.getRequestedProviderName === "function"
          ? impressora.getRequestedProviderName()
          : null,
      driver:
        typeof impressora.getDriverInfo === "function" ? impressora.getDriverInfo() : null,
      detectada:
        info?.impressora?.nome ||
        (info?.impressora?.host
          ? `${info.impressora.host}:${info.impressora.porta || info.impressora.port || process.env.PRINTER_PORT || "9100"}`
          : null) ||
        info?.impressora ||
        null,
      ultimaUsada: info?.ultimaUsada || null,
      jobs: impressora.printJobService?.observabilidade?.() || null,
    });
  });

  app.post("/impressora/teste", privateNetworkHeaders, exigirAgentToken, async (req, res) => {
    try {
      const resultado = await impressora.imprimirTeste();
      res.json({ ok: true, ...resultado });
    } catch (err) {
      responderErroImpressao(res, err);
    }
  });

  app.post("/impressora/segunda-via", privateNetworkHeaders, exigirAgentToken, async (req, res) => {
    try {
      const body = req.body || {};
      const resultado = await impressora.imprimirSegundaVia(body);
      res.json({ ok: true, segundaVia: true, ...resultado });
    } catch (err) {
      responderErroImpressao(res, err);
    }
  });

  app.get("/impressora/logo", privateNetworkHeaders, exigirAgentToken, (req, res) => {
    try {
      const printerLogo = require("./print/printerLogo");
      res.json(printerLogo.ler());
    } catch (e) {
      res.status(500).json({ erro: e.message });
    }
  });

  app.put("/impressora/logo", privateNetworkHeaders, exigirAgentToken, (req, res) => {
    try {
      const printerLogo = require("./print/printerLogo");
      const saved = printerLogo.salvar(req.body || {});
      res.json({ ok: true, logo: saved });
    } catch (e) {
      res.status(400).json({ erro: e.message });
    }
  });

  app.delete("/impressora/logo", privateNetworkHeaders, exigirAgentToken, (req, res) => {
    try {
      const printerLogo = require("./print/printerLogo");
      res.json({ ok: true, logo: printerLogo.remover() });
    } catch (e) {
      res.status(500).json({ erro: e.message });
    }
  });

  // ── Imagens de produtos (Storage / DirectoryManager) ───────────────────────
  app.get("/storage/produtos/:produtoId/imagem/meta", privateNetworkHeaders, exigirAgentToken, (req, res) => {
    try {
      const produtoImagens = require("./storage/produtoImagens");
      const cfg = lerConfigSync();
      const meta = produtoImagens.obterMeta(req.params.produtoId, cfg.tenantId);
      if (!meta) return res.status(404).json({ erro: "Imagem não encontrada" });
      res.json(meta);
    } catch (e) {
      res.status(500).json({ erro: e.message });
    }
  });

  app.get("/storage/produtos/:produtoId/imagem/:variant", privateNetworkHeaders, exigirAgentToken, (req, res) => {
    try {
      const variant = String(req.params.variant || "").toLowerCase();
      if (!["thumb", "medium", "original"].includes(variant)) {
        return res.status(400).json({ erro: "Variante inválida" });
      }
      const produtoImagens = require("./storage/produtoImagens");
      const cfg = lerConfigSync();
      const hit = produtoImagens.obterArquivo(req.params.produtoId, variant, cfg.tenantId);
      if (!hit) return res.status(404).json({ erro: "Arquivo não encontrado" });
      res.setHeader("Content-Type", hit.mime);
      res.setHeader("Cache-Control", "public, max-age=86400, immutable");
      res.sendFile(hit.file, { root: hit.root });
    } catch (e) {
      res.status(500).json({ erro: e.message });
    }
  });

  app.put("/storage/produtos/:produtoId/imagem", privateNetworkHeaders, exigirAgentToken, async (req, res) => {
    try {
      const produtoImagens = require("./storage/produtoImagens");
      const meta = await produtoImagens.salvar({
        produtoId: req.params.produtoId,
        base64: req.body?.base64,
        nome: req.body?.nome,
        usuario: req.body?.usuario,
        tenantId: req.body?.tenantId,
        ip: req.ip,
      });
      res.json({ ok: true, imagem: meta });
    } catch (e) {
      res.status(400).json({ erro: e.message });
    }
  });

  app.delete("/storage/produtos/:produtoId/imagem", privateNetworkHeaders, exigirAgentToken, (req, res) => {
    try {
      const produtoImagens = require("./storage/produtoImagens");
      const out = produtoImagens.remover(req.params.produtoId, {
        usuario: req.body?.usuario,
        tenantId: req.body?.tenantId,
        ip: req.ip,
      });
      res.json(out);
    } catch (e) {
      res.status(500).json({ erro: e.message });
    }
  });

  app.get("/impressora/listar", exigirAgentToken, (req, res) => {
    res.json(impressora.listar());
  });

  app.post("/impressora/detectar", exigirAgentToken, async (req, res) => {
    try {
      const bootstrap = require("./print/printerBootstrap");
      const result = await bootstrap.autoDetectarESincronizar({ force: true });
      if (!result.ok) {
        return res.status(404).json({
          ok: false,
          erro: "Nenhuma impressora encontrada",
          ...result.info,
        });
      }
      res.json({ ok: true, ...result.info, config: result.config });
    } catch (err) {
      res.status(500).json({ erro: err.message });
    }
  });

  app.get("/impressora/jobs", privateNetworkHeaders, exigirAgentToken, (req, res) => {
    try {
      const pjs = require("./print/printJobService");
      const status = req.query.status ? String(req.query.status) : undefined;
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      res.json({
        jobs: pjs.listarJobs({ status, limit }),
        observabilidade: pjs.observabilidade(),
      });
    } catch (err) {
      res.status(500).json({ erro: err.message });
    }
  });

  app.get("/impressora/jobs/:id", privateNetworkHeaders, exigirAgentToken, (req, res) => {
    try {
      const job = require("./print/printJobService").buscarJob(req.params.id);
      if (!job) return res.status(404).json({ erro: "Job não encontrado" });
      res.json(job);
    } catch (err) {
      res.status(500).json({ erro: err.message });
    }
  });

  app.post("/impressora/jobs/:id/reprocessar", privateNetworkHeaders, exigirAgentToken, (req, res) => {
    try {
      const job = require("./print/printJobService").reprocessar(req.params.id);
      res.json({ ok: true, job });
    } catch (err) {
      res.status(400).json({ erro: err.message });
    }
  });

  app.post("/impressora/jobs/:id/reimprimir", privateNetworkHeaders, exigirAgentToken, (req, res) => {
    try {
      const job = require("./print/printJobService").reimprimir(req.params.id, req.body || {});
      res.json({ ok: true, job });
    } catch (err) {
      res.status(400).json({ erro: err.message });
    }
  });

  app.post("/impressora/jobs/:id/cancelar", privateNetworkHeaders, exigirAgentToken, (req, res) => {
    try {
      const job = require("./print/printJobService").cancelar(req.params.id);
      res.json({ ok: true, job });
    } catch (err) {
      res.status(400).json({ erro: err.message });
    }
  });

  // ── Venda / Fila ──────────────────────────────────────────────────────────────
  app.post("/venda", exigirAgentToken, async (req, res) => {
    const payload = req.body;
    if (!payload?.numeroVendaCliente)
      return res.status(400).json({ erro: "numeroVendaCliente obrigatório." });
    try {
      const cloudFirst =
        req.query.modo === "cloud-first" ||
        req.headers["x-venda-modo"] === "cloud-first";
      const resposta = cloudFirst
        ? await fila.registrarCloudFirst(payload)
        : await fila.registrarLocalFirst(payload);
      res.json(resposta);
    } catch (err) {
      res.status(500).json({ erro: err.message });
    }
  });

  app.get("/fila", exigirAgentToken, (req, res) => res.json(fila.listar()));

  app.post("/fila/sincronizar", exigirAgentToken, async (req, res) => {
    res.json(await fila.sincronizar());
  });

  app.post("/fila/reprocessar", exigirAgentToken, async (req, res) => {
    auditLog.registrar("FILA_REPROCESSAR", { numeros: req.body?.numeros }, req);
    const numeros = Array.isArray(req.body?.numeros) ? req.body.numeros : [];
    const resultado = fila.resetarFalhas(numeros.length > 0 ? numeros : null);
    fila.sincronizar().catch(() => {});
    res.json({ ok: true, ...resultado });
  });

  // ── Página raiz (sem frontend-dist) ─────────────────────────────────────────
  const FRONTEND_INDEX = path.join(__dirname, "frontend-dist", "index.html");
  const STATUS_HTML = path.join(__dirname, "status.html");
  if (!fs.existsSync(FRONTEND_INDEX)) {
    app.get("/", (req, res) => {
      if (fs.existsSync(STATUS_HTML)) {
        return res.sendFile(STATUS_HTML);
      }
      res.status(404).send("status.html não encontrado");
    });
    if (fs.existsSync(STATUS_HTML)) {
      app.get("/status.html", (req, res) => res.sendFile(STATUS_HTML));
    }
  }

  // ── Frontend estático + SPA (DEPOIS de todas as rotas API) ─────────────────
  // Se montado antes, /fiscal/* e /health devolvem index.html → JSON parse error no PDV.
  const FRONTEND_DIST = path.join(__dirname, "frontend-dist");
  if (fs.existsSync(FRONTEND_INDEX)) {
    app.use(express.static(FRONTEND_DIST));
    app.get(
      /^(?!\/api|\/api-proxy|\/status|\/health|\/venda|\/fila|\/impressora|\/acbr|\/ativar|\/auth|\/config|\/contingencia|\/diagnostico|\/updater|\/fiscal).*$/,
      (req, res) => res.sendFile(FRONTEND_INDEX),
    );
  }

  // ── Error handler ─────────────────────────────────────────────────────────────
  const { respostaErroOperador } = require("./runtime/mensagensOperador");
  app.use((err, req, res, _next) => {
    console.error("[Agente] Erro na rota:", err.message);
    if (!res.headersSent) {
      const body = respostaErroOperador(err, 500);
      res.status(500).json(body);
    }
  });

  // ── Inicialização ─────────────────────────────────────────────────────────────
  fila.inicializar();
  inicializarDb();
  configSync.iniciar(lerConfig, fiscalDriver);

  const SYNC_INTERVAL = parseInt(process.env.SYNC_INTERVAL_MS || "30000", 10);
  trackInterval(() => {
    fila
      .sincronizar()
      .catch((err) =>
        console.warn("[Fila] Erro no sync automatico:", err.message),
      );
  }, SYNC_INTERVAL);
  trackInterval(
    () => {
      tentarSincronizarEpecs().catch((err) =>
        console.warn("[EPEC] Erro no sync automatico:", err.message),
      );
    },
    5 * 60 * 1000,
  );

  if (AUTO_UPDATE) {
    trackInterval(() => verificarAtualizacao().catch(() => {}), 60 * 60 * 1000);
    setTimeout(() => verificarAtualizacao().catch(() => {}), 2 * 60 * 1000);
  }

  process.on("uncaughtException", (err) => {
    console.error("[Agente] uncaughtException:", err);
    try {
      auditLog.registrar("UNCAUGHT_EXCEPTION", { message: err.message });
    } catch (_) {}
    encerrarGracefully("uncaughtException", 1).catch(() => process.exit(1));
  });
  process.on("unhandledRejection", (err) => {
    console.error("[Agente] unhandledRejection:", err);
    encerrarGracefully("unhandledRejection", 1).catch(() => process.exit(1));
  });
  process.on("SIGINT", () => {
    encerrarGracefully("SIGINT", 0).catch(() => process.exit(1));
  });
  process.on("SIGTERM", () => {
    encerrarGracefully("SIGTERM", 0).catch(() => process.exit(1));
  });

  const BIND_HOST = process.env.AGENT_BIND_HOST || "127.0.0.1";
  httpServer = app.listen(PORT, BIND_HOST, () => {
    try {
      require("./bootGuards").assertProductionGuards();
    } catch (e) {
      console.error("[Agente] Boot guard:", e.message);
      process.exit(1);
    }
    console.log(`\n╔══════════════════════════════════════════╗`);
    console.log(`║  Margin Engine — Agente Local v1.0       ║`);
    console.log(`║  ${AGENT_PUBLIC_BASE.padEnd(40)}║`);
    console.log(`╚══════════════════════════════════════════╝\n`);
    try {
      require("./print/factory").warnIfSelectedAtBoot();
      require("./print/printerBootstrap")
        .noBoot()
        .catch(() => {});
    } catch (_) {}
    if (!config.ativado)
      console.log(
        "⚠️  Agente não ativado. Acesse " +
          AGENT_PUBLIC_BASE +
          " para ativar.",
      );
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

// ── Contingência: funções internas ────────────────────────────────────────────
function isUuidEpec(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || ""),
  );
}

async function registrarEpecNoBackend(cfg, numeroVenda, xmlEpec) {
  const fetch = require("node-fetch");
  const resp = await fetch(`${cfg.backendUrl}/pdv/contingencia/epec`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.backendToken}`,
    },
    body: JSON.stringify({ numeroVenda, xmlEpec }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Backend EPEC ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  return data.epecId;
}

async function ativarContingencia(motivoErro) {
  if (estadoContingencia.ativa) return;
  const fetch = require("node-fetch");
  const cfg = await lerConfig();
  try {
    if (cfg.backendUrl && cfg.backendToken) {
      await fetch(`${cfg.backendUrl}/pdv/contingencia/iniciar`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.backendToken}`,
        },
        body: JSON.stringify({
          motivo: "SEFAZ_OFFLINE",
          observacao: motivoErro,
          dispositivoId: cfg.dispositivoId || null,
        }),
      });
    }
  } catch (e) {
    console.warn("[EPEC] Não foi possível notificar backend:", e.message);
  }
  estadoContingencia = {
    ativa: true,
    contingenciaId: null,
    iniciadaEm: new Date().toISOString(),
    motivo: "SEFAZ_OFFLINE",
  };
  salvarContingencia(estadoContingencia);
  console.warn("[EPEC] ⚠️  Contingência ATIVADA.");
}

async function encerrarContingenciaAutomatico(observacao) {
  const fetch = require("node-fetch");
  const cfg = await lerConfig();
  try {
    if (cfg.backendUrl && cfg.backendToken) {
      await fetch(`${cfg.backendUrl}/pdv/contingencia/encerrar`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.backendToken}`,
        },
        body: JSON.stringify({ observacao }),
      });
    }
  } catch (e) {
    console.warn("[EPEC] Não foi possível notificar encerramento:", e.message);
  }
  estadoContingencia = { ativa: false, contingenciaId: null, iniciadaEm: null };
  salvarContingencia(estadoContingencia);
  console.log("[EPEC] ✅ Contingência ENCERRADA.");
}

async function verificarEncerrarContingenciaEpec() {
  if (!db) return;
  const restantes = db
    .prepare("SELECT COUNT(*) as n FROM epec_pendentes WHERE status='PENDENTE'")
    .get();
  if (restantes.n === 0 && estadoContingencia.ativa) {
    await encerrarContingenciaAutomatico("Todos os EPECs transmitidos.");
  }
}

function registrarHandlerEpecFila() {
  filaFiscal.registrarHandler("EPEC", async (payload) => {
    try {
      const resultado = await fiscalDriver.emitirNfce({
        xml: payload.xml || payload.xmlEpec,
        modoEpec: true,
        numeroVenda: payload.numeroVenda,
      });
      if (!resultado?.chave) {
        throw new Error("EPEC retransmitido sem chave na resposta");
      }
      if (db && payload.epecPendenteId) {
        db.prepare("UPDATE epec_pendentes SET status='TRANSMITIDO' WHERE id=?").run(
          payload.epecPendenteId,
        );
      }
      const cfg = await lerConfig();
      if (cfg.backendUrl && cfg.backendToken && payload.epecId && isUuidEpec(payload.epecId)) {
        const fetch = require("node-fetch");
        const patch = await fetch(
          `${cfg.backendUrl}/pdv/contingencia/epec/${payload.epecId}/transmitido?chaveEpec=${encodeURIComponent(resultado.chave)}`,
          {
            method: "PATCH",
            headers: { Authorization: `Bearer ${cfg.backendToken}` },
          },
        );
        if (!patch.ok) {
          console.warn(
            `[EPEC] Backend PATCH transmitido falhou (${patch.status}) para ${payload.epecId}`,
          );
        }
      }
      log.info(
        {
          epecId: payload.epecId,
          registroId: payload.epecPendenteId,
          chave: resultado.chave,
        },
        "EPEC transmitido com sucesso",
      );
      await verificarEncerrarContingenciaEpec();
    } catch (err) {
      if (db && payload.epecPendenteId) {
        db.prepare(
          `UPDATE epec_pendentes SET tentativas=tentativas+1, ultimo_erro=?, status=CASE WHEN tentativas+1 >= 10 THEN 'FALHA_PERMANENTE' ELSE status END WHERE id=?`,
        ).run(err.message, payload.epecPendenteId);
      }
      throw err;
    }
  });
}

async function tentarSincronizarEpecs() {
  if (!db) return;
  if (filaFiscal.acbrOcupado()) return;
  const cfg = await lerConfig();
  if (cfg.backendUrl && cfg.backendToken) {
    try {
      const fetch = require("node-fetch");
      await fetch(`${cfg.backendUrl}/pdv/contingencia/epec/sincronizar`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.backendToken}` },
      });
    } catch (e) {
      console.warn("[EPEC] Falha ao sincronizar com backend:", e.message);
    }
  }
  const pendentes = db
    .prepare(
      `SELECT id, epec_id, numero_venda, xml_epec, tentativas FROM epec_pendentes WHERE status='PENDENTE' ORDER BY id LIMIT 20`,
    )
    .all();
  if (pendentes.length === 0) return;
  for (const row of pendentes) {
    if (!isUuidEpec(row.epec_id) && cfg.backendUrl && cfg.backendToken) {
      try {
        const backendId = await registrarEpecNoBackend(cfg, row.numero_venda, row.xml_epec);
        if (backendId && isUuidEpec(backendId)) {
          db.prepare(`UPDATE epec_pendentes SET epec_id = ? WHERE id = ?`).run(
            backendId,
            row.id,
          );
          row.epec_id = backendId;
        }
      } catch (err) {
        console.warn(
          `[EPEC] Retentativa de registro no backend falhou (${row.numero_venda}):`,
          err.message,
        );
      }
    }
  }
  console.log(`[EPEC] Enfileirando ${pendentes.length} XML(s) para retransmissão...`);
  for (const row of pendentes) {
    filaFiscal.enfileirar(
      "EPEC",
      {
        epecPendenteId: row.id,
        epecId: row.epec_id,
        numeroVenda: row.numero_venda,
        xml: row.xml_epec,
        modoEpec: true,
      },
      `epec-${row.id}`,
      row.numero_venda,
    );
  }
  filaFiscal.dispararProcessamento();
}

// ── Dispara tudo ──────────────────────────────────────────────────────────────
boot().catch((err) => {
  console.error("[Agente] Falha fatal no boot:", err);
  process.exit(1);
});

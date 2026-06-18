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
//   ✓ Contingência EPEC automática com scheduler
// ============================================================

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const os = require("os");
const crypto = require("crypto");
const impressora = require("./impressora");
const acbr = require("./acbr");
const fila = require("./fila");
const credenciais = require("./credenciais");
const marginPaths = require("./marginPaths");
const filaFiscal = require("./filaFiscal");
const fiscalService = require("./fiscalService");
const reconciliacaoFiscal = require("./reconciliacaoFiscal");
const fiscalPreflight = require("./fiscalPreflight");
const watchdog = require("./watchdog");

const app = express();
const PORT = process.env.PORT || 9100;

// ── Versão atual do agente ────────────────────────────────────────────────────
const VERSAO_ATUAL = "5.1.0";

// ── Config persistida ─────────────────────────────────────────────────────────
// Apenas dados NÃO-SENSÍVEIS ficam no config.json (url, nome, ids, flags).
// O backendToken é lido exclusivamente do cofre (credenciais.js).
const CONFIG_PATH = path.join(__dirname, "data", "config.json");

// Cache em memória — evita chamar o cofre a cada request.
// Atualizado por lerConfig() e salvarConfig().
let _configCache = null;

function lerConfigPublica() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    }
  } catch {}
  return {};
}

function salvarConfigPublica(dados) {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Garante que o token nunca seja gravado em texto puro
  const seguro = { ...dados };
  delete seguro.backendToken;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(seguro, null, 2), "utf8");
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
}

// ── Boot: carrega config completa (inclui cofre) ──────────────────────────────
// Usamos uma IIFE async para aguardar o cofre antes de iniciar os módulos.
let config = {};

async function boot() {
  config = await lerConfig();

  if (config.backendUrl) process.env.BACKEND_URL = config.backendUrl;
  if (config.backendToken) process.env.BACKEND_TOKEN = config.backendToken;
  if (config.backendUrl && config.backendToken) {
    fila.atualizarConfig(config.backendUrl, config.backendToken);
  }

  marginPaths.ensureDirs();
  filaFiscal.init();
  fiscalService.registrarHandlersFila(lerConfig);
  filaFiscal.iniciarWorker(5000);
  watchdog.iniciar();
  reconciliacaoFiscal.iniciar(lerConfig);

  iniciarServidor();
}

const AUTO_UPDATE =
  (process.env.AUTO_UPDATE || "false").toLowerCase() === "true";

// ── Contingência EPEC ─────────────────────────────────────────────────────────
const CONTINGENCIA_PATH = path.join(__dirname, "data", "contingencia.json");

function lerContingencia() {
  try {
    if (fs.existsSync(CONTINGENCIA_PATH))
      return JSON.parse(fs.readFileSync(CONTINGENCIA_PATH, "utf8"));
  } catch {}
  return {
    ativa: false,
    contingenciaId: null,
    iniciadaEm: null,
    epecPendentes: 0,
  };
}

function salvarContingencia(estado) {
  const dir = path.dirname(CONTINGENCIA_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONTINGENCIA_PATH, JSON.stringify(estado, null, 2));
}

let estadoContingencia = lerContingencia();

// ── SQLite ────────────────────────────────────────────────────────────────────
const Database = require("better-sqlite3");
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "fila.db");
let db;

function inicializarDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new Database(DB_PATH);
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
const CORS_ORIGENS_ENV = (process.env.AGENTE_CORS_ORIGENS || "")
  .split(",")
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
        `[CORS] Origem "${origin}" permitida (agente ainda sem AGENTE_CORS_ORIGENS / frontendOrigin configurado). ` +
          "Ative o terminal pelo painel ou defina AGENTE_CORS_ORIGENS para restringir.",
      );
      return callback(null, true);
    }
    console.warn(`[CORS] Origem bloqueada: ${origin}`);
    return callback(null, false);
  },
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Agent-Token");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
}

// ── Segurança: token do agente ────────────────────────────────────────────────
function exigirAgentToken(req, res, next) {
  const cfg = lerConfigSync();
  if (!cfg.agentToken) return next();
  const recebido = req.headers["x-agent-token"];
  if (recebido && recebido === cfg.agentToken) return next();
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

async function verificarAtualizacao() {
  if (!AUTO_UPDATE) return;
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
    console.warn(`[Updater] Falha ao verificar atualização: ${err.message}`);
  }
}

async function aplicarAtualizacao(urlDownload, novaVersao, shaEsperado) {
  if (updaterState.atualizando) return;
  updaterState.atualizando = true;

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
    if (!fs.existsSync(novoIndex)) {
      throw new Error(
        "Pacote de atualização inválido: index.js não encontrado.",
      );
    }

    const backupDir = path.join(__dirname, "data", "backup-pre-update");
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    const jsFiles = [
      "index.js",
      "impressora.js",
      "acbr.js",
      "fila.js",
      "credenciais.js",
    ];
    for (const f of jsFiles) {
      const src = path.join(__dirname, f);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(backupDir, f + ".bak"));
      }
    }

    for (const f of jsFiles) {
      const src = path.join(tmpDir, f);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(__dirname, f));
        console.log(`[Updater] ✓ ${f} atualizado`);
      }
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });

    console.log(
      `[Updater] ✅ Atualização ${novaVersao} aplicada. Reiniciando agente...`,
    );
    updaterState.atualizando = false;

    setTimeout(() => process.exit(0), 1500);
  } catch (err) {
    updaterState.atualizando = false;
    updaterState.ultimoErro = err.message;
    console.error(`[Updater] ✗ Falha ao aplicar atualização: ${err.message}`);
    try {
      const backupDir = path.join(__dirname, "data", "backup-pre-update");
      const jsFiles = [
        "index.js",
        "impressora.js",
        "acbr.js",
        "fila.js",
        "credenciais.js",
      ];
      for (const f of jsFiles) {
        const bak = path.join(backupDir, f + ".bak");
        if (fs.existsSync(bak)) fs.copyFileSync(bak, path.join(__dirname, f));
      }
      console.warn("[Updater] Backup restaurado após falha.");
    } catch {}
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

  app.use(corsMiddleware);
  app.use(express.json({ limit: "2mb" }));

  // ── Frontend estático ───────────────────────────────────────────────────────
  const FRONTEND_DIST = path.join(__dirname, "frontend-dist");
  if (fs.existsSync(FRONTEND_DIST)) {
    app.use(express.static(FRONTEND_DIST));
    app.get(
      /^(?!\/api|\/status|\/venda|\/fila|\/impressora|\/acbr|\/ativar|\/config|\/contingencia|\/diagnostico|\/updater).*$/,
      (req, res) => res.sendFile(path.join(FRONTEND_DIST, "index.html")),
    );
  } else if (fs.existsSync(path.join(__dirname, "status.html"))) {
    app.get(["/", "/status.html"], (req, res) => {
      res.sendFile(path.join(__dirname, "status.html"));
    });
  }

  // ── Diagnóstico ─────────────────────────────────────────────────────────────
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
        acbr.EMISSAO_FISCAL
          ? acbr.testar().catch(() => false)
          : Promise.resolve(false),
      ]);

      const { pendentes: filaOffline, falhas: filaFalhas } =
        await fila.contadores();
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
          const stat = fs.statSync(DB_PATH);
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
          temFrontend: fs.existsSync(FRONTEND_DIST),
          porta: PORT,
        },

        impressora: {
          ok: impressoraOk,
          tipo: process.env.PRINTER_TYPE || "auto",
          host: process.env.PRINTER_HOST || null,
          porta: process.env.PRINTER_PORT || null,
          detectada: impressoraInfo?.impressora || null,
          candidatos: impressoraInfo?.candidatos?.length || 0,
          ultimaUsada: impressoraInfo?.ultimaUsada || null,
        },

        acbr: {
          ok: acbrOk,
          emissaoFiscal: acbr.EMISSAO_FISCAL,
          host: process.env.ACBR_HOST || "127.0.0.1",
          porta: process.env.ACBR_PORT || "9200",
        },

        banco: {
          ok: dbOk,
          tamanho: dbSize,
          path: DB_PATH,
        },

        fila: {
          pendentes: filaOffline,
          falhas: filaFalhas,
          auth: fila.statusAuth ? fila.statusAuth() : undefined,
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
      });
    },
  );

  // ── Updater ─────────────────────────────────────────────────────────────────
  app.post(
    "/updater/verificar",
    privateNetworkHeaders,
    exigirAgentToken,
    async (req, res) => {
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

  // Status reduzido e PÚBLICO — alimenta a página "/" (status.html).
  // Mostra apenas informações não sensíveis (sem backendUrl, tenantId,
  // dispositivoId, hostname ou caminhos de arquivo). Pensado para o instalador
  // confirmar visualmente que o agente está rodando, sem expor dados do tenant.
  app.get("/status-basico", privateNetworkHeaders, async (req, res) => {
    config = await lerConfig();

    const [impressoraOk, impressoraInfo, acbrOk] = await Promise.all([
      impressora.testar().catch(() => false),
      impressora.getInfo().catch(() => null),
      acbr.EMISSAO_FISCAL
        ? acbr.testar().catch(() => false)
        : Promise.resolve(false),
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

      impressora: {
        ok: impressoraOk,
        tipo: process.env.PRINTER_TYPE || "auto",
        detectada: impressoraInfo?.impressora || null,
      },

      fiscal: {
        emissaoFiscal: acbr.EMISSAO_FISCAL,
        ok: acbr.EMISSAO_FISCAL ? acbrOk : null,
      },

      banco: { ok: dbOk },

      fila: { pendentes, falhas },

      contingencia: {
        ativa: contingencia.ativa,
        epecPendentes,
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
      const impressoraOk = await impressora.testar().catch(() => false);
      const acbrOk = acbr.EMISSAO_FISCAL
        ? await acbr.testar().catch(() => false)
        : false;
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
        acbrConectado: acbrOk,
        emissaoFiscal: acbr.EMISSAO_FISCAL,
        versao: VERSAO_ATUAL,
        timestamp: new Date().toISOString(),
        ativado: config.ativado === true,
        pdvNome: config.pdvNome || "PDV",
        tenantId: config.tenantId || null,
        dispositivoId: config.dispositivoId || null,
        temFrontend: fs.existsSync(path.join(__dirname, "frontend-dist")),
        filaOffline: { pendentes, falhas },
        contingencia: { ativa: contingencia.ativa, epecPendentes },
      });
    },
  );

  app.get("/config", privateNetworkHeaders, async (req, res) => {
    config = await lerConfig();
    res.json({
      ativado: config.ativado === true,
      pdvNome: config.pdvNome || "",
      backendUrl: config.backendUrl || "",
      tenantId: config.tenantId || "",
      dispositivoId: config.dispositivoId || null,
      emissaoFiscal: acbr.EMISSAO_FISCAL,
    });
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

      fila.atualizarConfig(backendUrl, dados.token);
      console.log(
        `[Agente PDV] Ativado — tenant=${dados.tenantId} pdv=${dados.pdvNome}`,
      );
      res.json({
        ok: true,
        pdvNome: dados.pdvNome,
        tenantId: dados.tenantId,
        agentToken,
      });
    } catch (err) {
      res.status(500).json({ erro: err.message });
    }
  });

  // ── ACBr / Fiscal ────────────────────────────────────────────────────────────
  app.post("/acbr/nfce/emitir", exigirAgentToken, async (req, res) => {
    if (!acbr.EMISSAO_FISCAL) return res.json({ fiscal: false });
    try {
      const cfg = await lerConfig();
      if (req.body?.numeroVenda) {
        const resultado = await fiscalService.emitirCompleto(cfg, {
          ...req.body,
          correlationId:
            req.headers["x-correlation-id"] || req.body.correlationId,
        });
        if (!resultado || resultado.fiscal === false)
          return res.json({ fiscal: false });
        if (estadoContingencia.ativa)
          await encerrarContingenciaAutomatico(
            "SEFAZ voltou — emissão normal restaurada.",
          );
        return res.json(resultado);
      }
      const resultado = await acbr.emitirNfce(req.body);
      if (!resultado || resultado.fiscal === false)
        return res.json({ fiscal: false });
      if (estadoContingencia.ativa)
        await encerrarContingenciaAutomatico(
          "SEFAZ voltou — emissão normal restaurada.",
        );
      return res.json(resultado);
    } catch (err) {
      const msg = err.message || "Erro ao emitir NFC-e";
      const ehFalhaSefaz =
        msg.includes("timeout") ||
        msg.includes("inacessível") ||
        msg.includes("503") ||
        msg.includes("500");
      if (ehFalhaSefaz && acbr.EMISSAO_FISCAL) {
        if (!estadoContingencia.ativa) await ativarContingencia(msg);
        return res.json({
          fiscal: true,
          contingencia: true,
          mensagem: "SEFAZ indisponível. Emita como EPEC.",
        });
      }
      return res.status(500).json({ erro: msg });
    }
  });

  app.post("/fiscal/emitir", exigirAgentToken, async (req, res) => {
    if (!acbr.EMISSAO_FISCAL) return res.json({ fiscal: false });
    try {
      const cfg = await lerConfig();
      const correlationId =
        req.headers["x-correlation-id"] || req.body.correlationId;
      const resultado = await fiscalService.enfileirarEmissao(cfg, {
        ...req.body,
        correlationId,
      });
      res.json(resultado);
    } catch (err) {
      res.status(500).json({ erro: err.message });
    }
  });

  app.get("/acbr/fiscal/preflight", exigirAgentToken, async (req, res) => {
    try {
      res.json(await fiscalPreflight.validarEmissao());
    } catch (err) {
      res.status(400).json({ ok: false, erro: err.message });
    }
  });

  app.post("/fiscal/cancelar", exigirAgentToken, async (req, res) => {
    try {
      const cfg = await lerConfig();
      const resultado = await fiscalService.cancelarCompleto(cfg, req.body);
      res.json(resultado);
    } catch (err) {
      res.status(500).json({ erro: err.message });
    }
  });

  app.post("/acbr/nfce/cancelar", exigirAgentToken, async (req, res) => {
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
      res.json(await acbr.cancelarNfce(chave, req.body?.motivo));
    } catch (err) {
      res.status(500).json({ erro: err.message });
    }
  });

  app.get("/acbr/sefaz/status", exigirAgentToken, async (req, res) => {
    try {
      res.json(await acbr.statusServico());
    } catch (err) {
      res.status(500).json({ erro: err.message });
    }
  });

  app.get("/acbr/nfce/consultar/:chave", exigirAgentToken, async (req, res) => {
    try {
      res.json(await acbr.consultarChave(req.params.chave));
    } catch (err) {
      res.status(500).json({ erro: err.message });
    }
  });

  app.post("/acbr/nfce/inutilizar", exigirAgentToken, async (req, res) => {
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

  app.post("/acbr/nfce/reimprimir", exigirAgentToken, async (req, res) => {
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

  app.get("/fila/fiscal", exigirAgentToken, (req, res) => {
    res.json({ ...filaFiscal.status(), itens: filaFiscal.listar(30) });
  });

  app.post("/fila/fiscal/reprocessar", exigirAgentToken, async (req, res) => {
    filaFiscal.retomarFila();
    res.json({ ok: true, ...filaFiscal.status() });
  });

  app.get("/diagnostico/fiscal", exigirAgentToken, async (req, res) => {
    res.json({
      filaFiscal: filaFiscal.status(),
      watchdog: watchdog.statusWatchdog(),
      paths: marginPaths.PATHS,
      emissaoFiscal: acbr.EMISSAO_FISCAL,
    });
  });

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
      const idLocal = backendEpecId || `epec-${Date.now()}`;
      if (db) {
        db.prepare(
          `INSERT OR REPLACE INTO epec_pendentes (epec_id, numero_venda, xml_epec) VALUES (?, ?, ?)`,
        ).run(idLocal, numeroVenda, xmlEpec);
      }
      res.json({ ok: true, epecId: idLocal });
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
  async function imprimirCupomHandler(req, res) {
    try {
      const resultado = await impressora.imprimirCupom(req.body);
      res.json({ ok: true, ...resultado });
    } catch (err) {
      res.status(500).json({ erro: err.message });
    }
  }

  app.post("/impressora/imprimir", exigirAgentToken, imprimirCupomHandler);
  app.post("/impressora/cupom", exigirAgentToken, imprimirCupomHandler);

  app.post("/impressora/abertura", exigirAgentToken, async (req, res) => {
    try {
      await impressora.imprimirAbertura(req.body);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ erro: err.message });
    }
  });

  app.post("/impressora/fechamento", exigirAgentToken, async (req, res) => {
    try {
      await impressora.imprimirFechamento(req.body);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ erro: err.message });
    }
  });

  app.post(
    "/impressora/movimento-caixa",
    exigirAgentToken,
    async (req, res) => {
      try {
        await impressora.imprimirMovimentoCaixa(req.body);
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ erro: err.message });
      }
    },
  );

  app.post("/impressora/gaveta", exigirAgentToken, async (req, res) => {
    try {
      await impressora.abrirGaveta();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ erro: err.message });
    }
  });

  app.get("/impressora/status", exigirAgentToken, async (req, res) => {
    const [ok, info] = await Promise.all([
      impressora.testar().catch(() => false),
      impressora.getInfo().catch(() => null),
    ]);
    res.json({
      conectada: ok,
      tipo: process.env.PRINTER_TYPE || "auto",
      detectada: info?.impressora || null,
      ultimaUsada: info?.ultimaUsada || null,
    });
  });

  app.get("/impressora/listar", exigirAgentToken, (req, res) => {
    res.json(impressora.listar());
  });

  app.post("/impressora/detectar", exigirAgentToken, async (req, res) => {
    try {
      res.json(await impressora.detectar());
    } catch (err) {
      res.status(500).json({ erro: err.message });
    }
  });

  // ── Venda / Fila ──────────────────────────────────────────────────────────────
  app.post("/venda", exigirAgentToken, async (req, res) => {
    const payload = req.body;
    if (!payload?.numeroVendaCliente)
      return res.status(400).json({ erro: "numeroVendaCliente obrigatório." });
    try {
      const resultado = await fila.tentarBackend(payload);
      if (resultado.ok)
        return res.json({ ok: true, origem: "online", dados: resultado.dados });
      fila.enfileirar(payload);
      res.json({
        ok: true,
        origem: "offline",
        mensagem: "Venda salva na fila.",
      });
    } catch (err) {
      res.status(500).json({ erro: err.message });
    }
  });

  app.get("/fila", exigirAgentToken, (req, res) => res.json(fila.listar()));

  app.post("/fila/sincronizar", exigirAgentToken, async (req, res) => {
    res.json(await fila.sincronizar());
  });

  app.post("/fila/reprocessar", exigirAgentToken, async (req, res) => {
    const numeros = Array.isArray(req.body?.numeros) ? req.body.numeros : [];
    const resultado = fila.resetarFalhas(numeros.length > 0 ? numeros : null);
    fila.sincronizar().catch(() => {});
    res.json({ ok: true, ...resultado });
  });

  // ── Página raiz ───────────────────────────────────────────────────────────────
  // Página estática e somente leitura, sem botões/ações e sem dados sensíveis
  // (sem backendUrl, tenantId, dispositivoId, tokens). Serve apenas para o
  // instalador/operador confirmar visualmente que o agente está rodando.
  // Os dados são obtidos via /status-basico (também público, mesma restrição).
  // Gestão completa do PDV acontece no painel web (/pdv/diagnostico),
  // autenticado e via X-Agent-Token.
  const STATUS_HTML = path.join(__dirname, "status.html");
  app.get("/", (req, res) => {
    if (fs.existsSync(STATUS_HTML)) {
      return res.sendFile(STATUS_HTML);
    }
    res.status(404).send("status.html não encontrado");
  });

  // ── Error handler ─────────────────────────────────────────────────────────────
  app.use((err, req, res, _next) => {
    console.error("[Agente] Erro na rota:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ erro: err.message || "Erro interno do agente." });
    }
  });

  // ── Inicialização ─────────────────────────────────────────────────────────────
  fila.inicializar();
  inicializarDb();

  const SYNC_INTERVAL = parseInt(process.env.SYNC_INTERVAL_MS || "30000", 10);
  setInterval(() => {
    fila
      .sincronizar()
      .catch((err) =>
        console.warn("[Fila] Erro no sync automatico:", err.message),
      );
  }, SYNC_INTERVAL);
  setInterval(
    () => {
      tentarSincronizarEpecs().catch((err) =>
        console.warn("[EPEC] Erro no sync automatico:", err.message),
      );
    },
    5 * 60 * 1000,
  );

  if (AUTO_UPDATE) {
    setInterval(() => verificarAtualizacao().catch(() => {}), 60 * 60 * 1000);
    setTimeout(() => verificarAtualizacao().catch(() => {}), 2 * 60 * 1000);
  }

  process.on("uncaughtException", (err) => {
    console.error("[Agente] uncaughtException:", err);
  });
  process.on("unhandledRejection", (err) => {
    console.error("[Agente] unhandledRejection:", err);
  });

  function encerrarGracefully(signal) {
    console.log(`[Agente] Encerrando (${signal})...`);
    try {
      if (db) db.close();
    } catch (_) {}
    process.exit(0);
  }
  process.on("SIGINT", () => encerrarGracefully("SIGINT"));
  process.on("SIGTERM", () => encerrarGracefully("SIGTERM"));

  app.listen(PORT, () => {
    console.log(`\n╔══════════════════════════════════════════╗`);
    console.log(`║  PDV Margin Engine — Agente Local v5.0  ║`);
    console.log(`║  http://localhost:${PORT}                   ║`);
    console.log(`╚══════════════════════════════════════════╝\n`);
    if (!config.ativado)
      console.log(
        "⚠️  Agente não ativado. Acesse http://localhost:" +
          PORT +
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

async function tentarSincronizarEpecs() {
  if (!db) return;
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
  console.log(`[EPEC] Tentando retransmitir ${pendentes.length} XML(s)...`);
  for (const row of pendentes) {
    try {
      const resultado = await acbr.emitirNfce({
        xml: row.xml_epec,
        modoEpec: true,
        numeroVenda: row.numero_venda,
      });
      if (resultado && resultado.chave) {
        db.prepare(
          "UPDATE epec_pendentes SET status='TRANSMITIDO' WHERE id=?",
        ).run(row.id);
        const cfg = await lerConfig();
        if (cfg.backendUrl && cfg.backendToken && row.epec_id) {
          const fetch = require("node-fetch");
          const patch = await fetch(
            `${cfg.backendUrl}/pdv/contingencia/epec/${row.epec_id}/transmitido?chaveEpec=${encodeURIComponent(resultado.chave)}`,
            {
              method: "PATCH",
              headers: { Authorization: `Bearer ${cfg.backendToken}` },
            },
          );
          if (!patch.ok) {
            console.warn(
              `[EPEC] Backend PATCH transmitido falhou (${patch.status}) para ${row.epec_id}`,
            );
          }
        }
        console.log(`[EPEC] ✅ ${row.numero_venda} transmitido.`);
      }
    } catch (err) {
      if (
        err.message?.includes("timeout") ||
        err.message?.includes("inacessível")
      ) {
        break;
      }
      db.prepare(
        `UPDATE epec_pendentes SET tentativas=tentativas+1, ultimo_erro=?, status=CASE WHEN tentativas+1 >= 10 THEN 'FALHA_PERMANENTE' ELSE status END WHERE id=?`,
      ).run(err.message, row.id);
    }
  }
  const restantes = db
    .prepare("SELECT COUNT(*) as n FROM epec_pendentes WHERE status='PENDENTE'")
    .get();
  if (restantes.n === 0 && estadoContingencia.ativa)
    await encerrarContingenciaAutomatico("Todos os EPECs transmitidos.");
}

// ── Dispara tudo ──────────────────────────────────────────────────────────────
boot().catch((err) => {
  console.error("[Agente] Falha fatal no boot:", err);
  process.exit(1);
});

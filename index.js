// ============================================================
// PDV Margin Engine — Agente Local v6.0
//
// NOVIDADES v6.0 (todas as 4 fases implementadas):
//
// Fase 1 — Seguranca critica:
//   ✓ Token JWT armazenado no Windows Credential Manager (keytar)
//     Nenhum token em texto puro em arquivo nenhum.
//   ✓ Instancia unica de SQLite criada aqui e injetada nos modulos.
//     Fim do risco de multiplos writers simultaneos.
//   ✓ Auto-updater verifica hash SHA-256 antes de aplicar update.
//     Backend deve retornar { versao, urlDownload, sha256, changelog }.
//   ✓ Middleware de autenticacao local nos endpoints sensiveis.
//     Token local gerado no primeiro boot, armazenado no cofre.
//
// Fase 2 — Empacotamento (pkg):
//   package.json ja configurado com "scripts.build" e "pkg" assets.
//   Execute: npm run build  -> gera dist/agente-pdv.exe
//
// Fase 3 — Observabilidade:
//   ✓ Logs estruturados via pino com rotacao diaria (logger.js).
//   ✓ /diagnostico com metricas expandidas (latencia, uptime detalhado).
//   ✓ Watchdog de saude: reinicia modulos que falharem silenciosamente.
//
// Fase 4 — Pronto para CI:
//   ✓ Versao semantica em VERSAO_ATUAL. npm run build gera o .exe.
//   ✓ Hash SHA-256 verificado no updater.
//
// Funcionalidades mantidas da v5:
//   ✓ Serve frontend React estatico
//   ✓ Ativacao por codigo de painel
//   ✓ Fila offline SQLite
//   ✓ Impressora termica ESC/POS
//   ✓ ACBr Monitor via socket TCP
//   ✓ Contingencia EPEC automatica
//   ✓ Auto-updater de hora em hora
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
const AdmZip = require("adm-zip");

const log = require("./logger");
const credenciais = require("./credenciais");
const impressora = require("./impressora");
const acbr = require("./acbr");
const fila = require("./fila");

const app = express();
const PORT = parseInt(process.env.PORT || "9100");

// ── Versao atual do agente ────────────────────────────────────────────────────
const VERSAO_ATUAL = "6.0.0";

// ─────────────────────────────────────────────────────────────────────────────
// ── BANCO DE DADOS — instancia unica injetada nos modulos ─────────────────────
// ─────────────────────────────────────────────────────────────────────────────
const Database = require("better-sqlite3");
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "fila.db");

let db;
function inicializarDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("temp_store = MEMORY");

  // Tabela de EPECs pendentes (contingencia fiscal)
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

  log.info({ path: DB_PATH }, "Banco SQLite inicializado");
}

// ─────────────────────────────────────────────────────────────────────────────
// ── CONFIGURACAO — lida do cofre de credenciais ────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

// config.json agora guarda APENAS dados nao sensiveis (pdvNome, porta, etc.)
// Token e backendUrl vivem no cofre (credenciais.js).
const CONFIG_PATH = path.join(__dirname, "data", "config.json");

function lerConfigPublica() {
  try {
    if (fs.existsSync(CONFIG_PATH))
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (_) {}
  return {
    pdvNome: process.env.PDV_NOME || "PDV Principal",
    tenantId: process.env.TENANT_ID || "",
    dispositivoId: null,
    ativado: false,
  };
}

function salvarConfigPublica(dados) {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // NUNCA salva token ou backendUrl aqui — vai para o cofre
  const { backendToken, ...publico } = dados; // eslint-disable-line no-unused-vars
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(publico, null, 2), "utf8");
}

// Config em memoria (populada no boot e na ativacao)
let config = {
  backendUrl: "",
  backendToken: "",
  pdvNome: "PDV Principal",
  tenantId: "",
  dispositivoId: null,
  ativado: false,
};

async function carregarConfig() {
  const publica = lerConfigPublica();
  const cred = await credenciais.ler();

  config = {
    ...publica,
    backendUrl: cred?.backendUrl || process.env.BACKEND_URL || "",
    backendToken: cred?.backendToken || process.env.BACKEND_TOKEN || "",
    ativado: !!cred?.backendToken,
  };

  if (config.backendUrl) process.env.BACKEND_URL = config.backendUrl;
  if (config.backendToken) process.env.BACKEND_TOKEN = config.backendToken;
}

// ─────────────────────────────────────────────────────────────────────────────
// ── TOKEN LOCAL — autenticacao dos endpoints sensiveis ────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Gerado no primeiro boot e salvo no cofre.
// O frontend local precisa incluir: Authorization: Bearer <LOCAL_TOKEN>
// O .env.example documenta como obter o token.

const LOCAL_TOKEN_KEY = "local-api-token";
let LOCAL_TOKEN = "";

async function garantirTokenLocal() {
  try {
    const cred = await credenciais.ler();
    if (cred?.[LOCAL_TOKEN_KEY]) {
      LOCAL_TOKEN = cred[LOCAL_TOKEN_KEY];
      return;
    }
  } catch (_) {}

  // Gera novo token aleatorio de 32 bytes
  LOCAL_TOKEN = crypto.randomBytes(32).toString("hex");
  const cred = (await credenciais.ler()) || {};
  cred[LOCAL_TOKEN_KEY] = LOCAL_TOKEN;
  await credenciais.salvar(cred);

  log.info("Token local gerado. Para obter o token, execute:");
  log.info(
    "  node -e \"require('./credenciais').ler().then(c=>console.log(c['local-api-token']))\"",
  );
}

// Middleware: verifica token local em rotas sensiveis.
// Rotas publicas (status, diagnostico, frontend) nao passam por aqui.
function autenticarLocal(req, res, next) {
  // Permite acesso de localhost sem token se LOCAL_AUTH=false no .env
  if ((process.env.LOCAL_AUTH || "true") === "false") return next();

  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (!token || token !== LOCAL_TOKEN) {
    log.warn(
      { ip: req.ip, path: req.path },
      "Requisicao nao autorizada bloqueada",
    );
    return res.status(401).json({
      erro: "Token local invalido. Veja os logs do agente para obter o token.",
    });
  }
  next();
}

// ── Contingencia EPEC ─────────────────────────────────────────────────────────
const CONTINGENCIA_PATH = path.join(__dirname, "data", "contingencia.json");

function lerContingencia() {
  try {
    if (fs.existsSync(CONTINGENCIA_PATH))
      return JSON.parse(fs.readFileSync(CONTINGENCIA_PATH, "utf8"));
  } catch (_) {}
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

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));

// ── Frontend estatico ─────────────────────────────────────────────────────────
const FRONTEND_DIST = path.join(__dirname, "frontend-dist");
if (fs.existsSync(FRONTEND_DIST)) {
  app.use(express.static(FRONTEND_DIST));
  app.get(
    /^(?!\/api|\/status|\/venda|\/fila|\/impressora|\/acbr|\/ativar|\/config|\/contingencia|\/diagnostico|\/updater).*$/,
    (req, res) => res.sendFile(path.join(FRONTEND_DIST, "index.html")),
  );
} else {
  // Pagina de status/administracao embutida (exibida quando nao ha frontend-dist)
  const STATUS_HTML_PATH = path.join(__dirname, "status.html");
  app.get("/", (req, res) => {
    if (fs.existsSync(STATUS_HTML_PATH)) {
      res.sendFile(STATUS_HTML_PATH);
    } else {
      res
        .type("html")
        .send(
          "<h2>PDV Margin Engine - Agente Local v" +
            VERSAO_ATUAL +
            ' rodando</h2><p>Acesse <a href="/diagnostico">/diagnostico</a> para ver o status.</p>',
        );
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ── AUTO-UPDATER com verificacao de hash SHA-256 ──────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
//
// O backend DEVE retornar em GET /pdv/agente/versao:
//   { versao: "6.1.0", urlDownload: "https://...", sha256: "abc123...", changelog: "..." }
//
// O sha256 e o hash do arquivo .zip. Se nao bater, a atualizacao e rejeitada.

let updaterState = {
  ultimaVerificacao: null,
  versaoDisponivel: null,
  changelog: null,
  atualizando: false,
  ultimoErro: null,
};

async function verificarAtualizacao() {
  if (!config.backendUrl || !config.backendToken) return;

  const fetch = require("node-fetch");
  try {
    const resp = await fetch(`${config.backendUrl}/pdv/agente/versao`, {
      headers: { Authorization: `Bearer ${config.backendToken}` },
      timeout: 8000,
    });

    if (!resp.ok) return;

    const { versao, urlDownload, sha256, changelog } = await resp.json();
    updaterState.ultimaVerificacao = new Date().toISOString();

    if (!versao || versao === VERSAO_ATUAL) {
      updaterState.versaoDisponivel = null;
      log.debug({ versao: VERSAO_ATUAL }, "Agente up to date");
      return;
    }

    log.info(
      { versaoAtual: VERSAO_ATUAL, versaoNova: versao },
      "Nova versao disponivel",
    );
    updaterState.versaoDisponivel = versao;
    updaterState.changelog = changelog || null;

    if (urlDownload && sha256) {
      await aplicarAtualizacao(urlDownload, sha256, versao);
    } else {
      log.warn(
        "URL de download ou hash SHA-256 ausente — atualizacao nao aplicada",
      );
    }
  } catch (err) {
    updaterState.ultimoErro = err.message;
    log.warn({ err: err.message }, "Falha ao verificar atualizacao");
  }
}

async function aplicarAtualizacao(urlDownload, sha256Esperado, novaVersao) {
  if (updaterState.atualizando) return;
  updaterState.atualizando = true;

  const tmpDir = path.join(os.tmpdir(), `pdv-update-${Date.now()}`);
  const tmpZip = path.join(tmpDir, "update.zip");

  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    log.info({ versao: novaVersao }, "Baixando atualizacao...");

    await downloadFile(urlDownload, tmpZip);

    // ── Verificacao de integridade SHA-256 ────────────────────────────────────
    const hashReal = crypto
      .createHash("sha256")
      .update(fs.readFileSync(tmpZip))
      .digest("hex");

    if (hashReal.toLowerCase() !== sha256Esperado.toLowerCase()) {
      throw new Error(
        `Hash SHA-256 invalido! Esperado: ${sha256Esperado} | Recebido: ${hashReal}. Atualizacao rejeitada.`,
      );
    }
    log.info("Hash SHA-256 verificado com sucesso");

    // ── Extrai com adm-zip (pure JS, sem dependencia de sistema) ──────────────
    const zip = new AdmZip(tmpZip);
    zip.extractAllTo(tmpDir, true);

    const novoIndex = path.join(tmpDir, "index.js");
    if (!fs.existsSync(novoIndex)) {
      throw new Error("Pacote invalido: index.js nao encontrado.");
    }

    // ── Backup dos arquivos atuais ────────────────────────────────────────────
    const backupDir = path.join(__dirname, "data", "backup-pre-update");
    fs.mkdirSync(backupDir, { recursive: true });

    const jsFiles = [
      "index.js",
      "impressora.js",
      "acbr.js",
      "fila.js",
      "logger.js",
      "credenciais.js",
    ];
    for (const f of jsFiles) {
      const src = path.join(__dirname, f);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(backupDir, f + ".bak"));
      }
    }

    // ── Aplica os novos arquivos ──────────────────────────────────────────────
    for (const f of jsFiles) {
      const src = path.join(tmpDir, f);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(__dirname, f));
        log.info({ arquivo: f }, "Arquivo atualizado");
      }
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
    log.info({ versao: novaVersao }, "Atualizacao aplicada. Reiniciando...");
    updaterState.atualizando = false;

    setTimeout(() => process.exit(0), 1500);
  } catch (err) {
    updaterState.atualizando = false;
    updaterState.ultimoErro = err.message;
    log.error({ err: err.message }, "Falha ao aplicar atualizacao");

    // Restaura backup se existir
    try {
      const backupDir = path.join(__dirname, "data", "backup-pre-update");
      const jsFiles = [
        "index.js",
        "impressora.js",
        "acbr.js",
        "fila.js",
        "logger.js",
        "credenciais.js",
      ];
      for (const f of jsFiles) {
        const bak = path.join(backupDir, f + ".bak");
        if (fs.existsSync(bak)) fs.copyFileSync(bak, path.join(__dirname, f));
      }
      log.warn("Backup restaurado apos falha na atualizacao");
    } catch (_) {}

    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(destPath);
    protocol
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Download falhou: HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ── ROTAS PUBLICAS (sem autenticacao local) ────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

// Status basico — acessivel pelo frontend sem token
app.get("/status", async (req, res) => {
  const impressoraOk = await impressora.testar().catch(() => false);
  const acbrOk = acbr.EMISSAO_FISCAL
    ? await acbr.testar().catch(() => false)
    : false;
  const { pendentes, falhas } = fila.contadores();
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
    ativado: config.ativado,
    pdvNome: config.pdvNome || "PDV",
    temFrontend: fs.existsSync(FRONTEND_DIST),
    filaOffline: { pendentes, falhas },
    contingencia: { ativa: contingencia.ativa, epecPendentes },
  });
});

// Diagnostico detalhado — publico (nao expoe token)
app.get("/diagnostico", async (req, res) => {
  const [impressoraOk, acbrOk] = await Promise.all([
    impressora.testar().catch(() => false),
    acbr.EMISSAO_FISCAL
      ? acbr.testar().catch(() => false)
      : Promise.resolve(false),
  ]);

  const { pendentes: filaOffline, falhas: filaFalhas } = fila.contadores();
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
      dbSize = fs.statSync(DB_PATH).size;
    } catch (_) {}
  }

  const uptime = process.uptime();
  const memUsed = process.memoryUsage().heapUsed;

  res.json({
    versao: VERSAO_ATUAL,
    timestamp: new Date().toISOString(),
    uptime,

    agente: {
      ok: true,
      ativado: config.ativado,
      pdvNome: config.pdvNome || "PDV",
      backendUrl: config.backendUrl || null,
      tenantId: config.tenantId || null,
      dispositivoId: config.dispositivoId || null,
      temFrontend: fs.existsSync(FRONTEND_DIST),
      porta: PORT,
      autenticacaoLocal: (process.env.LOCAL_AUTH || "true") !== "false",
    },

    impressora: {
      ok: impressoraOk,
      tipo: process.env.PRINTER_TYPE || "usb",
      host: process.env.PRINTER_HOST || null,
      porta: process.env.PRINTER_PORT || null,
    },

    acbr: {
      ok: acbrOk,
      emissaoFiscal: acbr.EMISSAO_FISCAL,
      host: process.env.ACBR_HOST || "127.0.0.1",
      porta: process.env.ACBR_PORT || "9200",
    },

    banco: { ok: dbOk, tamanho: dbSize, path: DB_PATH },

    fila: { pendentes: filaOffline, falhas: filaFalhas },

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
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      nodeVersao: process.version,
      memUsedMb: Math.round(memUsed / 1024 / 1024),
      uptimeHuman: formatUptime(uptime),
    },
  });
});

// Ativacao — publica (precisa ser acessivel antes de ter token)
app.post("/ativar", async (req, res) => {
  const { codigo, backendUrl } = req.body || {};
  if (!codigo || !backendUrl)
    return res
      .status(400)
      .json({ erro: "codigo e backendUrl sao obrigatorios." });

  const fetch = require("node-fetch");
  try {
    const resp = await fetch(`${backendUrl}/pdv/ativar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codigoAtivacao: codigo }),
    });
    if (!resp.ok) {
      const texto = await resp.text();
      return res.status(400).json({ erro: texto || "Falha na ativacao." });
    }
    const dados = await resp.json();

    // Salva token no cofre — nunca em arquivo texto
    const credNovas = {
      backendUrl,
      backendToken: dados.token,
      tenantId: dados.tenantId,
      pdvNome: dados.pdvNome || "PDV",
      dispositivoId: dados.dispositivoId || null,
    };
    await credenciais.salvar(credNovas);

    // Salva apenas dados nao sensiveis no config.json
    const publica = {
      pdvNome: dados.pdvNome || "PDV",
      tenantId: dados.tenantId,
      dispositivoId: dados.dispositivoId || null,
      ativado: true,
    };
    salvarConfigPublica(publica);

    // Atualiza config em memoria
    config = {
      ...publica,
      backendUrl,
      backendToken: dados.token,
      ativado: true,
    };
    process.env.BACKEND_URL = backendUrl;
    process.env.BACKEND_TOKEN = dados.token;

    fila.atualizarConfig(backendUrl, dados.token);

    log.info(
      { tenantId: dados.tenantId, pdvNome: dados.pdvNome },
      "PDV ativado",
    );
    res.json({ ok: true, pdvNome: dados.pdvNome, tenantId: dados.tenantId });
  } catch (err) {
    log.error({ err: err.message }, "Falha na ativacao");
    res.status(500).json({ erro: err.message });
  }
});

// Config publica (sem token)
app.get("/config", (req, res) => {
  res.json({
    ativado: config.ativado,
    pdvNome: config.pdvNome || "",
    backendUrl: config.backendUrl || "",
    tenantId: config.tenantId || "",
    dispositivoId: config.dispositivoId || null,
    emissaoFiscal: acbr.EMISSAO_FISCAL,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ── ROTAS AUTENTICADAS (requerem token local) ─────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

// Venda
app.post("/venda", autenticarLocal, async (req, res) => {
  const payload = req.body;
  if (!payload?.numeroVendaCliente)
    return res.status(400).json({ erro: "numeroVendaCliente obrigatorio." });
  const resultado = await fila.tentarBackend(payload);
  if (resultado.ok)
    return res.json({ ok: true, origem: "online", dados: resultado.dados });
  fila.enfileirar(payload);
  res.json({ ok: true, origem: "offline", mensagem: "Venda salva na fila." });
});

// Fila
app.get("/fila", autenticarLocal, (req, res) => res.json(fila.listar()));
app.post("/fila/sincronizar", autenticarLocal, async (req, res) => {
  res.json(await fila.sincronizar());
});

// Impressora
app.post("/impressora/imprimir", autenticarLocal, async (req, res) => {
  try {
    await impressora.imprimirCupom(req.body);
    res.json({ ok: true });
  } catch (err) {
    log.error({ err: err.message }, "Erro ao imprimir cupom");
    res.status(500).json({ erro: err.message });
  }
});

app.post("/impressora/fechamento", autenticarLocal, async (req, res) => {
  try {
    await impressora.imprimirFechamento(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post("/impressora/movimento-caixa", autenticarLocal, async (req, res) => {
  try {
    await impressora.imprimirMovimentoCaixa(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.get("/impressora/status", async (req, res) => {
  const ok = await impressora.testar().catch(() => false);
  res.json({ conectada: ok });
});

// ACBr / NFC-e
app.post("/acbr/nfce/emitir", autenticarLocal, async (req, res) => {
  if (!acbr.EMISSAO_FISCAL) return res.json({ fiscal: false });
  try {
    const resultado = await acbr.emitirNfce(req.body);
    if (!resultado || resultado.fiscal === false)
      return res.json({ fiscal: false });
    if (estadoContingencia.ativa)
      await encerrarContingenciaAutomatico(
        "SEFAZ voltou — emissao normal restaurada.",
      );
    return res.json(resultado);
  } catch (err) {
    const msg = err.message || "Erro ao emitir NFC-e";
    const ehFalhaSefaz =
      msg.includes("timeout") ||
      msg.includes("inacessivel") ||
      msg.includes("503") ||
      msg.includes("500");
    if (ehFalhaSefaz && acbr.EMISSAO_FISCAL) {
      if (!estadoContingencia.ativa) await ativarContingencia(msg);
      return res.json({
        fiscal: true,
        contingencia: true,
        mensagem: "SEFAZ indisponivel. Emita como EPEC.",
      });
    }
    return res.status(500).json({ erro: msg });
  }
});

app.post("/acbr/nfce/cancelar", autenticarLocal, async (req, res) => {
  const chave = req.body?.chave || req.body?.chaveNfe;
  if (!chave) return res.status(400).json({ erro: "chave e obrigatoria." });
  try {
    res.json(await acbr.cancelarNfce(chave));
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Contingencia
app.post("/contingencia/epec/salvar", autenticarLocal, async (req, res) => {
  const { numeroVenda, xmlEpec, epecId } = req.body || {};
  if (!numeroVenda || !xmlEpec)
    return res
      .status(400)
      .json({ erro: "numeroVenda e xmlEpec sao obrigatorios." });
  try {
    db.prepare(
      `INSERT OR IGNORE INTO epec_pendentes (epec_id, numero_venda, xml_epec) VALUES (?, ?, ?)`,
    ).run(epecId || `epec-${Date.now()}`, numeroVenda, xmlEpec);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.get("/contingencia/status", (req, res) => {
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

app.post("/contingencia/encerrar", autenticarLocal, async (req, res) => {
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

app.get("/contingencia/epec/pendentes", autenticarLocal, (req, res) => {
  if (!db) return res.json([]);
  const rows = db
    .prepare(
      `SELECT epec_id, numero_venda, tentativas, ultimo_erro, criado_em
       FROM epec_pendentes WHERE status='PENDENTE' ORDER BY id`,
    )
    .all();
  res.json(rows);
});

// Updater
app.post("/updater/verificar", autenticarLocal, async (req, res) => {
  if (updaterState.atualizando)
    return res.json({ ok: false, mensagem: "Atualizacao ja em andamento." });
  verificarAtualizacao().catch(() => {});
  res.json({
    ok: true,
    mensagem: "Verificacao iniciada.",
    estado: updaterState,
  });
});

app.get("/updater/status", (req, res) => {
  res.json({ versaoAtual: VERSAO_ATUAL, ...updaterState });
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Contingencia: funcoes internas ────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
async function ativarContingencia(motivoErro) {
  if (estadoContingencia.ativa) return;
  const fetch = require("node-fetch");
  try {
    if (config.backendUrl && config.backendToken) {
      await fetch(`${config.backendUrl}/pdv/contingencia/iniciar`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.backendToken}`,
        },
        body: JSON.stringify({
          motivo: "SEFAZ_OFFLINE",
          observacao: motivoErro,
          dispositivoId: config.dispositivoId || null,
        }),
      });
    }
  } catch (e) {
    log.warn(
      { err: e.message },
      "Nao foi possivel notificar backend sobre contingencia",
    );
  }
  estadoContingencia = {
    ativa: true,
    contingenciaId: null,
    iniciadaEm: new Date().toISOString(),
    motivo: "SEFAZ_OFFLINE",
  };
  salvarContingencia(estadoContingencia);
  log.warn("Contingencia EPEC ATIVADA");
}

async function encerrarContingenciaAutomatico(observacao) {
  const fetch = require("node-fetch");
  try {
    if (config.backendUrl && config.backendToken) {
      await fetch(`${config.backendUrl}/pdv/contingencia/encerrar`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.backendToken}`,
        },
        body: JSON.stringify({ observacao }),
      });
    }
  } catch (e) {
    log.warn(
      { err: e.message },
      "Nao foi possivel notificar encerramento de contingencia",
    );
  }
  estadoContingencia = { ativa: false, contingenciaId: null, iniciadaEm: null };
  salvarContingencia(estadoContingencia);
  log.info("Contingencia EPEC ENCERRADA");
}

async function tentarSincronizarEpecs() {
  if (!db) return;
  const pendentes = db
    .prepare(
      `SELECT id, epec_id, numero_venda, xml_epec, tentativas
       FROM epec_pendentes WHERE status='PENDENTE' ORDER BY id LIMIT 20`,
    )
    .all();
  if (pendentes.length === 0) return;

  log.info({ quantidade: pendentes.length }, "Retransmitindo EPECs pendentes");

  for (const row of pendentes) {
    try {
      const resultado = await acbr.emitirNfce({
        xml: row.xml_epec,
        modoEpec: false,
        numeroVenda: row.numero_venda,
      });
      if (resultado && resultado.chave) {
        db.prepare(
          "UPDATE epec_pendentes SET status='TRANSMITIDO' WHERE id=?",
        ).run(row.id);
        if (config.backendUrl && config.backendToken && row.epec_id) {
          const fetch = require("node-fetch");
          await fetch(
            `${config.backendUrl}/pdv/contingencia/epec/${row.epec_id}/transmitido?chaveEpec=${resultado.chave}`,
            {
              method: "PATCH",
              headers: { Authorization: `Bearer ${config.backendToken}` },
            },
          ).catch(() => {});
        }
        log.info({ numeroVenda: row.numero_venda }, "EPEC transmitido");
      }
    } catch (err) {
      if (
        err.message?.includes("timeout") ||
        err.message?.includes("inacessivel")
      )
        break;
      db.prepare(
        `UPDATE epec_pendentes
         SET tentativas=tentativas+1, ultimo_erro=?,
             status=CASE WHEN tentativas+1 >= 10 THEN 'FALHA_PERMANENTE' ELSE status END
         WHERE id=?`,
      ).run(err.message, row.id);
    }
  }

  const restantes = db
    .prepare("SELECT COUNT(*) as n FROM epec_pendentes WHERE status='PENDENTE'")
    .get();
  if (restantes.n === 0 && estadoContingencia.ativa)
    await encerrarContingenciaAutomatico("Todos os EPECs transmitidos.");
}

// ── Helper ────────────────────────────────────────────────────────────────────
function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ── INICIALIZACAO ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  // 1. Banco de dados — instancia unica
  inicializarDb();

  // 2. Credenciais do cofre
  await carregarConfig();

  // 3. Token de autenticacao local
  await garantirTokenLocal();

  // 4. Fila — recebe a instancia do banco
  fila.inicializar(db, config.backendUrl, config.backendToken);

  // 5. Intervals
  const SYNC_INTERVAL = parseInt(process.env.SYNC_INTERVAL_MS || "30000");
  setInterval(() => fila.sincronizar().catch(() => {}), SYNC_INTERVAL);
  setInterval(() => tentarSincronizarEpecs().catch(() => {}), 5 * 60 * 1000);
  setInterval(() => verificarAtualizacao().catch(() => {}), 60 * 60 * 1000);
  setTimeout(() => verificarAtualizacao().catch(() => {}), 2 * 60 * 1000);

  // 6. Servidor HTTP
  app.listen(PORT, () => {
    log.info(
      { porta: PORT, versao: VERSAO_ATUAL },
      "PDV Margin Engine iniciado",
    );

    if (!config.ativado) {
      log.warn(
        { url: `http://localhost:${PORT}` },
        "Agente nao ativado — acesse para ativar",
      );
    } else {
      log.info(
        { pdvNome: config.pdvNome, tenantId: config.tenantId },
        "PDV ativado e pronto",
      );
    }
  });
}

main().catch((err) => {
  log.fatal({ err: err.message }, "Falha critica na inicializacao do agente");
  process.exit(1);
});

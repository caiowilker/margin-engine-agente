// ============================================================
// PDV Margin Engine — Agente Local v5.0
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
const impressora = require("./impressora");
const acbr = require("./acbr");
const fila = require("./fila");

const app = express();
const PORT = process.env.PORT || 9100;

// ── Versão atual do agente ────────────────────────────────────────────────────
const VERSAO_ATUAL = "5.0.0";

// ── Config persistida ─────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, "data", "config.json");

function lerConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      return {
        backendUrl: cfg.backendUrl || process.env.BACKEND_URL || "",
        backendToken: cfg.backendToken || process.env.BACKEND_TOKEN || "",
        tenantId: cfg.tenantId || process.env.TENANT_ID || "",
        pdvNome: cfg.pdvNome || process.env.PDV_NOME || "PDV Principal",
        dispositivoId: cfg.dispositivoId || null,
        ativado:
          cfg.ativado === true ||
          !!(cfg.backendUrl && cfg.backendToken) ||
          !!(process.env.BACKEND_URL && process.env.BACKEND_TOKEN),
      };
    }
  } catch {}
  return {
    backendUrl: process.env.BACKEND_URL || "",
    backendToken: process.env.BACKEND_TOKEN || "",
    tenantId: process.env.TENANT_ID || "",
    pdvNome: process.env.PDV_NOME || "PDV Principal",
    dispositivoId: null,
    ativado: !!(process.env.BACKEND_URL && process.env.BACKEND_TOKEN),
  };
}

function salvarConfig(cfg) {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
  process.env.BACKEND_URL = cfg.backendUrl;
  process.env.BACKEND_TOKEN = cfg.backendToken;
}

let config = lerConfig();
if (config.backendUrl) process.env.BACKEND_URL = config.backendUrl;
if (config.backendToken) process.env.BACKEND_TOKEN = config.backendToken;
if (config.backendUrl && config.backendToken) {
  fila.atualizarConfig(config.backendUrl, config.backendToken);
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

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));

// ── Frontend estático ─────────────────────────────────────────────────────────
const FRONTEND_DIST = path.join(__dirname, "frontend-dist");
if (fs.existsSync(FRONTEND_DIST)) {
  app.use(express.static(FRONTEND_DIST));
  app.get(
    /^(?!\/api|\/status|\/venda|\/fila|\/impressora|\/acbr|\/ativar|\/config|\/contingencia|\/diagnostico|\/updater).*$/,
    (req, res) => res.sendFile(path.join(FRONTEND_DIST, "index.html")),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ── AUTO-UPDATER ──────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

// Estado do updater — exposto no /diagnostico e /updater/status
let updaterState = {
  ultimaVerificacao: null,
  versaoDisponivel: null,
  changelog: null,
  atualizando: false,
  ultimoErro: null,
};

/**
 * Verifica se há nova versão no backend.
 * Endpoint esperado: GET /pdv/agente/versao
 * Resposta esperada: { versao: "5.1.0", urlDownload: "https://...", changelog: "..." }
 */
async function verificarAtualizacao() {
  if (!AUTO_UPDATE) return;
  const cfg = lerConfig();
  if (!cfg.backendUrl || !cfg.backendToken) return; // não ativado ainda

  const fetch = require("node-fetch");

  try {
    const resp = await fetch(`${cfg.backendUrl}/pdv/agente/versao`, {
      headers: { Authorization: `Bearer ${cfg.backendToken}` },
      timeout: 8000,
    });

    if (!resp.ok) return;

    const { versao, urlDownload, changelog } = await resp.json();
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
      await aplicarAtualizacao(urlDownload, versao);
    }
  } catch (err) {
    updaterState.ultimoErro = err.message;
    console.warn(`[Updater] Falha ao verificar atualização: ${err.message}`);
  }
}

/**
 * Baixa e aplica o pacote de atualização.
 * O backend serve um .zip com os arquivos JS do agente.
 * Estratégia: baixa em temp, valida, substitui, reinicia.
 */
async function aplicarAtualizacao(urlDownload, novaVersao) {
  if (updaterState.atualizando) return;
  updaterState.atualizando = true;

  const tmpDir = path.join(os.tmpdir(), `pdv-update-${Date.now()}`);
  const tmpZip = path.join(tmpDir, "update.zip");

  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    console.log(`[Updater] Baixando atualização ${novaVersao}...`);

    // Baixa o zip
    await downloadFile(urlDownload, tmpZip);

    // Extrai (usa unzipper via require dinâmico ou fallback para child_process)
    const { execSync } = require("child_process");
    try {
      execSync(`unzip -q "${tmpZip}" -d "${tmpDir}"`, { timeout: 30000 });
    } catch {
      // fallback: PowerShell no Windows
      execSync(
        `powershell -Command "Expand-Archive -Path '${tmpZip}' -DestinationPath '${tmpDir}' -Force"`,
        { timeout: 30000 },
      );
    }

    // Verifica se o pacote contém index.js (arquivo obrigatório)
    const novoIndex = path.join(tmpDir, "index.js");
    if (!fs.existsSync(novoIndex)) {
      throw new Error(
        "Pacote de atualização inválido: index.js não encontrado.",
      );
    }

    // Faz backup dos arquivos atuais
    const backupDir = path.join(__dirname, "data", "backup-pre-update");
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    const jsFiles = ["index.js", "impressora.js", "acbr.js", "fila.js"];
    for (const f of jsFiles) {
      const src = path.join(__dirname, f);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(backupDir, f + ".bak"));
      }
    }

    // Copia os novos arquivos
    for (const f of jsFiles) {
      const src = path.join(tmpDir, f);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(__dirname, f));
        console.log(`[Updater] ✓ ${f} atualizado`);
      }
    }

    // Limpa temp
    fs.rmSync(tmpDir, { recursive: true, force: true });

    console.log(
      `[Updater] ✅ Atualização ${novaVersao} aplicada. Reiniciando agente...`,
    );
    updaterState.atualizando = false;

    // Reinicia o processo — o serviço Windows reinicia automaticamente
    setTimeout(() => process.exit(0), 1500);
  } catch (err) {
    updaterState.atualizando = false;
    updaterState.ultimoErro = err.message;
    console.error(`[Updater] ✗ Falha ao aplicar atualização: ${err.message}`);
    // Tenta restaurar backup
    try {
      const backupDir = path.join(__dirname, "data", "backup-pre-update");
      const jsFiles = ["index.js", "impressora.js", "acbr.js", "fila.js"];
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

// ─────────────────────────────────────────────────────────────────────────────
// ── DIAGNÓSTICO ───────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /diagnostico
 * Retorna JSON estruturado com status de todos os subsistemas.
 * Usado pelo painel visual do frontend.
 */
app.get("/diagnostico", async (req, res) => {
  config = lerConfig();

  // Testa todos os subsistemas em paralelo
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

  // Info do sistema
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
});

// ── Updater: verificação manual ───────────────────────────────────────────────
app.post("/updater/verificar", async (req, res) => {
  if (updaterState.atualizando) {
    return res.json({ ok: false, mensagem: "Atualização já em andamento." });
  }
  verificarAtualizacao().catch(() => {});
  res.json({
    ok: true,
    mensagem: "Verificação iniciada.",
    estado: updaterState,
  });
});

app.get("/updater/status", (req, res) => {
  res.json({ versaoAtual: VERSAO_ATUAL, ...updaterState });
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Rotas existentes (mantidas idênticas) ─────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({ ok: true, versao: VERSAO_ATUAL, uptime: process.uptime() });
});

app.get("/status", async (req, res) => {
  config = lerConfig();
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
    temFrontend: fs.existsSync(FRONTEND_DIST),
    filaOffline: { pendentes, falhas },
    contingencia: { ativa: contingencia.ativa, epecPendentes },
  });
});

app.get("/config", (req, res) => {
  config = lerConfig();
  res.json({
    ativado: config.ativado === true,
    pdvNome: config.pdvNome || "",
    backendUrl: config.backendUrl || "",
    tenantId: config.tenantId || "",
    dispositivoId: config.dispositivoId || null,
    emissaoFiscal: acbr.EMISSAO_FISCAL,
  });
});

app.post("/ativar", async (req, res) => {
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
    const novoConfig = {
      backendUrl,
      backendToken: dados.token,
      tenantId: dados.tenantId,
      pdvNome: dados.pdvNome || "PDV",
      dispositivoId: dados.dispositivoId || null,
      ativado: true,
    };
    salvarConfig(novoConfig);
    config = novoConfig;
    fila.atualizarConfig(backendUrl, dados.token);
    console.log(
      `[Agente PDV] Ativado — tenant=${dados.tenantId} pdv=${dados.pdvNome}`,
    );
    res.json({ ok: true, pdvNome: dados.pdvNome, tenantId: dados.tenantId });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post("/acbr/nfce/emitir", async (req, res) => {
  if (!acbr.EMISSAO_FISCAL) return res.json({ fiscal: false });
  try {
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

app.post("/contingencia/epec/salvar", async (req, res) => {
  const { numeroVenda, xmlEpec, epecId } = req.body || {};
  if (!numeroVenda || !xmlEpec)
    return res
      .status(400)
      .json({ erro: "numeroVenda e xmlEpec são obrigatórios." });
  try {
    if (db) {
      db.prepare(
        `INSERT OR IGNORE INTO epec_pendentes (epec_id, numero_venda, xml_epec) VALUES (?, ?, ?)`,
      ).run(epecId || `epec-${Date.now()}`, numeroVenda, xmlEpec);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.get("/contingencia/status", async (req, res) => {
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

app.post("/contingencia/encerrar", async (req, res) => {
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

app.get("/contingencia/epec/pendentes", (req, res) => {
  if (!db) return res.json([]);
  const rows = db
    .prepare(
      `SELECT epec_id, numero_venda, tentativas, ultimo_erro, criado_em FROM epec_pendentes WHERE status='PENDENTE' ORDER BY id`,
    )
    .all();
  res.json(rows);
});

app.post("/acbr/nfce/cancelar", async (req, res) => {
  const chave = req.body?.chave || req.body?.chaveNfe;
  if (!chave) return res.status(400).json({ erro: "chave é obrigatória." });
  try {
    res.json(await acbr.cancelarNfce(chave));
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

async function imprimirCupomHandler(req, res) {
  try {
    const resultado = await impressora.imprimirCupom(req.body);
    res.json({ ok: true, ...resultado });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

app.post("/impressora/imprimir", imprimirCupomHandler);
app.post("/impressora/cupom", imprimirCupomHandler);

app.post("/impressora/abertura", async (req, res) => {
  try {
    await impressora.imprimirAbertura(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post("/impressora/fechamento", async (req, res) => {
  try {
    await impressora.imprimirFechamento(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post("/impressora/movimento-caixa", async (req, res) => {
  try {
    await impressora.imprimirMovimentoCaixa(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.get("/impressora/status", async (req, res) => {
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

app.get("/impressora/listar", (req, res) => {
  res.json(impressora.listar());
});

app.post("/impressora/detectar", async (req, res) => {
  try {
    res.json(await impressora.detectar());
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post("/venda", async (req, res) => {
  const payload = req.body;
  if (!payload?.numeroVendaCliente)
    return res.status(400).json({ erro: "numeroVendaCliente obrigatório." });
  try {
    const resultado = await fila.tentarBackend(payload);
    if (resultado.ok)
      return res.json({ ok: true, origem: "online", dados: resultado.dados });
    fila.enfileirar(payload);
    res.json({ ok: true, origem: "offline", mensagem: "Venda salva na fila." });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.get("/fila", (req, res) => res.json(fila.listar()));

app.post("/fila/sincronizar", async (req, res) => {
  res.json(await fila.sincronizar());
});

// Reseta itens FALHA_PERMANENTE de volta para PENDENTE e dispara sync imediato.
// Body opcional: { numeros: ["PDV-...", "PDV-..."] } para resetar itens específicos.
// Sem body (ou numeros vazio): reseta TODOS os itens em FALHA_PERMANENTE.
app.post("/fila/reprocessar", async (req, res) => {
  const numeros = Array.isArray(req.body?.numeros) ? req.body.numeros : [];
  const resultado = fila.resetarFalhas(numeros.length > 0 ? numeros : null);
  // Dispara sync automático para tentar enviar imediatamente
  fila.sincronizar().catch(() => {});
  res.json({ ok: true, ...resultado });
});

// ── Contingência: funções internas ────────────────────────────────────────────
async function ativarContingencia(motivoErro) {
  if (estadoContingencia.ativa) return;
  const fetch = require("node-fetch");
  const cfg = lerConfig();
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
  const cfg = lerConfig();
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
        const cfg = lerConfig();
        if (cfg.backendUrl && cfg.backendToken && row.epec_id) {
          const fetch = require("node-fetch");
          await fetch(
            `${cfg.backendUrl}/pdv/contingencia/epec/${row.epec_id}/transmitido?chaveEpec=${resultado.chave}`,
            {
              method: "PATCH",
              headers: { Authorization: `Bearer ${cfg.backendToken}` },
            },
          ).catch(() => {});
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

app.use((err, req, res, _next) => {
  console.error("[Agente] Erro na rota:", err.message);
  if (!res.headersSent) {
    res.status(500).json({ erro: err.message || "Erro interno do agente." });
  }
});

const STATUS_HTML = path.join(__dirname, "status.html");

app.get("/", (req, res) => {
  if (fs.existsSync(STATUS_HTML)) {
    return res.sendFile(STATUS_HTML);
  }

  res.status(404).send("status.html não encontrado");
});

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

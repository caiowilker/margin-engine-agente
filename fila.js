// ============================================================
// PDV Margin Engine — Modulo de Fila Offline com SQLite v3.3
//
// v3.3 — Alinhamento com backend confirmado
//   - processarLote: prioriza r.numeroVenda (campo exato do
//     SyncResultadoItem { numeroVenda, status, erro } do backend)
//     mantendo fallbacks para compatibilidade futura
//
// v3.2 — Diagnostico de token / autenticacao
//   - Loga (mascarado) qual token esta sendo usado e de onde veio
//   - Detecta 401/403 do backend e marca "tokenInvalido" para
//     aparecer no /diagnostico e no /status, em vez de falhar
//     silenciosamente e so reportar "falhas" genericas
//   - tentarBackend/sincronizar nunca mais retornam silenciosos
//     quando faltam url/token — sempre logam o motivo
//
// v3.1 — Estabilidade
//   - Carrega config.json no startup (token persistido apos ativacao)
//   - numeroVendaCliente aceito como chave de idempotencia
//   - Mutex evita sync simultaneo
//   - contadores/listar tolerantes a falhas
// ============================================================

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "fila.db");
const CONFIG_PATH = path.join(__dirname, "data", "config.json");
const MAX_TENTATIVAS = parseInt(process.env.MAX_TENTATIVAS || "10", 10);
const TIMEOUT_MS = parseInt(process.env.BACKEND_TIMEOUT_MS || "5000", 10);

let BACKEND_URL = process.env.BACKEND_URL || "";
let BACKEND_TOKEN = process.env.BACKEND_TOKEN || "";
let db;
let syncEmAndamento = false;

// ── Diagnostico de autenticacao ─────────────────────────────────────────────
// Guardamos o estado da ultima tentativa de comunicacao com o backend para
// que /diagnostico e /status possam mostrar exatamente o que esta acontecendo
// (ex: "token invalido/expirado") em vez de um simples "falhas: N".
let authState = {
  tokenInvalido: false,
  ultimoErro: null,
  ultimaTentativaEm: null,
  ultimoSucessoEm: null,
};

function mascararToken(token) {
  if (!token) return null;
  if (token.length <= 8) return "****";
  return `${token.slice(0, 4)}...${token.slice(-4)} (${token.length} chars)`;
}

function statusAuth() {
  return {
    backendUrl: BACKEND_URL || null,
    temToken: !!BACKEND_TOKEN,
    tokenPreview: mascararToken(BACKEND_TOKEN),
    ...authState,
  };
}

function extrairNumeroVenda(payload) {
  return (
    payload?.numeroVendaCliente ||
    payload?.numeroVenda ||
    payload?.numero ||
    null
  );
}

function isErroPermanente(erroMsg) {
  if (!erroMsg) return false;
  const msg = String(erroMsg).toLowerCase();
  return (
    msg.includes("estoque insuficiente") ||
    msg.includes("produto não encontrado") ||
    msg.includes("produto nao encontrado")
  );
}

function carregarConfigPersistida() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      console.warn(
        `[Fila] config.json nao encontrado em ${CONFIG_PATH} — usando variaveis de ambiente (BACKEND_URL/BACKEND_TOKEN).`,
      );
      return;
    }
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    if (cfg.backendUrl) BACKEND_URL = cfg.backendUrl;
    if (cfg.backendToken) BACKEND_TOKEN = cfg.backendToken;
    console.log(
      `[Fila] Config carregada de config.json — backend=${BACKEND_URL || "(vazio)"} token=${mascararToken(BACKEND_TOKEN) || "(ausente)"}`,
    );
    if (BACKEND_URL && !BACKEND_TOKEN) {
      console.warn(
        "[Fila] ⚠️  backendUrl configurado mas backendToken está vazio/ausente em config.json. " +
          "A sincronização vai ficar enfileirando sem nunca enviar até reativar o agente pelo painel.",
      );
    }
  } catch (err) {
    console.warn("[Fila] Falha ao ler config.json:", err.message);
  }
}

function atualizarConfig(url, token) {
  BACKEND_URL = url || "";
  BACKEND_TOKEN = token || "";
  authState.tokenInvalido = false;
  authState.ultimoErro = null;
  if (url) process.env.BACKEND_URL = url;
  if (token) process.env.BACKEND_TOKEN = token;
  console.log(
    `[Fila] Config atualizada — backend: ${url || "(vazio)"} token: ${mascararToken(token) || "(ausente)"}`,
  );
  if (url && !token) {
    console.warn(
      "[Fila] ⚠️  atualizarConfig recebeu backendUrl sem backendToken. " +
        "Verifique a resposta de /pdv/ativar — a sincronização não vai funcionar sem o token.",
    );
  }
}

function inicializar() {
  carregarConfigPersistida();

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("temp_store = MEMORY");
  db.pragma("busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS fila_vendas (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      numero_venda    TEXT    NOT NULL UNIQUE,
      payload         TEXT    NOT NULL,
      status          TEXT    NOT NULL DEFAULT 'PENDENTE',
      tentativas      INTEGER NOT NULL DEFAULT 0,
      ultimo_erro     TEXT,
      criado_em       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      sincronizado_em TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_fila_status
      ON fila_vendas(status);

    CREATE INDEX IF NOT EXISTS idx_fila_numero_venda
      ON fila_vendas(numero_venda);
  `);

  console.log(`[Fila SQLite] Banco iniciado em ${DB_PATH}`);
}

function enfileirar(payload) {
  if (!db) throw new Error("Fila SQLite nao inicializada.");
  const numero = extrairNumeroVenda(payload);
  if (!numero)
    throw new Error("numeroVendaCliente obrigatorio para enfileirar.");

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO fila_vendas (numero_venda, payload)
    VALUES (?, ?)
  `);
  stmt.run(String(numero), JSON.stringify(payload));
}

function calcularLucroMargem(payload) {
  const itens = Array.isArray(payload?.itens) ? payload.itens : [];
  let lucro = 0;
  for (const i of itens) {
    const qtd = Number(i.quantidade) || 0;
    const preco = Number(i.precoUnitario) || 0;
    const custo = Number(i.custoUnitario) || 0;
    lucro += (preco - custo) * qtd;
  }
  const total = Number(payload?.total) || 0;
  const margem = total > 0 ? (lucro / total) * 100 : 0;
  return { lucro, margem };
}

/** Resposta alinhada ao contrato RespostaVenda do backend (checkout PDV). */
function montarRespostaVenda(payload, opts = {}) {
  const numero = extrairNumeroVenda(payload);
  const { lucro, margem } = calcularLucroMargem(payload);
  const emitirNfce = payload?.emitirNfce === true;
  return {
    numeroVenda: String(numero),
    emitidoEm: opts.emitidoEm || new Date().toISOString(),
    margem,
    lucro,
    total: Number(payload?.total) || 0,
    status: "CONCLUIDA",
    statusFiscal: emitirNfce ? "PENDENTE" : null,
    precisaEmitirFiscal: emitirNfce,
    origem: opts.origem || "local",
    syncPendente: opts.syncPendente === true,
  };
}

function marcarSincronizado(numeroVenda) {
  if (!db) return;
  db.prepare(
    `UPDATE fila_vendas
     SET status = 'SINCRONIZADO',
         sincronizado_em = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE numero_venda = ?`,
  ).run(String(numeroVenda));
}

function sincronizarVendaEmBackground(payload) {
  const numero = extrairNumeroVenda(payload);
  tentarBackend(payload)
    .then((r) => {
      if (r.ok) {
        marcarSincronizado(numero);
        return;
      }
      sincronizar().catch(() => {});
    })
    .catch(() => {
      sincronizar().catch(() => {});
    });
}

/**
 * Local-first: persiste na fila SQLite e responde na hora; sync com nuvem em background.
 * Idempotente por numeroVendaCliente — retries do PDV retornam sucesso sem re-enfileirar.
 */
async function registrarLocalFirst(payload) {
  const numero = extrairNumeroVenda(payload);
  if (!numero) {
    throw new Error("numeroVendaCliente obrigatorio para enfileirar.");
  }

  const existente = db
    ?.prepare(`SELECT status FROM fila_vendas WHERE numero_venda = ?`)
    .get(String(numero));

  if (existente) {
    const syncPendente = existente.status === "PENDENTE";
    if (syncPendente) {
      sincronizarVendaEmBackground(payload);
    }
    return montarRespostaVenda(payload, { origem: "local", syncPendente });
  }

  enfileirar(payload);
  sincronizarVendaEmBackground(payload);
  return montarRespostaVenda(payload, { origem: "local", syncPendente: true });
}

/** Legado: tenta nuvem antes de enfileirar (usado com ?modo=cloud-first). */
async function registrarCloudFirst(payload) {
  const resultado = await tentarBackend(payload);
  if (resultado.ok && resultado.dados) {
    return {
      ...resultado.dados,
      origem: "online",
      syncPendente: false,
    };
  }
  enfileirar(payload);
  sincronizarVendaEmBackground(payload);
  return montarRespostaVenda(payload, { origem: "local", syncPendente: true });
}

async function tentarBackend(payload) {
  const url = BACKEND_URL || process.env.BACKEND_URL || "";
  const token = BACKEND_TOKEN || process.env.BACKEND_TOKEN || "";
  if (!url || !token) {
    const motivo = !url
      ? "backendUrl não configurado"
      : "backendToken não configurado";
    console.warn(
      `[Fila] /venda não enviado ao backend: ${motivo}. Agente provavelmente não está ativado (ver /config ou ative pelo painel).`,
    );
    return {
      ok: false,
      erro: `Agente nao configurado (${motivo}) — ative primeiro.`,
    };
  }

  const fetch = require("node-fetch");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  authState.ultimaTentativaEm = new Date().toISOString();

  try {
    const resp = await fetch(`${url}/pdv/vendas`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!resp.ok) {
      const texto = await resp.text().catch(() => `HTTP ${resp.status}`);
      if (resp.status === 401 || resp.status === 403) {
        authState.tokenInvalido = true;
        authState.ultimoErro = `HTTP ${resp.status}: ${texto}`;
        console.warn(
          `[Fila] ❌ Backend rejeitou o token (HTTP ${resp.status}) ao enviar venda online. ` +
            `Token atual: ${mascararToken(token)}. Reative o agente pelo painel para obter um token novo.`,
        );
      } else {
        authState.ultimoErro = `HTTP ${resp.status}: ${texto}`;
        console.warn(
          `[Fila] Backend retornou erro em /pdv/vendas: HTTP ${resp.status} - ${texto}`,
        );
      }
      return { ok: false, erro: texto, status: resp.status };
    }

    authState.tokenInvalido = false;
    authState.ultimoErro = null;
    authState.ultimoSucessoEm = new Date().toISOString();
    const dados = await resp.json();
    return { ok: true, dados };
  } catch (err) {
    clearTimeout(timer);
    const motivo = err.name === "AbortError" ? "Timeout" : err.message;
    authState.ultimoErro = motivo;
    console.warn(`[Fila] Falha de rede ao enviar /pdv/vendas: ${motivo}`);
    return { ok: false, erro: motivo };
  }
}

async function sincronizar() {
  if (syncEmAndamento) {
    return { sincronizadas: 0, falhas: 0, emAndamento: true };
  }

  const url = BACKEND_URL || process.env.BACKEND_URL || "";
  const token = BACKEND_TOKEN || process.env.BACKEND_TOKEN || "";
  if (!url || !token || !db) {
    return { sincronizadas: 0, falhas: 0 };
  }

  syncEmAndamento = true;
  try {
    return await sincronizarInterno(url, token);
  } finally {
    syncEmAndamento = false;
  }
}

async function sincronizarInterno(url, token) {
  const fetch = require("node-fetch");

  const pendentes = db
    .prepare(
      `
    SELECT id, numero_venda, payload, tentativas
    FROM   fila_vendas
    WHERE  status = 'PENDENTE'
    ORDER  BY id
    LIMIT  50
  `,
    )
    .all();

  if (pendentes.length === 0) return { sincronizadas: 0, falhas: 0 };

  // Monta mapa numero_venda → row para lookup eficiente na resposta
  const mapaNumero = {};
  for (const row of pendentes) {
    mapaNumero[String(row.numero_venda)] = row;
  }

  const lote = pendentes.map((row) => JSON.parse(row.payload));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS * 3);

  // Lê tenantId do config para enviar no header (alguns backends exigem)
  let tenantId = "";
  try {
    const fs = require("fs");
    const path = require("path");
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      tenantId = cfg.tenantId || "";
    }
  } catch (_) {}

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  if (tenantId) headers["X-Tenant-Id"] = tenantId;

  let respostas;
  try {
    const resp = await fetch(`${url}/pdv/vendas/sync`, {
      method: "POST",
      headers,
      body: JSON.stringify(lote),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      const erro = await resp.text().catch(() => `HTTP ${resp.status}`);
      if (resp.status === 401 || resp.status === 403) {
        authState.tokenInvalido = true;
        authState.ultimoErro = `HTTP ${resp.status}: ${erro}`;
        console.warn(
          `[Fila] ❌ Backend rejeitou token no sync (HTTP ${resp.status}). Reative o agente.`,
        );
      } else {
        authState.ultimoErro = `HTTP ${resp.status}: ${erro}`;
      }
      registrarFalhaLote(pendentes, erro);
      return { sincronizadas: 0, falhas: pendentes.length };
    }

    respostas = await resp.json();
  } catch (err) {
    clearTimeout(timer);
    const motivo = err.name === "AbortError" ? "Timeout" : err.message;
    authState.ultimoErro = motivo;
    registrarFalhaLote(pendentes, motivo);
    return { sincronizadas: 0, falhas: pendentes.length };
  }

  let sincronizadas = 0;
  let falhas = 0;

  const marcarSincronizado = db.prepare(`
    UPDATE fila_vendas
    SET    status = 'SINCRONIZADO',
           sincronizado_em = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE  numero_venda = ?
  `);

  const marcarFalha = db.prepare(`
    UPDATE fila_vendas
    SET    tentativas  = tentativas + 1,
           ultimo_erro = ?,
           status      = CASE
                           WHEN ? = 1 THEN 'FALHA_PERMANENTE'
                           WHEN tentativas + 1 >= ${MAX_TENTATIVAS} THEN 'FALHA_PERMANENTE'
                           ELSE 'PENDENTE'
                         END
    WHERE  numero_venda = ?
  `);

  const respostasArray = Array.isArray(respostas) ? respostas : [];

  // Conjunto dos numeros_venda já processados pela resposta do backend
  const processados = new Set();

  const processarLote = db.transaction((resps) => {
    for (const r of resps) {
      // Backend retorna SyncResultadoItem { numeroVenda, status, erro }
      // onde numeroVenda contém o numeroVendaCliente que foi enviado
      const numero =
        r.numeroVenda ||
        r.numeroVendaCliente ||
        r.numero_venda ||
        r.numero ||
        r.id ||
        r.vendaId ||
        null;

      if (!numero) {
        // Resposta sem identificador: log para diagnóstico, mas não conta falha
        // pois pode ser formato diferente de backend
        console.warn(
          "[Fila] Resposta do backend sem identificador de venda:",
          JSON.stringify(r),
        );
        continue;
      }

      const chave = String(numero);
      processados.add(chave);

      if (
        r.status === "ok" ||
        r.status === "duplicata" ||
        r.sucesso === true ||
        r.ok === true
      ) {
        marcarSincronizado.run(chave);
        sincronizadas++;
      } else {
        const erroMsg = r.erro || r.error || r.mensagem || "Erro desconhecido";
        marcarFalha.run(erroMsg, isErroPermanente(erroMsg) ? 1 : 0, chave);
        falhas++;
      }
    }

    // Vendas que foram enviadas mas não apareceram na resposta:
    // se o backend retornou array vazio ou omitiu itens, não deixa pendurado
    for (const chave of Object.keys(mapaNumero)) {
      if (!processados.has(chave)) {
        // Backend não confirmou nem negou — deixa PENDENTE para próximo ciclo
        // mas incrementa tentativa para não ficar em loop infinito silencioso
        marcarFalha.run("Sem confirmação do backend no lote", 0, chave);
        falhas++;
      }
    }
  });

  processarLote(respostasArray);

  authState.tokenInvalido = false;
  if (sincronizadas > 0) {
    authState.ultimoSucessoEm = new Date().toISOString();
    authState.ultimoErro = null;
  }

  return { sincronizadas, falhas };
}

function registrarFalhaLote(pendentes, erro) {
  const stmt = db.prepare(`
    UPDATE fila_vendas
    SET    tentativas  = tentativas + 1,
           ultimo_erro = ?,
           status      = CASE
                           WHEN tentativas + 1 >= ${MAX_TENTATIVAS} THEN 'FALHA_PERMANENTE'
                           ELSE 'PENDENTE'
                         END
    WHERE  id = ?
  `);
  const tx = db.transaction((rows) => {
    for (const row of rows) stmt.run(erro, row.id);
  });
  tx(pendentes);
}

function contadores() {
  try {
    if (!db) return { pendentes: 0, falhas: 0 };
    const row = db
      .prepare(
        `
      SELECT
        SUM(CASE WHEN status = 'PENDENTE'         THEN 1 ELSE 0 END) AS pendentes,
        SUM(CASE WHEN status = 'FALHA_PERMANENTE' THEN 1 ELSE 0 END) AS falhas
      FROM fila_vendas
    `,
      )
      .get();
    return {
      pendentes: row?.pendentes || 0,
      falhas: row?.falhas || 0,
    };
  } catch (err) {
    console.warn("[Fila] Erro ao ler contadores:", err.message);
    return { pendentes: 0, falhas: 0 };
  }
}

function listar() {
  try {
    if (!db) return [];
    return db
      .prepare(
        `
      SELECT id, numero_venda, status, tentativas, ultimo_erro, criado_em, sincronizado_em
      FROM   fila_vendas
      ORDER  BY id DESC
      LIMIT  200
    `,
      )
      .all();
  } catch (err) {
    console.warn("[Fila] Erro ao listar fila:", err.message);
    return [];
  }
}

/**
 * Reseta itens FALHA_PERMANENTE de volta para PENDENTE para nova tentativa.
 * Opcionalmente recebe um array de numero_venda para resetar apenas itens específicos.
 */
function resetarFalhas(numeros) {
  try {
    if (!db) return { resetados: 0 };
    let stmt;
    let result;
    if (numeros && numeros.length > 0) {
      const placeholders = numeros.map(() => "?").join(",");
      stmt = db.prepare(`
        UPDATE fila_vendas
        SET    status     = 'PENDENTE',
               tentativas = 0,
               ultimo_erro = NULL
        WHERE  status = 'FALHA_PERMANENTE'
        AND    numero_venda IN (${placeholders})
      `);
      result = stmt.run(...numeros.map(String));
    } else {
      stmt = db.prepare(`
        UPDATE fila_vendas
        SET    status     = 'PENDENTE',
               tentativas = 0,
               ultimo_erro = NULL
        WHERE  status = 'FALHA_PERMANENTE'
      `);
      result = stmt.run();
    }
    console.log(`[Fila] ${result.changes} item(s) resetado(s) para PENDENTE.`);
    return { resetados: result.changes };
  } catch (err) {
    console.warn("[Fila] Erro ao resetar falhas:", err.message);
    return { resetados: 0 };
  }
}

function purgeAntigos(dias = 30) {
  try {
    if (!db) inicializar();
    const r = db
      .prepare(
        `DELETE FROM fila_vendas WHERE status = 'CONCLUIDO'
         AND datetime(criado_em) < datetime('now', ?)`,
      )
      .run(`-${dias} days`);
    return { removidos: r.changes };
  } catch (err) {
    console.warn("[Fila] Erro no purge:", err.message);
    return { removidos: 0 };
  }
}

module.exports = {
  inicializar,
  atualizarConfig,
  enfileirar,
  tentarBackend,
  registrarLocalFirst,
  registrarCloudFirst,
  montarRespostaVenda,
  sincronizar,
  contadores,
  listar,
  resetarFalhas,
  statusAuth,
  purgeAntigos,
};

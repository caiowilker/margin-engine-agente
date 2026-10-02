/**
 * Sessão de piso da loja (storeFloor) — QR funcionário COUNTER_STORE.
 * Distinto de garcomFloor: hub = Central de pedidos, query = storeFloor.
 * JWT nunca vai no QR; o celular troca storeFloor → access/refresh + agentToken.
 *
 * Contrato de vida do QR (igual ao Garçom):
 * - Mesmo token/URL até Regenerar (forceNew) ou revoke.
 * - IP LAN pinado no 1º mint.
 */
const crypto = require("crypto");
const fs = require("fs");
const { writeJsonAtomicSync } = require("./runtime/atomicWrite");
const { getDirectoryManager } = require("./runtime/directoryManager");
const { buildLanPublicBase, detectLanIPv4, isPrivateIPv4 } = require("./lanNetwork");

function tokensEqual(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias
const HUB_PATH = "/pdv/central-pedidos";
const QUERY_PARAM = "storeFloor";

/**
 * Snapshot mínimo do operador para o celular abrir a Central sem getMe.
 * @param {unknown} me
 * @returns {object | null}
 */
function sanitizeOperatorMe(me) {
  if (!me || typeof me !== "object") return null;
  const m = /** @type {Record<string, unknown>} */ (me);
  const userId = m.userId != null ? String(m.userId).trim() : "";
  const email = m.email != null ? String(m.email).trim() : "";
  const role = m.role != null ? String(m.role).trim() : "";
  const tenantStatus = m.tenantStatus != null ? String(m.tenantStatus).trim() : "";
  if (!userId || !email || !role || !tenantStatus) return null;
  let operationMode =
    m.operationMode != null ? String(m.operationMode) : "COUNTER_STORE";
  if (
    operationMode !== "COUNTER_STORE" &&
    operationMode !== "FOOD_SERVICE" &&
    operationMode !== "HYBRID"
  ) {
    operationMode = "COUNTER_STORE";
  }
  return {
    userId,
    email,
    role,
    tenantStatus,
    tenantId: m.tenantId != null ? String(m.tenantId) : null,
    tenantName: m.tenantName != null ? String(m.tenantName) : null,
    userName: m.userName != null ? String(m.userName) : null,
    plan: m.plan != null ? String(m.plan) : null,
    activationDaysRemaining: Number(m.activationDaysRemaining) || 0,
    ownerEmail: m.ownerEmail != null ? String(m.ownerEmail) : null,
    hasPassword: m.hasPassword !== false,
    phone: m.phone != null ? String(m.phone) : null,
    termsAccepted: m.termsAccepted !== false,
    operationMode,
  };
}

/** @type {Record<string, unknown> | null} */
let _cache = null;

function resolveFilePath() {
  if (process.env.STORE_FLOOR_FILE) {
    return process.env.STORE_FLOOR_FILE;
  }
  return getDirectoryManager().file("agent", "store-floor.json");
}

function emptyState() {
  return {
    floorToken: null,
    accessToken: null,
    refreshToken: null,
    refreshIsolated: false,
    operatorMe: null,
    lanIp: null,
    expiresAt: 0,
    mintedAt: 0,
  };
}

function load() {
  if (_cache) return { ..._cache };
  const file = resolveFilePath();
  if (!fs.existsSync(file)) {
    _cache = emptyState();
    return { ..._cache };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const lanIpRaw = raw.lanIp ? String(raw.lanIp).trim() : null;
    _cache = {
      floorToken: raw.floorToken ? String(raw.floorToken) : null,
      accessToken: raw.accessToken ? String(raw.accessToken) : null,
      refreshToken: raw.refreshToken ? String(raw.refreshToken) : null,
      refreshIsolated: raw.refreshIsolated === true,
      operatorMe:
        raw.operatorMe && typeof raw.operatorMe === "object" ? raw.operatorMe : null,
      lanIp: lanIpRaw && isPrivateIPv4(lanIpRaw) ? lanIpRaw : null,
      expiresAt: Number(raw.expiresAt) || 0,
      mintedAt: Number(raw.mintedAt) || 0,
    };
  } catch {
    _cache = emptyState();
  }
  return { ..._cache };
}

function save(state) {
  _cache = { ...state };
  const file = resolveFilePath();
  writeJsonAtomicSync(file, _cache, {
    ensureDir: (dir) => {
      try {
        getDirectoryManager().ensurePath(dir, "agentData");
      } catch {
        fs.mkdirSync(dir, { recursive: true });
      }
    },
  });
}

function resolveLanIp(optsLanIp, pinnedLanIp, forceNew) {
  if (!forceNew && pinnedLanIp && isPrivateIPv4(pinnedLanIp)) {
    return pinnedLanIp;
  }
  if (optsLanIp !== undefined && optsLanIp !== null) {
    const explicit = String(optsLanIp).trim();
    if (explicit && isPrivateIPv4(explicit)) return explicit;
  }
  const detected = detectLanIPv4();
  return detected && isPrivateIPv4(detected) ? detected : null;
}

function buildQrUrl({ lanIp, port, floorToken }) {
  const base = buildLanPublicBase({
    port,
    lanIp: lanIp || detectLanIPv4(),
    preferLan: true,
  });
  if (!floorToken) return `${base}${HUB_PATH}`;
  return `${base}${HUB_PATH}?${QUERY_PARAM}=${encodeURIComponent(floorToken)}`;
}

/**
 * @param {{ accessToken?: string, refreshToken?: string, refreshIsolated?: boolean, operatorMe?: object | null, forceNew?: boolean, lanIp?: string | null, port?: number }} opts
 */
function mint(opts = {}) {
  let state = load();
  const accessToken =
    opts.accessToken != null && String(opts.accessToken).trim()
      ? String(opts.accessToken).trim()
      : null;
  const refreshToken =
    opts.refreshToken != null && String(opts.refreshToken).trim()
      ? String(opts.refreshToken).trim()
      : null;
  const refreshIsolated = opts.refreshIsolated === true && !!refreshToken;
  const operatorMe = sanitizeOperatorMe(opts.operatorMe);
  const forceNew = !!opts.forceNew;
  const port = Number(opts.port) || Number(process.env.AGENT_PORT || process.env.PORT || 9100);
  const now = Date.now();

  const reusable = !forceNew && !!state.floorToken && !!(state.accessToken || accessToken);

  if (reusable) {
    const lanIp = resolveLanIp(opts.lanIp, state.lanIp, false);
    const nextRefreshIsolated = refreshIsolated
      ? true
      : state.refreshIsolated === true;
    const nextRefreshToken = refreshIsolated
      ? refreshToken
      : nextRefreshIsolated
        ? state.refreshToken
        : null;
    state = {
      ...state,
      accessToken: accessToken || state.accessToken || null,
      refreshToken: nextRefreshToken,
      refreshIsolated: nextRefreshIsolated,
      operatorMe: operatorMe || state.operatorMe,
      lanIp: lanIp || state.lanIp || null,
      expiresAt: now + TTL_MS,
    };
    save(state);
    return {
      floorToken: state.floorToken,
      expiresAt: state.expiresAt,
      qrUrl: buildQrUrl({ lanIp: state.lanIp, port, floorToken: state.floorToken }),
      lanIp: state.lanIp,
      operatorBound: !!state.accessToken,
      hasOperatorMe: !!(state.operatorMe && state.operatorMe.userId),
      reused: true,
      floorKind: "store",
    };
  }

  const lanIp = resolveLanIp(opts.lanIp, null, true);
  const floorToken = crypto.randomBytes(24).toString("hex");
  state = {
    floorToken,
    accessToken: accessToken || null,
    refreshToken: refreshIsolated ? refreshToken : null,
    refreshIsolated,
    operatorMe: operatorMe || null,
    lanIp,
    expiresAt: now + TTL_MS,
    mintedAt: now,
  };
  save(state);

  return {
    floorToken,
    expiresAt: state.expiresAt,
    qrUrl: buildQrUrl({ lanIp: state.lanIp, port, floorToken }),
    lanIp: state.lanIp,
    operatorBound: !!state.accessToken,
    hasOperatorMe: !!(state.operatorMe && state.operatorMe.userId),
    reused: false,
    floorKind: "store",
  };
}

/**
 * @param {string} floorToken
 * @param {{ agentToken?: string | null }} [opts]
 */
function exchange(floorToken, opts = {}) {
  const state = load();
  const token = String(floorToken || "").trim();
  if (!token || !state.floorToken || !tokensEqual(token, state.floorToken)) {
    return {
      ok: false,
      status: 401,
      erro: "Token da loja inválido. Escaneie o QR atual do caixa (ou Regenerar se trocou de rede).",
    };
  }
  if (state.expiresAt > 0 && state.expiresAt <= Date.now()) {
    return {
      ok: false,
      status: 401,
      code: "FLOOR_SOFT_EXPIRED",
      erro:
        "Sessão da loja precisa ser reativada no caixa (abra QR da Loja — o mesmo QR continua válido).",
    };
  }
  if (!state.accessToken) {
    return {
      ok: false,
      status: 409,
      erro: "Sessão da loja sem operador vinculado. Faça login no PDV do caixa e regenere o QR.",
    };
  }
  return {
    ok: true,
    accessToken: state.accessToken,
    ...(state.refreshIsolated && state.refreshToken
      ? { refreshToken: state.refreshToken }
      : {}),
    agentToken: opts.agentToken || null,
    operatorMe: state.operatorMe || null,
    expiresAt: state.expiresAt,
    floorKind: "store",
  };
}

function revoke() {
  save(emptyState());
  return { ok: true };
}

function status(opts = {}) {
  const state = load();
  const port = Number(opts.port) || Number(process.env.AGENT_PORT || process.env.PORT || 9100);
  const lanIp = resolveLanIp(opts.lanIp, state.lanIp, false);
  const alive = !!state.floorToken;
  const softActive = alive && (!state.expiresAt || state.expiresAt > Date.now());
  return {
    active: softActive && !!state.accessToken,
    expiresAt: state.expiresAt || null,
    operatorBound: !!state.accessToken,
    lanIp: lanIp || state.lanIp || null,
    qrUrl:
      alive && state.floorToken
        ? buildQrUrl({
            lanIp: lanIp || state.lanIp,
            port,
            floorToken: state.floorToken,
          })
        : null,
    floorTokenAlive: alive,
    floorKind: "store",
  };
}

/** @internal testes */
function _resetForTests() {
  _cache = null;
}

module.exports = {
  TTL_MS,
  HUB_PATH,
  QUERY_PARAM,
  mint,
  exchange,
  revoke,
  status,
  buildQrUrl,
  sanitizeOperatorMe,
  _resetForTests,
  resolveFilePath,
};

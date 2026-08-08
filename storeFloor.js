/**
 * Sessão de piso da loja (storeFloor) — QR funcionário COUNTER_STORE.
 * Distinto de garcomFloor: hub = Central de pedidos, query = storeFloor.
 * JWT nunca vai no QR; o celular troca storeFloor → access/refresh + agentToken.
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

const TTL_MS = 12 * 60 * 60 * 1000; // 12h
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

/** @type {{ floorToken: string, accessToken: string | null, refreshToken: string | null, operatorMe: object | null, expiresAt: number, mintedAt: number } | null} */
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
    _cache = {
      floorToken: raw.floorToken ? String(raw.floorToken) : null,
      accessToken: raw.accessToken ? String(raw.accessToken) : null,
      refreshToken: raw.refreshToken ? String(raw.refreshToken) : null,
      refreshIsolated: raw.refreshIsolated === true,
      operatorMe:
        raw.operatorMe && typeof raw.operatorMe === "object" ? raw.operatorMe : null,
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

function purgeIfExpired(state = load()) {
  if (state.floorToken && state.expiresAt > 0 && state.expiresAt <= Date.now()) {
    const cleared = emptyState();
    save(cleared);
    return cleared;
  }
  return state;
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
 * @param {{ accessToken?: string, refreshToken?: string, operatorMe?: object | null, forceNew?: boolean, lanIp?: string | null, port?: number }} opts
 */
function mint(opts = {}) {
  let state = purgeIfExpired();
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
  const lanIp = opts.lanIp !== undefined ? opts.lanIp : detectLanIPv4();

  const reusable =
    !forceNew &&
    state.floorToken &&
    state.expiresAt > Date.now() &&
    (state.accessToken || accessToken);

  if (reusable) {
    if (accessToken) {
      state = {
        ...state,
        accessToken,
        refreshToken: refreshIsolated ? refreshToken : null,
        refreshIsolated,
        operatorMe: operatorMe || state.operatorMe,
      };
      save(state);
    }
    return {
      floorToken: state.floorToken,
      expiresAt: state.expiresAt,
      qrUrl: buildQrUrl({ lanIp, port, floorToken: state.floorToken }),
      lanIp: lanIp && isPrivateIPv4(lanIp) ? lanIp : null,
      operatorBound: !!state.accessToken,
      hasOperatorMe: !!(state.operatorMe && state.operatorMe.userId),
      reused: true,
      floorKind: "store",
    };
  }

  const floorToken = crypto.randomBytes(24).toString("hex");
  const now = Date.now();
  state = {
    floorToken,
    accessToken: accessToken || state.accessToken || null,
    refreshToken: refreshIsolated ? refreshToken : null,
    refreshIsolated,
    operatorMe: operatorMe || state.operatorMe || null,
    expiresAt: now + TTL_MS,
    mintedAt: now,
  };
  save(state);

  return {
    floorToken,
    expiresAt: state.expiresAt,
    qrUrl: buildQrUrl({ lanIp, port, floorToken }),
    lanIp: lanIp && isPrivateIPv4(lanIp) ? lanIp : null,
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
  const state = purgeIfExpired();
  const token = String(floorToken || "").trim();
  if (!token || !state.floorToken || !tokensEqual(token, state.floorToken)) {
    return { ok: false, status: 401, erro: "Token da loja inválido ou expirado." };
  }
  if (state.expiresAt <= Date.now()) {
    return { ok: false, status: 401, erro: "Token da loja expirado. Regenere o QR no caixa." };
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
  const state = purgeIfExpired();
  const port = Number(opts.port) || Number(process.env.AGENT_PORT || process.env.PORT || 9100);
  const lanIp = opts.lanIp !== undefined ? opts.lanIp : detectLanIPv4();
  return {
    active: !!(state.floorToken && state.expiresAt > Date.now()),
    expiresAt: state.expiresAt || null,
    operatorBound: !!state.accessToken,
    lanIp: lanIp && isPrivateIPv4(lanIp) ? lanIp : null,
    qrUrl:
      state.floorToken && state.expiresAt > Date.now()
        ? buildQrUrl({ lanIp, port, floorToken: state.floorToken })
        : null,
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

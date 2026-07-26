/**
 * Sessão de piso (floor) do garçom — token curto no QR, JWT do operador bound no PC.
 * JWT nunca vai no QR; o celular troca floor → access/refresh + agentToken.
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
const HUB_PATH = "/pdv/mesas";

/** @type {{ floorToken: string, accessToken: string | null, refreshToken: string | null, expiresAt: number, mintedAt: number } | null} */
let _cache = null;

function resolveFilePath() {
  if (process.env.GARCOM_FLOOR_FILE) {
    return process.env.GARCOM_FLOOR_FILE;
  }
  return getDirectoryManager().file("agent", "garcom-floor.json");
}

function emptyState() {
  return {
    floorToken: null,
    accessToken: null,
    refreshToken: null,
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
  return `${base}${HUB_PATH}?floor=${encodeURIComponent(floorToken)}`;
}

/**
 * @param {{ accessToken?: string, refreshToken?: string, forceNew?: boolean, lanIp?: string | null, port?: number }} opts
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
        refreshToken: refreshToken || state.refreshToken,
      };
      save(state);
    }
    return {
      floorToken: state.floorToken,
      expiresAt: state.expiresAt,
      qrUrl: buildQrUrl({ lanIp, port, floorToken: state.floorToken }),
      lanIp: lanIp && isPrivateIPv4(lanIp) ? lanIp : null,
      operatorBound: !!(state.accessToken && state.refreshToken),
      reused: true,
    };
  }

  const floorToken = crypto.randomBytes(24).toString("hex");
  const now = Date.now();
  state = {
    floorToken,
    accessToken: accessToken || state.accessToken || null,
    refreshToken: refreshToken || state.refreshToken || null,
    expiresAt: now + TTL_MS,
    mintedAt: now,
  };
  save(state);

  return {
    floorToken,
    expiresAt: state.expiresAt,
    qrUrl: buildQrUrl({ lanIp, port, floorToken }),
    lanIp: lanIp && isPrivateIPv4(lanIp) ? lanIp : null,
    operatorBound: !!(state.accessToken && state.refreshToken),
    reused: false,
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
    return { ok: false, status: 401, erro: "Token do salão inválido ou expirado." };
  }
  if (state.expiresAt <= Date.now()) {
    return { ok: false, status: 401, erro: "Token do salão expirado. Regenere o QR no caixa." };
  }
  if (!state.accessToken || !state.refreshToken) {
    return {
      ok: false,
      status: 409,
      erro: "Sessão do salão sem operador vinculado. Faça login no PDV do caixa e regenere o QR.",
    };
  }
  return {
    ok: true,
    accessToken: state.accessToken,
    refreshToken: state.refreshToken,
    agentToken: opts.agentToken || null,
    expiresAt: state.expiresAt,
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
    operatorBound: !!(state.accessToken && state.refreshToken),
    lanIp: lanIp && isPrivateIPv4(lanIp) ? lanIp : null,
    qrUrl:
      state.floorToken && state.expiresAt > Date.now()
        ? buildQrUrl({ lanIp, port, floorToken: state.floorToken })
        : null,
  };
}

/** @internal testes */
function _resetForTests() {
  _cache = null;
}

module.exports = {
  TTL_MS,
  HUB_PATH,
  mint,
  exchange,
  revoke,
  status,
  buildQrUrl,
  _resetForTests,
  resolveFilePath,
};

/**
 * Detecção de IPv4 privado para QR Garçom / acesso LAN do salão.
 * Prefere interfaces Wi‑Fi/Ethernet reais; penaliza docker/WSL/VM.
 */
const os = require("os");

const VIRTUAL_IFACE_RX =
  /docker|veth|br-|virbr|vbox|vmnet|hyper-v|wsl|tun|tap|loopback|lo$/i;
const PREFERRED_IFACE_RX = /wi-?fi|wlan|wl|wifi|eth|ethernet|en0|enp|eno|ens|lan|local area/i;

function isPrivateIPv4(ip) {
  const s = String(ip || "").replace(/^::ffff:/, "");
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return false;
  if (s.startsWith("10.")) return true;
  if (s.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(s)) return true;
  return false;
}

function isLoopbackIPv4(ip) {
  const s = String(ip || "").replace(/^::ffff:/, "");
  return s === "127.0.0.1" || s === "::1";
}

/**
 * @param {string} name
 * @param {string} address
 * @returns {number}
 */
function scoreCandidate(name, address) {
  let score = 0;
  if (VIRTUAL_IFACE_RX.test(name)) score -= 100;
  if (PREFERRED_IFACE_RX.test(name)) score += 30;
  if (address.startsWith("192.168.")) score += 15;
  else if (address.startsWith("10.")) score += 10;
  else if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) score += 8;
  // Preferir endereços "estáveis" (não APIPA)
  if (address.startsWith("169.254.")) score -= 50;
  return score;
}

/**
 * Lista candidatos IPv4 privados a partir de os.networkInterfaces().
 * @param {NodeJS.Dict<os.NetworkInterfaceInfo[]> | null} [ifaces]
 * @returns {{ name: string, address: string, score: number }[]}
 */
function listPrivateIPv4Candidates(ifaces) {
  const nets = ifaces || os.networkInterfaces();
  const out = [];
  for (const [name, list] of Object.entries(nets || {})) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!entry || entry.internal) continue;
      if (entry.family !== "IPv4" && entry.family !== 4) continue;
      const address = String(entry.address || "");
      if (!isPrivateIPv4(address)) continue;
      out.push({ name, address, score: scoreCandidate(name, address) });
    }
  }
  out.sort((a, b) => b.score - a.score || a.address.localeCompare(b.address));
  return out;
}

/**
 * Melhor IPv4 privado do host, ou null.
 * @param {NodeJS.Dict<os.NetworkInterfaceInfo[]> | null} [ifaces]
 * @returns {string | null}
 */
function detectLanIPv4(ifaces) {
  const candidates = listPrivateIPv4Candidates(ifaces);
  if (!candidates.length) return null;
  return candidates[0].address;
}

/**
 * Resolve se o acesso LAN do salão está habilitado.
 * Env AGENT_LAN_ENABLED sobrescreve; senão `lanStaffAccess: false` desliga;
 * default: ligado somente com agente ativado.
 *
 * @param {{ ativado?: boolean, lanStaffAccess?: boolean } | null} cfg
 * @param {NodeJS.ProcessEnv} [env]
 */
function isLanStaffAccessEnabled(cfg, env = process.env) {
  const raw = env.AGENT_LAN_ENABLED;
  if (raw != null && String(raw).trim() !== "") {
    return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
  }
  if (!cfg || !cfg.ativado) return false;
  if (cfg.lanStaffAccess === false) return false;
  return true;
}

/**
 * Host de bind HTTP: AGENT_BIND_HOST explícito, senão 0.0.0.0 com LAN on.
 *
 * @param {{ ativado?: boolean, lanStaffAccess?: boolean } | null} cfg
 * @param {NodeJS.ProcessEnv} [env]
 */
function resolveBindHost(cfg, env = process.env) {
  if (env.AGENT_BIND_HOST && String(env.AGENT_BIND_HOST).trim()) {
    return String(env.AGENT_BIND_HOST).trim();
  }
  return isLanStaffAccessEnabled(cfg, env) ? "0.0.0.0" : "127.0.0.1";
}

/**
 * Base URL para QR operacional (nunca localhost se houver LAN).
 *
 * @param {{ port: number, lanIp?: string | null, preferLan?: boolean }} opts
 */
function buildLanPublicBase({ port, lanIp, preferLan = true }) {
  const p = Number(port) || 9100;
  if (preferLan && lanIp && isPrivateIPv4(lanIp)) {
    return `http://${lanIp}:${p}`;
  }
  return `http://127.0.0.1:${p}`;
}

module.exports = {
  isPrivateIPv4,
  isLoopbackIPv4,
  listPrivateIPv4Candidates,
  detectLanIPv4,
  isLanStaffAccessEnabled,
  resolveBindHost,
  buildLanPublicBase,
};

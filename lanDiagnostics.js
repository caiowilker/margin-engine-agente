/**
 * Autodiagnóstico LAN do agente (bind real + reachability + firewall Windows).
 * Usado por GET /lan/info e pelo painel do QR Garçom.
 */
const net = require("net");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { isLoopbackBindHost, isPrivateIPv4 } = require("./lanNetwork");

const execFileAsync = promisify(execFile);

const FIREWALL_RULE_PREFIX = "PDV Agente";
const LEGACY_FIREWALL_RULE = "Margin Engine Agente";

/**
 * Endereço real em que o HTTP está escutando (após listen).
 * @param {import("http").Server | null} server
 * @returns {{ address: string, port: number, family?: string } | null}
 */
function getListeningAddress(server) {
  if (!server || typeof server.address !== "function") return null;
  const addr = server.address();
  if (!addr || typeof addr === "string") return null;
  return {
    address: String(addr.address || ""),
    port: Number(addr.port) || 0,
    family: addr.family ? String(addr.family) : undefined,
  };
}

/**
 * @param {string} host
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
function probeTcp(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, family: 4 }, () => {
      sock.destroy();
      resolve(true);
    });
    const fail = () => {
      try {
        sock.destroy();
      } catch (_) {}
      resolve(false);
    };
    sock.on("error", fail);
    sock.setTimeout(timeoutMs, fail);
  });
}

/**
 * Garante regra de entrada TCP na porta do agente (Windows).
 * Usa PowerShell New-NetFirewallRule com -Profile Any (rede Wi‑Fi "Pública").
 *
 * @param {number} port
 * @returns {Promise<{ ok: boolean, skipped?: boolean, ruleName?: string, detail?: string }>}
 */
async function ensureWindowsFirewallRule(port) {
  if (process.platform !== "win32") {
    return { ok: true, skipped: true, detail: "não-Windows" };
  }
  const p = Number(port) || 9100;
  const ruleName = `${FIREWALL_RULE_PREFIX} ${p}`;
  const ps = `
$ErrorActionPreference = 'Stop'
$port = ${p}
$ruleName = '${ruleName.replace(/'/g, "''")}'
$legacy = '${LEGACY_FIREWALL_RULE.replace(/'/g, "''")}'
Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Any -ErrorAction Stop | Out-Null
$leg = Get-NetFirewallRule -DisplayName $legacy -ErrorAction SilentlyContinue
if ($leg) {
  Set-NetFirewallRule -DisplayName $legacy -Direction Inbound -Action Allow -Enabled True -Profile Any -ErrorAction SilentlyContinue
}
$ok = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($ok -and $ok.Enabled -eq 'True') { Write-Output 'OK' } else { Write-Output 'FAIL' }
`.trim();

  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
      { timeout: 15000, windowsHide: true },
    );
    const out = String(stdout || "").trim();
    if (out.includes("OK")) {
      return { ok: true, ruleName, detail: "regra inbound TCP Profile Any" };
    }
    return { ok: false, ruleName, detail: out || "PowerShell não confirmou a regra" };
  } catch (err) {
    try {
      await execFileAsync(
        "netsh",
        ["advfirewall", "firewall", "delete", "rule", `name=${ruleName}`],
        { timeout: 8000, windowsHide: true },
      ).catch(() => {});
      await execFileAsync(
        "netsh",
        [
          "advfirewall",
          "firewall",
          "add",
          "rule",
          `name=${ruleName}`,
          "dir=in",
          "action=allow",
          "protocol=TCP",
          `localport=${p}`,
          "profile=any",
        ],
        { timeout: 8000, windowsHide: true },
      );
      return {
        ok: true,
        ruleName,
        detail: "regra via netsh profile=any (fallback)",
      };
    } catch (err2) {
      return {
        ok: false,
        ruleName,
        detail:
          (err2 && err2.message) ||
          (err && err.message) ||
          "falha ao criar regra de firewall (execute o instalador como admin)",
      };
    }
  }
}

/**
 * Verifica se existe regra Allow inbound na porta (Windows).
 * @param {number} port
 */
async function checkWindowsFirewallRule(port) {
  if (process.platform !== "win32") {
    return { ok: true, skipped: true, detail: "não-Windows" };
  }
  const p = Number(port) || 9100;
  const ruleName = `${FIREWALL_RULE_PREFIX} ${p}`;
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$names = @('${ruleName.replace(/'/g, "''")}', '${LEGACY_FIREWALL_RULE.replace(/'/g, "''")}')
foreach ($n in $names) {
  $r = Get-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue |
    Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' } |
    Select-Object -First 1
  if ($r) {
    Write-Output ("OK|" + $n + "|" + $r.Profile.ToString())
    exit 0
  }
}
Write-Output 'MISSING'
`.trim();

  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
      { timeout: 12000, windowsHide: true },
    );
    const out = String(stdout || "").trim();
    if (out.startsWith("OK|")) {
      const parts = out.split("|");
      return {
        ok: true,
        ruleName: parts[1] || ruleName,
        profile: parts[2] || null,
        detail: `regra "${parts[1]}" (perfil ${parts[2] || "?"})`,
      };
    }
    return {
      ok: false,
      ruleName,
      detail: "nenhuma regra inbound Allow encontrada para a porta",
    };
  } catch (err) {
    return {
      ok: null,
      ruleName,
      detail: err.message || "não foi possível consultar o firewall",
    };
  }
}

/**
 * Monta o bloco de diagnóstico para /lan/info.
 *
 * @param {{
 *   server: import("http").Server | null,
 *   configuredBindHost: string,
 *   lanIp: string | null,
 *   port: number,
 *   lanStaffAccess: boolean,
 *   ensureFirewall?: boolean,
 * }} opts
 */
async function buildLanDiagnostics(opts) {
  const port = Number(opts.port) || 9100;
  const listening = getListeningAddress(opts.server);
  const listenAddr = listening?.address || opts.configuredBindHost || "?";
  const bindIsAllInterfaces =
    listenAddr === "0.0.0.0" || listenAddr === "::" || listenAddr === "*";
  const bindIsLoopback = isLoopbackBindHost(listenAddr);

  let bindOk = bindIsAllInterfaces || (isPrivateIPv4(listenAddr) && !bindIsLoopback);
  // Se ainda não temos address() (antes do listen), usar configurado
  if (!listening) {
    bindOk =
      opts.configuredBindHost === "0.0.0.0" ||
      opts.configuredBindHost === "::" ||
      (isPrivateIPv4(opts.configuredBindHost) &&
        !isLoopbackBindHost(opts.configuredBindHost));
  }

  const bindMessage = bindOk
    ? `Servidor ouvindo em ${listenAddr}:${port}`
    : `Servidor ouvindo apenas em ${listenAddr}:${port} — celular na LAN não conecta (corrigir bind para 0.0.0.0)`;

  const [loopbackOk, lanIpOk] = await Promise.all([
    probeTcp("127.0.0.1", port),
    opts.lanIp ? probeTcp(opts.lanIp, port) : Promise.resolve(null),
  ]);

  // Reachability via IP LAN no próprio PC: se falhar com loopback OK → bind errado
  let reachabilityOk = null;
  let reachabilityMessage = null;
  if (opts.lanIp) {
    if (lanIpOk) {
      reachabilityOk = true;
      reachabilityMessage = `PC alcança http://${opts.lanIp}:${port} (bind OK neste host)`;
    } else if (loopbackOk) {
      reachabilityOk = false;
      reachabilityMessage = `localhost responde, mas ${opts.lanIp}:${port} recusou — bind em loopback`;
      bindOk = false;
    } else {
      reachabilityOk = false;
      reachabilityMessage = `Porta ${port} não responde nem em localhost`;
    }
  }

  let firewall = { ok: null, skipped: true, detail: "não verificado" };
  if (process.platform === "win32" && opts.lanStaffAccess) {
    if (opts.ensureFirewall) {
      const ensured = await ensureWindowsFirewallRule(port);
      firewall = {
        ok: ensured.ok,
        skipped: !!ensured.skipped,
        ruleName: ensured.ruleName,
        detail: ensured.detail,
      };
    } else {
      const checked = await checkWindowsFirewallRule(port);
      firewall = {
        ok: checked.ok,
        skipped: !!checked.skipped,
        ruleName: checked.ruleName,
        profile: checked.profile,
        detail: checked.detail,
      };
    }
  } else if (process.platform !== "win32") {
    firewall = { ok: true, skipped: true, detail: "firewall Windows N/A" };
  }

  const firewallOk = firewall.ok === true || firewall.skipped === true;
  const firewallMessage =
    firewall.ok === true
      ? `Porta ${port} liberada no firewall${firewall.ruleName ? ` (${firewall.ruleName})` : ""}`
      : firewall.ok === false
        ? `Porta ${port} bloqueada ou sem regra inbound — rode o instalador/reparo como admin`
        : firewall.detail || `Firewall: ${firewall.detail}`;

  return {
    bindOk,
    bindHostConfigured: opts.configuredBindHost,
    bindHostListening: listenAddr,
    bindMessage,
    reachabilityOk,
    reachabilityMessage,
    loopbackOk,
    lanIpReachable: lanIpOk,
    firewallOk: firewall.ok,
    firewallSkipped: !!firewall.skipped,
    firewallMessage,
    firewallRule: firewall.ruleName || null,
    firewallProfile: firewall.profile || null,
    readyForPhone: !!(bindOk && (firewall.ok !== false) && (reachabilityOk !== false)),
  };
}

module.exports = {
  FIREWALL_RULE_PREFIX,
  LEGACY_FIREWALL_RULE,
  getListeningAddress,
  probeTcp,
  ensureWindowsFirewallRule,
  checkWindowsFirewallRule,
  buildLanDiagnostics,
};

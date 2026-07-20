#!/usr/bin/env node
/**
 * Cria atalhos do Margin Engine (menu Iniciar + área de trabalho opcional).
 * Sempre aponta para scripts/open-pdv.cmd → http://localhost:9100/
 *
 * Não use TargetPath=http://… em .lnk: no Windows isso frequentemente resolve
 * para o IP da LAN (ex.: 192.168.x.101) e falha — o agente escuta só 127.0.0.1.
 *
 * Uso: node scripts/installer-shortcuts.js [--desktop]
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const PANEL_URL = "http://localhost:9100/";
const SHORTCUT_NAME = "Margin Engine";

function resolvePaths() {
  const appDir = path.resolve(__dirname, "..");
  const launcher = path.join(__dirname, "open-pdv.cmd");
  const iconCandidates = [
    path.join(appDir, "assets", "margin-engine.ico"),
    path.join(appDir, "..", "app", "assets", "margin-engine.ico"),
  ];
  const iconPath = iconCandidates.find((p) => fs.existsSync(p)) || "";
  return { appDir, launcher, iconPath };
}

function psEscapeSingle(s) {
  return String(s).replace(/'/g, "''");
}

function runPowerShell(script) {
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { stdio: "pipe" },
  );
}

function createShortcutScript(folderPsExpr, { launcher, appDir, iconPath }) {
  const target = psEscapeSingle(launcher);
  const workDir = psEscapeSingle(appDir);
  const icon = psEscapeSingle(iconPath);
  const iconLine = icon
    ? `$s.IconLocation = '${icon}';`
    : `$s.IconLocation = 'shell32.dll,13';`;
  return `
$ErrorActionPreference = 'Stop';
$shell = New-Object -ComObject WScript.Shell;
$folder = ${folderPsExpr};
if (-not $folder) { exit 0 };
$lnk = Join-Path $folder '${SHORTCUT_NAME}.lnk';
$urlLegacy = Join-Path $folder '${SHORTCUT_NAME}.url';
if (Test-Path $urlLegacy) { Remove-Item -Force $urlLegacy -ErrorAction SilentlyContinue };
$s = $shell.CreateShortcut($lnk);
$s.TargetPath = '${target}';
$s.WorkingDirectory = '${workDir}';
$s.WindowStyle = 7;
${iconLine}
$s.Description = 'Abrir Margin Engine em ${PANEL_URL}';
$s.Save();
`.trim();
}

function criarAtalhos(opts = {}) {
  const withDesktop = opts.desktop === true || process.argv.includes("--desktop");
  if (process.platform !== "win32") {
    return { ok: false, skipped: true, reason: "not_win32" };
  }
  const paths = resolvePaths();
  if (!fs.existsSync(paths.launcher)) {
    return { ok: false, reason: "launcher_missing", launcher: paths.launcher };
  }

  runPowerShell(createShortcutScript("$shell.SpecialFolders('Programs')", paths));
  if (withDesktop) {
    runPowerShell(createShortcutScript("$shell.SpecialFolders('Desktop')", paths));
    runPowerShell(
      createShortcutScript("[Environment]::GetFolderPath('CommonDesktopDirectory')", paths),
    );
  }
  return { ok: true, url: PANEL_URL, desktop: withDesktop };
}

function main() {
  try {
    const r = criarAtalhos();
    if (r.skipped) process.exit(0);
    if (!r.ok) {
      console.warn("[installer] Atalhos:", r.reason, r.launcher || "");
      process.exit(0);
    }
    console.log(`[installer] Atalhos criados → ${PANEL_URL}`);
  } catch (err) {
    console.warn("[installer] Atalhos:", err.message);
    process.exit(0);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  PANEL_URL,
  SHORTCUT_NAME,
  criarAtalhos,
  resolvePaths,
  createShortcutScript,
};

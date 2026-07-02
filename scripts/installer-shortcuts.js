#!/usr/bin/env node
/**
 * Cria atalhos do Margin Engine (menu Iniciar + área de trabalho opcional).
 * Uso: node scripts/installer-shortcuts.js [--desktop]
 */
const { execSync } = require("child_process");

const withDesktop = process.argv.includes("--desktop");
const url = "http://localhost:9100/";
const name = "Margin Engine";

if (process.platform !== "win32") {
  process.exit(0);
}

function ps(script) {
  execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${script.replace(/"/g, '\\"')}"`, {
    stdio: "pipe",
  });
}

try {
  const startMenu =
    "$shell = New-Object -ComObject WScript.Shell; " +
    `$sm = $shell.SpecialFolders('Programs'); ` +
    `$lnk = Join-Path $sm '${name}.lnk'; ` +
    `$s = $shell.CreateShortcut($lnk); ` +
    `$s.TargetPath = '${url}'; ` +
    `$s.IconLocation = 'shell32.dll,13'; ` +
    `$s.Description = 'Abrir o Margin Engine neste computador'; ` +
    `$s.Save()`;
  ps(startMenu);

  if (withDesktop) {
    const desktop =
      "$shell = New-Object -ComObject WScript.Shell; " +
      `$desk = $shell.SpecialFolders('Desktop'); ` +
      `$lnk = Join-Path $desk '${name}.lnk'; ` +
      `$s = $shell.CreateShortcut($lnk); ` +
      `$s.TargetPath = '${url}'; ` +
      `$s.IconLocation = 'shell32.dll,13'; ` +
      `$s.Save()`;
    ps(desktop);
  }
  console.log("[installer] Atalhos criados");
} catch (err) {
  console.warn("[installer] Atalhos:", err.message);
  process.exit(0);
}

#!/usr/bin/env node
/**
 * Bootstrap do instalador Margin Engine (Inno Setup).
 * Instalar | Reparar | Atualizar — mesma base de scripts.
 *
 * Uso:
 *   node scripts/installer-bootstrap.js <appDir> --mode=install|repair|update [--service] [--firewall] [--open] [--desktop]
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const appDir = path.resolve(process.argv[2] || path.join(__dirname, ".."));
const args = process.argv.slice(3);
const mode = (args.find((a) => a.startsWith("--mode=")) || "--mode=install").split("=")[1];
const withService = args.includes("--service");
const withFirewall = args.includes("--firewall") || mode === "install" || mode === "update";
const withOpen = args.includes("--open");
const withDesktop = args.includes("--desktop");
const npmFromArg = args.find((a) => a.startsWith("--npm="));
if (npmFromArg) {
  process.env.MARGIN_NPM = npmFromArg.slice("--npm=".length);
}

process.chdir(appDir);
process.env.MARGIN_ENGINE_AGENT_ROOT = appDir;
process.env.NODE_ENV = "production";
process.env.LOG_MODE = "PRODUCTION";
process.env.LOG_PATCH_CONSOLE = "false";

const { initLogging } = require(path.join(appDir, "runtime", "loggingService"));
const log = initLogging({ patchConsole: false }).createLogger({
  modulo: "install_bootstrap",
  channel: "installer",
});

function run(cmd, opts = {}) {
  log.info({ acao: "exec", comando: cmd }, "Executando comando");
  try {
    execSync(cmd, {
      cwd: appDir,
      stdio: opts.inherit ? "inherit" : "pipe",
      encoding: "utf8",
      ...opts,
    });
  } catch (err) {
    const detail = String(err.stderr || err.stdout || err.message || err);
    throw new Error(`Comando falhou: ${cmd}\n${detail.slice(0, 2000)}`);
  }
}

function writeBootstrapFailure(err) {
  const text = [
    new Date().toISOString(),
    "Margin Engine — falha no bootstrap do instalador",
    "",
    String(err?.stack || err?.message || err),
  ].join("\n");
  const targets = [];
  try {
    const { getDirectoryManager } = require(path.join(appDir, "runtime", "directoryManager"));
    const dm = getDirectoryManager();
    dm.ensureAll();
    targets.push(path.join(dm.PATHS.diagnostics, "install-bootstrap-error.txt"));
  } catch {
    /* ignore */
  }
  targets.push(path.join(os.tmpdir(), "margin-install-bootstrap-error.txt"));
  for (const fp of targets) {
    try {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, text, "utf8");
      break;
    } catch {
      /* try next */
    }
  }
}

function nativeDepsReady() {
  const base = path.join(appDir, "node_modules");
  if (!fs.existsSync(base)) return false;
  const required = ["better-sqlite3", "node-windows", "express"];
  for (const name of required) {
    if (!fs.existsSync(path.join(base, name, "package.json"))) return false;
  }
  const sqliteBinding = path.join(base, "better-sqlite3", "build", "Release", "better_sqlite3.node");
  return fs.existsSync(sqliteBinding);
}

function writeDefaultConfigs() {
  if (mode === "update") {
    log.info({ acao: "skip_default_config" }, "Atualização — configurações existentes preservadas");
    return;
  }

  const envPath = path.join(appDir, ".env");
  if (mode === "repair" && fs.existsSync(envPath)) {
    log.info({ acao: "skip_default_config" }, "Reparo — .env existente preservado");
    return;
  }

  const tmp = path.join(require("os").tmpdir(), `margin-install-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });

  const fiscalJson = path.join(tmp, "fiscal-install.json");
  const printJson = path.join(tmp, "print-install.json");

  const fiscal = {
    emissaoFiscal: false,
    driver: "lib",
    libPath: path.join(appDir, "acbrlib", "lib", "ACBrNFe64.dll"),
    libIni: path.join(appDir, "acbrlib", "data", "config", "acbrlib.ini"),
  };

  const printCfg = {
    provider: "acbr-posprinter",
    fallback: "native",
    autoDetect: true,
    porta: "",
    modelo: "0",
    encoding: "UTF8",
    cut: "partial",
    nomeImpressora: "",
    libPath: path.join(appDir, "posprinter", "lib", "ACBrPosPrinter64.dll"),
    iniPath: path.join(appDir, "data", "posprinter.ini"),
    testarImpressao: false,
  };

  fs.writeFileSync(fiscalJson, JSON.stringify(fiscal), "utf8");
  fs.writeFileSync(printJson, JSON.stringify(printCfg), "utf8");

  run(`node "${path.join(appDir, "scripts", "installer-apply-fiscal-config.js")}" "${appDir}" "${fiscalJson}"`);
  run(`node "${path.join(appDir, "scripts", "installer-apply-print-config.js")}" "${appDir}" "${printJson}"`);

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function ensureDirectories() {
  const { getDirectoryManager } = require(path.join(appDir, "runtime", "directoryManager"));
  const dm = getDirectoryManager();
  dm.ensureAll();
  log.info({ acao: "ensure_dirs", root: dm.ROOT }, "Diretórios Margin Engine preparados");
  return dm;
}

function ensureEnv() {
  const envPath = path.join(appDir, ".env");
  const example = path.join(appDir, ".env.example");
  if (!fs.existsSync(envPath) && fs.existsSync(example)) {
    fs.copyFileSync(example, envPath);
    log.info({ acao: "create_env" }, "Arquivo de configuração inicial criado");
  }
}

function ensureWindowsPermissions(dm) {
  if (process.platform !== "win32") return;
  const root = dm.ROOT;
  try {
    run(`icacls "${root}" /grant *S-1-5-32-545:(OI)(CI)M /T /C`, { stdio: "pipe" });
    log.info({ acao: "permissions", diretorio: root }, "Permissões aplicadas");
  } catch (err) {
    log.warn({ err: err.message }, "Não foi possível ajustar todas as permissões");
  }
}

function ensureFirewall() {
  if (process.platform !== "win32" || !withFirewall) return;
  const port = process.env.AGENT_PORT || process.env.PORT || "9100";
  const ruleName = "Margin Engine Agente";
  try {
    run(
      `netsh advfirewall firewall add rule name="${ruleName}" dir=in action=allow protocol=TCP localport=${port}`,
      { stdio: "pipe" },
    );
    log.info({ acao: "firewall", porta: port }, "Regra de firewall registrada");
  } catch {
    log.warn({ porta: port }, "Firewall não configurado (pode já existir ou política bloqueou)");
  }
}

function validateDependencies() {
  const nodeMajor = parseInt(process.version.split(".")[0].replace("v", ""), 10);
  if (nodeMajor < 18) {
    throw new Error(`Node.js ${process.version} incompatível (mínimo 18)`);
  }
  const pkg = path.join(appDir, "package.json");
  if (!fs.existsSync(pkg)) {
    throw new Error("package.json ausente — instalação corrompida");
  }
}

function npmInstallIfNeeded() {
  if (mode === "repair") return;
  if (nativeDepsReady()) {
    log.info({ acao: "skip_npm_ci" }, "Dependências nativas já empacotadas no instalador");
    return;
  }
  const npm = process.env.MARGIN_NPM || "npm";
  log.info({ acao: "npm_ci" }, "Instalando dependências (primeira execução ou pacote sem node_modules)");
  run(`"${npm}" ci --omit=dev`, { inherit: true });
  run(`"${npm}" rebuild better-sqlite3`, { inherit: true });
}

function stopAgentService() {
  try {
    const ctl = require(path.join(appDir, "scripts", "installer-service-control"));
    const r = ctl.stopService();
    if (!r.ok && !r.skipped) {
      throw new Error(r.error || `Serviço não parou (estado: ${r.state})`);
    }
    log.info({ acao: "service_stop", ...r }, "Serviço Margin Engine parado para manutenção");
    return r;
  } catch (err) {
    if (process.platform !== "win32") return { ok: true, skipped: true };
    log.error({ err: err.message }, "Não foi possível parar o serviço");
    return { ok: false, error: err.message };
  }
}

function backupPreUpdate() {
  if (mode !== "update") return null;
  const manifestPath = path.join(appDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  const backupDir = path.join(appDir, "data", "backup-pre-installer");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(backupDir, `manifest-${stamp}.json`);
  fs.copyFileSync(manifestPath, dest);
  log.info({ acao: "backup_manifest", dest }, "Backup do manifest antes da atualização");
  return dest;
}

function npmRepairSteps() {
  if (nativeDepsReady()) {
    log.info({ acao: "skip_npm_repair" }, "node_modules presente — reparo sem npm ci");
    return;
  }
  const npm = process.env.MARGIN_NPM || "npm";
  run(`"${npm}" ci --omit=dev`, { inherit: true });
  run(`"${npm}" rebuild better-sqlite3`, { inherit: true });
}

function validatePostUpdate() {
  const manifestPath = path.join(appDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error("manifest.json ausente após atualização");
  }
  try {
    const { verificarManifestBoot } = require(path.join(appDir, "manifestUpdater"));
    if (typeof verificarManifestBoot === "function") {
      const ok = verificarManifestBoot();
      if (ok === false) throw new Error("Integridade do manifest falhou");
    }
  } catch (err) {
    log.warn({ err: err.message }, "Verificação de manifest reportou aviso");
  }
  return true;
}

function generateManifest() {
  const npm = process.env.MARGIN_NPM || "npm";
  run(`"${npm}" run manifest`, { inherit: true });
}

function startAgentService() {
  if (!withService) return { ok: true, skipped: true };
  try {
    const ctl = require(path.join(appDir, "scripts", "installer-service-control"));
    const r = ctl.startService();
    if (!r.ok && !r.skipped) {
      throw new Error(r.error || `Serviço não iniciou (estado: ${r.state})`);
    }
    log.info({ acao: "service_start", ...r }, "Serviço Margin Engine reiniciado");
    return r;
  } catch (err) {
    if (process.platform !== "win32") return { ok: true, skipped: true };
    log.warn({ err: err.message }, "Não foi possível reiniciar o serviço automaticamente");
    return { ok: false, error: err.message };
  }
}

function runPredeploy() {
  try {
    const npm = process.env.MARGIN_NPM || "npm";
    run(`"${npm}" run predeploy`, { inherit: true });
  } catch (err) {
    log.warn({ err: err.message }, "Pré-deploy reportou avisos");
  }
}

function registerService() {
  if (!withService) return;
  run(`node "${path.join(appDir, "install-service.js")}" --no-open`, { inherit: true });
}

function waitForOnline() {
  if (!withService) return { ok: false, skipped: true };
  try {
    run(`node "${path.join(appDir, "scripts", "installer-wait-online.js")}" "${appDir}"`, {
      inherit: true,
    });
    return { ok: true };
  } catch {
    log.warn({ acao: "wait_online" }, "Agente ainda não respondeu — verifique o serviço Windows");
    return { ok: false };
  }
}

function createShortcuts() {
  if (process.platform !== "win32") return;
  const flags = withDesktop ? " --desktop" : "";
  try {
    run(`node "${path.join(appDir, "scripts", "installer-shortcuts.js")}"${flags}`, { inherit: true });
  } catch (err) {
    log.warn({ err: err.message }, "Não foi possível criar todos os atalhos");
  }
}

function openPanel() {
  if (!withOpen || process.platform !== "win32") return;
  const port = process.env.AGENT_PORT || process.env.PORT || "9100";
  try {
    run(`cmd /c start http://127.0.0.1:${port}/`, { stdio: "pipe" });
    log.info({ acao: "open_panel", url: `http://127.0.0.1:${port}/` }, "Painel aberto no navegador");
  } catch (err) {
    log.warn({ err: err.message }, "Não foi possível abrir o navegador automaticamente");
  }
}

async function runDiagnostic() {
  const { runDiagnostic: diag, writeReports } = require(path.join(appDir, "scripts", "installer-diagnostic"));
  let dmRoot = null;
  try {
    const { getDirectoryManager } = require(path.join(appDir, "runtime", "directoryManager"));
    dmRoot = getDirectoryManager().ROOT;
  } catch {
    /* ignore */
  }
  const report = await diag();
  writeReports(report, dmRoot);
  return report;
}

async function main() {
  log.info({ acao: "bootstrap_start", modo: mode }, "Margin Engine — bootstrap do instalador");

  const needsServiceCycle = withService && (mode === "update" || mode === "repair");
  if (needsServiceCycle) {
    const stop = stopAgentService();
    if (!stop.ok && !stop.skipped) {
      throw new Error(
        stop.error ||
          "Não foi possível parar o serviço Margin Engine. Encerre manualmente e execute novamente.",
      );
    }
    if (mode === "update") backupPreUpdate();
  }

  validateDependencies();
  const dm = ensureDirectories();
  ensureEnv();
  ensureWindowsPermissions(dm);

  if (mode === "install" || mode === "update") {
    writeDefaultConfigs();
    npmInstallIfNeeded();
    generateManifest();
    runPredeploy();
    ensureFirewall();
    if (mode === "update") validatePostUpdate();
  }

  if (mode === "repair") {
    writeDefaultConfigs();
    npmRepairSteps();
    generateManifest();
    ensureFirewall();
  }

  registerService();
  if (needsServiceCycle) {
    startAgentService();
  }
  const online = waitForOnline();
  createShortcuts();
  if (online.ok) {
    openPanel();
  }

  const report = await runDiagnostic();
  log.info(
    {
      acao: "bootstrap_done",
      modo: mode,
      ok: report.ok,
      issues: report.issues.length,
      agentOnline: online.ok,
    },
    "Bootstrap concluído",
  );

  process.exit(report.ok ? 0 : 2);
}

main().catch((err) => {
  writeBootstrapFailure(err);
  try {
    log.fatal({ err, acao: "bootstrap_fail" }, err.message);
  } catch {
    /* logging pode falhar antes de diretórios */
  }
  process.exit(1);
});

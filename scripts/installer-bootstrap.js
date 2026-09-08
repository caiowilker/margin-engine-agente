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
const { execSync, execFileSync } = require("child_process");
const { resolveNpmFromArgs } = require("../runtime/shellUtils");
const {
  packagedInstall,
  shouldSkipNpmCi,
  shouldSkipManifestRegen,
  shouldSkipPredeploy,
  icaclsGrantCommand,
  manifestEntriesPresent,
  INSTALL_WAIT_ONLINE_MS,
  INSTALL_WAIT_RETRY_MS,
  INSTALL_BOOTSTRAP_MAX_MS,
  remainingBootstrapBudgetMs,
  clampWaitMs,
  createBootstrapTiming,
} = require("./installerSpeed");

const appDir = path.resolve(process.argv[2] || path.join(__dirname, ".."));
const args = process.argv.slice(3);
const mode = (args.find((a) => a.startsWith("--mode=")) || "--mode=install").split("=")[1];
const withService = args.includes("--service");
const withFirewall = args.includes("--firewall") || mode === "install" || mode === "update";
const withOpen = args.includes("--open");
const withDesktop = args.includes("--desktop");
// resolveNpmFromArgs reconstrói o path mesmo quando passado sem aspas pelo Inno Setup
// (ex: --npm=C:\Program + Files\nodejs\npm.cmd → "C:\Program Files\nodejs\npm.cmd")
const npmPath = resolveNpmFromArgs(args);
if (npmPath) {
  process.env.MARGIN_NPM = npmPath;
}

process.chdir(appDir);
process.env.MARGIN_ENGINE_AGENT_ROOT = appDir;
process.env.NODE_ENV = "production";
process.env.LOG_MODE = "PRODUCTION";
process.env.LOG_PATCH_CONSOLE = "false";

let log = null;

function initBootstrapLog() {
  if (log) return log;
  try {
    const { initLogging } = require(path.join(appDir, "runtime", "loggingService"));
    log = initLogging({ patchConsole: false }).createLogger({
      modulo: "install_bootstrap",
      channel: "installer",
    });
  } catch {
    log = {
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
    };
  }
  return log;
}

function run(cmd, opts = {}) {
  initBootstrapLog().info({ acao: "exec", comando: cmd }, "Executando comando");
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

/**
 * Resolve o executável npm: usa MARGIN_NPM se definido (com path completo), senão
 * usa npm.cmd no Windows ou npm no Unix, ambos resolvidos pelo PATH.
 */
function resolveNpmExe() {
  if (process.env.MARGIN_NPM) return process.env.MARGIN_NPM;
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

/**
 * Executa npm via execFileSync (sem passar pelo shell) — path com espaços funciona
 * corretamente pois o executável é passado como argumento separado ao SO.
 */
function runNpm(npmArgs, opts = {}) {
  const npm = resolveNpmExe();
  initBootstrapLog().info({ acao: "exec_npm", npm, args: npmArgs }, "Executando npm");
  try {
    execFileSync(npm, npmArgs, {
      cwd: appDir,
      stdio: opts.inherit ? "inherit" : "pipe",
      encoding: "utf8",
    });
  } catch (err) {
    const detail = String(err.stderr || err.stdout || err.message || err);
    throw new Error(`npm ${npmArgs.join(" ")} falhou:\n${detail.slice(0, 2000)}`);
  }
}

function clearBootstrapMarkers() {
  const rels = [
    "install-bootstrap-exit.txt",
    "install-bootstrap-error.txt",
    "install-last-report.txt",
  ];
  for (const rel of rels) {
    try {
      fs.unlinkSync(path.join(appDir, "data", rel));
    } catch {
      /* ignore */
    }
  }
  // ProgramData: evita Inno mostrar relatório OK antigo após falha nova.
  try {
    const { getDirectoryManager } = require(path.join(appDir, "runtime", "directoryManager"));
    const diag = getDirectoryManager().PATHS.diagnostics;
    for (const name of [
      "install-bootstrap-exit.txt",
      "install-bootstrap-error.txt",
      "install-last-report.txt",
    ]) {
      try {
        fs.unlinkSync(path.join(diag, name));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

function writeBootstrapFailure(err) {
  const text = [
    new Date().toISOString(),
    "Margin Engine — falha no bootstrap do instalador",
    "",
    String(err?.stack || err?.message || err),
  ].join("\n");
  const targets = [
    path.join(appDir, "data", "install-bootstrap-error.txt"),
    path.join(os.tmpdir(), "margin-install-bootstrap-error.txt"),
  ];
  try {
    const { getDirectoryManager } = require(path.join(appDir, "runtime", "directoryManager"));
    const dm = getDirectoryManager();
    dm.ensureAll();
    targets.unshift(path.join(dm.PATHS.diagnostics, "install-bootstrap-error.txt"));
  } catch {
    /* ignore */
  }
  for (const fp of targets) {
    try {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, text, "utf8");
    } catch {
      /* try next */
    }
  }
}

function writeBootstrapExit(code) {
  const text = String(code);
  const targets = [
    path.join(appDir, "data", "install-bootstrap-exit.txt"),
    path.join(os.tmpdir(), "margin-install-bootstrap-exit.txt"),
  ];
  try {
    const { getDirectoryManager } = require(path.join(appDir, "runtime", "directoryManager"));
    targets.unshift(path.join(getDirectoryManager().PATHS.diagnostics, "install-bootstrap-exit.txt"));
  } catch {
    /* ignore */
  }
  for (const fp of targets) {
    try {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, text, "utf8");
    } catch {
      /* try next */
    }
  }
}

function getServiceCtl() {
  return require(path.join(appDir, "scripts", "installer-service-control"));
}

function tryStartService(waitMs) {
  try {
    return getServiceCtl().startService({ waitMs });
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Garante koffi mesmo quando o restante do node_modules já veio no .exe antigo. */
function ensureKoffi() {
  const koffiPkg = path.join(appDir, "node_modules", "koffi", "package.json");
  const winNode = path.join(appDir, "node_modules", "koffi", "build", "koffi", "win32_x64", "koffi.node");
  const ok =
    fs.existsSync(koffiPkg) &&
    (process.platform !== "win32" || fs.existsSync(winNode));
  if (ok) {
    initBootstrapLog().info({ acao: "koffi_ok" }, "koffi presente");
    return;
  }
  initBootstrapLog().info(
    { acao: "npm_install_koffi" },
    "koffi ausente — instalando (necessário para impressão térmica ACBr)",
  );
  runNpm(["install", "koffi@^2.9.0", "--omit=dev", "--no-fund", "--no-audit"], {
    inherit: true,
  });
  if (!fs.existsSync(koffiPkg)) {
    throw new Error(
      "koffi não foi instalado — impressão térmica ACBr ficará incompleta (ME-011b). Verifique rede/npm e reinstale.",
    );
  }
  if (process.platform === "win32" && !fs.existsSync(winNode)) {
    throw new Error(
      "koffi instalado sem prebuild win32_x64 — reinstale o pacote koffi no Windows (npm install koffi).",
    );
  }
}

function nativeDepsReady() {
  const base = path.join(appDir, "node_modules");
  if (!fs.existsSync(base)) return false;
  // koffi = FFI ACBr PosPrinter (prebuild Windows). Sem ele → ME-011b e cupom lento.
  const required = ["better-sqlite3", "node-windows", "express", "koffi"];
  for (const name of required) {
    if (!fs.existsSync(path.join(base, name, "package.json"))) return false;
  }
  const sqliteBinding = path.join(base, "better-sqlite3", "build", "Release", "better_sqlite3.node");
  if (!fs.existsSync(sqliteBinding)) return false;
  if (process.platform === "win32") {
    const winNode = path.join(base, "koffi", "build", "koffi", "win32_x64", "koffi.node");
    if (!fs.existsSync(winNode)) return false;
  }
  return true;
}

function writeDefaultConfigs() {
  if (mode === "update") {
    initBootstrapLog().info({ acao: "skip_default_config" }, "Atualização — configurações existentes preservadas");
    return;
  }

  const envPath = path.join(appDir, ".env");
  if (mode === "repair" && fs.existsSync(envPath)) {
    initBootstrapLog().info({ acao: "skip_default_config" }, "Reparo — .env existente preservado");
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
    // ProgramData: sobrevive a update/reparo (install dir em Win10 era apagado → impressora “sumia”).
    iniPath: (() => {
      try {
        const { getDirectoryManager } = require(path.join(appDir, "runtime", "directoryManager"));
        const dm = getDirectoryManager();
        dm.ensurePath(dm.PATHS.config, "config");
        return path.join(dm.PATHS.config, "posprinter.ini");
      } catch (_) {
        return path.join(appDir, "data", "posprinter.ini");
      }
    })(),
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
  initBootstrapLog().info({ acao: "ensure_dirs", root: dm.ROOT }, "Diretórios Margin Engine preparados");
  return dm;
}

function ensureEnv() {
  const envPath = path.join(appDir, ".env");
  const example = path.join(appDir, ".env.example");
  if (!fs.existsSync(envPath) && fs.existsSync(example)) {
    fs.copyFileSync(example, envPath);
    initBootstrapLog().info({ acao: "create_env" }, "Arquivo de configuração inicial criado");
  }
}

function ensureWindowsPermissions(dm) {
  if (process.platform !== "win32") return;
  const root = dm.ROOT;
  try {
    run(icaclsGrantCommand(root, { recurse: mode === "repair" }), { stdio: "pipe" });
    initBootstrapLog().info(
      { acao: "permissions", diretorio: root, recurse: mode === "repair" },
      "Permissões aplicadas",
    );
  } catch (err) {
    initBootstrapLog().warn({ err: err.message }, "Não foi possível ajustar todas as permissões");
  }
}

function ensureFirewall() {
  if (process.platform !== "win32" || !withFirewall) return;
  const port = process.env.AGENT_PORT || process.env.PORT || "9100";
  const ruleName = `PDV Agente ${port}`;
  // Já existe → skip (update rápido).
  try {
    const shown = execSync(`netsh advfirewall firewall show rule name="${ruleName}"`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (/Enabled:|Ativada:|Habilitada:/i.test(shown) || /Direction:|Direção:/i.test(shown)) {
      initBootstrapLog().info(
        { acao: "firewall_skip", porta: port, ruleName },
        "Regra de firewall já presente",
      );
      return { ok: true, skipped: true };
    }
  } catch {
    /* cria abaixo */
  }
  try {
    try {
      run(`netsh advfirewall firewall delete rule name="${ruleName}"`, { stdio: "pipe" });
    } catch (_) {}
    run(
      `netsh advfirewall firewall add rule name="${ruleName}" dir=in action=allow protocol=TCP localport=${port} profile=any`,
      { stdio: "pipe" },
    );
    initBootstrapLog().info(
      { acao: "firewall", porta: port, via: "netsh", profile: "Any" },
      "Regra de firewall registrada via netsh",
    );
    return { ok: true };
  } catch {
    /* fallback PowerShell */
  }
  try {
    const ps = `
$ErrorActionPreference = 'Stop'
$port = ${Number(port) || 9100}
$ruleName = '${ruleName.replace(/'/g, "''")}'
Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Any | Out-Null
`.trim();
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
      { stdio: "pipe", windowsHide: true },
    );
    initBootstrapLog().info(
      { acao: "firewall", porta: port, via: "powershell", profile: "Any" },
      "Regra de firewall registrada (PowerShell)",
    );
    return { ok: true };
  } catch {
    initBootstrapLog().warn(
      { porta: port },
      "Firewall não configurado (pode já existir ou política bloqueou)",
    );
    return { ok: false };
  }
}

/** Migra .env legado: AGENT_BIND_HOST=127.0.0.1 quebrava QR Garçom (IP certo + connection refused). */
function migrateEnvLanBind() {
  const envPath = path.join(appDir, ".env");
  if (!fs.existsSync(envPath)) return;
  let text = fs.readFileSync(envPath, "utf8");
  if (!/^AGENT_BIND_HOST\s*=\s*(127\.0\.0\.1|localhost)\s*$/im.test(text)) return;
  text = text.replace(
    /^AGENT_BIND_HOST\s*=\s*(127\.0\.0\.1|localhost)\s*$/im,
    "# Migrado: loopback impedia celular na LAN (ERR_CONNECTION_REFUSED)\nAGENT_BIND_HOST=0.0.0.0",
  );
  fs.writeFileSync(envPath, text, "utf8");
  initBootstrapLog().info({ acao: "migrate_env_bind" }, "AGENT_BIND_HOST migrado para 0.0.0.0");
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
  if (shouldSkipNpmCi({ mode, nativeReady: nativeDepsReady() })) {
    initBootstrapLog().info({ acao: "skip_npm_ci" }, "Dependências nativas já empacotadas no instalador");
    ensureKoffi();
    require(path.join(appDir, "runtime", "acbrKoffiTopology")).enforceSingleKoffi({ appRoot: appDir });
    return;
  }
  initBootstrapLog().info({ acao: "npm_ci" }, "Instalando dependências (primeira execução ou pacote sem node_modules)");
  runNpm(["ci", "--omit=dev"], { inherit: true });
  runNpm(["rebuild", "better-sqlite3"], { inherit: true });
  ensureKoffi();
  require(path.join(appDir, "runtime", "acbrKoffiTopology")).enforceSingleKoffi({ appRoot: appDir });
}

function stopAgentService() {
  try {
    const ctl = require(path.join(appDir, "scripts", "installer-service-control"));
    const state = typeof ctl.queryState === "function" ? ctl.queryState() : null;
    if (state === "stopped" || state === "missing") {
      initBootstrapLog().info(
        { acao: "service_stop_skip", state },
        "Serviço já parado — skip stop",
      );
      return { ok: true, skipped: true, state };
    }
    let r = ctl.stopService({ force: false, waitMs: 20_000 });
    if (!r.ok && !r.skipped) {
      initBootstrapLog().warn({ acao: "service_stop_force", ...r }, "Parada suave falhou — forçando");
      r = ctl.stopService({ force: true, waitMs: 25_000 });
    }
    if (!r.ok && !r.skipped) {
      throw new Error(r.error || `Serviço não parou (estado: ${r.state})`);
    }
    initBootstrapLog().info({ acao: "service_stop", ...r }, "Serviço Margin Engine parado para manutenção");
    return r;
  } catch (err) {
    if (process.platform !== "win32") return { ok: true, skipped: true };
    initBootstrapLog().error({ err: err.message }, "Não foi possível parar o serviço");
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
  initBootstrapLog().info({ acao: "backup_manifest", dest }, "Backup do manifest antes da atualização");
  return dest;
}

function npmRepairSteps() {
  if (nativeDepsReady()) {
    initBootstrapLog().info({ acao: "skip_npm_repair" }, "node_modules presente — reparo sem npm ci");
    ensureKoffi();
    require(path.join(appDir, "runtime", "acbrKoffiTopology")).enforceSingleKoffi({ appRoot: appDir });
    return;
  }
  runNpm(["ci", "--omit=dev"], { inherit: true });
  runNpm(["rebuild", "better-sqlite3"], { inherit: true });
  ensureKoffi();
  require(path.join(appDir, "runtime", "acbrKoffiTopology")).enforceSingleKoffi({ appRoot: appDir });
}

function validatePostUpdate() {
  const manifestPath = path.join(appDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error("manifest.json ausente após atualização");
  }
  const { verificarManifestBoot } = require(path.join(appDir, "manifestUpdater"));
  if (typeof verificarManifestBoot === "function") {
    const check = verificarManifestBoot();
    if (check && check.ok === false) {
      throw new Error(check.motivo || "Integridade do manifest falhou");
    }
  }
  const frontDist = path.join(appDir, "frontend-dist");
  if (fs.existsSync(path.join(frontDist, "index.html"))) {
    const fi = require(path.join(appDir, "runtime", "frontendIntegrity"));
    const ui = fi.verificarFrontendDist(frontDist, { skipCache: true });
    if (!ui.ok) {
      throw new Error(`frontend-dist inválido após update: ${ui.motivo}`);
    }
  }
  return true;
}

/** XSDs NFe/NFSe → ProgramData. Update com PD já OK → skip. */
function ensureProgramDataSchemas() {
  try {
    const { getDirectoryManager } = require(path.join(appDir, "runtime", "directoryManager"));
    const dm = getDirectoryManager();
    const {
      ensureInstallerSchemas,
      programDataSchemasReady,
    } = require(path.join(appDir, "scripts", "installer-ensure-schemas"));

    if (mode === "update" && programDataSchemasReady(dm.ROOT, { requireNfse: true })) {
      initBootstrapLog().info(
        { acao: "ensure_schemas_skip", reason: "programdata_ready" },
        "Schemas ProgramData já suficientes — skip cópia",
      );
      return { ok: true, skipped: true };
    }

    const r = ensureInstallerSchemas(appDir, dm.ROOT, {
      requireNfse: true,
      onlyIfMissing: mode === "update",
    });
    if (r && r.ok === false) {
      throw new Error(r.error || "schemas fiscais insuficientes no payload");
    }
    initBootstrapLog().info(
      { acao: "ensure_schemas", ...r },
      "Schemas fiscais sincronizados com ProgramData",
    );
    return r;
  } catch (err) {
    throw new Error(`Falha ao sincronizar schemas fiscais: ${err.message}`);
  }
}

function ensureNodeModulesBundle() {
  const {
    ensureNodeModulesFromBundle,
  } = require(path.join(appDir, "scripts", "installer-payload-bundle"));
  const r = ensureNodeModulesFromBundle(appDir, {
    log: (fields, msg) => initBootstrapLog().info(fields, msg),
  });
  initBootstrapLog().info({ acao: "nm_bundle", ...r }, "Bundle node_modules verificado");
  if (r.reason === "missing" && !nativeDepsReady()) {
    throw new Error(
      "vendor/node_modules.zip ausente e node_modules incompleto — reinstale com Setup atualizado",
    );
  }
  return r;
}

function ensureSchemasBundleLocal() {
  const {
    ensureSchemasFromBundle,
  } = require(path.join(appDir, "scripts", "installer-payload-bundle"));
  const r = ensureSchemasFromBundle(appDir, {
    log: (fields, msg) => initBootstrapLog().info(fields, msg),
  });
  initBootstrapLog().info({ acao: "schemas_bundle", ...r }, "Bundle schemas local verificado");
  return r;
}

function writeBootstrapTiming(timing) {
  if (!timing) return;
  const snap = timing.snapshot();
  const targets = [path.join(appDir, "data", "install-bootstrap-timing.json")];
  try {
    const { getDirectoryManager } = require(path.join(appDir, "runtime", "directoryManager"));
    targets.unshift(path.join(getDirectoryManager().PATHS.diagnostics, "install-bootstrap-timing.json"));
  } catch {
    /* ignore */
  }
  const text = JSON.stringify(snap, null, 2);
  for (const fp of targets) {
    try {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, text, "utf8");
    } catch {
      /* try next */
    }
  }
  initBootstrapLog().info(
    { acao: "bootstrap_timing", totalMs: snap.totalMs, phases: snap.phases.length },
    "Timing do bootstrap gravado",
  );
}

function ensurePayloadBundles() {
  // Compat auto-reparo: ambos os bundles.
  ensureNodeModulesBundle();
  ensureSchemasBundleLocal();
}

function generateManifest() {
  if (shouldSkipManifestRegen({
    nativeReady: nativeDepsReady(),
    packaged: packagedInstall(appDir),
    manifestPresent: fs.existsSync(path.join(appDir, "manifest.json")),
    entriesPresent: manifestEntriesPresent(appDir),
  })) {
    initBootstrapLog().info({ acao: "skip_manifest_regen" }, "Manifest já veio no instalador e está completo");
    return;
  }
  const manifestScript = path.join(appDir, "scripts", "generate-manifest.js");
  if (fs.existsSync(manifestScript)) {
    run(`node "${manifestScript}"`, { inherit: true });
    return;
  }
  runNpm(["run", "manifest"], { inherit: true });
}

function runPredeploy() {
  if (shouldSkipPredeploy({ nativeReady: nativeDepsReady(), packaged: packagedInstall(appDir) })) {
    initBootstrapLog().info({ acao: "skip_predeploy" }, "Pré-deploy já rodou no build do instalador");
    return;
  }
  try {
    runNpm(["run", "predeploy"], { inherit: true });
  } catch (err) {
    initBootstrapLog().warn({ err: err.message }, "Pré-deploy reportou avisos");
  }
}

function registerService() {
  if (!withService) return { ok: true, skipped: true };
  // Update/repair: se SCM já tem o serviço e natives OK → só start (sem node-windows reinstall).
  if ((mode === "update" || mode === "repair") && process.platform === "win32") {
    const scm = verifyServiceRegistered();
    if (scm.present && nativeDepsReady()) {
      initBootstrapLog().info(
        { acao: "skip_service_reinstall", state: scm.state, mode },
        "Serviço já registrado — start sem reinstall",
      );
      const started = tryStartService(20_000);
      if (started.ok || scm.state === "running") {
        return {
          ok: true,
          skippedReinstall: true,
          state: started.state || scm.state,
          ...started,
        };
      }
      initBootstrapLog().warn(
        { acao: "skip_reinstall_start_failed", ...started },
        "Start falhou após skip — caindo para reinstall",
      );
    }
  }
  try {
    run(
      `node "${path.join(appDir, "install-service.js")}" --no-open --from-installer`,
      { inherit: true },
    );
    return { ok: true };
  } catch (err) {
    const recovered = verifyServiceRegistered();
    // Só recupera se SCM está RUNNING — stopped/missing não é sucesso.
    if (recovered.ok && recovered.state === "running") {
      initBootstrapLog().warn(
        { err: err.message, state: recovered.state },
        "Registro reportou erro mas serviço RUNNING — continuando",
      );
      return recovered;
    }
    initBootstrapLog().warn({ err: err.message }, "Registro do serviço falhou — tentará auto-reparo");
    return { ok: false, error: err.message, state: recovered.state };
  }
}

function verifyServiceRegistered() {
  if (process.platform !== "win32") return { ok: false, state: "skipped", present: false };
  try {
    const ctl = require(path.join(appDir, "scripts", "installer-service-control"));
    const st = ctl.queryState();
    if (st === "missing") return { ok: false, state: st, present: false };
    return {
      ok: st === "running",
      recovered: st === "running",
      state: st,
      present: true,
    };
  } catch {
    return { ok: false, state: "unknown", present: false };
  }
}

async function runAutoRepairIfOffline(online, startResult, dm, serviceResult) {
  if (online.ok || !withService || process.platform !== "win32") {
    return { online, startResult, serviceResult, repaired: false };
  }

  initBootstrapLog().warn(
    { acao: "auto_repair", agentOnline: online.ok, serviceRunning: startResult.ok },
    "Primeira subida falhou — auto-reparo (mesmo fluxo do Reparar)",
  );

  stopAgentService();

  try {
    run(icaclsGrantCommand(dm.ROOT, { recurse: false }), { stdio: "pipe" });
    initBootstrapLog().info({ acao: "auto_repair_acl" }, "Permissões na raiz aplicadas");
  } catch (err) {
    initBootstrapLog().warn({ err: err.message }, "Auto-reparo: ACL raiz parcial");
  }

  npmRepairSteps();

  try {
    ensurePayloadBundles();
  } catch (err) {
    initBootstrapLog().warn({ err: err.message }, "Auto-reparo: bundles");
  }

  let nextServiceResult = serviceResult;
  const scm = verifyServiceRegistered();
  if (!scm.present) {
    initBootstrapLog().warn({ acao: "auto_repair_register" }, "Serviço ausente no SCM — re-registro");
    nextServiceResult = registerService();
  } else if (!scm.ok) {
    initBootstrapLog().info(
      { acao: "auto_repair_start_only", state: scm.state },
      "Serviço presente mas parado — start sem re-registro",
    );
  }

  const repairBudget = Date.now();
  let nextStart = tryStartService(clampWaitMs(20_000, repairBudget));
  let nextOnline = await waitForOnlineAsync(clampWaitMs(INSTALL_WAIT_ONLINE_MS, repairBudget));

  if (!nextOnline.ok) {
    initBootstrapLog().warn({ acao: "auto_repair_acl_tree" }, "Auto-reparo — ACL recursiva (/T)");
    try {
      run(icaclsGrantCommand(dm.ROOT, { recurse: true }), { stdio: "pipe" });
    } catch (err) {
      initBootstrapLog().warn({ err: err.message }, "Auto-reparo: ACL /T parcial");
    }
    const retryMs = clampWaitMs(INSTALL_WAIT_RETRY_MS, repairBudget);
    tryStartService(retryMs);
    nextOnline = await waitForOnlineAsync(retryMs);
    if (!nextStart.ok) nextStart = tryStartService(retryMs);
  }

  initBootstrapLog().info(
    {
      acao: "auto_repair_done",
      agentOnline: nextOnline.ok,
      serviceRunning: nextStart.ok,
      serviceRegistered: nextServiceResult.ok,
    },
    "Auto-reparo concluído",
  );

  return {
    online: nextOnline,
    startResult: nextStart,
    serviceResult: nextServiceResult,
    repaired: true,
  };
}

async function bringAgentOnline() {
  if (!withService) {
    return { online: { ok: false, skipped: true }, startResult: { ok: true, skipped: true } };
  }

  const budgetStarted = Date.now();
  // Só probe rápido se SCM já RUNNING (update skip-reinstall / retry).
  const scmNow = verifyServiceRegistered();
  if (scmNow.state === "running") {
    try {
      const { waitOnline } = require(path.join(appDir, "scripts", "installer-wait-online"));
      const quick = await waitOnline(1_500);
      if (quick.ok) {
        initBootstrapLog().info(
          { acao: "wait_online_already", porta: quick.port, waitedMs: quick.waitedMs },
          "Agente já online — skip start longo",
        );
        return {
          online: { ok: true, ...quick },
          startResult: { ok: true, alreadyOnline: true, state: "running" },
        };
      }
    } catch {
      /* segue start normal */
    }
  }

  const firstWait = clampWaitMs(INSTALL_WAIT_ONLINE_MS, budgetStarted);
  let startResult = tryStartService(clampWaitMs(20_000, budgetStarted));
  initBootstrapLog().info({ acao: "service_start", ...startResult }, "Start do serviço pós-registro");

  let online = await waitForOnlineAsync(firstWait);
  if (!online.ok && remainingBootstrapBudgetMs(budgetStarted) > 5_000) {
    initBootstrapLog().warn({ acao: "wait_online_retry" }, "Agente offline — retry start + espera");
    const retryMs = clampWaitMs(INSTALL_WAIT_RETRY_MS, budgetStarted);
    tryStartService(retryMs);
    online = await waitForOnlineAsync(retryMs);
    if (!startResult.ok) startResult = tryStartService(retryMs);
  }

  return { online, startResult };
}

async function waitForOnlineAsync(timeoutMs = INSTALL_WAIT_ONLINE_MS) {
  if (!withService) return { ok: false, skipped: true };
  try {
    const { waitOnline } = require(path.join(appDir, "scripts", "installer-wait-online"));
    const result = await waitOnline(timeoutMs);
    if (result.ok) {
      initBootstrapLog().info(
        { acao: "wait_online", porta: result.port, waitedMs: result.waitedMs },
        "Agente online",
      );
      return { ok: true, ...result };
    }
    initBootstrapLog().warn(
      { acao: "wait_online", porta: result.port, waitedMs: result.waitedMs, timeoutMs },
      "Agente ainda não respondeu",
    );
    return { ok: false, ...result };
  } catch (err) {
    initBootstrapLog().warn({ err: err.message, acao: "wait_online" }, "Falha ao aguardar agente");
    return { ok: false };
  }
}

function createShortcuts() {
  if (process.platform !== "win32") return;
  const flags = withDesktop ? " --desktop" : "";
  try {
    run(`node "${path.join(appDir, "scripts", "installer-shortcuts.js")}"${flags}`, { inherit: true });
  } catch (err) {
    initBootstrapLog().warn({ err: err.message }, "Não foi possível criar todos os atalhos");
  }
}

function openPanel() {
  if (!withOpen || process.platform !== "win32") return;
  const port = process.env.AGENT_PORT || process.env.PORT || "9100";
  // Sempre localhost — IP da LAN (ex.: …101) não alcança o bind 127.0.0.1 do agente.
  const url = `http://localhost:${port}/`;
  try {
    run(`cmd /c start "" "${url}"`, { stdio: "pipe" });
    initBootstrapLog().info({ acao: "open_panel", url }, "Painel aberto no navegador");
  } catch (err) {
    initBootstrapLog().warn({ err: err.message }, "Não foi possível abrir o navegador automaticamente");
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
  try {
    const localReport = path.join(appDir, "data", "install-last-report.txt");
    fs.mkdirSync(path.dirname(localReport), { recursive: true });
    const lines = [
      report.ok ? "Margin Engine — diagnóstico OK" : "Margin Engine — ATENÇÃO",
      `Versão: ${report.version || "?"}`,
      `Problemas: ${report.issues.length}`,
    ];
    for (const issue of report.issues) {
      lines.push(`- [${issue.severity}] ${issue.message}`);
    }
    fs.writeFileSync(localReport, lines.join("\n"), "utf8");
  } catch {
    /* ignore */
  }
  return report;
}

async function runDiagnosticLight(online) {
  // Se health+ui.ok já passaram, não re-probe HTTP — só relatório curto.
  if (online && online.ok) {
    const version = (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8")).version;
      } catch {
        return "?";
      }
    })();
    const report = {
      ok: true,
      version,
      issues: [],
      light: true,
    };
    try {
      const localReport = path.join(appDir, "data", "install-last-report.txt");
      fs.mkdirSync(path.dirname(localReport), { recursive: true });
      fs.writeFileSync(
        localReport,
        [
          "Margin Engine — diagnóstico OK (light)",
          `Versão: ${version}`,
          "Problemas: 0",
          "Health + ui.ok confirmados no wait-online.",
        ].join("\n"),
        "utf8",
      );
      const { getDirectoryManager } = require(path.join(appDir, "runtime", "directoryManager"));
      const diag = getDirectoryManager().PATHS.diagnostics;
      fs.mkdirSync(diag, { recursive: true });
      fs.writeFileSync(path.join(diag, "install-last-report.txt"), fs.readFileSync(localReport));
    } catch {
      /* ignore */
    }
    return report;
  }
  return runDiagnostic();
}

async function main() {
  const timing = createBootstrapTiming(mode);
  initBootstrapLog().info({ acao: "bootstrap_start", modo: mode }, "Margin Engine — bootstrap do instalador");
  clearBootstrapMarkers();

  const needsServiceCycle = withService && (mode === "install" || mode === "update" || mode === "repair");
  if (needsServiceCycle) {
    const stop = stopAgentService();
    if (!stop.ok && !stop.skipped) {
      initBootstrapLog().warn(
        { acao: "service_stop_continue", ...stop },
        "Serviço ainda ativo após parada — instalador continua (CloseApplications/bootstrap)",
      );
    }
    if (mode === "update") backupPreUpdate();
  }
  timing.mark("stop");

  validateDependencies();
  if (process.platform === "win32" && mode === "install") {
    try {
      const ctl = require(path.join(appDir, "scripts", "installer-service-control"));
      ctl.removeLegacyServices(appDir);
    } catch {
      /* ignore */
    }
  }
  const dm = ensureDirectories();
  ensureEnv();
  migrateEnvLanBind();
  ensureWindowsPermissions(dm);
  timing.mark("dirs_acl");

  // Só node_modules no caminho crítico — schemas locais depois do :9100 (menos I/O no boot).
  ensureNodeModulesBundle();
  timing.mark("nm_bundle");

  if (mode === "install" || mode === "update") {
    writeDefaultConfigs();
    npmInstallIfNeeded();
    generateManifest();
    runPredeploy();
    if (mode === "update") validatePostUpdate();
  }

  if (mode === "repair") {
    writeDefaultConfigs();
    npmRepairSteps();
    generateManifest();
  }
  timing.mark("deps_validate");

  // Firewall // com wait; schemas (local+ProgramData) DEPOIS do online — disco livre pro boot.
  const fwJob = Promise.resolve().then(() => ensureFirewall());

  let serviceResult = registerService();
  timing.mark("service_register");
  const brought = await bringAgentOnline();
  let online = brought.online;
  let startResult = brought.startResult;
  timing.mark("wait_online");

  try {
    await fwJob;
  } catch (err) {
    initBootstrapLog().warn({ err: err.message }, "Firewall falhou (não bloqueia)");
  }
  timing.mark("firewall");

  // Schemas após health: não compete com cold start do agente; ainda fail-hard antes do Done.
  ensureSchemasBundleLocal();
  ensureProgramDataSchemas();
  timing.mark("schemas");

  const repaired = await runAutoRepairIfOffline(online, startResult, dm, serviceResult);
  online = repaired.online;
  startResult = repaired.startResult;
  serviceResult = repaired.serviceResult || serviceResult;
  if (repaired.repaired) {
    try {
      ensureSchemasBundleLocal();
      ensureProgramDataSchemas();
    } catch (err) {
      initBootstrapLog().warn({ err: err.message }, "Schemas pós auto-reparo");
      throw err;
    }
  }
  timing.mark("auto_repair");

  createShortcuts();
  if (online.ok) {
    openPanel();
  }
  timing.mark("shortcuts");

  if (!startResult.ok && withService && process.platform === "win32") {
    initBootstrapLog().error(
      { startResult, serviceResult },
      "Serviço Margin Engine NÃO ficou RUNNING — abra services.msc ou execute Reparar",
    );
  }

  let report = { ok: true, issues: [] };
  try {
    report = await runDiagnosticLight(online);
  } catch (err) {
    initBootstrapLog().warn({ err: err.message }, "Diagnóstico pós-instalação falhou");
    writeBootstrapFailure(err);
  }
  timing.mark("diagnostic");
  writeBootstrapTiming(timing);

  initBootstrapLog().info(
    {
      acao: "bootstrap_done",
      modo: mode,
      ok: report.ok,
      issues: report.issues.length,
      agentOnline: online.ok,
      serviceOk: serviceResult.ok,
      serviceRunning: startResult.ok,
      autoRepaired: repaired.repaired,
      diagnosticLight: Boolean(report.light),
      totalMs: timing.snapshot().totalMs,
    },
    "Bootstrap concluído",
  );

  if ((!serviceResult.ok || !startResult.ok) && !nativeDepsReady()) {
    writeBootstrapExit(1);
    process.exit(1);
  }
  if (withService && process.platform === "win32" && !online.ok) {
    const detail = [
      "Agente não respondeu em http://localhost:9100/health (ui.ok).",
      `serviceResult=${JSON.stringify(serviceResult)}`,
      `startResult=${JSON.stringify(startResult)}`,
      "Verifique services.msc (Margin Engine) e %ProgramData%\\MarginEngine\\Logs\\application.log",
    ].join("\n");
    writeBootstrapFailure(new Error(detail));
    writeBootstrapExit(1);
    process.exit(1);
  }
  writeBootstrapExit(0);
  process.exit(0);
}

main().catch(async (err) => {
  writeBootstrapFailure(err);
  writeBootstrapExit(1);
  try {
    initBootstrapLog().fatal({ err, acao: "bootstrap_fail" }, err.message);
  } catch {
    /* logging pode falhar antes de diretórios */
  }
  try {
    await runDiagnostic();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

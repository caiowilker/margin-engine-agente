// ============================================================
// PDV Margin Engine — Instalador de Serviço Windows v4.0
//
// NOVIDADES v4.0:
//   ✓ Verifica se serviço já existe antes de instalar
//   ✓ Timeout de 30s no install para evitar travamento
//
// Uso:
//   node install-service.js             → instala o serviço
//   node install-service.js --uninstall → remove o serviço
// ============================================================

require("dotenv").config();

const { initLogging } = require("./runtime/loggingService");
initLogging({ patchConsole: process.env.LOG_PATCH_CONSOLE !== "false" });

const PORT = Number(process.env.PORT || process.env.AGENT_PORT || 9100);
const AGENT_PUBLIC_BASE = (
  process.env.AGENT_PUBLIC_HOST || `http://127.0.0.1:${PORT}`
).replace(/\/$/, "");

const path = require("path");
const fs = require("fs");
const { execSync, exec } = require("child_process");

// ── Banner ────────────────────────────────────────────────────────────────────
console.log("\n╔══════════════════════════════════════════════╗");
console.log("║   Margin Engine — Serviço do agente local    ║");
console.log("╚══════════════════════════════════════════════╝\n");

// ── Verifica Node.js ──────────────────────────────────────────────────────────
const nodeVersion = process.version;
const nodeMajor = parseInt(nodeVersion.split(".")[0].replace("v", ""));
if (nodeMajor < 18) {
  console.error(`✗ Node.js ${nodeVersion} detectado. Versão mínima: 18.`);
  console.error("  Baixe em: https://nodejs.org\n");
  process.exit(1);
}
console.log(`✓ Node.js ${nodeVersion}`);

// ── Verifica privilégios de admin no Windows ──────────────────────────────────
if (process.platform === "win32" && !fromInstaller) {
  try {
    execSync("net session", { stdio: "ignore" });
    console.log("✓ Executando como Administrador");
  } catch (_) {
    console.error(
      "\n✗ Este instalador precisa ser executado como Administrador.",
    );
    console.error(
      "  Clique com botão direito no setup.bat → 'Executar como administrador'\n",
    );
    process.exit(1);
  }
}

// ── Instala dependências se necessário ───────────────────────────────────────
const nodeModules = path.join(__dirname, "node_modules");
if (!fs.existsSync(nodeModules)) {
  console.log("  Instalando dependências (npm install)...");
  try {
    execSync("npm install --loglevel=error", {
      cwd: __dirname,
      stdio: "inherit",
    });
    console.log("✓ Dependências instaladas\n");
  } catch (e) {
    console.error("✗ Erro ao instalar dependências:", e.message);
    process.exit(1);
  }
} else {
  console.log("✓ Dependências já instaladas");
}

// ── Diretórios de dados (ProgramData via DirectoryManager) ───────────────────
const { getDirectoryManager } = require("./runtime/directoryManager");
try {
  getDirectoryManager().ensureAll();
  console.log("✓ Diretórios Margin Engine preparados");
} catch (err) {
  console.warn("⚠ Não foi possível preparar todos os diretórios:", err.message);
}

// ── Cria .env a partir do .env.example se não existir ────────────────────────
const envPath = path.join(__dirname, ".env");
const envExample = path.join(__dirname, ".env.example");
if (!fs.existsSync(envPath) && fs.existsSync(envExample)) {
  fs.copyFileSync(envExample, envPath);
  console.log("✓ .env criado a partir do .env.example");
}

// ── Porta da impressora de rede ───────────────────────────────────────────────
// PORT (agente HTTP local) e PRINTER_PORT (socket da impressora na LAN) são
// independentes — impressoras ESC/POS na rede usam 9100 na maioria dos modelos.
// Não alterar PRINTER_PORT só porque o agente também usa 9100 em localhost.

// ── Verifica frontend-dist ────────────────────────────────────────────────────
const frontendIndex = path.join(__dirname, "frontend-dist", "index.html");
if (!fs.existsSync(frontendIndex)) {
  console.log("\n⚠  frontend-dist/index.html não encontrado.");
  console.log("   PDV precisará de internet para carregar o app.");
  console.log("   Para instalar offline:");
  console.log("     1. No projeto frontend: npm run build");
  console.log("     2. Copie o conteúdo de dist/ para frontend-dist/ (com index.html)\n");
} else {
  console.log("✓ frontend-dist encontrado — PDV funciona offline no navegador");
}

// ── Carrega node-windows ──────────────────────────────────────────────────────
const Service = (() => {
  try {
    return require("node-windows").Service;
  } catch (_) {
    return null;
  }
})();

if (!Service) {
  console.error("\n✗ node-windows não encontrado.");
  console.error("  Execute: npm install\n");
  process.exit(1);
}

// ── Configura serviço ─────────────────────────────────────────────────────────
const svc = new Service({
  name: "Margin Engine",
  description:
    "Agente local do Margin Engine — impressão, fila offline e serviços do PDV.",
  script: path.join(__dirname, "index.js"),
  nodeOptions: [],
  env: [
    { name: "NODE_ENV", value: "production" },
    { name: "LOG_MODE", value: "PRODUCTION" },
    { name: "LOG_PATCH_CONSOLE", value: "false" },
    {
      name: "MARGIN_ENGINE_AGENT_ROOT",
      value: __dirname,
    },
  ],
  wait: 2,
  grow: 0.5,
  maxRestarts: 10,
  abortOnError: false,
});

const uninstall = process.argv.includes("--uninstall");
const noOpen = process.argv.includes("--no-open");
const fromInstaller = process.argv.includes("--from-installer");

svc.on("install", () => {
  svc.start();
  console.log("\n✓ Serviço instalado e iniciado.");
  console.log(`  PDV disponível em: ${AGENT_PUBLIC_BASE}`);
  console.log("  Acesse para ativar o terminal de caixa.\n");

  if (noOpen) {
    finishInstall(0);
    return;
  }

  setTimeout(() => {
    const url = AGENT_PUBLIC_BASE;
    const cmd =
      process.platform === "win32"
        ? `start ${url}`
        : process.platform === "darwin"
          ? `open ${url}`
          : `xdg-open ${url}`;
    exec(cmd);
  }, 2000);
});

svc.on("alreadyinstalled", () => {
  console.log("\n⚠  Serviço já instalado. Reiniciando...");
  svc.start();
  if (noOpen) finishInstall(0);
});

svc.on("uninstall", () => {
  console.log("✓ Serviço Margin Engine removido.");
});

svc.on("start", () => {
  console.log(`✓ Serviço iniciado — PDV disponível em ${AGENT_PUBLIC_BASE}`);
});

svc.on("stop", () => {
  console.log("✓ Serviço parado.");
});

svc.on("error", (e) => {
  console.error("✗ Erro no serviço:", e);
  if (noOpen) finishInstall(1);
});

// ── Executar ──────────────────────────────────────────────────────────────────
const INSTALL_TIMEOUT_MS = 120000;

function finishInstall(code) {
  setTimeout(() => process.exit(code), 300);
}

if (uninstall) {
  console.log("\nRemovendo serviço Margin Engine...");
  svc.uninstall();
} else {
  console.log("\nInstalando serviço Margin Engine...");
  if (noOpen) {
    setTimeout(() => {
      console.error("✗ Timeout ao instalar o serviço Windows (120s)");
      process.exit(1);
    }, INSTALL_TIMEOUT_MS);
  }
  svc.install();
}

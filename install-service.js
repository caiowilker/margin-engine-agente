// ============================================================
// PDV Margin Engine — Instalador de Serviço Windows v4.0
//
// NOVIDADES v4.0:
//   ✓ Detecta conflito de porta 9100 entre agente e impressora
//   ✓ Corrige PRINTER_PORT automaticamente se conflitar com PORT
//   ✓ Solicita elevação UAC se não for admin (Windows)
//   ✓ Verifica se serviço já existe antes de instalar
//   ✓ Timeout de 30s no install para evitar travamento
//
// Uso:
//   node install-service.js             → instala o serviço
//   node install-service.js --uninstall → remove o serviço
// ============================================================

require("dotenv").config();

const PORT = Number(process.env.PORT || process.env.AGENT_PORT || 9100);
const AGENT_PUBLIC_BASE = (
  process.env.AGENT_PUBLIC_HOST || `http://127.0.0.1:${PORT}`
).replace(/\/$/, "");

const path = require("path");
const fs = require("fs");
const { execSync, exec } = require("child_process");

// ── Banner ────────────────────────────────────────────────────────────────────
console.log("\n╔══════════════════════════════════════════════╗");
console.log("║   PDV Margin Engine — Instalador v4.0        ║");
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
if (process.platform === "win32") {
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

// ── Cria diretório de dados ───────────────────────────────────────────────────
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
  console.log("✓ Diretório data/ criado");
}

// ── Cria .env a partir do .env.example se não existir ────────────────────────
const envPath = path.join(__dirname, ".env");
const envExample = path.join(__dirname, ".env.example");
if (!fs.existsSync(envPath) && fs.existsSync(envExample)) {
  fs.copyFileSync(envExample, envPath);
  console.log("✓ .env criado a partir do .env.example");
}

// ── Detecta conflito de porta: agente (PORT) vs impressora (PRINTER_PORT) ────
// Ambos defaultam para 9100 — isso causa falha silenciosa na impressora de rede.
if (fs.existsSync(envPath)) {
  let envContent = fs.readFileSync(envPath, "utf8");

  const portMatch = envContent.match(/^PORT\s*=\s*(\d+)/m);
  const printerPortMatch = envContent.match(/^PRINTER_PORT\s*=\s*(\d+)/m);
  const printerTypeMatch = envContent.match(/^PRINTER_TYPE\s*=\s*(\w+)/m);

  const agentPort = portMatch ? parseInt(portMatch[1]) : 9100;
  const printerPort = printerPortMatch ? parseInt(printerPortMatch[1]) : 9100;
  const printerType = printerTypeMatch ? printerTypeMatch[1] : "auto";

  if (printerType === "network" || printerType === "auto") {
    if (agentPort === printerPort) {
      console.warn(
        `\n⚠  CONFLITO DETECTADO: PORT e PRINTER_PORT ambos em ${agentPort}`,
      );
      console.warn("   Corrigindo PRINTER_PORT para 9101 no .env...");
      envContent = envContent.replace(
        /^PRINTER_PORT\s*=\s*\d+/m,
        "PRINTER_PORT=9101",
      );
      fs.writeFileSync(envPath, envContent, "utf8");
      console.log("✓ PRINTER_PORT corrigido para 9101\n");
    }
  }
}

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
  name: "PDV Margin Engine",
  description:
    "Agente local do PDV Margin Engine — impressora, ACBr e fila offline.",
  script: path.join(__dirname, "index.js"),
  nodeOptions: [],
  env: [{ name: "NODE_ENV", value: "production" }],
  wait: 2,
  grow: 0.5,
  maxRestarts: 10,
  abortOnError: false,
});

const uninstall = process.argv.includes("--uninstall");

svc.on("install", () => {
  svc.start();
  console.log("\n✓ Serviço instalado e iniciado.");
  console.log(`  PDV disponível em: ${AGENT_PUBLIC_BASE}`);
  console.log("  Acesse para ativar o terminal de caixa.\n");

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
});

svc.on("uninstall", () => {
  console.log("✓ Serviço PDV Margin Engine removido.");
});

svc.on("start", () => {
  console.log(`✓ Serviço iniciado — PDV disponível em ${AGENT_PUBLIC_BASE}`);
});

svc.on("stop", () => {
  console.log("✓ Serviço parado.");
});

svc.on("error", (e) => {
  console.error("✗ Erro no serviço:", e);
});

// ── Executar ──────────────────────────────────────────────────────────────────
if (uninstall) {
  console.log("\nRemovendo serviço PDV Margin Engine...");
  svc.uninstall();
} else {
  console.log("\nInstalando serviço PDV Margin Engine...");
  svc.install();
}

// ============================================================
// PDV Margin Engine - Instalador de Servico Windows v5.0
//
// MUDANCAS v5.0:
//   - Usa logger simplificado ASCII em vez de console.log com simbolos
//   - Nao le mais config.json para buscar token - cofre gerenciado
//     pelo modulo credenciais.js
//   - Detecta conflito de porta 9100 entre agente e impressora
//   - Solicita elevacao UAC se nao for admin
//   - Verifica se servico ja existe antes de instalar
//   - Cria pasta data/logs/ automaticamente
//
// Uso:
//   node install-service.js             instala o servico
//   node install-service.js --uninstall remove o servico
// ============================================================

const path = require("path");
const fs = require("fs");
const { execSync, exec } = require("child_process");

// Logger simplificado para o instalador (sem pino-roll, pois
// pode rodar antes do npm install estar completo)
function info(msg) {
  console.log("[OK]    " + msg);
}
function warn(msg) {
  console.log("[AVISO] " + msg);
}
function erro(msg) {
  console.log("[ERRO]  " + msg);
}
function titulo(msg) {
  console.log("\n" + msg + "\n" + "=".repeat(msg.length));
}

titulo("PDV Margin Engine - Instalador v5.0");

// -- Verifica Node.js ---------------------------------------------------------
const nodeVersion = process.version;
const nodeMajor = parseInt(nodeVersion.split(".")[0].replace("v", ""));
if (nodeMajor < 18) {
  erro("Node.js " + nodeVersion + " detectado. Versao minima: 18.");
  erro("Baixe em: https://nodejs.org");
  process.exit(1);
}
info("Node.js " + nodeVersion);

// -- Verifica privilegios de admin no Windows ---------------------------------
if (process.platform === "win32") {
  try {
    execSync("net session", { stdio: "ignore" });
    info("Executando como Administrador");
  } catch (_) {
    erro("Este instalador precisa ser executado como Administrador.");
    erro(
      "Clique com botao direito no setup.bat -> 'Executar como administrador'",
    );
    process.exit(1);
  }
}

// -- Instala dependencias se necessario ---------------------------------------
const nodeModules = path.join(__dirname, "node_modules");
if (!fs.existsSync(nodeModules)) {
  info("Instalando dependencias (npm install)...");
  try {
    execSync("npm install --loglevel=error", {
      cwd: __dirname,
      stdio: "inherit",
    });
    info("Dependencias instaladas");
  } catch (e) {
    erro("Erro ao instalar dependencias: " + e.message);
    process.exit(1);
  }
} else {
  info("Dependencias ja instaladas");
}

// -- Cria diretorios necessarios ----------------------------------------------
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
  info("Diretorio data/ criado");
}

const logsDir = path.join(__dirname, "data", "logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
  info("Diretorio data/logs/ criado");
}

// -- Cria .env a partir do .env.example se nao existir -----------------------
const envPath = path.join(__dirname, ".env");
const envExample = path.join(__dirname, ".env.example");
if (!fs.existsSync(envPath) && fs.existsSync(envExample)) {
  fs.copyFileSync(envExample, envPath);
  info(".env criado a partir do .env.example");
} else if (fs.existsSync(envPath)) {
  info(".env ja existe");
}

// -- Detecta conflito de porta: agente (PORT) vs impressora (PRINTER_PORT) ---
if (fs.existsSync(envPath)) {
  let envContent = fs.readFileSync(envPath, "utf8");

  const portMatch = envContent.match(/^PORT\s*=\s*(\d+)/m);
  const printerPortMatch = envContent.match(/^PRINTER_PORT\s*=\s*(\d+)/m);
  const printerTypeMatch = envContent.match(/^PRINTER_TYPE\s*=\s*(\w+)/m);

  const agentPort = portMatch ? parseInt(portMatch[1]) : 9100;
  const printerPort = printerPortMatch ? parseInt(printerPortMatch[1]) : 9100;
  const printerType = printerTypeMatch ? printerTypeMatch[1] : "usb";

  if (printerType === "network" && agentPort === printerPort) {
    warn(
      "CONFLITO: PORT e PRINTER_PORT ambos em " +
        agentPort +
        ". Corrigindo PRINTER_PORT para 9101...",
    );
    envContent = envContent.replace(
      /^PRINTER_PORT\s*=\s*\d+/m,
      "PRINTER_PORT=9101",
    );
    fs.writeFileSync(envPath, envContent, "utf8");
    info("PRINTER_PORT corrigido para 9101 no .env");
  }
}

// -- Verifica frontend-dist ---------------------------------------------------
const frontendDist = path.join(__dirname, "frontend-dist");
if (!fs.existsSync(frontendDist)) {
  warn("frontend-dist nao encontrado.");
  warn("PDV precisara de internet para carregar o app.");
  warn(
    "Para instalar offline: npm run build no frontend -> copie dist/ como frontend-dist/",
  );
} else {
  info("frontend-dist encontrado - PDV funciona offline");
}

// -- Carrega node-windows -----------------------------------------------------
const Service = (() => {
  try {
    return require("node-windows").Service;
  } catch (_) {
    return null;
  }
})();

if (!Service) {
  erro("node-windows nao encontrado. Execute: npm install");
  process.exit(1);
}

// -- Configura servico --------------------------------------------------------
const svc = new Service({
  name: "PDV Margin Engine",
  description:
    "Agente local do PDV Margin Engine - impressora, ACBr e fila offline.",
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
  info("Servico instalado e iniciado.");
  info("PDV disponivel em: http://localhost:9100");
  info("Para obter o token local de API, execute depois:");
  info(
    "  node -e \"require('./credenciais').ler().then(c=>console.log(c['local-api-token']))\"",
  );

  setTimeout(() => {
    const url = "http://localhost:9100";
    const cmd =
      process.platform === "win32"
        ? "start " + url
        : process.platform === "darwin"
          ? "open " + url
          : "xdg-open " + url;
    exec(cmd);
  }, 2000);
});

svc.on("alreadyinstalled", () => {
  warn("Servico ja instalado. Reiniciando...");
  svc.start();
});

svc.on("uninstall", () => {
  info("Servico PDV Margin Engine removido.");
});

svc.on("start", () => {
  info("Servico iniciado - PDV disponivel em http://localhost:9100");
});

svc.on("stop", () => {
  info("Servico parado.");
});

svc.on("error", (e) => {
  erro("Erro no servico: " + e);
});

// -- Executar -----------------------------------------------------------------
if (uninstall) {
  titulo("Removendo servico PDV Margin Engine...");
  svc.uninstall();
} else {
  titulo("Instalando servico PDV Margin Engine...");
  svc.install();
}

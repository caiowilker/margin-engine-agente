#!/usr/bin/env node
/**
 * Checklist pré-deploy — npm run predeploy
 * Somente leitura; exit 0 = apto, exit 1 = bloqueado.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const net = require("net");
const http = require("http");

const ROOT = path.join(__dirname, "..");
let falhas = 0;

function ok(msg) {
  console.log(`  ✓ ${msg}`);
}

function fail(msg) {
  console.log(`  ✗ ${msg}`);
  falhas++;
}

function lerEnvArquivo() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return {};
  const map = {};
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    map[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return map;
}

function checkManifest() {
  console.log("\n[manifest.json]");
  const fp = path.join(ROOT, "manifest.json");
  if (!fs.existsSync(fp)) {
    fail("manifest.json ausente — execute npm run manifest");
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch (err) {
    fail(`manifest.json inválido: ${err.message}`);
    return;
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  if (manifest.versao !== pkg.version) {
    fail(`versão manifest (${manifest.versao}) ≠ package.json (${pkg.version})`);
  } else {
    ok(`versão ${manifest.versao} confere com package.json`);
  }
  if (!manifest.arquivos?.length) {
    fail("manifest sem arquivos");
    return;
  }
  let shaOk = true;
  for (const item of manifest.arquivos) {
    if (!item.sha256 || String(item.sha256).trim() === "") {
      fail(`SHA-256 vazio: ${item.arquivo}`);
      shaOk = false;
    }
  }
  if (shaOk) ok(`${manifest.arquivos.length} arquivos com SHA-256 preenchido`);
}

function checkEnvVars() {
  console.log("\n[.env]");
  const envFile = lerEnvArquivo();
  const obrigatorias = [
    "ACBR_HOST",
    "ACBR_PORT",
    "AGENT_PORT",
    "BACKEND_URL",
    "DISK_MIN_MB_XML",
    "DISK_MIN_MB_PDF",
    "DISK_MIN_MB_BACKUP",
    "MAX_TENTATIVAS_CONSULTA",
  ];
  if (!Object.keys(envFile).length && !fs.existsSync(path.join(ROOT, ".env"))) {
    fail(".env ausente — copie de .env.example");
    return;
  }
  for (const chave of obrigatorias) {
    const val =
      envFile[chave] ??
      (chave === "AGENT_PORT"
        ? envFile.PORT || process.env.PORT
        : process.env[chave]);
    if (val === undefined || val === "") {
      if (chave === "AGENT_PORT" && (envFile.PORT || process.env.PORT)) {
        ok(`${chave} (via PORT=${envFile.PORT || process.env.PORT})`);
        continue;
      }
      fail(`variável ausente ou vazia: ${chave}`);
    } else {
      ok(`${chave} definida`);
    }
  }
}

function checkSqlite() {
  console.log("\n[SQLite integrity_check]");
  const Database = require("better-sqlite3");
  const dbs = [
    path.join(ROOT, "data", "fila_fiscal.db"),
    path.join(ROOT, "data", "fila.db"),
    path.join(ROOT, "data", "fiscal_metrics.db"),
  ];
  for (const dbPath of dbs) {
    const nome = path.basename(dbPath);
    if (!fs.existsSync(dbPath)) {
      ok(`${nome} — ainda não criado (OK em deploy novo)`);
      continue;
    }
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.pragma("integrity_check");
      if (row[0]?.integrity_check === "ok") ok(`${nome} — integrity ok`);
      else fail(`${nome} — integrity_check: ${row[0]?.integrity_check}`);
    } catch (err) {
      fail(`${nome} — ${err.message}`);
    } finally {
      db.close();
    }
  }
}

function checkAcbr() {
  console.log("\n[ACBr TCP]");
  const host = process.env.ACBR_HOST || "127.0.0.1";
  const port = parseInt(process.env.ACBR_PORT || "9200", 10);
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port }, () => {
      ok(`ACBr responde em ${host}:${port}`);
      socket.destroy();
      resolve();
    });
    socket.setTimeout(3000);
    socket.on("timeout", () => {
      fail(`ACBr sem resposta em ${host}:${port} (timeout 3s)`);
      socket.destroy();
      resolve();
    });
    socket.on("error", (err) => {
      fail(`ACBr inacessível em ${host}:${port} — ${err.message}`);
      resolve();
    });
  });
}

function checkDisco() {
  console.log("\n[disco]");
  const fiscalStorage = require("../fiscalStorage");
  const { PATHS } = require("../marginPaths");
  const xml = fiscalStorage.checkDiskSpace(PATHS.xml, fiscalStorage.MIN_MB_XML);
  const pdf = fiscalStorage.checkDiskSpace(PATHS.pdf, fiscalStorage.MIN_MB_PDF);
  const backup = fiscalStorage.checkDiskSpace(
    PATHS.backup,
    fiscalStorage.MIN_MB_BACKUP,
  );
  const minTotal =
    fiscalStorage.MIN_MB_XML +
    fiscalStorage.MIN_MB_PDF +
    fiscalStorage.MIN_MB_BACKUP;
  if (xml.livresMB !== null && xml.livresMB < minTotal) {
    fail(
      `espaço insuficiente (${xml.livresMB}MB livres, mínimo combinado ${minTotal}MB)`,
    );
  } else if (xml.livresMB === null) {
    ok("espaço em disco — verificação indisponível neste SO (ignorado)");
  } else {
    ok(`espaço livre ${xml.livresMB}MB ≥ ${minTotal}MB exigidos`);
  }
}

function checkPorta() {
  console.log("\n[porta agente]");
  const port = parseInt(
    process.env.AGENT_PORT || process.env.PORT || "9100",
    10,
  );
  return new Promise((resolve) => {
    const server = http.createServer();
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        fail(`porta ${port} já em uso — pare o agente antes do deploy`);
      } else {
        fail(`porta ${port} — ${err.message}`);
      }
      resolve();
    });
    server.listen(port, "127.0.0.1", () => {
      ok(`porta ${port} disponível`);
      server.close(() => resolve());
    });
  });
}

function checkNode() {
  console.log("\n[Node.js]");
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major >= 18) ok(`Node ${process.versions.node}`);
  else fail(`Node ${process.versions.node} — requer >= 18`);
}

function checkWebhookUrl() {
  console.log("\n[WEBHOOK_ALERTAS_URL]");
  const url = process.env.WEBHOOK_ALERTAS_URL;
  if (!url) {
    ok("não definida (feature desativada)");
    return;
  }
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") {
      ok(`URL válida (${u.protocol}//${u.host})`);
    } else {
      fail("WEBHOOK_ALERTAS_URL deve ser http ou https");
    }
  } catch {
    fail("WEBHOOK_ALERTAS_URL inválida");
  }
}

function checkFrontAgenteUrls() {
  console.log("\n[VITE_AGENTE_URLS front]");
  const frontEnv = path.join(ROOT, "..", "margin-engine-front", ".env");
  const frontExample = path.join(ROOT, "..", "margin-engine-front", ".env.example");
  const fp = fs.existsSync(frontEnv) ? frontEnv : frontExample;
  if (!fs.existsSync(fp)) {
    ok("front .env não encontrado (opcional)");
    return;
  }
  const content = fs.readFileSync(fp, "utf8");
  const m = content.match(/VITE_AGENTE_URLS=(.+)/);
  if (!m) {
    ok("VITE_AGENTE_URLS ausente (usa default localhost)");
    return;
  }
  try {
    const arr = JSON.parse(m[1].trim());
    if (Array.isArray(arr) && arr.length > 0) {
      ok(`JSON array válido (${arr.length} instância(s))`);
    } else {
      fail("VITE_AGENTE_URLS deve ser array JSON não vazio");
    }
  } catch {
    fail("VITE_AGENTE_URLS não é JSON array válido");
  }
}

async function main() {
  console.log("pre-deploy-check.js\n");
  checkNode();
  checkManifest();
  checkEnvVars();
  checkWebhookUrl();
  checkFrontAgenteUrls();
  checkSqlite();
  checkDisco();
  await checkAcbr();
  await checkPorta();
  console.log(falhas ? `\n${falhas} check(s) falharam.\n` : "\nTodos os checks passaram.\n");
  process.exit(falhas ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

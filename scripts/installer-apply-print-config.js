#!/usr/bin/env node
/**
 * Aplica configuração de impressora gravada pelo instalador Inno Setup.
 * Uso: node scripts/installer-apply-print-config.js <appDir> <configJsonPath>
 */
const fs = require("fs");
const path = require("path");
const http = require("http");

const appDir = process.argv[2];
const configPath = process.argv[3];

if (!appDir || !configPath || !fs.existsSync(configPath)) {
  process.exit(0);
}

const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
const envPath = path.join(appDir, ".env");
const envExample = path.join(appDir, ".env.example");

if (!fs.existsSync(envPath) && fs.existsSync(envExample)) {
  fs.copyFileSync(envExample, envPath);
}

function patchEnv(lines, key, value) {
  const re = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value ?? ""}`;
  if (re.test(lines)) return lines.replace(re, line);
  return `${lines.replace(/\s*$/, "")}\n${line}\n`;
}

let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";

envContent = patchEnv(envContent, "PRINTER_PROVIDER", cfg.provider || "acbr-posprinter");
envContent = patchEnv(envContent, "PRINTER_FALLBACK", cfg.fallback || "native");
if (cfg.porta) envContent = patchEnv(envContent, "PRINTER_PORTA", cfg.porta);
if (cfg.modelo != null) envContent = patchEnv(envContent, "PRINTER_MODEL", String(cfg.modelo));
if (cfg.encoding) envContent = patchEnv(envContent, "PRINTER_ENCODING", cfg.encoding);
if (cfg.cut) envContent = patchEnv(envContent, "PRINTER_CUT", cfg.cut);
if (cfg.nomeImpressora) envContent = patchEnv(envContent, "PRINTER_NAME", cfg.nomeImpressora);
if (cfg.libPath) {
  envContent = patchEnv(envContent, "ACBR_POSPRINTER_LIB_PATH", cfg.libPath.replace(/\\/g, "\\\\"));
}
if (cfg.iniPath) {
  envContent = patchEnv(envContent, "ACBR_POSPRINTER_INI", cfg.iniPath.replace(/\\/g, "\\\\"));
}
envContent = envContent.replace(/^PRINTER_ALLOW_PARITY=.*\n?/m, "");

fs.writeFileSync(envPath, envContent, "utf8");

process.chdir(appDir);
const printerLocalConfig = require(path.join(appDir, "print", "printerLocalConfig"));
printerLocalConfig.salvar({
  provider: cfg.provider || "acbr-posprinter",
  porta: cfg.porta,
  modelo: cfg.modelo,
  encoding: cfg.encoding || "UTF8",
  cut: cfg.cut || "partial",
  nomeImpressora: cfg.nomeImpressora,
  serial: cfg.serial,
});

if (cfg.logoBase64) {
  try {
    const printerLogo = require(path.join(appDir, "print", "printerLogo"));
    printerLogo.salvar({
      base64: cfg.logoBase64,
      kc1: cfg.logoKc1,
      kc2: cfg.logoKc2,
      ativo: true,
    });
  } catch (e) {
    console.warn("[installer-print] Logo ignorado:", e.message);
  }
}

const port = Number(process.env.PORT || process.env.AGENT_PORT || 9100);
if (cfg.testarImpressao) {
  const body = JSON.stringify({});
  const req = http.request(
    {
      hostname: "127.0.0.1",
      port,
      path: "/impressora/teste",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout: 120000,
    },
    (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode >= 400) {
          console.warn("[installer-print] Teste HTTP falhou:", data);
          process.exit(1);
        }
        console.log("[installer-print] Teste de impressão OK");
        process.exit(0);
      });
    },
  );
  req.on("error", (err) => {
    console.warn("[installer-print] Agente offline — config salva, teste manual necessário:", err.message);
    process.exit(0);
  });
  req.write(body);
  req.end();
} else {
  console.log("[installer-print] Configuração de impressora aplicada");
}

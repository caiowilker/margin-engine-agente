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

process.chdir(appDir);
require("dotenv").config();

const printerBootstrap = require(path.join(appDir, "print", "printerBootstrap"));
const saved = printerBootstrap.aplicarConfigInstalador(cfg);
console.log("[installer-print] Provider:", saved.provider, "| modo:", saved.mode);

if (cfg.autoDetect !== false) {
  printerBootstrap
    .autoDetectarESincronizar({ force: true })
    .then((r) => {
      if (r.ok && r.config) {
        console.log(
          "[installer-print] Auto-detect:",
          r.config.porta || "(porta pendente — conecte a impressora e reinicie o agente)",
        );
      } else {
        console.log(
          "[installer-print] Auto-detect: nenhuma impressora agora (normal se USB/rede ainda não conectada)",
        );
      }
      finalizarTeste();
    })
    .catch((err) => {
      console.warn("[installer-print] Auto-detect falhou:", err.message);
      finalizarTeste();
    });
} else {
  finalizarTeste();
}

function finalizarTeste() {
  if (!cfg.testarImpressao) {
    console.log("[installer-print] Configuração de impressora aplicada");
    process.exit(0);
    return;
  }

  const port = Number(process.env.PORT || process.env.AGENT_PORT || 9100);
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
    console.warn(
      "[installer-print] Agente offline — config salva, teste após iniciar o serviço:",
      err.message,
    );
    process.exit(0);
  });
  req.write(body);
  req.end();
}

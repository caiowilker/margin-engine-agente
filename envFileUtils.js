/**
 * Leitura/escrita de valores no .env do agente.
 */
const fs = require("fs");
const path = require("path");

function desescaparValorEnv(val) {
  if (val == null || val === "") return "";
  return String(val).replace(/\\\\/g, "\\").trim();
}

function lerEnvMap(envPath) {
  if (!envPath || !fs.existsSync(envPath)) return {};
  const map = {};
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) map[m[1]] = m[2];
  }
  return map;
}

/** Caminhos Windows gravados com \\ no .env voltam a barra simples. */
function lerEnvPath(envPath, key) {
  const map = lerEnvMap(envPath);
  return desescaparValorEnv(map[key] || process.env[key] || "");
}

module.exports = {
  desescaparValorEnv,
  lerEnvMap,
  lerEnvPath,
};

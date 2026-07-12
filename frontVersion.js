// Identificador estável do build do front servido em frontend-dist/
const fs = require("fs");
const path = require("path");

function lerFrontVersionJson(baseDir = __dirname) {
  const jsonPath = path.join(baseDir, "frontend-dist", "version.json");
  if (!fs.existsSync(jsonPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  } catch {
    return null;
  }
}

/** Retorna buildId (hash Vite) ou version como fallback. */
function lerFrontBuildId(baseDir = __dirname) {
  const data = lerFrontVersionJson(baseDir);
  if (!data) return null;
  const buildId = data.buildId != null ? String(data.buildId).trim() : "";
  if (buildId) return buildId;
  const version = data.version != null ? String(data.version).trim() : "";
  return version || null;
}

module.exports = {
  lerFrontVersionJson,
  lerFrontBuildId,
};

"use strict";

/**
 * Verifica pré-requisitos locais para CT-e/MDF-e sem carregar ou chamar ACBr.
 * A emissão permanece desabilitada até existir um adaptador fiscal próprio.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PATHS } = require("../marginPaths");

const AGENT_ROOT = path.resolve(__dirname, "..");

const DOCUMENTOS = {
  cte: {
    nome: "CT-e",
    envPrefix: "ACBR_CTE",
    dll: os.platform() === "win32" ? "ACBrCTe64.dll" : "libacbrcte64.so",
    schemaDirs: ["CTe", "CTeOS"],
    configFiles: ["acbrcte.ini", "ACBrCTe.ini"],
  },
  mdfe: {
    nome: "MDF-e",
    envPrefix: "ACBR_MDFE",
    dll: os.platform() === "win32" ? "ACBrMDFe64.dll" : "libacbrmdfe64.so",
    schemaDirs: ["MDFe"],
    configFiles: ["acbrmdfe.ini", "ACBrMDFe.ini"],
  },
};

function resolveExistingPath(explicit, candidates) {
  if (explicit) {
    const resolved = path.isAbsolute(explicit)
      ? explicit
      : path.resolve(AGENT_ROOT, explicit);
    return fs.existsSync(resolved) ? resolved : null;
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function directoryHasXsd(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).some((entry) => {
      const entryPath = path.join(dir, entry.name);
      return entry.isFile()
        ? entry.name.toLowerCase().endsWith(".xsd")
        : entry.isDirectory() && directoryHasXsd(entryPath);
    });
  } catch {
    return false;
  }
}

function verificarCapacidadeTransporte(documento, env = process.env) {
  const definition = DOCUMENTOS[documento];
  if (!definition) throw new Error(`Documento de transporte inválido: ${documento}`);

  const dllPath = resolveExistingPath(env[`${definition.envPrefix}_LIB_PATH`], [
    path.join(AGENT_ROOT, "acbrlib", "lib", definition.dll),
    path.join(AGENT_ROOT, "lib", definition.dll),
    path.join(PATHS.root, "lib", definition.dll),
    path.join(AGENT_ROOT, definition.dll),
  ]);
  const configPath = resolveExistingPath(env[`${definition.envPrefix}_INI`], [
    ...definition.configFiles.map((file) =>
      path.join(AGENT_ROOT, "acbrlib", "data", "config", file),
    ),
    ...definition.configFiles.map((file) => path.join(AGENT_ROOT, "data", file)),
    ...definition.configFiles.map((file) => path.join(PATHS.root, "data", file)),
    ...definition.configFiles.map((file) => path.join(PATHS.acbr, file)),
  ]);

  const configuredSchemas = env[`${definition.envPrefix}_SCHEMAS_PATH`];
  const schemaRoots = [
    configuredSchemas
      ? path.isAbsolute(configuredSchemas)
        ? configuredSchemas
        : path.resolve(AGENT_ROOT, configuredSchemas)
      : null,
    path.join(AGENT_ROOT, "acbrlib", "data", "Schemas"),
    path.join(AGENT_ROOT, "schemas"),
    path.join(PATHS.root, "Schemas"),
  ].filter(Boolean);
  const schemaPath =
    schemaRoots
      .flatMap((root) => definition.schemaDirs.map((schemaDir) => path.join(root, schemaDir)))
      .find(directoryHasXsd) || null;

  const ausentes = [];
  if (!dllPath) ausentes.push("dll");
  if (!schemaPath) ausentes.push("schemas");
  if (!configPath) ausentes.push("config");

  return {
    ok: ausentes.length === 0,
    code: ausentes.length === 0 ? null : "CAPABILITY_UNAVAILABLE",
    documento,
    nome: definition.nome,
    ausentes,
    paths: {
      dll: dllPath,
      schemas: schemaPath,
      config: configPath,
    },
  };
}

module.exports = {
  DOCUMENTOS,
  directoryHasXsd,
  verificarCapacidadeTransporte,
};

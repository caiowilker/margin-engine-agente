#!/usr/bin/env node
/**
 * Payload rápido do instalador Windows: poucos arquivos no Inno, árvore no disco.
 *
 * - Build: empacota node_modules (+ Schemas) em ZIP (tar -a) sob vendor/
 * - Bootstrap: extrai 1× com tar.exe (Win10+) se stamp divergir ou natives ausentes
 *
 * Uso:
 *   node scripts/installer-payload-bundle.js pack [appDir]
 *   node scripts/installer-payload-bundle.js ensure [appDir]
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const NODE_MODULES_ZIP = path.join("vendor", "node_modules.zip");
const NODE_MODULES_STAMP = path.join("vendor", "node_modules.stamp");
const SCHEMAS_ZIP = path.join("vendor", "schemas.zip");
const SCHEMAS_STAMP = path.join("vendor", "schemas.stamp");
const INSTALLED_NM_STAMP = path.join("node_modules", ".bundle-stamp");
const INSTALLED_SCHEMAS_STAMP = path.join("acbrlib", "data", "Schemas", ".bundle-stamp");

function readPkgVersion(appDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8")).version || "0";
  } catch {
    return "0";
  }
}

function stampForZip(appDir, zipRel) {
  const abs = path.join(appDir, zipRel);
  const st = fs.statSync(abs);
  return `${readPkgVersion(appDir)}|${st.size}|${Math.trunc(st.mtimeMs)}`;
}

function writeText(fp, text) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, text, "utf8");
}

function resolveTar() {
  if (process.platform === "win32") {
    const candidates = [
      path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"),
      "tar.exe",
      "tar",
    ];
    for (const c of candidates) {
      try {
        execFileSync(c, ["--version"], { stdio: "pipe" });
        return c;
      } catch {
        /* try next */
      }
    }
    throw new Error("tar.exe ausente — Windows 10+ é obrigatório para o bundle do instalador");
  }
  return "tar";
}

function packZip(appDir, sourceDirRel, zipRel) {
  const srcAbs = path.join(appDir, sourceDirRel);
  if (!fs.existsSync(srcAbs)) {
    throw new Error(`Fonte ausente para bundle: ${sourceDirRel}`);
  }
  const zipAbs = path.join(appDir, zipRel);
  fs.mkdirSync(path.dirname(zipAbs), { recursive: true });
  try {
    fs.unlinkSync(zipAbs);
  } catch {
    /* ignore */
  }
  const tar = resolveTar();
  const base = path.basename(sourceDirRel);
  const parent = path.dirname(srcAbs);
  try {
    execFileSync(tar, ["-a", "-cf", zipAbs, "-C", parent, base], {
      stdio: "pipe",
      windowsHide: true,
    });
  } catch (err) {
    // GNU tar antigo / ambiente sem -a: fallback zip(1)
    try {
      execFileSync("zip", ["-r", "-q", zipAbs, base], {
        cwd: parent,
        stdio: "pipe",
      });
    } catch (err2) {
      throw new Error(
        `Falha ao criar ${zipRel}: ${err.message}; zip fallback: ${err2.message}`,
      );
    }
  }
  if (!fs.existsSync(zipAbs) || fs.statSync(zipAbs).size < 1000) {
    throw new Error(`Bundle vazio/inválido: ${zipRel}`);
  }
  return zipAbs;
}

function extractZip(appDir, zipRel, destParentRel) {
  const zipAbs = path.join(appDir, zipRel);
  const destParent = path.join(appDir, destParentRel);
  fs.mkdirSync(destParent, { recursive: true });
  const tar = resolveTar();
  execFileSync(tar, ["-xf", zipAbs, "-C", destParent], {
    stdio: "pipe",
    windowsHide: true,
  });
}

function rmrf(target) {
  if (!fs.existsSync(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
}

function packNodeModules(appDir) {
  const nm = path.join(appDir, "node_modules");
  if (!fs.existsSync(path.join(nm, "better-sqlite3", "package.json"))) {
    throw new Error("node_modules incompleto — rode npm ci antes de pack");
  }
  packZip(appDir, "node_modules", NODE_MODULES_ZIP);
  writeText(path.join(appDir, NODE_MODULES_STAMP), stampForZip(appDir, NODE_MODULES_ZIP));
  return {
    zip: NODE_MODULES_ZIP,
    size: fs.statSync(path.join(appDir, NODE_MODULES_ZIP)).size,
  };
}

function packSchemas(appDir) {
  const schemas = path.join(appDir, "acbrlib", "data", "Schemas");
  if (!fs.existsSync(schemas)) {
    throw new Error("acbrlib/data/Schemas ausente — rode sync:windows-build");
  }
  packZip(appDir, path.join("acbrlib", "data", "Schemas"), SCHEMAS_ZIP);
  writeText(path.join(appDir, SCHEMAS_STAMP), stampForZip(appDir, SCHEMAS_ZIP));
  return {
    zip: SCHEMAS_ZIP,
    size: fs.statSync(path.join(appDir, SCHEMAS_ZIP)).size,
  };
}

function packAll(appDir) {
  const nm = packNodeModules(appDir);
  const schemas = packSchemas(appDir);
  return { nodeModules: nm, schemas };
}

function needsExtract(appDir, zipRel, stampRel, installedStampRel, readyCheck) {
  const zipAbs = path.join(appDir, zipRel);
  if (!fs.existsSync(zipAbs)) return { needed: false, reason: "no_zip" };
  if (typeof readyCheck === "function" && !readyCheck()) {
    return { needed: true, reason: "not_ready" };
  }
  const expected = fs.existsSync(path.join(appDir, stampRel))
    ? fs.readFileSync(path.join(appDir, stampRel), "utf8").trim()
    : stampForZip(appDir, zipRel);
  const installedPath = path.join(appDir, installedStampRel);
  if (!fs.existsSync(installedPath)) return { needed: true, reason: "no_installed_stamp" };
  const got = fs.readFileSync(installedPath, "utf8").trim();
  if (got !== expected) return { needed: true, reason: "stamp_mismatch" };
  return { needed: false, reason: "stamp_ok" };
}

function nativesFromBundleReady(appDir) {
  const base = path.join(appDir, "node_modules");
  const required = ["better-sqlite3", "node-windows", "express", "koffi"];
  for (const name of required) {
    if (!fs.existsSync(path.join(base, name, "package.json"))) return false;
  }
  if (
    !fs.existsSync(
      path.join(base, "better-sqlite3", "build", "Release", "better_sqlite3.node"),
    )
  ) {
    return false;
  }
  if (process.platform === "win32") {
    if (!fs.existsSync(path.join(base, "koffi", "build", "koffi", "win32_x64", "koffi.node"))) {
      return false;
    }
  }
  return true;
}

function ensureNodeModulesFromBundle(appDir, opts = {}) {
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const zipAbs = path.join(appDir, NODE_MODULES_ZIP);
  const explodedOk = nativesFromBundleReady(appDir);

  if (!fs.existsSync(zipAbs)) {
    return { extracted: false, reason: explodedOk ? "exploded_only" : "missing" };
  }

  const check = needsExtract(
    appDir,
    NODE_MODULES_ZIP,
    NODE_MODULES_STAMP,
    INSTALLED_NM_STAMP,
    () => explodedOk,
  );
  if (!check.needed) {
    if (!nativesFromBundleReady(appDir)) {
      throw new Error(
        "node_modules stamp OK mas natives incompletos (sqlite/koffi) — delete node_modules e reinstale",
      );
    }
    log({ acao: "nm_bundle_skip", reason: check.reason }, "node_modules bundle OK");
    return { extracted: false, reason: check.reason };
  }

  log({ acao: "nm_bundle_extract", reason: check.reason }, "Extraindo node_modules.zip");
  const nmDir = path.join(appDir, "node_modules");
  const bak = path.join(appDir, `node_modules.__old__${Date.now()}`);
  if (fs.existsSync(nmDir)) {
    try {
      fs.renameSync(nmDir, bak);
    } catch {
      rmrf(nmDir);
    }
  }
  extractZip(appDir, NODE_MODULES_ZIP, ".");
  if (!nativesFromBundleReady(appDir)) {
    if (fs.existsSync(bak) && !fs.existsSync(nmDir)) {
      try {
        fs.renameSync(bak, nmDir);
      } catch {
        /* ignore */
      }
    }
    throw new Error(
      "Falha ao extrair vendor/node_modules.zip (natives sqlite/koffi/express ausentes após extract)",
    );
  }
  rmrf(bak);
  const expected = fs.existsSync(path.join(appDir, NODE_MODULES_STAMP))
    ? fs.readFileSync(path.join(appDir, NODE_MODULES_STAMP), "utf8").trim()
    : stampForZip(appDir, NODE_MODULES_ZIP);
  writeText(path.join(appDir, INSTALLED_NM_STAMP), expected);
  log({ acao: "nm_bundle_ok" }, "node_modules extraído do bundle");
  return { extracted: true, reason: check.reason };
}

function ensureSchemasFromBundle(appDir, opts = {}) {
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const zipAbs = path.join(appDir, SCHEMAS_ZIP);
  const schemasDir = path.join(appDir, "acbrlib", "data", "Schemas");
  const explodedOk = fs.existsSync(schemasDir) && fs.readdirSync(schemasDir).length > 0;

  if (!fs.existsSync(zipAbs)) {
    return { extracted: false, reason: explodedOk ? "exploded_only" : "missing" };
  }

  const check = needsExtract(
    appDir,
    SCHEMAS_ZIP,
    SCHEMAS_STAMP,
    INSTALLED_SCHEMAS_STAMP,
    () => explodedOk,
  );
  if (!check.needed) {
    log({ acao: "schemas_bundle_skip", reason: check.reason }, "schemas bundle OK");
    return { extracted: false, reason: check.reason };
  }

  log({ acao: "schemas_bundle_extract", reason: check.reason }, "Extraindo schemas.zip");
  const parent = path.join(appDir, "acbrlib", "data");
  fs.mkdirSync(parent, { recursive: true });
  const bak = path.join(parent, `Schemas.__old__${Date.now()}`);
  if (fs.existsSync(schemasDir)) {
    try {
      fs.renameSync(schemasDir, bak);
    } catch {
      rmrf(schemasDir);
    }
  }
  extractZip(appDir, SCHEMAS_ZIP, path.join("acbrlib", "data"));
  if (!fs.existsSync(schemasDir)) {
    if (fs.existsSync(bak)) {
      try {
        fs.renameSync(bak, schemasDir);
      } catch {
        /* ignore */
      }
    }
    throw new Error("Falha ao extrair vendor/schemas.zip");
  }
  // Solidez: mesmo assert do prepare-build após extract.
  const { assertBundledSchemas } = require("./installer-ensure-schemas");
  const checkSchemas = assertBundledSchemas(appDir, { requireNfse: true });
  if (!checkSchemas.ok) {
    if (fs.existsSync(bak) && fs.existsSync(schemasDir)) {
      try {
        rmrf(schemasDir);
        fs.renameSync(bak, schemasDir);
      } catch {
        /* ignore */
      }
    }
    throw new Error(
      checkSchemas.errors.join("; ") || "schemas inválidos após extract do ZIP",
    );
  }
  rmrf(bak);
  const expected = fs.existsSync(path.join(appDir, SCHEMAS_STAMP))
    ? fs.readFileSync(path.join(appDir, SCHEMAS_STAMP), "utf8").trim()
    : stampForZip(appDir, SCHEMAS_ZIP);
  writeText(path.join(appDir, INSTALLED_SCHEMAS_STAMP), expected);
  log({ acao: "schemas_bundle_ok" }, "Schemas extraídos do bundle");
  return { extracted: true, reason: check.reason };
}

function ensureAllBundles(appDir, opts = {}) {
  const nm = ensureNodeModulesFromBundle(appDir, opts);
  const schemas = ensureSchemasFromBundle(appDir, opts);
  return { nodeModules: nm, schemas };
}

if (require.main === module) {
  const cmd = process.argv[2] || "pack";
  const appDir = path.resolve(process.argv[3] || path.join(__dirname, ".."));
  if (cmd === "pack") {
    const r = packAll(appDir);
    console.log(
      JSON.stringify(
        {
          ok: true,
          nodeModulesMb: +(r.nodeModules.size / 1024 / 1024).toFixed(1),
          schemasMb: +(r.schemas.size / 1024 / 1024).toFixed(1),
        },
        null,
        2,
      ),
    );
  } else if (cmd === "ensure") {
    const r = ensureAllBundles(appDir, {
      log: (o, msg) => console.log(msg, o),
    });
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.error("Uso: pack|ensure [appDir]");
    process.exit(2);
  }
}

module.exports = {
  NODE_MODULES_ZIP,
  SCHEMAS_ZIP,
  NODE_MODULES_STAMP,
  SCHEMAS_STAMP,
  packAll,
  packNodeModules,
  packSchemas,
  ensureAllBundles,
  ensureNodeModulesFromBundle,
  ensureSchemasFromBundle,
  nativesFromBundleReady,
};

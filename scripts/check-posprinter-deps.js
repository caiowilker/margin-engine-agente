#!/usr/bin/env node
/**
 * Verifica ACBrPosPrinter64.dll + side DLLs + koffi (Windows).
 * Exit 0 = ok; 1 = faltando dependência.
 */
const fs = require("fs");
const path = require("path");
const { POSPRINTER_SIDE_DLLS } = require("../print/posPrinterIniDefaults");

const AGENT_ROOT = path.resolve(__dirname, "..");

function resolveLibDir() {
  if (process.env.ACBR_POSPRINTER_LIB_PATH) {
    return path.dirname(process.env.ACBR_POSPRINTER_LIB_PATH);
  }
  return path.join(AGENT_ROOT, "posprinter", "lib");
}

function checkPosprinterDeps() {
  const libDir = resolveLibDir();
  const mainDll = path.join(libDir, "ACBrPosPrinter64.dll");
  const missing = [];
  const present = [];

  if (!fs.existsSync(mainDll)) {
    missing.push(mainDll);
  } else {
    present.push(mainDll);
  }

  for (const name of POSPRINTER_SIDE_DLLS) {
    const p = path.join(libDir, name);
    if (!fs.existsSync(p)) missing.push(p);
    else present.push(p);
  }

  let koffiOk = false;
  let koffiPath = "";
  try {
    const koffiRoot = path.dirname(require.resolve("koffi/package.json"));
    koffiPath = path.join(koffiRoot, "build", "koffi", "win32_x64", "koffi.node");
    if (process.platform === "win32") {
      koffiOk = fs.existsSync(koffiPath);
      if (!koffiOk) missing.push(koffiPath);
    } else {
      koffiOk = fs.existsSync(path.join(koffiRoot, "package.json"));
      koffiPath = koffiRoot;
    }
  } catch (err) {
    missing.push(`koffi: ${err.message}`);
  }

  return {
    ok: missing.length === 0,
    libDir,
    present: present.map((p) => path.basename(p)),
    missing: missing.map((p) => (path.isAbsolute(p) ? path.basename(p) : p)),
    koffi: { ok: koffiOk, path: koffiPath },
  };
}

function main() {
  const report = checkPosprinterDeps();
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    console.error(
      "\n[PosPrinter] Dependências incompletas — reinstale o agente ou copie as DLLs para posprinter/lib/",
    );
    process.exit(1);
  }
  console.log("\n[PosPrinter] Dependências OK");
}

if (require.main === module) {
  main();
}

module.exports = { checkPosprinterDeps, resolveLibDir, POSPRINTER_SIDE_DLLS };

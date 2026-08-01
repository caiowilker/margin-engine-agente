#!/usr/bin/env node
/**
 * Prova isolada da ABI ACBrLib MT.
 * Não emite, não consulta SEFAZ e não usa a fila do agente.
 *
 * Uso Windows:
 *   node scripts/probe-acbrlib-native.js --lib "C:\...\ACBrNFe64.dll" --ini "C:\...\acbrlib.ini"
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function argument(name) {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exitCode = 1;
}

function proof(file) {
  const data = fs.readFileSync(file);
  const peOffset = data.length >= 0x40 ? data.readUInt32LE(0x3c) : 0;
  const machine = peOffset && data.length >= peOffset + 6 ? data.readUInt16LE(peOffset + 4) : null;
  return {
    path: file,
    bytes: data.length,
    sha256: crypto.createHash("sha256").update(data).digest("hex"),
    peMachine: machine === 0x8664 ? "x64" : machine ? `0x${machine.toString(16)}` : null,
  };
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log("Uso: node scripts/probe-acbrlib-native.js --lib=<ACBrNFe64.dll> --ini=<acbrlib.ini> [--cycles=3]");
    return;
  }
  const libPath = path.resolve(argument("lib") || process.env.ACBR_LIB_PATH || "");
  const iniPath = path.resolve(argument("ini") || process.env.ACBR_LIB_INI || "");
  const cycles = Math.max(1, Math.min(10, Number(argument("cycles") || 3)));
  if (!fs.existsSync(libPath) || !fs.existsSync(iniPath)) {
    throw new Error("Informe --lib e --ini existentes. O probe não usa defaults para evitar testar artefatos errados.");
  }

  const ACBrLibNFeMT = require("@projetoacbr/acbrlib-nfe-node/dist/src").default;
  const koffiVersion = require("koffi/package.json").version;
  const sourceArtifact = proof(libPath);
  if (sourceArtifact.peMachine !== "x64") {
    throw new Error(`DLL incompatível: esperado PE x64, recebido ${sourceArtifact.peMachine || "desconhecido"}`);
  }
  const runtimeEngine = require("../fiscal/drivers/acbrLibRuntime");
  const ini = runtimeEngine.readIniValues(iniPath);
  const runtime = runtimeEngine.prepareNativeRuntime({
    libPath,
    iniConfigPath: iniPath,
    assets: {
      lib: path.dirname(libPath),
      schemas: ini.pathSchemas,
      cert: ini.certFile,
      servicos: ini.servicos,
      notas: path.join(path.dirname(iniPath), "probe-notas"),
      pdf: path.join(path.dirname(iniPath), "probe-pdf"),
      log: path.join(path.dirname(iniPath), "probe-log"),
    },
    forceStaging: process.platform === "win32",
  });
  const runtimeArtifact = proof(runtime.libPath);

  const originalCwd = process.cwd();
  const result = {
    ok: false,
    operation: "Inicializar → Nome → Versão → Finalizar",
    node: process.version,
    arch: process.arch,
    koffi: koffiVersion,
    sourceArtifact,
    runtimeArtifact,
    iniPath: runtime.iniConfig,
    cycles,
    results: [],
  };
  try {
    process.chdir(runtime.root);
    for (let cycle = 1; cycle <= cycles; cycle += 1) {
      const instance = new ACBrLibNFeMT(
        path.basename(runtime.libPath),
        runtime.iniConfig,
        process.env.ACBR_LIB_CRYPT_KEY || "",
      );
      const cycleResult = { cycle, initialized: false, finalized: false };
      try {
        instance.inicializar();
        cycleResult.initialized = true;
        cycleResult.nome = instance.nome();
        cycleResult.versao = instance.versao();
      } finally {
        if (cycleResult.initialized) {
          instance.finalizar();
          cycleResult.finalized = true;
        }
      }
      result.results.push(cycleResult);
    }
    result.ok = true;
  } finally {
    process.chdir(originalCwd);
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => fail(error?.stack || error?.message || String(error)));

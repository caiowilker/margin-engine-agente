#!/usr/bin/env node
/**
 * Prova isolada da ABI ACBrLib PosPrinter (espelha probe-acbrlib-native da NFe).
 * Não imprime, não abre gaveta, não toca no fiscal/NFe.
 *
 * Uso:
 *   node scripts/probe-acbr-posprinter-native.js
 *   node scripts/probe-acbr-posprinter-native.js --lib=./posprinter/lib/ACBrPosPrinter64.dll --cycles=3
 *   node scripts/probe-acbr-posprinter-native.js --ativar   # Windows + porta configurada
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const AGENT_ROOT = path.resolve(__dirname, "..");

function argument(name) {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exitCode = 1;
}

/** Prova de artefato PE (igual probe NFe). */
function proof(file) {
  const data = fs.readFileSync(file);
  const peOffset = data.length >= 0x40 ? data.readUInt32LE(0x3c) : 0;
  const machine =
    peOffset && data.length >= peOffset + 6 ? data.readUInt16LE(peOffset + 4) : null;
  return {
    path: file,
    bytes: data.length,
    sha256: crypto.createHash("sha256").update(data).digest("hex"),
    peMachine: machine === 0x8664 ? "x64" : machine ? `0x${machine.toString(16)}` : null,
  };
}

/** Lista nomes exportados de uma DLL PE64 (read-only, funciona no Linux). */
function listPeExports(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) {
    throw new Error("Não é PE/MZ");
  }
  const e_lfanew = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(e_lfanew) !== 0x4550) throw new Error("PE signature inválida");
  const magic = buf.readUInt16LE(e_lfanew + 24);
  if (magic !== 0x20b) throw new Error("Esperado PE32+ (64-bit)");
  const exportRva = buf.readUInt32LE(e_lfanew + 24 + 112); // DataDirectory[0].VirtualAddress
  const exportSize = buf.readUInt32LE(e_lfanew + 24 + 116);
  if (!exportRva || !exportSize) return [];

  const numSections = buf.readUInt16LE(e_lfanew + 6);
  const optSize = buf.readUInt16LE(e_lfanew + 20);
  const sectionTable = e_lfanew + 24 + optSize;

  function rvaToOff(rva) {
    for (let i = 0; i < numSections; i++) {
      const off = sectionTable + i * 40;
      const virt = buf.readUInt32LE(off + 12);
      const rawSize = buf.readUInt32LE(off + 16);
      const rawPtr = buf.readUInt32LE(off + 20);
      const virtSize = buf.readUInt32LE(off + 8);
      const size = Math.max(virtSize, rawSize);
      if (rva >= virt && rva < virt + size) return rawPtr + (rva - virt);
    }
    return null;
  }

  const expOff = rvaToOff(exportRva);
  if (expOff == null) return [];
  const numNames = buf.readUInt32LE(expOff + 24);
  const namesRva = buf.readUInt32LE(expOff + 32);
  const namesOff = rvaToOff(namesRva);
  if (namesOff == null) return [];

  const names = [];
  for (let i = 0; i < numNames; i++) {
    const nameRva = buf.readUInt32LE(namesOff + i * 4);
    const nameOff = rvaToOff(nameRva);
    if (nameOff == null) continue;
    let end = nameOff;
    while (end < buf.length && buf[end] !== 0) end++;
    names.push(buf.toString("ascii", nameOff, end));
  }
  return names.sort();
}

function resolveLibPath() {
  const explicit = argument("lib") || process.env.ACBR_POSPRINTER_LIB_PATH || "";
  if (explicit && fs.existsSync(explicit)) return path.resolve(explicit);
  const candidates = [
    path.join(AGENT_ROOT, "posprinter", "lib", "ACBrPosPrinter64.dll"),
    path.join(AGENT_ROOT, "lib", "ACBrPosPrinter64.dll"),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function resolveIniPath(libPath) {
  const explicit = argument("ini") || process.env.ACBR_POSPRINTER_INI || "";
  if (explicit) return path.resolve(explicit);
  const probeDir = path.join(os.tmpdir(), `me-pos-probe-${process.pid}`);
  fs.mkdirSync(probeDir, { recursive: true });
  const ini = path.join(probeDir, "posprinter-probe.ini");
  if (!fs.existsSync(ini)) {
    fs.writeFileSync(
      ini,
      `[Principal]
TipoResposta=2
LogNivel=0
ArqLog=

[PosPrinter]
Modelo=1
Porta=
PaginaDeCodigo=2
ColunasFonteNormal=48
CortaPapel=1
TipoCorte=1
TraduzirTags=1
ControlePorta=0

[PosPrinter_Device]
BytesCount=512
BytesInterval=10
TimeOut=4
`,
      "utf8",
    );
  }
  return ini;
}

function trimBuf(buf) {
  return Buffer.isBuffer(buf)
    ? buf.toString("latin1").replace(/\0+$/, "").trim()
    : String(buf || "");
}

function assertRet(fnName, ret, ultimoFn) {
  if (ret === 0) return;
  let msg = "";
  try {
    const buf = Buffer.alloc(2048);
    const tam = [buf.length];
    ultimoFn(buf, tam);
    msg = trimBuf(buf);
  } catch (_) {}
  throw new Error(`${fnName} ret=${ret}${msg ? `: ${msg}` : ""}`);
}

async function runFfiCycles(libPath, iniPath, cycles, wantAtivar) {
  const koffi = require("koffi");
  const {
    POS_FFI_SIGNATURES,
    POS_WORKER_REQUIRED,
  } = require("../print/acbrPosExports");

  const libDir = path.dirname(libPath);
  const prevCwd = process.cwd();
  process.chdir(libDir);
  try {
    const dll = koffi.load(libPath);
    const lib = {};
    for (const name of Object.keys(POS_FFI_SIGNATURES)) {
      try {
        lib[name] = dll.func(POS_FFI_SIGNATURES[name]);
      } catch (err) {
        if (POS_WORKER_REQUIRED.has(name)) {
          throw new Error(`Export obrigatório ausente (${name}): ${err.message}`);
        }
      }
    }

    const results = [];
    for (let cycle = 1; cycle <= cycles; cycle += 1) {
      const cycleResult = {
        cycle,
        initialized: false,
        finalized: false,
        ativado: false,
      };
      try {
        assertRet(
          "POS_Inicializar",
          lib.POS_Inicializar(iniPath, process.env.ACBR_POSPRINTER_CRYPT_KEY || ""),
          lib.POS_UltimoRetorno,
        );
        cycleResult.initialized = true;

        if (lib.POS_Nome) {
          const buf = Buffer.alloc(256);
          const tam = [buf.length];
          assertRet("POS_Nome", lib.POS_Nome(buf, tam), lib.POS_UltimoRetorno);
          cycleResult.nome = trimBuf(buf);
        }
        if (lib.POS_Versao) {
          const buf = Buffer.alloc(256);
          const tam = [buf.length];
          assertRet("POS_Versao", lib.POS_Versao(buf, tam), lib.POS_UltimoRetorno);
          cycleResult.versao = trimBuf(buf);
        }

        if (wantAtivar && lib.POS_Ativar) {
          assertRet("POS_Ativar", lib.POS_Ativar(), lib.POS_UltimoRetorno);
          cycleResult.ativado = true;
          if (lib.POS_Desativar) {
            lib.POS_Desativar();
            cycleResult.ativado = false;
          }
        }
      } finally {
        if (cycleResult.initialized && lib.POS_Finalizar) {
          lib.POS_Finalizar();
          cycleResult.finalized = true;
        }
      }
      results.push(cycleResult);
    }
    return results;
  } finally {
    process.chdir(prevCwd);
  }
}

async function main() {
  if (hasFlag("help")) {
    console.log(
      "Uso: node scripts/probe-acbr-posprinter-native.js [--lib=ACBrPosPrinter64.dll] [--ini=pos.ini] [--cycles=3] [--ativar]",
    );
    return;
  }

  const libPath = resolveLibPath();
  if (!libPath) {
    throw new Error(
      "DLL não encontrada. Informe --lib=.../ACBrPosPrinter64.dll ou ACBR_POSPRINTER_LIB_PATH",
    );
  }

  const cycles = Math.max(1, Math.min(10, Number(argument("cycles") || 3)));
  const wantAtivar = hasFlag("ativar");
  const sourceArtifact = proof(libPath);
  if (sourceArtifact.peMachine !== "x64") {
    throw new Error(
      `DLL incompatível: esperado PE x64, recebido ${sourceArtifact.peMachine || "desconhecido"}`,
    );
  }

  const { POS_WORKER_REQUIRED, POS_REQUIRED_EXPORTS } = require("../print/acbrPosExports");
  const { POSPRINTER_SIDE_DLLS } = require("../print/posPrinterIniDefaults");
  const exports = listPeExports(libPath);
  const posExports = exports.filter((n) => n.startsWith("POS_"));
  const required = [...POS_WORKER_REQUIRED];
  const missingRequired = required.filter((n) => !posExports.includes(n));
  const missingCatalog = [...POS_REQUIRED_EXPORTS].filter((n) => !posExports.includes(n));

  const libDir = path.dirname(libPath);
  const sideMissing = POSPRINTER_SIDE_DLLS.filter(
    (name) => !fs.existsSync(path.join(libDir, name)),
  );

  let koffiVersion = null;
  try {
    koffiVersion = require("koffi/package.json").version;
  } catch (_) {}

  const result = {
    ok: false,
    operation: wantAtivar
      ? "Inicializar → Nome → Versão → Ativar → Desativar → Finalizar"
      : "Inicializar → Nome → Versão → Finalizar",
    node: process.version,
    arch: process.arch,
    platform: process.platform,
    koffi: koffiVersion,
    sourceArtifact,
    exports: {
      total: posExports.length,
      sample: posExports.slice(0, 12),
      missingRequired,
      missingCatalog,
    },
    sideDlls: {
      dir: libDir,
      missing: sideMissing,
    },
    cycles,
    results: [],
    ffi: { ran: false, skipped: null },
  };

  if (missingRequired.length) {
    throw new Error(`Exports obrigatórios ausentes na DLL: ${missingRequired.join(", ")}`);
  }
  if (sideMissing.length && process.platform === "win32") {
    throw new Error(`Side DLLs ausentes: ${sideMissing.join(", ")}`);
  }

  if (process.platform !== "win32") {
    result.ffi.skipped = "not_win32 — PE/exports validados; FFI koffi só no Windows";
    result.ok = true;
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const iniPath = resolveIniPath(libPath);
  result.iniPath = iniPath;
  result.results = await runFfiCycles(libPath, iniPath, cycles, wantAtivar);
  result.ffi.ran = true;
  result.ok = result.results.every((r) => r.initialized && r.finalized);
  if (!result.ok) throw new Error("Um ou mais ciclos FFI falharam");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => fail(error?.stack || error?.message || String(error)));

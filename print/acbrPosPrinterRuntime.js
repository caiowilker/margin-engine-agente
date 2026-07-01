/**
 * Runtime ACBrLib PosPrinter — FFI (Windows + DLL).
 * API alinhada à documentação ACBrLibPosPrinter (POS_*).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveStagingDir } = require("../runtime/windowsEnv");

const AGENT_ROOT = path.resolve(__dirname, "..");

function isUncPath(p) {
  return /wsl\.localhost|wsl\$|^\\\\/i.test(String(p || ""));
}

function defaultLibName() {
  return os.platform() === "win32" ? "ACBrPosPrinter64.dll" : "libacbrposprinter64.so";
}

function resolveLibPath() {
  const explicit = process.env.ACBR_POSPRINTER_LIB_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const candidates = [
    path.join(AGENT_ROOT, "posprinter", "lib", defaultLibName()),
    path.join(AGENT_ROOT, "lib", defaultLibName()),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function resolveIniPath() {
  const explicit = process.env.ACBR_POSPRINTER_INI;
  if (explicit) return explicit;
  const candidates = [path.join(AGENT_ROOT, "data", "posprinter.ini")];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}

function copyFileEnsureDir(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else copyFileEnsureDir(s, d);
  }
}

function prepareRuntimePaths() {
  const sourceLib = resolveLibPath();
  if (!sourceLib) return { libPath: null, iniPath: resolveIniPath(), staged: false };

  const iniPath = resolveIniPath();
  const shouldStage =
    process.platform === "win32" &&
    (isUncPath(sourceLib) || isUncPath(iniPath) || process.env.ACBR_POS_WIN_STAGING);

  if (!shouldStage) {
    return { libPath: sourceLib, iniPath, root: path.dirname(sourceLib), staged: false };
  }

  const staging =
    process.env.ACBR_POS_WIN_STAGING || resolveStagingDir("margin-acbr-posprinter");
  copyDirRecursive(path.dirname(sourceLib), staging);
  const stagedLib = path.join(staging, path.basename(sourceLib));
  fs.mkdirSync(path.dirname(iniPath), { recursive: true });
  if (fs.existsSync(iniPath) && !String(iniPath).startsWith(staging)) {
    copyFileEnsureDir(iniPath, path.join(staging, "config", path.basename(iniPath)));
  }
  const stagedIni = path.join(staging, "config", path.basename(iniPath));
  return {
    libPath: fs.existsSync(stagedLib) ? stagedLib : sourceLib,
    iniPath: fs.existsSync(stagedIni) ? stagedIni : iniPath,
    root: staging,
    staged: true,
  };
}

function canLoadNativeLib() {
  if (process.platform !== "win32") return false;
  return !!resolveLibPath();
}

function createBindings(ffi, ref, libPath) {
  const CString = ref.refType(ref.types.CString);
  const tInt = ref.refType("int");
  const tLong = ref.refType("int");

  return ffi.Library(libPath, {
    POS_Inicializar: ["int", ["string", "string"]],
    POS_Finalizar: ["int", []],
    POS_Nome: ["int", [CString, tInt]],
    POS_Versao: ["int", [CString, tInt]],
    POS_UltimoRetorno: ["int", [CString, tInt]],
    POS_ConfigLer: ["int", ["string"]],
    POS_ConfigGravar: ["int", ["string"]],
    POS_ConfigGravarValor: ["int", ["string", "string", "string"]],
    POS_Ativar: ["int", []],
    POS_Desativar: ["int", []],
    POS_Zerar: ["int", []],
    POS_InicializarPos: ["int", []],
    POS_Reset: ["int", []],
    POS_PularLinhas: ["int", ["int"]],
    POS_CortarPapel: ["int", ["bool"]],
    POS_AbrirGaveta: ["int", []],
    POS_LerInfoImpressora: ["int", [CString, tInt]],
    POS_LerStatusImpressoraFormatado: ["int", ["int", CString, tInt]],
    POS_AcharPortas: ["int", [CString, tInt]],
    POS_PodeLerDaPorta: ["int", []],
    POS_LerCaracteristicas: ["int", [CString, tInt]],
    POS_GravarLogoArquivo: ["int", ["string", "int", "int"]],
    POS_ImprimirLogo: ["int", ["int", "int", "int", "int"]],
    POS_Imprimir: ["int", ["string", "bool", "bool", "bool", "int"]],
    POS_ImprimirLinha: ["int", ["string"]],
    POS_ImprimirCmd: ["int", ["string"]],
  });
}

function loadLib() {
  if (!canLoadNativeLib()) return null;
  try {
    const ffi = require("ffi-napi");
    const ref = require("ref-napi");
    const paths = prepareRuntimePaths();
    if (!paths.libPath) return null;
    return {
      lib: createBindings(ffi, ref, paths.libPath),
      ref,
      libPath: paths.libPath,
      iniPath: paths.iniPath,
      root: paths.root,
      staged: paths.staged,
    };
  } catch (err) {
    return { error: err.message };
  }
}

function promisify(fn, ...args) {
  return new Promise((resolve, reject) => {
    fn(...args, (err, ret) => {
      if (err) return reject(err);
      resolve(ret);
    });
  });
}

function trimBuf(buf) {
  return Buffer.isBuffer(buf) ? buf.toString().replace(/\0+$/, "").trim() : String(buf || "");
}

async function ultimoRetorno(libBundle) {
  const buf = Buffer.alloc(8192);
  const tam = libBundle.ref.alloc("int", 8192);
  await promisify(libBundle.lib.POS_UltimoRetorno.async.bind(libBundle.lib.POS_UltimoRetorno), buf, tam);
  return trimBuf(buf);
}

async function readStringOut(libBundle, fn, ...args) {
  const buf = Buffer.alloc(8192);
  const tam = libBundle.ref.alloc("int", 8192);
  const ret = await promisify(fn.bind(libBundle.lib), ...args, buf, tam);
  if (ret !== 0) {
    const msg = await ultimoRetorno(libBundle);
    const err = new Error(`${fn.name || "POS"} falhou (${ret}): ${msg || ret}`);
    err.acbrRet = ret;
    throw err;
  }
  const text = trimBuf(buf);
  if (text) return text;
  return ultimoRetorno(libBundle);
}

async function callPos(libBundle, fn, ...args) {
  const ret = await promisify(fn.bind(libBundle.lib), ...args);
  if (ret !== 0) {
    const msg = await ultimoRetorno(libBundle);
    const err = new Error(`${fn.name || "POS"} falhou (${ret}): ${msg || ret}`);
    err.acbrRet = ret;
    throw err;
  }
  return ret;
}

async function gravarConfigIni(libBundle, iniPath, values) {
  for (const [sec, keys] of Object.entries(values)) {
    for (const [key, val] of Object.entries(keys)) {
      try {
        await promisify(
          libBundle.lib.POS_ConfigGravarValor.async.bind(libBundle.lib.POS_ConfigGravarValor),
          sec,
          key,
          String(val),
        );
      } catch (_) {
        /* opcional por versão */
      }
    }
  }
  await promisify(libBundle.lib.POS_ConfigGravar.async.bind(libBundle.lib.POS_ConfigGravar), iniPath);
}

function defaultIniContent() {
  return `[Principal]
TipoResposta=2
LogNivel=4

[PosPrinter]
Modelo=0
Porta=RAW:
PaginaDeCodigo=2
ColunasFonteNormal=48
CortaPapel=1
TraduzirTags=1
ControlePorta=1
`;
}

function buildRuntimeValues() {
  let local = null;
  try {
    local = require("./printerLocalConfig").ler();
  } catch (_) {}
  const model = local?.modelo || process.env.PRINTER_MODEL || "0";
  let porta =
    local?.porta ||
    process.env.PRINTER_PORTA ||
    process.env.PRINTER_PATH ||
    "";
  const hostRede = (process.env.PRINTER_HOST || "").trim();
  if (hostRede && (!porta || /^USB$/i.test(porta))) {
    porta = `TCP:${hostRede}:${process.env.PRINTER_PORT || "9100"}`;
  }
  if (!porta && hostRede) {
    porta = `TCP:${hostRede}:${process.env.PRINTER_PORT || "9100"}`;
  }
  if (!porta && process.env.PRINTER_NAME) {
    porta = `RAW:${process.env.PRINTER_NAME}`;
  }
  if (!porta) porta = "USB";

  const enc = local?.encoding || process.env.PRINTER_ENCODING || "850";
  const pageCode = enc === "UTF8" || enc === "utf8" ? "5" : enc === "1252" ? "6" : "2";
  const cut = local?.cut || process.env.PRINTER_CUT || "partial";

  const values = {
    PosPrinter: {
      Modelo: model,
      Porta: porta,
      PaginaDeCodigo: pageCode,
      ColunasFonteNormal: local?.colunas || process.env.PRINTER_COLUNAS || "48",
      CortaPapel: cut === "total" ? "0" : "1",
      TraduzirTags: "1",
      ControlePorta: "1",
      LinhasBuffer: process.env.PRINTER_BUFFER_LINES || "0",
      VerificarImpressora: process.env.PRINTER_VERIFICAR === "true" ? "1" : "0",
      TipoCorte: cut === "partial" ? "1" : "0",
    },
  };

  if (local?.baud) {
    values.PosPrinter_Device = {
      Baud: local.baud,
      Parity: local.parity || "0",
      Stop: local.stopBits || "0",
      HandShake: local.handshake || "0",
      TimeOut: local.timeout || "3",
    };
  }

  return values;
}

async function withPosPrinterSession(fn) {
  const bundle = loadLib();
  if (!bundle || bundle.error) {
    throw new Error(
      bundle?.error ||
        "[ACBrPosPrinter] Biblioteca nativa não encontrada — configure ACBR_POSPRINTER_LIB_PATH",
    );
  }
  const iniPath = bundle.iniPath || resolveIniPath();
  fs.mkdirSync(path.dirname(iniPath), { recursive: true });
  if (!fs.existsSync(iniPath)) {
    fs.writeFileSync(iniPath, defaultIniContent(), "utf8");
  }

  const cwdBefore = process.cwd();
  const libDir = bundle.root || path.dirname(bundle.libPath);
  const cryptKey = process.env.ACBR_POSPRINTER_CRYPT_KEY || process.env.ACBR_LIB_CRYPT_KEY || "";

  try {
    if (fs.existsSync(libDir)) process.chdir(libDir);
    const iniForLib =
      bundle.staged && bundle.root && String(iniPath).startsWith(bundle.root)
        ? path.relative(bundle.root, iniPath)
        : iniPath;

    await callPos(bundle, bundle.lib.POS_Inicializar.async, iniForLib, cryptKey);
    await gravarConfigIni(bundle, iniForLib, buildRuntimeValues());
    await callPos(bundle, bundle.lib.POS_Ativar.async);

    try {
      return await fn(bundle);
    } finally {
      try {
        await promisify(bundle.lib.POS_Desativar.async.bind(bundle.lib.POS_Desativar));
      } catch (_) {}
      try {
        await promisify(bundle.lib.POS_Finalizar.async.bind(bundle.lib.POS_Finalizar));
      } catch (_) {}
    }
  } finally {
    try {
      process.chdir(cwdBefore);
    } catch (_) {}
  }
}

async function imprimirTagsNative(tags) {
  return withPosPrinterSession(async (bundle) => {
    await callPos(bundle, bundle.lib.POS_InicializarPos.async);
    await callPos(bundle, bundle.lib.POS_Imprimir.async, tags, true, true, false, 1);
    return { ok: true, native: true };
  });
}

async function abrirGavetaNative() {
  return withPosPrinterSession(async (bundle) => {
    await callPos(bundle, bundle.lib.POS_AbrirGaveta.async);
    return { ok: true, native: true };
  });
}

async function lerStatusFormatadoNative(tentativas = 3) {
  return withPosPrinterSession(async (bundle) => {
    const raw = await readStringOut(
      bundle,
      bundle.lib.POS_LerStatusImpressoraFormatado.async,
      tentativas,
    );
    const fields = [
      "erro",
      "apenasEscrita",
      "poucoPapel",
      "semPapel",
      "gavetaAberta",
      "imprimindo",
      "offLine",
      "tampaAberta",
      "erroLeitura",
      "slip",
      "micr",
      "aguardandoSlip",
      "tof",
      "bof",
    ];
    const vals = String(raw || "")
      .split("|")
      .map((v) => parseInt(v, 10));
    const status = {};
    fields.forEach((name, i) => {
      status[name] = Number.isFinite(vals[i]) ? vals[i] : -1;
    });
    return { raw, status, ok: status.erro !== 1 && status.semPapel !== 1 };
  });
}

async function acharPortasNative() {
  return withPosPrinterSession(async (bundle) => {
    const raw = await readStringOut(bundle, bundle.lib.POS_AcharPortas.async);
    return { portas: String(raw || "").split("|").filter(Boolean), raw };
  });
}

async function lerInfoImpressoraNative() {
  return withPosPrinterSession(async (bundle) => {
    const raw = await readStringOut(bundle, bundle.lib.POS_LerInfoImpressora.async);
    return { raw };
  });
}

async function gravarLogoArquivoNative(bmpPath, kc1, kc2) {
  return withPosPrinterSession(async (bundle) => {
    await callPos(bundle, bundle.lib.POS_GravarLogoArquivo.async, bmpPath, kc1, kc2);
    return { ok: true, native: true };
  });
}

async function lerVersaoNative() {
  return withPosPrinterSession(async (bundle) => {
    const nome = await readStringOut(bundle, bundle.lib.POS_Nome.async);
    const versao = await readStringOut(bundle, bundle.lib.POS_Versao.async);
    return { nome, versao };
  });
}

module.exports = {
  canLoadNativeLib,
  resolveLibPath,
  resolveIniPath,
  prepareRuntimePaths,
  loadLib,
  withPosPrinterSession,
  imprimirTagsNative,
  abrirGavetaNative,
  lerStatusFormatadoNative,
  acharPortasNative,
  lerInfoImpressoraNative,
  gravarLogoArquivoNative,
  lerVersaoNative,
  buildRuntimeValues,
};

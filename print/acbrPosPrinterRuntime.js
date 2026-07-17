/**
 * Runtime ACBrLib PosPrinter — FFI (Windows + DLL).
 * API alinhada à documentação ACBrLibPosPrinter (POS_*).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveStagingDir } = require("../runtime/windowsEnv");
const { formatAcbrPosError } = require("./acbrPosPrinterErrors");
const { resolveControlePorta } = require("./printerModelMap");

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
    const values = buildRuntimeValues();
    throw formatAcbrPosError(fn.name || "POS", ret, msg, {
      porta: values.PosPrinter?.Porta,
      modelo: values.PosPrinter?.Modelo,
    });
  }
  const text = trimBuf(buf);
  if (text) return text;
  return ultimoRetorno(libBundle);
}

async function callPos(libBundle, fn, ...args) {
  const ret = await promisify(fn.bind(libBundle.lib), ...args);
  if (ret !== 0) {
    const msg = await ultimoRetorno(libBundle);
    const values = buildRuntimeValues();
    throw formatAcbrPosError(fn.name || "POS", ret, msg, {
      porta: values.PosPrinter?.Porta,
      modelo: values.PosPrinter?.Modelo,
    });
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

function syncIniFromSource(bundle, iniPath) {
  if (!bundle?.staged || !iniPath) return;
  const sourceIni = resolveIniPath();
  if (!sourceIni || sourceIni === iniPath || !fs.existsSync(sourceIni)) return;
  try {
    copyFileEnsureDir(sourceIni, iniPath);
  } catch (_) {
    /* staging opcional */
  }
}

function syncIniToSource(bundle, iniPath) {
  if (!bundle?.staged || !iniPath || !fs.existsSync(iniPath)) return;
  const sourceIni = resolveIniPath();
  if (!sourceIni || sourceIni === iniPath) return;
  try {
    fs.mkdirSync(path.dirname(sourceIni), { recursive: true });
    copyFileEnsureDir(iniPath, sourceIni);
  } catch (_) {
    /* best-effort */
  }
}

async function ativarComConfig(bundle, iniForLib, iniPathDisk) {
  const { portaAcbrValida } = require("./printerModelMap");
  const values = buildRuntimeValues();
  const porta = values.PosPrinter?.Porta || "";
  if (!portaAcbrValida(porta)) {
    throw formatAcbrPosError("Config", -10, "Porta não definida", {
      porta: porta || "(vazio)",
      modelo: values.PosPrinter?.Modelo,
    });
  }
  await gravarConfigIni(bundle, iniForLib, values);
  if (iniPathDisk) syncIniToSource(bundle, iniPathDisk);
  try {
    await promisify(bundle.lib.POS_Desativar.async.bind(bundle.lib.POS_Desativar));
  } catch (_) {
    /* primeira ativação */
  }
  await callPos(bundle, bundle.lib.POS_Ativar.async);
}

function defaultIniContent() {
  return `[Principal]
TipoResposta=2
LogNivel=4

[PosPrinter]
Modelo=0
Porta=USB
PaginaDeCodigo=2
ColunasFonteNormal=48
CortaPapel=1
TraduzirTags=1
ControlePorta=0
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
  try {
    const override = require("./printerStationRoutes").getPortaOverride();
    if (override) porta = override;
  } catch (_) {
    /* módulo opcional */
  }
  const { portaAcbrValida, normalizarPortaAcbr } = require("./printerModelMap");
  if (!portaAcbrValida(porta) && process.env.PRINTER_NAME) {
    porta = normalizarPortaAcbr(`RAW:${process.env.PRINTER_NAME}`, {
      nomeWindows: process.env.PRINTER_NAME,
    });
  }
  if (!portaAcbrValida(porta) && process.env.PRINTER_HOST) {
    porta = `TCP:${process.env.PRINTER_HOST}:${process.env.PRINTER_PORT || "9100"}`;
  }
  if (!portaAcbrValida(porta)) {
    const inferred = require("./printerModelMap").inferirPortaAcbr({
      nomeWindows: process.env.PRINTER_NAME,
    });
    if (portaAcbrValida(inferred)) porta = inferred;
  }
  if (!portaAcbrValida(porta) && process.platform !== "win32") {
    porta = "USB";
  }

  const enc = local?.encoding || process.env.PRINTER_ENCODING || "850";
  const pageCode = enc === "UTF8" || enc === "utf8" ? "5" : enc === "1252" ? "6" : "2";
  const cut = local?.cut || process.env.PRINTER_CUT || "partial";
  const controlePorta = resolveControlePorta(porta);
  const verificarImpressora =
    process.env.PRINTER_VERIFICAR === "true"
      ? "1"
      : /^RAW:/i.test(porta)
        ? "1"
        : "0";

  const values = {
    PosPrinter: {
      Modelo: model,
      Porta: porta,
      PaginaDeCodigo: pageCode,
      ColunasFonteNormal: local?.colunas || process.env.PRINTER_COLUNAS || "48",
      CortaPapel: cut === "total" ? "0" : "1",
      TraduzirTags: "1",
      ControlePorta: controlePorta,
      LinhasBuffer: process.env.PRINTER_BUFFER_LINES || "0",
      VerificarImpressora: verificarImpressora,
      TipoCorte: cut === "partial" ? "1" : "0",
    },
  };

  const serial = local?.serial || {};
  const baud = serial.baud || local?.baud;
  if (baud) {
    values.PosPrinter_Device = {
      Baud: baud,
      Parity: serial.parity || local?.parity || "0",
      Stop: serial.stopBits || local?.stopBits || "0",
      HandShake: serial.handshake || local?.handshake || "0",
      TimeOut: serial.timeout || local?.timeout || "3",
    };
  }

  return values;
}

async function withPosPrinterSession(fn, opts = {}) {
  const SESSION_IDLE_MS = parseInt(process.env.ACBR_POS_SESSION_IDLE_MS || "45000", 10);
  let _activeSession = withPosPrinterSession._session;
  let _refCount = withPosPrinterSession._refCount || 0;
  let _idleTimer = withPosPrinterSession._idleTimer;

  function configKey() {
    return JSON.stringify(buildRuntimeValues());
  }

  async function teardownSession(sess) {
    if (!sess?.bundle) return;
    try {
      await promisify(sess.bundle.lib.POS_Desativar.async.bind(sess.bundle.lib.POS_Desativar));
    } catch (_) {}
    try {
      await promisify(sess.bundle.lib.POS_Finalizar.async.bind(sess.bundle.lib.POS_Finalizar));
    } catch (_) {}
    try {
      if (sess.cwdBefore) process.chdir(sess.cwdBefore);
    } catch (_) {}
    if (withPosPrinterSession._session === sess) {
      withPosPrinterSession._session = null;
    }
  }

  function sessaoCurtaRaw() {
    if (process.env.ACBR_POS_SESSION_PER_JOB === "false") return false;
    const porta = buildRuntimeValues().PosPrinter?.Porta || "";
    return /^RAW:/i.test(porta);
  }

  function scheduleIdle(sess) {
    if (_idleTimer) clearTimeout(_idleTimer);
    _idleTimer = setTimeout(() => {
      withPosPrinterSession._idleTimer = null;
      if ((withPosPrinterSession._refCount || 0) <= 0 && withPosPrinterSession._session) {
        teardownSession(withPosPrinterSession._session).catch(() => {});
      }
    }, SESSION_IDLE_MS);
    withPosPrinterSession._idleTimer = _idleTimer;
  }

  const key = configKey();
  if (_activeSession && _activeSession.configKey !== key) {
    await teardownSession(_activeSession);
    _activeSession = null;
    withPosPrinterSession._session = null;
  }

  if (!_activeSession) {
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

    if (fs.existsSync(libDir)) process.chdir(libDir);
    const iniForLib =
      bundle.staged && bundle.root && String(iniPath).startsWith(bundle.root)
        ? path.relative(bundle.root, iniPath)
        : iniPath;

    syncIniFromSource(bundle, iniPath);
    await callPos(bundle, bundle.lib.POS_Inicializar.async, iniForLib, cryptKey);
    await ativarComConfig(bundle, iniForLib, iniPath);

    _activeSession = { bundle, configKey: key, cwdBefore, iniForLib, iniPath };
    withPosPrinterSession._session = _activeSession;
  }

  withPosPrinterSession._refCount = (_refCount += 1);
  if (_idleTimer) {
    clearTimeout(_idleTimer);
    withPosPrinterSession._idleTimer = null;
  }

  try {
    return await fn(_activeSession.bundle);
  } catch (err) {
    const invalidate =
      opts.invalidateOnError ||
      /porta|offline|inicializar|ativar|desativar|finalizar|pos_imprimir/i.test(
        String(err?.message || ""),
      );
    if (invalidate && _activeSession) {
      await teardownSession(_activeSession);
      withPosPrinterSession._session = null;
      _activeSession = null;
    }
    throw err;
  } finally {
    withPosPrinterSession._refCount = Math.max(0, (withPosPrinterSession._refCount || 1) - 1);
    const sess = withPosPrinterSession._session;
    if (sess) {
      if (sessaoCurtaRaw() && withPosPrinterSession._refCount <= 0) {
        if (_idleTimer) {
          clearTimeout(_idleTimer);
          withPosPrinterSession._idleTimer = null;
        }
        teardownSession(sess).catch(() => {});
      } else {
        scheduleIdle(sess);
      }
    }
  }
}

async function assertPortaLegivel(bundle) {
  const porta = buildRuntimeValues().PosPrinter?.Porta || "";
  if (/^RAW:/i.test(porta) || !bundle?.lib?.POS_PodeLerDaPorta?.async) return;
  const ret = await promisify(bundle.lib.POS_PodeLerDaPorta.async.bind(bundle.lib.POS_PodeLerDaPorta));
  if (ret === 0) return;
  const msg = await ultimoRetorno(bundle);
  const values = buildRuntimeValues();
  throw formatAcbrPosError("POS_PodeLerDaPorta", ret, msg, {
    porta: values.PosPrinter?.Porta,
    modelo: values.PosPrinter?.Modelo,
  });
}

async function imprimirTagsNativeOnce(bundle, tags) {
  const sess = withPosPrinterSession._session;
  if (sess?.iniForLib) {
    await ativarComConfig(bundle, sess.iniForLib, sess.iniPath);
  }
  await assertPortaLegivel(bundle);
  await callPos(bundle, bundle.lib.POS_InicializarPos.async);
  await callPos(bundle, bundle.lib.POS_Imprimir.async, tags, true, true, false, 1);
  return { ok: true, native: true };
}

function erroPortaRecuperavel(err) {
  const msg = String(err?.message || "");
  return err?.acbrRet === -10 || /porta.*n[aã]o definida|PRINTER_PORTA_INDEFINIDA/i.test(msg);
}

async function imprimirTagsNative(tags) {
  const maxTentativas = parseInt(process.env.ACBR_POS_PRINT_RETRIES || "3", 10);
  let lastErr;

  for (let attempt = 1; attempt <= maxTentativas; attempt++) {
    try {
      await require("./printerBootstrap").garantirPortaImpressao({
        skipDetect: attempt === 1,
        force: attempt > 1,
      });
      return await withPosPrinterSession(async (bundle) => imprimirTagsNativeOnce(bundle, tags), {
        invalidateOnError: attempt < maxTentativas,
      });
    } catch (err) {
      lastErr = err;
      if (!erroPortaRecuperavel(err) || attempt >= maxTentativas) throw err;
      await invalidatePosPrinterSession();
      await new Promise((r) => setTimeout(r, 250 * attempt));
      try {
        await require("./printerBootstrap").autoDetectarESincronizar({ force: attempt >= 2 });
      } catch (_) {}
      try {
        require("./factory").resetPrintProvider();
      } catch (_) {}
    }
  }
  throw lastErr;
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

async function invalidatePosPrinterSession() {
  const sess = withPosPrinterSession._session;
  if (!sess?.bundle) return;
  withPosPrinterSession._refCount = 0;
  try {
    await promisify(sess.bundle.lib.POS_Desativar.async.bind(sess.bundle.lib.POS_Desativar));
  } catch (_) {}
  try {
    await promisify(sess.bundle.lib.POS_Finalizar.async.bind(sess.bundle.lib.POS_Finalizar));
  } catch (_) {}
  try {
    if (sess.cwdBefore) process.chdir(sess.cwdBefore);
  } catch (_) {}
  withPosPrinterSession._session = null;
  if (withPosPrinterSession._idleTimer) {
    clearTimeout(withPosPrinterSession._idleTimer);
    withPosPrinterSession._idleTimer = null;
  }
}

module.exports = {
  canLoadNativeLib,
  resolveLibPath,
  resolveIniPath,
  prepareRuntimePaths,
  loadLib,
  withPosPrinterSession,
  invalidatePosPrinterSession,
  imprimirTagsNative,
  abrirGavetaNative,
  lerStatusFormatadoNative,
  acharPortasNative,
  lerInfoImpressoraNative,
  gravarLogoArquivoNative,
  lerVersaoNative,
  buildRuntimeValues,
};

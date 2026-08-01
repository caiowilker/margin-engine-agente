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
const {
  resolveLogNivel,
  resolveDeviceTimeout,
  buildDeviceRuntimeValues,
} = require("./posPrinterIniDefaults");
const log = require("../logger").child({ modulo: "acbr_posprinter_runtime" });

const AGENT_ROOT = path.resolve(__dirname, "..");

/** Fase atual da sessão PosPrinter — usada pelo executor p/ fallback pré-impressão. */
let _acbrPrintPhase = "idle";

function setAcbrPrintPhase(phase) {
  _acbrPrintPhase = String(phase || "idle");
}

function getAcbrPrintPhase() {
  return _acbrPrintPhase;
}

function annotateAcbrError(err) {
  if (err && typeof err === "object" && err.acbrPhase == null) {
    err.acbrPhase = _acbrPrintPhase;
  }
  return err;
}

function isUncPath(p) {
  return /wsl\.localhost|wsl\$|^\\\\/i.test(String(p || ""));
}

function defaultLibName() {
  return os.platform() === "win32" ? "ACBrPosPrinter64.dll" : "libacbrposprinter64.so";
}

function resolveLibPath() {
  const explicit = process.env.ACBR_POSPRINTER_LIB_PATH;
  const candidates = [
    explicit && fs.existsSync(explicit) ? explicit : null,
    path.join(AGENT_ROOT, "posprinter", "lib", defaultLibName()),
    path.join(AGENT_ROOT, "lib", defaultLibName()),
  ].filter(Boolean);

  // Em Windows, nunca preferir UNC/WSL se houver DLL local (spooler/FFI quebram).
  if (process.platform === "win32") {
    const local = candidates.find((p) => fs.existsSync(p) && !isUncPath(p));
    if (local) return local;
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) =>
    path.normalize(String(p).replace(/\\\\/g, "\\")).toLowerCase();
  return norm(a) === norm(b);
}

function isUnderDir(filePath, dir) {
  if (!filePath || !dir) return false;
  const f = path.normalize(filePath).toLowerCase();
  const d = path.normalize(dir).toLowerCase();
  return f === d || f.startsWith(d + path.sep);
}

/**
 * SSOT do posprinter.ini:
 * - Preferir %ProgramData%\MarginEngine\Config (sobrevive a update do instalador).
 * - ACBR_POSPRINTER_INI em install dir (legado) é migrado — Win10 perdia config no update.
 * - Override de teste: caminho fora de AGENT_ROOT e fora de ProgramData.
 */
function resolveIniPath() {
  const explicit = String(process.env.ACBR_POSPRINTER_INI || "").trim();
  const legacyIni = path.join(AGENT_ROOT, "data", "posprinter.ini");

  let programDataIni = null;
  let programDataRoot = null;
  try {
    const { getDirectoryManager } = require("../runtime/directoryManager");
    const dm = getDirectoryManager();
    dm.ensurePath(dm.PATHS.config, "config");
    programDataIni = path.join(dm.PATHS.config, "posprinter.ini");
    programDataRoot = dm.PATHS.root || path.dirname(dm.PATHS.config);
  } catch (_) {
    /* testes / boot precoce */
  }

  // Testes / override explícito fora do install e do ProgramData.
  if (
    explicit &&
    programDataIni &&
    !samePath(explicit, programDataIni) &&
    !samePath(explicit, legacyIni) &&
    !isUnderDir(explicit, AGENT_ROOT) &&
    !isUnderDir(explicit, programDataRoot)
  ) {
    return path.normalize(explicit);
  }

  if (programDataIni) {
    if (!fs.existsSync(programDataIni)) {
      const sources = [explicit, legacyIni].filter(
        (p) => p && fs.existsSync(p) && !samePath(p, programDataIni),
      );
      for (const src of sources) {
        try {
          fs.mkdirSync(path.dirname(programDataIni), { recursive: true });
          fs.copyFileSync(src, programDataIni);
          break;
        } catch (_) {
          /* tenta próximo */
        }
      }
    }
    // Runtime aponta para ProgramData; .env é alinhado em sanitizarConfigPersistida.
    if (!samePath(process.env.ACBR_POSPRINTER_INI, programDataIni)) {
      process.env.ACBR_POSPRINTER_INI = programDataIni;
    }
    return programDataIni;
  }

  if (explicit) return path.normalize(explicit);
  return legacyIni;
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
  const stagedLib = path.join(staging, path.basename(sourceLib));
  const sessionActive = !!withPosPrinterSession._session;
  const dllPinned = withPosPrinterSession._dllPinned === true;
  let workerOwns = false;
  try {
    workerOwns = require("./acbrPosWorkerPool").isPosWorkerEnabled() === true;
  } catch (_) {
    /* pool ausente em testes */
  }
  // Worker mapeia a DLL no processo filho — nunca refresh mtime enquanto staged existe.
  const blockOverwrite =
    sessionActive || dllPinned || (workerOwns && fs.existsSync(stagedLib));

  // Nunca sobrescrever DLL PosPrinter com sessão/worker mapeando a lib.
  const needsLib =
    !fs.existsSync(stagedLib) ||
    (() => {
      try {
        const s = fs.statSync(sourceLib);
        const d = fs.statSync(stagedLib);
        return s.size !== d.size || Math.floor(s.mtimeMs) > Math.floor(d.mtimeMs) + 500;
      } catch (_) {
        return true;
      }
    })();

  if (!blockOverwrite && needsLib) {
    copyDirRecursive(path.dirname(sourceLib), staging);
  } else if (!fs.existsSync(stagedLib)) {
    copyFileEnsureDir(sourceLib, stagedLib);
  }

  fs.mkdirSync(path.dirname(iniPath), { recursive: true });
  if (fs.existsSync(iniPath) && !String(iniPath).startsWith(staging)) {
    const destIni = path.join(staging, "config", path.basename(iniPath));
    try {
      if (
        !fs.existsSync(destIni) ||
        fs.statSync(iniPath).size !== fs.statSync(destIni).size
      ) {
        copyFileEnsureDir(iniPath, destIni);
      }
    } catch (_) {
      copyFileEnsureDir(iniPath, destIni);
    }
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
  if (!resolveLibPath()) return false;
  return canRequireFfiBindings();
}

/**
 * koffi traz prebuild Windows — não exige VS Build Tools (ao contrário de ffi-napi).
 * Instalador/Reparar passam a funcionar com `npm ci` simples.
 */
let _ffiBindingsOk = undefined;
let _ffiBindingsErr = null;
let _ffiLoading = false;

function canRequireFfiBindings() {
  if (_ffiBindingsOk !== undefined) return _ffiBindingsOk;
  // Reentrada durante o load do koffi — NÃO cachear false (senão envenena o processo)
  if (_ffiLoading) return false;
  _ffiLoading = true;
  const cwdBefore = process.cwd();
  try {
    // Serviço node-windows inicia com cwd=System32 — koffi/cnoke estoura stack
    try {
      if (cwdBefore.toLowerCase() !== AGENT_ROOT.toLowerCase()) {
        process.chdir(AGENT_ROOT);
      }
    } catch (_) {}
    require("koffi");
    if (process.platform === "win32") {
      const koffiRoot = path.dirname(require.resolve("koffi/package.json"));
      const winNode = path.join(koffiRoot, "build", "koffi", "win32_x64", "koffi.node");
      if (!fs.existsSync(winNode)) {
        _ffiBindingsOk = false;
        _ffiBindingsErr = `koffi.node ausente: ${winNode}`;
        return false;
      }
    }
    _ffiBindingsOk = true;
    _ffiBindingsErr = null;
  } catch (e) {
    _ffiBindingsOk = false;
    _ffiBindingsErr = String(e && e.message ? e.message : e);
    try {
      const dump = path.join(
        process.env.PROGRAMDATA || "C:\\ProgramData",
        "MarginEngine",
        "Logs",
        "koffi-load-error.txt",
      );
      fs.mkdirSync(path.dirname(dump), { recursive: true });
      fs.writeFileSync(
        dump,
        `${new Date().toISOString()}\n${_ffiBindingsErr}\n${e && e.stack ? e.stack : ""}\n` +
          `main=${process.mainModule && process.mainModule.filename}\ncwd=${process.cwd()}\nagentRoot=${AGENT_ROOT}\n`,
        "utf8",
      );
    } catch (_) {}
  } finally {
    _ffiLoading = false;
    try {
      if (cwdBefore && process.cwd() !== cwdBefore) process.chdir(cwdBefore);
    } catch (_) {}
  }
  return _ffiBindingsOk;
}

function getFfiBindingsError() {
  canRequireFfiBindings();
  return _ffiBindingsErr;
}

/**
 * Expõe `.async(...args, cb)` compatível com promisify/callPos.
 *
 * IMPORTANTE (koffi ≥2): `fn.async` NÃO retorna Promise — exige callback
 * `(err, res)` como último argumento. Remover o callback gera
 * "Expected N+1 arguments, got N" (ex.: POS_Inicializar → Expected 3, got 2)
 * e o executor cai no fallback native.
 *
 * @see https://koffi.dev/functions#asynchronous-calls
 */
function wrapKoffiFunc(nativeFn, exportName = "POS") {
  const sync = (...args) => nativeFn(...args);
  try {
    Object.defineProperty(sync, "name", { value: exportName, configurable: true });
  } catch (_) {
    /* ignore */
  }
  sync.async = function posAsync(...args) {
    const maybeCb = args[args.length - 1];
    if (typeof maybeCb === "function") {
      // Caminho principal: repassa args + callback para o async nativo do koffi
      try {
        return nativeFn.async(...args);
      } catch (e) {
        // Erro síncrono (arity etc.) → callback no próximo tick (padrão Node)
        setImmediate(() => maybeCb(e));
        return undefined;
      }
    }
    // Conveniência: await fn.async(...args) sem callback
    return new Promise((resolve, reject) => {
      try {
        nativeFn.async(...args, (err, ret) => {
          if (err) reject(err);
          else resolve(ret);
        });
      } catch (e) {
        reject(e);
      }
    });
  };
  try {
    Object.defineProperty(sync.async, "name", {
      value: `${exportName}.async`,
      configurable: true,
    });
  } catch (_) {
    /* ignore */
  }
  return sync;
}

const {
  POS_FFI_SIGNATURES,
  POS_REQUIRED_EXPORTS,
} = require("./acbrPosExports");

function createBindings(libPath) {
  const koffi = require("koffi");
  const dll = koffi.load(libPath);

  // Catálogo completo (docs/ACBRLIB-POSPRINTER.md) — cdecl; buffers Buffer + int[1]
  const lib = {};
  for (const [name, sig] of Object.entries(POS_FFI_SIGNATURES)) {
    try {
      lib[name] = wrapKoffiFunc(dll.func(sig), name);
    } catch (err) {
      if (POS_REQUIRED_EXPORTS.has(name)) {
        throw new Error(
          `[ACBrPosPrinter] Export obrigatório ausente (${name}): ${err.message || err}`,
        );
      }
      lib[name] = null;
    }
  }
  return lib;
}

function loadLib() {
  if (!canLoadNativeLib()) return null;
  try {
    const paths = prepareRuntimePaths();
    if (!paths.libPath) return null;
    return {
      lib: createBindings(paths.libPath),
      libPath: paths.libPath,
      iniPath: paths.iniPath,
      root: paths.root,
      staged: paths.staged,
    };
  } catch (err) {
    _ffiBindingsOk = false;
    return { error: err.message };
  }
}

function promisify(fn, ...args) {
  return new Promise((resolve, reject) => {
    try {
      if (typeof fn !== "function") {
        reject(new TypeError("[ACBrPosPrinter] promisify: fn inválida"));
        return;
      }
      fn(...args, (err, ret) => {
        if (err) return reject(err);
        resolve(ret);
      });
    } catch (e) {
      // koffi lança TypeError síncrono (ex.: arity) — sem isso a Promise fica pendente
      reject(e);
    }
  });
}

function trimBuf(buf) {
  return Buffer.isBuffer(buf) ? buf.toString("latin1").replace(/\0+$/, "").trim() : String(buf || "");
}

/** Buffer + tamanho InOut no formato koffi (`int[1]`). */
function allocOutBuffer(size = 8192) {
  return { buf: Buffer.alloc(size), tam: [size] };
}

async function ultimoRetorno(libBundle) {
  if (!libBundle?.lib?.POS_UltimoRetorno?.async) return "";
  const { buf, tam } = allocOutBuffer(8192);
  try {
    await callPosBestEffort(libBundle, libBundle.lib.POS_UltimoRetorno.async, buf, tam);
  } catch (_) {
    return "";
  }
  return trimBuf(buf);
}

async function readStringOut(libBundle, fn, ...args) {
  const { buf, tam } = allocOutBuffer(8192);
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

/**
 * Chama FFI PosPrinter com timeout duro.
 * Sem isso, POS_Ativar/POS_Imprimir em RAW: pode prender o threadpool por minutos
 * (agente "off", cupom só imprime depois).
 *
 * Nota: Promise.race não cancela a FFI nativa — só deixa de esperar.
 * Por isso teardown usa timeout curto e abandona a sessão (ver callPosBestEffort).
 */
async function callPos(libBundle, fn, ...args) {
  if (typeof fn !== "function") {
    const e = new Error("[ACBrPosPrinter] Função FFI indisponível nesta DLL");
    e.code = "ACBR_POS_FN_MISSING";
    throw annotateAcbrError(e);
  }
  const timeoutMs = parseInt(process.env.ACBR_POS_CALL_TIMEOUT_MS || "5000", 10);
  const invoke = promisify(fn.bind(libBundle.lib), ...args);
  let timer;
  let ret;
  try {
    ret = await Promise.race([
      invoke,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const e = new Error(
            `Timeout ACBr PosPrinter (${timeoutMs}ms) em ${fn.name || "POS_*"}`,
          );
          e.code = "ACBR_POS_TIMEOUT";
          e.printTimedOut = true;
          reject(annotateAcbrError(e));
        }, Math.max(1000, timeoutMs));
      }),
    ]);
  } catch (err) {
    throw annotateAcbrError(err);
  } finally {
    clearTimeout(timer);
  }

  if (ret !== 0) {
    const msg = await ultimoRetorno(libBundle);
    const values = buildRuntimeValues();
    throw annotateAcbrError(
      formatAcbrPosError(fn.name || "POS", ret, msg, {
        porta: values.PosPrinter?.Porta,
        modelo: values.PosPrinter?.Modelo,
      }),
    );
  }
  return ret;
}

/**
 * Desativar/Finalizar com deadline curto — NUNCA esperar minutos no teardown.
 * Se estourar, abandona a await (FFI pode continuar no worker) e o caller dropa a sessão.
 */
async function callPosBestEffort(libBundle, fn, ...args) {
  if (typeof fn !== "function") return;
  const timeoutMs = parseInt(process.env.ACBR_POS_TEARDOWN_TIMEOUT_MS || "2000", 10);
  let timer;
  try {
    await Promise.race([
      promisify(fn.bind(libBundle.lib), ...args),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("teardown timeout")), Math.max(500, timeoutMs));
      }),
    ]);
  } catch (_) {
    /* abandonado de propósito */
  } finally {
    clearTimeout(timer);
  }
}

async function gravarConfigIni(libBundle, iniPath, values) {
  setAcbrPrintPhase("config");
  const criticalKeys = new Set(["Porta", "Modelo"]);
  for (const [sec, keys] of Object.entries(values)) {
    for (const [key, val] of Object.entries(keys)) {
      try {
        await promisify(
          libBundle.lib.POS_ConfigGravarValor.async.bind(libBundle.lib.POS_ConfigGravarValor),
          sec,
          key,
          String(val),
        );
      } catch (err) {
        // Porta/Modelo errados = Ativar/Imprimir no destino errado — não engolir
        if (sec === "PosPrinter" && criticalKeys.has(key)) {
          throw annotateAcbrError(err);
        }
        /* demais chaves: opcional por versão da DLL */
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
  // Bloqueia jato/laser em RAW — Ativar/Imprimir prende threadpool e agente fica Offline
  if (/^RAW:/i.test(porta)) {
    const nome = porta.replace(/^RAW:/i, "").trim();
    const NAO =
      /l4260|l3250|l3210|l1250|l3150|l4150|l5290|inkjet|deskjet|officejet|laserjet|ecosys|brother\s*hl|dcp-|mfc-|onenote|microsoft\s*print\s*to\s*pdf|fax|xps|pdf/i;
    const SIM =
      /elgin|bematech|daruma|tanca|jetway|thermal|tm-|mp-|i9|i7|pos\s*80|pos80|posprinter|cupom|nfce|receipt|termica|tm-t|tm-m/i;
    if (nome && !SIM.test(nome) && NAO.test(nome)) {
      const err = new Error(
        `Impressora "${nome}" não é térmica ESC/POS (jato/laser/virtual). ` +
          `Configure a POS80/térmica ou TCP:IP:9100.`,
      );
      err.code = "PRINTER_NOT_THERMAL";
      err.permanente = true;
      throw err;
    }
  }
  await gravarConfigIni(bundle, iniForLib, values);
  if (iniPathDisk) syncIniToSource(bundle, iniPathDisk);
  try {
    await callPosBestEffort(bundle, bundle.lib.POS_Desativar.async);
  } catch (_) {
    /* primeira ativação */
  }
  setAcbrPrintPhase("ativar");
  await callPos(bundle, bundle.lib.POS_Ativar.async);
}

function defaultIniContent() {
  const logNivel = resolveLogNivel();
  return `[Principal]
TipoResposta=2
LogNivel=${logNivel}
ArqLog=

[PosPrinter]
Modelo=1
Porta=
PaginaDeCodigo=2
ColunasFonteNormal=48
CortaPapel=1
TraduzirTags=1
ControlePorta=0

[PosPrinter_Device]
BytesCount=512
BytesInterval=10
TimeOut=${resolveDeviceTimeout()}
`;
}

function buildRuntimeValues() {
  let local = null;
  try {
    local = require("./printerLocalConfig").ler();
  } catch (_) {}
  let model = local?.modelo || process.env.PRINTER_MODEL || "0";
  const {
    portaAcbrValida,
    normalizarPortaAcbr,
    inferirModeloAcbr,
  } = require("./printerModelMap");

  // SSOT: INI válido manda. Env só se INI vazio/inválido — nunca misturar host de teste.
  let porta = String(local?.porta || "").trim();
  if (!portaAcbrValida(porta)) {
    porta = String(
      process.env.PRINTER_PORTA || process.env.PRINTER_PATH || "",
    ).trim();
  }
  try {
    const override = require("./printerStationRoutes").getPortaOverride();
    if (override && portaAcbrValida(override)) porta = override;
  } catch (_) {
    /* módulo opcional */
  }

  if (portaAcbrValida(porta)) {
    porta = normalizarPortaAcbr(porta, {
      nomeWindows:
        process.env.PRINTER_NAME ||
        (/^RAW:(.+)$/i.exec(porta)?.[1] || "").trim(),
    });
  } else {
    porta = normalizarPortaAcbr(porta, {
      host: process.env.PRINTER_HOST,
      port: process.env.PRINTER_PORT || "9100",
      nomeWindows: process.env.PRINTER_NAME || local?.nomeImpressora,
    });
  }

  if (!portaAcbrValida(porta) && process.env.PRINTER_NAME) {
    porta = normalizarPortaAcbr(`RAW:${process.env.PRINTER_NAME}`, {
      nomeWindows: process.env.PRINTER_NAME,
    });
  }
  if (!portaAcbrValida(porta) && process.env.PRINTER_HOST) {
    const tcpCandidate = normalizarPortaAcbr(
      `TCP:${process.env.PRINTER_HOST}:${process.env.PRINTER_PORT || "9100"}`,
      {
        host: process.env.PRINTER_HOST,
        port: process.env.PRINTER_PORT || "9100",
        nomeWindows: process.env.PRINTER_NAME,
      },
    );
    if (portaAcbrValida(tcpCandidate)) porta = tcpCandidate;
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

  // modelo "0" (texto genérico) com POS80/Elgin/etc. → Epson-compatível
  if (String(model) === "0" || model === "auto") {
    const fromPorta = /^RAW:(.+)$/i.exec(String(porta || ""));
    const nomeHint =
      fromPorta?.[1] ||
      process.env.PRINTER_NAME ||
      local?.nomeImpressora ||
      "";
    const inferred = inferirModeloAcbr(nomeHint, "", { ignoreEnv: true });
    if (inferred && inferred !== "0") model = inferred;
  }

  const enc = local?.encoding || process.env.PRINTER_ENCODING || "850";
  const pageCode = enc === "UTF8" || enc === "utf8" ? "5" : enc === "1252" ? "6" : "2";
  const cut = local?.cut || process.env.PRINTER_CUT || "partial";
  const controlePorta = resolveControlePorta(porta);
  const verificarImpressora =
    process.env.PRINTER_VERIFICAR === "true"
      ? "1"
      : "0";

  const serial = local?.serial || {};
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
    PosPrinter_Device: buildDeviceRuntimeValues(
      {
        baud: serial.baud || local?.baud,
        parity: serial.parity || local?.parity,
        stopBits: serial.stopBits || local?.stopBits,
        handshake: serial.handshake || local?.handshake,
        timeout: serial.timeout || local?.timeout,
      },
      porta,
    ),
  };

  return values;
}

async function withPosPrinterSession(fn, opts = {}) {
  // Worker mode: main NÃO carrega a mesma DLL (duas instâncias = hang RAW).
  // Fallback in-process só quando pool.markFallbackInProcess (isPosWorkerEnabled=false).
  if (!opts.fromWorkerFallback && !opts.allowAlongsideWorker) {
    try {
      const pool = require("./acbrPosWorkerPool");
      if (pool.isPosWorkerEnabled()) {
        const e = new Error(
          "[ACBrPosPrinter] Sessão in-process bloqueada — ACBR_POS_WORKER ativo (use worker ou =false)",
        );
        e.code = "ACBR_POS_WORKER_OWNS_SESSION";
        throw e;
      }
    } catch (err) {
      if (err?.code === "ACBR_POS_WORKER_OWNS_SESSION") throw err;
      /* pool opcional em testes isolados */
    }
  }

  // In-process Pos e ACBrLib NFe compartilham process.chdir — nunca em paralelo.
  try {
    const coord = require("./printFiscalCoordination");
    if (coord.fiscalEmUso()) {
      await coord.aguardarFiscalLivre(
        parseInt(process.env.PRINT_FISCAL_WAIT_CHDIR_MS || "3000", 10),
      );
    }
    if (coord.fiscalEmUso()) {
      const e = new Error(
        "Fiscal ACBr ocupado — Pos in-process bloqueado (evita corrida de cwd)",
      );
      e.code = "ACBR_POS_FISCAL_BUSY_CHDIR";
      e.fallbackNative = true;
      throw e;
    }
    const st = require("../fiscal/drivers/acbrLibSession").getSessionStatus?.();
    if (st?.ativa) {
      const e = new Error(
        "Sessão ACBrLib NFe ativa — Pos in-process bloqueado (evita corrida de cwd)",
      );
      e.code = "ACBR_POS_FISCAL_SESSION_ACTIVE";
      e.fallbackNative = true;
      throw e;
    }
  } catch (err) {
    if (
      err?.code === "ACBR_POS_FISCAL_BUSY_CHDIR" ||
      err?.code === "ACBR_POS_FISCAL_SESSION_ACTIVE"
    ) {
      throw err;
    }
    /* coord/session opcional em testes */
  }

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
      await callPosBestEffort(sess.bundle, sess.bundle.lib.POS_Desativar.async);
    } catch (_) {}
    try {
      await callPosBestEffort(sess.bundle, sess.bundle.lib.POS_Finalizar.async);
    } catch (_) {}
    try {
      if (sess.cwdBefore) process.chdir(sess.cwdBefore);
    } catch (_) {}
    if (withPosPrinterSession._session === sess) {
      withPosPrinterSession._session = null;
    }
  }

  /**
   * Sessão curta por job em RAW era o padrão antigo — cada cupom fazia
   * Finalizar+Inicializar+Ativar e travava o spooler. Agora: sessão quente
   * (idle timeout). Opt-in: ACBR_POS_SESSION_PER_JOB=true.
   */
  function sessaoCurtaRaw() {
    if (process.env.ACBR_POS_SESSION_PER_JOB === "true") {
      const porta = buildRuntimeValues().PosPrinter?.Porta || "";
      return /^RAW:/i.test(porta);
    }
    return false;
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
    withPosPrinterSession._dllPinned = true;
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
      /porta|offline|inicializar|ativar|desativar|finalizar|pos_imprimir|expected \d+ arguments|acbr_pos_timeout|acbr_pos_fn_missing/i.test(
        String(err?.message || err?.code || ""),
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
  // RAW:Windows — não consultar (hang conhecido). TCP/COM: opt-in (padrão off).
  if (/^RAW:/i.test(porta) || !bundle?.lib?.POS_PodeLerDaPorta?.async) return;
  if (String(process.env.ACBR_POS_PODE_LER || "").toLowerCase() !== "true") return;
  const ret = await callPos(
    bundle,
    bundle.lib.POS_PodeLerDaPorta.async.bind(bundle.lib.POS_PodeLerDaPorta),
  );
  if (ret === 0) return;
  const msg = await ultimoRetorno(bundle);
  const values = buildRuntimeValues();
  throw formatAcbrPosError("POS_PodeLerDaPorta", ret, msg, {
    porta: values.PosPrinter?.Porta,
    modelo: values.PosPrinter?.Modelo,
  });
}

async function imprimirTagsNativeOnce(bundle, tags) {
  // NÃO re-chamar POS_Ativar a cada cupom — sessão já ativa em withPosPrinterSession.
  // Re-Ativar em RAW:Windows prende o spooler por minutos.
  const forceReativar = process.env.ACBR_POS_REATIVAR_POR_JOB === "true";
  const sess = withPosPrinterSession._session;
  if (forceReativar && sess?.iniForLib) {
    await ativarComConfig(bundle, sess.iniForLib, sess.iniPath);
  }
  await assertPortaLegivel(bundle);
  setAcbrPrintPhase("init");
  await callPos(bundle, bundle.lib.POS_InicializarPos.async);
  // POS_Imprimir(eString, PulaLinha, DecodificarTags, CodificarPagina, Copias)
  // CodificarPagina=true alinha com PaginaDeCodigo do INI (CP850/1252/UTF8).
  setAcbrPrintPhase("imprimir");
  try {
    await callPos(bundle, bundle.lib.POS_Imprimir.async, String(tags || ""), true, true, true, 1);
    return { ok: true, native: true };
  } finally {
    setAcbrPrintPhase("idle");
  }
}

function erroPortaRecuperavel(err) {
  const msg = String(err?.message || "");
  return err?.acbrRet === -10 || /porta.*n[aã]o definida|PRINTER_PORTA_INDEFINIDA/i.test(msg);
}

async function imprimirTagsViaWorker(tags) {
  await require("./printerBootstrap").garantirPortaImpressao({ skipDetect: true });
  const paths = prepareRuntimePaths();
  if (!paths?.libPath) {
    const e = new Error("[ACBrPosPrinter] DLL não encontrada para worker");
    e.code = "ACBR_POS_DLL_MISSING";
    throw e;
  }
  const values = buildRuntimeValues();
  const porta = values.PosPrinter?.Porta || "default";
  // Guard térmico ANTES do worker (Ativar em jato/laser prende o RAW)
  if (/^RAW:/i.test(porta)) {
    const nome = porta.replace(/^RAW:/i, "").trim();
    require("./escpos/impressoraCore").assertPortaTermicaOuFalhar(nome);
  }
  if (!porta || porta === "default" || !require("./printerModelMap").portaAcbrValida(porta)) {
    const e = new Error("Porta da impressora não configurada");
    e.code = "PRINTER_PORTA_INDEFINIDA";
    throw e;
  }
  return require("./acbrPosWorkerPool").imprimirTags({
    printerKey: porta,
    dllPath: paths.libPath,
    iniPath: paths.iniPath,
    agentRoot: AGENT_ROOT,
    cryptKey: process.env.ACBR_POSPRINTER_CRYPT_KEY || process.env.ACBR_LIB_CRYPT_KEY || "",
    values,
    tags,
  }).then((r) => {
    withPosPrinterSession._dllPinned = true;
    return r;
  });
}

async function imprimirTagsNativeInProcess(tags) {
  const maxTentativas = parseInt(process.env.ACBR_POS_PRINT_RETRIES || "2", 10);
  let lastErr;

  for (let attempt = 1; attempt <= maxTentativas; attempt++) {
    try {
      await require("./printerBootstrap").garantirPortaImpressao({
        skipDetect: attempt === 1,
        force: attempt > 1,
      });
      return await withPosPrinterSession(
        async (bundle) => imprimirTagsNativeOnce(bundle, tags),
        {
          invalidateOnError: attempt < maxTentativas,
          fromWorkerFallback: true,
        },
      );
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

/**
 * FFI PosPrinter no processo principal (threadpool libuv).
 * Padrão: NÃO — hang de minutos no HTTP se Ativar/Imprimir travar.
 * Permitido só com: ACBR_POS_ALLOW_INPROCESS=true OU ACBR_POS_WORKER=false (rollback).
 */
function allowInProcessAcbrFfi() {
  const allow = String(process.env.ACBR_POS_ALLOW_INPROCESS || "").toLowerCase();
  if (allow === "true" || allow === "1") return true;
  const worker = String(process.env.ACBR_POS_WORKER || "true").toLowerCase();
  if (worker === "false" || worker === "0") return true;
  return false;
}

function refuseInProcessOrThrow(reason) {
  const msg = String(reason || "ACBr PosPrinter in-process bloqueado");
  try {
    openAcbrPosCircuit(msg);
  } catch (_) {}
  const e = new Error(
    `[ACBrPosPrinter] ${msg} — comerciais via ESC/POS nativo (sem FFI no main)`,
  );
  e.code = "ACBR_POS_INPROCESS_BLOCKED";
  e.fallbackNative = true;
  throw e;
}

/**
 * Impressão ACBr — sob physicalLock; prefer worker (terminate real).
 * Windows: sem fallback in-process automático (native no executor).
 */
async function imprimirTagsNative(tags) {
  const physical = require("../runtime/physicalResourceLock");
  const map = require("../runtime/physicalResourceMap");
  return physical.run(map.resolvePosprinterKey(), () => imprimirTagsNativeInner(tags), "pos-print");
}

async function imprimirTagsNativeInner(tags) {
  const pool = require("./acbrPosWorkerPool");
  if (pool.isPosWorkerEnabled() && canLoadNativeLib()) {
    try {
      return await imprimirTagsViaWorker(tags);
    } catch (err) {
      // Timeout/kill/térmica/erro ACBr: NÃO segundo envio no mesmo job
      if (
        err?.code === "ACBR_POS_WORKER_KILLED" ||
        err?.code === "ACBR_POS_TIMEOUT" ||
        err?.code === "PRINTER_NOT_THERMAL" ||
        err?.code === "ACBR_POS_ERROR" ||
        err?.printTimedOut ||
        err?.acbrRet != null
      ) {
        throw err;
      }
      // Spawn/init falhou → pool marcou fallback; Win = native (não FFI main)
      if (!pool.isPosWorkerEnabled()) {
        if (!allowInProcessAcbrFfi()) {
          refuseInProcessOrThrow(err.message || "worker_spawn_fail");
        }
        log.warn(
          { err: err.message, metric: "print.worker_fallback_inprocess" },
          "[ACBrPosPrinter] Worker falhou — imprimindo in-process (ALLOW_INPROCESS)",
        );
        return imprimirTagsNativeInProcess(tags);
      }
      throw err;
    }
  }
  if (!allowInProcessAcbrFfi()) {
    refuseInProcessOrThrow("worker indisponível");
  }
  return imprimirTagsNativeInProcess(tags);
}

async function abrirGavetaNative() {
  const physical = require("../runtime/physicalResourceLock");
  const map = require("../runtime/physicalResourceMap");
  return physical.run(map.resolvePosprinterKey(), () => abrirGavetaNativeInner(), "pos-gaveta");
}

async function abrirGavetaNativeInner() {
  const pool = require("./acbrPosWorkerPool");
  if (pool.isPosWorkerEnabled() && canLoadNativeLib()) {
    try {
      const paths = prepareRuntimePaths();
      const values = buildRuntimeValues();
      return await pool.abrirGaveta({
        printerKey: values.PosPrinter?.Porta || "default",
        dllPath: paths.libPath,
        iniPath: paths.iniPath,
        agentRoot: AGENT_ROOT,
        cryptKey: process.env.ACBR_POSPRINTER_CRYPT_KEY || process.env.ACBR_LIB_CRYPT_KEY || "",
        values,
      });
    } catch (err) {
      if (err?.code === "ACBR_POS_WORKER_KILLED" || err?.printTimedOut) throw err;
      if (!pool.isPosWorkerEnabled() && allowInProcessAcbrFfi()) {
        /* fallback in-process abaixo */
      } else if (!pool.isPosWorkerEnabled() && !allowInProcessAcbrFfi()) {
        // Gaveta via ESC/POS nativo — sem FFI no main Windows
        return require("./escpos/impressoraCore").abrirGaveta();
      } else {
        throw err;
      }
    }
  }
  if (!allowInProcessAcbrFfi()) {
    return require("./escpos/impressoraCore").abrirGaveta();
  }
  return withPosPrinterSession(
    async (bundle) => {
      await callPos(bundle, bundle.lib.POS_AbrirGaveta.async);
      return { ok: true, native: true };
    },
    { fromWorkerFallback: true },
  );
}

async function lerStatusFormatadoNative(tentativas = 3) {
  try {
    const pool = require("./acbrPosWorkerPool");
    if (pool.isPosWorkerEnabled()) {
      // Evita segunda instância da DLL no main enquanto worker possui a porta
      return { raw: "", status: {}, ok: true, unsupported: true, workerOwned: true };
    }
  } catch (_) {}
  return withPosPrinterSession(async (bundle) => {
    if (!bundle?.lib?.POS_LerStatusImpressoraFormatado?.async) {
      return { raw: "", status: {}, ok: true, unsupported: true };
    }
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
    // offline / sem papel / tampa aberta = indisponível.
    // "erro=1" sozinho é intermitente em várias térmicas e não deve marcar Offline
    // se a impressão continua funcionando (POS_Imprimir ok).
    const indisponivel =
      status.offLine === 1 || status.semPapel === 1 || status.tampaAberta === 1;
    return { raw, status, ok: !indisponivel };
  });
}

function workerOwnsPosSession() {
  try {
    return require("./acbrPosWorkerPool").isPosWorkerEnabled();
  } catch (_) {
    return false;
  }
}

async function acharPortasNative() {
  if (workerOwnsPosSession()) {
    return { portas: [], raw: "", unsupported: true, workerOwned: true };
  }
  return withPosPrinterSession(async (bundle) => {
    if (!bundle?.lib?.POS_AcharPortas?.async) {
      return { portas: [], raw: "", unsupported: true };
    }
    const raw = await readStringOut(bundle, bundle.lib.POS_AcharPortas.async);
    return { portas: String(raw || "").split("|").filter(Boolean), raw };
  });
}

async function lerInfoImpressoraNative() {
  if (workerOwnsPosSession()) {
    return { raw: "", unsupported: true, workerOwned: true };
  }
  return withPosPrinterSession(async (bundle) => {
    if (!bundle?.lib?.POS_LerInfoImpressora?.async) {
      return { raw: "", unsupported: true };
    }
    const raw = await readStringOut(bundle, bundle.lib.POS_LerInfoImpressora.async);
    return { raw };
  });
}

async function gravarLogoArquivoNative(bmpPath, kc1, kc2) {
  if (workerOwnsPosSession()) {
    // Libera porta no worker antes de gravar logo in-process (operação rara/operador)
    await invalidatePosPrinterSession();
  }
  return withPosPrinterSession(
    async (bundle) => {
      if (!bundle?.lib?.POS_GravarLogoArquivo?.async) {
        throw new Error("[ACBrPosPrinter] POS_GravarLogoArquivo não disponível nesta DLL");
      }
      await callPos(bundle, bundle.lib.POS_GravarLogoArquivo.async, bmpPath, kc1, kc2);
      return { ok: true, native: true };
    },
    { fromWorkerFallback: true },
  );
}

async function lerVersaoNative() {
  if (workerOwnsPosSession()) {
    return { nome: "", versao: "", unsupported: true, workerOwned: true };
  }
  return withPosPrinterSession(async (bundle) => {
    const nome = await readStringOut(bundle, bundle.lib.POS_Nome.async);
    const versao = await readStringOut(bundle, bundle.lib.POS_Versao.async);
    return { nome, versao };
  });
}

async function invalidatePosPrinterSession() {
  try {
    await require("./acbrPosWorkerPool").invalidateAll();
  } catch (_) {}
  const sess = withPosPrinterSession._session;
  if (!sess?.bundle) return;
  withPosPrinterSession._refCount = 0;
  // Dropa referência ANTES do teardown — próximo job não reusa sessão zumbi
  withPosPrinterSession._session = null;
  if (withPosPrinterSession._idleTimer) {
    clearTimeout(withPosPrinterSession._idleTimer);
    withPosPrinterSession._idleTimer = null;
  }
  try {
    await callPosBestEffort(sess.bundle, sess.bundle.lib.POS_Desativar.async);
  } catch (_) {}
  try {
    await callPosBestEffort(sess.bundle, sess.bundle.lib.POS_Finalizar.async);
  } catch (_) {}
  try {
    if (sess.cwdBefore) process.chdir(sess.cwdBefore);
  } catch (_) {}
}

/**
 * Circuito aberto: ACBr PosPrinter falhou nesta máquina (ex.: POS_Ativar -10 / timeout RAW).
 * Cupons comerciais passam a ir direto no ESC/POS nativo (sem WARN a cada job).
 * Fiscal/DANFE ainda tenta ACBr. Desligar: PRINT_ACBR_CIRCUIT=false.
 * Persistido em disco — sobrevive a reinício do serviço Windows.
 * Reset: Detectar/Salvar force do operador ou apagar o arquivo.
 */
let _acbrPosCircuit = { open: false, reason: null, openedAt: null };
let _circuitLoaded = false;

function resolveCircuitPath() {
  if (process.env.ACBR_POS_CIRCUIT_FILE) return process.env.ACBR_POS_CIRCUIT_FILE;
  return path.join(path.dirname(resolveIniPath()), "acbr-pos-circuit.json");
}

function loadCircuitFromDisk() {
  if (_circuitLoaded) return;
  _circuitLoaded = true;
  try {
    const file = resolveCircuitPath();
    if (!fs.existsSync(file)) return;
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw && raw.open === true) {
      _acbrPosCircuit = {
        open: true,
        reason: String(raw.reason || "persisted").slice(0, 240),
        openedAt: Number(raw.openedAt) || Date.now(),
      };
      log.info(
        { reason: _acbrPosCircuit.reason, openedAt: _acbrPosCircuit.openedAt },
        "[ACBrPosPrinter] Circuito RAW restaurado do disco — comerciais via native",
      );
    }
  } catch (err) {
    log.debug({ err: err.message }, "[ACBrPosPrinter] Falha ao ler circuito do disco");
  }
}

function persistCircuitToDisk() {
  try {
    const file = resolveCircuitPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!_acbrPosCircuit.open) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return;
    }
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          open: true,
          reason: _acbrPosCircuit.reason,
          openedAt: _acbrPosCircuit.openedAt,
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch (err) {
    log.warn({ err: err.message }, "[ACBrPosPrinter] Falha ao persistir circuito");
  }
}

function isAcbrPosCircuitOpen() {
  if (String(process.env.PRINT_ACBR_CIRCUIT || "true").toLowerCase() === "false") {
    return false;
  }
  loadCircuitFromDisk();
  if (!_acbrPosCircuit.open) return false;
  // Half-open: após TTL tenta ACBr de novo. Default 0 = só Salvar/Detectar reabre (solidez).
  const ttl = parseInt(process.env.ACBR_POS_CIRCUIT_TTL_MS || "0", 10);
  const ttlMs = Number.isFinite(ttl) && ttl > 0 ? ttl : 0;
  if (
    ttlMs > 0 &&
    _acbrPosCircuit.openedAt &&
    Date.now() - Number(_acbrPosCircuit.openedAt) >= ttlMs
  ) {
    log.info(
      {
        metric: "print.circuit_ttl_expire",
        ttlMs,
        openedAt: _acbrPosCircuit.openedAt,
        reason: _acbrPosCircuit.reason,
      },
      "[ACBrPosPrinter] Circuito expirou (TTL) — nova tentativa ACBr/Epson no próximo cupom",
    );
    resetAcbrPosCircuit();
    return false;
  }
  return true;
}

function getAcbrPosCircuit() {
  loadCircuitFromDisk();
  return { ..._acbrPosCircuit };
}

function openAcbrPosCircuit(reason) {
  loadCircuitFromDisk();
  if (_acbrPosCircuit.open) return false;
  _acbrPosCircuit = {
    open: true,
    reason: String(reason || "acbr_unreliable").slice(0, 240),
    openedAt: Date.now(),
  };
  persistCircuitToDisk();
  try {
    require("./factory").resetPrintProvider();
  } catch (_) {}
  log.warn(
    {
      reason: _acbrPosCircuit.reason,
      circuitFile: resolveCircuitPath(),
      metric: "print.circuit_open",
    },
    "[ACBrPosPrinter] Circuito RAW aberto — comerciais via ESC/POS nativo (sem tentar Ativar a cada cupom)",
  );
  return true;
}

function resetAcbrPosCircuit() {
  _circuitLoaded = true;
  const wasOpen = _acbrPosCircuit.open;
  _acbrPosCircuit = { open: false, reason: null, openedAt: null };
  persistCircuitToDisk();
  try {
    require("./acbrPosWorkerPool").clearFallbackInProcess();
  } catch (_) {}
  if (wasOpen) {
    log.info(
      { metric: "print.circuit_reset" },
      "[ACBrPosPrinter] Circuito RAW fechado — ACBr será tentado novamente",
    );
  }
}

function shouldOpenCircuitFromError(err) {
  const msg = String(err?.message || err || "");
  if (err?.code === "PRINTER_NOT_THERMAL" || err?.permanente) return false;
  if (err?.code === "ACBR_POS_WORKER_OWNS_SESSION") return false;
  // Contenção temporária com fiscal (chdir) — não abre circuito permanente.
  if (
    err?.code === "ACBR_POS_FISCAL_BUSY_CHDIR" ||
    err?.code === "ACBR_POS_FISCAL_SESSION_ACTIVE"
  ) {
    return false;
  }
  if (err?.acbrRet === -10 || /\(-10\)/.test(msg) || /ret\s*=\s*-10\b/i.test(msg)) return true;
  if (/expected \d+ arguments, got \d+/i.test(msg)) return true;
  if (
    err?.code === "ACBR_POS_TIMEOUT" ||
    err?.code === "ACBR_POS_FN_MISSING" ||
    err?.code === "ACBR_POS_WORKER_KILLED" ||
    err?.code === "ACBR_POS_WORKER_EXIT" ||
    err?.code === "ACBR_POS_WORKER_ERROR" ||
    err?.code === "PRINT_HARD_DRAIN" ||
    err?.code === "ACBR_POS_INPROCESS_BLOCKED" ||
    err?.printTimedOut === true
  ) {
    return true;
  }
  if (/POS_Ativar|erro de comunica[cç][aã]o com a impressora|Timeout de impressão/i.test(msg)) {
    return true;
  }
  return false;
}

/** @internal testes — força reload do arquivo */
function __reloadCircuitFromDiskForTests() {
  _circuitLoaded = false;
  _acbrPosCircuit = { open: false, reason: null, openedAt: null };
  loadCircuitFromDisk();
}

module.exports = {
  canLoadNativeLib,
  canRequireFfiBindings,
  getFfiBindingsError,
  resolveLibPath,
  resolveIniPath,
  resolveCircuitPath,
  prepareRuntimePaths,
  loadLib,
  withPosPrinterSession,
  invalidatePosPrinterSession,
  imprimirTagsNative,
  abrirGavetaNative,
  allowInProcessAcbrFfi,
  lerStatusFormatadoNative,
  acharPortasNative,
  lerInfoImpressoraNative,
  gravarLogoArquivoNative,
  lerVersaoNative,
  buildRuntimeValues,
  isAcbrPosCircuitOpen,
  getAcbrPosCircuit,
  openAcbrPosCircuit,
  resetAcbrPosCircuit,
  shouldOpenCircuitFromError,
  getAcbrPrintPhase,
  setAcbrPrintPhase,
  /** @internal testes — simula contrato async do koffi */
  __wrapKoffiFunc: wrapKoffiFunc,
  __reloadCircuitFromDiskForTests,
};

/**
 * Worker thread — ACBr PosPrinter isolado.
 * Sessão QUENTE: Inicializar+Ativar 1×; cupons só InicializarPos+Imprimir.
 * Chamadas síncronas koffi (bloqueia só a OS thread deste worker).
 */
const { parentPort, workerData } = require("worker_threads");
const fs = require("fs");
const path = require("path");

const agentRoot = workerData?.agentRoot || path.resolve(__dirname, "..", "..");
const dllPath = workerData?.dllPath;
const iniPath = workerData?.iniPath;
const cryptKey = workerData?.cryptKey || "";

let lib = null;
let generation = Number(workerData?.generation) || 0;
let ready = false;
let lastValuesKey = "";

function reply(msg) {
  try {
    parentPort.postMessage(msg);
  } catch (_) {
    /* parent gone */
  }
}

function fail(id, code, message, extra = {}) {
  reply({
    id,
    generation,
    ok: false,
    error: {
      code,
      message: String(message || code),
      ...(extra.acbrRet != null ? { acbrRet: extra.acbrRet } : {}),
      ...(extra.acbrPhase ? { acbrPhase: extra.acbrPhase } : {}),
    },
  });
}

function ok(id, data) {
  reply({ id, generation, ok: true, data: data || {} });
}

function ultimoRetornoSync() {
  if (!lib?.POS_UltimoRetorno) return "";
  try {
    const buf = Buffer.alloc(1024);
    const size = [buf.length];
    lib.POS_UltimoRetorno(buf, size);
    return buf.toString("utf8", 0, Math.max(0, size[0] || 0)).replace(/\0/g, "").trim();
  } catch (_) {
    return "";
  }
}

function assertRet(fnName, ret) {
  if (ret === 0) return;
  const msg = ultimoRetornoSync();
  const err = new Error(`[ACBrPosPrinter] ${fnName} ret=${ret}${msg ? `: ${msg}` : ""}`);
  err.code = "ACBR_POS_ERROR";
  err.acbrRet = ret;
  throw err;
}

function loadDll() {
  if (lib) return;
  if (!dllPath || !fs.existsSync(dllPath)) {
    throw Object.assign(new Error(`DLL ausente: ${dllPath}`), { code: "ACBR_POS_DLL_MISSING" });
  }
  // Preferir dir da DLL (deps ACBr) — igual ao runtime no main
  const libDir = path.dirname(dllPath);
  try {
    if (fs.existsSync(libDir)) process.chdir(libDir);
    else if (process.cwd() !== agentRoot) process.chdir(agentRoot);
  } catch (_) {}
  const koffi = require("koffi");
  const dll = koffi.load(dllPath);
  const {
    POS_FFI_SIGNATURES,
    POS_WORKER_EXPORTS,
    POS_WORKER_REQUIRED,
  } = require("../acbrPosExports");
  lib = {};
  for (const name of POS_WORKER_EXPORTS) {
    const sig = POS_FFI_SIGNATURES[name];
    if (!sig) continue;
    try {
      lib[name] = dll.func(sig);
    } catch (e) {
      if (POS_WORKER_REQUIRED.has(name)) throw e;
    }
  }
}

function gravarValues(values) {
  if (!values || typeof values !== "object") return;
  for (const [sec, keys] of Object.entries(values)) {
    if (!keys || typeof keys !== "object") continue;
    for (const [key, val] of Object.entries(keys)) {
      try {
        assertRet(
          "POS_ConfigGravarValor",
          lib.POS_ConfigGravarValor(sec, key, String(val)),
        );
      } catch (err) {
        if (sec === "PosPrinter" && (key === "Porta" || key === "Modelo")) throw err;
      }
    }
  }
  if (iniPath) {
    try {
      fs.mkdirSync(path.dirname(iniPath), { recursive: true });
    } catch (_) {}
    assertRet("POS_ConfigGravar", lib.POS_ConfigGravar(iniPath));
  }
}

function ensureSession(values) {
  loadDll();
  const key = JSON.stringify(values || {});
  if (ready && key === lastValuesKey) return;

  if (ready) {
    try {
      lib.POS_Desativar();
    } catch (_) {}
    try {
      lib.POS_Finalizar();
    } catch (_) {}
    ready = false;
  }

  const porta = values?.PosPrinter?.Porta || "";
  if (/^RAW:/i.test(porta)) {
    const nome = porta.replace(/^RAW:/i, "").trim();
    try {
      require("../escpos/impressoraCore").assertPortaTermicaOuFalhar(nome);
    } catch (err) {
      throw err;
    }
  }

  const ini = iniPath || "";
  if (ini) {
    try {
      fs.mkdirSync(path.dirname(ini), { recursive: true });
      if (!fs.existsSync(ini)) {
        fs.writeFileSync(
          ini,
          "[Principal]\nTipoResposta=2\n\n[PosPrinter]\nModelo=0\nPorta=\n",
          "utf8",
        );
      }
    } catch (_) {}
  }

  assertRet("POS_Inicializar", lib.POS_Inicializar(ini, cryptKey));
  gravarValues(values);
  try {
    lib.POS_Desativar();
  } catch (_) {}
  assertRet("POS_Ativar", lib.POS_Ativar());
  ready = true;
  lastValuesKey = key;
}

function shutdown() {
  if (!lib) return;
  try {
    lib.POS_Desativar();
  } catch (_) {}
  try {
    lib.POS_Finalizar();
  } catch (_) {}
  ready = false;
  lastValuesKey = "";
}

parentPort.on("message", (msg) => {
  const id = msg?.id;
  if (msg?.generation != null && Number(msg.generation) !== generation) {
    return; // late message de geração anterior
  }
  try {
    switch (msg?.cmd) {
      case "init":
        ensureSession(msg.values);
        ok(id, { ready: true });
        break;
      case "imprimirTags":
        ensureSession(msg.values);
        // NÃO re-Ativar — sessão quente
        assertRet("POS_InicializarPos", lib.POS_InicializarPos());
        // Demo oficial: POS_Imprimir(texto, 1, 1, 1, 1) — Boolean como int.
        assertRet(
          "POS_Imprimir",
          lib.POS_Imprimir(String(msg.tags || ""), 1, 1, 1, 1),
        );
        ok(id, { native: true, worker: true });
        break;
      case "abrirGaveta":
        ensureSession(msg.values);
        assertRet("POS_AbrirGaveta", lib.POS_AbrirGaveta());
        ok(id, { native: true, worker: true });
        break;
      case "shutdown":
        shutdown();
        ok(id, { shutdown: true });
        break;
      case "ping":
        ok(id, { ready, generation });
        break;
      default:
        fail(id, "ACBR_POS_WORKER_UNKNOWN_CMD", `cmd=${msg?.cmd}`);
    }
  } catch (err) {
    const phase =
      msg?.cmd === "imprimirTags"
        ? "imprimir"
        : msg?.cmd === "init"
          ? "init"
          : "idle";
    fail(id, err.code || "ACBR_POS_WORKER_ERROR", err.message, {
      acbrRet: err.acbrRet,
      acbrPhase: phase,
    });
  }
});

reply({ id: null, generation, ok: true, data: { boot: true } });

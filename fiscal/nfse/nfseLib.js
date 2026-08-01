/**
 * Emissão NFS-e via ACBrLib nativa (FFI) — espelha o padrão NFe em acbrLibDriver.
 *
 * Pacote: @projetoacbr/acbrlib-nfse-node → ACBrLibNFSeMT → ACBrNFSe64.dll / libacbrnfse64.so
 * Fallback: Monitor TCP (nfseAcbr.emitirNfseCore) quando a DLL não está disponível.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const acbr = require("../../acbr");
const log = require("../../logger").child({ modulo: "acbr_lib_nfse" });
const { PATHS } = require("../../marginPaths");
const acbrLibRuntime = require("../drivers/acbrLibRuntime");
const acbrLibSession = require("../drivers/acbrLibSession");
const fiscalTrace = require("../../fiscalTraceLog");
const { validarPayloadNfse } = require("./nfseValidate");
const { parseRespostaNfse, normalizarResultadoNfse } = require("./nfseAcbr");

const AGENT_ROOT = path.resolve(__dirname, "../..");

/** @type {typeof import('@projetoacbr/acbrlib-nfse-node/dist/src').default | null} */
let ACBrLibNFSeMT = null;
/** @type {typeof import('@projetoacbr/acbrlib-nfse-node/dist/src').NFSeModoEnvio | null} */
let NFSeModoEnvio = null;

function loadAcbrLibNfse() {
  if (ACBrLibNFSeMT) return { ACBrLibNFSeMT, NFSeModoEnvio };
  const mod = require("@projetoacbr/acbrlib-nfse-node/dist/src");
  ACBrLibNFSeMT = mod.default;
  NFSeModoEnvio = mod.NFSeModoEnvio;
  return { ACBrLibNFSeMT, NFSeModoEnvio };
}

function defaultNfseLibFileName() {
  return os.platform() === "win32" ? "ACBrNFSe64.dll" : "libacbrnfse64.so";
}

function resolveNfseLibPath() {
  const explicit = process.env.ACBR_NFSE_LIB_PATH;
  if (explicit) {
    const resolved = path.isAbsolute(explicit) ? explicit : path.resolve(AGENT_ROOT, explicit);
    if (fs.existsSync(resolved)) return resolved;
  }
  const names =
    os.platform() === "win32"
      ? ["ACBrNFSe64.dll"]
      : ["libacbrnfse64.so", "ACBrNFSe64.dll"];
  const dirs = [
    path.join(AGENT_ROOT, "acbrlib", "lib"),
    path.join(AGENT_ROOT, "lib"),
    path.join(PATHS.root, "lib"),
    AGENT_ROOT,
  ];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function resolveLibIniPath() {
  const explicit = process.env.ACBR_LIB_INI;
  if (explicit) {
    const resolved = path.isAbsolute(explicit) ? explicit : path.resolve(AGENT_ROOT, explicit);
    if (fs.existsSync(resolved)) return resolved;
  }
  const candidates = [
    path.join(AGENT_ROOT, "acbrlib", "data", "config", "acbrlib.ini"),
    path.join(AGENT_ROOT, "data", "acbrlib.ini"),
    path.join(PATHS.root, "data", "acbrlib.ini"),
    path.join(PATHS.acbr, "acbrlib.ini"),
  ];
  return candidates.find((p) => fs.existsSync(p)) || explicit || null;
}

/**
 * DLL presente só conta como nativo no Windows (FFI real).
 * Linux/CI: fallback Monitor mesmo com .dll no disco.
 */
function canLoadNativeNfseLib() {
  if (process.platform !== "win32") return false;
  return !!resolveNfseLibPath();
}

/**
 * @returns {"native"|"monitor"}
 */
function getNfseIntegrationMode() {
  return canLoadNativeNfseLib() ? "native" : "monitor";
}

function getNfseLibInfo() {
  const mode = getNfseIntegrationMode();
  return {
    provider: "acbr-lib-nfse",
    package: "@projetoacbr/acbrlib-nfse-node",
    mode,
    native: mode === "native",
    libPath: resolveNfseLibPath(),
    libIni: resolveLibIniPath(),
    ready: true,
  };
}

function resolveEmissaoTimeoutMs() {
  const libMs = parseInt(process.env.ACBR_LIB_EMISSAO_TIMEOUT_MS || "", 10);
  const filaMs = parseInt(process.env.FISCAL_EMISSAO_TIMEOUT_MS || "120000", 10);
  if (Number.isFinite(libMs) && libMs > 0) return libMs;
  return filaMs;
}

function resolveModoEnvio(modoEnum) {
  const raw = process.env.ACBR_NFSE_MODO_ENVIO;
  if (raw != null && String(raw).trim() !== "") {
    const n = parseInt(String(raw), 10);
    if (Number.isFinite(n)) return n;
  }
  return modoEnum.LOTE_SINCRONO;
}

function buildNativeNfseRuntime() {
  const libPath = resolveNfseLibPath();
  const iniConfig = resolveLibIniPath();
  if (!libPath || !iniConfig) {
    throw new Error("[ACBrLib NFSe] Biblioteca ou INI não configurados");
  }
  const iniVals = acbrLibRuntime.readIniValues(iniConfig);
  const runtime = acbrLibRuntime.prepareNativeRuntime({
    libPath,
    iniConfigPath: iniConfig,
    assets: {
      lib: path.dirname(libPath),
      schemas: iniVals.pathSchemas || path.join(AGENT_ROOT, "acbrlib", "data", "Schemas"),
      cert: iniVals.certFile,
      servicos: iniVals.servicos || path.join(AGENT_ROOT, "data", "ACBrNFeServicos.ini"),
      notas: PATHS.xml,
      log: PATHS.logs,
      pdf: PATHS.pdf,
    },
    forceStaging: process.platform === "win32",
  });
  return acbrLibSession.cacheRuntime(runtime);
}

/**
 * Emissão nativa: carregarINI → assinar → validar → emitir(lote, modo, imprimir).
 */
async function emitirNfseViaNativeLib(payload) {
  validarPayloadNfse(payload);

  const fiscalIniPolicy = require("../fiscalIniPolicy");
  let iniBase;
  if (payload.documentIni && String(payload.documentIni).trim()) {
    iniBase = String(payload.documentIni);
  } else {
    fiscalIniPolicy.requireDocumentIniOrAllowLocal(payload, "NFS-e");
    throw new Error("documentIni obrigatório para NFS-e");
  }

  const ref = payload.numeroRps || payload.numeroVenda || Date.now();
  const iniPath = path.join(PATHS.ini, `nfse-lib-${ref}-${Date.now()}.ini`);
  fs.mkdirSync(path.dirname(iniPath), { recursive: true });
  fs.writeFileSync(iniPath, iniBase, "utf8");

  const { ACBrLibNFSeMT: LibClass, NFSeModoEnvio: ModoEnvio } = loadAcbrLibNfse();
  const lote = String(payload.numeroLote || payload.lote || "1");
  const modoEnvio = resolveModoEnvio(ModoEnvio);

  return acbr.withAcbrLock(async () => {
    // Runtime sob mutex — evita TOCTOU de DLL com outro slot/Inicializar.
    const runtime = buildNativeNfseRuntime();
    const nativeIni = acbrLibRuntime.resolveNativeDocumentIniPath(iniPath, runtime);
    fiscalTrace.trace("ACBrLibNFSe", "Início emissão nativa", {
      ini: nativeIni,
      lote,
      modoEnvio,
    });
    log.info(
      {
        libPath: runtime.libPath,
        iniConfig: runtime.iniConfig,
        iniPath: nativeIni,
        transport: "ffi",
        class: "ACBrLibNFSeMT",
        lote,
        modoEnvio,
      },
      "[ACBrLib NFSe] Emissão NATIVA",
    );

    return acbrLibRuntime.withNativeLibSession(runtime, async () => {
      const runOnce = async () => {
        const session = await acbrLibSession.ensureSession(runtime, LibClass);
        acbrLibSession.assertSessionAlive(session);
        acbrLibSession.scheduleIdleFinalize(session.slot);
        return session;
      };
      let session;
      try {
        session = await runOnce();
      } catch (err) {
        if (!acbrLibSession.shouldInvalidateOnError(err)) throw err;
        const koffiDead =
          acbrLibSession.isKoffiDeadHandleError(err) || err?.softDead === true;
        await acbrLibSession.invalidateNativeSession(
          koffiDead ? "koffi_dead" : "operation_error",
          "nfse",
        );
        if (koffiDead) acbrLibSession.clearSoftDead("nfse");
        session = await runOnce();
      }
      const inst = session.inst;
      acbrLibSession.assertSessionAlive(session);

      try {
        try {
          inst.limparLista();
        } catch (_) {
          /* ignore */
        }

        inst.carregarINI(nativeIni);
        log.info({ iniPath: nativeIni }, "[ACBrLib NFSe] CarregarINI OK");

        acbrLibRuntime.reloadNativeCertAfterCarregarIni(inst, runtime);

        inst.assinar();
        log.info("[ACBrLib NFSe] Assinar OK");

        inst.validar();
        log.info("[ACBrLib NFSe] Validar OK");

        const emissaoTimeoutMs = resolveEmissaoTimeoutMs();
        acbrLibSession.assertSessionAlive(session);
        const resposta = await Promise.race([
          Promise.resolve().then(() => inst.emitir(lote, modoEnvio, false)),
          new Promise((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `[ACBrLib NFSe] emitir timeout após ${emissaoTimeoutMs}ms — verifique certificado, provedor municipal e logs`,
                  ),
                ),
              emissaoTimeoutMs,
            ),
          ),
        ]);

        log.info(
          { respostaLen: String(resposta || "").length, preview: String(resposta || "").slice(0, 300) },
          "[ACBrLib NFSe] emitir retorno",
        );

        const p = parseRespostaNfse(resposta);
        if (!p.chave && !p.numero) {
          const err = new Error(
            `ACBrLib NFSe não retornou identificador. Resposta: ${String(resposta).slice(0, 500)}`,
          );
          if (/rejeit|erro|falha/i.test(String(resposta))) err.permanente = true;
          throw err;
        }

        const resultado = normalizarResultadoNfse(p, resposta);
        fiscalTrace.copiarLogAcbrStagingParaCanonico(runtime);
        fiscalTrace.trace("ACBrLibNFSe", "Emissão nativa concluída", {
          chave: resultado.chave,
          numero: resultado.numero,
        });
        log.info(
          { chave: resultado.chave, numero: resultado.numero, native: true },
          "[ACBrLib NFSe] Emissão NATIVA concluída",
        );
        return { ...resultado, native: true };
      } catch (err) {
        let ultimo = "";
        try {
          ultimo = typeof inst.ultimoRetorno === "function" ? inst.ultimoRetorno() : "";
        } catch (_) {
          /* ignore */
        }
        fiscalTrace.copiarLogAcbrStagingParaCanonico(runtime);
        fiscalTrace.error("ACBrLibNFSe", "Falha na emissão nativa", {
          err: err.message,
          ultimoRetorno: String(ultimo || "").slice(0, 500),
        });
        log.error({ err: err.message, ultimoRetorno: ultimo }, "[ACBrLib NFSe] Falha na emissão nativa");
        if (acbrLibSession.shouldInvalidateOnError(err)) {
          await acbrLibSession.invalidateNativeSession(
            acbrLibSession.isKoffiDeadHandleError(err) ? "koffi_dead" : "nfse_emissao_error",
            "nfse",
          );
        }
        throw err;
      }
    });
  }, "acbr-lib-nfse-native");
}

/**
 * Preferência: DLL nativa no Windows; senão Monitor TCP.
 */
async function emitirNfseLibCore(payload) {
  if (getNfseIntegrationMode() === "native") {
    return emitirNfseViaNativeLib(payload);
  }
  log.info(
    { libPath: resolveNfseLibPath(), platform: process.platform },
    "[ACBrLib NFSe] Sem FFI nativo — fallback Monitor TCP",
  );
  const nfseAcbr = require("./nfseAcbr");
  return nfseAcbr.emitirNfseCore(payload);
}

module.exports = {
  resolveNfseLibPath,
  resolveLibIniPath,
  canLoadNativeNfseLib,
  getNfseIntegrationMode,
  getNfseLibInfo,
  emitirNfseLibCore,
  emitirNfseViaNativeLib,
  defaultNfseLibFileName,
  loadAcbrLibNfse,
};

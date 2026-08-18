/**
 * Driver fiscal via ACBrLib nativa (FFI/koffi) — Onda B.5.
 *
 * Integração real: @projetoacbr/acbrlib-nfe-node → ACBrLibNFeMT → libacbrnfe64.so / ACBrNFe64.dll
 * NFS-e: @projetoacbr/acbrlib-nfse-node → ACBrLibNFSeMT → ACBrNFSe64.dll (fallback Monitor)
 *
 * Modos:
 * - native  — ACBR_LIB_PATH aponta para .so/.dll existente (provider OFICIAL 1.0)
 * - parity  — ACBR_LIB_ALLOW_PARITY=true SEM DLL; fallback Monitor TCP (dev/CI only)
 * - unconfigured — sem DLL e sem ALLOW_PARITY; emitir falha com erro explícito
 *
 * SEFAZ tpAmb: 1=produção · 2=homologação (XML/documentos).
 * ACBrLib [NFe] Ambiente: 0=produção · 1=homologação — gravado no INI pelo fiscalLocalConfig.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const acbr = require("../../acbr");
const log = require("../../logger").child({ modulo: "acbr_lib_driver" });
const fiscalNumeracao = require("../../fiscalNumeracao");
const { PATHS } = require("../../marginPaths");
const acbrLibResposta = require("../../acbrLibResposta");
const acbrLibRuntime = require("./acbrLibRuntime");
const acbrLibSession = require("./acbrLibSession");
const { validarPayloadNfe } = require("../../fiscalValidacaoNfe");
const fiscalTrace = require("../../fiscalTraceLog");
const fiscalEmissionLock = require("../fiscalEmissionLock");
const fiscalDhEmiIni = require("../fiscalDhEmiIni");
const { wrapAcbrExports } = require("../wrapAcbrExports");
const { isMainThread } = require("worker_threads");
const contingenciaOffline = require("../contingenciaOffline");
const contingenciaOfflineQueue = require("../contingenciaOfflineQueue");

const AGENT_ROOT = path.resolve(__dirname, "../..");

/** @type {typeof import('@projetoacbr/acbrlib-nfe-node/dist/src').default | null} */
let ACBrLibNFeMT = null;

function loadAcbrLibNFeMT() {
  if (ACBrLibNFeMT) return ACBrLibNFeMT;
  ACBrLibNFeMT = require("@projetoacbr/acbrlib-nfe-node/dist/src").default;
  return ACBrLibNFeMT;
}

const DRIVER_INFO = {
  provider: "acbr-lib",
  label: "ACBrLib (nativo FFI)",
  ready: true,
  transport: "ffi",
};

/** cNF determinístico em homologação/paridade (espelha PatchNumeracaoIni Java). */
const CNF_PARIDADE = process.env.ACBR_LIB_PARITY_CNF || "00000001";

function libCryptKey() {
  return process.env.ACBR_LIB_CRYPT_KEY || "";
}

function defaultLibFileName() {
  return os.platform() === "win32" ? "ACBrNFe64.dll" : "libacbrnfe64.so";
}

function resolveLibPath() {
  const explicit = process.env.ACBR_LIB_PATH;
  if (explicit) {
    const resolved = path.isAbsolute(explicit) ? explicit : path.resolve(AGENT_ROOT, explicit);
    if (fs.existsSync(resolved)) return resolved;
  }
  const libName = defaultLibFileName();
  const candidates = [
    path.join(AGENT_ROOT, "acbrlib", "lib", libName),
    path.join(AGENT_ROOT, "lib", libName),
    path.join(PATHS.root, "lib", libName),
    path.join(AGENT_ROOT, libName),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
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
 * DLL presente no disco só conta como nativo no Windows (FFI real).
 * Linux/CI: ACBR_LIB_ALLOW_PARITY → Monitor TCP mesmo com .dll no repo.
 */
function canLoadNativeLib() {
  if (process.platform !== "win32") return false;
  return !!resolveLibPath();
}

/**
 * @returns {"native"|"parity"|"unconfigured"}
 */
function getIntegrationMode() {
  if (canLoadNativeLib()) return "native";
  if (process.env.ACBR_LIB_ALLOW_PARITY === "true") return "parity";
  return "unconfigured";
}

/**
 * O processo HTTP nunca carrega koffi em produção Windows. A mesma superfície
 * do driver é executada no filho fiscal, que pode ser reiniciado isoladamente.
 */
function usarWorkerFiscal() {
  return (
    isMainThread &&
    process.env.ACBR_LIB_WORKER_CHILD !== "true" &&
    getIntegrationMode() === "native" &&
    String(process.env.ACBR_LIB_WORKER || "true").toLowerCase() !== "false"
  );
}

/**
 * StatusServico/testar atualizam memória no worker; o Diagnóstico lê o processo HTTP.
 * Espelha o resultado no pai para Motor/statusGeral ficarem alinhados ao SEFAZ.
 */
function syncStatusMemoriaFromWorkerResult(method, result) {
  if (method === "statusServico" && result && typeof result === "object") {
    if (result.operacional === true) {
      acbr.atualizarStatusMemoria(true);
    } else if (result.operacional === false) {
      acbr.atualizarStatusMemoria(false, { degradado: true });
    }
    return;
  }
  if (method === "testar") {
    acbr.atualizarStatusMemoria(!!result, result ? {} : { degradado: true });
    return;
  }
  if (method === "testarLibDetalhe" && result && typeof result === "object") {
    const ok = result.ok === true || result.operacional === true;
    acbr.atualizarStatusMemoria(ok, ok ? {} : { degradado: true });
  }
}

function executarNativo(method, local, timeoutMs) {
  return async (...args) => {
    if (!usarWorkerFiscal()) return local(...args);
    const result = await require("../acbrLibWorkerPool").call(method, args, { timeoutMs });
    try {
      syncStatusMemoriaFromWorkerResult(method, result);
    } catch (_) {}
    return result;
  };
}

function isNativeLibConfigured() {
  return getIntegrationMode() === "native";
}

function getDriverInfo() {
  const mode = getIntegrationMode();
  const nfseLib = require("../nfse/nfseLib");
  return {
    ...DRIVER_INFO,
    mode,
    native: mode === "native",
    parity: mode === "parity",
    libPath: resolveLibPath(),
    libIni: resolveLibIniPath(),
    parityCnf: CNF_PARIDADE,
    package: "@projetoacbr/acbrlib-nfe-node",
    ready: mode === "native" || mode === "parity",
    nfse: nfseLib.getNfseLibInfo(),
  };
}

function assertEmitivel() {
  const mode = getIntegrationMode();
  if (mode !== "unconfigured") return mode;
  throw new Error(
    "[ACBrLib] Biblioteca nativa não encontrada. Configure ACBR_LIB_PATH e ACBR_LIB_INI " +
      "(ou copie libacbrnfe64.so para agente-local/lib/ e data/acbrlib.ini). " +
      "Para dev/CI sem DLL, use ACBR_LIB_ALLOW_PARITY=true — isso NÃO é emissão nativa.",
  );
}

/**
 * Patch de numeração Lib — série/número da reserva; cNF da Lib (fixo em paridade).
 */
function patchNumeracaoIniLib(ini, numeracao) {
  if (!ini || !numeracao) return ini;
  const patched = acbr.patchNumeracaoIni(ini, numeracao);
  if (!patched) return patched;
  const cNf = numeracao.cNf || CNF_PARIDADE;
  const lines = String(patched).split(/\r?\n/);
  let inIdent = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "[Identificacao]") {
      inIdent = true;
      continue;
    }
    if (inIdent && line.startsWith("[")) break;
    if (!inIdent) continue;
    if (line.startsWith("cNF=")) lines[i] = `cNF=${cNf}`;
  }
  return lines.join("\n");
}

function resolveEmissaoTimeoutMs() {
  const libMs = parseInt(process.env.ACBR_LIB_EMISSAO_TIMEOUT_MS || "", 10);
  const filaMs = parseInt(process.env.FISCAL_EMISSAO_TIMEOUT_MS || "120000", 10);
  if (Number.isFinite(libMs) && libMs > 0) return libMs;
  return filaMs;
}

async function emitirNfceLib(payload) {
  const physical = require("../../runtime/physicalResourceLock");
  const map = require("../../runtime/physicalResourceMap");
  // Ordem: physicalLock → emissionLock (nunca o inverso)
  return physical.run(
    map.resolveNfeKey(),
    () =>
      fiscalEmissionLock.withEmissionLock(
        () => emitirNfceLibCore(payload),
        "acbr-lib-nfce",
      ),
    "nfe-emit",
  );
}

async function emitirNfceLibCore(payload) {
  if (payload?.xml || payload?.xmlEpec || payload?.modoEpec) {
    return emitirEpecLib(payload);
  }
  return emitirDocumentoLib(payload, "65");
}

async function emitirNfseLib(payload) {
  if (!acbr.isNfseHabilitado()) return { fiscal: false };
  const nfseLib = require("../nfse/nfseLib");
  const physical = require("../../runtime/physicalResourceLock");
  const map = require("../../runtime/physicalResourceMap");
  return physical.run(
    map.resolveNfeKey(),
    () =>
      fiscalEmissionLock.withEmissionLock(
        () => nfseLib.emitirNfseLibCore(payload),
        "lib-nfse",
      ),
    "nfse-emit",
  );
}

async function emitirNfeLib(payload) {
  if (!acbr.isNfeModelo55Habilitado()) return { fiscal: false };
  const physical = require("../../runtime/physicalResourceLock");
  const map = require("../../runtime/physicalResourceMap");
  return physical.run(
    map.resolveNfeKey(),
    () =>
      fiscalEmissionLock.withEmissionLock(
        () => emitirDocumentoLib(payload, "55"),
        "acbr-lib-nfe",
      ),
    "nfe55-emit",
  );
}

function resolverNumeracaoLib(payload, serie, modeloDf) {
  if (payload.numeroNfe) {
    return {
      serie: payload.serieNfe || serie,
      numero: parseInt(String(payload.numeroNfe).replace(/\D/g, ""), 10),
      cNf: CNF_PARIDADE,
      modelo: modeloDf,
    };
  }
  if (payload._fiscalMeta?.numeroNfe) {
    return {
      serie: payload._fiscalMeta.serieNfe || serie,
      numero: parseInt(String(payload._fiscalMeta.numeroNfe).replace(/\D/g, ""), 10),
      cNf: CNF_PARIDADE,
      modelo: modeloDf,
    };
  }
  return { ...fiscalNumeracao.reservarProximoNumero(serie, modeloDf), cNf: CNF_PARIDADE };
}

async function montarIniLib(payload, numeracao, modeloDf, empresa) {
  const fiscalIniPolicy = require("../fiscalIniPolicy");
  if (payload.documentIni && String(payload.documentIni).trim()) {
    return fiscalDhEmiIni.prepararIniParaEmissao(
      patchNumeracaoIniLib(payload.documentIni, numeracao),
    );
  }
  fiscalIniPolicy.requireDocumentIniOrAllowLocal(
    payload,
    modeloDf === "55" ? "NF-e" : "NFC-e",
  );
  if (modeloDf === "55") {
    const destinatario = validarPayloadNfe(payload);
    return acbr.montarIniNfe({ ...payload, empresa }, numeracao, destinatario);
  }
  return acbr.montarIniNfce({ ...payload, empresa }, numeracao);
}

async function emitirDocumentoLib(payload, modeloDf) {
  const mode = assertEmitivel();
  const empresa = await acbr.enriquecerEmpresa(payload.empresa || {}, {
    permitirRede: false,
  });
  acbr.validarEmpresaFiscal(empresa);

  const serie =
    modeloDf === "55"
      ? payload.serieNfe || fiscalNumeracao.SERIE_NFE_55
      : payload.serieNfe || fiscalNumeracao.SERIE_PADRAO;

  const numeracao = {
    ...resolverNumeracaoLib(payload, serie, modeloDf),
    numeroVenda: payload.numeroVenda || null,
  };
  const prefix = modeloDf === "55" ? "nfe-lib" : "nfce-lib";
  const ini = await montarIniLib(payload, numeracao, modeloDf, empresa);
  const iniPath = path.join(
    PATHS.ini,
    `${prefix}-${payload.numeroVenda || Date.now()}-${numeracao.numero}.ini`,
  );
  fs.mkdirSync(path.dirname(iniPath), { recursive: true });
  fs.writeFileSync(iniPath, ini, "utf8");

  if (mode === "native") {
    return await emitirViaNativeLib(iniPath, modeloDf, numeracao);
  }
  if (
    contingenciaOffline.isModeloNfce(modeloDf) &&
    contingenciaOffline.isContingenciaOperacionalAtiva()
  ) {
    throw new Error(
      "[ContingenciaOffline] NFC-e em contingência exige ACBrLib nativa (tpEmis=9). O Monitor TCP não emite off-line.",
    );
  }
  return await emitirViaParidade(iniPath, Number(modeloDf), numeracao);
}

/**
 * Retransmissão EPEC — carregarXML + enviar (nativo) ou Monitor TCP (paridade).
 */
async function emitirEpecLib(payload) {
  const xml = payload?.xml || payload?.xmlEpec;
  if (!xml || !String(xml).trim()) {
    throw new Error("XML EPEC ausente para retransmissao.");
  }

  const mode = getIntegrationMode();
  if (mode !== "native") {
    return acbr.emitirNfce(payload);
  }

  const xmlPath = path.join(PATHS.temp, `epec-lib-${Date.now()}.xml`);
  fs.mkdirSync(path.dirname(xmlPath), { recursive: true });
  fs.writeFileSync(xmlPath, xml, "utf8");

  return withNativeLib("epecRetransmit", (inst) => {
    inst.limparLista();
    inst.carregarXML(xmlPath);
    const resposta = inst.enviar(1, false, true, false);
    const p = acbr.parseResposta(resposta);
    if (!p.chave) {
      throw new Error(
        `ACBrLib EPEC não retornou chave. Resposta: ${String(resposta || "").slice(0, 500)}`,
      );
    }
    const resultado = acbr.normalizarResultado(p, resposta, "65");
    log.info(
      { chave: resultado.chave, protocolo: resultado.protocolo, native: true },
      "[ACBrLib] EPEC retransmitido (nativo)",
    );
    return { ...resultado, native: true };
  });
}

/**
 * Emissão nativa via ACBrLibNFeMT (koffi FFI → libacbrnfe64.so / ACBrNFe64.dll).
 */
async function emitirViaNativeLib(iniPath, modelo, numeracao) {
  const libPath = resolveLibPath();
  const iniConfig = resolveLibIniPath();

  if (!libPath) {
    throw new Error("[ACBrLib] Biblioteca fiscal não configurada neste caixa");
  }
  if (!iniConfig) {
    throw new Error("[ACBrLib] Configuração fiscal local ausente — reinstale ou repare o Margin Engine");
  }

  return acbr.withAcbrLock(async () => {
    // prepareNativeRuntime sob o mutex — evita TOCTOU overwrite de DLL com Inicializar paralelo.
    const runtime = buildNativeRuntime();
    const nativeIniPath = acbrLibRuntime.resolveNativeDocumentIniPath(iniPath, runtime);

    fiscalTrace.trace("ACBrLib", "Início emissão nativa", {
      modelo,
      ini: nativeIniPath,
      staging: !!runtime.staged,
      xmlDir: PATHS.xml,
      pdfDir: PATHS.pdf,
    });
    log.info(
      {
        libPath: runtime.libPath,
        iniConfig: runtime.iniConfig,
        iniPath: nativeIniPath,
        modelo,
        transport: "ffi",
        class: "ACBrLibNFeMT",
        staged: runtime.staged,
      },
      "[ACBrLib] Emissão NATIVA — sessão compartilhada",
    );

    const LibClass = loadAcbrLibNFeMT();
    try {
      return await runNativeOpWithRetry("emitir", runtime, LibClass, async (inst, _rt, session) => {
        try {
          try {
            inst.limparLista();
          } catch (_) {
            /* ignore */
          }

          if (
            contingenciaOffline.isModeloNfce(modelo) &&
            contingenciaOffline.isContingenciaOperacionalAtiva()
          ) {
            return emitirNfceContingenciaOffline(
              inst,
              runtime,
              nativeIniPath,
              modelo,
              numeracao,
              { ok: false, motivo: "contingencia_ativa" },
            );
          }

          if (
            contingenciaOffline.isEnabled() &&
            contingenciaOffline.isModeloNfce(modelo)
          ) {
            const probe = await contingenciaOffline.probeStatusServicoComRetry(
              inst,
              acbrLibResposta,
              log,
            );
            if (probe.ok) {
              contingenciaOfflineQueue.fecharJanelaDhCont();
            } else {
              return emitirNfceContingenciaOffline(
                inst,
                runtime,
                nativeIniPath,
                modelo,
                numeracao,
                probe,
              );
            }
          }

          contingenciaOffline.gravarFormaEmissao(
            inst,
            contingenciaOffline.FORMA_NORMAL,
            null,
          );
          inst.carregarINI(nativeIniPath);
          log.info({ iniPath: nativeIniPath }, "[ACBrLib] NFE_CarregarINI OK");

          acbrLibRuntime.reloadNativeCertAfterCarregarIni(inst, runtime);

          inst.assinar();
          log.info("[ACBrLib] NFE_Assinar OK");

          inst.validar();
          log.info("[ACBrLib] NFE_Validar OK");

          const emissaoTimeoutMs = resolveEmissaoTimeoutMs();
          const resposta = await Promise.race([
            Promise.resolve().then(() => inst.enviar(1, false, true, false)),
            new Promise((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    new Error(
                      `[ACBrLib] NFE_Enviar timeout após ${emissaoTimeoutMs}ms — verifique certificado, SEFAZ e logs do agente`,
                    ),
                  ),
                emissaoTimeoutMs,
              ),
            ),
          ]);
          log.info(
            { respostaLen: String(resposta || "").length, preview: String(resposta || "").slice(0, 300) },
            "[ACBrLib] NFE_Enviar retorno",
          );

          const p0 = acbrLibResposta.parseRespostaLib(resposta);
          let p = await acbr.enrichParsePosEmissaoAsync(p0, resposta, {
            consultar: async (chave) => {
              acbrLibSession.assertSessionAlive(session);
              const chaveNorm = String(chave || "").replace(/\D/g, "");
              const raw = inst.consultar(chaveNorm, true);
              const parsed = acbrLibResposta.parseRespostaLib(raw);
              return {
                chave: chaveNorm,
                cStat: parsed.cStat,
                xMotivo: parsed.xMotivo,
                protocolo: parsed.protocolo,
                situacao: acbr.inferirSituacao(parsed.cStat, raw),
                raw,
                native: true,
              };
            },
          });
          acbr.assertAutorizada(p, resposta, modelo);
          log.info(
            { cStat: p.cStat, chave: p.chave, protocolo: p.protocolo, xMotivo: p.xMotivo },
            "[ACBrLib] Resposta parseada (chave/protocolo SEFAZ)",
          );

          if (numeracao?.serie != null) {
            try {
              fiscalNumeracao.sincronizarNumeroAutorizado(
                numeracao.serie,
                p.numero || numeracao.numero,
                modelo,
              );
            } catch (syncErr) {
              log.warn(
                { err: syncErr.message },
                "[ACBrLib] sincronizarNumeracao ignorada (sqlite indisponível)",
              );
            }
          }

          const resultado = acbr.normalizarResultado(p, resposta, modelo);
          const artifacts = persistNativeEmissaoOutputs(inst, runtime, p.chave, modelo);
          fiscalTrace.copiarLogAcbrStagingParaCanonico(runtime);
          fiscalTrace.trace("ACBrLib", "Emissão nativa concluída", {
            chave: resultado.chave,
            cStat: resultado.cStat,
            xmlPath: artifacts.xmlPath,
            pdfPath: artifacts.pdfPath,
          });
          log.info(
            {
              chave: resultado.chave,
              protocolo: resultado.protocolo,
              cStat: resultado.cStat,
              xmlPath: artifacts.xmlPath,
              pdfPath: artifacts.pdfPath,
              native: true,
            },
            "[ACBrLib] Emissão NATIVA concluída",
          );
          return {
            ...resultado,
            native: true,
            xmlPath: artifacts.xmlPath,
            pdfPath: artifacts.pdfPath,
          };
        } catch (err) {
          let ultimo = "";
          try {
            ultimo = typeof inst.ultimoRetorno === "function" ? inst.ultimoRetorno() : "";
          } catch (_) {
            /* ignore */
          }
          fiscalTrace.copiarLogAcbrStagingParaCanonico(runtime);
          fiscalTrace.error("ACBrLib", "Falha na emissão nativa", {
            err: err.message,
            ultimoRetorno: String(ultimo || "").slice(0, 500),
          });
          log.error({ err: err.message, ultimoRetorno: ultimo }, "[ACBrLib] Falha na emissão nativa");
          throw err;
        }
      });
    } catch (err) {
      throw err;
    }
  }, "acbr-lib-native");
}

/**
 * NFC-e off-line: FormaEmissao=8 (teOffLine) → INI tpEmis=9 + dhCont/xJust
 * → Assinar → GravarXML. Sem NFE_Enviar. Restaura teNormal=0 no finally.
 */
function emitirNfceContingenciaOffline(inst, runtime, nativeIniPath, modelo, numeracao, probe) {
  try {
    try {
      inst.limparLista();
    } catch (_) {}

    const dhCont = contingenciaOfflineQueue.obterOuAbrirJanelaDhCont(new Date());
    const iniOffline = contingenciaOffline.escreverIniOffline(nativeIniPath, { dhCont });

    let xmlPeek = "";
    let ultimoCheck = null;
    const maxAssinar = 2;
    for (let tentativa = 1; tentativa <= maxAssinar; tentativa++) {
      if (tentativa > 1) {
        try {
          inst.limparLista();
        } catch (_) {}
      }
      contingenciaOffline.garantirFormaEmissaoOffline(inst, log);
      inst.carregarINI(iniOffline);
      // CarregarINI restaura FormaEmissao=0 do INI global — teOffLine de novo antes de Assinar.
      contingenciaOffline.garantirFormaEmissaoOffline(inst, log);
      if (tentativa === 1) {
        log.info(
          {
            iniPath: iniOffline,
            dhCont,
            formaEmissaoLib: contingenciaOffline.lerFormaEmissao(inst),
            tpEmisXml: contingenciaOffline.TP_EMIS_XML_OFFLINE,
          },
          "[ContingenciaOffline] NFE_CarregarINI (FormaEmissao=8 / tpEmis=9)",
        );
      }
      acbrLibRuntime.reloadNativeCertAfterCarregarIni(inst, runtime);

      inst.assinar();
      log.info({ tentativa }, "[ContingenciaOffline] NFE_Assinar OK");
      try {
        inst.validar();
      } catch (valErr) {
        log.warn({ err: valErr.message }, "[ContingenciaOffline] NFE_Validar avisou — XML será gravado");
      }

      xmlPeek = contingenciaOffline.lerXmlAssinadoDaLista(inst);
      ultimoCheck = contingenciaOffline.xmlNfceOfflineValido(xmlPeek);
      if (ultimoCheck.ok && !contingenciaOffline.xmlTemAssinatura(xmlPeek)) {
        ultimoCheck = {
          ok: false,
          motivo: "assinatura",
          detalhe: "XML sem Signature após NFE_Assinar",
        };
      }
      if (ultimoCheck.ok) break;
      log.warn(
        {
          tentativa,
          motivo: ultimoCheck.motivo,
          detalhe: ultimoCheck.detalhe,
          formaEmissaoLib: contingenciaOffline.lerFormaEmissao(inst),
          xmlLen: xmlPeek.length,
        },
        "[ContingenciaOffline] XML pós-assinar inválido — nova tentativa",
      );
    }

    if (!xmlPeek.trim()) {
      throw new Error("[ContingenciaOffline] XML vazio após NFE_Assinar");
    }
    if (!ultimoCheck?.ok) {
      contingenciaOffline.assertXmlNfceOffline(xmlPeek);
    }
    const metaPeek = contingenciaOffline.metaDoXml(xmlPeek);
    const chave = String(metaPeek.chave || "").replace(/\D/g, "");
    if (chave.length !== 44) {
      throw new Error("[ContingenciaOffline] chave de 44 dígitos ausente após assinar");
    }

    const destXml = PATHS.xml || runtime.notas;
    const gravado = contingenciaOffline.gravarXmlAssinado(inst, destXml, chave);
    let xml = gravado.xml;
    contingenciaOffline.assertXmlNfceOffline(xml);
    const meta = contingenciaOffline.metaDoXml(xml);

    contingenciaOfflineQueue.enqueue({
      chave,
      numero: meta.numero || numeracao?.numero,
      serie: meta.serie || numeracao?.serie,
      xmlPath: gravado.xmlPath,
      numeroVenda: numeracao?.numeroVenda || null,
      dhCont,
      terminalId: contingenciaOffline.terminalId(),
    });

    let pdfPath = null;
    try {
      const artifacts = persistNativeEmissaoOutputs(inst, runtime, chave, modelo, {
        xmlJaSalvo: gravado.xmlPath,
      });
      pdfPath = artifacts.pdfPath || null;
      const xmlLista = contingenciaOffline.lerXmlAssinadoDaLista(inst);
      const xmlPos =
        xmlLista ||
        (artifacts.xmlPath && fs.existsSync(artifacts.xmlPath)
          ? fs.readFileSync(artifacts.xmlPath, "utf8")
          : "");
      const consolidado = contingenciaOffline.persistirXmlFilaAposDanfe(
        gravado.xmlPath,
        xmlPos,
        chave,
      );
      if (consolidado) xml = consolidado;
    } catch (printErr) {
      log.warn(
        { err: printErr.message, chave, xmlPath: gravado.xmlPath },
        "[ContingenciaOffline] DANFE falhou após XML gravado — XML preservado na fila",
      );
    }

    const xmlFila = fs.readFileSync(gravado.xmlPath, "utf8");
    contingenciaOffline.assertXmlNfceOffline(xmlFila);
    xml = xmlFila;

    fiscalTrace.trace("ContingenciaOffline", "NFC-e gravada sem envio SEFAZ", {
      chave,
      xmlPath: gravado.xmlPath,
      dhCont,
      probe: probe?.cStat || probe?.erro || "indisponivel",
      tentativasProbe: probe?.tentativas,
    });
    log.info(
      { chave, xmlPath: gravado.xmlPath, pdfPath, dhCont, native: true },
      "[ContingenciaOffline] XML persistido antes do DANFE — pendente de sincronização",
    );

    const qr = require("../../documentosFiscais").extrairQrCodeDoXml(xml);
    return {
      chave,
      numero: meta.numero || numeracao?.numero,
      serie: meta.serie || numeracao?.serie || "001",
      qrcode: qr,
      protocolo: null,
      cStat: null,
      xMotivo: "NFC-e emitida em contingência off-line (tpEmis=9) — transmissão pendente",
      xml,
      fiscal: true,
      modeloDocumento: String(modelo),
      chaveNfe: chave,
      numeroNfe: meta.numero || numeracao?.numero,
      serieNfe: meta.serie || numeracao?.serie || "001",
      qrcodeNfe: qr,
      native: true,
      xmlPath: gravado.xmlPath,
      pdfPath,
      contingenciaOffline: true,
      statusFiscal: "CONTINGENCIA_OFFLINE",
      dhCont,
    };
  } finally {
    contingenciaOffline.gravarFormaEmissao(inst, contingenciaOffline.FORMA_NORMAL, log);
    try {
      inst.limparLista();
    } catch (_) {}
  }
}

let syncOfflineInflight = null;

async function sincronizarNfceOfflineLib() {
  if (getIntegrationMode() !== "native") {
    return { ok: true, skipped: true, motivo: "nao_nativo" };
  }
  if (syncOfflineInflight) return syncOfflineInflight;

  syncOfflineInflight = (async () => {
    const pendentesAntes = contingenciaOfflineQueue.contarPendentes();
    if (pendentesAntes === 0) {
      return { ok: true, skipped: true, motivo: "sem_pendentes", pendentes: 0 };
    }
    const { rows: pendentes } = contingenciaOfflineQueue.claimPendentes(10, 180_000);
    const resultados = [];
    for (const row of pendentes) {
      const xmlPath = row.xml_path;
      if (!xmlPath || !fs.existsSync(xmlPath)) {
        contingenciaOfflineQueue.marcarRejeicao(row.chave, "XML ausente no disco", "xml");
        resultados.push({ chave: row.chave, ok: false, tipo: "REJEICAO", erro: "xml_ausente" });
        continue;
      }
      try {
        const xmlDisco = fs.readFileSync(xmlPath, "utf8");
        try {
          contingenciaOffline.assertXmlProntoParaTransmissao(xmlDisco, row.chave);
        } catch (valErr) {
          contingenciaOfflineQueue.marcarRejeicao(row.chave, valErr.message, "xml");
          resultados.push({
            chave: row.chave,
            ok: false,
            tipo: "REJEICAO",
            erro: valErr.message,
          });
          continue;
        }
        const resultado = await withNativeLib("offlineRetransmit", (inst, runtime) => {
          contingenciaOffline.gravarFormaEmissao(inst, contingenciaOffline.FORMA_NORMAL, log);
          try {
            inst.limparLista();
            inst.carregarXML(xmlPath);
            const xmlLista =
              contingenciaOffline.lerXmlAssinadoDaLista(inst) || xmlDisco;
            contingenciaOffline.assertXmlProntoParaTransmissao(xmlLista, row.chave);
            const resposta = inst.enviar(1, false, true, false);
            const p0 = acbrLibResposta.parseRespostaLib(resposta);
            acbr.assertAutorizada(p0, resposta, "65");
            const chaveFila = String(row.chave).replace(/\D/g, "");
            const chaveRet = String(p0.chave || "").replace(/\D/g, "");
            if (chaveRet.length === 44 && chaveRet !== chaveFila) {
              throw new Error(
                `[ContingenciaOffline] chave devolvida (${chaveRet}) diverge da impressa (${chaveFila})`,
              );
            }
            const artifacts = persistNativeEmissaoOutputs(inst, runtime, chaveFila, "65");
            return {
              chave: chaveFila,
              cStat: p0.cStat,
              protocolo: p0.protocolo,
              xMotivo: p0.xMotivo,
              dhRecbto: p0.dhRecbto,
              numero: p0.numero,
              serie: p0.serie,
              xmlPath: artifacts.xmlPath,
              pdfPath: artifacts.pdfPath,
            };
          } finally {
            contingenciaOffline.gravarFormaEmissao(inst, contingenciaOffline.FORMA_NORMAL, log);
            try {
              inst.limparLista();
            } catch (_) {}
          }
        });
        contingenciaOfflineQueue.marcarTransmitido(resultado.chave, resultado.protocolo);
        try {
          await require("../../fiscalService").notificarOfflineTransmitido(
            resultado,
            row.numero_venda,
          );
        } catch (cbErr) {
          log.warn(
            { chave: resultado.chave, err: cbErr.message },
            "[ContingenciaOffline] Transmitida SEFAZ — callback backend pendente",
          );
        }
        resultados.push({ chave: resultado.chave, ok: true, cStat: resultado.cStat });
        log.info(
          { chave: resultado.chave, protocolo: resultado.protocolo },
          "[ContingenciaOffline] Transmitida à SEFAZ",
        );
      } catch (err) {
        const cls = contingenciaOffline.classificarResultadoSync(err);
        if (cls.consultar) {
          try {
            const cons = await consultarChaveLib(row.chave);
            const cs = String(cons?.cStat || "");
            if (cs === "100" || cs === "150" || cons?.situacao === "AUTORIZADA") {
              contingenciaOfflineQueue.marcarTransmitido(row.chave, cons.protocolo);
              try {
                await require("../../fiscalService").notificarOfflineTransmitido(
                  {
                    chave: row.chave,
                    cStat: cs,
                    protocolo: cons.protocolo,
                    xMotivo: cons.xMotivo,
                  },
                  row.numero_venda,
                );
              } catch (_) {}
              resultados.push({ chave: row.chave, ok: true, cStat: cs, via: "consulta_duplicidade" });
              continue;
            }
          } catch (_) {}
        }
        if (cls.reter) {
          contingenciaOfflineQueue.marcarFalhaRede(row.chave, err.message);
          resultados.push({
            chave: row.chave,
            ok: false,
            tipo: "REDE",
            erro: err.message,
            cStat: cls.cStat,
          });
          log.warn(
            { chave: row.chave, err: err.message, cStat: cls.cStat },
            "[ContingenciaOffline] Falha de rede/SEFAZ instável — permanece na fila",
          );
        } else {
          contingenciaOfflineQueue.marcarRejeicao(row.chave, err.message, cls.cStat);
          try {
            require("../../fiscalAlertas").alertarFalhaPermanente({
              numeroVenda: row.numero_venda,
              chave: row.chave,
              cStat: cls.cStat,
              erro: err.message,
              origem: "contingencia_offline_sync",
            });
          } catch (_) {}
          resultados.push({
            chave: row.chave,
            ok: false,
            tipo: "REJEICAO",
            erro: err.message,
            cStat: cls.cStat,
          });
          log.error(
            { chave: row.chave, err: err.message, cStat: cls.cStat },
            "[ContingenciaOffline] Rejeição SEFAZ — intervenção manual (sai da fila de retry)",
          );
        }
      }
    }
    const idade = contingenciaOfflineQueue.metricasIdade();
    return {
      ok: true,
      processados: resultados.length,
      transmitidos: resultados.filter((r) => r.ok).length,
      rejeicoes: resultados.filter((r) => r.tipo === "REJEICAO").length,
      pendentes: contingenciaOfflineQueue.contarPendentes(),
      alertaIdade: idade.alertaIdade,
      resultados,
    };
  })().finally(() => {
    syncOfflineInflight = null;
  });

  return syncOfflineInflight;
}

/** Fallback Monitor TCP — apenas com ACBR_LIB_ALLOW_PARITY=true (não é rollout). */
async function emitirViaParidade(iniPath, modeloDf, numeracao) {
  log.warn(
    { iniPath, modeloDf },
    "[ACBrLib] MODO PARIDADE — sem biblioteca nativa; delegando ao Monitor TCP (NÃO usar em rollout)",
  );
  const { p, resposta } = await acbr.criarEnviarIniModelo(iniPath, modeloDf);
  fiscalNumeracao.sincronizarNumeroAutorizado(numeracao.serie, p.numero || numeracao.numero, String(modeloDf));
  return acbr.normalizarResultado(p, resposta, String(modeloDf));
}

function warnIfSelectedAtBoot() {
  const info = getDriverInfo();
  if (info.mode === "native") {
    log.info(
      { libPath: info.libPath, libIni: info.libIni },
      "[ACBrLib] Modo NATIVO ativo — FFI via ACBrLibNFeMT",
    );
  } else if (info.mode === "parity") {
    log.warn(
      "[ACBrLib] Modo PARIDADE ativo (ACBR_LIB_ALLOW_PARITY) — emissão via Monitor TCP, não é biblioteca nativa",
    );
  } else {
    log.error(
      "[ACBrLib] Driver Lib selecionado mas biblioteca nativa não encontrada — emissões falharão até configurar ACBR_LIB_PATH",
    );
  }
  if (info.nfse?.native) {
    log.info(
      { libPath: info.nfse.libPath },
      "[ACBrLib NFSe] Modo NATIVO — FFI via ACBrLibNFSeMT",
    );
  } else {
    log.info(
      { libPath: info.nfse?.libPath || null, platform: process.platform },
      "[ACBrLib NFSe] Fallback Monitor TCP (DLL ausente ou plataforma sem FFI)",
    );
  }
}

function buildNativeRuntime() {
  const libPath = resolveLibPath();
  const iniConfig = resolveLibIniPath();
  if (!libPath || !iniConfig) {
    throw new Error("[ACBrLib] Biblioteca ou INI não configurados");
  }
  const iniVals = acbrLibRuntime.readIniValues(iniConfig);
  const runtime = acbrLibRuntime.prepareNativeRuntime({
    libPath,
    iniConfigPath: iniConfig,
    assets: {
      lib: path.dirname(libPath),
      schemas: iniVals.pathSchemas || path.join(AGENT_ROOT, "schemas", "NFe"),
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

async function withNativeLib(opName, fn) {
  if (getIntegrationMode() !== "native") {
    throw new Error(`[ACBrLib] ${opName} requer biblioteca nativa configurada`);
  }
  // No processo HTTP, toda FFI pertence ao filho fiscal. Isto impede que uma
  // rota esquecida (ex.: PDF) volte a carregar koffi no processo que atende 9100.
  if (usarWorkerFiscal()) {
    const err = new Error(
      `[ACBrLib] ${opName} bloqueado no processo principal; use o worker fiscal`,
    );
    err.code = "ACBR_LIB_WORKER_OWNS_SESSION";
    throw err;
  }
  const LibClass = loadAcbrLibNFeMT();
  return acbr.withAcbrLock(async () => {
    const runtime = buildNativeRuntime();
    log.info({ opName }, "[ACBrLib] operação nativa (sessão compartilhada)");
    return runNativeOpWithRetry(opName, runtime, LibClass, fn);
  }, `acbr-lib-${opName}`);
}

/**
 * Executa op nativa.
 * Handle koffi morto (void **): NÃO cria nova sessão no mesmo processo
 * (Inicializar sem Finalizar da instância abandonada corrompe o koffi).
 * Única recuperação = recycle do processo.
 */
async function runNativeOpWithRetry(opName, runtime, LibClass, fn) {
  const processRecycle = require("./acbrLibProcessRecycle");
  if (processRecycle.isProcessPoisoned()) {
    const e = new Error(
      "ACBrLib koffi envenenado — o serviço do agente está reiniciando automaticamente",
    );
    e.reiniciarAcbr = true;
    e.processPoisoned = true;
    e.retryable = true;
    processRecycle.scheduleRecycle("op_poisoned");
    throw e;
  }
  return acbrLibRuntime.withNativeLibSession(runtime, async () => {
    const runOnce = async () => {
      const session = await acbrLibSession.ensureSession(runtime, LibClass);
      acbrLibSession.scheduleIdleFinalize(session.slot);
      acbrLibSession.assertSessionAlive(session);
      return await fn(session.inst, runtime, session);
    };
    try {
      return await runOnce();
    } catch (err) {
      if (!acbrLibSession.shouldInvalidateOnError(err)) throw err;
      const slot = acbrLibSession.resolveSlotKey(runtime);
      const koffiDead =
        acbrLibSession.isKoffiDeadHandleError(err) || err?.softDead === true;
      await acbrLibSession.invalidateNativeSession(
        koffiDead ? "koffi_dead" : "operation_error",
        slot,
      );
      if (koffiDead) {
        // Proibido: novo Inicializar com handle anterior ainda vivo na DLL.
        log.error(
          { opName, err: err.message, slot, metric: "acbrlib.koffi_no_inplace_retry" },
          "[ACBrLib] void** — reciclando processo (sem nova sessão in-process)",
        );
        processRecycle.markProcessPoisoned(`koffi_dead:${opName}`);
        err.reiniciarAcbr = true;
        err.processPoisoned = true;
        err.retryable = true;
        throw err;
      }
      log.warn(
        { opName, err: err.message, slot },
        "[ACBrLib] Sessão invalidada — retry único",
      );
      try {
        return await runOnce();
      } catch (err2) {
        if (acbrLibSession.shouldInvalidateOnError(err2)) {
          await acbrLibSession.invalidateNativeSession(
            acbrLibSession.isKoffiDeadHandleError(err2)
              ? "koffi_dead"
              : "operation_error",
            slot,
          );
          if (acbrLibSession.isKoffiDeadHandleError(err2) || err2?.processPoisoned) {
            processRecycle.markProcessPoisoned(`retry_failed:${opName}`);
          }
        }
        throw err2;
      }
    }
  });
}

/** Cache curto de StatusServico — Diagnóstico/watchdog/front não martelam a SEFAZ/DLL. */
let statusServicoCache = { at: 0, value: null };
let statusServicoInflight = null;
const STATUS_SERVICO_TTL_MS = parseInt(
  process.env.ACBR_STATUS_SERVICO_TTL_MS || "45000",
  10,
);

function invalidateStatusServicoCache() {
  statusServicoCache = { at: 0, value: null };
}

/**
 * ACBrLib (TipoResposta=JSON) às vezes devolve Status CStat=0 vazio enquanto
 * SalvarWS=1 grava *-sta.xml com cStat real da SEFAZ (ex.: 107).
 */
function readLatestStatusFromNotasXml(notasDir, maxAgeMs = 120000) {
  try {
    if (!notasDir || !fs.existsSync(notasDir)) return null;
    const cutoff = Date.now() - Math.max(5000, maxAgeMs);
    const files = fs
      .readdirSync(notasDir)
      .filter((f) => /-sta\.xml$/i.test(f) && !/-ped-sta/i.test(f))
      .map((f) => {
        const full = path.join(notasDir, f);
        try {
          return { full, mtimeMs: fs.statSync(full).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const file of files.slice(0, 5)) {
      if (file.mtimeMs < cutoff) continue;
      const xml = fs.readFileSync(file.full, "utf8");
      const parsed = acbrLibResposta.parseRetConsStatServXml(xml);
      if (parsed?.cStat) {
        return { ...parsed, file: file.full, mtimeMs: file.mtimeMs };
      }
    }
  } catch (_) {
    /* ignore */
  }
  return null;
}

function resolveStatusNotasDirs() {
  const temp = process.env.TEMP || process.env.TMP || os.tmpdir();
  const dirs = [
    path.join(temp, "margin-acbrlib", "notas"),
    PATHS?.xml,
    path.join(AGENT_ROOT, "notas"),
  ];
  return [...new Set(dirs.filter(Boolean))];
}

async function statusServicoLib() {
  if (getIntegrationMode() !== "native") {
    return acbr.statusServico();
  }
  const processRecycle = require("./acbrLibProcessRecycle");
  if (processRecycle.isProcessPoisoned()) {
    acbr.atualizarStatusMemoria(false, { degradado: true });
    processRecycle.scheduleRecycle("status_poisoned");
    return {
      operacional: false,
      cStat: null,
      xMotivo: "ACBrLib koffi envenenado — reiniciando serviço",
      native: true,
      processPoisoned: true,
      cached: false,
    };
  }
  const ttl = Math.max(5000, STATUS_SERVICO_TTL_MS);
  const negTtl = Math.max(2000, parseInt(process.env.ACBR_STATUS_SERVICO_NEG_TTL_MS || "5000", 10));
  if (statusServicoCache.value && Date.now() - statusServicoCache.at < ttl) {
    const cached = statusServicoCache.value;
    // Negativos: TTL curto — não acelerar EPEC com falhas em cache.
    if (cached.operacional || Date.now() - statusServicoCache.at < negTtl) {
      // Diagnóstico lê obterStatusMemoria — manter alinhado ao StatusServico (incl. cache).
      acbr.atualizarStatusMemoria(!!cached.operacional, cached.operacional ? {} : { degradado: true });
      return cached;
    }
  }
  if (statusServicoInflight) return statusServicoInflight;

  statusServicoInflight = (async () => {
    try {
      const { resposta, configEfetiva, ultimoRetorno } = await withNativeLib("statusServico", (inst) => {
        const read = (secao, chave) => {
          try {
            return String(inst.configLerValor(secao, chave) || "");
          } catch {
            return null;
          }
        };
        const resposta = inst.statusServico();
        let ultimoRetorno = "";
        try {
          if (typeof inst.ultimoRetorno === "function") {
            ultimoRetorno = String(inst.ultimoRetorno() || "");
          }
        } catch (_) {}
        return {
          resposta,
          ultimoRetorno,
          configEfetiva: {
            ambiente: read("NFe", "Ambiente"),
            ambienteSefaz: read("NFe", "AmbienteSefaz"),
            sslCryptLib: read("DFe", "SSLCryptLib"),
            sslHttpLib: read("DFe", "SSLHttpLib"),
            sslXmlSignLib: read("DFe", "SSLXmlSignLib"),
            sslType: read("DFe", "SSLType"),
            uf: read("DFe", "UF"),
            arquivoPfx: read("DFe", "ArquivoPFX"),
            certificadoArquivo: read("Certificado", "Arquivo"),
          },
        };
      });
      let p = acbrLibResposta.parseRespostaLib(resposta);
      let statusSource = "json";
      if (acbrLibResposta.isHollowStatusJson(p)) {
        for (const dir of resolveStatusNotasDirs()) {
          const fromXml = readLatestStatusFromNotasXml(dir);
          if (fromXml?.cStat) {
            p = fromXml;
            statusSource = "sta_xml";
            log.info(
              {
                cStat: fromXml.cStat,
                xMotivo: fromXml.xMotivo,
                file: fromXml.file,
                metric: "acbrlib.status_servico_xml_fallback",
              },
              "[ACBrLib] StatusServico recuperado do XML WS (JSON nativo vazio)",
            );
            break;
          }
        }
      }
      const operacional =
        p.cStat === "107" ||
        p.cStat === "108" ||
        String(p.xMotivo || resposta || "")
          .toUpperCase()
          .includes("SERVICO EM OPERACAO");
      const xMotivo =
        p.xMotivo ||
        (!operacional && ultimoRetorno ? String(ultimoRetorno).slice(0, 280) : null);
      const value = {
        operacional,
        cStat: p.cStat,
        xMotivo,
        tpAmb: p.tpAmb,
        raw: statusSource === "sta_xml" ? p.raw : resposta,
        native: true,
        statusSource,
        configEfetiva,
        ultimoRetorno: ultimoRetorno ? String(ultimoRetorno).slice(0, 500) : null,
        cached: false,
      };
      if (!operacional) {
        log.warn(
          {
            cStat: p.cStat,
            xMotivo: xMotivo || null,
            tpAmb: p.tpAmb || null,
            configEfetiva,
            ultimoRetorno: value.ultimoRetorno,
            raw: String(resposta || "").slice(0, 4000),
            metric: "acbrlib.status_servico_indisponivel",
          },
          "[ACBrLib] StatusServico não operacional",
        );
      }
      // Cache positivo no TTL longo; negativo só no TTL curto (gravado com mesmo at).
      statusServicoCache = { at: Date.now(), value: { ...value, cached: true } };
      // Alinha Motor/statusGeral do Diagnóstico (não depender só de testar()).
      acbr.atualizarStatusMemoria(operacional, operacional ? {} : { degradado: true });
      return value;
    } catch (err) {
      invalidateStatusServicoCache();
      throw err;
    } finally {
      statusServicoInflight = null;
    }
  })();

  return statusServicoInflight;
}

/** Último erro de testar/statusServico — watchdog usa para não abrir EPEC em falha de certificado. */
let lastTestarErro = null;

function getLastTestarErro() {
  return lastTestarErro;
}

async function testarLib() {
  if (getIntegrationMode() !== "native") {
    return acbr.testar();
  }
  // Paridade com acbr.testar() / probe /status — sem StatusServico nativo se emissão off.
  if (!acbr.EMISSAO_FISCAL) {
    acbr.atualizarStatusMemoria(false);
    return false;
  }
  const processRecycle = require("./acbrLibProcessRecycle");
  if (processRecycle.isProcessPoisoned()) {
    acbr.atualizarStatusMemoria(false, { degradado: true });
    processRecycle.scheduleRecycle("testar_poisoned");
    return false;
  }
  try {
    const st = await statusServicoLib();
    const ok = st.operacional !== false;
    lastTestarErro = ok ? null : st.erro || st.xMotivo || "StatusServico não operacional";
    acbr.atualizarStatusMemoria(ok, ok ? {} : { degradado: true });
    return ok;
  } catch (err) {
    lastTestarErro = err?.message || String(err);
    let cert = null;
    let senhaProbe = null;
    try {
      const { certProofForLog, validatePfxPassword } = require("../certProof");
      const proof = acbrLibRuntime.getLastCertProof({ refresh: true });
      cert = certProofForLog(proof);
      const pfx = proof?.stagedPath || proof?.sourcePath;
      let senhaEfetiva = "";
      try {
        senhaEfetiva = acbrLibRuntime.readIniValues(resolveLibIniPath()).senha || "";
      } catch (_) {}
      if (pfx) {
        const probe = validatePfxPassword(pfx, senhaEfetiva);
        // Chaves sem "senha/cert" — sanitizer não engole o diagnóstico.
        senhaProbe = {
          pfxOk: probe.ok === true,
          reason: probe.reason || null,
          vaultHasPassword: !!senhaEfetiva,
          thumbprint: probe.meta?.thumbprint || null,
          notAfter: probe.meta?.notAfter || null,
        };
      } else {
        senhaProbe = { pfxOk: false, reason: "arquivo_ausente", vaultHasPassword: !!senhaEfetiva };
      }
    } catch (_) {}
    log.warn(
      {
        err: err.message,
        cert,
        pfxPasswordProbe: senhaProbe,
        metric: "acbrlib.cert_password_probe",
      },
      "[ACBrLib] testar() falhou",
    );
    if (acbrLibSession.isKoffiDeadHandleError(err) || err?.processPoisoned) {
      // withNativeLib já marcou poison + recycle — não abrir nova sessão aqui.
      acbr.atualizarStatusMemoria(false, { degradado: true });
      return false;
    }
    if (acbrLibSession.shouldInvalidateOnError(err) || err?.softDead) {
      try {
        await acbr.withAcbrLock(async () => {
          await acbrLibSession.invalidateNativeSession("testar_soft", "nfe");
        }, "testar_soft");
      } catch (_) {}
      invalidateStatusServicoCache();
    }
    acbr.atualizarStatusMemoria(false, { degradado: true });
    return false;
  }
}

/** Detalhe do teste nativo (diagnóstico) — não usar como boolean. */
async function testarLibDetalhe() {
  if (getIntegrationMode() !== "native") {
    const ok = await acbr.testar();
    return { ok, native: false };
  }
  const st = await statusServicoLib();
  return {
    ok: st.operacional !== false,
    cStat: st.cStat,
    xMotivo: st.xMotivo,
    native: true,
  };
}

function destinoPdfCanonico(chave, modeloDocumento, formatoPdf = "termico") {
  const { destinoPdfCanonico: destFmt } = require("../../fiscalPdfFormato");
  return destFmt(chave, modeloDocumento, formatoPdf);
}

/** Persiste XML/PDF do staging nativo para PATHS do agente e gera DANFC-e via NFE_ImprimirPDF. */
function persistNativeEmissaoOutputs(inst, runtime, chave, modelo, opts = {}) {
  const docs = require("../../documentosFiscais");
  const { ensureDirs } = require("../../marginPaths");
  ensureDirs();

  const k = String(chave || "").replace(/\D/g, "");
  let xmlPathCanon = null;
  let pdfPathCanon = null;

  if (opts.xmlJaSalvo && fs.existsSync(opts.xmlJaSalvo)) {
    xmlPathCanon = opts.xmlJaSalvo;
  }

  let xmlContent = null;
  const stagedXml = acbrLibRuntime.findStagedArtifact(runtime, k, ".xml");
  if (stagedXml && fs.existsSync(stagedXml)) {
    xmlContent = fs.readFileSync(stagedXml, "utf8");
  } else {
    try {
      xmlContent = inst.obterXml(0);
    } catch (_) {
      /* ignore */
    }
  }
  if (!xmlPathCanon && xmlContent && String(xmlContent).trim()) {
    xmlPathCanon = docs.salvarXmlAutorizado(k, xmlContent);
    fiscalTrace.trace("Persist", "XML autorizado salvo", { chave: k, path: xmlPathCanon });
  } else if (!xmlPathCanon) {
    fiscalTrace.warn("Persist", "XML vazio após emissão — SEFAZ pode não ter autorizado", {
      chave: k,
      stagedXml,
      notasDir: runtime.notas,
    });
  }

  const {
    applyMarcaDaguaAcbrLib,
    applyNfcePdfFormatoAcbrLib,
    applyDanfeLogoAcbrLib,
  } = require("../../fiscalPdfFormato");
  if (String(modelo || "65") === "55") {
    try {
      inst.configGravarValor("DANFE", "TipoDANFE", "1");
    } catch (_) {
      /* versões antigas da DLL */
    }
    applyMarcaDaguaAcbrLib(inst);
    acbrLibRuntime.applyDanfeLayoutConfig(inst, modelo);
  } else {
    applyNfcePdfFormatoAcbrLib(inst, "termico");
  }
  applyDanfeLogoAcbrLib(inst, runtime, {
    modelo,
    formatoPdf: String(modelo) === "55" ? "a4" : "termico",
  });
  const destPdf = destinoPdfCanonico(k, modelo);
  const dirsPdf = [PATHS.pdf, PATHS.saida, runtime.pdf, runtime.notas, runtime.root].filter(
    Boolean,
  );
  const snapPdf = docs.snapshotPdfs(dirsPdf);
  try {
    inst.imprimirPDF();
  } catch (pdfErr) {
    log.warn({ err: pdfErr.message, chave: k }, "[ACBrLib] imprimirPDF pós-envio — tentando salvarPDF");
    try {
      inst.salvarPDF();
    } catch (_) {
      /* ignore */
    }
  }

  const captured = docs.capturarPdfRecemGerado(k, modelo, "termico", destPdf, {
    snapshot: snapPdf,
    dirs: dirsPdf,
    somenteNovos: true,
  });
  if (captured) {
    pdfPathCanon = captured;
    fiscalTrace.trace("Persist", "PDF copiado para ProgramData", { chave: k, path: pdfPathCanon });
  } else {
    fiscalTrace.warn("Persist", "PDF não encontrado no staging (chave não bate)", {
      chave: k,
      destPdf,
      runtimePdf: runtime.pdf,
    });
  }

  if (!xmlPathCanon) {
    fiscalTrace.error("Persist", "Emissão sem XML em ProgramData", {
      chave: k,
      xmlDir: PATHS.xml,
      logsDir: PATHS.logs,
    });
    const err = new Error(
      `[ACBrLib] XML autorizado não persistido — chave ${k}. Verifique logs em ${PATHS.logs}`,
    );
    err.incerto = true;
    err.chaveConsulta = k;
    throw err;
  }

  return { xmlPath: xmlPathCanon, pdfPath: pdfPathCanon };
}

function resolveXmlPathForPdf(chave, xmlPath) {
  const docs = require("../../documentosFiscais");
  const k = String(chave || "").replace(/\D/g, "");

  if (xmlPath && fs.existsSync(xmlPath)) return xmlPath;

  const local = docs.localizarXmlPorChave(k);
  if (local?.path && fs.existsSync(local.path)) return local.path;

  const staged = acbrLibRuntime.findStagedArtifactAnywhere(k, ".xml");
  if (staged) return staged;

  return null;
}

function xmlListaContemChave(xml, chave) {
  const k = String(chave || "").replace(/\D/g, "");
  if (k.length !== 44) return false;
  const s = String(xml || "");
  return s.includes(k) || s.replace(/\D/g, "").includes(k);
}

function lerXmlListaNativa(inst) {
  try {
    return String(inst.obterXml(0) || "");
  } catch (_) {
    return "";
  }
}

/** A lista ACBr é compartilhada — imprimirPDF do índice 0 da nota anterior gerava o PDF repetido. */
function carregarXmlDaChaveNaLista(inst, xmlRel, chave) {
  const k = String(chave || "").replace(/\D/g, "");
  const tentar = () => {
    try {
      inst.limparLista();
    } catch (_) {}
    inst.carregarXML(xmlRel);
    return lerXmlListaNativa(inst);
  };
  let xml = tentar();
  if (xmlListaContemChave(xml, k)) return xml;
  xml = tentar();
  if (xml && !xmlListaContemChave(xml, k)) {
    const outra = xml.match(/Id="NFe(\d{44})"/i)?.[1] || xml.match(/\d{44}/)?.[0];
    throw new Error(
      `[ACBrLib] lista nativa tem outro XML (${outra || "chave ausente"}), não ${k} — recusando PDF`,
    );
  }
  return xml;
}

function descobrirPdfGerado(chave, modeloDocumento, destino, formatoPdf = "termico", opts = {}) {
  const docs = require("../../documentosFiscais");
  return docs.capturarPdfRecemGerado(chave, modeloDocumento, formatoPdf, destino, opts);
}

async function gerarPdfFiscalLib(chave, xmlPath, modeloDocumento = "65", opts = {}) {
  const mode = getIntegrationMode();
  const modelo = String(modeloDocumento || "65");
  const {
    normalizarFormatoPdfNfce,
    applyNfcePdfFormatoAcbrLib,
    applyMarcaDaguaAcbrLib,
    applyDanfeLogoAcbrLib,
  } = require("../../fiscalPdfFormato");
  const formatoPdf = normalizarFormatoPdfNfce(opts.formatoPdf, modelo);
  const destino = destinoPdfCanonico(chave, modelo, formatoPdf);
  const docs = require("../../documentosFiscais");

  if (opts.skipCache) {
    docs.aposentarPdfCanonico(destino);
  } else {
    const existente = docs.localizarPdfPorChave(chave, modelo, formatoPdf);
    if (existente && docs.pdfValidoParaChave(existente, chave, modelo, formatoPdf)) {
      if (path.resolve(existente) !== path.resolve(destino)) {
        fs.copyFileSync(existente, destino);
      }
      return destino;
    }
    if (fs.existsSync(destino) && docs.pdfValidoParaChave(destino, chave, modelo, formatoPdf)) {
      return destino;
    }
  }

  if (mode !== "native") {
    return acbr.gerarPdfFiscal(chave, xmlPath, modeloDocumento, opts);
  }

  const xmlAbs = resolveXmlPathForPdf(chave, xmlPath);
  if (!xmlAbs) {
    throw new Error(
      `[ACBrLib] XML não encontrado para PDF da chave ${chave}. Emita novamente ou verifique PathSalvar.`,
    );
  }
  try {
    const xmlDisk = fs.readFileSync(xmlAbs, "utf8");
    if (!xmlListaContemChave(xmlDisk, chave)) {
      throw new Error(`[ACBrLib] XML em disco não contém a chave ${chave}`);
    }
  } catch (err) {
    if (String(err.message || "").includes("não contém a chave")) throw err;
    throw new Error(`[ACBrLib] XML ilegível para PDF da chave ${chave}: ${err.message}`);
  }

  fs.mkdirSync(path.dirname(destino), { recursive: true });

  let snapPdf = null;
  let dirsPdf = [PATHS.pdf, PATHS.saida];
  await withNativeLib("imprimirPDF", (inst, runtime) => {
    dirsPdf = [...new Set([PATHS.pdf, PATHS.saida, runtime.pdf, runtime.notas, runtime.root].filter(Boolean))];
    snapPdf = docs.snapshotPdfs(dirsPdf);
    const xmlRel = acbrLibRuntime.resolveNativeLibRelativePath(xmlAbs, runtime);
    carregarXmlDaChaveNaLista(inst, xmlRel, chave);
    acbrLibRuntime.reloadNativeCertAfterCarregarIni(inst, runtime);
    if (modelo === "55") {
      try {
        inst.configGravarValor("DANFE", "TipoDANFE", "1");
      } catch (_) {
        /* versões antigas da DLL */
      }
      applyMarcaDaguaAcbrLib(inst);
      acbrLibRuntime.applyDanfeLayoutConfig(inst, modelo);
    } else {
      applyNfcePdfFormatoAcbrLib(inst, formatoPdf);
    }
    applyDanfeLogoAcbrLib(inst, runtime, { modelo, formatoPdf });
    try {
      inst.imprimirPDF();
    } catch (_) {
      inst.salvarPDF();
    }
    return true;
  });

  const achado = descobrirPdfGerado(chave, modelo, destino, formatoPdf, {
    snapshot: snapPdf,
    dirs: dirsPdf,
    somenteNovos: true,
  });
  if (achado) {
    log.info({ chave, pdfPath: destino, native: true, formatoPdf }, "[ACBrLib] PDF gerado (nativo)");
    return destino;
  }

  throw new Error(`[ACBrLib] NFE_ImprimirPDF não gerou arquivo para chave ${chave}. Verifique PathPDF no INI.`);
}

async function consultarChaveLib(chave) {
  if (getIntegrationMode() !== "native") {
    return acbr.consultarChave(chave);
  }
  const chaveNorm = String(chave || "").replace(/\D/g, "");
  const resposta = await withNativeLib("consultar", (inst) => inst.consultar(chaveNorm, true));
  const p0 = acbrLibResposta.parseRespostaLib(resposta);
  // Sync enrich — evita reentrada em consultarChave(Monitor) / recursão Lib.
  const p = acbr.enrichParsePosEmissao(p0, resposta);
  return {
    chave: chaveNorm,
    cStat: p.cStat,
    xMotivo: p.xMotivo,
    protocolo: p.protocolo,
    situacao: acbr.inferirSituacao(p.cStat, resposta),
    raw: resposta,
    native: true,
  };
}

/**
 * Consulta situação de NF-e modelo 55 (entrada) — força ModeloDF=moNFe.
 * Sem isso a sessão PDV (NFC-e) pode consultar no ambiente errado.
 */
async function consultarChaveNfeEntradaLib(chave) {
  if (getIntegrationMode() !== "native") {
    return acbr.consultarChave(chave);
  }
  const chaveNorm = String(chave || "").replace(/\D/g, "");
  const resposta = await withNativeLibModeloNfe("consultarNFeEntrada", (inst) =>
    inst.consultar(chaveNorm, true),
  );
  const p0 = acbrLibResposta.parseRespostaLib(resposta);
  const p = acbr.enrichParsePosEmissao(p0, resposta);
  return {
    chave: chaveNorm,
    cStat: p.cStat,
    xMotivo: p.xMotivo,
    protocolo: p.protocolo,
    situacao: acbr.inferirSituacao(p.cStat, resposta),
    raw: resposta,
    native: true,
  };
}

async function cancelarNfceLib(chaveNfeOuChave, motivo, cnpj) {
  if (getIntegrationMode() !== "native") {
    return acbr.cancelarNfce(chaveNfeOuChave, motivo, cnpj);
  }
  const chave = chaveNfeOuChave;
  const motivoTexto = (motivo || "Cancelamento solicitado pelo operador").slice(0, 255);
  const k = String(chave || "").replace(/\D/g, "");
  const cnpjEmit = String(cnpj || (k.length >= 20 ? k.substring(6, 20) : "") || "").replace(/\D/g, "");
  const resposta = await withNativeLib("cancelar", (inst) =>
    inst.cancelar(chave, motivoTexto, cnpjEmit, 1),
  );
  const p = acbr.parseResposta(resposta);
  return {
    ok: true,
    protocolo: p.protocolo,
    cStat: p.cStat,
    xml: require("../../documentosFiscais").extrairXmlDaResposta(resposta),
    raw: resposta,
    native: true,
  };
}

async function inutilizarNfceLib(params) {
  if (getIntegrationMode() !== "native") {
    return acbr.inutilizarNfce(params);
  }
  const {
    ano,
    cnpj,
    modelo = "65",
    serie,
    numeroInicial,
    numeroFinal,
    motivo,
  } = params;
  const motivoTexto = (motivo || "Inutilizacao solicitada").slice(0, 255);
  const cnpjLimpo = String(cnpj).replace(/\D/g, "");
  const resposta = await withNativeLib("inutilizar", (inst) =>
    inst.inutilizar(
      cnpjLimpo,
      motivoTexto,
      Number(ano),
      Number(modelo),
      Number(serie),
      Number(numeroInicial),
      Number(numeroFinal),
    ),
  );
  const p = acbr.parseResposta(resposta);
  const { isCStatInutilizacaoOk } = require("../../acbrResposta");
  const cStat = String(p.cStat || "");
  const ok = isCStatInutilizacaoOk(cStat);
  if (!ok) {
    const msg = p.xMotivo || p.mensagem || resposta;
    throw new Error(
      `SEFAZ rejeitou inutilização (cStat ${cStat || "?"}): ${String(msg).slice(0, 280)}`,
    );
  }
  return {
    ok: true,
    protocolo: p.protocolo,
    cStat,
    xMotivo: p.xMotivo,
    xml: require("../../documentosFiscais").extrairXmlDaResposta(resposta),
    raw: resposta,
    native: true,
  };
}

async function enviarEventoFiscalLib(payload) {
  if (getIntegrationMode() !== "native") {
    return acbr.enviarEventoFiscal(payload);
  }
  const documentIni = payload?.documentIni;
  if (!documentIni || !String(documentIni).trim()) {
    throw new Error("documentIni obrigatório para evento fiscal");
  }
  const chave = payload?.chave || payload?.chaveNfe || null;
  const iniPath = path.join(
    PATHS.ini,
    `evento-lib-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ini`,
  );
  fs.writeFileSync(iniPath, String(documentIni), "utf8");
  const resposta = await withNativeLib("enviarEvento", (inst, runtime) => {
    const nativeIniPath = acbrLibRuntime.resolveNativeDocumentIniPath(iniPath, runtime);
    if (typeof inst.limparListaEventos === "function") {
      inst.limparListaEventos();
    } else {
      inst.limparLista();
    }
    if (typeof inst.carregarEventoINI === "function") {
      inst.carregarEventoINI(nativeIniPath);
    } else {
      inst.carregarINI(nativeIniPath);
    }
    inst.assinar();
    return inst.enviarEvento(1);
  });
  const p = acbrLibResposta.parseRespostaLib(resposta);
  const cStat = String(p.cStat || "");
  const { isCStatAutorizado } = require("../../acbrResposta");
  const ok = isCStatAutorizado(cStat) || acbr.isCStatEventoOk(cStat);
  return {
    ok,
    cStat: p.cStat,
    protocolo: p.protocolo,
    chave: p.chave || chave,
    xMotivo: p.xMotivo,
    raw: resposta,
    native: true,
    tipoEvento: payload?.tipoEvento || payload?.tipo || null,
  };
}

function toUfAutorNumber(ufHint, chaveFallback) {
  const cod = acbr.resolverUfIbgeDestinatario(ufHint, chaveFallback);
  const n = Number(String(cod || "").replace(/\D/g, ""));
  if (!Number.isFinite(n) || n < 11 || n > 99) {
    throw new Error(`UF do destinatário inválida para DistDFe ACBrLib: ${ufHint || cod || "?"}`);
  }
  return n;
}

/**
 * DistDFe / manifesto usam Ambiente Nacional NF-e ([NFe_AN_H] / [NFe_AN_P]), não NFC-e.
 * ACBrLib enum ModeloDF: 0=moNFe · 1=moNFCe — o runtime PDV fica em NFC-e por padrão.
 */
function aplicarModeloDfNfeParaDistDfe(inst) {
  const sets = [
    ["NFe", "ModeloDF", "0"], // enum moNFe → sessão NFe_AN_*
    ["ACBrNFe", "ModeloDF", "55"],
  ];
  for (const [sec, key, val] of sets) {
    try {
      inst.configGravarValor(sec, key, val);
    } catch (_) {
      /* versão sem seção */
    }
  }
}

function restaurarModeloDfNfce(inst) {
  const sets = [
    ["NFe", "ModeloDF", "1"], // enum moNFCe — padrão PDV
    ["ACBrNFe", "ModeloDF", "65"],
  ];
  for (const [sec, key, val] of sets) {
    try {
      inst.configGravarValor(sec, key, val);
    } catch (_) {
      /* ignore */
    }
  }
}

async function withNativeLibModeloNfe(opName, fn) {
  return withNativeLib(opName, async (inst, runtime) => {
    aplicarModeloDfNfeParaDistDfe(inst);
    try {
      return await fn(inst, runtime);
    } finally {
      restaurarModeloDfNfce(inst);
    }
  });
}

async function distribuicaoDFePorUltNsuLib(ultNsu, cnpjDestinatario, uf) {
  if (getIntegrationMode() !== "native") {
    return acbr.distribuicaoDFePorUltNsu(ultNsu, cnpjDestinatario, uf);
  }
  const cnpj = String(cnpjDestinatario || "").replace(/\D/g, "");
  if (cnpj.length !== 14) {
    throw new Error("CNPJ do destinatário obrigatório para Distribuição DFe (14 dígitos).");
  }
  const nsu = String(ultNsu || "0").replace(/\D/g, "").padStart(15, "0");
  const ufAutor = toUfAutorNumber(uf, null);
  const resposta = await withNativeLibModeloNfe("distribuicaoDFePorUltNSU", (inst) =>
    inst.distribuicaoDFePorUltNSU(ufAutor, cnpj, nsu),
  );
  const parsed = acbr.parseDistribuicaoDFeUltNsuResposta(resposta, nsu);
  return { ...parsed, native: true };
}

async function distribuicaoDFePorChaveLib(chave, cnpjDestinatario, ufAutor) {
  if (getIntegrationMode() !== "native") {
    return acbr.distribuicaoDFePorChave(chave, cnpjDestinatario, ufAutor);
  }
  const chaveNorm = String(chave || "").replace(/\D/g, "");
  if (chaveNorm.length !== 44) {
    throw new Error("Chave NF-e deve ter 44 dígitos.");
  }
  const cnpj = String(cnpjDestinatario || "").replace(/\D/g, "");
  if (cnpj.length !== 14) {
    throw new Error("CNPJ do destinatário obrigatório para Distribuição DFe (14 dígitos).");
  }
  const ufNum = toUfAutorNumber(ufAutor, chaveNorm);
  const resposta = await withNativeLibModeloNfe("distribuicaoDFePorChave", (inst) =>
    inst.distribuicaoDFePorChave(ufNum, cnpj, chaveNorm),
  );
  const parsed = acbr.parseDistribuicaoDFePorChaveResposta(resposta, chaveNorm);
  return { ...parsed, native: true };
}

async function manifestarEventoDestinatarioLib(chave, cnpjDestinatario, tpEvento, xJust) {
  if (getIntegrationMode() !== "native") {
    return acbr.manifestarEventoDestinatario(chave, cnpjDestinatario, tpEvento, xJust);
  }
  const cnpj = String(cnpjDestinatario || "").replace(/\D/g, "");
  if (cnpj.length !== 14) {
    throw new Error("CNPJ do destinatário obrigatório para manifestação (14 dígitos).");
  }
  const chaveNorm = String(chave || "").replace(/\D/g, "");
  const tp = String(tpEvento || "210210").trim();
  const documentIni = acbr.montarIniManifestacaoEvento(chaveNorm, cnpj, tp, xJust);
  const iniPath = path.join(
    PATHS.ini,
    `manifesto-lib-${tp}-${Date.now()}-${chaveNorm.slice(-8)}.ini`,
  );
  fs.writeFileSync(iniPath, documentIni, "utf8");
  const resposta = await withNativeLibModeloNfe("manifestarEventoDestinatario", (inst, runtime) => {
    const nativeIniPath = acbrLibRuntime.resolveNativeDocumentIniPath(iniPath, runtime);
    if (typeof inst.limparListaEventos === "function") {
      inst.limparListaEventos();
    } else {
      inst.limparLista();
    }
    if (typeof inst.carregarEventoINI !== "function") {
      throw new Error("ACBrLib sem NFE_CarregarEventoINI — atualize a biblioteca nativa.");
    }
    inst.carregarEventoINI(nativeIniPath);
    inst.assinar();
    return inst.enviarEvento(1);
  });
  const p = acbrLibResposta.parseRespostaLib(resposta);
  const cStat = String(p.cStat || "");
  const { isCStatAutorizado, CSTAT_LOTE_OK } = require("../../acbrResposta");
  const ok = acbr.isCStatManifestacaoOk(cStat, resposta);
  if (!ok && !isCStatAutorizado(cStat) && !CSTAT_LOTE_OK.has(cStat)) {
    const motivo = p.xMotivo || `SEFAZ rejeitou manifesto cStat ${cStat || "?"}`;
    const err = new Error(motivo);
    err.cStat = p.cStat;
    throw err;
  }
  return {
    ok: true,
    cStat: p.cStat,
    protocolo: p.protocolo,
    chave: p.chave || chaveNorm,
    xMotivo: p.xMotivo,
    raw: resposta,
    tipoEvento: tp,
    modeloDocumento: "55",
    native: true,
  };
}

async function manifestarCienciaOperacaoLib(chave, cnpjDestinatario) {
  return manifestarEventoDestinatarioLib(chave, cnpjDestinatario, "210210", null);
}

async function consultarChaveEntradaLib(chave, cnpjDestinatario, ufAutor) {
  return acbr.consultarChaveEntrada(chave, cnpjDestinatario, ufAutor, {
    consultarChave: consultarChaveNfeEntradaLib,
    distribuicaoDFePorChave: distribuicaoDFePorChaveLib,
    manifestarCienciaOperacao: manifestarCienciaOperacaoLib,
  });
}

/** Invalida sessão nativa — próxima operação reinicializa a biblioteca. */
async function refreshLibRuntimeConfig() {
  return acbr.withAcbrLock(async () => {
    invalidateStatusServicoCache();
    await acbrLibSession.invalidateNativeSession("config_refresh");
    acbrLibSession.clearSoftDead();
    acbrLibSession.invalidateRuntimeCache();
    return { refreshed: getIntegrationMode() === "native", mode: getIntegrationMode() };
  }, "config_refresh");
}

async function invalidateNativeSession(reason) {
  return acbr.withAcbrLock(async () => {
    await acbrLibSession.invalidateNativeSession(reason || "external");
    // Reset operador / shutdown: libera soft-dead DEPOIS do destroy.
    if (
      reason === "config_refresh" ||
      reason === "operator_reset" ||
      reason === "shutdown" ||
      reason === "watchdog_restart"
    ) {
      acbrLibSession.clearSoftDead();
    }
    acbrLibSession.invalidateRuntimeCache();
  }, reason || "invalidate");
}

const exportedDriver = wrapAcbrExports({
  getDriverInfo,
  getIntegrationMode,
  DRIVER_INFO,
  patchNumeracaoIniLib,
  parseResposta: (resposta) => acbrLibResposta.parseRespostaLib(resposta),
  emitirNfce: executarNativo("emitirNfce", emitirNfceLib, resolveEmissaoTimeoutMs()),
  emitirNfe: executarNativo("emitirNfe", emitirNfeLib, resolveEmissaoTimeoutMs()),
  emitirNfse: executarNativo("emitirNfse", emitirNfseLib, resolveEmissaoTimeoutMs()),
  isNfseHabilitado: () => acbr.isNfseHabilitado(),
  emitirViaNativeLib: executarNativo("emitirViaNativeLib", emitirViaNativeLib, resolveEmissaoTimeoutMs()),
  sincronizarNfceOffline: executarNativo(
    "sincronizarNfceOffline",
    sincronizarNfceOfflineLib,
    resolveEmissaoTimeoutMs(),
  ),
  statusServico: executarNativo("statusServico", statusServicoLib, 30_000),
  testar: executarNativo("testar", testarLib, 30_000),
  testarLibDetalhe: executarNativo("testarLibDetalhe", testarLibDetalhe, 30_000),
  consultarChave: executarNativo("consultarChave", consultarChaveLib, 60_000),
  consultarChaveEntrada: executarNativo("consultarChaveEntrada", consultarChaveEntradaLib, 60_000),
  cancelarNfce: executarNativo("cancelarNfce", cancelarNfceLib, resolveEmissaoTimeoutMs()),
  inutilizarNfce: executarNativo("inutilizarNfce", inutilizarNfceLib, resolveEmissaoTimeoutMs()),
  enviarEventoFiscal: executarNativo("enviarEventoFiscal", enviarEventoFiscalLib, resolveEmissaoTimeoutMs()),
  distribuicaoDFePorUltNsu: executarNativo("distribuicaoDFePorUltNsu", distribuicaoDFePorUltNsuLib, 60_000),
  distribuicaoDFePorChave: executarNativo("distribuicaoDFePorChave", distribuicaoDFePorChaveLib, 60_000),
  manifestarCienciaOperacao: executarNativo("manifestarCienciaOperacao", manifestarCienciaOperacaoLib, 60_000),
  manifestarEventoDestinatario: executarNativo("manifestarEventoDestinatario", manifestarEventoDestinatarioLib, 60_000),
  refreshLibRuntimeConfig: executarNativo("refreshLibRuntimeConfig", refreshLibRuntimeConfig, 30_000),
  invalidateNativeSession: executarNativo("invalidateNativeSession", invalidateNativeSession, 30_000),
  getLastTestarErro,
  getLibSessionStatus: () => {
    const session = acbrLibSession.getSessionStatus();
    let logNivel = null;
    try {
      logNivel = acbrLibRuntime.resolveAcbrLogNivel();
    } catch (_) {}
    return {
      ...session,
      logNivel,
      logNativoAtivo: String(logNivel || "0") !== "0",
      lastTestarErro,
      worker: usarWorkerFiscal()
        ? require("../acbrLibWorkerPool").status()
        : { enabled: false, online: false },
    };
  },
  gerarPdfFiscal: executarNativo("gerarPdfFiscal", gerarPdfFiscalLib, resolveEmissaoTimeoutMs()),
  gerarPdfDanfce: executarNativo(
    "gerarPdfDanfce",
    (chave, xmlPath, opts) => gerarPdfFiscalLib(chave, xmlPath, "65", opts),
    resolveEmissaoTimeoutMs(),
  ),
  gerarPdfDanfe: executarNativo(
    "gerarPdfDanfe",
    (chave, xmlPath, opts) => gerarPdfFiscalLib(chave, xmlPath, "55", opts),
    resolveEmissaoTimeoutMs(),
  ),
  warnIfSelectedAtBoot,
  // exportados para teste / diagnóstico DistDFe
  aplicarModeloDfNfeParaDistDfe,
  restaurarModeloDfNfce,
});

// A emissão fiscal pode mudar em runtime pelo configSync. O filho recebe um
// snapshot de env/estado no fork; descartá-lo é a forma segura de não manter
// certificado, INI ou toggle de emissão obsoleto.
const setRuntimeEmissaoOriginal = exportedDriver.setRuntimeEmissaoFiscal;
exportedDriver.setRuntimeEmissaoFiscal = (valor) => {
  const anterior = exportedDriver.getRuntimeEmissaoFiscal?.();
  setRuntimeEmissaoOriginal(valor);
  // configSync reaplica o mesmo valor periodicamente. Reciclar o filho nesse
  // caso interrompe StatusServico/emissão sem atualizar qualquer configuração.
  if (usarWorkerFiscal() && anterior !== Boolean(valor)) {
    void require("../acbrLibWorkerPool").terminate("runtime_config_changed");
  }
};

// refresh roda no worker via IPC; o pai descarta o filho para novo PFX/senha.
const refreshLibRuntimeOriginal = exportedDriver.refreshLibRuntimeConfig;
exportedDriver.refreshLibRuntimeConfig = async (...args) => {
  const result = await refreshLibRuntimeOriginal(...args);
  if (usarWorkerFiscal()) {
    try {
      await require("../acbrLibWorkerPool").terminate("cert_or_config_refresh");
      log.info(
        { metric: "acbrlib.cert_session_refresh" },
        "[ACBrLib] Certificado atualizado — sessão nativa reiniciada (worker)",
      );
    } catch (_) {}
  }
  return result;
};

module.exports = exportedDriver;

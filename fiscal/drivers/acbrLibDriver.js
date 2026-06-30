/**
 * Driver fiscal via ACBrLib nativa (FFI/koffi) — Onda B.5.
 *
 * Integração real: @projetoacbr/acbrlib-nfe-node → ACBrLibNFeMT → libacbrnfe64.so / ACBrNFe64.dll
 *
 * Modos:
 * - native  — ACBR_LIB_PATH aponta para .so/.dll existente (provider OFICIAL 1.0)
 * - parity  — ACBR_LIB_ALLOW_PARITY=true SEM DLL; fallback Monitor TCP (dev/CI only)
 * - unconfigured — sem DLL e sem ALLOW_PARITY; emitir falha com erro explícito
 *
 * SEFAZ: Ambiente=2 homolog (testes) · Ambiente=1 produção — definido em acbrlib.ini
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
const { validarPayloadNfe } = require("../../fiscalValidacaoNfe");

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

function isNativeLibConfigured() {
  return getIntegrationMode() === "native";
}

function getDriverInfo() {
  const mode = getIntegrationMode();
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

async function emitirNfceLib(payload) {
  if (payload?.xml || payload?.xmlEpec || payload?.modoEpec) {
    return emitirEpecLib(payload);
  }
  return emitirDocumentoLib(payload, "65");
}

async function emitirNfeLib(payload) {
  if (!acbr.isNfeModelo55Habilitado()) return { fiscal: false };
  return emitirDocumentoLib(payload, "55");
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
    return patchNumeracaoIniLib(payload.documentIni, numeracao);
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
  const empresa = await acbr.enriquecerEmpresa(payload.empresa || {});
  acbr.validarEmpresaFiscal(empresa);

  const serie =
    modeloDf === "55"
      ? payload.serieNfe || fiscalNumeracao.SERIE_NFE_55
      : payload.serieNfe || fiscalNumeracao.SERIE_PADRAO;

  let numeracao = resolverNumeracaoLib(payload, serie, modeloDf);
  const prefix = modeloDf === "55" ? "nfe-lib" : "nfce-lib";

  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const ini = await montarIniLib(payload, numeracao, modeloDf, empresa);
    const iniPath = path.join(
      PATHS.ini,
      `${prefix}-${payload.numeroVenda || Date.now()}-${numeracao.numero}.ini`,
    );
    fs.mkdirSync(path.dirname(iniPath), { recursive: true });
    fs.writeFileSync(iniPath, ini, "utf8");

    try {
      if (mode === "native") {
        return await emitirViaNativeLib(iniPath, modeloDf, numeracao);
      }
      return await emitirViaParidade(iniPath, Number(modeloDf), numeracao);
    } catch (err) {
      if (
        String(err.cStat) === "539" &&
        tentativa === 0 &&
        !payload.numeroNfe &&
        !payload._fiscalMeta?.numeroNfe
      ) {
        numeracao = { ...fiscalNumeracao.reservarProximoNumero(serie, modeloDf), cNf: CNF_PARIDADE };
        continue;
      }
      throw err;
    }
  }
  throw new Error("[ACBrLib] Falha na emissão após retentativas");
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
  const LibClass = loadAcbrLibNFeMT();
  const libPath = resolveLibPath();
  const iniConfig = resolveLibIniPath();

  if (!libPath) {
    throw new Error("[ACBrLib] ACBR_LIB_PATH não configurado ou arquivo inexistente");
  }
  if (!iniConfig) {
    throw new Error(
      "[ACBrLib] ACBR_LIB_INI não configurado. Copie templates/acbrlib.ini.template para data/acbrlib.ini",
    );
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
      notas: PATHS.ini,
      log: PATHS.logs,
      pdf: PATHS.pdf,
    },
    forceStaging: process.platform === "win32",
  });

  const nativeIniPath = acbrLibRuntime.resolveNativeDocumentIniPath(iniPath, runtime);

  return acbr.withAcbrLock(async () => {
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
      "[ACBrLib] Emissão NATIVA — NFE_Inicializar",
    );

    return acbrLibRuntime.withNativeLibSession(runtime, async ({ libPath: libInst, iniConfig: iniInst }) => {
      const inst = new LibClass(libInst, iniInst, libCryptKey());
      try {
        inst.inicializar();
        log.info("[ACBrLib] NFE_Inicializar OK");

        acbrLibRuntime.applyNativeRuntimeConfig(inst, runtime);

        try {
          inst.limparLista();
        } catch (_) {
          /* ignore */
        }

        inst.carregarINI(nativeIniPath);
        log.info({ iniPath: nativeIniPath }, "[ACBrLib] NFE_CarregarINI OK");

        acbrLibRuntime.reloadNativeCertAfterCarregarIni(inst, runtime);

        inst.assinar();
        log.info("[ACBrLib] NFE_Assinar OK");

        inst.validar();
        log.info("[ACBrLib] NFE_Validar OK");

        const resposta = inst.enviar(1, false, true, false);
        log.info(
          { respostaLen: String(resposta || "").length, preview: String(resposta || "").slice(0, 300) },
          "[ACBrLib] NFE_Enviar retorno",
        );

        const p0 = acbrLibResposta.parseRespostaLib(resposta);
        let p = await acbr.enrichParsePosEmissaoAsync(p0, resposta);
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
        log.error({ err: err.message, ultimoRetorno: ultimo }, "[ACBrLib] Falha na emissão nativa");
        throw err;
      } finally {
        try {
          inst.finalizar();
          log.info("[ACBrLib] NFE_Finalizar OK");
        } catch (_) {
          /* ignore */
        }
      }
    });
  }, "acbr-lib-native");
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
    return;
  }
  if (info.mode === "parity") {
    log.warn(
      "[ACBrLib] Modo PARIDADE ativo (ACBR_LIB_ALLOW_PARITY) — emissão via Monitor TCP, não é biblioteca nativa",
    );
    return;
  }
  log.error(
    "[ACBrLib] Driver Lib selecionado mas biblioteca nativa não encontrada — emissões falharão até configurar ACBR_LIB_PATH",
  );
}

function buildNativeRuntime() {
  const libPath = resolveLibPath();
  const iniConfig = resolveLibIniPath();
  if (!libPath || !iniConfig) {
    throw new Error("[ACBrLib] Biblioteca ou INI não configurados");
  }
  const iniVals = acbrLibRuntime.readIniValues(iniConfig);
  return acbrLibRuntime.prepareNativeRuntime({
    libPath,
    iniConfigPath: iniConfig,
    assets: {
      lib: path.dirname(libPath),
      schemas: iniVals.pathSchemas || path.join(AGENT_ROOT, "schemas", "NFe"),
      cert: iniVals.certFile,
      servicos: iniVals.servicos || path.join(AGENT_ROOT, "data", "ACBrNFeServicos.ini"),
      notas: PATHS.ini,
      log: PATHS.logs,
      pdf: PATHS.pdf,
    },
    forceStaging: process.platform === "win32",
  });
}

async function withNativeLib(opName, fn) {
  const runtime = buildNativeRuntime();
  const LibClass = loadAcbrLibNFeMT();
  return acbr.withAcbrLock(async () => {
    log.info({ opName }, "[ACBrLib] operação nativa");
    return acbrLibRuntime.withNativeLibSession(runtime, async ({ libPath, iniConfig }) => {
      const inst = new LibClass(libPath, iniConfig, libCryptKey());
      try {
        inst.inicializar();
        acbrLibRuntime.applyNativeRuntimeConfig(inst, runtime);
        acbrLibRuntime.applyNativeCertConfig(inst, runtime);
        return await fn(inst, runtime);
      } catch (err) {
        let ultimo = "";
        try {
          ultimo = typeof inst.ultimoRetorno === "function" ? inst.ultimoRetorno() : "";
        } catch (_) {
          /* ignore */
        }
        if (ultimo) {
          const e = new Error(`${err.message} | ultimoRetorno: ${ultimo}`);
          e.cause = err;
          throw e;
        }
        throw err;
      } finally {
        try {
          inst.finalizar();
        } catch (_) {
          /* ignore */
        }
      }
    });
  }, `acbr-lib-${opName}`);
}

async function statusServicoLib() {
  if (getIntegrationMode() !== "native") {
    return acbr.statusServico();
  }
  const resposta = await withNativeLib("statusServico", (inst) => inst.statusServico());
  const p = acbrLibResposta.parseRespostaLib(resposta);
  const operacional =
    p.cStat === "107" ||
    p.cStat === "108" ||
    String(resposta || "").toUpperCase().includes("SERVICO EM OPERACAO");
  return {
    operacional,
    cStat: p.cStat,
    xMotivo: p.xMotivo,
    tpAmb: p.tpAmb,
    raw: resposta,
    native: true,
  };
}

async function testarLib() {
  if (getIntegrationMode() !== "native") {
    return acbr.testar();
  }
  try {
    const st = await statusServicoLib();
    const ok = st.operacional !== false;
    acbr.atualizarStatusMemoria(ok);
    return ok;
  } catch (err) {
    log.warn({ err: err.message }, "[ACBrLib] testar() falhou");
    acbr.atualizarStatusMemoria(false);
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

function destinoPdfCanonico(chave, modeloDocumento) {
  const modelo = String(modeloDocumento || "65");
  const suffix = modelo === "55" ? "danfe" : "danfce";
  return path.join(PATHS.pdf, `${chave}-${suffix}.pdf`);
}

/** Persiste XML/PDF do staging nativo para PATHS do agente e gera DANFC-e via NFE_ImprimirPDF. */
function persistNativeEmissaoOutputs(inst, runtime, chave, modelo) {
  const docs = require("../../documentosFiscais");
  const { ensureDirs } = require("../../marginPaths");
  ensureDirs();

  const k = String(chave || "").replace(/\D/g, "");
  let xmlPathCanon = null;
  let pdfPathCanon = null;

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
  if (xmlContent && String(xmlContent).trim()) {
    xmlPathCanon = docs.salvarXmlAutorizado(k, xmlContent);
  }

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

  const destPdf = destinoPdfCanonico(k, modelo);
  let stagedPdf = acbrLibRuntime.findStagedArtifact(runtime, k, ".pdf");
  if (!stagedPdf && fs.existsSync(runtime.pdf)) {
    const recent = fs
      .readdirSync(runtime.pdf)
      .filter((f) => f.toLowerCase().endsWith(".pdf"))
      .map((f) => ({ f, m: fs.statSync(path.join(runtime.pdf, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0];
    if (recent) stagedPdf = path.join(runtime.pdf, recent.f);
  }
  if (stagedPdf && fs.existsSync(stagedPdf)) {
    fs.mkdirSync(path.dirname(destPdf), { recursive: true });
    fs.copyFileSync(stagedPdf, destPdf);
    pdfPathCanon = destPdf;
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

function descobrirPdfGerado(chave, modeloDocumento, destino) {
  const docs = require("../../documentosFiscais");
  const achado = docs.localizarPdfPorChave(chave, modeloDocumento);
  if (achado && docs.isPdfValid(achado)) {
    if (path.resolve(achado) !== path.resolve(destino)) {
      fs.copyFileSync(achado, destino);
    }
    return destino;
  }
  for (const dir of [PATHS.saida, PATHS.pdf, PATHS.xml]) {
    if (!dir || !fs.existsSync(dir)) continue;
    const match = fs
      .readdirSync(dir)
      .find((f) => f.includes(String(chave)) && f.toLowerCase().endsWith(".pdf"));
    if (match) {
      fs.copyFileSync(path.join(dir, match), destino);
      return destino;
    }
  }
  return null;
}

async function gerarPdfFiscalLib(chave, xmlPath, modeloDocumento = "65") {
  const mode = getIntegrationMode();
  const modelo = String(modeloDocumento || "65");
  const destino = destinoPdfCanonico(chave, modelo);
  const docs = require("../../documentosFiscais");

  const existente = docs.localizarPdfPorChave(chave, modelo);
  if (existente && docs.isPdfValid(existente)) {
    if (path.resolve(existente) !== path.resolve(destino)) {
      fs.copyFileSync(existente, destino);
    }
    return destino;
  }
  if (fs.existsSync(destino) && docs.isPdfValid(destino)) {
    return destino;
  }

  const stagedPdf = acbrLibRuntime.findStagedArtifactAnywhere(chave, ".pdf");
  if (stagedPdf && docs.isPdfValid(stagedPdf)) {
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.copyFileSync(stagedPdf, destino);
    return destino;
  }

  if (mode !== "native") {
    return acbr.gerarPdfFiscal(chave, xmlPath, modeloDocumento);
  }

  const xmlAbs = resolveXmlPathForPdf(chave, xmlPath);
  if (!xmlAbs) {
    throw new Error(
      `[ACBrLib] XML não encontrado para PDF da chave ${chave}. Emita novamente ou verifique PathSalvar.`,
    );
  }

  fs.mkdirSync(path.dirname(destino), { recursive: true });

  const runtime = buildNativeRuntime();
  await withNativeLib("imprimirPDF", (inst) => {
    const xmlRel = acbrLibRuntime.resolveNativeLibRelativePath(xmlAbs, runtime);
    inst.limparLista();
    inst.carregarXML(xmlRel);
    acbrLibRuntime.reloadNativeCertAfterCarregarIni(inst, runtime);
    const tipoDanfe = modelo === "55" ? "1" : "4";
    try {
      inst.configGravarValor("DANFE", "TipoDANFE", tipoDanfe);
    } catch (_) {
      /* versões antigas da DLL */
    }
    try {
      inst.imprimirPDF();
    } catch (_) {
      inst.salvarPDF();
    }
    return true;
  });

  const achado =
    descobrirPdfGerado(chave, modelo, destino) ||
    acbrLibRuntime.findStagedArtifactAnywhere(chave, ".pdf");
  if (achado && docs.isPdfValid(achado)) {
    if (path.resolve(achado) !== path.resolve(destino)) {
      fs.copyFileSync(achado, destino);
    }
    log.info({ chave, pdfPath: destino, native: true }, "[ACBrLib] PDF gerado (nativo)");
    return destino;
  }

  throw new Error(`[ACBrLib] NFE_ImprimirPDF não gerou arquivo para chave ${chave}. Verifique PathPDF no INI.`);
}

async function consultarChaveLib(chave) {
  if (getIntegrationMode() !== "native") {
    return acbr.consultarChave(chave);
  }
  const resposta = await withNativeLib("consultar", (inst) => inst.consultar(chave, true));
  const p = acbr.parseResposta(resposta);
  return {
    chave,
    cStat: p.cStat,
    xMotivo: p.xMotivo,
    protocolo: p.protocolo,
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
  return {
    ok: true,
    protocolo: p.protocolo,
    cStat: p.cStat,
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
  const runtime = buildNativeRuntime();
  const nativeIniPath = acbrLibRuntime.resolveNativeDocumentIniPath(iniPath, runtime);
  const resposta = await withNativeLib("enviarEvento", (inst) => {
    inst.limparLista();
    inst.carregarINI(nativeIniPath);
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

/** Próxima sessão nativa relê acbrlib.ini — invalida cache de staging se existir. */
function refreshLibRuntimeConfig() {
  return { refreshed: getIntegrationMode() === "native", mode: getIntegrationMode() };
}

module.exports = Object.assign({}, acbr, {
  getDriverInfo,
  getIntegrationMode,
  DRIVER_INFO,
  patchNumeracaoIniLib,
  parseResposta: (resposta) => acbrLibResposta.parseRespostaLib(resposta),
  emitirNfce: emitirNfceLib,
  emitirNfe: emitirNfeLib,
  emitirViaNativeLib,
  statusServico: statusServicoLib,
  testar: testarLib,
  testarLibDetalhe,
  consultarChave: consultarChaveLib,
  cancelarNfce: cancelarNfceLib,
  inutilizarNfce: inutilizarNfceLib,
  enviarEventoFiscal: enviarEventoFiscalLib,
  refreshLibRuntimeConfig,
  gerarPdfFiscal: gerarPdfFiscalLib,
  gerarPdfDanfce: (chave, xmlPath) => gerarPdfFiscalLib(chave, xmlPath, "65"),
  gerarPdfDanfe: (chave, xmlPath) => gerarPdfFiscalLib(chave, xmlPath, "55"),
  warnIfSelectedAtBoot,
});

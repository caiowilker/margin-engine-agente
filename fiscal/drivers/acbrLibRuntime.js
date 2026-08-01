/**
 * Runtime ACBrLib nativo — staging Windows (WSL), chdir e config pós-init.
 * Compartilhado pelo acbrLibDriver.js e scripts de homologação.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { resolveTempRoot, resolveStagingDir } = require("../../runtime/windowsEnv");
const fiscalSecrets = require("../../fiscalSecrets");
const certProof = require("../certProof");
const acbrLibCrypt = require("../acbrLibCrypt");

let lastCertProof = null;

function resolveAcbrLogNivel() {
  // Default 4 = paridade com a última emissão OK (19/07). Sem isso o log nativo
  // fica mudo e StatusServico CStat=0 vira "falha operacional" sem causa.
  const raw = String(process.env.ACBR_LIB_LOG_NIVEL ?? "4").trim();
  return raw === "" ? "4" : raw;
}

/**
 * Prova do PFX a partir do disco (pai HTTP ou diagnóstico) — sem depender do worker.
 * Metadados (thumbprint/NotAfter) só via OpenSSL/PowerShell quando o hash muda
 * ou quando opts.forceMeta=true — evita custo a cada poll de /status.
 */
function probeCertProofFromDisk(opts = {}) {
  const { resolveProgramDataRoot, resolveStagingDir } = require("../../runtime/windowsEnv");
  let sourcePath =
    opts.sourcePath ||
    process.env.CERT_A1_PATH ||
    process.env.ACBR_CERT_PATH ||
    null;
  if (sourcePath) sourcePath = String(sourcePath).replace(/\\\\/g, "\\").trim();
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    try {
      const root = resolveProgramDataRoot().root;
      const candidate = path.join(root, "cert", "cert.pfx");
      if (fs.existsSync(candidate)) sourcePath = candidate;
    } catch (_) {}
  }
  const stagedPath = path.join(resolveStagingDir("margin-acbrlib"), "cert", "cert.pfx");
  const stagedExists = fs.existsSync(stagedPath);
  const sourceExists = sourcePath && fs.existsSync(sourcePath);
  const sourceSha256 = sourceExists ? certProof.sha256File(sourcePath) : null;
  const stagedSha256 = stagedExists ? certProof.sha256File(stagedPath) : null;
  const hashKey = `${sourceSha256 || ""}|${stagedSha256 || ""}`;
  const prevKey = lastCertProof
    ? `${lastCertProof.sourceSha256 || ""}|${lastCertProof.stagedSha256 || ""}`
    : null;
  const hashChanged = hashKey !== prevKey;

  let password = opts.password || "";
  if (!password) {
    try {
      password = fiscalSecrets.lerSync()?.certificadoSenha || "";
    } catch (_) {}
  }
  if (!password) {
    password = process.env.ACBR_CERT_SENHA || process.env.CERT_A1_PASS || "";
  }
  password = certProof.normalizeCertPassword(password);

  const needMeta =
    opts.forceMeta === true ||
    hashChanged ||
    !lastCertProof ||
    (password && !lastCertProof.thumbprint && !lastCertProof.notAfter);

  if (!needMeta && lastCertProof) {
    return {
      ...lastCertProof,
      sourcePath: sourceExists ? sourcePath : null,
      stagedPath: stagedExists ? stagedPath : null,
      sourceSha256,
      stagedSha256,
      hashMatch:
        sourceSha256 && stagedSha256
          ? sourceSha256 === stagedSha256
          : sourceSha256 == null && stagedSha256 == null,
      senhaPresente: !!password,
    };
  }

  const proof = certProof.buildCertProof({
    sourcePath: sourceExists ? sourcePath : null,
    stagedPath: stagedExists ? stagedPath : null,
    password: needMeta ? password : "",
    synced: false,
  });
  // Se pulamos meta por senha vazia no build, preservar meta anterior do mesmo hash.
  if (!needMeta && lastCertProof?.thumbprint) {
    proof.thumbprint = lastCertProof.thumbprint;
    proof.notBefore = lastCertProof.notBefore;
    proof.notAfter = lastCertProof.notAfter;
    proof.expired = lastCertProof.expired;
    proof.subject = lastCertProof.subject;
    proof.metaSource = lastCertProof.metaSource;
  }
  lastCertProof = proof;
  return proof;
}

function getLastCertProof(opts = {}) {
  if (opts.refresh || opts.forceMeta || !lastCertProof) {
    try {
      return probeCertProofFromDisk(opts);
    } catch (_) {
      return lastCertProof;
    }
  }
  return lastCertProof;
}

function isUncPath(p) {
  return /wsl\.localhost|wsl\$|^\\\\/i.test(String(p || ""));
}

function readIniValues(iniPath) {
  if (!iniPath || !fs.existsSync(iniPath)) {
    return {
      senha: "",
      idCsc: "000001",
      csc: "",
      uf: "MG",
      ambiente: "2",
      ambienteSefaz: "homologacao",
      ambienteLib: "1",
    };
  }
  const iniDir = path.dirname(iniPath);
  const resolveRel = (p) => resolveIniRelative(iniDir, p);

  const raw = fs.readFileSync(iniPath, "utf8");
  const get = (key) => raw.match(new RegExp(`^${key}=(.+)$`, "m"))?.[1]?.trim() || "";
  const getSec = (sec, key) => {
    const re = new RegExp(`\\[${sec}\\][\\s\\S]*?^${key}=(.+)$`, "m");
    return raw.match(re)?.[1]?.trim() || "";
  };

  let fiscalLocal = null;
  try {
    fiscalLocal = require("../../fiscalLocalConfig");
  } catch (_) {
    fiscalLocal = null;
  }

  const ambEnvRaw = String(process.env.AMBIENTE_SEFAZ || "").toLowerCase();
  const ambLabelIni =
    getSec("Sistema", "AmbienteSefaz") ||
    getSec("ACBrNFe", "AmbienteSefaz") ||
    getSec("NFe", "AmbienteSefaz") ||
    "";
  const ambienteIni =
    getSec("ACBrNFe", "Ambiente") || getSec("NFe", "Ambiente") || get("Ambiente") || "";

  let ambienteSefaz = "homologacao";
  if (fiscalLocal?.normalizarAmbienteSefaz) {
    ambienteSefaz =
      fiscalLocal.normalizarAmbienteSefaz(ambEnvRaw) ||
      fiscalLocal.normalizarAmbienteSefaz(ambLabelIni) ||
      (ambienteIni
        ? fiscalLocal.tpAmbToAmbiente(ambienteIni)
        : null) ||
      "homologacao";
  } else if (ambEnvRaw === "producao" || ambEnvRaw === "1") {
    ambienteSefaz = "producao";
  } else if (ambEnvRaw === "homologacao" || ambEnvRaw === "2") {
    ambienteSefaz = "homologacao";
  } else if (String(ambLabelIni).toLowerCase() === "producao") {
    ambienteSefaz = "producao";
  } else if (ambienteIni === "0") {
    ambienteSefaz = "producao";
  } else if (ambienteIni === "2") {
    ambienteSefaz = "homologacao";
  } else if (ambienteIni === "1") {
    // Legado: INI com tpAmb SEFAZ=1 (produção) antes de AmbienteSefaz
    ambienteSefaz = "producao";
  }

  const tpAmb =
    (fiscalLocal?.ambienteToTpAmb
      ? fiscalLocal.ambienteToTpAmb(ambienteSefaz)
      : ambienteSefaz === "producao"
        ? "1"
        : "2");
  const ambienteLib =
    fiscalLocal?.ambienteToAmbienteLib
      ? fiscalLocal.ambienteToAmbienteLib(ambienteSefaz)
      : tpAmbToAmbienteLib(tpAmb);

  const vault = fiscalSecrets.lerSync();
  const senhaIni = get("Senha") || getSec("Certificado", "Senha") || "";
  const cscIni = getSec("NFCe", "CSC") || getSec("NFe", "CSC") || get("CSC") || "";
  const senhaBruta =
    vault.certificadoSenha ||
    (senhaIni && senhaIni !== "__VAULT__" ? senhaIni : "") ||
    process.env.ACBR_CERT_SENHA ||
    process.env.CERT_A1_PASS ||
    "";
  return {
    senha: certProof.normalizeCertPassword(senhaBruta),
    idCsc: getSec("NFCe", "IdCSC") || getSec("NFe", "IdCSC") || get("IdCSC") || "000001",
    csc:
      vault.nfceCsc ||
      (cscIni && cscIni !== "__VAULT__" ? cscIni : "") ||
      process.env.NFE_CSC_TOKEN ||
      "",
    uf: getSec("DFe", "UF") || get("UF") || "MG",
    pathSchemas: resolveSchemasDir(
      iniDir,
      get("PathSchemas") || getSec("ACBrNFe", "PathSchemas") || getSec("NFe", "PathSchemas"),
    ),
    certFile: (() => {
      const fromIni = resolveRel(
        getSec("Certificado", "Arquivo") ||
          getSec("DFe", "ArquivoPFX") ||
          get("Arquivo"),
      );
      if (fromIni && fs.existsSync(fromIni)) return fromIni;
      const envPath = process.env.CERT_A1_PATH || process.env.ACBR_CERT_PATH || "";
      const envNorm = String(envPath).replace(/\\\\/g, "\\").trim();
      if (envNorm && fs.existsSync(envNorm)) return envNorm;
      try {
        const { resolveProgramDataRoot } = require("../../runtime/windowsEnv");
        const candidate = path.join(resolveProgramDataRoot().root, "cert", "cert.pfx");
        if (fs.existsSync(candidate)) return candidate;
      } catch (_) {}
      return fromIni || envNorm || null;
    })(),
    servicos: resolveRel(
      get("ArquivoServicos") || getSec("ACBrNFe", "ArquivoServicos") || getSec("NFe", "IniServicos") || get("IniServicos"),
    ),
    /** tpAmb SEFAZ 1/2 — documentos / XML */
    ambiente: tpAmb,
    ambienteSefaz,
    /** enum ACBrLib 0/1 */
    ambienteLib,
  };
}

/** tpAmb SEFAZ (1=prod · 2=homolog) → enum ACBrLib [NFe] Ambiente (0/1). */
function tpAmbToAmbienteLib(tpAmb) {
  const a = String(tpAmb || "").trim();
  if (a === "1" || a === "0" || a === "producao") return "0";
  return "1";
}

/** Resolve path relativo ao diretório do INI de configuração. */
function resolveIniRelative(iniDir, relativePath) {
  if (!relativePath) return null;
  const p = String(relativePath).trim();
  if (!p) return null;
  if (path.isAbsolute(p)) return p;
  return path.normalize(path.join(iniDir, p));
}

const AGENT_ROOT = path.join(__dirname, "..", "..");

function dirTemSchemasXsd(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  try {
    if (fs.readdirSync(dir).some((f) => f.endsWith(".xsd"))) return true;
    const nfe = path.join(dir, "NFe");
    return fs.existsSync(nfe) && fs.readdirSync(nfe).some((f) => f.endsWith(".xsd"));
  } catch {
    return false;
  }
}

/** Localiza pasta de schemas XSD (bundled ou configurada no INI). */
function resolveSchemasDir(iniDir, configuredRel) {
  const configured = configuredRel ? resolveIniRelative(iniDir, configuredRel) : null;
  const candidates = [
    configured,
    configured ? path.join(configured, "NFe") : null,
    path.join(iniDir, "..", "Schemas"),
    path.join(iniDir, "..", "Schemas", "NFe"),
    path.join(AGENT_ROOT, "acbrlib", "data", "Schemas"),
    path.join(AGENT_ROOT, "schemas", "NFe"),
  ].filter(Boolean);

  for (const dir of candidates) {
    if (!dirTemSchemasXsd(dir)) continue;
    const nfe = path.join(dir, "NFe");
    if (dirTemSchemasXsd(nfe)) return nfe;
    return dir;
  }
  return configured || path.join(AGENT_ROOT, "acbrlib", "data", "Schemas");
}

function copyFileEnsureDir(src, dest) {
  if (!src || !fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.copyFileSync(src, dest);
  } catch (err) {
    if (err?.code === "EBUSY" && fs.existsSync(dest)) return true;
    throw err;
  }
  return true;
}

/** Grava só se o conteúdo mudou — evita mtime falso-positivo no fingerprint da sessão Lib. */
function writeFileIfChanged(filePath, content) {
  try {
    if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === content) {
      return false;
    }
  } catch (_) {
    /* regrava */
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return true;
}

/** Sync só quando ausente, size diverge, ou origem é mais nova (update). */
function fileNeedsSync(src, dest) {
  if (!src || !fs.existsSync(src)) return false;
  if (!dest || !fs.existsSync(dest)) return true;
  try {
    const s = fs.statSync(src);
    const d = fs.statSync(dest);
    if (s.size !== d.size) return true;
    // Certificado pode ser substituído preservando tamanho/mtime (backup,
    // restauração ou cópia administrativa). Para artefatos nativos, conteúdo
    // é a autoridade: nunca reutilizar PFX/DLL antigo só pela data.
    const sourceHash = crypto.createHash("sha256").update(fs.readFileSync(src)).digest("hex");
    const destHash = crypto.createHash("sha256").update(fs.readFileSync(dest)).digest("hex");
    return sourceHash !== destHash;
  } catch (_) {
    return true;
  }
}

function copyFileIfNeeded(src, dest) {
  if (!fileNeedsSync(src, dest)) return false;
  copyFileEnsureDir(src, dest);
  return true;
}

function copyDirRecursiveIfNeeded(src, dest) {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dest, { recursive: true });
  let n = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) n += copyDirRecursiveIfNeeded(s, d);
    else if (copyFileIfNeeded(s, d)) n += 1;
  }
  return n;
}

/**
 * Staging seletivo — NÃO copiar acbrlib/lib inteiro.
 *
 * Motivo (auditoria dep 2026-08-01):
 * - ACBrNFe/NFSe NÃO linkam OpenSSL/libxml no PE; fazem LoadLibrary pelo cwd.
 * - Pasta lib traz CTe/MDFe + libcrypto 1.1 E 3 + árvore OpenSSL/* → DLL hell no Windows.
 * - PosPrinter usa só OpenSSL 1.1; misturar no mesmo processo/cwd é risco de heap/FFI.
 */
const STAGING_RUNTIME_DLLS = [
  "libxml2.dll",
  "libxslt.dll",
  "libexslt.dll",
  "libiconv.dll",
  "legacy.dll",
];

function opensslPairForStaging() {
  // Preferir 1.1 (alinha PosPrinter + evita PKCS12_parse/legacy do OpenSSL 3).
  // Override: ACBR_LIB_OPENSSL=3 (só com legacy.dll no cwd).
  const v = String(process.env.ACBR_LIB_OPENSSL || "1.1").trim();
  if (v === "3" || v === "3.0") {
    return ["libcrypto-3-x64.dll", "libssl-3-x64.dll"];
  }
  return ["libcrypto-1_1-x64.dll", "libssl-1_1-x64.dll"];
}

/** Pastas oficiais do pacote ACBrLib (\dep\ / OpenSSL / LibXml2) — mesma arch da DLL. */
function officialDepCandidateDirs(libDir) {
  // LibXml2/x64 e OpenSSL/* ANTES de libDir: a raiz de acbrlib/lib costuma ter
  // libxml2.dll antigo/incompatível (CarregarINI → -10 XmlNode nulo). Preferir o
  // pacote oficial LibXml2/x64 (validado 2026-08-01).
  const dirs = [];
  const opensslRoot = path.join(libDir, "OpenSSL");
  const libxmlRoot = path.join(libDir, "LibXml2");
  dirs.push(path.join(libxmlRoot, "x64"));
  dirs.push(path.join(libxmlRoot, "X64"));
  // Preferir 1.1.x; se ACBR_LIB_OPENSSL=3, priorizar 3.x.
  const prefer3 = /^(3|3\.0)$/.test(String(process.env.ACBR_LIB_OPENSSL || "1.1").trim());
  const opensslVers = prefer3
    ? ["3.1.3", "3.0", "1.1.1.10", "1.1.1"]
    : ["1.1.1.10", "1.1.1", "3.1.3"];
  for (const ver of opensslVers) {
    dirs.push(path.join(opensslRoot, ver, "x64"));
    dirs.push(path.join(opensslRoot, ver, "X64"));
  }
  dirs.push(libDir);
  return dirs.filter((d) => d && fs.existsSync(d));
}

function findDepDll(libDir, fileName) {
  const needle = String(fileName).toLowerCase();
  for (const dir of officialDepCandidateDirs(libDir)) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.toLowerCase() !== needle) continue;
        const full = path.join(dir, name);
        if (fs.statSync(full).isFile()) return full;
      }
    } catch (_) {}
  }
  return null;
}

function stageNativeLibBundle(libPath, stagingRoot) {
  if (!libPath || !stagingRoot || !fs.existsSync(libPath)) return 0;
  let n = 0;
  const mainDll = path.basename(libPath);
  const libDir = path.dirname(libPath);
  // Staging antigo podia conter DLLs de CTe/MDFe/NFS-e e duas famílias OpenSSL.
  // ACBr faz LoadLibrary pelo cwd; remover artefatos estranhos antes do primeiro
  // Inicializar elimina resolução não determinística.
  const foreign = [
    "ACBrCTe64.dll",
    "ACBrMDFe64.dll",
    "ACBrNFSe64.dll",
    "libcrypto-3-x64.dll",
    "libssl-3-x64.dll",
  ];
  if (/nfse/i.test(mainDll)) {
    foreign.splice(foreign.indexOf("ACBrNFSe64.dll"), 1);
  }
  // Se estamos no modo 1.1, nunca deixar crypto-3 no cwd (PKCS12_parse / legacy).
  // Se modo 3, não deixar crypto-1.1 competir.
  const prefer3 = /^(3|3\.0)$/.test(String(process.env.ACBR_LIB_OPENSSL || "1.1").trim());
  if (!prefer3) {
    /* already in foreign */
  } else {
    foreign.push("libcrypto-1_1-x64.dll", "libssl-1_1-x64.dll", "libcrypto-1_1.dll", "libssl-1_1.dll");
  }
  for (const name of foreign) {
    try {
      fs.rmSync(path.join(stagingRoot, name), { force: true });
    } catch (_) {}
  }
  try {
    fs.rmSync(path.join(stagingRoot, "OpenSSL"), { recursive: true, force: true });
  } catch (_) {}
  if (copyFileIfNeeded(libPath, path.join(stagingRoot, mainDll))) n += 1;

  const wantedNames = [
    ...STAGING_RUNTIME_DLLS,
    ...opensslPairForStaging(),
  ];
  // legacy.dll sempre — necessário se alguma chamada cair no OpenSSL 3.
  if (!wantedNames.includes("legacy.dll")) wantedNames.push("legacy.dll");

  for (const name of wantedNames) {
    const src = findDepDll(libDir, name);
    if (!src) continue;
    if (copyFileIfNeeded(src, path.join(stagingRoot, name))) n += 1;
  }
  return n;
}


function isNativeSessionActiveSafe() {
  try {
    return require("./acbrLibSession").getSessionStatus().ativa === true;
  } catch (_) {
    return false;
  }
}

/** Sessão ativa OU DLL já mapeada (soft-abandon) — não sobrescrever no disco. */
function shouldBlockDllOverwriteSafe() {
  try {
    const s = require("./acbrLibSession");
    return s.isDllPinned() === true || s.getSessionStatus().ativa === true;
  } catch (_) {
    return false;
  }
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

function getWinStagingRoot(custom, libPathHint) {
  if (custom) return custom;
  if (process.env.ACBR_WIN_STAGING) return process.env.ACBR_WIN_STAGING;
  const base = path.basename(String(libPathHint || "")).toLowerCase();
  const slot = base.includes("nfse") ? "margin-acbrlib-nfse" : "margin-acbrlib";
  return resolveStagingDir(slot);
}

/**
 * @param {object} opts
 * @param {string} opts.libPath
 * @param {string} opts.iniConfigPath
 * @param {object} opts.assets — lib, schemas, cert, servicos, notas, log
 * @param {string} [opts.stagingRoot]
 * @param {boolean} [opts.forceStaging] — força staging no Windows mesmo sem UNC
 */
function prepareNativeRuntime({ libPath, iniConfigPath, assets, stagingRoot, forceStaging = false }) {
  const iniVals = readIniValues(iniConfigPath);
  const certFile = assets.cert || iniVals.certFile;
  const schemasDir = assets.schemas || iniVals.pathSchemas;
  const servicosFile = assets.servicos || iniVals.servicos;
  const notasDir = assets.notas;
  const logDir = assets.log;
  const libDir = assets.lib || path.dirname(libPath);

  const shouldStage =
    process.platform === "win32" &&
    (forceStaging || isUncPath(libPath) || isUncPath(iniConfigPath) || isUncPath(certFile));

  if (!shouldStage) {
    const root = path.dirname(libPath);
    const pdfDir = assets.pdf || path.join(path.dirname(iniConfigPath), "..", "pdf");
    const certAbs = certFile && fs.existsSync(certFile) ? certFile : null;
    const certRel = certAbs ? path.basename(certAbs) : null;
    const schemasResolved = resolveSchemasDir(path.dirname(iniConfigPath), schemasDir);
    const proof = certProof.buildCertProof({
      sourcePath: certAbs,
      stagedPath: certAbs,
      password: iniVals.senha,
      synced: false,
    });
    lastCertProof = proof;
    return {
      root,
      libPath,
      iniConfig: iniConfigPath,
      notas: notasDir || path.dirname(libPath),
      pdf: pdfDir,
      schemas: schemasResolved,
      servicos: servicosFile,
      cert: certAbs,
      certRel,
      certSha256: proof.stagedSha256 || proof.sourceSha256 || null,
      certSourceSha256: proof.sourceSha256 || null,
      certProof: proof,
      certSynced: false,
      logNivel: resolveAcbrLogNivel(),
      config: path.dirname(iniConfigPath),
      senha: iniVals.senha,
      idCsc: iniVals.idCsc,
      csc: iniVals.csc,
      tpAmb: iniVals.ambiente || "2",
      ambienteSefaz: iniVals.ambienteSefaz || "homologacao",
      ambienteLib: iniVals.ambienteLib || tpAmbToAmbienteLib(iniVals.ambiente || "2"),
      staged: false,
    };
  }

  const staging = getWinStagingRoot(stagingRoot, libPath);
  const dirs = {
    root: staging,
    config: path.join(staging, "config"),
    cert: path.join(staging, "cert"),
    schemas: path.join(staging, "Schemas", "NFe"),
    notas: path.join(staging, "notas"),
    pdf: path.join(staging, "pdf"),
    log: path.join(staging, "log"),
  };

  for (const d of Object.values(dirs)) {
    if (d !== staging) fs.mkdirSync(d, { recursive: true });
  }

  // Nunca regravar DLL/deps com sessão ativa OU após soft-abandon (DLL ainda mapeada no koffi).
  const blockDllOverwrite = shouldBlockDllOverwriteSafe();
  if (blockDllOverwrite) {
    const stagedLib = path.join(staging, path.basename(libPath));
    if (!fs.existsSync(stagedLib)) {
      stageNativeLibBundle(libPath, staging);
    }
  } else {
    stageNativeLibBundle(libPath, staging);
  }
  if (schemasDir) {
    if (
      !blockDllOverwrite ||
      !fs.existsSync(dirs.schemas) ||
      fs.readdirSync(dirs.schemas).length < 5
    ) {
      copyDirRecursiveIfNeeded(schemasDir, dirs.schemas);
    }
  }
  if (servicosFile) {
    copyFileIfNeeded(servicosFile, path.join(dirs.config, path.basename(servicosFile)));
  }
  let certSynced = false;
  if (certFile) {
    certSynced = copyFileIfNeeded(
      certFile,
      path.join(dirs.cert, path.basename(certFile) || "cert.pfx"),
    );
  }

  const stagedCert = path.join(dirs.cert, path.basename(certFile || "cert.pfx"));
  const stagedCertRel = path.join("cert", path.basename(certFile || "cert.pfx"));
  const stagedServicos = path.join(dirs.config, path.basename(servicosFile || "ACBrNFeServicos.ini"));
  const runtimeIni = path.join(dirs.config, "acbrlib.runtime.ini");
  const tpAmb = iniVals.ambiente || "2";
  const ambLib = iniVals.ambienteLib || tpAmbToAmbienteLib(tpAmb);
  const ambSefaz = iniVals.ambienteSefaz || (tpAmb === "1" ? "producao" : "homologacao");
  const certIniPath = stagedCert;
  const logNivel = resolveAcbrLogNivel();

  const proof = certProof.buildCertProof({
    sourcePath: certFile || null,
    stagedPath: fs.existsSync(stagedCert) ? stagedCert : null,
    password: iniVals.senha,
    synced: certSynced,
  });
  lastCertProof = proof;
  try {
    const log = require("../../logger").child({ modulo: "acbr_lib_runtime" });
    log.info(
      { cert: certProof.certProofForLog(proof), logNivel, metric: "acbrlib.cert_proof" },
      certSynced
        ? "[ACBrLib] Certificado sincronizado no staging — sessão deve reiniciar"
        : "[ACBrLib] Prova do certificado A1 (staging)",
    );
  } catch (_) {
    /* logger opcional em scripts isolados */
  }

  const iniContent = `[Principal]
TipoResposta=2
LogNivel=${logNivel}
LogPath=${dirs.log}

[Sistema]
Nome=MarginEngine-ACBrLib
Versao=1.0.0
AmbienteSefaz=${ambSefaz}

[NFe]
Ambiente=${ambLib}
AmbienteSefaz=${ambSefaz}
ModeloDF=1
VersaoDF=3
IniServicos=${path.join("config", path.basename(stagedServicos))}
PathSchemas=${path.join("Schemas", "NFe")}
PathSalvar=${path.join("notas")}
PathNFe=${path.join("notas")}
PathPDF=${path.join("pdf")}
SalvarGer=1
SalvarWS=1
ExibirErroSchema=1
FormaEmissao=0
Timeout=30000
IdCSC=${iniVals.idCsc}
CSC=${iniVals.csc}

[ACBrNFe]
Ambiente=${ambLib}
AmbienteSefaz=${ambSefaz}
ModeloDF=65
VersaoDF=4.00
PathSchemas=${path.join("Schemas", "NFe")}
PathSalvar=${path.join("notas")}
PathNFe=${path.join("notas")}
PathPDF=${path.join("pdf")}
ArquivoServicos=${path.join("config", path.basename(stagedServicos))}
SalvarGer=1
SalvarWS=1
ExibirErroSchema=1
FormaEmissao=0
Timeout=30000

[Certificado]
Arquivo=${certIniPath}
Senha=${iniVals.senha || ""}

[DFe]
UF=${iniVals.uf}
ArquivoPFX=${certIniPath}
Senha=${iniVals.senha ? acbrLibCrypt.stringToB64Crypt(iniVals.senha) : ""}
SSLCryptLib=1
SSLHttpLib=3
SSLXmlSignLib=4
SSLType=5

[DANFE]
PathPDF=${path.join("pdf")}
TipoDANFE=1
ImprimeCodigoEan=0

[DANFENFe]
ExibeEAN=0
LarguraCodProd=72

[NFCe]
IdCSC=${iniVals.idCsc}
CSC=${iniVals.csc}
`;
  // Só regrava se o conteúdo mudou — write sempre muda mtime e o fingerprint
  // da sessão forçava NFE_Finalizar+Inicializar a cada statusServico (void** no koffi).
  writeFileIfChanged(runtimeIni, iniContent);

  const stagedLib = path.join(staging, path.basename(libPath));
  return {
    root: staging,
    libPath: fs.existsSync(stagedLib) ? stagedLib : libPath,
    iniConfig: runtimeIni,
    notas: dirs.notas,
    pdf: dirs.pdf,
    schemas: dirs.schemas,
    cert: stagedCert,
    certRel: stagedCertRel,
    certSha256: proof.stagedSha256 || proof.sourceSha256 || null,
    certSourceSha256: proof.sourceSha256 || null,
    certProof: proof,
    certSynced,
    logNivel,
    config: dirs.config,
    senha: iniVals.senha,
    idCsc: iniVals.idCsc,
    csc: iniVals.csc,
    tpAmb,
    ambienteSefaz: ambSefaz,
    ambienteLib: ambLib,
    staged: true,
  };
}

/** Garante path nativo para INI/XML quando origem está fora do cwd da DLL (UNC ou MarginEngine). */
function ensureNativeDocumentPath(documentPath, runtime) {
  if (!documentPath) return documentPath;
  const basename = path.basename(documentPath);
  if (runtime.staged && runtime.notas && fs.existsSync(documentPath)) {
    const dest = path.join(runtime.notas, basename);
    if (path.resolve(dest) !== path.resolve(documentPath)) {
      copyFileEnsureDir(documentPath, dest);
      return dest;
    }
  }
  if (!isUncPath(documentPath)) return documentPath;
  const dest = path.join(runtime.notas, basename);
  copyFileEnsureDir(documentPath, dest);
  return dest;
}

/** Localiza artefato (XML/PDF) no staging pelo chave de 44 dígitos. */
function findStagedArtifact(runtime, chave, ext) {
  const k = String(chave || "").replace(/\D/g, "");
  if (k.length !== 44) return null;
  const suffix = String(ext || "").toLowerCase();
  const dirs = [runtime?.notas, runtime?.pdf, runtime?.root].filter(Boolean);
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const hit = fs
      .readdirSync(dir)
      .find((f) => f.toLowerCase().includes(k) && f.toLowerCase().endsWith(suffix));
    if (hit) return path.join(dir, hit);
  }
  return null;
}


/** Diretórios de staging conhecidos (homolog / emissões anteriores). */
function listKnownStagingRoots() {
  const temp = resolveTempRoot();
  const roots = [
    process.env.ACBR_WIN_STAGING,
    path.join(temp, "margin-acbrlib-prod-test"),
    path.join(temp, "margin-acbrlib"),
    path.join(temp, "margin-acbrlib-nfse"),
    resolveStagingDir("margin-acbrlib-prod-test"),
    resolveStagingDir("margin-acbrlib"),
    resolveStagingDir("margin-acbrlib-nfse"),
  ].filter(Boolean);
  return [...new Set(roots)];
}

function findStagedArtifactAnywhere(chave, ext) {
  for (const root of listKnownStagingRoots()) {
    const hit = findStagedArtifact(
      { notas: path.join(root, "notas"), pdf: path.join(root, "pdf"), root },
      chave,
      ext,
    );
    if (hit) return hit;
  }
  return null;
}

/** Path relativo ao cwd da DLL para NFE_CarregarXML / CarregarINI. */
function resolveNativeLibRelativePath(filePath, runtime) {
  if (!filePath) return filePath;
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(runtime?.root || process.cwd(), filePath);
  if (runtime?.staged && runtime.root && abs.startsWith(runtime.root)) {
    return path.relative(runtime.root, abs);
  }
  if (runtime?.staged && runtime.notas) {
    const dest = path.join(runtime.notas, path.basename(abs));
    if (path.resolve(dest) !== path.resolve(abs)) {
      copyFileEnsureDir(abs, dest);
    }
    return path.join("notas", path.basename(abs));
  }
  return abs;
}

/** Path relativo ao cwd da DLL para NFE_CarregarINI (staging Windows). */
function resolveNativeDocumentIniPath(documentPath, runtime) {
  const prepared = ensureNativeDocumentPath(documentPath, runtime);
  if (runtime.root && fs.existsSync(prepared) && String(prepared).startsWith(runtime.root)) {
    return path.relative(runtime.root, prepared);
  }
  if (runtime.staged && runtime.notas) {
    return path.join("notas", path.basename(prepared));
  }
  return prepared;
}

/**
 * Reaplica paths/CSC via configGravarValor — NÃO toca certificado (evita -10 após CarregarINI).
 */
function schemasPathForNativeLib(runtime) {
  if (runtime.staged) {
    return path.join("Schemas", "NFe");
  }
  if (runtime.schemas && fs.existsSync(runtime.schemas)) {
    return runtime.schemas;
  }
  return path.join("Schemas", "NFe");
}

function applyDanfeLayoutConfig(inst, modeloDf = "55") {
  if (String(modeloDf) !== "55") return;
  const largura = String(process.env.DANFE_LARGURA_COD_PROD || "72").trim() || "72";
  const sets = [
    ["DANFE", "ImprimeCodigoEan", "0"],
    ["DANFENFe", "ExibeEAN", "0"],
    ["DANFENFe", "LarguraCodProd", largura],
  ];
  for (const [sec, key, val] of sets) {
    try {
      inst.configGravarValor(sec, key, val);
    } catch (_) {
      /* opcional por versão da DLL */
    }
  }
}

function applyNativeRuntimeConfig(inst, runtime) {
  const servicosName = path.basename(runtime.servicos || "ACBrNFeServicos.ini");
  const servicosRel = path.join("config", servicosName);
  const ambLib = String(
    runtime.ambienteLib || tpAmbToAmbienteLib(runtime.tpAmb || runtime.ambiente || "2"),
  );
  const ambSefaz = String(
    runtime.ambienteSefaz || (String(runtime.tpAmb) === "1" ? "producao" : "homologacao"),
  );
  const sets = [
    ["NFe", "Ambiente", ambLib],
    ["ACBrNFe", "Ambiente", ambLib],
    ["NFe", "AmbienteSefaz", ambSefaz],
    ["ACBrNFe", "AmbienteSefaz", ambSefaz],
    ["Sistema", "AmbienteSefaz", ambSefaz],
    ["NFe", "PathSchemas", schemasPathForNativeLib(runtime)],
    ["NFe", "IniServicos", servicosRel],
    ["NFe", "PathSalvar", path.join("notas")],
    ["NFe", "PathNFe", path.join("notas")],
    ["NFe", "PathPDF", path.join("pdf")],
    ["DANFE", "PathPDF", path.join("pdf")],
    ["DANFE", "TipoDANFE", "1"],
    ["DANFE", "Site", "Margin Engine"],
    ["DANFE", "MarcaDagua", "Margin Engine"],
    ["NFe", "IdCSC", runtime.idCsc || "000001"],
    ["NFe", "CSC", runtime.csc || ""],
    ["NFCe", "IdCSC", runtime.idCsc || "000001"],
    ["NFCe", "CSC", runtime.csc || ""],
    // A1 em arquivo .pfx (como em 19/07/2026, última emissão OK): OpenSSL + LibXml2 + TLS 1.2.
    // WinCrypt (3/2/4) abria o PFX mas StatusServico voltava CStat=0 vazio neste PDV.
    // SSLCryptLib: 1=OpenSSL · SSLHttpLib: 3=OpenSSL · SSLXmlSignLib: 4=LibXml2 · SSLType: 5=TLS1.2
    ["DFe", "SSLCryptLib", "1"],
    ["DFe", "SSLHttpLib", "3"],
    ["DFe", "SSLXmlSignLib", "4"],
    ["DFe", "SSLType", "5"],
  ];
  for (const [sec, key, val] of sets) {
    if (val == null || val === "") continue;
    try {
      inst.configGravarValor(sec, key, String(val));
    } catch (_) {
      /* opcional por versão */
    }
  }
  applyDanfeLayoutConfig(inst, "55");
}

function applyNativeCertConfig(inst, runtime) {
  const certPath = runtime.cert || runtime.certRel;
  const senha = certProof.normalizeCertPassword(runtime.senha);
  if (!certPath) return;
  if (!senha) {
    try {
      const log = require("../../logger").child({ modulo: "acbr_lib_runtime" });
      log.error(
        { metric: "acbrlib.cert_senha_ausente" },
        "[ACBrLib] Senha do certificado ausente no cofre — serviço Windows não lê keyring do usuário. Regrave a senha em Configuração Fiscal.",
      );
    } catch (_) {}
    return;
  }
  const cert = String(certPath);
  // Paridade 19/07 (emissão OK): Certificado.* + DFe.* via API com senha plaintext.
  // SEFAZ-MG exige mTLS — sem Certificado.Senha o HTTP sobe sem client cert e
  // StatusServico volta CStat=0 vazio (handshake failure). Logs nativos 28–30/07
  // mostram PrecisaCriptografar(Certificado,Senha)=False e (DFe,Senha)=True.
  try {
    inst.configGravarValor("Certificado", "Arquivo", cert);
    inst.configGravarValor("Certificado", "Senha", senha);
    inst.configGravarValor("DFe", "ArquivoPFX", cert);
    inst.configGravarValor("DFe", "Senha", senha);
  } catch (err) {
    try {
      const log = require("../../logger").child({ modulo: "acbr_lib_runtime" });
      log.warn({ err: err?.message, metric: "acbrlib.cert_senha_api_fail" }, "[ACBrLib] Falha ao gravar certificado/senha");
    } catch (_) {}
  }
}

/**
 * Certificado deve ser reaplicado APÓS NFE_CarregarINI (documento limpa contexto SSL).
 */
function reloadNativeCertAfterCarregarIni(inst, runtime) {
  applyNativeCertConfig(inst, runtime);
}

function resolveInstPaths(runtime) {
  const libInRoot =
    runtime.root && path.dirname(runtime.libPath) === runtime.root
      ? path.basename(runtime.libPath)
      : runtime.libPath;
  const iniInRoot =
    runtime.root && String(runtime.iniConfig).startsWith(runtime.root)
      ? path.relative(runtime.root, runtime.iniConfig)
      : runtime.iniConfig;
  return { libPath: libInRoot, iniConfig: iniInRoot };
}

/**
 * Executa callback com cwd na pasta da DLL (requerido pela ACBrLib no Windows).
 * @template T
 * @param {object} runtime
 * @param {(paths: {libPath:string, iniConfig:string}) => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withNativeLibSession(runtime, fn) {
  const cwdBefore = process.cwd();
  const instPaths = resolveInstPaths(runtime);
  try {
    if (runtime.root && fs.existsSync(runtime.root)) {
      process.chdir(runtime.root);
    }
    return await fn(instPaths);
  } finally {
    try {
      process.chdir(cwdBefore);
    } catch (_) {
      /* ignore */
    }
  }
}

module.exports = {
  isUncPath,
  readIniValues,
  resolveIniRelative,
  resolveSchemasDir,
  tpAmbToAmbienteLib,
  prepareNativeRuntime,
  writeFileIfChanged,
  fileNeedsSync,
  copyFileIfNeeded,
  copyDirRecursiveIfNeeded,
  stageNativeLibBundle,
  ensureNativeDocumentPath,
  resolveNativeDocumentIniPath,
  resolveNativeLibRelativePath,
  findStagedArtifact,
  findStagedArtifactAnywhere,
  listKnownStagingRoots,
  applyNativeRuntimeConfig,
  applyDanfeLayoutConfig,
  applyNativeCertConfig,
  reloadNativeCertAfterCarregarIni,
  withNativeLibSession,
  resolveInstPaths,
  getLastCertProof,
  probeCertProofFromDisk,
  resolveAcbrLogNivel,
};

/**
 * Runtime ACBrLib nativo — staging Windows (WSL), chdir e config pós-init.
 * Compartilhado pelo acbrLibDriver.js e scripts de homologação.
 */
const fs = require("fs");
const path = require("path");
const { resolveTempRoot, resolveStagingDir } = require("../../runtime/windowsEnv");
const fiscalSecrets = require("../../fiscalSecrets");

function isUncPath(p) {
  return /wsl\.localhost|wsl\$|^\\\\/i.test(String(p || ""));
}

function readIniValues(iniPath) {
  if (!iniPath || !fs.existsSync(iniPath)) {
    return { senha: "", idCsc: "000001", csc: "", uf: "MG", ambiente: "2" };
  }
  const iniDir = path.dirname(iniPath);
  const resolveRel = (p) => resolveIniRelative(iniDir, p);

  const raw = fs.readFileSync(iniPath, "utf8");
  const get = (key) => raw.match(new RegExp(`^${key}=(.+)$`, "m"))?.[1]?.trim() || "";
  const getSec = (sec, key) => {
    const re = new RegExp(`\\[${sec}\\][\\s\\S]*?^${key}=(.+)$`, "m");
    return raw.match(re)?.[1]?.trim() || "";
  };
  const ambienteIni =
    getSec("ACBrNFe", "Ambiente") || getSec("NFe", "Ambiente") || get("Ambiente") || "2";
  const ambEnv = String(process.env.AMBIENTE_SEFAZ || "").toLowerCase();
  let ambiente = ambienteIni;
  if (ambEnv === "producao" || ambEnv === "1") ambiente = "1";
  else if (ambEnv === "homologacao" || ambEnv === "2") ambiente = "2";

  const vault = fiscalSecrets.lerSync();
  const senhaIni = get("Senha") || getSec("Certificado", "Senha") || "";
  const cscIni = getSec("NFCe", "CSC") || getSec("NFe", "CSC") || get("CSC") || "";
  return {
    senha:
      vault.certificadoSenha ||
      (senhaIni && senhaIni !== "__VAULT__" ? senhaIni : "") ||
      process.env.ACBR_CERT_SENHA ||
      process.env.CERT_A1_PASS ||
      "",
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
    certFile: resolveRel(getSec("Certificado", "Arquivo") || get("Arquivo")),
    servicos: resolveRel(
      get("ArquivoServicos") || getSec("ACBrNFe", "ArquivoServicos") || getSec("NFe", "IniServicos") || get("IniServicos"),
    ),
    ambiente,
    /** Ambiente ACBrLib [NFe]: 0=produção · 1=homologação (≠ tpAmb SEFAZ 1/2) */
    ambienteLib: tpAmbToAmbienteLib(ambiente),
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

function getWinStagingRoot(custom) {
  return custom || process.env.ACBR_WIN_STAGING || resolveStagingDir("margin-acbrlib");
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
      config: path.dirname(iniConfigPath),
      senha: iniVals.senha,
      idCsc: iniVals.idCsc,
      csc: iniVals.csc,
      tpAmb: iniVals.ambiente || "2",
      ambienteLib: iniVals.ambienteLib || tpAmbToAmbienteLib(iniVals.ambiente || "2"),
      staged: false,
    };
  }

  const staging = getWinStagingRoot(stagingRoot);
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

  copyDirRecursive(libDir, staging);
  if (schemasDir) copyDirRecursive(schemasDir, dirs.schemas);
  if (servicosFile) {
    copyFileEnsureDir(servicosFile, path.join(dirs.config, path.basename(servicosFile)));
  }
  if (certFile) {
    copyFileEnsureDir(certFile, path.join(dirs.cert, path.basename(certFile) || "cert.pfx"));
  }

  const stagedCert = path.join(dirs.cert, path.basename(certFile || "cert.pfx"));
  const stagedCertRel = path.join("cert", path.basename(certFile || "cert.pfx"));
  const stagedServicos = path.join(dirs.config, path.basename(servicosFile || "ACBrNFeServicos.ini"));
  const runtimeIni = path.join(dirs.config, "acbrlib.runtime.ini");
  const tpAmb = iniVals.ambiente || "2";
  const ambLib = iniVals.ambienteLib || tpAmbToAmbienteLib(tpAmb);
  const certIniPath = stagedCert;

  const iniContent = `[Principal]
TipoResposta=2
LogNivel=4
LogPath=${dirs.log}

[Sistema]
Nome=MarginEngine-ACBrLib
Versao=1.0.0

[NFe]
Ambiente=${ambLib}
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
Senha=${iniVals.senha}

[DFe]
UF=${iniVals.uf}
SSLCryptLib=1
SSLHttpLib=3
SSLXmlSignLib=4

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
  fs.writeFileSync(runtimeIni, iniContent, "utf8");

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
    config: dirs.config,
    senha: iniVals.senha,
    idCsc: iniVals.idCsc,
    csc: iniVals.csc,
    tpAmb,
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
    resolveStagingDir("margin-acbrlib-prod-test"),
    resolveStagingDir("margin-acbrlib"),
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
  const ambLib = runtime.ambienteLib || tpAmbToAmbienteLib(runtime.tpAmb || runtime.ambiente || "2");
  const sets = [
    ["NFe", "Ambiente", ambLib],
    ["ACBrNFe", "Ambiente", ambLib],
    ["NFe", "PathSchemas", schemasPathForNativeLib(runtime)],
    ["NFe", "IniServicos", servicosRel],
    ["NFe", "PathSalvar", path.join("notas")],
    ["NFe", "PathNFe", path.join("notas")],
    ["NFe", "PathPDF", path.join("pdf")],
    ["DANFE", "PathPDF", path.join("pdf")],
    ["DANFE", "TipoDANFE", "1"],
    ["NFe", "IdCSC", runtime.idCsc || "000001"],
    ["NFe", "CSC", runtime.csc || ""],
    ["NFCe", "IdCSC", runtime.idCsc || "000001"],
    ["NFCe", "CSC", runtime.csc || ""],
    ["DFe", "SSLCryptLib", "1"],
    ["DFe", "SSLHttpLib", "3"],
    ["DFe", "SSLXmlSignLib", "4"],
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
  if (!certPath || !runtime.senha) return;
  const cert = String(certPath);
  const senha = String(runtime.senha);
  try {
    inst.configGravarValor("Certificado", "Arquivo", cert);
    inst.configGravarValor("Certificado", "Senha", senha);
    inst.configGravarValor("DFe", "ArquivoPFX", cert);
    inst.configGravarValor("DFe", "Senha", senha);
  } catch (_) {
    /* ignore */
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
};

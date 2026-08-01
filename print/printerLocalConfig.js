/**
 * Configuração local da impressora — INI completo + .env (SSOT local).
 * Persistência: escrita atômica, idempotente, reset de provider só quando muda.
 */
const fs = require("fs");
const path = require("path");
const log = require("../logger").child({ modulo: "printer_local_config" });
function runtime() {
  return require("./acbrPosPrinterRuntime");
}
const {
  inferirModeloAcbr,
  inferirPortaAcbr,
  normalizarPortaAcbr,
  parsePortaTcp,
  resolveControlePorta,
  portaAcbrValida,
} = require("./printerModelMap");
const {
  resolveLogNivel,
  buildDeviceSection,
} = require("./posPrinterIniDefaults");

const AGENT_ROOT = path.resolve(__dirname, "..");

function escapeReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveIniPath() {
  return runtime().resolveIniPath();
}

function resolveEnvPath() {
  if (process.env.PRINTER_LOCAL_ENV_OVERRIDE) {
    return process.env.PRINTER_LOCAL_ENV_OVERRIDE;
  }
  return path.join(AGENT_ROOT, ".env");
}

/** Escrita atômica (tmp + rename) — evita INI/.env pela metade em crash. */
function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tmp, content, "utf8");
  try {
    fs.renameSync(tmp, filePath);
  } catch (_) {
    // Windows: destino existente — overwrite via copy+unlink
    fs.copyFileSync(tmp, filePath);
    try {
      fs.unlinkSync(tmp);
    } catch (_) {}
  }
}

function paperMmFromColunas(colunas) {
  const n = Number(colunas);
  if (Number.isFinite(n) && n > 0 && n <= 32) return 58;
  return 80;
}

function lerIniValores(iniPath) {
  const defaults = {
    modelo: "0",
    porta: "",
    colunas: "48",
    pageCode: "2",
    cut: "partial",
    baud: "9600",
    parity: "0",
    stopBits: "0",
    handshake: "0",
    timeout: "5",
  };
  if (!iniPath || !fs.existsSync(iniPath)) return { ...defaults };
  const raw = fs.readFileSync(iniPath, "utf8");
  const get = (sec, key) => {
    const re = new RegExp(`\\[${escapeReg(sec)}\\][\\s\\S]*?^${key}=(.+)$`, "m");
    return raw.match(re)?.[1]?.trim() || "";
  };
  return {
    modelo: get("PosPrinter", "Modelo") || defaults.modelo,
    porta: get("PosPrinter", "Porta") || defaults.porta,
    colunas: get("PosPrinter", "ColunasFonteNormal") || defaults.colunas,
    pageCode: get("PosPrinter", "PaginaDeCodigo") || defaults.pageCode,
    cut: get("PosPrinter", "CortaPapel") === "0" ? "total" : "partial",
    baud: get("PosPrinter_Device", "Baud") || defaults.baud,
    parity: get("PosPrinter_Device", "Parity") || defaults.parity,
    stopBits: get("PosPrinter_Device", "Stop") || defaults.stopBits,
    handshake: get("PosPrinter_Device", "HandShake") || defaults.handshake,
    timeout: get("PosPrinter_Device", "TimeOut") || defaults.timeout,
  };
}

function gerarIniContent(vals) {
  const logPath = path.join(AGENT_ROOT, "data", "logs", "posprinter");
  const logNivel = resolveLogNivel();
  // LogPath só quando debug — em produção ArqLog/nível 0 evita I/O no HD do PDV
  const principalLog =
    logNivel === "0"
      ? `LogNivel=0
ArqLog=
`
      : `LogNivel=${logNivel}
LogPath=${logPath}
ArqLog=
`;

  const deviceBlock = buildDeviceSection(vals, { porta: vals.porta });

  const logo = (() => {
    try {
      const meta = require("./printerLogo").ler();
      if (!meta.ativo) return "";
      const size = meta.printSize || require("./printerLogoSize").resolveLogoPrintSize(meta);
      return `
[PosPrinter_Logo]
IgnorarLogo=0
KeyCode=${meta.kc1 || "48"}
KeyCode2=${meta.kc2 || "49"}
FatorX=${size.fatorX}
FatorY=${size.fatorY}
`;
    } catch (_) {
      return "";
    }
  })();

  return `[Principal]
TipoResposta=2
${principalLog}
[PosPrinter]
Modelo=${vals.modelo || "0"}
Porta=${vals.porta || ""}
PaginaDeCodigo=${vals.pageCode || "2"}
ColunasFonteNormal=${vals.colunas || "48"}
CortaPapel=${vals.cut === "total" ? "0" : "1"}
TraduzirTags=1
IgnorarTags=0
LinhasBuffer=${process.env.PRINTER_BUFFER_LINES || "0"}
ControlePorta=${resolveControlePorta(vals.porta)}
VerificarImpressora=${
    process.env.PRINTER_VERIFICAR === "true"
      ? "1"
      : process.env.PRINTER_VERIFICAR === "false"
        ? "0"
        : "0"
  }
GavetaSinalInvertido=${process.env.PRINTER_DRAWER_INVERTED === "true" ? "1" : "0"}
GavetaTempoON=${process.env.PRINTER_DRAWER_ON_MS || "120"}
GavetaTempoOFF=${process.env.PRINTER_DRAWER_OFF_MS || "240"}
${deviceBlock}${logo}`;
}

function patchEnv(map) {
  invalidateLerCache();
  const envPath = resolveEnvPath();
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  for (const [key, val] of Object.entries(map)) {
    const re = new RegExp(`^${escapeReg(key)}=.*$`, "m");
    const line = `${key}=${val ?? ""}`;
    content = re.test(content) ? content.replace(re, line) : `${content.replace(/\s*$/, "")}\n${line}\n`;
  }
  writeFileAtomic(envPath, content);
  for (const [key, val] of Object.entries(map)) {
    process.env[key] = String(val ?? "");
  }
}

function patchEnvPublic(map) {
  return patchEnv(map);
}

/** Cache curto — getThermalCols/render chamam ler() dezenas de vezes por cupom. */
let _lerCache = { at: 0, value: null };
const LER_CACHE_MS = parseInt(process.env.PRINTER_CONFIG_CACHE_MS || "5000", 10);

function invalidateLerCache() {
  _lerCache = { at: 0, value: null };
}

function ler(opts = {}) {
  if (opts.fresh) invalidateLerCache();
  const agora = Date.now();
  if (_lerCache.value && agora - _lerCache.at < LER_CACHE_MS) {
    return _lerCache.value;
  }
  const iniPath = resolveIniPath();
  const ini = lerIniValores(iniPath);
  let logo = null;
  try {
    logo = require("./printerLogo").ler();
  } catch (_) {}
  const paperMm = paperMmFromColunas(ini.colunas);
  const value = {
    provider: process.env.PRINTER_PROVIDER || "acbr-posprinter",
    fallback: process.env.PRINTER_FALLBACK || "native",
    tipo: process.env.PRINTER_TYPE || "auto",
    encoding: process.env.PRINTER_ENCODING || "UTF8",
    cut: process.env.PRINTER_CUT || ini.cut || "partial",
    drawer: (process.env.PRINTER_DRAWER || "true").toLowerCase() !== "false",
    modelo: ini.modelo,
    porta: ini.porta,
    colunas: ini.colunas,
    paperMm,
    serial: {
      baud: ini.baud,
      parity: ini.parity,
      stopBits: ini.stopBits,
      handshake: ini.handshake,
      timeout: ini.timeout,
    },
    logo,
    libPath: runtime().resolveLibPath(),
    iniPath,
    iniExiste: !!(iniPath && fs.existsSync(iniPath)),
    nativeReady: !!runtime().resolveLibPath(),
    mode: runtime().resolveLibPath()
      ? "native"
      : process.env.PRINTER_ALLOW_PARITY === "true"
        ? "parity"
        : "unconfigured",
  };
  _lerCache = { at: agora, value };
  return value;
}

function eqStr(a, b) {
  return String(a ?? "").trim() === String(b ?? "").trim();
}

/**
 * Calcula vals+envPatch a partir do estado atual sem gravar.
 * Usado por salvar (idempotente) e testes.
 */
function projetarSalvar(updates, valsBase) {
  const envPatch = {};
  const vals = { ...valsBase };

  if (updates.provider) envPatch.PRINTER_PROVIDER = String(updates.provider);
  if (updates.porta != null && String(updates.porta).trim() !== "") {
    vals.porta = normalizarPortaAcbr(String(updates.porta), {
      host: updates.host,
      port: updates.portaNum,
      nomeWindows: updates.nomeImpressora,
    });
    if (!portaAcbrValida(vals.porta)) {
      const err = new Error(
        `Porta inválida: "${updates.porta}". Use TCP:IP:porta (ex.: TCP:192.168.1.50:9100), RAW:NomeWindows ou COMn.`,
      );
      err.code = "PRINTER_PORTA_INVALIDA";
      throw err;
    }
    envPatch.PRINTER_PORTA = vals.porta;
    const tcp = parsePortaTcp(vals.porta);
    if (tcp) {
      envPatch.PRINTER_HOST = tcp.host;
      envPatch.PRINTER_PORT = String(tcp.port);
      envPatch.PRINTER_TYPE = updates.tipo || "network";
    } else if (/^RAW:/i.test(vals.porta)) {
      const nomeRaw = vals.porta.replace(/^RAW:/i, "").trim();
      if (nomeRaw) envPatch.PRINTER_NAME = nomeRaw;
      envPatch.PRINTER_HOST = "";
      envPatch.PRINTER_TYPE = updates.tipo || "windows";
    } else if (/^COM\d/i.test(vals.porta)) {
      envPatch.PRINTER_TYPE = updates.tipo || "serial";
    }
  }
  if (updates.modelo != null && String(updates.modelo).trim() !== "") {
    vals.modelo = String(updates.modelo).trim();
    envPatch.PRINTER_MODEL = vals.modelo;
  }
  if (updates.colunas != null) {
    vals.colunas = String(updates.colunas);
    envPatch.PRINTER_COLUNAS = vals.colunas;
  }
  if (updates.paperMm != null || updates.larguraMm != null) {
    const mm = Number(updates.paperMm ?? updates.larguraMm);
    if (mm === 58 || mm === 80) {
      const { paperMmToCols } = require("./thermalCols");
      vals.colunas = String(paperMmToCols(mm));
      envPatch.PRINTER_COLUNAS = vals.colunas;
      envPatch.PRINTER_PAPER_MM = String(mm);
    }
  }
  if (updates.encoding) {
    envPatch.PRINTER_ENCODING = updates.encoding === "UTF8" ? "UTF8" : "CP860";
    vals.pageCode = updates.encoding === "UTF8" ? "65001" : "2";
  }
  if (updates.cut) {
    envPatch.PRINTER_CUT = updates.cut;
    vals.cut = updates.cut;
  }
  if (updates.tipo) envPatch.PRINTER_TYPE = updates.tipo;
  if (updates.serial && typeof updates.serial === "object") {
    if (updates.serial.baud != null) vals.baud = String(updates.serial.baud);
    if (updates.serial.parity != null) vals.parity = String(updates.serial.parity);
    if (updates.serial.stopBits != null) vals.stopBits = String(updates.serial.stopBits);
    if (updates.serial.handshake != null) vals.handshake = String(updates.serial.handshake);
    if (updates.serial.timeout != null) vals.timeout = String(updates.serial.timeout);
  }
  if (updates.nomeImpressora) {
    envPatch.PRINTER_NAME = String(updates.nomeImpressora);
    if (updates.modelo == null && updates.modeloAuto !== false) {
      vals.modelo = inferirModeloAcbr(updates.nomeImpressora, "", { ignoreEnv: true });
      envPatch.PRINTER_MODEL = vals.modelo;
    }
  }

  // Modelo genérico "0" + RAW/POS80 → Epson-compatível (1)
  if (
    updates.modeloAuto !== false &&
    (String(vals.modelo) === "0" || String(vals.modelo).toLowerCase() === "auto")
  ) {
    const fromRaw = /^RAW:(.+)$/i.exec(String(vals.porta || ""));
    const nomeHint =
      fromRaw?.[1]?.trim() ||
      updates.nomeImpressora ||
      process.env.PRINTER_NAME ||
      "";
    if (nomeHint) {
      const inferred = inferirModeloAcbr(nomeHint, "", { ignoreEnv: true });
      if (inferred && inferred !== "0") {
        vals.modelo = inferred;
        envPatch.PRINTER_MODEL = inferred;
      }
    }
  }

  if (!vals.porta || vals.porta === "USB") {
    const inferida = inferirPortaAcbr({
      nomeWindows: updates.nomeImpressora,
      portaWindows: updates.portaWindows,
    });
    if (inferida && inferida !== "USB" && portaAcbrValida(inferida)) {
      vals.porta = inferida;
      envPatch.PRINTER_PORTA = vals.porta;
      const tcp = parsePortaTcp(vals.porta);
      if (tcp) {
        envPatch.PRINTER_HOST = tcp.host;
        envPatch.PRINTER_PORT = String(tcp.port);
      }
    }
  }

  return { vals, envPatch };
}

function envPatchSemMudanca(envPatch) {
  for (const [key, val] of Object.entries(envPatch)) {
    if (key === "ACBR_POSPRINTER_INI") {
      const a = String(process.env[key] || "").replace(/\\\\/g, "\\").trim();
      const b = String(val ?? "").replace(/\\\\/g, "\\").trim();
      if (
        path.normalize(a).toLowerCase() !== path.normalize(b).toLowerCase()
      ) {
        return false;
      }
      continue;
    }
    if (!eqStr(process.env[key], val)) return false;
  }
  return true;
}

function iniSemMudanca(valsBefore, vals) {
  return (
    eqStr(valsBefore.porta, vals.porta) &&
    eqStr(valsBefore.modelo, vals.modelo) &&
    eqStr(valsBefore.colunas, vals.colunas) &&
    eqStr(valsBefore.cut, vals.cut) &&
    eqStr(valsBefore.pageCode, vals.pageCode) &&
    eqStr(valsBefore.baud, vals.baud) &&
    eqStr(valsBefore.parity, vals.parity) &&
    eqStr(valsBefore.stopBits, vals.stopBits) &&
    eqStr(valsBefore.handshake, vals.handshake) &&
    eqStr(valsBefore.timeout, vals.timeout)
  );
}

function afterConfigChanged() {
  try {
    require("./factory").resetPrintProvider();
  } catch (_) {}
  try {
    require("../printerService").invalidateProbeCache?.();
  } catch (_) {}
  try {
    require("./escpos/impressoraCore").invalidateDiscoveryCache?.();
  } catch (_) {}
  // Porta/modelo salvos → reabrir circuito e limpar fallback (próximo cupom tenta ACBr limpo)
  try {
    require("./acbrPosPrinterRuntime").resetAcbrPosCircuit();
  } catch (_) {}
  try {
    require("./acbrPosWorkerPool").clearFallbackInProcess();
  } catch (_) {}
  try {
    void require("./acbrPosPrinterRuntime").invalidatePosPrinterSession();
  } catch (_) {}
}

/**
 * Boot / pós-save: remove porta de teste inválida e alinha .env com o INI (SSOT).
 * Ex.: TCP:192168150:9100 → limpa; RAW válido → zera PRINTER_HOST fantasma.
 */
function sanitizarConfigPersistida() {
  const { portaAcbrValida, parsePortaTcp, normalizarPortaAcbr, isValidTcpHost } = require("./printerModelMap");
  const iniPath = resolveIniPath();
  const ini = lerIniValores(iniPath);
  const portaOriginal = String(ini.porta || "").trim();
  let porta = portaOriginal;
  const envPatch = {};
  let mudouIni = false;

  if (porta && !portaAcbrValida(porta)) {
    // TCP inválido (ex.: 192168150) NÃO vira RAW via PRINTER_NAME — era teste/erro.
    const wasTcp = /^TCP:/i.test(porta);
    const tentativa = wasTcp
      ? ""
      : normalizarPortaAcbr(porta, {
          nomeWindows: process.env.PRINTER_NAME,
        });
    if (tentativa && portaAcbrValida(tentativa)) {
      log.warn(
        { de: porta, para: tentativa, metric: "print.config_sanitize_normalized" },
        "[PrinterLocalConfig] Porta inválida normalizada",
      );
      porta = tentativa;
      ini.porta = porta;
      mudouIni = true;
    } else {
      log.warn(
        { porta, metric: "print.config_sanitize_cleared" },
        "[PrinterLocalConfig] Porta de teste/inválida removida — configure de novo no painel",
      );
      porta = "";
      ini.porta = "";
      mudouIni = true;
      envPatch.PRINTER_PORTA = "";
      envPatch.PRINTER_HOST = "";
    }
  }

  if (portaAcbrValida(porta)) {
    envPatch.PRINTER_PORTA = porta;
    const tcp = parsePortaTcp(porta);
    if (tcp) {
      envPatch.PRINTER_HOST = tcp.host;
      envPatch.PRINTER_PORT = String(tcp.port);
      envPatch.PRINTER_TYPE = "network";
    } else if (/^RAW:/i.test(porta)) {
      const nome = porta.replace(/^RAW:/i, "").trim();
      if (nome) envPatch.PRINTER_NAME = nome;
      envPatch.PRINTER_HOST = "";
      envPatch.PRINTER_TYPE = "windows";
    } else if (/^COM\d/i.test(porta)) {
      envPatch.PRINTER_HOST = "";
      envPatch.PRINTER_TYPE = "serial";
    }
  } else {
    const host = String(process.env.PRINTER_HOST || "").trim();
    if (host && !isValidTcpHost(host)) {
      envPatch.PRINTER_HOST = "";
      log.warn(
        { host, metric: "print.config_sanitize_bad_host" },
        "[PrinterLocalConfig] PRINTER_HOST inválido limpo",
      );
    }
  }

  // Garante .env com caminho ProgramData (após migrate de resolveIniPath).
  if (iniPath) {
    const curNorm = String(process.env.ACBR_POSPRINTER_INI || "")
      .replace(/\\\\/g, "\\")
      .trim();
    if (
      path.normalize(curNorm).toLowerCase() !==
      path.normalize(iniPath).toLowerCase()
    ) {
      // .env Windows: barras escapadas; process.env fica com path real.
      envPatch.ACBR_POSPRINTER_INI = String(iniPath).replace(/\\/g, "\\\\");
    }
  }

  // Regrava INI com defaults de produção (LogNivel=0, BytesCount, ControlePorta RAW)
  // sempre que o conteúdo canônico divergir — corrige installs antigos com LogNivel=4.
  const valsForIni = { ...ini, porta: porta || ini.porta || "" };
  const nextIni = gerarIniContent(valsForIni);
  let prevIni = "";
  try {
    if (fs.existsSync(iniPath)) prevIni = fs.readFileSync(iniPath, "utf8");
  } catch (_) {}
  if (nextIni !== prevIni) {
    invalidateLerCache();
    writeFileAtomic(iniPath, nextIni);
    mudouIni = true;
    log.info(
      { metric: "print.config_ini_production_defaults" },
      "[PrinterLocalConfig] INI PosPrinter alinhado (log off + BytesCount + ControlePorta)",
    );
  } else if (mudouIni) {
    invalidateLerCache();
    writeFileAtomic(iniPath, nextIni);
  }
  if (Object.keys(envPatch).length && !envPatchSemMudanca(envPatch)) {
    patchEnv(envPatch);
    // Paths no .env usam \\ ; process.env deve permanecer path real (resolveIniPath).
    if (envPatch.ACBR_POSPRINTER_INI && iniPath) {
      process.env.ACBR_POSPRINTER_INI = iniPath;
    }
  }

  try {
    const stations = require("./printerStationRoutes");
    const routes = stations.ler();
    let dirty = false;
    const next = { byPrintType: { ...routes.byPrintType } };
    for (const [k, v] of Object.entries(next.byPrintType)) {
      if (!v) continue;
      if (!portaAcbrValida(v)) {
        next.byPrintType[k] = "";
        dirty = true;
      }
    }
    if (dirty) stations.salvar(next);
  } catch (_) {}

  invalidateLerCache();
  return ler({ fresh: true });
}

function salvar(updates) {
  if (!updates || typeof updates !== "object") throw new Error("Payload inválido");

  const iniPath = resolveIniPath();
  const valsBefore = lerIniValores(iniPath);
  const { vals, envPatch } = projetarSalvar(updates, valsBefore);

  // Poll/detect repetido: não regravar INI/.env nem resetPrintProvider.
  if (iniSemMudanca(valsBefore, vals) && envPatchSemMudanca(envPatch)) {
    log.debug(
      { porta: vals.porta, modelo: vals.modelo },
      "[PrinterLocalConfig] Sem mudança — skip save/reset",
    );
    return Object.assign(ler({ fresh: true }), { unchanged: true });
  }

  invalidateLerCache();
  writeFileAtomic(iniPath, gerarIniContent(vals));
  if (Object.keys(envPatch).length) patchEnv(envPatch);

  afterConfigChanged();

  log.info(
    { porta: vals.porta, modelo: vals.modelo, paperMm: paperMmFromColunas(vals.colunas) },
    "[PrinterLocalConfig] Configuração salva",
  );
  return Object.assign(ler({ fresh: true }), { unchanged: false });
}

function salvarSemPorta(updates) {
  if (!updates || typeof updates !== "object") throw new Error("Payload inválido");

  const envPatch = {
    PRINTER_PROVIDER: String(updates.provider || "acbr-posprinter"),
    PRINTER_TYPE: "auto",
    PRINTER_ENCODING: updates.encoding || "UTF8",
    PRINTER_CUT: updates.cut || "partial",
  };
  if (updates.modelo != null) envPatch.PRINTER_MODEL = String(updates.modelo);

  const iniPath = resolveIniPath();
  const before = lerIniValores(iniPath);
  const vals = {
    ...before,
    modelo: updates.modelo != null ? String(updates.modelo) : before.modelo || "0",
    porta: "",
    cut: updates.cut || before.cut || "partial",
    pageCode: updates.encoding === "UTF8" ? "65001" : before.pageCode || "2",
  };

  if (iniSemMudanca(before, vals) && envPatchSemMudanca(envPatch)) {
    log.debug("[PrinterLocalConfig] Instalador — sem mudança (porta vazia)");
    return Object.assign(ler({ fresh: true }), { unchanged: true });
  }

  invalidateLerCache();
  writeFileAtomic(iniPath, gerarIniContent(vals));
  patchEnv(envPatch);
  afterConfigChanged();

  log.info("[PrinterLocalConfig] Instalador — aguardando auto-detecção de porta");
  return Object.assign(ler({ fresh: true }), { unchanged: false });
}

function sincronizarDeDeteccao(info) {
  if (!info?.impressora) return Object.assign(ler(), { unchanged: true });
  const imp = info.impressora;
  const nome = imp.nome || imp.name || "";
  // Não gravar jato/laser como porta térmica — reinfecta config e derruba o agente.
  try {
    const core = require("./escpos/impressoraCore");
    if (typeof core.pareceNaoTermica === "function" && core.pareceNaoTermica(nome)) {
      log.warn(
        { nome },
        "[PrinterLocalConfig] Ignorando auto-detecção de impressora não térmica",
      );
      return Object.assign(ler(), { unchanged: true });
    }
  } catch (_) {}
  const payload = {
    nomeImpressora: nome,
    modelo: inferirModeloAcbr(nome, imp.driver || imp.driverName),
    modeloAuto: true,
    portaWindows: imp.porta || imp.port,
  };
  if (imp.metodo === "network" && imp.host) {
    payload.porta = `TCP:${imp.host}:${imp.porta || imp.port || process.env.PRINTER_PORT || "9100"}`;
    payload.tipo = "network";
  } else if (imp.metodo === "windows" && nome) {
    payload.porta = `RAW:${nome}`;
    payload.tipo = "windows";
  } else if (imp.porta) {
    payload.porta = imp.porta;
  }
  return salvar(payload);
}

module.exports = {
  ler,
  salvar,
  salvarSemPorta,
  sincronizarDeDeteccao,
  gerarIniContent,
  patchEnvPublic,
  resolveIniPath,
  resolveEnvPath,
  invalidateLerCache,
  writeFileAtomic,
  paperMmFromColunas,
  projetarSalvar,
  sanitizarConfigPersistida,
};

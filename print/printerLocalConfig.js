/**
 * Configuração local da impressora — INI completo + .env.
 */
const fs = require("fs");
const path = require("path");
const log = require("../logger").child({ modulo: "printer_local_config" });
const runtime = require("./acbrPosPrinterRuntime");
const { inferirModeloAcbr, inferirPortaAcbr, normalizarPortaAcbr, parsePortaTcp } = require("./printerModelMap");

const AGENT_ROOT = path.resolve(__dirname, "..");

function escapeReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveIniPath() {
  return runtime.resolveIniPath();
}

function resolveEnvPath() {
  if (process.env.PRINTER_LOCAL_ENV_OVERRIDE) {
    return process.env.PRINTER_LOCAL_ENV_OVERRIDE;
  }
  return path.join(AGENT_ROOT, ".env");
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
    timeout: "3",
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
  const isSerial = /^COM\d/i.test(String(vals.porta || ""));
  const deviceBlock = isSerial
    ? `
[PosPrinter_Device]
Baud=${vals.baud || process.env.PRINTER_SERIAL_BAUD || "9600"}
Parity=${vals.parity || process.env.PRINTER_SERIAL_PARITY || "0"}
Stop=${vals.stopBits || process.env.PRINTER_SERIAL_STOP || "0"}
HandShake=${vals.handshake || process.env.PRINTER_SERIAL_HANDSHAKE || "0"}
TimeOut=${vals.timeout || process.env.PRINTER_SERIAL_TIMEOUT || "3"}
SoftFlow=${process.env.PRINTER_SERIAL_SOFTFLOW || "0"}
HardFlow=${process.env.PRINTER_SERIAL_HARDFLOW || "0"}
`
    : "";

  const logo = (() => {
    try {
      const meta = require("./printerLogo").ler();
      if (!meta.ativo) return "";
      return `
[PosPrinter_Logo]
IgnorarLogo=0
KeyCode=${meta.kc1 || "48"}
KeyCode2=${meta.kc2 || "49"}
FatorX=${meta.fatorX || "1"}
FatorY=${meta.fatorY || "1"}
`;
    } catch (_) {
      return "";
    }
  })();

  return `[Principal]
LogNivel=4
LogPath=${logPath}

[PosPrinter]
Modelo=${vals.modelo || "0"}
Porta=${vals.porta || ""}
PaginaDeCodigo=${vals.pageCode || "2"}
ColunasFonteNormal=${vals.colunas || "48"}
CortaPapel=${vals.cut === "total" ? "0" : "1"}
TraduzirTags=1
IgnorarTags=0
LinhasBuffer=${process.env.PRINTER_BUFFER_LINES || "0"}
ControlePorta=1
VerificarImpressora=0
GavetaSinalInvertido=${process.env.PRINTER_DRAWER_INVERTED === "true" ? "1" : "0"}
GavetaTempoON=${process.env.PRINTER_DRAWER_ON_MS || "120"}
GavetaTempoOFF=${process.env.PRINTER_DRAWER_OFF_MS || "240"}
${deviceBlock}${logo}`;
}

function patchEnv(map) {
  const envPath = resolveEnvPath();
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  for (const [key, val] of Object.entries(map)) {
    const re = new RegExp(`^${escapeReg(key)}=.*$`, "m");
    const line = `${key}=${val ?? ""}`;
    content = re.test(content) ? content.replace(re, line) : `${content.replace(/\s*$/, "")}\n${line}\n`;
  }
  fs.writeFileSync(envPath, content, "utf8");
  for (const [key, val] of Object.entries(map)) {
    process.env[key] = String(val ?? "");
  }
}

function patchEnvPublic(map) {
  return patchEnv(map);
}

function ler() {
  const iniPath = resolveIniPath();
  const ini = lerIniValores(iniPath);
  let logo = null;
  try {
    logo = require("./printerLogo").ler();
  } catch (_) {}
  return {
    provider: process.env.PRINTER_PROVIDER || "acbr-posprinter",
    fallback: process.env.PRINTER_FALLBACK || "native",
    tipo: process.env.PRINTER_TYPE || "auto",
    encoding: process.env.PRINTER_ENCODING || "UTF8",
    cut: process.env.PRINTER_CUT || ini.cut || "partial",
    drawer: (process.env.PRINTER_DRAWER || "true").toLowerCase() !== "false",
    modelo: ini.modelo,
    porta: ini.porta,
    colunas: ini.colunas,
    serial: {
      baud: ini.baud,
      parity: ini.parity,
      stopBits: ini.stopBits,
      handshake: ini.handshake,
      timeout: ini.timeout,
    },
    logo,
    libPath: runtime.resolveLibPath(),
    iniPath,
    iniExiste: !!(iniPath && fs.existsSync(iniPath)),
    nativeReady: runtime.canLoadNativeLib(),
    mode: runtime.canLoadNativeLib()
      ? "native"
      : process.env.PRINTER_ALLOW_PARITY === "true"
        ? "parity"
        : "unconfigured",
  };
}

function salvar(updates) {
  if (!updates || typeof updates !== "object") throw new Error("Payload inválido");

  const envPatch = {};
  const iniPath = resolveIniPath();
  fs.mkdirSync(path.dirname(iniPath), { recursive: true });

  let vals = lerIniValores(iniPath);

  if (updates.provider) envPatch.PRINTER_PROVIDER = String(updates.provider);
  if (updates.porta != null && String(updates.porta).trim() !== "") {
    vals.porta = normalizarPortaAcbr(String(updates.porta), {
      host: updates.host,
      port: updates.portaNum,
      nomeWindows: updates.nomeImpressora,
    });
    envPatch.PRINTER_PORTA = vals.porta;
    const tcp = parsePortaTcp(vals.porta);
    if (tcp) {
      envPatch.PRINTER_HOST = tcp.host;
      envPatch.PRINTER_PORT = String(tcp.port);
    } else if (/^RAW:/i.test(vals.porta)) {
      envPatch.PRINTER_HOST = "";
      envPatch.PRINTER_TYPE = updates.tipo || "windows";
    }
  }
  if (updates.modelo != null) {
    vals.modelo = String(updates.modelo);
    envPatch.PRINTER_MODEL = vals.modelo;
  }
  if (updates.colunas != null) {
    vals.colunas = String(updates.colunas);
    envPatch.PRINTER_COLUNAS = vals.colunas;
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
    if (!updates.modelo && updates.modeloAuto !== false) {
      vals.modelo = inferirModeloAcbr(updates.nomeImpressora, "");
      envPatch.PRINTER_MODEL = vals.modelo;
    }
  }

  if (!vals.porta || vals.porta === "USB") {
    const inferida = inferirPortaAcbr({
      nomeWindows: updates.nomeImpressora,
      portaWindows: updates.portaWindows,
    });
    if (inferida && inferida !== "USB") {
      vals.porta = inferida;
      envPatch.PRINTER_PORTA = vals.porta;
      const tcp = parsePortaTcp(vals.porta);
      if (tcp) {
        envPatch.PRINTER_HOST = tcp.host;
        envPatch.PRINTER_PORT = String(tcp.port);
      }
    }
  }

  fs.writeFileSync(iniPath, gerarIniContent(vals), "utf8");
  if (Object.keys(envPatch).length) patchEnv(envPatch);

  try {
    require("./factory").resetPrintProvider();
  } catch (_) {}

  log.info({ porta: vals.porta, modelo: vals.modelo }, "[PrinterLocalConfig] Configuração salva");
  return ler();
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
  fs.mkdirSync(path.dirname(iniPath), { recursive: true });
  const vals = {
    ...lerIniValores(iniPath),
    modelo: updates.modelo != null ? String(updates.modelo) : "0",
    porta: "",
    cut: updates.cut || "partial",
    pageCode: updates.encoding === "UTF8" ? "65001" : "2",
  };
  fs.writeFileSync(iniPath, gerarIniContent(vals), "utf8");
  patchEnv(envPatch);

  try {
    require("./factory").resetPrintProvider();
  } catch (_) {}

  log.info("[PrinterLocalConfig] Instalador — aguardando auto-detecção de porta");
  return ler();
}

function sincronizarDeDeteccao(info) {
  if (!info?.impressora) return ler();
  const imp = info.impressora;
  const payload = {
    nomeImpressora: imp.nome || imp.name,
    modelo: inferirModeloAcbr(imp.nome || imp.name, imp.driver || imp.driverName),
    modeloAuto: true,
    portaWindows: imp.porta || imp.port,
  };
  if (imp.metodo === "network" && imp.host) {
    payload.porta = `TCP:${imp.host}:${imp.porta || imp.port || process.env.PRINTER_PORT || "9100"}`;
    payload.tipo = "network";
  } else if (imp.metodo === "windows" && (imp.nome || imp.name)) {
    payload.porta = `RAW:${imp.nome || imp.name}`;
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
  resolveIniPath,
  patchEnvPublic,
};

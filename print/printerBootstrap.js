/**
 * Bootstrap ACBr PosPrinter — detecção automática e configuração pós-instalação.
 */
const log = require("../logger").child({ modulo: "printer_bootstrap" });
const { parsePortaTcp, normalizarPortaAcbr } = require("./printerModelMap");

function portaEfetivaPrecisaDeteccao(porta) {
  const p = String(porta || "").trim();
  if (!p || /^USB$/i.test(p)) return true;
  if (/^TCP:/i.test(p) || /^RAW:/i.test(p) || /^COM\d/i.test(p)) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}/.test(p)) return false;
  return true;
}

function hostConfiguradoAcessivelSync() {
  const host = (process.env.PRINTER_HOST || "").trim();
  if (!host) return false;
  const port = Number(process.env.PRINTER_PORT) || 9100;
  const portaIni = process.env.PRINTER_PORTA || "";
  const tcp = parsePortaTcp(portaIni);
  if (tcp && tcp.host === host && tcp.port === port) return true;
  return !portaEfetivaPrecisaDeteccao(portaIni);
}

function precisaAutoDetectar(opts = {}) {
  if (opts.force) return true;
  const tipo = String(process.env.PRINTER_TYPE || "auto").toLowerCase();
  if (tipo !== "auto" && tipo !== "network") return false;

  try {
    const local = require("./printerLocalConfig").ler();
    if (!portaEfetivaPrecisaDeteccao(local.porta)) {
      if (tipo === "auto") return false;
      return tipo === "network" && !process.env.PRINTER_HOST;
    }
  } catch (_) {}

  if (process.env.PRINTER_HOST && hostConfiguradoAcessivelSync()) return false;
  return true;
}

async function autoDetectarESincronizar(opts = {}) {
  const force = opts.force === true;
  if (!precisaAutoDetectar({ force })) {
    return { ok: true, skipped: true, motivo: "porta_ja_configurada" };
  }

  const core = require("./escpos/impressoraCore");
  const info = await core.detectarImpressora(force);
  if (!info?.impressora) {
    log.warn(
      { candidatos: info?.candidatos?.length ?? 0 },
      "[PrinterBootstrap] Nenhuma impressora detectada",
    );
    return { ok: false, info };
  }

  const saved = require("./printerLocalConfig").sincronizarDeDeteccao(info);
  try {
    require("./factory").resetPrintProvider();
  } catch (_) {}

  const imp = info.impressora;
  log.info(
    {
      metodo: imp.metodo,
      nome: imp.nome,
      host: imp.host,
      porta: imp.porta || imp.port,
      acbrPorta: saved.porta,
    },
    "[PrinterBootstrap] Impressora sincronizada",
  );

  return { ok: true, info, config: saved };
}

/**
 * Configuração mínima pós-instalador — sem forçar USB; detecção em seguida se solicitada.
 */
function aplicarConfigInstalador(cfg = {}) {
  const printerLocalConfig = require("./printerLocalConfig");
  const portaInformada = String(cfg.porta || "").trim();
  const payload = {
    provider: cfg.provider || "acbr-posprinter",
    tipo: "auto",
    encoding: cfg.encoding || "UTF8",
    cut: cfg.cut || "partial",
    modelo: cfg.modelo != null ? String(cfg.modelo) : "0",
    nomeImpressora: cfg.nomeImpressora || "",
  };

  const envPatch = {
    PRINTER_PROVIDER: payload.provider,
    PRINTER_FALLBACK: cfg.fallback || "native",
    PRINTER_TYPE: "auto",
    PRINTER_ENCODING: payload.encoding,
    PRINTER_CUT: payload.cut,
    PRINTER_HOST: "",
    PRINTER_PORT: "9100",
  };

  if (cfg.libPath) {
    envPatch.ACBR_POSPRINTER_LIB_PATH = String(cfg.libPath).replace(/\\/g, "\\\\");
  }
  if (cfg.iniPath) {
    envPatch.ACBR_POSPRINTER_INI = String(cfg.iniPath).replace(/\\/g, "\\\\");
  }
  if (cfg.modelo != null) envPatch.PRINTER_MODEL = String(cfg.modelo);

  printerLocalConfig.patchEnvPublic(envPatch);

  if (portaInformada) {
    payload.porta = normalizarPortaAcbr(portaInformada, {
      nomeWindows: cfg.nomeImpressora,
    });
    return printerLocalConfig.salvar(payload);
  }

  if (cfg.nomeImpressora) {
    payload.porta = normalizarPortaAcbr(`RAW:${cfg.nomeImpressora}`);
    return printerLocalConfig.salvar(payload);
  }

  return printerLocalConfig.salvarSemPorta(payload);
}

/** Campos de status para /status-basico — evita exibir PRINTER_PORT=9100 em spooler RAW. */
function resolverStatusExibicao(impressoraInfo) {
  let local = null;
  try {
    local = require("./printerLocalConfig").ler();
  } catch (_) {}

  const acbrPorta = String(local?.porta || process.env.PRINTER_PORTA || "").trim();
  const rawMatch = /^RAW:(.+)$/i.exec(acbrPorta);
  const tcp = parsePortaTcp(acbrPorta);
  const imp = impressoraInfo?.impressora || null;

  let metodo = imp?.metodo || null;
  let nome = imp?.nome || process.env.PRINTER_NAME || null;
  let host = imp?.host || null;
  let porta = imp?.porta || imp?.port || null;

  if (rawMatch) {
    metodo = "windows";
    nome = nome || rawMatch[1].trim();
    porta = acbrPorta;
    host = null;
  } else if (tcp) {
    metodo = metodo || "network";
    host = host || tcp.host;
    porta = String(tcp.port);
  } else if (acbrPorta) {
    porta = acbrPorta;
  }

  if (metodo === "windows" && !rawMatch && !tcp) {
    host = null;
    porta = imp?.porta || imp?.port || acbrPorta || null;
  }

  if (!porta && !host && !tcp && !rawMatch) {
    const envPort = process.env.PRINTER_PORT;
    if (envPort && (metodo === "network" || process.env.PRINTER_HOST)) {
      porta = envPort;
    }
  }

  return {
    metodo,
    nome,
    host,
    porta,
    acbrPorta: acbrPorta || null,
    detectada: imp || nome,
  };
}

function noBoot(delayMs = 2500) {
  const tipo = String(process.env.PRINTER_PROVIDER || "acbr-posprinter").toLowerCase();
  if (!tipo.includes("acbr") && tipo !== "posprinter") return Promise.resolve();

  return new Promise((resolve) => {
    setTimeout(async () => {
      try {
        const r = await autoDetectarESincronizar();
        if (r.ok && !r.skipped) {
          const impressora = require("../printerService");
          const ok = await impressora.testar(true).catch(() => false);
          log.info({ teste: ok, porta: r.config?.porta }, "[PrinterBootstrap] Pós-boot");
        }
      } catch (err) {
        log.warn({ err: err.message }, "[PrinterBootstrap] Falha no pós-boot");
      }
      resolve();
    }, delayMs);
  });
}

module.exports = {
  portaEfetivaPrecisaDeteccao,
  precisaAutoDetectar,
  autoDetectarESincronizar,
  aplicarConfigInstalador,
  resolverStatusExibicao,
  noBoot,
};

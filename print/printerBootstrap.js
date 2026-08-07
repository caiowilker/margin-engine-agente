/**
 * Bootstrap ACBr PosPrinter — detecção automática e configuração pós-instalação.
 */
const log = require("../logger").child({ modulo: "printer_bootstrap" });
const { parsePortaTcp, normalizarPortaAcbr } = require("./printerModelMap");

function portaEfetivaPrecisaDeteccao(porta) {
  const { portaAcbrValida } = require("./printerModelMap");
  return !portaAcbrValida(porta);
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
  const detectar =
    typeof core.detectarImpressora === "function"
      ? core.detectarImpressora
      : typeof core.detectar === "function"
        ? (force) => core.detectar(force)
        : null;
  if (!detectar) {
    log.warn("[PrinterBootstrap] impressoraCore sem detectarImpressora — skip auto-detecção");
    return { ok: false, skipped: true, motivo: "detectar_indisponivel" };
  }
  const info = await detectar(force);
  if (!info?.impressora) {
    log.warn(
      { candidatos: info?.candidatos?.length ?? 0 },
      "[PrinterBootstrap] Nenhuma impressora detectada",
    );
    return { ok: false, info };
  }

  const saved = require("./printerLocalConfig").sincronizarDeDeteccao(info);
  // Idempotente: não resetar provider se porta/modelo já iguais (evita thrash).
  if (!saved?.unchanged) {
    try {
      require("./factory").resetPrintProvider();
    } catch (_) {}
  }

  const imp = info.impressora;
  log.info(
    {
      metodo: imp.metodo,
      nome: imp.nome,
      host: imp.host,
      porta: imp.porta || imp.port,
      acbrPorta: saved.porta,
      unchanged: !!saved?.unchanged,
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

/** Porta RAW/TCP válida persistida (INI ProgramData / legacy). */
function portaPersistidaValida() {
  try {
    const { portaAcbrValida } = require("./printerModelMap");
    const local = require("./printerLocalConfig").ler();
    return portaAcbrValida(local?.porta);
  } catch (_) {
    return false;
  }
}

/**
 * Conectividade para UI/poll (Win10 sólido).
 * Get-Printer/spooler lento NÃO pode marcar offline se a porta SSOT está salva —
 * impressão RAW/TCP não depende da listagem do PrintManagement.
 *
 * @param {{ probeOk?: boolean|null, printBusy?: boolean, recente?: boolean, timedOut?: boolean, skipped?: boolean }} opts
 */
function resolverConectada(opts = {}) {
  const probeOk = opts.probeOk;
  const printBusy = opts.printBusy === true;
  const recente = opts.recente === true;
  const timedOut = opts.timedOut === true;
  const skipped = opts.skipped === true;

  if (recente || printBusy) {
    return { conectada: true, fonte: recente ? "recente" : "busy" };
  }
  if (probeOk === true) {
    return { conectada: true, fonte: "probe" };
  }

  if (portaPersistidaValida()) {
    return {
      conectada: true,
      fonte: "configurada",
      assumida: true,
      timedOut,
      skipped,
      probeOk: probeOk === false ? false : probeOk,
    };
  }

  if (probeOk === false) {
    return { conectada: false, fonte: "probe" };
  }
  return { conectada: null, fonte: "desconhecida", timedOut, skipped };
}

/**
 * Garante porta ACBr válida antes de qualquer impressão física.
 * Tenta auto-detecção quando INI/.env estão vazios ou inválidos.
 */
async function garantirPortaImpressao(opts = {}) {
  const { portaAcbrValida } = require("./printerModelMap");
  const printerLocalConfig = require("./printerLocalConfig");

  let cfg = printerLocalConfig.ler();
  if (portaAcbrValida(cfg.porta)) {
    return { ok: true, porta: cfg.porta, detectado: false };
  }

  const precisaDetectar = opts.forceDetect === true || opts.force === true || !portaAcbrValida(cfg.porta);
  if (precisaDetectar && opts.skipDetect !== true) {
    await autoDetectarESincronizar({ force: opts.force === true || opts.forceDetect === true });
    cfg = printerLocalConfig.ler();
    if (portaAcbrValida(cfg.porta)) {
      return { ok: true, porta: cfg.porta, detectado: true };
    }
  }

  const err = new Error(
    "Porta da impressora não configurada — use Detectar no painel :9100 e depois Imprimir teste.",
  );
  err.code = "PRINTER_PORTA_INDEFINIDA";
  throw err;
}

function noBoot(delayMs = 2500) {
  return new Promise((resolve) => {
    // Warm hot-path no boot (orçamento curto) — DLL + raster logo em background.
    // NÃO bloqueia detecção; NÃO usa Image.load no caminho do cupom.
    setImmediate(async () => {
      const core = require("./escpos/impressoraCore");
      const tWarm = performance.now();
      try {
        const warmOk = await core.warmPrintHotPath();
        const warmMs = performance.now() - tWarm;
        global.__printWarmState = { ok: !!warmOk, ms: Math.round(warmMs), at: Date.now() };
        if (warmMs > 1000) {
          log.warn(
            { warmMs, metric: "print.warm_slow" },
            "[PrinterBootstrap] Print hot-path warm foi lento",
          );
        } else {
          log.debug(
            { warmMs, ok: warmOk, metric: "print.warm_ok" },
            "[PrinterBootstrap] Print hot-path aquecido",
          );
        }
      } catch (err) {
        global.__printWarmState = { ok: false, ms: null, at: Date.now(), err: err?.message };
        log.warn(
          { err: err?.message, metric: "print.warm_failed" },
          "[PrinterBootstrap] Falha ao aquecer print hot-path",
        );
      }
    });

    // Continue with auto-detection after delay
    setTimeout(async () => {
      const tipo = String(process.env.PRINTER_PROVIDER || "acbr-posprinter").toLowerCase();
      if (!tipo.includes("acbr") && tipo !== "posprinter") {
        resolve();
        return;
      }

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
  garantirPortaImpressao,
  aplicarConfigInstalador,
  resolverStatusExibicao,
  portaPersistidaValida,
  resolverConectada,
  noBoot,
};

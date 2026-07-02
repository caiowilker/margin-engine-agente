/**
 * Coleta dados enterprise para painel diagnóstico — operador e suporte.
 */
const os = require("os");
const fs = require("fs");
const path = require("path");

let _cpuSample = { at: Date.now(), usage: process.cpuUsage() };

function formatUptime(seconds) {
  const s = Math.floor(Number(seconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}min`;
  if (m > 0) return `${m} min`;
  return `${s}s`;
}

function sanitizarPath(p) {
  const { sanitizePathForDisplay } = require("./runtime/windowsEnv");
  return sanitizePathForDisplay(p);
}

function formatarEventoEmissao(row) {
  if (!row) return null;
  if (typeof row === "string") return row;
  const quando = row.atualizado_em || row.criado_em || null;
  const venda = row.numero_venda ? `venda ${row.numero_venda}` : null;
  const status = row.status ? String(row.status) : null;
  const erro = row.erro ? String(row.erro).slice(0, 120) : null;
  const partes = [quando, venda, status, erro].filter(Boolean);
  return partes.length ? partes.join(" · ") : null;
}

/** Rótulos operacionais — sem nomes de biblioteca na UI */
function nomeDriverProfissional(info) {
  const { nomeDriverProfissional: nome } = require("./runtime/mensagensOperador");
  return nome(info);
}

function nomeDriverFiscal(info) {
  return nomeDriverProfissional(info);
}

function amostrarCpuPercent() {
  const now = Date.now();
  const cur = process.cpuUsage();
  const dt = (now - _cpuSample.at) / 1000;
  const du = (cur.user - _cpuSample.usage.user) / 1e6;
  const ds = (cur.system - _cpuSample.usage.system) / 1e6;
  _cpuSample = { at: now, usage: cur };
  if (dt <= 0) return null;
  return Math.min(100, Math.round(((du + ds) / dt) * 100));
}

function coletarInfoBackup() {
  try {
    const { getDirectoryManager } = require("./runtime/directoryManager");
    const paths = getDirectoryManager().PATHS;
    const candidatos = [paths.fiscalBackup, paths.agentData, paths.fila].filter(Boolean);
    let ultimo = null;
    let ultimaCompactacao = null;

    for (const dir of candidatos) {
      if (!dir || !fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        if (!ultimo || st.mtimeMs > ultimo.mtimeMs) {
          ultimo = {
            arquivo: sanitizarPath(full),
            tamanho: st.size,
            quando: new Date(st.mtimeMs).toISOString(),
            tipo: ent.isDirectory() ? "pasta" : "arquivo",
          };
        }
      }
    }

    const logsDir = paths.logs;
    if (logsDir && fs.existsSync(logsDir)) {
      for (const ent of fs.readdirSync(logsDir)) {
        if (!/\.gz$/i.test(ent)) continue;
        const full = path.join(logsDir, ent);
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        if (!ultimaCompactacao || st.mtimeMs > new Date(ultimaCompactacao).getTime()) {
          ultimaCompactacao = new Date(st.mtimeMs).toISOString();
        }
      }
    }

    return { ultimo, ultimaCompactacao };
  } catch {
    return { ultimo: null, ultimaCompactacao: null };
  }
}

function calcularStatusGeralEnterprise(ctx) {
  if (ctx.atualizando) return "ATUALIZANDO";
  if (ctx.contingenciaAtiva) return "CONTINGÊNCIA";
  if (ctx.recuperando > 0 || ctx.incertos > 0) return "RECUPERANDO";
  if (ctx.acbr === "offline" || ctx.bancoOk === false || ctx.manifestOk === false) {
    return "OFFLINE";
  }
  if (
    ctx.acbr === "degradado" ||
    ctx.incertosComBackoff > 0 ||
    ctx.discoCritico ||
    ctx.impressoraOk === false
  ) {
    return "DEGRADADO";
  }
  return "ONLINE";
}

function coletarContextoEnterprise(deps) {
  const wd = deps.watchdog.statusWatchdog();
  const alertas = deps.filaFiscal.contadoresAlertas();
  const filaSt = deps.filaFiscal.status();
  const acbrDet = deps.acbr.obterStatusDetalhe(wd.degraded);
  const espacoDisco = deps.fiscalStorage.statusDiscoPorTipo();
  const discoCritico = ["xml", "pdf", "backup"].some(
    (k) => espacoDisco[k]?.status === "critico",
  );

  let banco = { ok: false, tamanho: 0, path: deps.dbPath || null, integridade: "desconhecida" };
  if (deps.db && deps.dbPath && fs.existsSync(deps.dbPath)) {
    try {
      deps.db.prepare("PRAGMA quick_check").get();
      banco.ok = true;
      banco.integridade = "ok";
      banco.tamanho = fs.statSync(deps.dbPath).size;
    } catch (err) {
      banco.integridade = err.message?.slice(0, 80) || "erro";
    }
  }

  const backupInfo = deps.backup || coletarInfoBackup();

  let impressora = {
    ok: false,
    modelo: null,
    porta: null,
    driver: null,
    estado: "desconhecido",
    ultimaImpressao: null,
    tempoMs: null,
  };
  try {
    const pb = require("./print/printerBootstrap");
    const factory = require("./print/factory");
    const info = deps.impressoraInfo;
    const st = pb.resolverStatusExibicao(info);
    const driverInfo = factory.getDriverInfo?.() || {};
    const ultima = info?.ultimaUsada || info?.ultimaImpressao || null;
    impressora = {
      ok: deps.impressoraOk === true,
      modelo: st.nome || (typeof st.detectada === "object" ? st.detectada?.nome : st.detectada) || null,
      porta: st.porta || st.acbrPorta || null,
      driver: driverInfo.provider || st.metodo || null,
      estado:
        deps.impressoraOk === true
          ? "online"
          : deps.impressoraOk === false
            ? "offline"
            : "desconhecido",
      ultimaImpressao: ultima
        ? typeof ultima === "object"
          ? ultima.quando || ultima.em || JSON.stringify(ultima).slice(0, 80)
          : String(ultima)
        : null,
      tempoMs: ultima?.durationMs ?? ultima?.tempoMs ?? null,
    };
  } catch (_) {
    /* impressora opcional em testes */
  }

  const mem = process.memoryUsage();
  const cpuPercent = amostrarCpuPercent();
  const manifestUpdater = deps.manifestUpdater;
  const rollbackOk =
    typeof manifestUpdater?.rollbackDisponivel === "function"
      ? manifestUpdater.rollbackDisponivel()
      : deps.updater?.rollbackDisponivel === true;
  const ultimoBackup =
    typeof manifestUpdater?.ultimoBackupInfo === "function"
      ? manifestUpdater.ultimoBackupInfo()
      : null;

  const servico = {
    instalado: process.platform === "win32",
    rodando: true,
    pid: process.pid,
    versao: deps.versao,
    uptime: formatUptime(process.uptime()),
    memoriaMb: Math.round(mem.heapUsed / 1024 / 1024),
    cpuPercent,
    cpuArch: os.arch(),
    hostname: os.hostname(),
  };

  const libSession =
    typeof deps.acbr.getLibSessionStatus === "function"
      ? deps.acbr.getLibSessionStatus()
      : null;

  const fiscalDriverInfo =
    typeof deps.acbr.getDriverInfo === "function" ? deps.acbr.getDriverInfo() : {};

  const ultimoXmlDoc =
    typeof deps.filaFiscal.ultimoDocumentoXml === "function"
      ? deps.filaFiscal.ultimoDocumentoXml()
      : null;

  const metricas = deps.metricas || {};
  const tempoMedioMs =
    metricas.tempoMedioMs ??
    metricas.latenciaMs?.p50 ??
    metricas.latenciaMs?.p95 ??
    null;

  const ctx = {
    acbr: acbrDet.estado,
    acbrAtualizadoEm: acbrDet.atualizadoEm,
    recuperando: alertas.recuperando || 0,
    incertos: alertas.incertos || 0,
    incertosComBackoff: alertas.incertosComBackoff || 0,
    atualizando: deps.updater?.atualizando === true,
    contingenciaAtiva: deps.contingencia?.ativa === true,
    bancoOk: banco.ok,
    manifestOk: deps.manifestUpdater.isManifestOk(),
    impressoraOk: deps.impressoraOk,
  };

  return {
    statusGeral: calcularStatusGeralEnterprise(ctx),
    timestamp: new Date().toISOString(),
    versao: deps.versao,
    fiscal: {
      driver: nomeDriverProfissional(fiscalDriverInfo),
      driverRaw: fiscalDriverInfo.provider || null,
      mode: fiscalDriverInfo.mode || null,
      emissaoFiscal: deps.acbr.EMISSAO_FISCAL === true,
      ok: acbrDet.estado === "online",
      fallback: fiscalDriverInfo.mode === "parity",
      ultimaEmissao: formatarEventoEmissao(alertas.ultimaEmissao),
      ultimaAutorizacao: formatarEventoEmissao(alertas.ultimaEmissaoSucesso),
      ultimaRejeicao: formatarEventoEmissao(alertas.ultimaRejeicao),
      ultimoXml: ultimoXmlDoc
        ? {
            chave: ultimoXmlDoc.chave || null,
            arquivo: sanitizarPath(ultimoXmlDoc.xml_path),
            quando: ultimoXmlDoc.criado_em || null,
          }
        : null,
      tempoMedioMs,
      sessaoLib: libSession,
    },
    impressora,
    banco: {
      ...banco,
      path: sanitizarPath(banco.path),
      backup: backupInfo.ultimo || null,
      ultimaCompactacao: backupInfo.ultimaCompactacao || null,
    },
    servico,
    atualizador: {
      versaoAtual: deps.versao,
      versaoDisponivel: deps.updater?.versaoDisponivel || null,
      ultimaVerificacao: deps.updater?.ultimaVerificacao || null,
      ultimaAtualizacao: ultimoBackup?.quando || deps.updater?.ultimaAtualizacao || null,
      canal: process.env.UPDATE_CHANNEL || "stable",
      atualizando: deps.updater?.atualizando === true,
      rollbackDisponivel: rollbackOk,
      ultimoErro: deps.updater?.ultimoErro || null,
    },
    fila: {
      pendentes: filaSt.pendentes ?? 0,
      processando: filaSt.processando ?? 0,
      incertos: alertas.incertos ?? 0,
      recuperando: alertas.recuperando ?? 0,
      falhas24h: alertas.falhasUltimas24h ?? 0,
    },
    espacoDisco,
    configSync: deps.configSync?.getStatus?.() || null,
    ultimasEmissoes: deps.filaFiscal.listarUltimasEmissoes(10),
    manifestOk: deps.manifestUpdater.isManifestOk(),
    logs: deps.logs || null,
  };
}

function lerUltimosLogsEnterprise(limit = 20) {
  const { lerUltimosLogsEnterprise: ler } = require("./runtime/logEnterprise");
  return ler(limit);
}

module.exports = {
  coletarContextoEnterprise,
  coletarInfoBackup,
  lerUltimosLogsEnterprise,
  calcularStatusGeralEnterprise,
  sanitizarPath,
  formatUptime,
  nomeDriverFiscal,
  nomeDriverProfissional,
  formatarEventoEmissao,
};

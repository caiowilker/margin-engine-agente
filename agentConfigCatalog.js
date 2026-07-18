// Catálogo de configs operacionais (categoria A) — sincronizáveis via painel.
// Credenciais ACBr, emissão on/off, ambiente e UF são SSOT em fiscalLocalConfig (PUT /config/fiscal).

/** Chaves gerenciadas apenas localmente — não sincronizar via operacional/backend. */
const CHAVES_SSOT_LOCAL = new Set([
  "emissaoFiscal",
  "ambienteSefaz",
  "nfeUf",
]);

/** @typedef {"boolean"|"number"|"string"} ConfigTipo */
/** @typedef {"fiscal"|"disco"|"alertas"|"recovery"|"operacao"|"impressora"} ConfigGrupo */

/**
 * @type {Record<string, {
 *   env: string,
 *   tipo: ConfigTipo,
 *   default: boolean|number|string,
 *   grupo: ConfigGrupo,
 *   label: string,
 *   min?: number,
 *   max?: number,
 *   enum?: string[],
 * }>}
 */
const CATALOGO = {
  acbrNfeEnabled: {
    env: "ACBR_NFE_ENABLED",
    tipo: "boolean",
    default: true,
    grupo: "fiscal",
    label: "NF-e modelo 55 habilitada",
  },
  nfeSerie55: {
    env: "NFE_SERIE_55",
    tipo: "number",
    default: 1,
    min: 1,
    max: 999,
    grupo: "fiscal",
    label: "Série NF-e (modelo 55)",
  },
  nfeCfopPadrao: {
    env: "NFE_CFOP_PADRAO",
    tipo: "string",
    default: "5102",
    enum: ["5102", "5101", "6102", "6101", "5405"],
    grupo: "fiscal",
    label: "CFOP padrão NF-e",
  },
  nfeSerie: {
    env: "NFE_SERIE",
    tipo: "number",
    default: 1,
    min: 1,
    max: 999,
    grupo: "fiscal",
    label: "Série NFC-e (modelo 65)",
  },
  fiscalPreflightRapido: {
    env: "FISCAL_PREFLIGHT_RAPIDO",
    tipo: "boolean",
    default: true,
    grupo: "fiscal",
    label: "Preflight rápido antes de emitir",
  },
  fiscalPreflightTtlMs: {
    env: "FISCAL_PREFLIGHT_TTL_MS",
    tipo: "number",
    default: 90000,
    min: 10000,
    max: 600000,
    grupo: "fiscal",
    label: "TTL cache preflight (ms)",
  },
  fiscalGerarPdf: {
    env: "FISCAL_GERAR_PDF",
    tipo: "boolean",
    default: false,
    grupo: "fiscal",
    label: "Gerar PDF DANFC-e/DANFE via ACBr",
  },
  fiscalGerarPdfOnEmit: {
    env: "FISCAL_GERAR_PDF_ON_EMIT",
    tipo: "boolean",
    default: false,
    grupo: "fiscal",
    label: "PDF síncrono na emissão (bloqueia checkout)",
  },
  fiscalPollMs: {
    env: "FISCAL_POLL_MS",
    tipo: "number",
    default: 200,
    min: 50,
    max: 5000,
    grupo: "fiscal",
    label: "Intervalo poll fila fiscal (ms)",
  },
  fiscalEmitirSync: {
    env: "FISCAL_EMITIR_SYNC",
    tipo: "boolean",
    default: false,
    grupo: "fiscal",
    label: "Emissão fiscal síncrona (legado)",
  },
  fiscalWorkerMs: {
    env: "FISCAL_WORKER_MS",
    tipo: "number",
    default: 1000,
    min: 200,
    max: 10000,
    grupo: "fiscal",
    label: "Worker fila fiscal (ms)",
  },
  fiscalRateLimitMin: {
    env: "FISCAL_RATE_LIMIT_MIN",
    tipo: "number",
    default: 12,
    min: 1,
    max: 120,
    grupo: "fiscal",
    label: "Rate limit emissões/minuto",
  },
  fiscalRateLimitHora: {
    env: "FISCAL_RATE_LIMIT_HORA",
    tipo: "number",
    default: 200,
    min: 10,
    max: 2000,
    grupo: "fiscal",
    label: "Rate limit emissões/hora",
  },
  fiscalRateBackoffMs: {
    env: "FISCAL_RATE_BACKOFF_MS",
    tipo: "number",
    default: 60000,
    min: 5000,
    max: 600000,
    grupo: "fiscal",
    label: "Backoff rate limit (ms)",
  },
  fiscalReconciliacaoMs: {
    env: "FISCAL_RECONCILIACAO_MS",
    tipo: "number",
    default: 300000,
    min: 60000,
    max: 3600000,
    grupo: "fiscal",
    label: "Intervalo reconciliação fiscal (ms)",
  },
  fiscalEmissaoTimeoutMs: {
    env: "FISCAL_EMISSAO_TIMEOUT_MS",
    tipo: "number",
    default: 180000,
    min: 30000,
    max: 600000,
    grupo: "fiscal",
    label: "Timeout job emissão (ms)",
  },
  acbrTimeoutMs: {
    env: "ACBR_TIMEOUT_MS",
    tipo: "number",
    default: 10000,
    min: 3000,
    max: 120000,
    grupo: "fiscal",
    label: "Timeout TCP ACBr (ms)",
  },
  acbrTimeoutEmissaoMs: {
    env: "ACBR_TIMEOUT_EMISSAO_MS",
    tipo: "number",
    default: 120000,
    min: 30000,
    max: 600000,
    grupo: "fiscal",
    label: "Timeout emissão ACBr (ms)",
  },
  imprimirQrNfce: {
    env: "IMPRIMIR_QR_NFCE",
    tipo: "boolean",
    default: true,
    grupo: "fiscal",
    label: "QR Code no cupom térmico NFC-e",
  },
  imprimirQrNfceSize: {
    env: "IMPRIMIR_QR_NFCE_SIZE",
    tipo: "number",
    default: 6,
    min: 3,
    max: 8,
    grupo: "fiscal",
    label: "Tamanho módulos QR (3–8)",
  },
  diskMinMbXml: {
    env: "DISK_MIN_MB_XML",
    tipo: "number",
    default: 50,
    min: 10,
    max: 5000,
    grupo: "disco",
    label: "Disco mínimo XML (MB)",
  },
  diskMinMbPdf: {
    env: "DISK_MIN_MB_PDF",
    tipo: "number",
    default: 50,
    min: 10,
    max: 5000,
    grupo: "disco",
    label: "Disco mínimo PDF (MB)",
  },
  diskMinMbBackup: {
    env: "DISK_MIN_MB_BACKUP",
    tipo: "number",
    default: 100,
    min: 10,
    max: 5000,
    grupo: "disco",
    label: "Disco mínimo backup (MB)",
  },
  fiscalMinDiskMb: {
    env: "FISCAL_MIN_DISK_MB",
    tipo: "number",
    default: 500,
    min: 50,
    max: 10000,
    grupo: "disco",
    label: "Disco mínimo geral fiscal (MB)",
  },
  auditRetencaoDias: {
    env: "AUDIT_RETENCAO_DIAS",
    tipo: "number",
    default: 90,
    min: 7,
    max: 3650,
    grupo: "disco",
    label: "Retenção audit log (dias)",
  },
  fiscalPurgeFilaDias: {
    env: "FISCAL_PURGE_FILA_DIAS",
    tipo: "number",
    default: 30,
    min: 7,
    max: 365,
    grupo: "disco",
    label: "Purge fila fiscal (dias)",
  },
  fiscalPurgeResultadosDias: {
    env: "FISCAL_PURGE_RESULTADOS_DIAS",
    tipo: "number",
    default: 180,
    min: 30,
    max: 3650,
    grupo: "disco",
    label: "Purge resultados emissão (dias)",
  },
  fiscalPurgeVendasDias: {
    env: "FISCAL_PURGE_VENDAS_DIAS",
    tipo: "number",
    default: 30,
    min: 7,
    max: 365,
    grupo: "disco",
    label: "Purge vendas locais (dias)",
  },
  fiscalPurgeXmlDias: {
    env: "FISCAL_PURGE_XML_DIAS",
    tipo: "number",
    default: 180,
    min: 30,
    max: 3650,
    grupo: "disco",
    label: "Purge arquivos XML (dias)",
  },
  fiscalPurgePdfDias: {
    env: "FISCAL_PURGE_PDF_DIAS",
    tipo: "number",
    default: 180,
    min: 30,
    max: 3650,
    grupo: "disco",
    label: "Purge arquivos PDF (dias)",
  },
  fiscalPurgeBackupDias: {
    env: "FISCAL_PURGE_BACKUP_DIAS",
    tipo: "number",
    default: 90,
    min: 30,
    max: 3650,
    grupo: "disco",
    label: "Purge backups (dias)",
  },
  alertaIncertosMax: {
    env: "ALERTA_INCERTOS_MAX",
    tipo: "number",
    default: 5,
    min: 1,
    max: 100,
    grupo: "alertas",
    label: "Máx. jobs INCERTO antes de alerta",
  },
  filaPendenteAlertaThreshold: {
    env: "FILA_PENDENTE_ALERTA_THRESHOLD",
    tipo: "number",
    default: 10,
    min: 1,
    max: 500,
    grupo: "alertas",
    label: "Limite fila pendente (alerta sustentado)",
  },
  filaPendenteIdadeMin: {
    env: "FILA_PENDENTE_IDADE_MIN",
    tipo: "number",
    default: 15,
    min: 5,
    max: 240,
    grupo: "alertas",
    label: "Minutos com fila acima do limite",
  },
  cStat999RateWindowMin: {
    env: "CSTAT_999_RATE_WINDOW_MIN",
    tipo: "number",
    default: 10,
    min: 5,
    max: 120,
    grupo: "alertas",
    label: "Janela (min) taxa cStat 999",
  },
  cStat999RateMax: {
    env: "CSTAT_999_RATE_MAX",
    tipo: "number",
    default: 5,
    min: 1,
    max: 100,
    grupo: "alertas",
    label: "Máx. cStat 999 na janela",
  },
  alertaMonitorIntervalMs: {
    env: "ALERTA_MONITOR_INTERVAL_MS",
    tipo: "number",
    default: 60000,
    min: 15000,
    max: 600000,
    grupo: "alertas",
    label: "Intervalo monitor alertas (ms)",
  },
  relatorioHorario: {
    env: "RELATORIO_HORARIO",
    tipo: "string",
    default: "23:59",
    grupo: "alertas",
    label: "Horário relatório diário (HH:mm)",
  },
  fiscalRecoveryMs: {
    env: "FISCAL_RECOVERY_MS",
    tipo: "number",
    default: 30000,
    min: 5000,
    max: 600000,
    grupo: "recovery",
    label: "Intervalo recovery fiscal (ms)",
  },
  maxTentativasConsulta: {
    env: "MAX_TENTATIVAS_CONSULTA",
    tipo: "number",
    default: 12,
    min: 1,
    max: 50,
    grupo: "recovery",
    label: "Máx. tentativas consulta chave",
  },
  fiscalBootCancel: {
    env: "FISCAL_BOOT_CANCEL",
    tipo: "boolean",
    default: false,
    grupo: "recovery",
    label: "Boot: cancelar pendentes (legado)",
  },
  fiscalIntegrityStrict: {
    env: "FISCAL_INTEGRITY_STRICT",
    tipo: "boolean",
    default: true,
    grupo: "recovery",
    label: "Integridade SQLite estrita",
  },
  syncIntervalMs: {
    env: "SYNC_INTERVAL_MS",
    tipo: "number",
    default: 30000,
    min: 5000,
    max: 600000,
    grupo: "recovery",
    label: "Sync fila offline (ms)",
  },
  configPollIntervalMs: {
    env: "CONFIG_POLL_INTERVAL_MS",
    tipo: "number",
    default: 45000,
    min: 15000,
    max: 600000,
    grupo: "recovery",
    label: "Polling config painel (ms)",
  },
  maxTentativas: {
    env: "MAX_TENTATIVAS",
    tipo: "number",
    default: 10,
    min: 1,
    max: 50,
    grupo: "recovery",
    label: "Máx. tentativas fila offline",
  },
  acbrAutoRestart: {
    env: "ACBR_AUTO_RESTART",
    tipo: "boolean",
    default: false,
    grupo: "recovery",
    label: "Reiniciar ACBr automaticamente",
  },
  acbrBannerMs: {
    env: "ACBR_BANNER_MS",
    tipo: "number",
    default: 80,
    min: 20,
    max: 500,
    grupo: "recovery",
    label: "Latência banner TCP ACBr (ms)",
  },
  acbrIdleMs: {
    env: "ACBR_IDLE_MS",
    tipo: "number",
    default: 180,
    min: 50,
    max: 1000,
    grupo: "recovery",
    label: "Idle TCP ACBr (ms)",
  },
  backendTimeoutMs: {
    env: "BACKEND_TIMEOUT_MS",
    tipo: "number",
    default: 5000,
    min: 1000,
    max: 60000,
    grupo: "operacao",
    label: "Timeout backend offline (ms)",
  },
  offlineQueueWarn: {
    env: "OFFLINE_QUEUE_WARN",
    tipo: "number",
    default: 50,
    min: 10,
    max: 1000,
    grupo: "operacao",
    label: "Aviso fila offline (vendas pendentes)",
  },
  offlineQueueCritical: {
    env: "OFFLINE_QUEUE_CRITICAL",
    tipo: "number",
    default: 200,
    min: 50,
    max: 5000,
    grupo: "operacao",
    label: "Crítico fila offline (vendas pendentes)",
  },
  fiscalQueueWarnMax: {
    env: "FISCAL_QUEUE_WARN_MAX",
    tipo: "number",
    default: 100,
    min: 20,
    max: 2000,
    grupo: "operacao",
    label: "Aviso fila fiscal (jobs ativos)",
  },
  fiscalQueueCriticalMax: {
    env: "FISCAL_QUEUE_CRITICAL_MAX",
    tipo: "number",
    default: 300,
    min: 50,
    max: 5000,
    grupo: "operacao",
    label: "Crítico fila fiscal (jobs ativos)",
  },
  autoUpdate: {
    env: "AUTO_UPDATE",
    tipo: "boolean",
    default: false,
    grupo: "operacao",
    label: "Auto-update do agente",
  },
  exibirImagensPdv: {
    env: "PDV_EXIBIR_IMAGENS",
    tipo: "boolean",
    default: false,
    grupo: "operacao",
    label: "Exibir thumbnails de produtos no PDV",
  },
  printerProvider: {
    env: "PRINTER_PROVIDER",
    tipo: "string",
    default: "acbr-posprinter",
    enum: ["acbr-posprinter", "native", "mock"],
    grupo: "impressora",
    label: "Provider de impressão (ACBr PosPrinter / ESC/POS)",
  },
  printerFallback: {
    env: "PRINTER_FALLBACK",
    tipo: "string",
    default: "native",
    enum: ["native", "mock"],
    grupo: "impressora",
    label: "Fallback quando ACBr indisponível",
  },
  printerType: {
    env: "PRINTER_TYPE",
    tipo: "string",
    default: "auto",
    enum: ["auto", "usb", "network", "windows"],
    grupo: "impressora",
    label: "Transporte ESC/POS (fallback native)",
  },
  printerEncoding: {
    env: "PRINTER_ENCODING",
    tipo: "string",
    default: "UTF8",
    enum: ["UTF8", "CP860"],
    grupo: "impressora",
    label: "Codificação térmica",
  },
  printerCut: {
    env: "PRINTER_CUT",
    tipo: "string",
    default: "partial",
    enum: ["partial", "total", "full", "none"],
    grupo: "impressora",
    label: "Tipo de corte de papel",
  },
  printerDrawer: {
    env: "PRINTER_DRAWER",
    tipo: "boolean",
    default: true,
    grupo: "impressora",
    label: "Abrir gaveta no teste de impressão",
  },
  printerModel: {
    env: "PRINTER_MODEL",
    tipo: "string",
    default: "auto",
    grupo: "impressora",
    label: "Modelo ACBr PosPrinter (0=genérica)",
  },
  printerPorta: {
    env: "PRINTER_PORTA",
    tipo: "string",
    default: "USB",
    grupo: "impressora",
    label: "Porta impressora (USB/COM/rede)",
  },
  printerQrErrorLevel: {
    env: "PRINTER_QR_ERROR_LEVEL",
    tipo: "string",
    default: "L",
    enum: ["L", "M", "Q", "H"],
    grupo: "impressora",
    label: "QR Code — nível de correção",
  },
  printerQrEscposMode: {
    env: "PRINTER_QR_ESCPOS_MODE",
    tipo: "string",
    default: "gs_k",
    enum: ["gs_k", "raster"],
    grupo: "impressora",
    label: "QR Code ESC/POS — GS ( k nativo ou raster (imagem)",
  },
  printerBarcodeAltura: {
    env: "PRINTER_BARCODE_ALTURA",
    tipo: "number",
    default: 50,
    min: 10,
    max: 255,
    grupo: "impressora",
    label: "Código de barras — altura",
  },
  printJobMaxTentativas: {
    env: "PRINT_JOB_MAX_TENTATIVAS",
    tipo: "number",
    default: 5,
    min: 1,
    max: 20,
    grupo: "impressora",
    label: "Máx. tentativas por job de impressão",
  },
  printJobTimeoutTotalMs: {
    env: "PRINT_JOB_TIMEOUT_TOTAL_MS",
    tipo: "number",
    default: 20000,
    min: 5000,
    max: 120000,
    grupo: "impressora",
    label: "Timeout total por tentativa (ms)",
  },
  printJobBackoffMs: {
    env: "PRINT_JOB_BACKOFF_MS",
    tipo: "number",
    default: 2000,
    min: 500,
    max: 60000,
    grupo: "impressora",
    label: "Backoff entre retries (ms)",
  },
  printJobPollMs: {
    env: "PRINT_JOB_POLL_MS",
    tipo: "number",
    default: 1000,
    min: 200,
    max: 30000,
    grupo: "impressora",
    label: "Intervalo worker fila impressão (ms)",
  },
  printJobRetentionDias: {
    env: "PRINT_JOB_RETENTION_DIAS",
    tipo: "number",
    default: 90,
    min: 7,
    max: 365,
    grupo: "impressora",
    label: "Retenção histórico jobs (dias)",
  },
};

function lerEnvFallback(chave) {
  const def = CATALOGO[chave];
  if (!def) return undefined;
  const raw = process.env[def.env];
  if (raw === undefined || raw === "") return def.default;
  if (def.tipo === "boolean") {
    return ["true", "1", "yes", "sim"].includes(String(raw).toLowerCase());
  }
  if (def.tipo === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : def.default;
  }
  return String(raw);
}

function valoresPadraoCompletos() {
  /** @type {Record<string, boolean|number|string>} */
  const out = {};
  for (const [k, def] of Object.entries(getCatalogoAtivo())) {
    out[k] = def.default;
  }
  return out;
}

/** Catálogo ativo — remoto quando disponível, bundled como fallback. */
let catalogoAtivo = { ...CATALOGO };
let catalogVersionRemota = null;

function chaveToEnv(chave) {
  return (
    {
      nfeSerie55: "NFE_SERIE_55",
      cStat999RateWindowMin: "CSTAT_999_RATE_WINDOW_MIN",
      cStat999RateMax: "CSTAT_999_RATE_MAX",
      exibirImagensPdv: "PDV_EXIBIR_IMAGENS",
    }[chave] ||
    String(chave)
      .replace(/([A-Z])/g, "_$1")
      .replace(/^_/, "")
      .toUpperCase()
  );
}

function exportEnvContrato() {
  const out = {};
  for (const [chave, def] of Object.entries(CATALOGO)) {
    out[chave] = def.env || chaveToEnv(chave);
  }
  return out;
}

function getCatalogoAtivo() {
  return catalogoAtivo;
}

function getCatalogVersionRemota() {
  return catalogVersionRemota;
}

/**
 * Carrega catálogo do backend (GET /pdv/agente/config/catalog).
 * Mantém bundled como base — chaves desconhecidas no bundle são adicionadas.
 */
function carregarCatalogoRemoto(payload) {
  const defs = Array.isArray(payload) ? payload : payload?.defs;
  const version = payload?.catalogVersion ?? null;
  if (!defs || !Array.isArray(defs) || defs.length === 0) {
    return { ok: false, motivo: "catalogo_vazio" };
  }

  const next = { ...CATALOGO };
  for (const d of defs) {
    if (!d || !d.chave) continue;
    const existing = CATALOGO[d.chave] || {};
    next[d.chave] = {
      env: d.env || existing.env || chaveToEnv(d.chave),
      tipo: d.tipo || existing.tipo || "string",
      default: d.padrao !== undefined && d.padrao !== null ? d.padrao : existing.default,
      grupo: d.grupo || existing.grupo || "operacao",
      label: d.label || existing.label || d.chave,
      min: d.min ?? existing.min,
      max: d.max ?? existing.max,
      enum: d.valoresPermitidos ?? existing.enum,
    };
  }
  catalogoAtivo = next;
  catalogVersionRemota = version;
  return { ok: true, version, chaves: Object.keys(next).length };
}

function resetCatalogoBundled() {
  catalogoAtivo = { ...CATALOGO };
  catalogVersionRemota = null;
}

function mesclarComDefaults(operacional) {
  const cat = getCatalogoAtivo();
  /** @type {Record<string, boolean|number|string>} */
  const base = valoresPadraoCompletos();
  if (!operacional || typeof operacional !== "object") return base;
  for (const [k, v] of Object.entries(operacional)) {
    if (cat[k] && v !== undefined && v !== null) {
      base[k] = validarValor(k, v);
    }
  }
  return base;
}

function validarValor(chave, valor) {
  const def = getCatalogoAtivo()[chave];
  if (!def) throw new Error(`Config desconhecida: ${chave}`);
  if (def.tipo === "boolean") return !!valor;
  if (def.tipo === "number") {
    const n = Number(valor);
    if (!Number.isFinite(n)) throw new Error(`${chave}: número inválido`);
    if (def.min != null && n < def.min) {
      throw new Error(`${chave}: mínimo ${def.min}`);
    }
    if (def.max != null && n > def.max) {
      throw new Error(`${chave}: máximo ${def.max}`);
    }
    return n;
  }
  const s = String(valor).trim();
  if (def.enum && !def.enum.includes(s)) {
    throw new Error(`${chave}: valor deve ser um de ${def.enum.join(", ")}`);
  }
  if (chave === "relatorioHorario" && !/^\d{2}:\d{2}$/.test(s)) {
    throw new Error("relatorioHorario: use HH:mm");
  }
  return s;
}

function aplicarNoProcessEnv(operacional) {
  const merged = mesclarComDefaults(operacional);
  const cat = getCatalogoAtivo();
  for (const [k, v] of Object.entries(merged)) {
    if (CHAVES_SSOT_LOCAL.has(k)) continue;
    const def = cat[k];
    if (!def) continue;
    process.env[def.env] =
      def.tipo === "boolean" ? (v ? "true" : "false") : String(v);
  }
  return merged;
}

function filtrarSomenteOverrides(operacional) {
  if (!operacional || typeof operacional !== "object") return {};
  const cat = getCatalogoAtivo();
  /** @type {Record<string, boolean|number|string>} */
  const out = {};
  for (const [k, v] of Object.entries(operacional)) {
    if (CHAVES_SSOT_LOCAL.has(k)) continue;
    const norm = validarValor(k, v);
    if (norm !== cat[k].default) out[k] = norm;
  }
  return out;
}

module.exports = {
  CATALOGO,
  CHAVES_SSOT_LOCAL,
  lerEnvFallback,
  valoresPadraoCompletos,
  mesclarComDefaults,
  validarValor,
  aplicarNoProcessEnv,
  filtrarSomenteOverrides,
  carregarCatalogoRemoto,
  getCatalogoAtivo,
  getCatalogVersionRemota,
  resetCatalogoBundled,
  chaveToEnv,
  exportEnvContrato,
};

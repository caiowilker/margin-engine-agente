// Catálogo de configs operacionais (categoria A) — sincronizáveis via painel.
// Credenciais ACBr e infra local (categoria B/C) não entram aqui.

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
  nfeUf: {
    env: "NFE_UF",
    tipo: "string",
    default: "MG",
    enum: [
      "AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT",
      "PA", "PB", "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO",
    ],
    grupo: "fiscal",
    label: "UF emitente (referência)",
  },
  ambienteSefaz: {
    env: "AMBIENTE_SEFAZ",
    tipo: "string",
    default: "homologacao",
    enum: ["homologacao", "producao"],
    grupo: "fiscal",
    label: "Ambiente SEFAZ (homologação ou produção)",
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
    enum: ["partial", "total"],
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
  printerBarcodeAltura: {
    env: "PRINTER_BARCODE_ALTURA",
    tipo: "number",
    default: 50,
    min: 10,
    max: 255,
    grupo: "impressora",
    label: "Código de barras — altura",
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
  for (const [k, def] of Object.entries(CATALOGO)) {
    out[k] = def.default;
  }
  return out;
}

function mesclarComDefaults(operacional) {
  const base = valoresPadraoCompletos();
  if (!operacional || typeof operacional !== "object") return base;
  for (const [k, v] of Object.entries(operacional)) {
    if (CATALOGO[k] && v !== undefined && v !== null) {
      base[k] = validarValor(k, v);
    }
  }
  return base;
}

function validarValor(chave, valor) {
  const def = CATALOGO[chave];
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
  for (const [k, v] of Object.entries(merged)) {
    const def = CATALOGO[k];
    if (!def) continue;
    process.env[def.env] =
      def.tipo === "boolean" ? (v ? "true" : "false") : String(v);
  }
  return merged;
}

function filtrarSomenteOverrides(operacional) {
  if (!operacional || typeof operacional !== "object") return {};
  /** @type {Record<string, boolean|number|string>} */
  const out = {};
  for (const [k, v] of Object.entries(operacional)) {
    if (!CATALOGO[k]) continue;
    const norm = validarValor(k, v);
    if (norm !== CATALOGO[k].default) out[k] = norm;
  }
  return out;
}

module.exports = {
  CATALOGO,
  lerEnvFallback,
  valoresPadraoCompletos,
  mesclarComDefaults,
  validarValor,
  aplicarNoProcessEnv,
  filtrarSomenteOverrides,
};

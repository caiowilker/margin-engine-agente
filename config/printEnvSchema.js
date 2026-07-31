/**
 * Schema canônico de env de impressão — SSOT para defaults, clamp e .env.example.
 * Typo em loja NÃO derruba o serviço Windows (clamp + log); exit só nos bootGuards fiscais.
 */
const log = require("../logger").child({ modulo: "print_env_schema" });

/** @typedef {{ env: string, kind: "int"|"bool"|"enum", min?: number, max?: number, default: string|number|boolean, values?: string[], comment: string }} PrintEnvField */

/** @type {PrintEnvField[]} */
const PRINT_ENV_FIELDS = [
  {
    env: "PRINT_JOB_TIMEOUT_FAST_MS",
    kind: "int",
    min: 1000,
    max: 15000,
    default: 4000,
    comment: "Soft timeout jobs comerciais (cupom/gaveta/pedido)",
  },
  {
    env: "PRINT_JOB_TIMEOUT_TOTAL_MS",
    kind: "int",
    min: 2000,
    max: 60000,
    default: 10000,
    comment: "Soft timeout jobs gerais (DANFE etc.)",
  },
  {
    env: "PRINT_HARD_DRAIN_MS",
    kind: "int",
    min: 500,
    max: 5000,
    default: 2000,
    comment: "Hard drain após soft — nunca minutos",
  },
  {
    env: "PRINTER_RAW_TIMEOUT_MS",
    kind: "int",
    min: 1000,
    max: 15000,
    default: 4000,
    comment: "Timeout WritePrinter PowerShell + taskkill /T",
  },
  {
    env: "PRINTER_RAW_KILL_HOLD_MS",
    kind: "int",
    min: 1000,
    max: 30000,
    default: 12000,
    comment:
      "Após soft kill: quanto segurar o physicalLock antes de liberar (evita 2º cupom no USB ocupado)",
  },
  {
    env: "ACBR_POS_CALL_TIMEOUT_MS",
    kind: "int",
    min: 1000,
    max: 15000,
    default: 5000,
    comment: "Timeout por chamada POS_* (worker ou in-process)",
  },
  {
    env: "PRINT_FISCAL_WAIT_MS",
    kind: "int",
    min: 0,
    max: 10000,
    default: 2000,
    comment: "Espera cortesia se emissão fiscal ativa (ACBr path)",
  },
  {
    env: "PRINT_FISCAL_WAIT_NATIVE_MS",
    kind: "int",
    min: 0,
    max: 5000,
    default: 800,
    comment: "Espera cortesia se fiscal ativo (native path)",
  },
  {
    env: "PRINT_FAST_NATIVE",
    kind: "bool",
    default: false,
    comment: "true = cupom comercial via ESC/POS nativo (legado)",
  },
  {
    env: "ACBR_POS_WORKER",
    kind: "bool",
    default: true,
    comment:
      "Isola PosPrinter em worker_thread (terminate real). Falha → ESC/POS nativo (não FFI no main)",
  },
  {
    env: "ACBR_POS_WORKER_KILL_COOLDOWN_MS",
    kind: "int",
    min: 0,
    max: 5000,
    default: 750,
    comment: "Pausa após terminate() antes de respawn (USB/spooler)",
  },
  {
    env: "PHYSICAL_USB_TOPOLOGY",
    kind: "enum",
    values: ["shared", "separate"],
    default: "separate",
    comment: "shared = térmica e NFC-e no mesmo hub USB (serializa); separate = portas distintas",
  },
  {
    env: "PRINT_ACBR_CIRCUIT",
    kind: "bool",
    default: true,
    comment: "Circuito RAW: após falha ACBr, comerciais vão native",
  },
  {
    env: "ACBR_POS_CIRCUIT_TTL_MS",
    kind: "int",
    min: 0,
    max: 86400000,
    default: 0,
    comment:
      "TTL do circuito (0=nunca; só Salvar/Detectar reabre ACBr). >0 = half-open após ms",
  },
  {
    env: "ACBR_POS_ALLOW_INPROCESS",
    kind: "bool",
    default: false,
    comment:
      "Permite FFI PosPrinter no processo principal (perigoso no Windows). Padrão: só worker ou ACBR_POS_WORKER=false",
  },
];

function isTruthy(v) {
  const s = String(v ?? "")
    .trim()
    .toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

function isFalsy(v) {
  const s = String(v ?? "")
    .trim()
    .toLowerCase();
  return s === "false" || s === "0" || s === "no" || s === "off";
}

/**
 * Normaliza process.env conforme schema (clamp). Idempotente.
 * @returns {{ clamped: Array<{ env: string, from: string, to: string }>, applied: Record<string, string> }}
 */
function applyPrintEnvSchema(env = process.env) {
  const clamped = [];
  const applied = {};

  for (const field of PRINT_ENV_FIELDS) {
    const raw = env[field.env];
    const missing = raw === undefined || String(raw).trim() === "";

    if (field.kind === "int") {
      const def = Number(field.default);
      let n = missing ? def : parseInt(String(raw), 10);
      if (!Number.isFinite(n) || n < field.min || n > field.max) {
        // Typo tipo 80000 → default canônico (não só borda) — evita serviço morto e timeouts absurdos
        clamped.push({
          env: field.env,
          from: missing ? "(vazio)" : String(raw),
          to: String(def),
        });
        n = def;
      }
      env[field.env] = String(n);
      applied[field.env] = String(n);
      continue;
    }

    if (field.kind === "bool") {
      let val = field.default;
      if (!missing) {
        if (isTruthy(raw)) val = true;
        else if (isFalsy(raw)) val = false;
        else {
          clamped.push({
            env: field.env,
            from: String(raw),
            to: String(field.default),
          });
          val = field.default;
        }
      }
      env[field.env] = val ? "true" : "false";
      applied[field.env] = env[field.env];
      continue;
    }

    if (field.kind === "enum") {
      const def = String(field.default);
      let val = missing ? def : String(raw).trim().toLowerCase();
      if (!field.values.includes(val)) {
        clamped.push({ env: field.env, from: String(raw), to: def });
        val = def;
      }
      env[field.env] = val;
      applied[field.env] = val;
    }
  }

  if (clamped.length) {
    log.error(
      { clamped, metric: "env.clamped" },
      `[PrintEnv] ${clamped.length} variável(is) corrigida(s) para default canônico`,
    );
  }

  return { clamped, applied };
}

/** Bloco markdown/comentário para .env.example (gerado). */
function renderPrintEnvExampleBlock() {
  const lines = [
    "# ── Impressão térmica (SSOT: config/printEnvSchema.js) ─────────",
    "# Defaults abaixo = código em produção. Não documentar valores legados.",
    "# npm run generate:print-env  → regenera este bloco",
  ];
  for (const field of PRINT_ENV_FIELDS) {
    lines.push(`# ${field.comment}`);
    lines.push(`${field.env}=${field.default}`);
  }
  lines.push("");
  return lines.join("\n");
}

const PRINT_ENV_BLOCK_START = "# BEGIN PRINT_ENV_SCHEMA";
const PRINT_ENV_BLOCK_END = "# END PRINT_ENV_SCHEMA";

function wrapPrintEnvExampleBlock() {
  return `${PRINT_ENV_BLOCK_START}\n${renderPrintEnvExampleBlock()}${PRINT_ENV_BLOCK_END}\n`;
}

function getPrintEnvField(envName) {
  return PRINT_ENV_FIELDS.find((f) => f.env === envName) || null;
}

module.exports = {
  PRINT_ENV_FIELDS,
  PRINT_ENV_BLOCK_START,
  PRINT_ENV_BLOCK_END,
  applyPrintEnvSchema,
  renderPrintEnvExampleBlock,
  wrapPrintEnvExampleBlock,
  getPrintEnvField,
};

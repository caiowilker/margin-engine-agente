/**
 * Rate-limit por UF para emissões fiscais ao SEFAZ.
 *
 * Implementa token-bucket independente por UF, com:
 *  - Taxa sustentada (tokens por segundo) configurável por env global ou por UF
 *  - Burst máximo (rajada máxima momentânea) configurável
 *  - Jitter ao adiar jobs (evita thundering-herd quando SEFAZ retorna)
 *  - Métricas: quantas emissões foram atrasadas vs enviadas imediatamente
 *
 * Valores default conservadores baseados nos limites documentados pela SEFAZ:
 *  - A maioria das UFs tolera ~3–5 req/s por certificado emitente no SEFAZ
 *    (sem documentação oficial pública; baseado em experiência de produção).
 *  - Configurar valores via env para ajustar por UF específica.
 *
 * Integração: fiscalService.js chama `consumir(uf)` antes de enviar ao ACBr.
 * Se não houver token disponível, retorna `{ ok: false, aguardarMs }`.
 * O chamador deve adiar o job (retornar ao worker sem marcar erro).
 */
const log = require("../logger").child({ modulo: "uf_rate_limit" });

// Taxa padrão (tokens/segundo) para todas as UFs sem configuração específica
const DEFAULT_TAXA_POR_SEGUNDO = parseFloat(
  process.env.SEFAZ_RL_TAXA_PADRAO || "3",
);
// Burst máximo padrão (tokens acumulados no bucket)
const DEFAULT_BURST = parseInt(process.env.SEFAZ_RL_BURST_PADRAO || "5", 10);

// Jitter máximo aplicado ao aguardarMs (ms) — distribui reenvios
const JITTER_MAX_MS = parseInt(process.env.SEFAZ_RL_JITTER_MS || "2000", 10);

// Configurações por UF via env — ex: SEFAZ_RL_SP_TAXA=2 SEFAZ_RL_SP_BURST=4
// Para desativar rate-limit por UF, defina SEFAZ_RL_UF_HABILITADO=false
// Leitura dinâmica para permitir toggle sem reiniciar o processo.
function isHabilitado() {
  return (process.env.SEFAZ_RL_UF_HABILITADO || "true").toLowerCase() !== "false";
}

/**
 * Retorna configuração de taxa/burst para uma UF.
 * Leitura dinâmica para permitir ajuste sem reiniciar o processo.
 */
function configUf(uf) {
  const u = String(uf || "").toUpperCase().trim() || "DEFAULT";
  const taxa = parseFloat(
    process.env[`SEFAZ_RL_${u}_TAXA`] || String(DEFAULT_TAXA_POR_SEGUNDO),
  );
  const burst = parseInt(
    process.env[`SEFAZ_RL_${u}_BURST`] || String(DEFAULT_BURST),
    10,
  );
  return {
    taxa: Number.isFinite(taxa) && taxa > 0 ? taxa : DEFAULT_TAXA_POR_SEGUNDO,
    burst: Number.isFinite(burst) && burst > 0 ? burst : DEFAULT_BURST,
  };
}

/**
 * Estado por UF: { tokens: number, ultimaRecargaMs: number }
 * tokens = tokens disponíveis (fração de inteiro permitida para precisão)
 * ultimaRecargaMs = timestamp da última recarga
 */
const _buckets = new Map();

/**
 * Contadores de métrica — acessíveis via `metricas()`.
 * ufBloqueados: chave uf → contagem de chamadas que aguardaram
 * ufEmitidos: chave uf → contagem de emissões que passaram direto
 */
const _stats = {
  bloqueados: 0,
  emitidos: 0,
  porUf: new Map(), // uf → { bloqueados, emitidos }
};

function _statUf(uf) {
  const u = String(uf || "XX").toUpperCase();
  if (!_stats.porUf.has(u)) _stats.porUf.set(u, { bloqueados: 0, emitidos: 0 });
  return _stats.porUf.get(u);
}

function _recarregar(bucket, cfg) {
  const agora = Date.now();
  const decorrido = Math.max(0, agora - bucket.ultimaRecargaMs) / 1000;
  bucket.tokens = Math.min(cfg.burst, bucket.tokens + decorrido * cfg.taxa);
  bucket.ultimaRecargaMs = agora;
}

function _bucket(uf, cfg) {
  const u = String(uf || "DEFAULT").toUpperCase();
  if (!_buckets.has(u)) {
    // Bucket inicializa cheio (burst completo)
    _buckets.set(u, { tokens: cfg.burst, ultimaRecargaMs: Date.now() });
  }
  return _buckets.get(u);
}

/**
 * Tenta consumir 1 token da UF.
 *
 * @param {string} uf - Sigla da UF emitente (ex: "SP")
 * @returns {{ ok: boolean, aguardarMs?: number, uf: string }}
 *   ok=true  → pode emitir agora
 *   ok=false → aguardar aguardarMs (com jitter) antes de tentar novamente
 */
function consumir(uf) {
  if (!isHabilitado()) return { ok: true, uf };

  const cfg = configUf(uf);
  const u = String(uf || "DEFAULT").toUpperCase();
  const bucket = _bucket(u, cfg);
  _recarregar(bucket, cfg);

  const stat = _statUf(u);

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    stat.emitidos += 1;
    _stats.emitidos += 1;
    return { ok: true, uf: u };
  }

  // Calcula quanto tempo falta para ter 1 token
  const faltaSegundos = (1 - bucket.tokens) / cfg.taxa;
  const jitter = Math.floor(Math.random() * JITTER_MAX_MS);
  const aguardarMs = Math.ceil(faltaSegundos * 1000) + jitter;

  stat.bloqueados += 1;
  _stats.bloqueados += 1;

  log.warn(
    {
      uf: u,
      tokensDisponiveis: bucket.tokens.toFixed(2),
      aguardarMs,
      taxaConfigurada: cfg.taxa,
      burst: cfg.burst,
    },
    "[UF Rate Limit] Token esgotado — emissão adiada",
  );

  return {
    ok: false,
    uf: u,
    aguardarMs,
    motivo: `Rate limit SEFAZ por UF (${u}): aguarde ${Math.ceil(aguardarMs / 1000)}s`,
  };
}

/**
 * Extrai a UF de um payload de emissão.
 * Prioriza empresa.uf, depois payload.uf.
 */
function extrairUf(payload) {
  const uf =
    payload?.empresa?.uf ||
    payload?.uf ||
    payload?.emitente?.uf ||
    null;
  return String(uf || "").toUpperCase().trim() || null;
}

/**
 * Retorna snapshot das métricas de rate-limiting por UF.
 */
function metricas() {
  const porUf = {};
  for (const [uf, s] of _stats.porUf.entries()) {
    const bucket = _buckets.get(uf);
    const cfg = configUf(uf);
    porUf[uf] = {
      bloqueados: s.bloqueados,
      emitidos: s.emitidos,
      tokensDisponiveis: bucket
        ? parseFloat(bucket.tokens.toFixed(2))
        : cfg.burst,
      taxaTokensPorSegundo: cfg.taxa,
      burst: cfg.burst,
    };
  }
  return {
    habilitado: isHabilitado(),
    totalBloqueados: _stats.bloqueados,
    totalEmitidos: _stats.emitidos,
    porUf,
  };
}

/**
 * Reseta estado dos buckets e métricas — usado em testes.
 */
function resetParaTestes() {
  _buckets.clear();
  _stats.bloqueados = 0;
  _stats.emitidos = 0;
  _stats.porUf.clear();
}

module.exports = { consumir, extrairUf, metricas, resetParaTestes };

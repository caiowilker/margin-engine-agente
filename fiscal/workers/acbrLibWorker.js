/**
 * Processo filho para toda a FFI fiscal ACBrLib.
 * Não importa este arquivo no processo HTTP: aqui é permitido carregar koffi,
 * mudar cwd e encerrar em caso de corrupção do heap nativo.
 */
process.env.ACBR_LIB_WORKER_CHILD = "true";
// O base-node aloca o handle e o bridge declara a função. Ambos precisam
// resolver a mesma instância Koffi antes de qualquer require fiscal.
require("../../runtime/acbrKoffiTopology").enforceSingleKoffi();

const allowed = new Set([
  "emitirNfce",
  "emitirNfe",
  "emitirNfse",
  "emitirViaNativeLib",
  "sincronizarNfceOffline",
  "statusServico",
  "testar",
  "testarLibDetalhe",
  "consultarChave",
  "consultarChaveEntrada",
  "cancelarNfce",
  "inutilizarNfce",
  "enviarEventoFiscal",
  "distribuicaoDFePorUltNsu",
  "distribuicaoDFePorChave",
  "manifestarCienciaOperacao",
  "manifestarEventoDestinatario",
  "gerarPdfFiscal",
  "gerarPdfDanfce",
  "gerarPdfDanfe",
  "refreshLibRuntimeConfig",
  "invalidateNativeSession",
]);

let driver = null;
let generation = Number(process.env.ACBR_LIB_WORKER_GENERATION || 0);
let queue = Promise.resolve();

function getDriver() {
  if (!driver) driver = require("../drivers/acbrLibDriver");
  return driver;
}

function send(message) {
  try {
    process.send?.(message);
  } catch (_) {}
}

process.on("message", (message) => {
  const run = async () => {
  if (!message || message.generation !== generation) return;
  const { id, method, args } = message;
  if (!allowed.has(method) || typeof getDriver()[method] !== "function") {
    return send({
      id,
      generation,
      ok: false,
      error: { code: "ACBR_LIB_WORKER_UNKNOWN_METHOD", message: `Método não permitido: ${method}` },
    });
  }
  try {
    const data = await getDriver()[method](...(Array.isArray(args) ? args : []));
    send({ id, generation, ok: true, data });
  } catch (error) {
    send({
      id,
      generation,
      ok: false,
      error: {
        code: error?.code || (error?.processPoisoned ? "ACBR_LIB_KOFFI_POISONED" : "ACBR_LIB_WORKER_ERROR"),
        message: error?.message || String(error),
        meta: {
          processPoisoned: error?.processPoisoned === true,
          retryable: error?.retryable === true,
        },
      },
    });
  }
  };
  queue = queue.then(run, run);
});

send({ id: null, generation, ok: true, data: { boot: true } });

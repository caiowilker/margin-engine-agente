/**
 * MockPrinterProvider — testes CI sem hardware.
 */
const jobs = [];

const DRIVER_INFO = {
  provider: "mock",
  label: "Mock (testes)",
  ready: true,
  mode: "mock",
};

function record(tipo, payload) {
  jobs.push({ tipo, payload, at: new Date().toISOString() });
  return { ok: true, provider: "mock", tipo, jobIndex: jobs.length - 1 };
}

module.exports = {
  getProviderName: () => "mock",
  getDriverInfo: () => ({ ...DRIVER_INFO, jobs: jobs.length }),
  testar: async () => true,
  getInfo: async () => ({ ok: true, conectada: true, mock: true }),
  listar: () => ({ mock: true, jobs: jobs.length }),
  detectar: async () => ({ ok: true, mock: true }),
  imprimirCupom: async (payload) => record("cupom", payload),
  imprimirSegundaVia: async (opts) => record("segunda-via", opts),
  imprimirAbertura: async (payload) => record("abertura", payload),
  imprimirFechamento: async (payload) => record("fechamento", payload),
  imprimirMovimentoCaixa: async (payload) => record("movimento", payload),
  abrirGaveta: async () => record("gaveta", {}),
  imprimirTeste: async () => record("teste", { pagina: true }),
  _jobs: jobs,
  _clearJobs: () => {
    jobs.length = 0;
  },
};

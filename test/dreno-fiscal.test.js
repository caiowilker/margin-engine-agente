/**
 * Dreno de NFC-e devidas: venda fiscal sem nota volta para a fila sem nunca gerar segunda nota.
 */
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

process.env.LOG_SILENT = "true";
const dreno = require("../drenoFiscal");

const INI = "[Identificacao]\ndhEmi=05/10/2026 10:00:00\nnatOp=VENDA\n[Produto001]\nNCM=22021000\n";

function fakeDeps({
  itens = [],
  job = null,
  jobs = null,
  doc = null,
  ativas = 0,
  prepare,
  emissao = true,
  relogio,
  paginas = null,
} = {}) {
  const chamadas = {
    preparar: [],
    enfileirar: [],
    callback: [],
    sincronizar: [],
    reabrirConsulta: [],
    reabrirEmissao: [],
    listar: [],
  };
  let agora = relogio ?? 1_000_000;
  const deps = {
    fiscalDriver: { EMISSAO_FISCAL: emissao },
    acbr: { isAcbrBusy: () => false },
    agora: () => agora,
    avancar: (ms) => {
      agora += ms;
    },
    filaFiscal: {
      acbrOcupado: () => false,
      contarEmissoesAtivas: () => ativas,
      buscarDocumentoPorVenda: () => doc,
      buscarJobEmissaoPorVenda: (n) => (jobs ? jobs[n] || null : job),
      reabrirParaConsulta: (id) => chamadas.reabrirConsulta.push(id),
      reabrirJobEmissao: (id, payload) => chamadas.reabrirEmissao.push({ id, payload }),
      dispararProcessamento: () => {},
    },
    listarPendentes: async (_cfg, limite, apos) => {
      chamadas.listar.push({ limite, apos });
      return { itens: paginas ? paginas(apos, limite) : itens };
    },
    sincronizarVenda: async (_cfg, numeroVenda) => {
      chamadas.sincronizar.push(numeroVenda);
      return { ok: true };
    },
    preparar:
      prepare ||
      (async (_cfg, numeroVenda) => {
        chamadas.preparar.push(numeroVenda);
        return {
          correlationId: "corr-1",
          documentIni: INI,
          itens: [{ codigo: "P1", quantidade: 1 }],
        };
      }),
    enfileirarEmissao: async (_cfg, payload) => {
      chamadas.enfileirar.push(payload);
      return { fiscal: "pending", deduplicado: false };
    },
    recuperarDocumentoLocal: async (_cfg, numeroVenda) => {
      chamadas.callback.push(numeroVenda);
      return true;
    },
  };
  return { deps, chamadas };
}

const lerConfig = async () => ({ backendUrl: "http://backend", backendToken: "tok" });

beforeEach(() => dreno.resetParaTestes());

test("emissão desligada: dreno não toca em nada", async () => {
  const { deps, chamadas } = fakeDeps({ itens: [{ numeroVenda: "V1" }], emissao: false });
  const r = await dreno.executarCiclo(lerConfig, deps);
  assert.equal(r.motivo, "emissao_desligada");
  assert.equal(chamadas.preparar.length, 0);
});

test("venda sem job: prepara e enfileira pela fila normal", async () => {
  const { deps, chamadas } = fakeDeps({ itens: [{ numeroVenda: "V1", statusFiscal: "PENDENTE" }] });
  const r = await dreno.executarCiclo(lerConfig, deps);
  assert.equal(r.resultados[0].acao, "enfileirado");
  assert.deepEqual(chamadas.preparar, ["V1"]);
  const p = chamadas.enfileirar[0];
  assert.equal(p.numeroVenda, "V1");
  assert.equal(p.correlationId, "corr-1");
  assert.equal(p.itens[0].id, "P1");
  assert.equal(p.documentIni, INI);
});

test("job ativo na fila: não prepara nem enfileira de novo", async () => {
  const { deps, chamadas } = fakeDeps({
    itens: [{ numeroVenda: "V1" }],
    job: { id: 7, status: "INCERTO" },
  });
  const r = await dreno.executarCiclo(lerConfig, deps);
  assert.equal(r.resultados[0].acao, "em_fila");
  assert.equal(chamadas.preparar.length, 0);
  assert.equal(chamadas.enfileirar.length, 0);
});

test("nota já autorizada localmente: só reenvia o callback", async () => {
  const { deps, chamadas } = fakeDeps({
    itens: [{ numeroVenda: "V1", correlationId: "c" }],
    doc: { chave: "3".repeat(44) },
  });
  const r = await dreno.executarCiclo(lerConfig, deps);
  assert.equal(r.resultados[0].acao, "callback_reenviado");
  assert.deepEqual(chamadas.callback, ["V1"]);
  assert.equal(chamadas.preparar.length, 0);
});

test("consulta esgotada: 1º reabre consulta; esgotou de novo reemite com o mesmo job/nNF", async () => {
  const job = {
    id: 9,
    status: "FALHA_PERMANENTE",
    erro: "ACBr_OFFLINE_TIMEOUT",
    payload: JSON.stringify({ documentIni: INI, _fiscalMeta: { numeroNfe: "41" } }),
  };
  const { deps, chamadas } = fakeDeps({ itens: [{ numeroVenda: "V1" }], job });

  let r = await dreno.executarCiclo(lerConfig, deps);
  assert.equal(r.resultados[0].acao, "reaberto_consulta");
  assert.deepEqual(chamadas.reabrirConsulta, [9]);
  assert.equal(chamadas.preparar.length, 0, "INCERTO nunca reemite direto");

  deps.avancar(10 * 60_000);
  r = await dreno.executarCiclo(lerConfig, deps);
  assert.equal(r.resultados[0].acao, "reemissao_reaberta");
  assert.equal(chamadas.reabrirEmissao[0].id, 9);
  assert.equal(chamadas.reabrirEmissao[0].payload._fiscalMeta.numeroNfe, "41");
  assert.equal(chamadas.enfileirar.length, 0, "reabre o job existente — não cria número novo");
  assert.equal(chamadas.preparar.length, 0, "INCERTO no backend recusa prepare — usa o payload do job");
});

test("falha transitória esgotada reabre com o payload do job, sem prepare", async () => {
  const job = {
    id: 4,
    status: "FALHA_PERMANENTE",
    erro: "Timeout na comunicação com a SEFAZ",
    payload: JSON.stringify({ documentIni: INI, correlationId: "c-old" }),
  };
  const { deps, chamadas } = fakeDeps({ itens: [{ numeroVenda: "V1", statusFiscal: "PENDENTE_FISCAL" }], job });
  const r = await dreno.executarCiclo(lerConfig, deps);
  assert.equal(r.resultados[0].acao, "reemissao_reaberta");
  assert.equal(chamadas.reabrirEmissao[0].payload.documentIni, INI);
  assert.equal(chamadas.preparar.length, 0);
});

test("duplicidade 539 nunca é reemitida automaticamente", async () => {
  const job = {
    id: 5,
    status: "FALHA_PERMANENTE",
    erro: "Rejeição cStat 539: Duplicidade de NF-e com diferença na chave",
    payload: JSON.stringify({ documentIni: INI }),
  };
  const { deps, chamadas } = fakeDeps({ itens: [{ numeroVenda: "V1" }], job });
  const r = await dreno.executarCiclo(lerConfig, deps);
  assert.equal(r.resultados[0].acao, "aguardando_operador");
  assert.equal(chamadas.reabrirEmissao.length, 0);
  assert.equal(chamadas.preparar.length, 0);
});

test("venda em voo no backend (INCERTO) sem job local nunca ganha número novo", async () => {
  const { deps, chamadas } = fakeDeps({ itens: [{ numeroVenda: "V1", statusFiscal: "INCERTO" }] });
  const r = await dreno.executarCiclo(lerConfig, deps);
  assert.equal(r.resultados[0].acao, "sem_job_local");
  assert.equal(chamadas.preparar.length, 0);
  assert.equal(chamadas.enfileirar.length, 0);
});

test("job concluído sem documento local reenvia o resultado ao backend", async () => {
  const { deps, chamadas } = fakeDeps({
    itens: [{ numeroVenda: "V1" }],
    job: { id: 2, status: "CONCLUIDO", payload: "{}" },
  });
  const r = await dreno.executarCiclo(lerConfig, deps);
  assert.equal(r.resultados[0].acao, "callback_reenviado");
  assert.deepEqual(chamadas.sincronizar, ["V1"]);
});

test("vendas travadas no início não bloqueiam as mais novas (rodízio + cota por trabalho)", async () => {
  const itens = Array.from({ length: 6 }, (_, i) => ({
    numeroVenda: `V${i + 1}`,
    emitidoEm: `2026-10-05T10:0${i}:00`,
  }));
  let preparos = [];
  const { deps } = fakeDeps({
    itens,
    prepare: async (_c, n) => {
      preparos.push(n);
      throw Object.assign(new Error("Dados fiscais incompletos"), { status: 400 });
    },
  });
  await dreno.executarCiclo(lerConfig, deps);
  assert.deepEqual(preparos, ["V1", "V2", "V3"]);
  preparos = [];
  await dreno.executarCiclo(lerConfig, deps);
  assert.deepEqual(preparos, ["V4", "V5", "V6"], "travadas em backoff não ocupam a cota");
});

test("cursor: página cheia avança; página curta volta ao início", async () => {
  const pagina = (ini, n) =>
    Array.from({ length: n }, (_, i) => ({ numeroVenda: `P${ini + i}`, emitidoEm: `T${String(ini + i).padStart(3, "0")}` }));
  const { deps, chamadas } = fakeDeps({
    jobs: new Proxy({}, { get: () => ({ id: 1, status: "PROCESSANDO" }) }),
    paginas: (apos) => (apos ? pagina(100, 3) : pagina(0, 20)),
  });
  let r = await dreno.executarCiclo(lerConfig, deps);
  assert.equal(r.cursor, "T019");
  r = await dreno.executarCiclo(lerConfig, deps);
  assert.equal(chamadas.listar[1].apos, "T019");
  assert.equal(r.cursor, null);
  await dreno.executarCiclo(lerConfig, deps);
  assert.equal(chamadas.listar[2].apos, null);
});

test("classificarFalha", () => {
  const c = dreno.classificarFalha;
  assert.equal(c("ACBr_OFFLINE_TIMEOUT"), "consulta_esgotada");
  assert.equal(c("cStat 539 Duplicidade"), "duplicidade");
  assert.equal(c("NFC-e rejeitada (cStat 225): Falha no Schema XML"), "definitiva");
  assert.equal(c("NFC-e rejeitada (cStat 999): SEFAZ indisponível"), "transitoria");
  assert.equal(c("Rejeição cStat 108: Serviço paralisado momentaneamente"), "transitoria");
  assert.equal(c("cStat 656: Consumo indevido"), "transitoria");
  assert.equal(c("Timeout na comunicação"), "transitoria");
  assert.equal(c("ECONNRESET"), "transitoria");
  assert.equal(c("Cancelado manualmente pelo operador"), "definitiva");
  assert.equal(c("NCM inexistente"), "definitiva");
});

test("rejeição definitiva com o mesmo INI aguarda correção do cadastro", async () => {
  const job = {
    id: 3,
    status: "FALHA_PERMANENTE",
    erro: "NFC-e rejeitada (cStat 778): NCM inexistente",
    payload: JSON.stringify({ documentIni: INI.replace("10:00:00", "09:00:00") }),
  };
  const { deps, chamadas } = fakeDeps({ itens: [{ numeroVenda: "V1" }], job });
  const r = await dreno.executarCiclo(lerConfig, deps);
  assert.equal(r.resultados[0].acao, "aguardando_correcao_cadastro");
  assert.equal(chamadas.reabrirEmissao.length, 0);
});

test("rejeição definitiva com INI corrigido reabre a emissão", async () => {
  const job = {
    id: 3,
    status: "FALHA_PERMANENTE",
    erro: "NFC-e rejeitada (cStat 778): NCM inexistente",
    payload: JSON.stringify({ documentIni: INI.replace("22021000", "99999999") }),
  };
  const { deps, chamadas } = fakeDeps({ itens: [{ numeroVenda: "V1" }], job });
  const r = await dreno.executarCiclo(lerConfig, deps);
  assert.equal(r.resultados[0].acao, "reemissao_reaberta");
  assert.equal(chamadas.reabrirEmissao.length, 1);
});

test("backoff: venda tentada não é preparada de novo no ciclo seguinte", async () => {
  const falha = Object.assign(new Error("Dados fiscais incompletos"), { status: 400 });
  let preparos = 0;
  const { deps } = fakeDeps({
    itens: [{ numeroVenda: "V1" }],
    prepare: async () => {
      preparos += 1;
      throw falha;
    },
  });
  let r = await dreno.executarCiclo(lerConfig, deps);
  assert.equal(r.resultados[0].acao, "prepare_falhou");
  r = await dreno.executarCiclo(lerConfig, deps);
  assert.equal(r.resultados[0].acao, "aguardando_backoff");
  assert.equal(preparos, 1);
  deps.avancar(61_000);
  await dreno.executarCiclo(lerConfig, deps);
  assert.equal(preparos, 2);
});

test("fila do agente cheia: não puxa mais vendas", async () => {
  const { deps, chamadas } = fakeDeps({ itens: [{ numeroVenda: "V1" }], ativas: 5 });
  const r = await dreno.executarCiclo(lerConfig, deps);
  assert.equal(r.motivo, "fila_cheia");
  assert.equal(chamadas.preparar.length, 0);
});

test("hashIni ignora dhEmi (reescrito na emissão)", () => {
  assert.equal(dreno.hashIni(INI), dreno.hashIni(INI.replace("10:00:00", "23:59:59")));
  assert.notEqual(dreno.hashIni(INI), dreno.hashIni(INI.replace("22021000", "11111111")));
});

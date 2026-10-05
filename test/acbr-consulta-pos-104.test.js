/**
 * cStat 104 sem protNFe: consultas por chave escalonadas em vez de espera fixa de 15 s.
 */
const assert = require("assert");
const { test } = require("node:test");

const acbr = require("../acbr");

const CHAVE = "35260512345678000195650010000001231000001234";

function lote104() {
  return { chave: CHAVE, cStat: "104", todosCStat: ["104"], xml: null };
}

test("autoriza na primeira consulta após 1,5 s — não espera 15 s", async () => {
  const esperas = [];
  const r = await acbr.enrichParsePosEmissaoAsync(lote104(), "CStat=104\nXMotivo=Lote processado", {
    dormir: async (ms) => esperas.push(ms),
    consultar: async () => ({ cStat: "100", protocolo: "135260000000001", situacao: "AUTORIZADA" }),
  });
  assert.equal(r.cStat, "100");
  assert.equal(r.protocolo, "135260000000001");
  assert.deepEqual(esperas, [1500]);
});

test("217 (ainda não indexada) repete até autorizar", async () => {
  const esperas = [];
  const respostas = [{ cStat: "217" }, { cStat: "217" }, { cStat: "100", protocolo: "1" }];
  const r = await acbr.enrichParsePosEmissaoAsync(lote104(), "CStat=104", {
    dormir: async (ms) => esperas.push(ms),
    consultar: async () => respostas.shift(),
  });
  assert.equal(r.cStat, "100");
  assert.deepEqual(esperas, [1500, 3000, 5000]);
});

test("sem autorização dentro do teto segue INCERTO (cStat 104) — nunca rejeita", async () => {
  const esperas = [];
  let consultas = 0;
  const r = await acbr.enrichParsePosEmissaoAsync(lote104(), "CStat=104", {
    dormir: async (ms) => esperas.push(ms),
    consultar: async () => {
      consultas += 1;
      return { cStat: "217" };
    },
  });
  assert.equal(r.cStat, "104");
  assert.equal(consultas, 4);
  assert.ok(esperas.reduce((a, b) => a + b, 0) <= 15500);
  assert.throws(() => acbr.assertAutorizada(r, "CStat=104", 65), (e) => e.incerto === true);
});

test("consumo indevido (656) encerra as consultas imediatamente", async () => {
  let consultas = 0;
  const r = await acbr.enrichParsePosEmissaoAsync(lote104(), "CStat=104", {
    dormir: async () => {},
    consultar: async () => {
      consultas += 1;
      return { cStat: "656" };
    },
  });
  assert.equal(consultas, 1);
  assert.equal(r.cStat, "104");
});

test("falha de rede na consulta não aborta os próximos passos", async () => {
  let n = 0;
  const r = await acbr.enrichParsePosEmissaoAsync(lote104(), "CStat=104", {
    dormir: async () => {},
    consultar: async () => {
      n += 1;
      if (n === 1) throw new Error("ECONNRESET");
      return { cStat: "100", protocolo: "9" };
    },
  });
  assert.equal(r.cStat, "100");
  assert.equal(n, 2);
});

test("FISCAL_CONSULTA_POS_104_MS legado mantém espera única", async () => {
  const antes = process.env.FISCAL_CONSULTA_POS_104_MS;
  process.env.FISCAL_CONSULTA_POS_104_MS = "15000";
  try {
    const esperas = [];
    await acbr.enrichParsePosEmissaoAsync(lote104(), "CStat=104", {
      dormir: async (ms) => esperas.push(ms),
      consultar: async () => ({ cStat: "217" }),
    });
    assert.deepEqual(esperas, [15000]);
  } finally {
    if (antes === undefined) delete process.env.FISCAL_CONSULTA_POS_104_MS;
    else process.env.FISCAL_CONSULTA_POS_104_MS = antes;
  }
});

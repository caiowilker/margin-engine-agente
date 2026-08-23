/**
 * Flush offline + kill switch: documentIni com IBSCBS → ub-status false → sem IBSCBS.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../fiscal/reformaUbFlushPolicy");

const INI_COM_UB = `
[Identificacao]
mod=65

[IBSCBS001]
CST=000
cClassTrib=000001

[gIBSCBS001]
vBC=100.00

[gCBS001]
pCBS=0.90
vCBS=0.90

[Total]
vNF=100.00

[IBSCBSTot]
vBCIBSCBS=100.00
`.trim();

test("MARKER de invariante presente", () => {
  assert.equal(policy.MARKER, "REFORMA_UB_FLUSH_REVALIDATION=1");
});

test("removerGrupoUb elimina seções IBSCBS", () => {
  assert.equal(policy.contemGrupoUb(INI_COM_UB), true);
  const limpo = policy.removerGrupoUb(INI_COM_UB);
  assert.equal(policy.contemGrupoUb(limpo), false);
  assert.match(limpo, /\[Total\]/);
  assert.match(limpo, /vNF=100.00/);
});

test("flush: kill switch (ubPermitido=false) sanitiza documentIni enfileirado", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ geradoEm: new Date().toISOString(), ubPermitido: false }),
  });
  try {
    const out = await policy.aplicarPoliticaLiveFlush(
      { backendUrl: "http://localhost:8080", backendToken: "t" },
      INI_COM_UB,
    );
    assert.equal(out.sanitizado, true);
    assert.equal(out.motivo, "ub_nao_permitido_live");
    assert.equal(policy.contemGrupoUb(out.ini), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("flush: ubPermitido=true preserva IBSCBS", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ ubPermitido: true }),
  });
  try {
    const out = await policy.aplicarPoliticaLiveFlush(
      { backendUrl: "http://localhost:8080", backendToken: "t" },
      INI_COM_UB,
    );
    assert.equal(out.sanitizado, false);
    assert.equal(policy.contemGrupoUb(out.ini), true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("flush: backend inacessível fail-closed remove IBSCBS", async () => {
  const out = await policy.aplicarPoliticaLiveFlush(
    { backendUrl: "", backendToken: "" },
    INI_COM_UB,
  );
  assert.equal(out.sanitizado, true);
  assert.equal(out.motivo, "backend_inacessivel_fail_closed");
  assert.equal(policy.contemGrupoUb(out.ini), false);
});

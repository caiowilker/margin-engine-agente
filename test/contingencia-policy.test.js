/**
 * Testes — política de encerramento automático de contingência.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  decidirEncerrarAutomatico,
  contarPendentesBloqueantes,
} = require("../contingenciaPolicy");

test("não encerra se contingência inativa", () => {
  const r = decidirEncerrarAutomatico({
    ativa: false,
    epecPendentes: 0,
    sefazOk: true,
  });
  assert.equal(r.podeEncerrar, false);
  assert.equal(r.motivo, "contingencia_inativa");
});

test("não encerra se SEFAZ ainda indisponível", () => {
  const r = decidirEncerrarAutomatico({
    ativa: true,
    epecPendentes: 0,
    sefazOk: false,
  });
  assert.equal(r.podeEncerrar, false);
  assert.equal(r.motivo, "sefaz_indisponivel");
});

test("não encerra se ainda há EPEC pendente", () => {
  const r = decidirEncerrarAutomatico({
    ativa: true,
    epecPendentes: 2,
    sefazOk: true,
  });
  assert.equal(r.podeEncerrar, false);
  assert.equal(r.motivo, "epec_pendentes");
});

test("encerra automaticamente com SEFAZ ok e zero pendentes", () => {
  const r = decidirEncerrarAutomatico({
    ativa: true,
    epecPendentes: 0,
    sefazOk: true,
  });
  assert.equal(r.podeEncerrar, true);
  assert.equal(r.motivo, "sefaz_ok_sem_pendentes");
});

test("force do operador encerra mesmo com pendentes / SEFAZ down", () => {
  const r = decidirEncerrarAutomatico({
    ativa: true,
    epecPendentes: 5,
    sefazOk: false,
    force: true,
  });
  assert.equal(r.podeEncerrar, true);
  assert.equal(r.motivo, "force_operador");
});

test("contarPendentesBloqueantes ignora FALHA_PERMANENTE", () => {
  assert.equal(
    contarPendentesBloqueantes([
      { status: "PENDENTE" },
      { status: "FALHA_PERMANENTE" },
      { status: "TRANSMITIDO" },
      { status: "PENDENTE" },
    ]),
    2,
  );
});

const test = require("node:test");
const assert = require("node:assert/strict");

test("acbrLibSession invalida e recria fingerprint", async () => {
  const session = require("../fiscal/drivers/acbrLibSession");
  await session.invalidateNativeSession("test");
  session.invalidateRuntimeCache();
  const st = session.getSessionStatus();
  assert.equal(st.ativa, false);
});

test("logSuggestions retorna ação operacional", () => {
  const { sugerirParaErro } = require("../runtime/logSuggestions");
  const s = sugerirParaErro("Certificado A1 expirado");
  assert.match(s.acaoRecomendada, /Configuração Fiscal/i);
  assert.match(s.causa, /Certificado/i);
  assert.doesNotMatch(JSON.stringify(s), /stack|ACBrLib|DLL/i);
});

test("diagnosticoEnterprise calcula status ONLINE", () => {
  const { calcularStatusGeralEnterprise } = require("../diagnosticoEnterprise");
  assert.equal(
    calcularStatusGeralEnterprise({
      acbr: "online",
      bancoOk: true,
      manifestOk: true,
      impressoraOk: true,
      atualizando: false,
      contingenciaAtiva: false,
      recuperando: 0,
      incertos: 0,
      incertosComBackoff: 0,
      discoCritico: false,
    }),
    "ONLINE",
  );
});

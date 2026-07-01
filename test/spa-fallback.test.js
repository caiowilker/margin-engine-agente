const assert = require("node:assert/strict");
const test = require("node:test");

/** Espelha o regex em index.js — rotas API não podem cair no SPA. */
const SPA_FALLBACK =
  /^(?!\/api|\/api-proxy|\/status|\/health|\/venda|\/fila|\/impressora|\/acbr|\/ativar|\/auth|\/config|\/contingencia|\/diagnostico|\/updater|\/fiscal).*$/;

test("SPA fallback não intercepta rotas API do agente", () => {
  const apiPaths = [
    "/health",
    "/status-basico",
    "/fiscal/emissao/abc-123",
    "/fiscal/status/abc-123",
    "/fiscal/emitir",
    "/api-proxy/auth/login",
    "/venda",
    "/fila/fiscal",
    "/impressora/status",
    "/acbr/fiscal/preflight",
    "/config/fiscal",
    "/contingencia/status",
    "/diagnostico",
    "/updater/status",
  ];
  for (const p of apiPaths) {
    assert.equal(
      SPA_FALLBACK.test(p),
      false,
      `SPA não deve capturar ${p}`,
    );
  }
});

test("SPA fallback serve rotas do painel React", () => {
  const spaPaths = ["/", "/pdv", "/pdv/caixa", "/login", "/pdv/diagnostico"];
  for (const p of spaPaths) {
    assert.equal(SPA_FALLBACK.test(p), true, `SPA deve capturar ${p}`);
  }
});

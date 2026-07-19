const test = require("node:test");
const assert = require("node:assert/strict");

const LOCALHOST_RX = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
const CORS_ORIGENS_PADRAO = [
  "https://app.marginengine.com.br",
  "https://www.marginengine.com.br",
  "https://staging.marginengine.com.br",
];

/** Espelha a política de index.js — evita regressão do Failed to fetch pós-PIX. */
function isCorsOriginAllowed(origin, opts = {}) {
  const CORS_ORIGENS_ENV = opts.envOrigins || [];
  const cfg = opts.cfg || {};
  if (!origin) return true;
  if (LOCALHOST_RX.test(origin)) return true;
  if (CORS_ORIGENS_ENV.includes(origin)) return true;
  if (CORS_ORIGENS_PADRAO.includes(origin)) return true;
  if (cfg.frontendOrigin && origin === cfg.frontendOrigin) return true;
  if (CORS_ORIGENS_ENV.length === 0 && !cfg.frontendOrigin) return true;
  return false;
}

test("permite app.marginengine.com.br mesmo com frontendOrigin de outro host", () => {
  assert.equal(
    isCorsOriginAllowed("https://app.marginengine.com.br", {
      cfg: { frontendOrigin: "http://localhost:5173" },
    }),
    true,
  );
});

test("bloqueia origem desconhecida quando frontendOrigin já está configurado", () => {
  assert.equal(
    isCorsOriginAllowed("https://evil.example.com", {
      cfg: { frontendOrigin: "http://localhost:5173" },
    }),
    false,
  );
});

test("permite localhost e origem gravada na ativação", () => {
  assert.equal(isCorsOriginAllowed("http://localhost:5173"), true);
  assert.equal(
    isCorsOriginAllowed("https://cliente.exemplo.com", {
      cfg: { frontendOrigin: "https://cliente.exemplo.com" },
    }),
    true,
  );
});

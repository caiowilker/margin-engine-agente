const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

function privateNetworkHeaders(req, res, next) {
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Agent-Token, X-Correlation-Id, X-Fiscal-Sync",
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, PUT, PATCH, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
}

test("preflight OPTIONS permite PUT e DELETE com Private Network", async () => {
  const app = express();
  app.options("*", privateNetworkHeaders, (_req, res) => res.status(204).end());
  app.put("/storage/produtos/:id/imagem", privateNetworkHeaders, (_req, res) => res.json({ ok: true }));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = server.address().port;

  try {
    const resp = await fetch(`http://127.0.0.1:${port}/storage/produtos/x/imagem`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.marginengine.com.br",
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    assert.equal(resp.status, 204);
    const methods = resp.headers.get("access-control-allow-methods") || "";
    assert.match(methods, /PUT/);
    assert.match(methods, /DELETE/);
    assert.equal(resp.headers.get("access-control-allow-private-network"), "true");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

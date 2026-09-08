const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { healthProbe, healthOk } = require("../scripts/installer-wait-online");

describe("installer-wait-online — healthProbe fail-closed", () => {
  it("aceita só JSON com ok e ui.ok true", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, versao: "1.0.17", ui: { ok: true } }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address();
    const h = await healthProbe(port);
    assert.ok(h);
    assert.equal(h.versao, "1.0.17");
    assert.equal(await healthOk(port), true);
    server.close();
  });

  it("rejeita body não-JSON", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>spa</html>");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address();
    assert.equal(await healthProbe(port), null);
    assert.equal(await healthOk(port), false);
    server.close();
  });

  it("rejeita ui.ok false ou ausente", async () => {
    const payloads = [
      { ok: true, ui: { ok: false } },
      { ok: true },
      { ok: false, ui: { ok: true } },
    ];
    for (const body of payloads) {
      const server = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const { port } = server.address();
      assert.equal(await healthProbe(port), null, JSON.stringify(body));
      server.close();
    }
  });
});

/**
 * Testes — autodiagnóstico LAN (bind / reachability helpers).
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const {
  getListeningAddress,
  probeTcp,
  buildLanDiagnostics,
} = require("../lanDiagnostics");

test("getListeningAddress lê address() do server", async () => {
  const server = http.createServer((_req, res) => {
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  const addr = getListeningAddress(server);
  assert.ok(addr);
  assert.equal(addr.address, "0.0.0.0");
  assert.ok(addr.port > 0);
  const ok = await probeTcp("127.0.0.1", addr.port);
  assert.equal(ok, true);
  await new Promise((resolve) => server.close(resolve));
});

test("buildLanDiagnostics — bind 0.0.0.0 marca bindOk", async () => {
  const server = http.createServer((_req, res) => res.end("ok"));
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  const port = server.address().port;
  const diag = await buildLanDiagnostics({
    server,
    configuredBindHost: "0.0.0.0",
    lanIp: null,
    port,
    lanStaffAccess: true,
    ensureFirewall: false,
  });
  assert.equal(diag.bindOk, true);
  assert.match(diag.bindMessage, /0\.0\.0\.0/);
  assert.equal(diag.loopbackOk, true);
  await new Promise((resolve) => server.close(resolve));
});

test("buildLanDiagnostics — bind 127.0.0.1 marca bindOk=false", async () => {
  const server = http.createServer((_req, res) => res.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const diag = await buildLanDiagnostics({
    server,
    configuredBindHost: "127.0.0.1",
    lanIp: null,
    port,
    lanStaffAccess: true,
    ensureFirewall: false,
  });
  assert.equal(diag.bindOk, false);
  assert.match(diag.bindMessage, /localhost|127\.0\.0\.1/i);
  await new Promise((resolve) => server.close(resolve));
});

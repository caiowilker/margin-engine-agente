const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("http");
const { EventEmitter } = require("events");

const {
  criarApiProxy,
  anexarProxyWebSocket,
  resolverBackendUrlPadrao,
} = require("../apiProxy");

test("resolverBackendUrlPadrao respeita DEFAULT_BACKEND_URL", () => {
  const prev = process.env.DEFAULT_BACKEND_URL;
  process.env.DEFAULT_BACKEND_URL = "https://app.marginengine.com.br";
  try {
    assert.equal(resolverBackendUrlPadrao(), "https://app.marginengine.com.br");
  } finally {
    if (prev === undefined) delete process.env.DEFAULT_BACKEND_URL;
    else process.env.DEFAULT_BACKEND_URL = prev;
  }
});

test("criarApiProxy encaminha POST /auth/login para backend configurado", async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ accessToken: "a", refreshToken: "r" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const proxy = criarApiProxy({
    lerConfigSync: () => ({ backendUrl: "https://app.marginengine.com.br" }),
  });

  const req = {
    method: "POST",
    url: "/auth/login",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: { email: "a@b.com", password: "x" },
  };

  let statusCode = 0;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    setHeader() {},
    send() {},
    json() {},
    end() {},
  };

  try {
    await proxy(req, res);
    assert.equal(statusCode, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://app.marginengine.com.br/auth/login");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.body, JSON.stringify(req.body));
  } finally {
    global.fetch = originalFetch;
  }
});

test("criarApiProxy responde 204 em OPTIONS", async () => {
  const proxy = criarApiProxy({ lerConfigSync: () => ({}) });
  let statusCode = 0;
  let ended = false;
  await proxy(
    { method: "OPTIONS", url: "/auth/login", headers: {} },
    {
      status(code) {
        statusCode = code;
        return this;
      },
      end() {
        ended = true;
      },
      setHeader() {},
      send() {},
      json() {},
    },
  );
  assert.equal(statusCode, 204);
  assert.equal(ended, true);
});

test("anexarProxyWebSocket registra upgrade e rejeita não-localhost", async () => {
  const server = new EventEmitter();
  let allowedCalls = 0;
  anexarProxyWebSocket(server, {
    lerConfigSync: () => ({ backendUrl: "http://127.0.0.1:18080" }),
    isAllowed: () => {
      allowedCalls += 1;
      return false;
    },
  });

  assert.equal(server.listenerCount("upgrade"), 1);

  const chunks = [];
  const socket = {
    destroyed: false,
    write(data) {
      chunks.push(String(data));
    },
    destroy() {
      this.destroyed = true;
    },
    pipe() {
      return this;
    },
    on() {
      return this;
    },
  };

  server.emit(
    "upgrade",
    {
      url: "/api-proxy/ws/print-station?token=abc",
      headers: { upgrade: "websocket", connection: "Upgrade" },
    },
    socket,
    Buffer.alloc(0),
  );

  assert.equal(allowedCalls, 1);
  assert.ok(chunks.some((c) => c.includes("403")));
  assert.equal(socket.destroyed, true);
});

test("anexarProxyWebSocket ignora paths fora de /api-proxy/ws", () => {
  const server = new EventEmitter();
  let allowedCalls = 0;
  anexarProxyWebSocket(server, {
    lerConfigSync: () => ({ backendUrl: "http://127.0.0.1:18080" }),
    isAllowed: () => {
      allowedCalls += 1;
      return true;
    },
  });

  const socket = {
    destroyed: false,
    write() {},
    destroy() {
      this.destroyed = true;
    },
  };

  server.emit("upgrade", { url: "/other", headers: {} }, socket, Buffer.alloc(0));
  assert.equal(allowedCalls, 0);
  assert.equal(socket.destroyed, false);
});

test("anexarProxyWebSocket encaminha upgrade /api-proxy/ws/print-station", async () => {
  const upstream = http.createServer();
  const upgradeHits = [];
  upstream.on("upgrade", (req, socket) => {
    upgradeHits.push(req.url);
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
    socket.end();
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const { port } = upstream.address();

  const proxyServer = http.createServer((_req, res) => res.end("ok"));
  anexarProxyWebSocket(proxyServer, {
    lerConfigSync: () => ({ backendUrl: `http://127.0.0.1:${port}` }),
    isAllowed: () => true,
  });
  await new Promise((resolve) => proxyServer.listen(0, "127.0.0.1", resolve));
  const proxyPort = proxyServer.address().port;

  try {
    const response = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port: proxyPort,
        path: "/api-proxy/ws/print-station?token=t&stations=cozinha",
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version": "13",
        },
      });
      req.on("upgrade", (_res, socket) => {
        socket.destroy();
        resolve("upgraded");
      });
      req.on("error", reject);
      req.on("response", (res) => {
        reject(new Error(`expected upgrade, got HTTP ${res.statusCode}`));
      });
      req.end();
    });

    assert.equal(response, "upgraded");
    assert.equal(upgradeHits.length, 1);
    assert.match(upgradeHits[0], /^\/ws\/print-station\?/);
  } finally {
    await new Promise((r) => proxyServer.close(r));
    await new Promise((r) => upstream.close(r));
  }
});

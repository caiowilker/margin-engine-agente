const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("http");
const { EventEmitter } = require("events");

const {
  criarApiProxy,
  anexarProxyWebSocket,
  resolverBackendUrlPadrao,
} = require("../apiProxy");

test("normalizeBackendUrl remapeia app.* para api.*", () => {
  const { normalizeBackendUrl, PRODUCTION_API_URL } = require("../apiProxy");
  assert.equal(
    normalizeBackendUrl("https://app.marginengine.com.br"),
    PRODUCTION_API_URL,
  );
  assert.equal(
    normalizeBackendUrl("https://www.marginengine.com.br/"),
    PRODUCTION_API_URL,
  );
  assert.equal(
    normalizeBackendUrl("https://api.marginengine.com.br"),
    "https://api.marginengine.com.br",
  );
});

test("normalizeBackendUrl remapeia IP LAN morto para api.* em produção", () => {
  const { normalizeBackendUrl, PRODUCTION_API_URL } = require("../apiProxy");
  const prevNode = process.env.NODE_ENV;
  const prevAllow = process.env.ALLOW_PRIVATE_BACKEND;
  process.env.NODE_ENV = "production";
  delete process.env.ALLOW_PRIVATE_BACKEND;
  try {
    assert.equal(
      normalizeBackendUrl("http://172.26.126.223:8080"),
      PRODUCTION_API_URL,
    );
    assert.equal(
      normalizeBackendUrl("http://192.168.1.10:8080"),
      PRODUCTION_API_URL,
    );
  } finally {
    if (prevNode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNode;
    if (prevAllow === undefined) delete process.env.ALLOW_PRIVATE_BACKEND;
    else process.env.ALLOW_PRIVATE_BACKEND = prevAllow;
  }
});

test("normalizeBackendUrl preserva IP LAN com ALLOW_PRIVATE_BACKEND=1", () => {
  const { normalizeBackendUrl } = require("../apiProxy");
  const prevNode = process.env.NODE_ENV;
  const prevAllow = process.env.ALLOW_PRIVATE_BACKEND;
  process.env.NODE_ENV = "production";
  process.env.ALLOW_PRIVATE_BACKEND = "1";
  try {
    assert.equal(
      normalizeBackendUrl("http://172.26.126.223:8080"),
      "http://172.26.126.223:8080",
    );
  } finally {
    if (prevNode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNode;
    if (prevAllow === undefined) delete process.env.ALLOW_PRIVATE_BACKEND;
    else process.env.ALLOW_PRIVATE_BACKEND = prevAllow;
  }
});

test("resolverBackendUrlPadrao respeita DEFAULT_BACKEND_URL e normaliza app→api", () => {
  const prev = process.env.DEFAULT_BACKEND_URL;
  process.env.DEFAULT_BACKEND_URL = "https://app.marginengine.com.br";
  try {
    assert.equal(resolverBackendUrlPadrao(), "https://api.marginengine.com.br");
  } finally {
    if (prev === undefined) delete process.env.DEFAULT_BACKEND_URL;
    else process.env.DEFAULT_BACKEND_URL = prev;
  }
});

test("criarApiProxy encaminha POST /auth/login para API (não SPA app.*)", async () => {
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
    assert.equal(calls[0].url, "https://api.marginengine.com.br/auth/login");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.body, JSON.stringify(req.body));
  } finally {
    global.fetch = originalFetch;
  }
});

test("criarApiProxy encaminha body bruto multipart (importar-xml)", async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const proxy = criarApiProxy({
    lerConfigSync: () => ({ backendUrl: "https://api.marginengine.com.br" }),
  });

  const boundary = "----BoundForm";
  const raw = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="n.xml"\r\n\r\n<xml/>\r\n--${boundary}--\r\n`,
  );

  async function* gen() {
    yield raw;
  }

  const req = {
    method: "POST",
    url: "/pdv/notas-entrada/importar-xml",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      authorization: "Bearer tok",
    },
    readableEnded: false,
    complete: false,
    [Symbol.asyncIterator]: gen,
  };

  const res = {
    status() {
      return this;
    },
    setHeader() {},
    send() {},
    json() {},
    end() {},
  };

  try {
    await proxy(req, res);
    assert.equal(calls.length, 1);
    assert.ok(Buffer.isBuffer(calls[0].init.body));
    assert.ok(calls[0].init.body.includes(Buffer.from("<xml/>")));
    assert.equal(calls[0].init.headers.authorization, "Bearer tok");
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

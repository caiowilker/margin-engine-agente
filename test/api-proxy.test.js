const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("http");
const https = require("https");
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

/** Upstream real em 127.0.0.1; handler recebe (req, res, corpo, socketReqIndex). */
async function subirUpstream(handler) {
  const chamadas = [];
  const server = http.createServer((req, res) => {
    const socket = req.socket;
    socket.__reqs = (socket.__reqs || 0) + 1;
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const corpo = Buffer.concat(chunks);
      chamadas.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        corpo,
        porta: socket.remotePort,
        indiceNoSocket: socket.__reqs,
      });
      handler(req, res, corpo, socket.__reqs);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    chamadas,
    fechar: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(r);
      }),
  };
}

/** Proxy num http.Server com o mínimo de Express que ele usa (status/json + express.json). */
async function subirProxy(backendUrl, { parseJson = true } = {}) {
  const proxy = criarApiProxy({ lerConfigSync: () => ({ backendUrl }) });
  const server = http.createServer(async (req, res) => {
    res.status = (code) => {
      res.statusCode = code;
      return res;
    };
    res.json = (obj) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(obj));
    };
    req.url = req.url.replace(/^\/api-proxy/, "");
    const ct = String(req.headers["content-type"] || "");
    if (parseJson && ct.includes("application/json")) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      req.body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    }
    await proxy(req, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}/api-proxy`,
    fechar: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(r);
      }),
  };
}

test("criarApiProxy encaminha POST /auth/login para API (não SPA app.*)", async () => {
  const calls = [];
  const originalRequest = https.request;
  https.request = (opts) => {
    calls.push(opts);
    const req = new EventEmitter();
    req.reusedSocket = false;
    req.end = (body) => {
      calls[calls.length - 1].body = body;
      const res = new (require("stream").PassThrough)();
      res.statusCode = 200;
      res.headers = { "content-type": "application/json" };
      res.complete = true;
      setImmediate(() => {
        req.emit("response", res);
        res.end('{"accessToken":"a"}');
      });
    };
    req.destroy = () => {};
    return req;
  };

  const proxy = criarApiProxy({
    lerConfigSync: () => ({ backendUrl: "https://app.marginengine.com.br" }),
  });
  const { PassThrough } = require("stream");
  const res = new PassThrough();
  let statusCode = 0;
  res.status = (code) => {
    statusCode = code;
    return res;
  };
  res.setHeader = () => {};
  res.json = () => {};
  const body = { email: "a@b.com", password: "x" };
  try {
    await proxy(
      {
        method: "POST",
        url: "/auth/login",
        headers: { "content-type": "application/json", accept: "application/json" },
        body,
      },
      res,
    );
    assert.equal(statusCode, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].hostname, "api.marginengine.com.br");
    assert.equal(calls[0].path, "/auth/login");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].body, JSON.stringify(body));
    assert.equal(calls[0].agent.keepAlive, true);
  } finally {
    https.request = originalRequest;
  }
});

test("criarApiProxy encaminha body bruto multipart (importar-xml)", async () => {
  const up = await subirUpstream((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
  });
  const px = await subirProxy(up.url, { parseJson: false });
  const boundary = "----BoundForm";
  const raw = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="n.xml"\r\n\r\n<xml/>\r\n--${boundary}--\r\n`,
  );
  try {
    const r = await fetch(`${px.url}/pdv/notas-entrada/importar-xml`, {
      method: "POST",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        authorization: "Bearer tok",
      },
      body: raw,
    });
    assert.equal(r.status, 200);
    assert.equal(up.chamadas.length, 1);
    assert.ok(up.chamadas[0].corpo.equals(raw));
    assert.equal(up.chamadas[0].headers.authorization, "Bearer tok");
  } finally {
    await px.fechar();
    await up.fechar();
  }
});

test("criarApiProxy repassa Idempotency-Key, X-Supervisor-Token, If-Match e If-None-Match", async () => {
  const up = await subirUpstream((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("etag", '"7"');
    res.end('{"ok":true}');
  });
  const px = await subirProxy(up.url);
  try {
    const r = await fetch(`${px.url}/pdv/crediario/parcelas/abc/receber`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer tok",
        "idempotency-key": "chave-1",
        "x-supervisor-token": "sup-1",
        "if-match": '"3"',
        "if-none-match": '"2"',
        "x-current-refresh-token": "rt-1",
      },
      body: JSON.stringify({ valor: 10 }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("etag"), '"7"');
    const h = up.chamadas[0].headers;
    assert.equal(h["idempotency-key"], "chave-1");
    assert.equal(h["x-supervisor-token"], "sup-1");
    assert.equal(h["if-match"], '"3"');
    assert.equal(h["if-none-match"], '"2"');
    assert.equal(h["x-current-refresh-token"], "rt-1");
    assert.equal(up.chamadas[0].corpo.toString(), '{"valor":10}');
    assert.equal(h["content-length"], "12");
  } finally {
    await px.fechar();
    await up.fechar();
  }
});

test("criarApiProxy reaproveita a conexão com o backend (keep-alive)", async () => {
  const up = await subirUpstream((_req, res) => res.end("ok"));
  const px = await subirProxy(up.url);
  try {
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${px.url}/pdv/caixa/status`);
      assert.equal(await r.text(), "ok");
    }
    assert.equal(up.chamadas.length, 3);
    assert.equal(new Set(up.chamadas.map((c) => c.porta)).size, 1);
    assert.equal(up.chamadas[2].indiceNoSocket, 3);
  } finally {
    await px.fechar();
    await up.fechar();
  }
});

test("criarApiProxy faz streaming: primeiro pedaço chega antes do backend terminar", async () => {
  let terminar;
  const up = await subirUpstream((_req, res) => {
    res.setHeader("content-type", "text/plain");
    res.write("parte-1;");
    terminar = () => res.end("parte-2");
  });
  const px = await subirProxy(up.url);
  try {
    const r = await fetch(`${px.url}/pdv/relatorios/grande`);
    const leitor = r.body.getReader();
    const primeiro = await leitor.read();
    assert.equal(Buffer.from(primeiro.value).toString(), "parte-1;");
    terminar();
    let resto = "";
    for (;;) {
      const { value, done } = await leitor.read();
      if (done) break;
      resto += Buffer.from(value).toString();
    }
    assert.equal(resto, "parte-2");
  } finally {
    await px.fechar();
    await up.fechar();
  }
});

test("criarApiProxy repete uma vez GET em socket velho; POST sem Idempotency-Key não", async () => {
  const up = await subirUpstream((req, res, _corpo, indice) => {
    if (indice > 1) {
      req.socket.destroy();
      return;
    }
    res.end(`ok-${req.method}`);
  });
  const px = await subirProxy(up.url);
  try {
    assert.equal(await (await fetch(`${px.url}/a`)).text(), "ok-GET");
    const r = await fetch(`${px.url}/b`);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "ok-GET");
    assert.equal(up.chamadas.filter((c) => c.url === "/b").length, 2);

    const post = await fetch(`${px.url}/pdv/caixa/sangria`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(post.status, 502);
    assert.equal(up.chamadas.filter((c) => c.url === "/pdv/caixa/sangria").length, 1);

    assert.equal(await (await fetch(`${px.url}/c`)).text(), "ok-GET");
    const postIdem = await fetch(`${px.url}/pdv/caixa/abrir`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "k" },
      body: "{}",
    });
    assert.equal(postIdem.status, 200);
    assert.equal(up.chamadas.filter((c) => c.url === "/pdv/caixa/abrir").length, 2);
  } finally {
    await px.fechar();
    await up.fechar();
  }
});

test("criarApiProxy cancela a chamada ao backend quando o cliente desiste", async () => {
  let upstreamFechou;
  const fechou = new Promise((r) => {
    upstreamFechou = r;
  });
  const up = await subirUpstream((req) => {
    req.socket.on("close", upstreamFechou);
  });
  const px = await subirProxy(up.url);
  try {
    const ctrl = new AbortController();
    const pend = fetch(`${px.url}/pdv/lento`, { signal: ctrl.signal }).catch((e) => e);
    while (up.chamadas.length === 0) await new Promise((r) => setTimeout(r, 10));
    ctrl.abort();
    await pend;
    await Promise.race([
      fechou,
      new Promise((_, rej) => setTimeout(() => rej(new Error("upstream não foi cancelado")), 2000)),
    ]);
  } finally {
    await px.fechar();
    await up.fechar();
  }
});

test("criarApiProxy responde 504 quando o backend estoura API_PROXY_TIMEOUT_MS", async () => {
  const prev = process.env.API_PROXY_TIMEOUT_MS;
  process.env.API_PROXY_TIMEOUT_MS = "150";
  const up = await subirUpstream(() => {});
  const px = await subirProxy(up.url);
  try {
    const r = await fetch(`${px.url}/pdv/caixa/status`);
    assert.equal(r.status, 504);
    assert.match((await r.json()).erro, /não respondeu a tempo/);
  } finally {
    if (prev === undefined) delete process.env.API_PROXY_TIMEOUT_MS;
    else process.env.API_PROXY_TIMEOUT_MS = prev;
    await px.fechar();
    await up.fechar();
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

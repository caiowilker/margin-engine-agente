const assert = require("node:assert/strict");
const test = require("node:test");

const { criarApiProxy, resolverBackendUrlPadrao } = require("../apiProxy");

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

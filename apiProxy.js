/**
 * Proxy same-origin /api-proxy -> backend Margin Engine.
 * Permite login e API no frontend servido em localhost:9100 sem CORS.
 */
const fs = require("fs");
const path = require("path");

const FALLBACK_DEV_BACKEND = "http://localhost:8080";

function lerBackendPadraoDoFrontend() {
  const jsonPath = path.join(__dirname, "frontend-dist", "api-backend.json");
  try {
    if (!fs.existsSync(jsonPath)) return null;
    const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    const url = String(data.apiUrl || "").replace(/\/$/, "");
    return url || null;
  } catch {
    return null;
  }
}

function resolverBackendUrlPadrao() {
  return (
    process.env.DEFAULT_BACKEND_URL ||
    process.env.API_PUBLIC_URL ||
    lerBackendPadraoDoFrontend() ||
    (process.env.NODE_ENV === "production"
      ? "https://app.marginengine.com.br"
      : FALLBACK_DEV_BACKEND)
  ).replace(/\/$/, "");
}

function criarApiProxy({ lerConfigSync }) {
  function resolverBackendUrl() {
    const cfg = lerConfigSync();
    const url =
      cfg.backendUrl ||
      process.env.BACKEND_URL ||
      resolverBackendUrlPadrao();
    return String(url).replace(/\/$/, "");
  }

  const encaminharHeaders = [
    "authorization",
    "content-type",
    "accept",
    "accept-language",
    "x-request-id",
    "x-tenant-id",
  ];

  return async function proxyApiParaBackend(req, res) {
    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }

    try {
      const backend = resolverBackendUrl();
      const suffix =
        req.url && req.url.startsWith("/") ? req.url : `/${req.url || ""}`;
      const target = `${backend}${suffix}`;

      const headers = {};
      for (const name of encaminharHeaders) {
        const val = req.headers[name];
        if (val) headers[name] = val;
      }

      const method = req.method.toUpperCase();
      const init = { method, headers };

      if (!["GET", "HEAD"].includes(method)) {
        const ct = String(req.headers["content-type"] || "");
        if (req.body != null) {
          init.body = ct.includes("application/json")
            ? JSON.stringify(req.body)
            : req.body;
        }
      }

      const upstream = await fetch(target, init);
      res.status(upstream.status);
      const omitir = new Set([
        "transfer-encoding",
        "connection",
        "content-encoding",
        "access-control-allow-origin",
      ]);
      upstream.headers.forEach((value, key) => {
        if (!omitir.has(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      res.send(body);
    } catch (err) {
      console.warn("[Agente] api-proxy:", err.message);
      res.status(502).json({
        erro: `Proxy para backend falhou: ${err.message}`,
        backendUrl: resolverBackendUrl(),
      });
    }
  };
}

module.exports = {
  criarApiProxy,
  resolverBackendUrlPadrao,
  lerBackendPadraoDoFrontend,
};

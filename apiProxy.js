/**
 * Proxy same-origin /api-proxy -> backend Margin Engine.
 * Permite login e API no frontend servido em localhost:9100 sem CORS.
 * Inclui túnel WebSocket para /api-proxy/ws/* (ex.: print-station).
 */
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");

const FALLBACK_DEV_BACKEND = "http://localhost:8080";
const PRODUCTION_API_URL = "https://api.marginengine.com.br";
const API_PROXY_PREFIX = "/api-proxy";

/**
 * Host do SPA (app.*) não é a API REST — remapeia como o front em apiBaseUrl.ts.
 * Sem isso o api-proxy devolve HTML do app e o PDV marca "Servidor indisponível".
 * @param {string} url
 */
/**
 * IP privado (RFC1918) — típico de WSL/LAN de desenvolvimento.
 * Em instalação com frontend de produção, esse host costuma estar morto
 * e o api-proxy devolve 502 (claim da print station falha; vasilhame local não).
 */
function isPrivateLanHostname(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return false;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

/** Lê api-backend.json sem normalize (evita recursão com IP LAN). */
function frontendDeclaresProductionApi() {
  const jsonPath = path.join(__dirname, "frontend-dist", "api-backend.json");
  try {
    if (!fs.existsSync(jsonPath)) return false;
    const raw = String(JSON.parse(fs.readFileSync(jsonPath, "utf8")).apiUrl || "")
      .trim()
      .toLowerCase();
    return (
      raw.includes("api.marginengine.com.br") ||
      raw.includes("app.marginengine.com.br")
    );
  } catch {
    return false;
  }
}

function wantsProductionBackend() {
  if (process.env.ALLOW_PRIVATE_BACKEND === "1") return false;
  if (process.env.NODE_ENV === "production") return true;
  return frontendDeclaresProductionApi();
}

function normalizeBackendUrl(url) {
  const u = String(url || "").trim().replace(/\/$/, "");
  if (!u) return u;
  try {
    const parsed = new URL(u);
    const host = parsed.hostname.toLowerCase();
    if (
      host === "app.marginengine.com.br" ||
      host === "www.marginengine.com.br" ||
      host === "marginengine.com.br"
    ) {
      return PRODUCTION_API_URL;
    }
    // PDV empacotado aponta para api.*; config antiga com IP WSL/LAN morto
    // quebra /api-proxy (502) e a print station — remapeia para produção.
    if (isPrivateLanHostname(host) && wantsProductionBackend()) {
      return PRODUCTION_API_URL;
    }
  } catch {
    /* URL relativa ou inválida — devolve como veio */
  }
  if (
    u === "https://app.marginengine.com.br" ||
    u === "http://app.marginengine.com.br"
  ) {
    return PRODUCTION_API_URL;
  }
  return u;
}

function lerBackendPadraoDoFrontend() {
  const jsonPath = path.join(__dirname, "frontend-dist", "api-backend.json");
  try {
    if (!fs.existsSync(jsonPath)) return null;
    const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    const url = normalizeBackendUrl(String(data.apiUrl || ""));
    return url || null;
  } catch {
    return null;
  }
}

function resolverBackendUrlPadrao() {
  return normalizeBackendUrl(
    process.env.DEFAULT_BACKEND_URL ||
      process.env.API_PUBLIC_URL ||
      lerBackendPadraoDoFrontend() ||
      (process.env.NODE_ENV === "production"
        ? PRODUCTION_API_URL
        : FALLBACK_DEV_BACKEND),
  );
}

function criarResolverBackendUrl(lerConfigSync) {
  return function resolverBackendUrl() {
    const cfg = lerConfigSync();
    const url =
      cfg.backendUrl ||
      process.env.BACKEND_URL ||
      resolverBackendUrlPadrao();
    return normalizeBackendUrl(String(url));
  };
}

/**
 * Lê o body bruto quando o Express ainda não consumiu o stream
 * (multipart / binary). Essencial para upload de XML via FormData.
 * @param {import('express').Request} req
 * @returns {Promise<Buffer|null>}
 */
async function lerBodyBruto(req) {
  if (req.readableEnded || req.complete) {
    return null;
  }
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return null;
  return Buffer.concat(chunks);
}

function criarApiProxy({ lerConfigSync }) {
  const resolverBackendUrl = criarResolverBackendUrl(lerConfigSync);

  const encaminharHeaders = [
    "authorization",
    "content-type",
    "accept",
    "accept-language",
    "x-request-id",
    "x-correlation-id",
    "x-tenant-id",
    "x-store-floor-session",
    "x-margin-floor-session",
    "x-agent-token",
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
      const ct = String(req.headers["content-type"] || "").toLowerCase();

      if (!["GET", "HEAD"].includes(method)) {
        if (ct.includes("application/json") && req.body != null) {
          // express.json já parseou — re-serializa.
          init.body =
            typeof req.body === "string" ? req.body : JSON.stringify(req.body);
        } else if (Buffer.isBuffer(req.body) || typeof req.body === "string") {
          init.body = req.body;
        } else {
          // Multipart / octet-stream: stream ainda legível (json middleware pulou).
          const raw = await lerBodyBruto(req);
          if (raw && raw.length) {
            init.body = raw;
            if (!headers["content-length"]) {
              headers["content-length"] = String(raw.length);
            }
          } else if (req.body != null && typeof req.body === "object") {
            // Fallback: objeto já parseado (urlencoded etc.)
            init.body = JSON.stringify(req.body);
            headers["content-type"] = headers["content-type"] || "application/json";
          }
        }
      }

      const timeoutMs = Number(process.env.API_PROXY_TIMEOUT_MS || 60_000);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let upstream;
      try {
        upstream = await fetch(target, { ...init, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
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
      });
    }
  };
}

/**
 * Encaminha upgrade WebSocket de /api-proxy/ws/* para o backend.
 * O middleware HTTP (fetch) não consegue fazer handshake WS — sem isto o
 * frontend em :9100 falha em loop ao abrir ws://localhost:9100/api-proxy/ws/*.
 *
 * @param {import('http').Server} httpServer
 * @param {{ lerConfigSync: () => object, isAllowed?: (req: import('http').IncomingMessage) => boolean }} opts
 */
function anexarProxyWebSocket(httpServer, { lerConfigSync, isAllowed }) {
  const resolverBackendUrl = criarResolverBackendUrl(lerConfigSync);

  httpServer.on("upgrade", (req, socket, head) => {
    const rawUrl = String(req.url || "");
    if (!rawUrl.startsWith(`${API_PROXY_PREFIX}/ws`)) {
      return;
    }

    if (typeof isAllowed === "function" && isAllowed(req) === false) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    let backendBase;
    try {
      backendBase = resolverBackendUrl();
    } catch (err) {
      console.warn("[Agente] api-proxy ws: backend URL:", err.message);
      socket.destroy();
      return;
    }

    const suffix = rawUrl.slice(API_PROXY_PREFIX.length) || "/";
    let target;
    try {
      target = new URL(suffix, `${backendBase}/`);
    } catch (err) {
      console.warn("[Agente] api-proxy ws: URL inválida:", err.message);
      socket.destroy();
      return;
    }

    const isHttps = target.protocol === "https:";
    const lib = isHttps ? https : http;
    const headers = { ...req.headers, host: target.host };

    const proxyReq = lib.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: "GET",
      headers,
    });

    proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
      const statusLine = `HTTP/1.1 ${proxyRes.statusCode || 101} ${proxyRes.statusMessage || "Switching Protocols"}\r\n`;
      let responseHeaders = "";
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (value == null) continue;
        if (Array.isArray(value)) {
          for (const item of value) {
            responseHeaders += `${key}: ${item}\r\n`;
          }
        } else {
          responseHeaders += `${key}: ${value}\r\n`;
        }
      }
      socket.write(`${statusLine}${responseHeaders}\r\n`);
      if (proxyHead && proxyHead.length) socket.write(proxyHead);

      proxySocket.pipe(socket);
      socket.pipe(proxySocket);

      const destroyBoth = () => {
        proxySocket.destroy();
        socket.destroy();
      };
      proxySocket.on("error", destroyBoth);
      socket.on("error", destroyBoth);
    });

    proxyReq.on("error", (err) => {
      console.warn("[Agente] api-proxy ws:", err.message);
      if (!socket.destroyed) {
        socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        socket.destroy();
      }
    });

    proxyReq.on("response", (res) => {
      // Backend recusou o upgrade (ex.: 401 token inválido).
      let responseHeaders = "";
      for (const [key, value] of Object.entries(res.headers)) {
        if (value == null) continue;
        if (Array.isArray(value)) {
          for (const item of value) {
            responseHeaders += `${key}: ${item}\r\n`;
          }
        } else {
          responseHeaders += `${key}: ${value}\r\n`;
        }
      }
      socket.write(
        `HTTP/1.1 ${res.statusCode} ${res.statusMessage || ""}\r\n${responseHeaders}\r\n`,
      );
      res.pipe(socket);
    });

    if (head && head.length) {
      proxyReq.write(head);
    }
    proxyReq.end();
  });
}

module.exports = {
  criarApiProxy,
  anexarProxyWebSocket,
  resolverBackendUrlPadrao,
  lerBackendPadraoDoFrontend,
  normalizeBackendUrl,
  isPrivateLanHostname,
  lerBodyBruto,
  PRODUCTION_API_URL,
};

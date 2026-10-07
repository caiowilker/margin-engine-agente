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
 * e o api-proxy devolve 502 (fila de impressão e ack falham; vasilhame local não).
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
    // ALLOW_PRIVATE_BACKEND=1 preserva LAN só em laboratório explícito.
    if (isPrivateLanHostname(host) && process.env.ALLOW_PRIVATE_BACKEND !== "1") {
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

/** Teto do proxy: acima do maior timeout do front (faturar pedido, 90 s) e do servidor (pool 3 s + query 8 s). */
const PROXY_TIMEOUT_PADRAO_MS = 95_000;

/**
 * Conexões persistentes até a nuvem: sem isso cada poll (30 s) paga TCP+TLS de novo
 * (o fetch embutido descarta a conexão ociosa em ~4 s). Ociosa por mais de 50 s é fechada
 * aqui antes que o balanceador (60 s típico) a derrube por baixo.
 */
const OPCOES_KEEP_ALIVE = {
  keepAlive: true,
  keepAliveMsecs: 15_000,
  maxSockets: 32,
  maxFreeSockets: 8,
  timeout: 50_000,
};
const agenteHttp = new http.Agent(OPCOES_KEEP_ALIVE);
const agenteHttps = new https.Agent(OPCOES_KEEP_ALIVE);

const OMITIR_HEADERS_RESPOSTA = new Set([
  "transfer-encoding",
  "connection",
  "keep-alive",
  "access-control-allow-origin",
]);

/** Socket reaproveitado que o servidor já fechou: seguro repetir só o que é idempotente. */
const ERROS_SOCKET_VELHO = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED"]);

function podeRepetir(method, headers) {
  return method === "GET" || method === "HEAD" || Boolean(headers["idempotency-key"]);
}

function timeoutProxyMs() {
  const n = Number(process.env.API_PROXY_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : PROXY_TIMEOUT_PADRAO_MS;
}

/**
 * @returns {{ resposta: Promise<import('http').IncomingMessage>, upstreamReq: import('http').ClientRequest }}
 */
function enviarUpstream(target, method, headers, body) {
  const url = new URL(target);
  const isHttps = url.protocol === "https:";
  const upstreamReq = (isHttps ? https : http).request({
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: `${url.pathname}${url.search}`,
    method,
    headers,
    agent: isHttps ? agenteHttps : agenteHttp,
  });
  const resposta = new Promise((resolve, reject) => {
    upstreamReq.once("response", (r) => {
      r.on("error", () => {});
      resolve(r);
    });
    upstreamReq.on("error", reject);
  });
  if (body != null) upstreamReq.end(body);
  else upstreamReq.end();
  return { resposta, upstreamReq };
}

function criarApiProxy({ lerConfigSync }) {
  const resolverBackendUrl = criarResolverBackendUrl(lerConfigSync);

  const encaminharHeaders = [
    "authorization",
    "content-type",
    "accept",
    "accept-encoding",
    "accept-language",
    "x-request-id",
    "x-correlation-id",
    "x-tenant-id",
    "x-store-floor-session",
    "x-margin-floor-session",
    "x-agent-token",
    "idempotency-key",
    "x-supervisor-token",
    "if-match",
    "if-none-match",
    "x-current-refresh-token",
  ];

  return async function proxyApiParaBackend(req, res) {
    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }

    let upstreamAtual = null;
    let clienteSaiu = false;
    let expirou = false;
    const aoFecharCliente = () => {
      if (!res.writableFinished) {
        clienteSaiu = true;
        if (upstreamAtual) upstreamAtual.destroy();
      }
    };
    if (typeof res.on === "function") res.on("close", aoFecharCliente);
    const timer = setTimeout(() => {
      expirou = true;
      if (upstreamAtual) upstreamAtual.destroy(new Error("timeout"));
    }, timeoutProxyMs());

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
      let body = null;
      const ct = String(req.headers["content-type"] || "").toLowerCase();

      if (!["GET", "HEAD"].includes(method)) {
        if (ct.includes("application/json") && req.body != null) {
          // express.json já parseou — re-serializa.
          body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
        } else if (Buffer.isBuffer(req.body) || typeof req.body === "string") {
          body = req.body;
        } else {
          // Multipart / octet-stream: stream ainda legível (json middleware pulou).
          const raw = await lerBodyBruto(req);
          if (raw && raw.length) {
            body = raw;
          } else if (req.body != null && typeof req.body === "object") {
            // Fallback: objeto já parseado (urlencoded etc.)
            body = JSON.stringify(req.body);
            headers["content-type"] = headers["content-type"] || "application/json";
          }
        }
        headers["content-length"] = String(body == null ? 0 : Buffer.byteLength(body));
      }

      let upstreamRes;
      for (let tentativa = 0; ; tentativa++) {
        const envio = enviarUpstream(target, method, headers, body);
        upstreamAtual = envio.upstreamReq;
        try {
          upstreamRes = await envio.resposta;
          break;
        } catch (err) {
          const socketVelho =
            envio.upstreamReq.reusedSocket && ERROS_SOCKET_VELHO.has(err.code);
          if (
            tentativa === 0 &&
            socketVelho &&
            !expirou &&
            !clienteSaiu &&
            podeRepetir(method, headers)
          ) {
            continue;
          }
          throw err;
        }
      }

      res.status(upstreamRes.statusCode || 502);
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (value != null && !OMITIR_HEADERS_RESPOSTA.has(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      }
      await new Promise((resolve) => {
        upstreamRes.once("end", resolve);
        upstreamRes.once("error", resolve);
        upstreamRes.once("close", resolve);
        upstreamRes.pipe(res);
      });
      if (!upstreamRes.complete && !res.writableEnded && typeof res.destroy === "function") {
        res.destroy();
      }
    } catch (err) {
      if (clienteSaiu) return;
      if (res.headersSent) {
        if (typeof res.destroy === "function") res.destroy();
        return;
      }
      if (expirou) {
        console.warn("[Agente] api-proxy: timeout", req.method, req.url);
        res.status(504).json({ erro: "Servidor não respondeu a tempo. Tente novamente." });
        return;
      }
      console.warn("[Agente] api-proxy:", err.message);
      res.status(502).json({
        erro: `Proxy para backend falhou: ${err.message}`,
      });
    } finally {
      clearTimeout(timer);
      if (typeof res.off === "function") res.off("close", aoFecharCliente);
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
  PROXY_TIMEOUT_PADRAO_MS,
};

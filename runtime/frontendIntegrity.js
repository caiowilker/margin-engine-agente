/**
 * Integridade do PDV embutido (frontend-dist).
 *
 * Sintoma de campo: localhost:9100 “tela preta” / indisponível após update
 * parcial — index.html aponta para /assets/index-XXXX.js que não existe;
 * o shell Vite aplica dark mode no <html> e #root fica vazio → tela preta.
 * Atualizar o agente restaura o pacote e “volta ao normal”.
 */
const fs = require("fs");
const path = require("path");

const ASSET_REF_RE =
  /(?:src|href)=["'](\/[^"']+\.(?:js|css|webmanifest|json|svg|png|ico))["']/gi;

/** JS/CSS = tela preta se faltarem. Favicon/PNG/SVG/manifest = aviso, não derruba /health. */
function isCriticalAssetRef(ref) {
  return /\.(js|css)$/i.test(String(ref || ""));
}

/** Cache por mtime do index.html — /health e SPA pollam a cada ~150ms no instalador. */
let _cache = { key: null, result: null };

function invalidateFrontendIntegrityCache() {
  _cache = { key: null, result: null };
}

/**
 * Extrai refs absolutas locais de scripts/links do index.html.
 * Ignora http(s):// e data:.
 */
function extrairRefsLocais(html) {
  const refs = new Set();
  let m;
  const re = new RegExp(ASSET_REF_RE.source, "gi");
  while ((m = re.exec(html)) !== null) {
    const ref = m[1];
    if (!ref || ref.startsWith("//") || /^https?:/i.test(ref)) continue;
    refs.add(ref.split("?")[0].split("#")[0]);
  }
  return [...refs];
}

function cacheKey(frontendDistAbs, indexPath) {
  try {
    const st = fs.statSync(indexPath);
    return `${frontendDistAbs}|${st.mtimeMs}|${st.size}`;
  } catch {
    return null;
  }
}

/**
 * @param {string} frontendDistAbs pasta frontend-dist
 * @param {{ skipCache?: boolean }} [opts]
 * @returns {{ ok: boolean, motivo?: string, faltando?: string[], refs?: number }}
 */
function verificarFrontendDist(frontendDistAbs, opts = {}) {
  const indexPath = path.join(frontendDistAbs, "index.html");
  if (!opts.skipCache) {
    const key = cacheKey(frontendDistAbs, indexPath);
    if (key && _cache.key === key && _cache.result) {
      return _cache.result;
    }
  }

  const result = verificarFrontendDistUncached(frontendDistAbs, indexPath);
  if (!opts.skipCache) {
    const key = cacheKey(frontendDistAbs, indexPath);
    if (key) _cache = { key, result };
  }
  return result;
}

function verificarFrontendDistUncached(frontendDistAbs, indexPath) {
  if (!fs.existsSync(indexPath)) {
    return { ok: false, motivo: "frontend-dist/index.html ausente", faltando: ["index.html"] };
  }
  let html;
  try {
    html = fs.readFileSync(indexPath, "utf8");
  } catch (err) {
    return { ok: false, motivo: `não leu index.html: ${err.message}` };
  }
  if (!html.includes('id="root"') && !html.includes("id='root'")) {
    return { ok: false, motivo: "index.html sem #root (shell SPA inválido)" };
  }
  const refs = extrairRefsLocais(html);
  const faltandoCritico = [];
  const faltandoSuave = [];
  for (const ref of refs) {
    const rel = ref.replace(/^\//, "");
    const abs = path.join(frontendDistAbs, rel);
    if (!fs.existsSync(abs)) {
      if (isCriticalAssetRef(ref)) faltandoCritico.push(ref);
      else faltandoSuave.push(ref);
    }
  }
  if (faltandoCritico.length) {
    return {
      ok: false,
      motivo: `assets referenciados ausentes (${faltandoCritico.length}) — causa típica de tela preta`,
      faltando: faltandoCritico.slice(0, 12),
      avisos: faltandoSuave.length ? faltandoSuave.slice(0, 8) : undefined,
      refs: refs.length,
    };
  }

  // Vite: entry no index + chunks lazy em assets/*.js — pasta vazia = build quebrado.
  const assetsDir = path.join(frontendDistAbs, "assets");
  const hasJsRef = refs.some((r) => /\.js$/i.test(r));
  if (hasJsRef) {
    if (!fs.existsSync(assetsDir)) {
      return {
        ok: false,
        motivo: "pasta assets/ ausente (build Vite incompleto)",
        faltando: ["assets/"],
        refs: refs.length,
      };
    }
    let jsCount = 0;
    try {
      for (const name of fs.readdirSync(assetsDir)) {
        if (/\.js$/i.test(name)) jsCount += 1;
      }
    } catch (err) {
      return { ok: false, motivo: `não leu assets/: ${err.message}` };
    }
    if (jsCount < 1) {
      return {
        ok: false,
        motivo: "assets/ sem arquivos .js",
        faltando: ["assets/*.js"],
        refs: refs.length,
      };
    }
  }

  return {
    ok: true,
    refs: refs.length,
    avisos: faltandoSuave.length ? faltandoSuave.slice(0, 8) : undefined,
  };
}

/** HTML de recuperação — fundo claro, texto legível (não dark vazio). */
function htmlRecuperacaoUi(check, versao) {
  const faltando = (check.faltando || [])
    .map((f) => `<li><code>${escapeHtml(f)}</code></li>`)
    .join("");
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>PDV — UI incompleta</title>
  <style>
    body{font-family:system-ui,sans-serif;margin:0;background:#f4f6f8;color:#1a1d21;
      min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{max-width:520px;background:#fff;border:1px solid #d8dee6;border-radius:12px;
      padding:28px 28px 24px;box-shadow:0 8px 24px rgba(0,0,0,.06)}
    h1{font-size:1.25rem;margin:0 0 8px}
    p{margin:0 0 12px;line-height:1.5;color:#3c4450}
    code{font-size:.85em;background:#eef2f6;padding:1px 6px;border-radius:4px}
    ul{margin:0 0 16px;padding-left:1.2rem;color:#5a6570}
    .actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:8px}
    a.btn{display:inline-block;padding:10px 14px;border-radius:8px;text-decoration:none;
      font-weight:600;font-size:.9rem}
    a.primary{background:#1a7f4b;color:#fff}
    a.secondary{background:#eef2f6;color:#1a1d21}
    .meta{margin-top:18px;font-size:.8rem;color:#7a8490}
  </style>
</head>
<body>
  <div class="card">
    <h1>Interface do PDV incompleta</h1>
    <p>O agente está <strong>no ar</strong>, mas os arquivos da tela (frontend) não batem com o
      <code>index.html</code>. Isso gera a <strong>tela preta</strong> no navegador.</p>
    <p><strong>Motivo:</strong> ${escapeHtml(check.motivo || "integridade falhou")}</p>
    ${faltando ? `<ul>${faltando}</ul>` : ""}
    <p>Atualize o agente (mesmo pacote que já usou para corrigir) ou reinstale.
      APIs locais (<code>/health</code>, fiscal, impressão) podem continuar ok.</p>
    <div class="actions">
      <a class="btn primary" href="/health">Ver /health</a>
      <a class="btn secondary" href="/status-basico">Status básico</a>
      <a class="btn secondary" href="/diagnostico/painel">Diagnóstico</a>
    </div>
    <p class="meta">Agente ${escapeHtml(String(versao || ""))} · integridade frontend-dist</p>
  </div>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Injeta watchdog: se #root continuar vazio após timeout, mostra aviso (evita tela preta muda).
 * Default 3s — 8s deixava o caixa “morto” tempo demais após update incompleto.
 */
function injetarWatchdogRootVazio(html, timeoutMs = 3000) {
  if (!html || html.includes("data-me-root-watchdog")) return html;
  const snip = `
<script data-me-root-watchdog>
(function () {
  var ms = ${Number(timeoutMs) || 3000};
  setTimeout(function () {
    try {
      var r = document.getElementById("root");
      if (!r || r.childNodes.length > 0) return;
      if (document.getElementById("me-ui-falha")) return;
      var box = document.createElement("div");
      box.id = "me-ui-falha";
      box.setAttribute("role", "alert");
      box.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:24px;background:#f4f6f8;color:#1a1d21;font-family:system-ui,sans-serif;text-align:center";
      box.innerHTML = "<div style=\\"max-width:420px\\"><h1 style=\\"font-size:1.2rem;margin:0 0 10px\\">PDV não carregou</h1><p style=\\"margin:0 0 14px;line-height:1.45;color:#3c4450\\">A tela ficou vazia (comum após update incompleto). Force atualizar (Ctrl+F5) ou reinstale o agente.</p><p><a href=\\"/health\\" style=\\"color:#1a7f4b;font-weight:600\\">Abrir /health</a> · <a href=\\"/status.html\\" style=\\"color:#1a7f4b;font-weight:600\\">Painel status</a></p></div>";
      document.body.appendChild(box);
    } catch (_) {}
  }, ms);
})();
</script>`;
  if (html.includes("</body>")) {
    return html.replace("</body>", snip + "\n</body>");
  }
  return html + snip;
}

module.exports = {
  extrairRefsLocais,
  isCriticalAssetRef,
  verificarFrontendDist,
  invalidateFrontendIntegrityCache,
  htmlRecuperacaoUi,
  injetarWatchdogRootVazio,
};

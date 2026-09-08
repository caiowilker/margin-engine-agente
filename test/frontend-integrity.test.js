const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  extrairRefsLocais,
  verificarFrontendDist,
  injetarWatchdogRootVazio,
  htmlRecuperacaoUi,
} = require("../runtime/frontendIntegrity");

const {
  exitCodeParaScmRestart,
  healFrontendOnBoot,
  marcarPosUpdate,
  limparMarcadorPosUpdate,
} = require("../runtime/serviceResilience");

test("extrairRefsLocais ignora CDN e pega assets locais", () => {
  const html = `
    <link href="https://fonts.googleapis.com/css2?family=x" rel="stylesheet" />
    <script type="module" src="/assets/index-ABC.js"></script>
    <link rel="stylesheet" href="/assets/index-XYZ.css">
    <link rel="manifest" href="/manifest.webmanifest">
  `;
  const refs = extrairRefsLocais(html);
  assert.deepEqual(
    refs.sort(),
    ["/assets/index-ABC.js", "/assets/index-XYZ.css", "/manifest.webmanifest"].sort(),
  );
});

test("verificarFrontendDist ok com index + assets presentes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "me-ui-ok-"));
  try {
    fs.mkdirSync(path.join(dir, "assets"));
    fs.writeFileSync(path.join(dir, "assets", "app.js"), "1");
    fs.writeFileSync(path.join(dir, "assets", "app.css"), "1");
    fs.writeFileSync(
      path.join(dir, "index.html"),
      `<html><body><div id="root"></div>
       <script src="/assets/app.js"></script>
       <link href="/assets/app.css" rel="stylesheet"></body></html>`,
    );
    const r = verificarFrontendDist(dir);
    assert.equal(r.ok, true);
    assert.ok(r.refs >= 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("verificarFrontendDist falha quando asset hashed sumiu (tela preta)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "me-ui-bad-"));
  try {
    fs.mkdirSync(path.join(dir, "assets"));
    fs.writeFileSync(
      path.join(dir, "index.html"),
      `<html><body><div id="root"></div>
       <script src="/assets/index-MISSING.js"></script></body></html>`,
    );
    const r = verificarFrontendDist(dir);
    assert.equal(r.ok, false);
    assert.match(r.motivo, /ausentes|tela preta/i);
    assert.ok(r.faltando.includes("/assets/index-MISSING.js"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("injetarWatchdogRootVazio adiciona script uma vez", () => {
  const html = '<html><body><div id="root"></div></body></html>';
  const out = injetarWatchdogRootVazio(html, 1000);
  assert.match(out, /data-me-root-watchdog/);
  assert.match(out, /PDV não carregou/);
  assert.equal(injetarWatchdogRootVazio(out, 1000), out);
});

test("htmlRecuperacaoUi não é tela preta muda", () => {
  const html = htmlRecuperacaoUi(
    { ok: false, motivo: "assets ausentes", faltando: ["/assets/x.js"] },
    "1.0.17",
  );
  assert.match(html, /background:#f4f6f8/);
  assert.match(html, /Interface do PDV incompleta/);
  assert.match(html, /\/health/);
});

test("exitCodeParaScmRestart é 1 (Windows SCM reinicia em falha, não em 0)", () => {
  assert.equal(exitCodeParaScmRestart(), 1);
});

test("healFrontendOnBoot reporta ok quando UI íntegra", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "me-heal-"));
  try {
    const dist = path.join(root, "frontend-dist");
    fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
    fs.writeFileSync(path.join(dist, "assets", "a.js"), "1");
    fs.writeFileSync(
      path.join(dist, "index.html"),
      '<html><body><div id="root"></div><script src="/assets/a.js"></script></body></html>',
    );
    marcarPosUpdate({ versao: "9.9.9" });
    const r = healFrontendOnBoot(root);
    assert.equal(r.action, "ok");
    limparMarcadorPosUpdate();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("verificarFrontendDist falha quando assets/ sem .js", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "me-ui-empty-assets-"));
  try {
    fs.mkdirSync(path.join(dir, "assets"));
    fs.writeFileSync(
      path.join(dir, "index.html"),
      `<html><body><div id="root"></div>
       <script src="/assets/index-x.js"></script></body></html>`,
    );
    // ref aponta para arquivo ausente — cobrimos faltando
    const r = verificarFrontendDist(dir, { skipCache: true });
    assert.equal(r.ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("injetarWatchdogRootVazio default 3s", () => {
  const html = '<html><body><div id="root"></div></body></html>';
  const out = injetarWatchdogRootVazio(html);
  assert.match(out, /var ms = 3000/);
});

test("healFrontendOnBoot tenta rollback sem marcador quando UI quebrada", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "me-heal-nomarker-"));
  try {
    const dist = path.join(root, "frontend-dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(
      path.join(dist, "index.html"),
      '<html><body><div id="root"></div><script src="/assets/gone.js"></script></body></html>',
    );
    limparMarcadorPosUpdate();
    const r = healFrontendOnBoot(root);
    assert.equal(r.action, "failed");
    assert.match(r.detail, /ausentes|assets/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

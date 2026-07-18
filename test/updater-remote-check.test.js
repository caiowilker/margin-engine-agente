#!/usr/bin/env node
/**
 * Checagem remota de versão do updater — npm run test (incluído na suíte)
 */
const assert = require("assert");
const {
  consultarVersaoRemota,
  formatarErroConexao,
} = require("../updaterRemoteCheck");

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((e) => {
      failed++;
      console.error(`  ✗ ${name}:`, e.message);
    });
}

function criarManifestOk() {
  return {
    isManifestOk: () => true,
    getManifestBootMotivo: () => null,
  };
}

function criarState() {
  return {
    ultimaVerificacao: null,
    versaoDisponivel: null,
    changelog: null,
    atualizando: false,
    ultimoErro: null,
    pendingUrlDownload: null,
    pendingSha256: null,
  };
}

async function run() {
  console.log("\nUpdater remote check\n");

  await test("formatarErroConexao — rede", () => {
    const msg = formatarErroConexao({ code: "ECONNREFUSED", message: "connect" });
    assert.match(msg, /sem conexão/i);
  });

  await test("estado atualizado quando versão remota igual", async () => {
    const state = criarState();
    const res = await consultarVersaoRemota({
      versaoAtual: "1.0.0",
      updaterState: state,
      lerConfig: async () => ({
        backendUrl: "http://backend.test",
        backendToken: "tok",
      }),
      manifestUpdater: criarManifestOk(),
      fetchFn: async () => ({
        ok: true,
        json: async () => ({
          versao: "1.0.0",
          urlDownload: "",
          changelog: "",
          sha256: "",
        }),
      }),
      autoUpdate: false,
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.resultado, "atualizado");
    assert.strictEqual(res.podeAplicar, false);
    assert.match(res.mensagem, /mais recente/i);
  });

  await test("versão nova disponível sem aplicar (AUTO_UPDATE=false)", async () => {
    const state = criarState();
    let aplicou = false;
    const res = await consultarVersaoRemota({
      versaoAtual: "1.0.0",
      updaterState: state,
      lerConfig: async () => ({
        backendUrl: "http://backend.test",
        backendToken: "tok",
      }),
      manifestUpdater: criarManifestOk(),
      aplicarAutomaticamente: false,
      aplicarAtualizacao: async () => {
        aplicou = true;
      },
      fetchFn: async () => ({
        ok: true,
        json: async () => ({
          versao: "1.1.0",
          urlDownload: "https://cdn.test/agente.zip",
          changelog: "Correções",
          sha256: "abc123",
        }),
      }),
      autoUpdate: false,
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.resultado, "disponivel");
    assert.strictEqual(res.versaoDisponivel, "1.1.0");
    assert.strictEqual(res.podeAplicar, true);
    assert.strictEqual(aplicou, false);
    assert.strictEqual(state.pendingUrlDownload, "https://cdn.test/agente.zip");
    assert.strictEqual(state.pendingSha256, "abc123");
  });

  await test("erro claro sem conexão", async () => {
    const state = criarState();
    const res = await consultarVersaoRemota({
      versaoAtual: "1.0.0",
      updaterState: state,
      lerConfig: async () => ({
        backendUrl: "http://backend.test",
        backendToken: "tok",
      }),
      manifestUpdater: criarManifestOk(),
      fetchFn: async () => {
        const err = new Error("fetch failed");
        err.code = "ENOTFOUND";
        throw err;
      },
      autoUpdate: false,
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.resultado, "erro");
    assert.match(res.mensagem, /sem conexão/i);
  });

  await test("erro HTTP do backend", async () => {
    const state = criarState();
    const res = await consultarVersaoRemota({
      versaoAtual: "1.0.0",
      updaterState: state,
      lerConfig: async () => ({
        backendUrl: "http://backend.test",
        backendToken: "tok",
      }),
      manifestUpdater: criarManifestOk(),
      fetchFn: async () => ({ ok: false, status: 503 }),
      autoUpdate: false,
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.resultado, "erro");
    assert.match(res.mensagem, /HTTP 503/);
  });

  await test("AUTO_UPDATE=true aplica automaticamente", async () => {
    const state = criarState();
    let aplicou = false;
    const res = await consultarVersaoRemota({
      versaoAtual: "1.0.0",
      updaterState: state,
      lerConfig: async () => ({
        backendUrl: "http://backend.test",
        backendToken: "tok",
      }),
      manifestUpdater: criarManifestOk(),
      aplicarAutomaticamente: true,
      aplicarAtualizacao: async () => {
        aplicou = true;
      },
      fetchFn: async () => ({
        ok: true,
        json: async () => ({
          versao: "2.0.0",
          urlDownload: "https://cdn.test/agente.zip",
          changelog: "",
          sha256: "deadbeef",
        }),
      }),
      autoUpdate: true,
    });
    assert.strictEqual(res.resultado, "aplicando");
    assert.strictEqual(aplicou, true);
  });

  await test("anti-downgrade — versão remota inferior é recusada", async () => {
    const state = criarState();
    let aplicou = false;
    const res = await consultarVersaoRemota({
      versaoAtual: "1.2.0",
      updaterState: state,
      lerConfig: async () => ({
        backendUrl: "http://backend.test",
        backendToken: "tok",
      }),
      manifestUpdater: criarManifestOk(),
      aplicarAutomaticamente: true,
      aplicarAtualizacao: async () => {
        aplicou = true;
      },
      fetchFn: async () => ({
        ok: true,
        json: async () => ({
          versao: "1.0.0",
          urlDownload: "https://cdn.test/agente.zip",
          changelog: "old",
          sha256: "abc",
        }),
      }),
      autoUpdate: true,
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.resultado, "atualizado");
    assert.match(res.mensagem, /Downgrade bloqueado/i);
    assert.strictEqual(aplicou, false);
    assert.strictEqual(res.podeAplicar, false);
    assert.strictEqual(state.pendingUrlDownload, null);
  });

  console.log(`\nUpdater remote check: ${passed} ok, ${failed} falha(s)\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run();

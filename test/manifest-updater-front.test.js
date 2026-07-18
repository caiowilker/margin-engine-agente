#!/usr/bin/env node
/**
 * Atualização simulada: agente + frontend-dist no mesmo pacote (SHA-256 + rollback).
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "me-upd-"));
const agentRoot = path.join(tmpRoot, "agent");
const dataRoot = path.join(tmpRoot, "data");

process.env.MARGIN_ENGINE_ROOT = dataRoot;
const { getDirectoryManager, resetDirectoryManager } = require("../runtime/directoryManager");
resetDirectoryManager();
getDirectoryManager(dataRoot).ensureAll();

const manifestUpdater = require("../manifestUpdater");
manifestUpdater.__setAgentRootForTests(agentRoot);

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function write(rel, content) {
  const fp = path.join(agentRoot, rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content);
}

function read(rel) {
  return fs.readFileSync(path.join(agentRoot, rel), "utf8");
}

function buildManifest(files) {
  return {
    versao: "9.9.9",
    geradoEm: new Date().toISOString(),
    arquivos: files.map((rel) => ({
      arquivo: rel,
      sha256: sha256(read(rel)),
    })),
  };
}

function stagePackage(manifest, overrides) {
  const pkgDir = path.join(tmpRoot, `pkg-${Date.now()}`);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  for (const item of manifest.arquivos) {
    const content = overrides[item.arquivo] ?? read(item.arquivo);
    const dest = path.join(pkgDir, item.arquivo);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
  return pkgDir;
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}:`, e.message);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}:`, e.message);
  }
}

async function run() {
  console.log("\nmanifest-updater-front (agente + frontend-dist)\n");

  write("marker-agent.js", "// agent v1\n");
  write("package.json", JSON.stringify({ name: "agente", version: "9.9.9" }));
  write(
    "frontend-dist/version.json",
    JSON.stringify({ version: "1.0.0", buildId: "front-v1" }),
  );
  write("frontend-dist/index.html", "<html>v1</html>\n");

  const manifestV1 = buildManifest([
    "marker-agent.js",
    "package.json",
    "frontend-dist/version.json",
    "frontend-dist/index.html",
  ]);
  write("manifest.json", JSON.stringify(manifestV1, null, 2));

  test("boot valida manifest com frontend-dist", () => {
    const r = manifestUpdater.verificarManifestBoot();
    assert.strictEqual(r.ok, true);
  });

  await testAsync("aplica pacote com agente e front atualizados", async () => {
    const pkgV2 = JSON.stringify({ name: "agente", version: "9.9.10" });
    const manifestV2 = {
      versao: "9.9.10",
      geradoEm: new Date().toISOString(),
      arquivos: [
        {
          arquivo: "marker-agent.js",
          sha256: sha256("// agent v2\n"),
        },
        {
          arquivo: "package.json",
          sha256: sha256(pkgV2),
        },
        {
          arquivo: "frontend-dist/version.json",
          sha256: sha256(JSON.stringify({ version: "2.0.0", buildId: "front-v2" })),
        },
        {
          arquivo: "frontend-dist/index.html",
          sha256: sha256("<html>v2</html>\n"),
        },
      ],
    };
    const pkgDir = stagePackage(manifestV2, {
      "marker-agent.js": "// agent v2\n",
      "package.json": pkgV2,
      "frontend-dist/version.json": JSON.stringify({
        version: "2.0.0",
        buildId: "front-v2",
      }),
      "frontend-dist/index.html": "<html>v2</html>\n",
    });

    const result = await manifestUpdater.aplicarPacote(pkgDir, null, "9.9.10");
    assert.strictEqual(result.arquivos, 4);
    assert.strictEqual(read("marker-agent.js"), "// agent v2\n");
    assert.strictEqual(JSON.parse(read("package.json")).version, "9.9.10");
    assert.strictEqual(read("frontend-dist/index.html"), "<html>v2</html>\n");
    const version = JSON.parse(read("frontend-dist/version.json"));
    assert.strictEqual(version.buildId, "front-v2");

    // Manifest no disco deve ser o do pacote (boot seguinte valida SHA)
    const manifestOnDisk = JSON.parse(read("manifest.json"));
    assert.strictEqual(manifestOnDisk.versao, "9.9.10");
    assert.strictEqual(manifestUpdater.verificarManifestBoot().ok, true);

    const { lerFrontBuildId } = require("../frontVersion");
    assert.strictEqual(lerFrontBuildId(agentRoot), "front-v2");
  });

  test("rollback restaura agente e frontend-dist v1", () => {
    manifestUpdater.rollbackUltimo();
    assert.strictEqual(read("marker-agent.js"), "// agent v1\n");
    assert.strictEqual(JSON.parse(read("package.json")).version, "9.9.9");
    assert.strictEqual(read("frontend-dist/index.html"), "<html>v1</html>\n");
    const version = JSON.parse(read("frontend-dist/version.json"));
    assert.strictEqual(version.buildId, "front-v1");
    assert.strictEqual(JSON.parse(read("manifest.json")).versao, "9.9.9");
  });

  await testAsync("rejeita downgrade de versão", async () => {
    const pkgOld = JSON.stringify({ name: "agente", version: "9.9.0" });
    const badManifest = {
      versao: "9.9.0",
      arquivos: [
        { arquivo: "marker-agent.js", sha256: sha256("// old\n") },
        { arquivo: "package.json", sha256: sha256(pkgOld) },
      ],
    };
    const pkgDir = stagePackage(badManifest, {
      "marker-agent.js": "// old\n",
      "package.json": pkgOld,
    });
    let threw = false;
    try {
      await manifestUpdater.aplicarPacote(pkgDir, null, "9.9.0");
    } catch (e) {
      threw = true;
      assert.match(e.message, /Downgrade bloqueado/i);
    }
    assert.strictEqual(threw, true);
    assert.strictEqual(JSON.parse(read("package.json")).version, "9.9.9");
  });

  await testAsync("rejeita pacote sem package.json", async () => {
    const badManifest = {
      versao: "9.9.11",
      arquivos: [
        { arquivo: "marker-agent.js", sha256: sha256("// x\n") },
      ],
    };
    const pkgDir = stagePackage(badManifest, {
      "marker-agent.js": "// x\n",
    });
    let threw = false;
    try {
      await manifestUpdater.aplicarPacote(pkgDir, null, "9.9.11");
    } catch (e) {
      threw = true;
      assert.match(e.message, /package\.json ausente/i);
    }
    assert.strictEqual(threw, true);
  });

  await testAsync("rejeita pacote com SHA-256 divergente no manifest", async () => {
    const badPkg = path.join(tmpRoot, "pkg-bad");
    fs.mkdirSync(badPkg, { recursive: true });
    const pkg = JSON.stringify({ name: "agente", version: "9.9.11" });
    const badManifest = {
      versao: "9.9.11",
      arquivos: [
        {
          arquivo: "marker-agent.js",
          sha256: "0".repeat(64),
        },
        {
          arquivo: "package.json",
          sha256: sha256(pkg),
        },
      ],
    };
    fs.writeFileSync(path.join(badPkg, "manifest.json"), JSON.stringify(badManifest));
    fs.writeFileSync(path.join(badPkg, "marker-agent.js"), "// tampered\n");
    fs.writeFileSync(path.join(badPkg, "package.json"), pkg);
    let threw = false;
    try {
      await manifestUpdater.aplicarPacote(badPkg, null, "9.9.11");
    } catch (e) {
      threw = true;
      assert.match(e.message, /SHA-256 divergente/);
    }
    assert.strictEqual(threw, true);
    assert.strictEqual(read("marker-agent.js"), "// agent v1\n");
  });

  console.log(`\nmanifest-updater-front: ${passed} ok, ${failed} falha(s)\n`);

  manifestUpdater.__resetAgentRootForTests();
  delete process.env.MARGIN_ENGINE_ROOT;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

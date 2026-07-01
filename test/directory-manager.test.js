/**
 * Testes — DirectoryManager, atomicWrite e runtime Windows.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  resetDirectoryManager,
  getDirectoryManager,
} = require("../runtime/directoryManager");
const {
  writeFileAtomicSync,
  writeJsonAtomicSync,
  sha256,
} = require("../runtime/atomicWrite");
const { RuntimeError, mapFsError } = require("../runtime/runtimeErrors");

const ROOT = path.join(__dirname, "data-runtime-test");
let passed = 0;
let failed = 0;

function rmDir(dir) {
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}:`, e.message);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}:`, e.message);
  }
}

console.log("directory-manager.test.js\n");

rmDir(ROOT);
process.env.MARGIN_ENGINE_ROOT = ROOT;
resetDirectoryManager();

test("ensureAll cria estrutura completa", () => {
  const dm = getDirectoryManager();
  dm.ensureAll();
  assert.ok(fs.existsSync(dm.dir("logs")));
  assert.ok(fs.existsSync(dm.dir("agentData")));
  assert.ok(fs.existsSync(dm.PATHS.acbrXml));
});

test("file() resolve caminhos do agente", () => {
  const dm = getDirectoryManager();
  const cfg = dm.file("agent", "config.json");
  assert.ok(cfg.includes("config.json"));
});

test("diretório inexistente é recriado", () => {
  const dm = getDirectoryManager();
  const logs = dm.dir("logs");
  fs.rmSync(logs, { recursive: true, force: true });
  dm.ensurePath(logs, "logs");
  assert.ok(fs.existsSync(logs));
});

test("writeFileAtomicSync grava e checksum", () => {
  const dm = getDirectoryManager();
  const target = dm.file("agent", "atomic-test.txt");
  const res = writeFileAtomicSync(target, "hello", {
    encoding: "utf8",
    ensureDir: (d) => dm.ensurePath(d, "agentData"),
  });
  assert.ok(fs.existsSync(target));
  assert.equal(fs.readFileSync(target, "utf8"), "hello");
  assert.ok(res.checksum);
});

test("writeJsonAtomicSync", () => {
  const dm = getDirectoryManager();
  const target = dm.file("agent", "atomic.json");
  writeJsonAtomicSync(target, { ok: true }, {
    ensureDir: (d) => dm.ensurePath(d, "agentData"),
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { ok: true });
});

test("mapFsError EPERM vira DIR-004", () => {
  const err = mapFsError(
    Object.assign(new Error("perm"), { code: "EPERM" }),
    { arquivo: "Config/acbrlib.ini", diretorio: "/x" },
  );
  assert.ok(err instanceof RuntimeError);
  assert.equal(err.code, "DIR-004");
  assert.ok(err.message.includes("Config/acbrlib.ini"));
});

test("fallback sem PROGRAMDATA usa diretório gravável", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "margin-dm-"));
  delete process.env.MARGIN_ENGINE_ROOT;
  resetDirectoryManager();
  const saved = process.env.PROGRAMDATA;
  delete process.env.PROGRAMDATA;
  process.env.LOCALAPPDATA = tmp;
  const dm = getDirectoryManager();
  dm.ensureAll();
  assert.ok(fs.existsSync(dm.ROOT));
  if (saved) process.env.PROGRAMDATA = saved;
  process.env.MARGIN_ENGINE_ROOT = ROOT;
  resetDirectoryManager();
  rmDir(tmp);
});

void testAsync("pasta somente leitura — erro estruturado", async () => {
  if (process.platform === "win32") return;
  const dm = getDirectoryManager();
  const ro = dm.file("agent", "readonly-parent");
  fs.mkdirSync(ro, { recursive: true });
  fs.chmodSync(ro, 0o555);
  try {
    let threw = false;
    try {
      writeFileAtomicSync(path.join(ro, "x.txt"), "nope", {
        ensureDir: (d) => dm.ensurePath(d, "agentData"),
      });
    } catch (e) {
      threw = e instanceof RuntimeError;
    }
    assert.ok(threw, "deveria lançar RuntimeError");
  } finally {
    fs.chmodSync(ro, 0o755);
  }
}).then(() => {
  rmDir(ROOT);
  resetDirectoryManager();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
});

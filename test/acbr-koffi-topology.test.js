const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { enforceSingleKoffi } = require("../runtime/acbrKoffiTopology");

function writePackage(dir, version) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version }));
}

test("remove koffi aninhado da mesma versão", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acbr-koffi-"));
  try {
    writePackage(path.join(root, "node_modules", "koffi"), "2.16.3");
    const nested = path.join(
      root,
      "node_modules",
      "@projetoacbr",
      "acbrlib-base-node",
      "node_modules",
      "koffi",
    );
    writePackage(nested, "2.16.3");
    const result = enforceSingleKoffi({
      appRoot: root,
      packages: ["@projetoacbr/acbrlib-base-node"],
    });
    assert.equal(result.rootVersion, "2.16.3");
    assert.equal(result.removed.length, 1);
    assert.equal(fs.existsSync(nested), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("recusa versões koffi divergentes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acbr-koffi-"));
  try {
    writePackage(path.join(root, "node_modules", "koffi"), "2.16.3");
    writePackage(
      path.join(
        root,
        "node_modules",
        "@projetoacbr",
        "acbrlib-base-node",
        "node_modules",
        "koffi",
      ),
      "2.12.0",
    );
    assert.throws(
      () =>
        enforceSingleKoffi({
          appRoot: root,
          packages: ["@projetoacbr/acbrlib-base-node"],
        }),
      /múltiplas versões/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

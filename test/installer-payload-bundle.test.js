const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  packAll,
  ensureAllBundles,
  NODE_MODULES_ZIP,
  SCHEMAS_ZIP,
} = require("../scripts/installer-payload-bundle");

describe("installer-payload-bundle", () => {
  it("pack + ensure extrai e respeita stamp (skip 2ª vez)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "me-bundle-"));
    const nm = path.join(tmp, "node_modules", "better-sqlite3", "build", "Release");
    fs.mkdirSync(nm, { recursive: true });
    for (const name of ["express", "node-windows", "koffi"]) {
      fs.mkdirSync(path.join(tmp, "node_modules", name), { recursive: true });
      fs.writeFileSync(path.join(tmp, "node_modules", name, "package.json"), "{}");
    }
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ version: "9.9.9" }));
    fs.writeFileSync(path.join(tmp, "node_modules", "better-sqlite3", "package.json"), "{}");
    fs.writeFileSync(path.join(nm, "better_sqlite3.node"), "native");

    const schemas = path.join(tmp, "acbrlib", "data", "Schemas", "NFe");
    fs.mkdirSync(schemas, { recursive: true });
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(schemas, `a${i}.xsd`), "<xs/>");
    }
    const nfse = path.join(tmp, "acbrlib", "data", "Schemas", "NFSe");
    fs.mkdirSync(nfse, { recursive: true });
    for (let i = 0; i < 55; i++) {
      fs.writeFileSync(path.join(nfse, `b${i}.xsd`), "<xs/>");
    }

    const packed = packAll(tmp);
    assert.ok(packed.nodeModules.size > 100);
    assert.ok(fs.existsSync(path.join(tmp, NODE_MODULES_ZIP)));
    assert.ok(fs.existsSync(path.join(tmp, SCHEMAS_ZIP)));

    fs.rmSync(path.join(tmp, "node_modules"), { recursive: true, force: true });
    fs.rmSync(path.join(tmp, "acbrlib", "data", "Schemas"), { recursive: true, force: true });

    const first = ensureAllBundles(tmp);
    assert.equal(first.nodeModules.extracted, true);
    assert.ok(fs.existsSync(path.join(tmp, "node_modules", "better-sqlite3", "package.json")));
    assert.ok(fs.existsSync(path.join(tmp, "acbrlib", "data", "Schemas", "NFe")));

    const second = ensureAllBundles(tmp);
    assert.equal(second.nodeModules.extracted, false);
    assert.equal(second.nodeModules.reason, "stamp_ok");
    assert.equal(second.schemas.extracted, false);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

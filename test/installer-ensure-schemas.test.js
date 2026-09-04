const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  MIN_NFE_XSD,
  MIN_NFSE_XSD,
  contarXsd,
  ensureInstallerSchemas,
  assertBundledSchemas,
} = require("../scripts/installer-ensure-schemas");

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeXsd(dir, name, body = "<xs:schema/>") {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body, "utf8");
}

describe("installer-ensure-schemas", () => {
  it("assertBundledSchemas falha sem payload", () => {
    const app = mkTmp("me-schemas-empty-");
    const r = assertBundledSchemas(app, { requireNfse: true });
    assert.equal(r.ok, false);
    assert.ok(r.errors.length >= 1);
  });

  it("ensureInstallerSchemas copia NFe + NFSe para ProgramData", () => {
    const app = mkTmp("me-schemas-app-");
    const margin = mkTmp("me-schemas-pd-");
    const bundled = path.join(app, "acbrlib", "data", "Schemas");
    const nfe = path.join(bundled, "NFe");
    const nfse = path.join(bundled, "NFSe");

    for (let i = 0; i < MIN_NFE_XSD; i++) {
      writeXsd(nfe, `nfe_${i}.xsd`);
    }
    writeXsd(bundled, "raiz_legado.xsd");
    for (let i = 0; i < MIN_NFSE_XSD; i++) {
      writeXsd(path.join(nfse, "muni"), `nfse_${i}.xsd`);
    }

    const logs = [];
    const r = ensureInstallerSchemas(app, margin, {
      logger: (m) => logs.push(m),
      requireNfse: true,
    });

    assert.equal(r.ok, true);
    assert.ok(r.totalNfe >= MIN_NFE_XSD);
    assert.ok(r.totalNfse >= MIN_NFSE_XSD);
    assert.ok(fs.existsSync(path.join(margin, "acbr", "schemas", "NFe", "nfe_0.xsd")));
    assert.ok(fs.existsSync(path.join(margin, "acbr", "schemas", "NFe", "raiz_legado.xsd")));
    assert.ok(
      fs.existsSync(path.join(margin, "acbr", "schemas", "NFSe", "muni", "nfse_0.xsd")),
    );
    assert.match(logs.join("\n"), /schemas OK/);
  });

  it("ensureInstallerSchemas falha se payload incompleto", () => {
    const app = mkTmp("me-schemas-bad-");
    const margin = mkTmp("me-schemas-pd2-");
    writeXsd(path.join(app, "acbrlib", "data", "Schemas", "NFe"), "so_um.xsd");
    const r = ensureInstallerSchemas(app, margin, { requireNfse: false });
    assert.equal(r.ok, false);
    assert.ok(r.error);
  });

  it("contarXsd percorre subpastas", () => {
    const root = mkTmp("me-count-");
    writeXsd(path.join(root, "a"), "1.xsd");
    writeXsd(path.join(root, "a", "b"), "2.xsd");
    assert.equal(contarXsd(root), 2);
  });

  it("assertBundledSchemas OK no repo real (se presente)", () => {
    const agentRoot = path.join(__dirname, "..");
    const r = assertBundledSchemas(agentRoot, { requireNfse: true });
    if (!fs.existsSync(path.join(agentRoot, "acbrlib", "data", "Schemas"))) {
      return;
    }
    assert.equal(r.ok, true, r.errors.join("; "));
    assert.ok(r.total >= MIN_NFE_XSD);
    assert.ok(r.totalNfse >= MIN_NFSE_XSD);
  });
});

/**
 * Staging seletivo de deps oficiais ACBrLib (OpenSSL 1.1 + LibXml2 + legacy).
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { test } = require("node:test");

const ROOT = path.join(__dirname, "data-acbr-deps-staging");

function rmDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

test("stageNativeLibBundle copia deps oficiais e remove crypto-3 no modo 1.1", () => {
  rmDir(ROOT);
  const libDir = path.join(ROOT, "lib");
  const staging = path.join(ROOT, "stage");
  const openssl = path.join(libDir, "OpenSSL", "1.1.1.10", "x64");
  const libxml = path.join(libDir, "LibXml2", "x64");
  fs.mkdirSync(openssl, { recursive: true });
  fs.mkdirSync(libxml, { recursive: true });
  fs.mkdirSync(staging, { recursive: true });

  const main = path.join(libDir, "ACBrNFe64.dll");
  fs.writeFileSync(main, "dll-main");
  fs.writeFileSync(path.join(libDir, "ACBrCTe64.dll"), "foreign");
  fs.writeFileSync(path.join(libDir, "libcrypto-3-x64.dll"), "crypto3-flat");
  fs.writeFileSync(path.join(openssl, "libcrypto-1_1-x64.dll"), "crypto11");
  fs.writeFileSync(path.join(openssl, "libssl-1_1-x64.dll"), "ssl11");
  fs.writeFileSync(path.join(openssl, "legacy.dll"), "legacy");
  fs.writeFileSync(path.join(libxml, "libxml2.dll"), "xml2-official");
  fs.writeFileSync(path.join(libxml, "libxslt.dll"), "xslt");
  fs.writeFileSync(path.join(libxml, "libiconv.dll"), "iconv");
  // Raiz com libxml2 antigo (não deve vencer o pacote LibXml2/x64)
  fs.writeFileSync(path.join(libDir, "libxml2.dll"), "xml2-legacy-root");
  // Poluição prévia no staging
  fs.writeFileSync(path.join(staging, "libcrypto-3-x64.dll"), "old3");
  fs.writeFileSync(path.join(staging, "ACBrCTe64.dll"), "oldcte");

  const prev = process.env.ACBR_LIB_OPENSSL;
  process.env.ACBR_LIB_OPENSSL = "1.1";
  const runtime = require("../fiscal/drivers/acbrLibRuntime");
  const n = runtime.stageNativeLibBundle(main, staging);
  assert.ok(n >= 1);
  assert.ok(fs.existsSync(path.join(staging, "ACBrNFe64.dll")));
  assert.ok(fs.existsSync(path.join(staging, "libcrypto-1_1-x64.dll")));
  assert.ok(fs.existsSync(path.join(staging, "legacy.dll")));
  assert.ok(fs.existsSync(path.join(staging, "libxml2.dll")));
  assert.equal(fs.readFileSync(path.join(staging, "libxml2.dll"), "utf8"), "xml2-official");
  assert.equal(fs.existsSync(path.join(staging, "libcrypto-3-x64.dll")), false);
  assert.equal(fs.existsSync(path.join(staging, "ACBrCTe64.dll")), false);

  if (prev == null) delete process.env.ACBR_LIB_OPENSSL;
  else process.env.ACBR_LIB_OPENSSL = prev;
  rmDir(ROOT);
});

test("acbrIniGenerator usa OpenSSL A1 (stack que emitia em 19/07) + TLS 1.2", () => {
  const { gerarConteudoIni } = require("../runtime/acbrIniGenerator");
  const content = gerarConteudoIni({ uf: "MG", ambiente: "homologacao" });
  assert.match(content, /SSLCryptLib=1/);
  assert.match(content, /SSLHttpLib=3/);
  assert.match(content, /SSLType=5/);
});

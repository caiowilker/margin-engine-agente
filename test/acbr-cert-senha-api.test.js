/**
 * DFe.Senha no INI deve ser StringToB64Crypt(plain), nunca plaintext.
 */
const assert = require("assert");
const { test } = require("node:test");
const fs = require("fs");
const path = require("path");
const { stringToB64Crypt, b64CryptToString } = require("../fiscal/acbrLibCrypt");
const fiscalSecrets = require("../fiscalSecrets");

async function isolarSenhaCertificado() {
  delete process.env.CERT_A1_PASS;
  delete process.env.ACBR_CERT_SENHA;
  try {
    await fiscalSecrets.limpar();
  } catch (_) {
    /* vault pode não existir */
  }
  const vaultPath = fiscalSecrets.fallbackVaultPath();
  if (vaultPath && fs.existsSync(vaultPath)) {
    fs.unlinkSync(vaultPath);
  }
}

test("applyNativeCertConfig grava Certificado.* + DFe.* via API (mTLS SEFAZ)", () => {
  const calls = [];
  const inst = {
    configGravarValor(sec, key, val) {
      calls.push([sec, key, val]);
    },
  };
  const runtime = require("../fiscal/drivers/acbrLibRuntime");
  runtime.applyNativeCertConfig(inst, {
    cert: "C:\\temp\\cert.pfx",
    senha: "12345678",
  });
  assert.ok(calls.some(([s, k, v]) => s === "Certificado" && k === "Arquivo" && v.includes("cert.pfx")));
  assert.ok(
    calls.some(([s, k, v]) => s === "Certificado" && k === "Senha" && v === "12345678"),
    "Certificado.Senha plain via API (mTLS / paridade 19/07)",
  );
  assert.ok(calls.some(([s, k, v]) => s === "DFe" && k === "ArquivoPFX" && v.includes("cert.pfx")));
  assert.ok(
    calls.some(([s, k, v]) => s === "DFe" && k === "Senha" && v === "12345678"),
    "DFe.Senha plain via API (Lib aplica StringToB64Crypt)",
  );
});

test("runtime.ini grava DFe.Senha como Base64+StrCrypt", async () => {
  const root = path.join(__dirname, "data-acbr-senha-ini");
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "cert"), { recursive: true });
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  const lib = path.join(root, "lib", "ACBrNFe64.dll");
  const cert = path.join(root, "cert", "cert.pfx");
  const ini = path.join(root, "config", "acbrlib.ini");
  fs.writeFileSync(lib, "x");
  fs.writeFileSync(cert, "pfx");
  fs.writeFileSync(
    ini,
    `[Certificado]\nArquivo=${cert}\nSenha=12345678\n[DFe]\nUF=MG\n[NFe]\nAmbiente=1\n`,
    "utf8",
  );

  const prevCertPass = process.env.CERT_A1_PASS;
  const prevAcbrSenha = process.env.ACBR_CERT_SENHA;
  process.env.ACBR_WIN_STAGING = path.join(root, "stage");
  const prevPlat = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });

  try {
    await isolarSenhaCertificado();
    // Garante que o INI do teste manda — sem vazamento de vault/env de outros testes.
    assert.equal(process.env.CERT_A1_PASS, undefined);
    assert.equal(fiscalSecrets.lerSync().certificadoSenha || "", "");

    const runtime = require("../fiscal/drivers/acbrLibRuntime");
    const prepared = runtime.prepareNativeRuntime({
      libPath: lib,
      iniConfigPath: ini,
      assets: { lib: path.dirname(lib), cert, schemas: path.join(root, "schemas") },
      forceStaging: true,
    });
    const content = fs.readFileSync(prepared.iniConfig, "utf8");
    assert.match(content, /SSLCryptLib=1/);
    assert.match(content, /SSLHttpLib=3/);
    assert.match(content, /SSLType=5/);
    const dfe = content.match(/\[DFe\]([\s\S]*?)(\n\[|$)/)?.[1] || "";
    const m = dfe.match(/^Senha=(.+)$/m);
    assert.ok(m, "DFe.Senha presente");
    assert.notEqual(m[1].trim(), "12345678");
    assert.equal(b64CryptToString(m[1].trim()), "12345678");
    assert.equal(m[1].trim(), stringToB64Crypt("12345678"));
  } finally {
    if (prevPlat) Object.defineProperty(process, "platform", prevPlat);
    delete process.env.ACBR_WIN_STAGING;
    if (prevCertPass === undefined) delete process.env.CERT_A1_PASS;
    else process.env.CERT_A1_PASS = prevCertPass;
    if (prevAcbrSenha === undefined) delete process.env.ACBR_CERT_SENHA;
    else process.env.ACBR_CERT_SENHA = prevAcbrSenha;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

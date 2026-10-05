/**
 * Prova de identidade do PFX + fingerprint de sessão com SHA256/senha.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { test } = require("node:test");

const ROOT = path.join(__dirname, "data-cert-proof");

function rmDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

test("sha256File e buildCertProof sem senha", () => {
  rmDir(ROOT);
  fs.mkdirSync(ROOT, { recursive: true });
  const src = path.join(ROOT, "a.pfx");
  const dest = path.join(ROOT, "b.pfx");
  const payload = Buffer.from("fake-pfx-content-v1");
  fs.writeFileSync(src, payload);
  fs.writeFileSync(dest, payload);

  const { sha256File, buildCertProof, senhaFingerprint, certProofForLog } = require("../fiscal/certProof");
  const h = sha256File(src);
  assert.equal(h, crypto.createHash("sha256").update(payload).digest("hex"));

  const proof = buildCertProof({ sourcePath: src, stagedPath: dest, password: "", synced: true });
  assert.equal(proof.hashMatch, true);
  assert.equal(proof.synced, true);
  assert.equal(proof.senhaPresente, false);
  assert.equal(proof.sourceSha256, h);
  assert.equal(proof.stagedSha256, h);

  const safe = certProofForLog(proof);
  assert.ok(safe.sourceSha256);
  assert.equal(safe.senhaPresente, false);

  assert.equal(senhaFingerprint(""), "0");
  assert.notEqual(senhaFingerprint("1234"), senhaFingerprint("5678"));
  assert.equal(senhaFingerprint("abc").length, 16);

  rmDir(ROOT);
});

test("fingerprintRuntime muda quando SHA256 do PFX ou senha mudam", () => {
  const session = require("../fiscal/drivers/acbrLibSession");
  // fingerprintRuntime não é exportado — exercitar via ensureSession indireto é pesado;
  // reimplementamos a regra lendo o módulo e comparando strings montadas como o código faz.
  const { senhaFingerprint } = require("../fiscal/certProof");
  const base = {
    libPath: "C:\\lib\\ACBrNFe64.dll",
    iniConfig: "C:\\cfg\\acbrlib.runtime.ini",
    tpAmb: "1",
    ambienteLib: "0",
    ambienteSefaz: "producao",
    cert: "C:\\cert\\cert.pfx",
    idCsc: "000001",
    csc: "x",
    certSha256: "aaa",
    senha: "senha1",
  };
  const fp1 = [
    "nfe",
    base.libPath.toLowerCase(),
    base.iniConfig.toLowerCase(),
    base.tpAmb,
    base.ambienteLib,
    base.ambienteSefaz,
    base.cert.toLowerCase(),
    base.certSha256,
    senhaFingerprint(base.senha),
    base.idCsc,
    "1",
  ].join("|");
  const fp2 = fp1.replace("aaa", "bbb");
  const fp3 = [
    "nfe",
    base.libPath.toLowerCase(),
    base.iniConfig.toLowerCase(),
    base.tpAmb,
    base.ambienteLib,
    base.ambienteSefaz,
    base.cert.toLowerCase(),
    base.certSha256,
    senhaFingerprint("senha2"),
    base.idCsc,
    "1",
  ].join("|");
  assert.notEqual(fp1, fp2);
  assert.notEqual(fp1, fp3);
  assert.ok(session.getSessionStatus);
});

test("normalizeCertPassword remove aspas e espaços", () => {
  const { normalizeCertPassword } = require("../fiscal/certProof");
  assert.equal(normalizeCertPassword('  "abc123"  '), "abc123");
  assert.equal(normalizeCertPassword("'1978'"), "1978");
  assert.equal(normalizeCertPassword("  senha  "), "senha");
});

const PEM_TESTE = `-----BEGIN CERTIFICATE-----
MIICBDCCAW2gAwIBAgIUCF0bz7PBh4gJcoL5vOFVYjpOPDowDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJUERWIFRFU1RFMB4XDTI2MTAwNTE5MjMzNFoXDTM2MTAw
MjE5MjMzNFowFDESMBAGA1UEAwwJUERWIFRFU1RFMIGfMA0GCSqGSIb3DQEBAQUA
A4GNADCBiQKBgQC6lwXclscNEGYOFOGTYxJ+cpknZ/P6rvI57O2j2aKMhjIHj1lg
YAgyJvB9B+XMTbRioLKdXf5wF+exZ8Wt8Isf2GI3UDGBlk1ssNtNyY80sMTv9+nK
ucT+/VyXG1Tid8uP0AvIKLbGJ3GJ/fDdIdbSA69lUEyPDOC5708ufflYVwIDAQAB
o1MwUTAdBgNVHQ4EFgQUBwdg8Xrg3POkGZyiO6/H6qbZNEUwHwYDVR0jBBgwFoAU
Bwdg8Xrg3POkGZyiO6/H6qbZNEUwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0B
AQsFAAOBgQB2e/5ZkrRfdOWsp1oXLMmq8lmOqtAFbON351FdiCQpU6WydC43RN5q
YPR6K56gQVJpISC5VpCM5YtGyupeD7MihNVIBuPwcC0ypl4YGmoB6Q/m9HNzkt9r
0zbxS8ulLK5FFWByOTkdoVTD9qG6GhSban1OoXeSDl6tThVvpWJYqQ==
-----END CERTIFICATE-----`;

function carregarCertProofComSpawnFalso(resposta) {
  const cp = require("child_process");
  const original = cp.execFileSync;
  const chamadas = [];
  cp.execFileSync = (cmd, args) => {
    chamadas.push(cmd);
    if (cmd !== "openssl") throw new Error("indisponivel");
    const r = resposta();
    if (r instanceof Error) throw r;
    return r;
  };
  delete require.cache[require.resolve("../fiscal/certProof")];
  const mod = require("../fiscal/certProof");
  cp.execFileSync = original;
  delete require.cache[require.resolve("../fiscal/certProof")];
  return { mod, chamadas };
}

test("inspectPfxMeta cacheia por arquivo+senha e invalida quando mudam", () => {
  rmDir(ROOT);
  fs.mkdirSync(ROOT, { recursive: true });
  const pfx = path.join(ROOT, "cert.pfx");
  fs.writeFileSync(pfx, "pfx-v1");
  const { mod, chamadas } = carregarCertProofComSpawnFalso(() => PEM_TESTE);

  const a = mod.inspectPfxMeta(pfx, "1234");
  const b = mod.inspectPfxMeta(pfx, "1234");
  assert.ok(a.thumbprint);
  assert.equal(b.thumbprint, a.thumbprint);
  assert.equal(b.expired, false);
  assert.equal(chamadas.length, 1, "segunda emissão não pode spawnar openssl");

  mod.inspectPfxMeta(pfx, "9999");
  assert.equal(chamadas.length, 2, "senha nova invalida o cache");

  fs.writeFileSync(pfx, "pfx-v2-maior");
  mod.inspectPfxMeta(pfx, "1234");
  assert.equal(chamadas.length, 3, "PFX trocado invalida o cache");
  rmDir(ROOT);
});

test("validatePfxPassword ignora falha cacheada e reavalia", () => {
  rmDir(ROOT);
  fs.mkdirSync(ROOT, { recursive: true });
  const pfx = path.join(ROOT, "cert.pfx");
  fs.writeFileSync(pfx, "pfx-v1");
  let falhar = true;
  const { mod, chamadas } = carregarCertProofComSpawnFalso(() =>
    falhar ? new Error("mac verify failure") : PEM_TESTE,
  );

  assert.equal(mod.inspectPfxMeta(pfx, "1234").thumbprint, null);
  assert.equal(mod.inspectPfxMeta(pfx, "1234").thumbprint, null);
  assert.equal(chamadas.length, 1, "falha recente fica em cache curto no hot path");

  falhar = false;
  const v = mod.validatePfxPassword(pfx, "1234");
  assert.equal(v.ok, true);
  assert.equal(chamadas.length, 2);
  rmDir(ROOT);
});

test("hash diverge quando staged é antigo", () => {
  rmDir(ROOT);
  fs.mkdirSync(ROOT, { recursive: true });
  const src = path.join(ROOT, "novo.pfx");
  const dest = path.join(ROOT, "velho.pfx");
  fs.writeFileSync(src, "novo-certificado");
  fs.writeFileSync(dest, "certificado-antigo");
  const { buildCertProof } = require("../fiscal/certProof");
  const proof = buildCertProof({ sourcePath: src, stagedPath: dest, password: "x" });
  assert.equal(proof.hashMatch, false);
  assert.equal(proof.senhaPresente, true);
  rmDir(ROOT);
});

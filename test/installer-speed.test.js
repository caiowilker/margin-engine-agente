const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  packagedInstall,
  shouldSkipNpmCi,
  shouldSkipManifestRegen,
  shouldSkipPredeploy,
  icaclsGrantCommand,
  manifestEntriesPresent,
  INSTALL_WAIT_ONLINE_MS,
  INSTALL_WAIT_RETRY_MS,
  INSTALL_BOOTSTRAP_MAX_MS,
  remainingBootstrapBudgetMs,
  clampWaitMs,
} = require("../scripts/installerSpeed");

describe("installerSpeed — instalação rápida e sólida no caixa", () => {
  it("reconhece instalador empacotado pelo BUILD_STAMP", () => {
    assert.equal(
      packagedInstall("C:\\app", (p) => p.endsWith("BUILD_STAMP.json")),
      true,
    );
    assert.equal(
      packagedInstall("C:\\app", () => false),
      false,
    );
  });

  it("não roda npm ci quando node_modules nativo já veio no .exe", () => {
    assert.equal(shouldSkipNpmCi({ nativeReady: true }), true);
    assert.equal(shouldSkipNpmCi({ nativeReady: false }), false);
  });

  it("não regenera SHA-256 só se o manifest listar arquivos existentes (sem .br)", () => {
    assert.equal(
      shouldSkipManifestRegen({
        nativeReady: true,
        packaged: true,
        manifestPresent: true,
        entriesPresent: true,
      }),
      true,
    );
    assert.equal(
      shouldSkipManifestRegen({
        nativeReady: true,
        packaged: true,
        manifestPresent: true,
        entriesPresent: false,
      }),
      false,
    );
    assert.equal(
      shouldSkipPredeploy({ nativeReady: true, packaged: true }),
      true,
    );
  });

  it("manifestEntriesPresent recusa .br/.gz e arquivo ausente", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "me-iss-"));
    fs.writeFileSync(path.join(tmp, "ok.js"), "x");
    fs.writeFileSync(
      path.join(tmp, "manifest.json"),
      JSON.stringify({
        arquivos: [
          { arquivo: "ok.js", sha256: "aa" },
          { arquivo: "frontend-dist/a.js.br", sha256: "bb" },
        ],
      }),
    );
    assert.equal(manifestEntriesPresent(tmp), false);

    fs.writeFileSync(
      path.join(tmp, "manifest.json"),
      JSON.stringify({ arquivos: [{ arquivo: "ok.js", sha256: "aa" }] }),
    );
    assert.equal(manifestEntriesPresent(tmp), true);

    fs.writeFileSync(
      path.join(tmp, "manifest.json"),
      JSON.stringify({ arquivos: [{ arquivo: "missing.js", sha256: "aa" }] }),
    );
    assert.equal(manifestEntriesPresent(tmp), false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("ACL install sem /T; reparo com /T", () => {
    const install = icaclsGrantCommand("C:\\ProgramData\\MarginEngine");
    assert.match(install, /\(OI\)\(CI\)M/);
    assert.doesNotMatch(install, /(^|\s)\/T(\s|$)/);
    const repair = icaclsGrantCommand("C:\\ProgramData\\MarginEngine", { recurse: true });
    assert.match(repair, /(^|\s)\/T(\s|$)/);
  });

  it("espera o agente 120s + retry 60s (Defender/ACBr no 1º boot)", () => {
    assert.equal(INSTALL_WAIT_ONLINE_MS, 120_000);
    assert.equal(INSTALL_WAIT_RETRY_MS, 60_000);
    assert.equal(INSTALL_BOOTSTRAP_MAX_MS, 180_000);
    assert.ok(INSTALL_WAIT_ONLINE_MS + INSTALL_WAIT_RETRY_MS <= INSTALL_BOOTSTRAP_MAX_MS);
  });

  it("bootstrap usa um único caminho de start (sem startAgentService duplicado)", () => {
    const bootstrap = fs.readFileSync(
      path.join(__dirname, "..", "scripts", "installer-bootstrap.js"),
      "utf8",
    );
    assert.match(bootstrap, /function bringAgentOnline\(/);
    assert.doesNotMatch(bootstrap, /function startAgentService\(/);
    assert.match(bootstrap, /function runAutoRepairIfOffline\(/);
    assert.match(bootstrap, /writeBootstrapExit\(/);
  });
});

describe("pdv-agente-installer.iss — extração rápida e fail-fast", () => {
  const iss = fs.readFileSync(
    path.join(__dirname, "..", "pdv-agente-installer.iss"),
    "utf8",
  );

  it("usa lzma2/fast, não max", () => {
    assert.match(iss, /Compression=lzma2\/fast/);
    assert.doesNotMatch(iss, /Compression=lzma2\/max/);
  });

  it("não duplica Schemas XSD no [Files]", () => {
    const hits = iss.match(/acbrlib\\data\\Schemas/g) || [];
    assert.equal(hits.length, 0, "Schemas devem entrar só via dist\\app\\*");
  });

  it("exclui .br/.gz do frontend e não comprime Node/DLLs", () => {
    assert.match(iss, /Excludes: "\*\.br,\*\.gz"/);
    assert.match(iss, /dist\\node\\\*".*nocompression/s);
    assert.match(iss, /acbrlib\\lib\\\*".*nocompression/);
  });

  it("atualiza no diretório anterior e usa APIs Inno atuais", () => {
    assert.match(iss, /UsePreviousAppDir=yes/);
    assert.match(iss, /ArchitecturesAllowed=x64os/);
    assert.match(iss, /WizardIsTaskSelected/);
    assert.doesNotMatch(iss, /UsePreviousAppDir=no/);
    assert.doesNotMatch(iss, /(?<!Wizard)IsTaskSelected\(/);
  });

  it("não engole node_modules ou PosPrinter ausentes", () => {
    assert.match(iss, /dist\\app\\node_modules\\\*/);
    assert.doesNotMatch(
      iss,
      /dist\\app\\node_modules\\\*".*skipifsourcedoesntexist/,
    );
    assert.doesNotMatch(
      iss,
      /posprinter\\lib\\\*".*skipifsourcedoesntexist/,
    );
  });

  it("para serviço também na instalação nova (retry após falha parcial)", () => {
    assert.match(iss, /BootstrapMode <> 'install'\)/);
    assert.match(iss, /stop-preinstall/);
    assert.match(iss, /install-bootstrap-exit\.txt/);
    assert.doesNotMatch(
      iss,
      /if not IsExistingInstall then[\s\S]*if \(BootstrapMode <> 'update'\) and \(BootstrapMode <> 'repair'\)/,
    );
  });

  it("PrepareToInstall não bloqueia o wizard se o serviço demorar a parar", () => {
    assert.match(iss, /StopMarginEngineService;/);
    assert.doesNotMatch(iss, /if not StopMarginEngineService then/);
    assert.doesNotMatch(iss, /O serviço Margin Engine precisa estar parado/);
    assert.doesNotMatch(iss, /não parou dentro do tempo esperado/);
  });
});

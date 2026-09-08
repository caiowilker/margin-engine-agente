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

  it("espera o agente 45s + retry 20s (sucesso retorna antes; teto 75s)", () => {
    assert.equal(INSTALL_WAIT_ONLINE_MS, 45_000);
    assert.equal(INSTALL_WAIT_RETRY_MS, 20_000);
    assert.equal(INSTALL_BOOTSTRAP_MAX_MS, 75_000);
    assert.ok(INSTALL_WAIT_ONLINE_MS + INSTALL_WAIT_RETRY_MS <= INSTALL_BOOTSTRAP_MAX_MS);
  });

  it("install-service polla SCM em ~200ms com --no-open", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "install-service.js"),
      "utf8",
    );
    assert.match(src, /NO_OPEN_SCM_DELAY_MS = fromInstaller \? 200/);
    assert.match(src, /function pollScmUntilRunning/);
    assert.doesNotMatch(src, /12_000/);
  });

  it("bootstrap sincroniza schemas e falha em validatePostUpdate", () => {
    const bootstrap = fs.readFileSync(
      path.join(__dirname, "..", "scripts", "installer-bootstrap.js"),
      "utf8",
    );
    assert.match(bootstrap, /function ensureProgramDataSchemas\(/);
    assert.match(bootstrap, /ensureProgramDataSchemas\(\)/);
    assert.match(bootstrap, /ensurePayloadBundles\(/);
    assert.match(bootstrap, /skip_service_reinstall/);
    assert.match(bootstrap, /runDiagnosticLight/);
    assert.match(bootstrap, /throw new Error\(check\.motivo/);
    assert.doesNotMatch(
      bootstrap,
      /Verificação de manifest reportou aviso/,
    );
    assert.match(bootstrap, /st === "running"/);
    assert.match(bootstrap, /install-last-report\.txt/);
  });

  it("Inno não mistura exit≠0 com relatório ProgramData antigo", () => {
    const iss = fs.readFileSync(
      path.join(__dirname, "..", "pdv-agente-installer.iss"),
      "utf8",
    );
    assert.match(iss, /ExitFailed/);
    assert.match(iss, /if ExitFailed then/);
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

  it("usa lzma2/fast sem solid (extract/update rápido)", () => {
    assert.match(iss, /Compression=lzma2\/fast/);
    assert.match(iss, /SolidCompression=no/);
    assert.doesNotMatch(iss, /Compression=lzma2\/max/);
    assert.doesNotMatch(iss, /SolidCompression=yes/);
  });

  it("não duplica Schemas XSD no [Files] (vão no vendor ZIP)", () => {
    const sources = iss.match(/^Source:.*$/gm) || [];
    const schemaTrees = sources.filter(
      (l) =>
        /acbrlib\\data\\Schemas/i.test(l) &&
        !/Excludes:/i.test(l),
    );
    assert.equal(schemaTrees.length, 0, "árvore Schemas não deve ser Source — só vendor ZIP");
    assert.match(iss, /vendor\\schemas\.zip/);
    assert.match(iss, /vendor\\node_modules\.zip/);
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

  it("empacota node_modules e schemas como ZIP nocompression", () => {
    assert.match(iss, /vendor\\node_modules\.zip/);
    assert.match(iss, /vendor\\schemas\.zip/);
    assert.match(iss, /node_modules\.zip".*nocompression/);
    assert.match(iss, /schemas\.zip".*nocompression/);
    assert.doesNotMatch(iss, /dist\\app\\node_modules\\\*/);
  });

  it("não engole PosPrinter ausente", () => {
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

  it("PrepareToInstall cap ≤10s no stop-preinstall", () => {
    assert.match(iss, /StopMarginEngineService;/);
    assert.doesNotMatch(iss, /if not StopMarginEngineService then/);
    const ctl = fs.readFileSync(
      path.join(__dirname, "..", "scripts", "installer-service-control.js"),
      "utf8",
    );
    assert.match(ctl, /INSTALLER_PREINSTALL_STOP_MS \|\| "10000"/);
  });

  it("wait-online exige ui.ok no /health", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "scripts", "installer-wait-online.js"),
      "utf8",
    );
    assert.match(src, /json\.ui\.ok === false/);
  });
});

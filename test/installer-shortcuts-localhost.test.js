/**
 * Atalhos do instalador devem abrir localhost — nunca IP da LAN.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

describe("installer open-pdv / shortcuts — sempre localhost", () => {
  it("open-pdv.cmd aponta para http://localhost:9100/", () => {
    const cmd = fs.readFileSync(
      path.join(__dirname, "..", "scripts", "open-pdv.cmd"),
      "utf8",
    );
    assert.match(cmd, /start\s+""\s+"http:\/\/localhost:9100\/"/);
    assert.doesNotMatch(cmd, /start\s+""\s+"http:\/\/192\.168\./);
    assert.doesNotMatch(cmd, /start\s+""\s+"http:\/\/[^l]/);  });

  it("installer-shortcuts exporta PANEL_URL localhost", () => {
    const { PANEL_URL } = require("../scripts/installer-shortcuts");
    assert.equal(PANEL_URL, "http://localhost:9100/");
  });

  it("Inno Setup Icons usam open-pdv.cmd (não URL http crua)", () => {
    const iss = fs.readFileSync(
      path.join(__dirname, "..", "pdv-agente-installer.iss"),
      "utf8",
    );
    assert.match(iss, /open-pdv\.cmd/);
    assert.doesNotMatch(
      iss,
      /Name:\s*"\{commondesktop\}\\Margin Engine";\s*Filename:\s*"http:/i,
    );
  });
});

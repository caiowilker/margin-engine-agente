/**
 * Testes printerStationRoutes — npm run test:print
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "printer-stations-"));
process.env.PRINTER_STATIONS_FILE = path.join(tmp, "printer-stations.json");

const routes = require("../print/printerStationRoutes");

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

console.log("printerStationRoutes");

test("vazio por padrão", () => {
  const r = routes.ler();
  assert.strictEqual(r.byPrintType.cozinha, "");
  assert.strictEqual(r.byPrintType.bar, "");
  assert.strictEqual(routes.resolvePortaForPrintType("bar"), null);
});

test("salva e resolve porta por printType", () => {
  routes.salvar({
    byPrintType: {
      cozinha: "RAW:EPSON Cozinha",
      bar: "TCP:192.168.1.50:9100",
    },
  });
  assert.strictEqual(routes.resolvePortaForPrintType("cozinha"), "RAW:EPSON Cozinha");
  assert.strictEqual(routes.resolvePortaForPrintType("BAR"), "TCP:192.168.1.50:9100");
  assert.strictEqual(routes.resolvePortaForPrintType("cliente"), null);
  assert.ok(routes.hasAnyStationRoute());
});

test("withPortaOverride restaura estado", async () => {
  assert.strictEqual(routes.getPortaOverride(), null);
  await routes.withPortaOverride("TCP:10.0.0.1:9100", async () => {
    assert.strictEqual(routes.getPortaOverride(), "TCP:10.0.0.1:9100");
  });
  assert.strictEqual(routes.getPortaOverride(), null);
});

test("rejeita porta inválida", () => {
  assert.throws(() => routes.salvar({ byPrintType: { bar: "USB" } }), /Porta inválida/);
});

console.log("printerStationRoutes — ok");

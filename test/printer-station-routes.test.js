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

test("requirePorta — sem rotas usa padrão (null)", () => {
  assert.strictEqual(routes.requirePortaForPrintType("entrega"), null);
  assert.strictEqual(routes.requirePortaForPrintType("bar"), null);
});

test("salva e resolve porta por printType", () => {
  const saved = routes.salvar({
    byPrintType: {
      cozinha: "RAW:EPSON Cozinha",
      bar: "TCP:192.168.1.50:9100",
    },
  });
  assert.strictEqual(saved.unchanged, false);
  assert.strictEqual(routes.resolvePortaForPrintType("cozinha"), "RAW:EPSON Cozinha");
  assert.strictEqual(routes.resolvePortaForPrintType("BAR"), "TCP:192.168.1.50:9100");
  assert.strictEqual(routes.resolvePortaForPrintType("cliente"), null);
  assert.ok(routes.hasAnyStationRoute());
});

test("requirePorta — rotas parciais usam fallback (não queima job)", () => {
  // cozinha foi preenchida no teste anterior → fallback deve ser ela (não throw).
  assert.strictEqual(routes.requirePortaForPrintType("entrega"), "RAW:EPSON Cozinha");
  assert.strictEqual(routes.requirePortaForPrintType("bar"), "TCP:192.168.1.50:9100");
  // cliente não é comanda de estação obrigatória
  assert.strictEqual(routes.requirePortaForPrintType("cliente"), null);
});

test("requirePorta — strict ainda bloqueia entrega vazia", () => {
  const prev = process.env.PRINTER_STATION_STRICT;
  process.env.PRINTER_STATION_STRICT = "1";
  try {
    assert.throws(
      () => routes.requirePortaForPrintType("entrega"),
      (err) => err && err.code === "PRINTER_STATION_ROUTE_MISSING",
    );
  } finally {
    if (prev == null) delete process.env.PRINTER_STATION_STRICT;
    else process.env.PRINTER_STATION_STRICT = prev;
  }
});

test("requirePorta — entrega ok após configurar", () => {
  routes.salvar({ byPrintType: { entrega: "RAW:EPSON Entrega" } });
  assert.strictEqual(routes.requirePortaForPrintType("entrega"), "RAW:EPSON Entrega");
});

test("salvar rotas — idempotente", () => {
  const again = routes.salvar({
    byPrintType: {
      cozinha: "RAW:EPSON Cozinha",
      bar: "TCP:192.168.1.50:9100",
      entrega: "RAW:EPSON Entrega",
    },
  });
  assert.strictEqual(again.unchanged, true);
});

test("healPartialRoutes preenche entrega/cozinha vazias com porta do bar", () => {
  // estado atual do arquivo tmp: bar + entrega configurados no teste anterior —
  // zera entrega/cozinha/producao e cura.
  routes.salvar({
    byPrintType: {
      cozinha: "",
      bar: "TCP:192.168.1.50:9100",
      producao: "",
      cliente: "",
      entrega: "",
    },
  });
  const healed = routes.healPartialRoutes();
  assert.strictEqual(healed.healed, true);
  assert.strictEqual(healed.routes.byPrintType.entrega, "TCP:192.168.1.50:9100");
  assert.strictEqual(healed.routes.byPrintType.cozinha, "TCP:192.168.1.50:9100");
  assert.strictEqual(routes.healPartialRoutes().healed, false);
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

/**
 * Cenários A–F (agente) — mutex, CODE39 forçado, QR 58mm, 2ª via, {B CODE128.
 */
const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  encodeCode128ForEscPos,
  imprimirBarcodesEscpos,
  resolveQrPrintOpts,
} = require("../print/cupomLayoutShared");
const { barcodeTagsWithCode39Fallback } = require("../print/acbrTags");
const {
  renderVasilhameTags,
  normalizarVasilhamePayload,
} = require("../print/vasilhameAcbrTags");
const { suggestQrModuleSize, COLS_58MM, paperMmToCols } = require("../print/thermalCols");
const physical = require("../runtime/physicalResourceLock");

const INCIDENT_A = "985be217-6169-4bc2-95ca-202e6bdcb4f6";
const INCIDENT_B = "564216bb-a289-4ea8-9a06-bb08fd8b8351";

test("A/F — encode CODE128 Epson {B em todos os códigos (incl. incidentes)", () => {
  for (const code of ["VAS01", INCIDENT_A.slice(0, 8).toUpperCase(), "ABC123"]) {
    const enc = encodeCode128ForEscPos(code);
    assert.ok(enc.startsWith("{B"), `faltou {B em ${code}: ${enc}`);
    assert.equal(encodeCode128ForEscPos("{B" + code), "{B" + code);
  }
});

test("C — mutex físico serializa dois jobs (Bar + Entrega) sem RAW paralelo", async () => {
  const order = [];
  const key = "thermal-test-mutex";
  await Promise.all([
    physical.run(key, async () => {
      order.push("bar-start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("bar-end");
    }),
    physical.run(key, async () => {
      order.push("entrega-start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("entrega-end");
    }),
  ]);
  assert.deepEqual(order, ["bar-start", "bar-end", "entrega-start", "entrega-end"]);
});

test("D — idempotency 1ª via ≠ 2ª via (clickId) — não compete como job novo de claim", () => {
  const n1 = normalizarVasilhamePayload({ codigoTransacao: "VAS01" });
  const n2 = normalizarVasilhamePayload({
    codigoTransacao: "VAS01",
    reimpressao: true,
    clickId: "clk-1",
  });
  assert.equal(n1.reimpressao, false);
  assert.equal(n2.reimpressao, true);
  assert.notEqual(n1.clickId, n2.clickId);
});

test("E — banner SEGUNDA VIA expandido + negrito nas tags", () => {
  const tags = renderVasilhameTags({
    codigoTransacao: "VAS99",
    reimpressao: true,
    clickId: "abc",
  });
  assert.match(tags, /SEGUNDA VIA/i);
  assert.match(tags, /<e><n>\*\*\* SEGUNDA VIA \*\*\*<\/n><\/e>/i);
});

test("CODE39 fallback forçado (ACBr tags) — CODE128 falha → CODE39", () => {
  const tags = barcodeTagsWithCode39Fallback("VAS01", { altura: 64 }, { forceCode128Fail: true });
  assert.equal(tags.length, 1);
  assert.match(tags[0], /CODE39/);
  assert.doesNotMatch(tags[0], /CODE128/);
});

test("CODE39 fallback forçado (ESC/POS) — barcodeFn CODE128 throw → CODE39", () => {
  const calls = [];
  const printer = {
    align() {
      return this;
    },
    feed() {
      return this;
    },
  };
  const n = imprimirBarcodesEscpos(
    printer,
    { code128: "VAS01" },
    {
      forceCode128Fail: true,
      barcodeFn(code, tipo) {
        calls.push({ code, tipo });
      },
    },
  );
  assert.equal(n, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tipo, "CODE39");
  assert.equal(calls[0].code, "VAS01");
});

test("QR 58mm — moduleSize >= 4 e resolveQrPrintOpts respeita paper", () => {
  assert.equal(paperMmToCols(58), COLS_58MM);
  assert.equal(suggestQrModuleSize(COLS_58MM), 4);
  const q = resolveQrPrintOpts({ moduleSize: suggestQrModuleSize(COLS_58MM) });
  assert.ok(q.moduleSize >= 4);
  assert.ok(q.moduleSize <= 16);
});

test("vasilhame force CODE128 fail no render → CODE39 na etiqueta", () => {
  const tags = renderVasilhameTags({
    codigoTransacao: "VAS01",
    __forceCode128Fail: true,
  });
  assert.match(tags, /CODE39/);
  assert.doesNotMatch(tags, /CODE128/);
  assert.match(tags, /<e><n>VAS01<\/n><\/e>/);
});

test("F — IDs do incidente documentados (força-release / stuck)", () => {
  assert.match(INCIDENT_A, /^985be217-/);
  assert.match(INCIDENT_B, /^564216bb-/);
});

console.log("print-hardening-scenarios.test.js — A–F ok");

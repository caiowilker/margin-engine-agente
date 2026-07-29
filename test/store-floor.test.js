/**
 * Testes — sessão de piso (storeFloor) do funcionário da loja.
 */
const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "store-floor-"));
const floorFile = path.join(tmpDir, "store-floor.json");
process.env.STORE_FLOOR_FILE = floorFile;

const storeFloor = require("../storeFloor");

beforeEach(() => {
  storeFloor._resetForTests();
  if (fs.existsSync(floorFile)) fs.unlinkSync(floorFile);
});

after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {}
});

test("mint gera qrUrl com Central e storeFloor (não mesas/floor)", () => {
  const r = storeFloor.mint({
    accessToken: "acc",
    refreshToken: "ref",
    lanIp: "192.168.1.40",
    port: 9100,
    forceNew: true,
  });
  assert.ok(r.floorToken);
  assert.ok(r.qrUrl.includes("192.168.1.40:9100/pdv/central-pedidos?storeFloor="));
  assert.ok(!r.qrUrl.includes("/pdv/mesas"));
  assert.ok(!r.qrUrl.includes("?floor="));
  assert.equal(r.floorKind, "store");
  assert.equal(r.operatorBound, true);
});

test("exchange devolve tokens; token inválido 401", () => {
  const minted = storeFloor.mint({
    accessToken: "acc",
    refreshToken: "ref",
    lanIp: "10.0.0.2",
    port: 9100,
    forceNew: true,
  });
  const ok = storeFloor.exchange(minted.floorToken, { agentToken: "ag" });
  assert.equal(ok.ok, true);
  assert.equal(ok.accessToken, "acc");
  assert.equal(ok.floorKind, "store");

  const bad = storeFloor.exchange("token-errado");
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 401);
});

test("sanitizeOperatorMe força COUNTER_STORE quando RETAIL", () => {
  const me = storeFloor.sanitizeOperatorMe({
    userId: "u1",
    email: "a@b.c",
    role: "OPERADOR_PDV",
    tenantStatus: "ACTIVE",
    operationMode: "RETAIL",
  });
  assert.equal(me.operationMode, "COUNTER_STORE");
});

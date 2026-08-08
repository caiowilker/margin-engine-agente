/**
 * Testes — sessão de piso (floor) do garçom.
 */
const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "garcom-floor-"));
const floorFile = path.join(tmpDir, "garcom-floor.json");
process.env.GARCOM_FLOOR_FILE = floorFile;

const garcomFloor = require("../garcomFloor");

beforeEach(() => {
  garcomFloor._resetForTests();
  if (fs.existsSync(floorFile)) fs.unlinkSync(floorFile);
});

after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {}
});

test("mint gera qrUrl com IP LAN e floor (sem localhost)", () => {
  const r = garcomFloor.mint({
    accessToken: "acc",
    refreshToken: "ref",
    lanIp: "192.168.1.40",
    port: 9100,
    forceNew: true,
  });
  assert.ok(r.floorToken);
  assert.ok(r.qrUrl.includes("192.168.1.40:9100/pdv/mesas?floor="));
  assert.ok(!r.qrUrl.includes("localhost"));
  assert.ok(!r.qrUrl.includes("127.0.0.1"));
  assert.equal(r.operatorBound, true);
});

test("sanitizeOperatorMe exige campos mínimos e preserva COUNTER_STORE", () => {
  assert.equal(garcomFloor.sanitizeOperatorMe(null), null);
  assert.equal(garcomFloor.sanitizeOperatorMe({ userId: "x" }), null);
  const retail = garcomFloor.sanitizeOperatorMe({
    userId: "u1",
    email: "a@b.com",
    role: "OPERADOR_PDV",
    tenantStatus: "ACTIVE",
    operationMode: "RETAIL",
  });
  assert.equal(retail.operationMode, "FOOD_SERVICE");
  const counter = garcomFloor.sanitizeOperatorMe({
    userId: "u1",
    email: "a@b.com",
    role: "OPERADOR_PDV",
    tenantStatus: "ACTIVE",
    operationMode: "COUNTER_STORE",
  });
  assert.equal(counter.operationMode, "COUNTER_STORE");
});

test("exchange devolve operatorMe mintado no PC", () => {
  const me = {
    userId: "u1",
    tenantId: "t1",
    email: "op@test.com",
    role: "OPERADOR_PDV",
    plan: "FOOD_PRO",
    tenantStatus: "ACTIVE",
  };
  const minted = garcomFloor.mint({
    accessToken: "acc-me",
    refreshToken: "ref-me",
    operatorMe: me,
    lanIp: "10.0.0.5",
    port: 9100,
    forceNew: true,
  });
  assert.equal(minted.hasOperatorMe, true);
  const ex = garcomFloor.exchange(minted.floorToken);
  assert.equal(ex.ok, true);
  assert.equal(ex.operatorMe.userId, "u1");
  assert.equal(ex.operatorMe.email, "op@test.com");
  assert.equal(ex.operatorMe.operationMode, "FOOD_SERVICE");
});

test("exchange sem operador bound retorna 409", () => {
  const minted = garcomFloor.mint({
    lanIp: "192.168.0.1",
    port: 9100,
    forceNew: true,
  });
  assert.equal(minted.operatorBound, false);
  const ex = garcomFloor.exchange(minted.floorToken);
  assert.equal(ex.ok, false);
  assert.equal(ex.status, 409);
});

test("exchange com token inválido retorna 401", () => {
  const ex = garcomFloor.exchange("nao-existe");
  assert.equal(ex.ok, false);
  assert.equal(ex.status, 401);
});

test("revoke invalida floor", () => {
  const minted = garcomFloor.mint({
    accessToken: "a",
    refreshToken: "b",
    lanIp: "192.168.1.1",
    forceNew: true,
  });
  garcomFloor.revoke();
  const ex = garcomFloor.exchange(minted.floorToken);
  assert.equal(ex.ok, false);
});

test("mint reutiliza token válido e atualiza JWT", () => {
  const a = garcomFloor.mint({
    accessToken: "old",
    refreshToken: "old-r",
    lanIp: "192.168.1.9",
    forceNew: true,
  });
  const b = garcomFloor.mint({
    accessToken: "new",
    refreshToken: "new-r",
    lanIp: "192.168.1.9",
    forceNew: false,
  });
  assert.equal(b.reused, true);
  assert.equal(b.floorToken, a.floorToken);
  const ex = garcomFloor.exchange(b.floorToken);
  assert.equal(ex.accessToken, "new");
  // O refresh é sessão privada do PC: QR nunca pode recebê-lo.
  assert.equal(ex.refreshToken, undefined);
});

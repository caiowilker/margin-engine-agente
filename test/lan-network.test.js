/**
 * Testes — detecção de IP LAN e política de bind.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  isPrivateIPv4,
  isLoopbackIPv4,
  detectLanIPv4,
  listPrivateIPv4Candidates,
  isLanStaffAccessEnabled,
  resolveBindHost,
  buildLanPublicBase,
} = require("../lanNetwork");

test("isPrivateIPv4 reconhece faixas RFC1918", () => {
  assert.equal(isPrivateIPv4("192.168.1.10"), true);
  assert.equal(isPrivateIPv4("10.0.0.5"), true);
  assert.equal(isPrivateIPv4("172.16.0.1"), true);
  assert.equal(isPrivateIPv4("172.31.255.1"), true);
  assert.equal(isPrivateIPv4("8.8.8.8"), false);
  assert.equal(isPrivateIPv4("127.0.0.1"), false);
  assert.equal(isPrivateIPv4("169.254.1.1"), false);
});

test("isLoopbackIPv4", () => {
  assert.equal(isLoopbackIPv4("127.0.0.1"), true);
  assert.equal(isLoopbackIPv4("::1"), true);
  assert.equal(isLoopbackIPv4("192.168.0.1"), false);
});

test("detectLanIPv4 prefere Wi‑Fi/Ethernet sobre docker", () => {
  const ifaces = {
    docker0: [{ family: "IPv4", address: "172.17.0.1", internal: false }],
    "Wi-Fi": [{ family: "IPv4", address: "192.168.1.50", internal: false }],
    lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
  };
  assert.equal(detectLanIPv4(ifaces), "192.168.1.50");
  const ranked = listPrivateIPv4Candidates(ifaces);
  assert.equal(ranked[0].address, "192.168.1.50");
});

test("isLanStaffAccessEnabled — env sobrescreve; default on se ativado", () => {
  assert.equal(isLanStaffAccessEnabled({ ativado: true }, {}), true);
  assert.equal(isLanStaffAccessEnabled({ ativado: false }, {}), false);
  assert.equal(
    isLanStaffAccessEnabled({ ativado: true, lanStaffAccess: false }, {}),
    false,
  );
  assert.equal(
    isLanStaffAccessEnabled({ ativado: false, lanStaffAccess: true }, {}),
    false,
  );
  assert.equal(
    isLanStaffAccessEnabled({ ativado: false }, { AGENT_LAN_ENABLED: "true" }),
    true,
  );
  assert.equal(
    isLanStaffAccessEnabled({ ativado: true }, { AGENT_LAN_ENABLED: "0" }),
    false,
  );
});

test("resolveBindHost — 0.0.0.0 com LAN; AGENT_BIND_HOST explícito", () => {
  assert.equal(resolveBindHost({ ativado: true }, {}), "0.0.0.0");
  assert.equal(resolveBindHost({ ativado: false }, {}), "127.0.0.1");
  assert.equal(
    resolveBindHost({ ativado: true }, { AGENT_BIND_HOST: "127.0.0.1" }),
    "127.0.0.1",
  );
});

test("buildLanPublicBase nunca usa localhost quando há LAN", () => {
  const url = buildLanPublicBase({
    port: 9100,
    lanIp: "192.168.0.20",
    preferLan: true,
  });
  assert.equal(url, "http://192.168.0.20:9100");
  assert.ok(!url.includes("localhost"));
  assert.ok(!url.includes("127.0.0.1"));
});

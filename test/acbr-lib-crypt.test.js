const assert = require("assert");
const { test } = require("node:test");
const {
  strCrypt,
  stringToB64Crypt,
  b64CryptToString,
  CLIB_CHAVE_CRYPT,
} = require("../fiscal/acbrLibCrypt");

test("StringToB64Crypt / B64CryptToString round-trip", () => {
  const plain = "12345678";
  const enc = stringToB64Crypt(plain);
  assert.ok(enc.length > 0);
  assert.notEqual(enc, plain);
  assert.equal(b64CryptToString(enc), plain);
  assert.equal(CLIB_CHAVE_CRYPT, "tYk*5W@");
});

test("StrCrypt é involutivo (XOR)", () => {
  const a = strCrypt("senha-teste");
  assert.equal(strCrypt(a), "senha-teste");
});

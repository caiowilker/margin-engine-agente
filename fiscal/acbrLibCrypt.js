/**
 * Compatível com ACBrLib StringToB64Crypt / B64CryptToString
 * (StrCrypt XOR + Base64, chave padrão CLibChaveCrypt).
 */
const CLIB_CHAVE_CRYPT = "tYk*5W@";

/** StrCrypt (ACBrUtil) — AnsiString XOR cíclico com a chave. */
function strCrypt(input, chave = CLIB_CHAVE_CRYPT) {
  const s = Buffer.from(String(input ?? ""), "latin1");
  const k = Buffer.from(String(chave || CLIB_CHAVE_CRYPT), "latin1");
  if (!s.length || !k.length) return s.toString("latin1");
  const out = Buffer.alloc(s.length);
  for (let i = 0; i < s.length; i++) {
    const i1 = i + 1;
    let pos = i1 % k.length;
    if (pos === 0) pos = k.length;
    let posLetra = s[i] ^ k[pos - 1];
    if (posLetra === 0) posLetra = s[i];
    out[i] = posLetra;
  }
  return out.toString("latin1");
}

function stringToB64Crypt(plain, chave = CLIB_CHAVE_CRYPT) {
  return Buffer.from(strCrypt(plain, chave), "latin1").toString("base64");
}

function b64CryptToString(encoded, chave = CLIB_CHAVE_CRYPT) {
  const raw = Buffer.from(String(encoded || ""), "base64").toString("latin1");
  return strCrypt(raw, chave);
}

module.exports = {
  CLIB_CHAVE_CRYPT,
  strCrypt,
  stringToB64Crypt,
  b64CryptToString,
};

"use strict";

/**
 * Substituto do get-pixels para o escpos (via "overrides" no package.json do agente).
 * O get-pixels original puxa `request` (abandonado, com CVEs em form-data/qs/tough-cookie/uuid) só para baixar
 * imagens por URL — o agente nunca faz isso. Aqui só entra arquivo local ou Buffer, decodificado pelo sharp
 * em RGBA (mesmo formato { data, shape: [largura, altura, 4] } que o escpos.Image lê).
 */
function getPixels(origem, tipo, callback) {
  if (typeof tipo === "function") {
    callback = tipo;
  }
  let entrada;
  if (Buffer.isBuffer(origem) || origem instanceof Uint8Array) {
    entrada = Buffer.from(origem);
  } else if (typeof origem === "string" && origem && !/^[a-z][a-z0-9+.-]*:/i.test(origem.replace(/^[a-z]:[\\/]/i, ""))) {
    entrada = origem;
  } else {
    process.nextTick(callback, new Error("get-pixels: só arquivo local ou Buffer (URL não suportada)"));
    return;
  }
  let sharp;
  try {
    sharp = require("sharp");
  } catch (e) {
    process.nextTick(callback, e);
    return;
  }
  sharp(entrada)
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
    .then(({ data, info }) => {
      callback(null, {
        data: new Uint8Array(data.buffer, data.byteOffset, data.length),
        shape: [info.width, info.height, 4],
      });
    })
    .catch((err) => callback(err));
}

module.exports = getPixels;

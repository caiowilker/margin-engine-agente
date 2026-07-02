/**
 * Validação e helpers compartilhados — cupom térmico (native + ACBr tags).
 */
const { extrairQrCodeDoXml, isNfceModelo65 } = require("../documentosFiscais");

function resolverQrCodeNfce(payload) {
  const candidatos = [
    payload?.qrcodeNfe,
    payload?.qrcode,
    payload?.QRCode,
    payload?.urlConsulta,
  ];
  for (const raw of candidatos) {
    if (typeof raw === "string" && raw.trim()) return raw.trim();
  }
  const xml = payload?.xmlContent || payload?.xml || payload?.xmlNfeAutorizado;
  if (xml) {
    const doXml = extrairQrCodeDoXml(xml);
    if (doXml) return doXml;
  }
  return null;
}

function validarCupomPayload(payload, opts = {}) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Payload de cupom inválido");
  }
  const imprimirQr =
    (process.env.IMPRIMIR_QR_NFCE ?? "true").toLowerCase() !== "false";
  const qrcodeNfe = resolverQrCodeNfce(payload);
  const relaxQr =
    opts.relaxQr === true ||
    payload.permitirSemQr === true ||
    payload.origem === "contingencia" ||
    payload.origem === "offline" ||
    payload.somenteDanfeTermico === true ||
    payload.danfeTermico === true;
  if (
    payload?.chaveNfe &&
    isNfceModelo65(payload.chaveNfe) &&
    imprimirQr &&
    !qrcodeNfe &&
    !relaxQr &&
    payload.origem !== "offline" &&
    payload.origem !== "local"
  ) {
    throw new Error(
      "NFC-e autorizada sem URL de QR Code — aguarde sincronização do XML ou reimprima via DANFC-e",
    );
  }
  return qrcodeNfe;
}

function normalizarCupomPayload(payload) {
  const qrcodeNfe = validarCupomPayload(payload);
  if (qrcodeNfe) {
    return { ...payload, qrcodeNfe, qrcode: qrcodeNfe };
  }
  return payload;
}

module.exports = {
  resolverQrCodeNfce,
  validarCupomPayload,
  normalizarCupomPayload,
};

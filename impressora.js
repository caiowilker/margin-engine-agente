/**
 * Facade pública — compatibilidade total com rotas e imports existentes.
 * Toda impressão passa por PrinterService → PrinterProvider.
 */
module.exports = require("./printerService");

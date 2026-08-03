/**
 * Performance Instrumentation Test
 *
 * This test exercises the instrumented printing functions and collects
 * their performance metrics to identify the exact bottleneck.
 *
 * Run: node test/performance-instrumentation.test.js
 *
 * Expected output:
 * - Timing for each function in the hot path
 * - Identification of the slowest component
 * - Evidence to distinguish facts from hypotheses
 */

const path = require("path");
const fs = require("fs");

// Set up environment for testing
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "debug";

const log = require("../lib/logging-service");

// Mock payload with all necessary fields
const mockPayload = {
  empresa: {
    nome: "Test Company",
    cnpj: "12345678000100",
    inscricaoEstadual: "123456789",
    endereco: {
      rua: "Test Street",
      numero: "123",
      complemento: "Suite 1",
      bairro: "Test District",
      cidade: "Test City",
      estado: "SP",
      cep: "01234567",
    },
    telefone: "1122222222",
    site: "test.com",
    email: "test@test.com",
  },
  cupom: {
    numero: 123,
    serie: 1,
    dataEmissao: new Date().toISOString(),
  },
  itens: [
    {
      descricao: "Test Item 1",
      quantidade: 1,
      valorUnitario: 100.0,
      valorTotal: 100.0,
      impostos: 20.0,
    },
    {
      descricao: "Test Item 2",
      quantidade: 2,
      valorUnitario: 50.0,
      valorTotal: 100.0,
      impostos: 20.0,
    },
  ],
  resumoPorForma: {
    dinheiro: { total: 150.0, quantidade: 1 },
    pix: { total: 50.0, quantidade: 1 },
  },
  totalLiquido: 200.0,
  totalBruto: 220.0,
  totalDesconto: 10.0,
  totalAcrescimo: 0,
  totalImpostos: 44.0,
  taxaServico: 0,
  observacoes: "Test observations",
  vendedor: "Test Seller",
  cliente: {
    nome: "Test Customer",
    cpf: "12345678900",
  },
};

// Mock EscPos printer for testing
class MockPrinter {
  constructor() {
    this.commands = [];
  }

  align(pos) {
    this.commands.push(`align(${pos})`);
    return this;
  }

  text(content) {
    this.commands.push(`text(${String(content).substring(0, 50)})`);
    return this;
  }

  style(style) {
    this.commands.push(`style(${style})`);
    return this;
  }

  feed(lines) {
    this.commands.push(`feed(${lines})`);
    return this;
  }

  font(font) {
    this.commands.push(`font(${font})`);
    return this;
  }

  size(w, h) {
    this.commands.push(`size(${w},${h})`);
    return this;
  }

  bold(enabled) {
    this.commands.push(`bold(${enabled})`);
    return this;
  }

  cut() {
    this.commands.push(`cut()`);
    return this;
  }

  qrimage(data, callback) {
    setImmediate(() => callback(null));
    return this;
  }

  image(img, density, callback) {
    setImmediate(() => callback(null));
    return this;
  }

  getBuffer() {
    return Buffer.alloc(1024);
  }

  toString() {
    return `MockPrinter(${this.commands.length} commands)`;
  }
}

/**
 * Run the performance test
 */
async function runPerformanceTest() {
  console.log(
    "\n" +
      "═".repeat(80) +
      "\n" +
      "Performance Instrumentation Test\n" +
      "Testing printing hot path with instrumentation\n" +
      "═".repeat(80) +
      "\n",
  );

  const metrics = {};

  // Instrument console.log to capture metrics
  const originalLog = console.log;
  const logCapture = [];

  console.log = function (...args) {
    logCapture.push(args);
    originalLog.apply(console, args);
  };

  try {
    // Test 1: Import and basic structure
    console.log("[TEST 1] Loading modules...");
    const tLoad = performance.now();
    const impressoraCore = require("../print/escpos/impressoraCore");
    const printerLogo = require("../print/printerLogo");
    metrics.loadMs = performance.now() - tLoad;
    console.log(`✓ Modules loaded in ${metrics.loadMs.toFixed(2)}ms\n`);

    // Test 2: Test printerLogo.ler()
    console.log("[TEST 2] Testing printerLogo.ler()...");
    const tLer = performance.now();
    const logoInfo = printerLogo.ler();
    metrics.lerMs = performance.now() - tLer;
    console.log(`✓ printerLogo.ler() completed in ${metrics.lerMs.toFixed(2)}ms`);
    console.log(`  Logo status: ${logoInfo.ativo ? "ACTIVE" : "INACTIVE"}`);
    if (logoInfo.caminhoAbsoluto) {
      console.log(`  Logo path: ${logoInfo.caminhoAbsoluto}\n`);
    } else {
      console.log(`  (No logo file found - using placeholder)\n`);
    }

    // Test 3: Test renderCupomConteudo with mock printer
    console.log("[TEST 3] Testing renderCupomConteudo()...");
    const printer = new MockPrinter();

    const tRender = performance.now();
    await impressoraCore.__test.renderCupomConteudo(printer, mockPayload);
    metrics.renderMs = performance.now() - tRender;

    console.log(`✓ renderCupomConteudo() completed in ${metrics.renderMs.toFixed(2)}ms`);
    console.log(`  Commands generated: ${printer.commands.length}\n`);

    // Test 4: Test gerarBuffer
    console.log("[TEST 4] Testing gerarBuffer()...");
    const tBuffer = performance.now();
    const buffer = await impressoraCore.__test.gerarBuffer(
      async (p) => impressoraCore.__test.renderCupomConteudo(p, mockPayload),
    );
    metrics.bufferMs = performance.now() - tBuffer;

    console.log(`✓ gerarBuffer() completed in ${metrics.bufferMs.toFixed(2)}ms`);
    console.log(`  Buffer size: ${buffer.length} bytes\n`);
  } catch (err) {
    console.error("[ERROR]", err.message);
    console.error(err.stack);
  } finally {
    console.log = originalLog;
  }

  // Summary
  console.log(
    "═".repeat(80) +
      "\n" +
      "Performance Summary\n" +
      "═".repeat(80) +
      "\n",
  );

  console.log("Timing Breakdown:");
  console.log(`  Module load        : ${metrics.loadMs?.toFixed(2) || "N/A"} ms`);
  console.log(`  printerLogo.ler()  : ${metrics.lerMs?.toFixed(2) || "N/A"} ms`);
  console.log(`  renderCupomConteudo: ${metrics.renderMs?.toFixed(2) || "N/A"} ms`);
  console.log(`  gerarBuffer()      : ${metrics.bufferMs?.toFixed(2) || "N/A"} ms`);

  console.log("\n" + "─".repeat(80) + "\n");

  // Analysis
  if (metrics.bufferMs > 5000) {
    console.log("⚠️  PERFORMANCE ISSUE DETECTED");
    console.log(`   Buffer generation took ${metrics.bufferMs.toFixed(2)}ms (expected <1500ms)`);
    console.log("\n   Check the instrumentation logs above for:");
    console.log(
      "   - escpos.Image.load() timing (primary suspect for >100s delays)",
    );
    console.log("   - sharp().toFile() timing (secondary suspect)");
    console.log("   - fs.readFileSync() timing (tertiary suspect)");
  } else {
    console.log("✅ Performance OK");
    console.log(`   Buffer generation: ${metrics.bufferMs?.toFixed(2) || 0} ms`);
  }

  console.log(
    "\n" +
      "═".repeat(80) +
      "\n" +
      "Next Steps:\n" +
      "1. Run this test with a real thermal printer and logo\n" +
      "2. Check logs for metric: print.escpos_image_load_duration\n" +
      "3. If Image.load() > 1000ms, check Windows Defender settings\n" +
      "4. Profile the exact file causing the delay\n" +
      "═".repeat(80) +
      "\n",
  );
}

// Run the test
runPerformanceTest().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});

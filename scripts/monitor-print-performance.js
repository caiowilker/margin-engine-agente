#!/usr/bin/env node

/**
 * Print Performance Monitor
 *
 * Monitors real-time logging output and extracts performance metrics
 * from the instrumented printing functions.
 *
 * Usage:
 *   node scripts/monitor-print-performance.js [logfile]
 *
 * If no logfile specified, monitors stdout/stderr in real-time.
 *
 * Extracts:
 * - print.escpos_image_load_duration (primary suspect)
 * - print.prepararescpos_regenerated (sharp timing)
 * - print.logo_lerbuffer_duration (file I/O)
 * - print.buffer_generation_timing (total)
 * - print.rendercupomconteudo_total (render timing)
 */

const fs = require("fs");
const readline = require("readline");

const METRICS = [
  "print.escpos_image_load_duration",
  "print.prepararescpos_regenerated",
  "print.logo_lerbuffer_duration",
  "print.logo_ler_duration",
  "print.buffer_generation_timing",
  "print.rendercupomconteudo_total",
  "print.imprimirlogo_total",
];

const results = {
  imageLoad: [],
  sharpMs: [],
  fileReadMs: [],
  totalBuffer: [],
  totalRender: [],
  imageLogo: [],
};

let lineCount = 0;
let metricsFound = 0;

/**
 * Parse a log line and extract metrics
 */
function parseMetric(line) {
  try {
    // Try to extract JSON object from log line
    const jsonMatch = line.match(/\{[^{}]*("metric"|"loadMs"|"sharpMs")[^{}]*\}/);
    if (!jsonMatch) return null;

    const obj = JSON.parse(jsonMatch[0]);

    if (!obj.metric) return null;

    switch (obj.metric) {
      case "print.escpos_image_load_duration":
        if (obj.loadMs) {
          results.imageLoad.push(obj.loadMs);
          return {
            type: "IMAGE_LOAD",
            ms: obj.loadMs,
            severity: obj.loadMs > 1000 ? "CRITICAL" : obj.loadMs > 100 ? "WARN" : "OK",
          };
        }
        break;

      case "print.prepararescpos_regenerated":
        if (obj.sharpMs) {
          results.sharpMs.push(obj.sharpMs);
          return {
            type: "SHARP",
            ms: obj.sharpMs,
            severity: obj.sharpMs > 2000 ? "CRITICAL" : obj.sharpMs > 100 ? "WARN" : "OK",
          };
        }
        break;

      case "print.logo_lerbuffer_duration":
        if (obj.readMs) {
          results.fileReadMs.push(obj.readMs);
          return {
            type: "FILE_READ",
            ms: obj.readMs,
            severity: obj.readMs > 500 ? "CRITICAL" : obj.readMs > 50 ? "WARN" : "OK",
          };
        }
        break;

      case "print.buffer_generation_timing":
        if (obj.bufferMs) {
          results.totalBuffer.push(obj.bufferMs);
          return {
            type: "BUFFER_TOTAL",
            ms: obj.bufferMs,
            severity: obj.bufferMs > 5000 ? "CRITICAL" : obj.bufferMs > 1500 ? "WARN" : "OK",
          };
        }
        break;

      case "print.rendercupomconteudo_total":
        if (obj.totalRenderMs) {
          results.totalRender.push(obj.totalRenderMs);
          return {
            type: "RENDER_TOTAL",
            ms: obj.totalRenderMs,
            severity: obj.totalRenderMs > 5000 ? "CRITICAL" : obj.totalRenderMs > 1400 ? "WARN" : "OK",
          };
        }
        break;

      case "print.imprimirlogo_total":
        if (obj.totalMs) {
          results.imageLogo.push(obj.totalMs);
          return {
            type: "LOGO_TOTAL",
            ms: obj.totalMs,
            severity: obj.totalMs > 2000 ? "CRITICAL" : obj.totalMs > 100 ? "WARN" : "OK",
          };
        }
        break;
    }
  } catch (e) {
    // Ignore parse errors
  }
  return null;
}

/**
 * Format a number as milliseconds
 */
function formatMs(ms) {
  if (ms === undefined) return "N/A";
  if (ms < 1) return `${ms.toFixed(2)}ms`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Get severity color
 */
function severityColor(severity) {
  switch (severity) {
    case "CRITICAL":
      return "\x1b[41m";
    case "WARN":
      return "\x1b[43m";
    default:
      return "\x1b[42m";
  }
}

function resetColor() {
  return "\x1b[0m";
}

/**
 * Print current statistics
 */
function printStats() {
  console.log("\n" + "═".repeat(80));
  console.log("Performance Metrics Summary");
  console.log("═".repeat(80) + "\n");

  if (metricsFound === 0) {
    console.log("⏳ Waiting for metrics... (no measurements yet)\n");
    return;
  }

  const avg = (arr) => (arr.length > 0 ? arr.reduce((a, b) => a + b) / arr.length : 0);
  const max = (arr) => (arr.length > 0 ? Math.max(...arr) : 0);
  const min = (arr) => (arr.length > 0 ? Math.min(...arr) : 0);

  console.log("📊 Image Load (escpos.Image.load)");
  if (results.imageLoad.length > 0) {
    const severity = max(results.imageLoad) > 1000 ? "CRITICAL" : "OK";
    console.log(
      `${severityColor(severity)}   Samples: ${results.imageLoad.length} | Avg: ${formatMs(avg(results.imageLoad))} | Max: ${formatMs(max(results.imageLoad))} | Min: ${formatMs(min(results.imageLoad))}${resetColor()}`,
    );
  } else {
    console.log("   (no measurements yet)");
  }

  console.log("\n📊 Sharp Processing (image resize/encode)");
  if (results.sharpMs.length > 0) {
    const severity = max(results.sharpMs) > 2000 ? "CRITICAL" : "OK";
    console.log(
      `${severityColor(severity)}   Samples: ${results.sharpMs.length} | Avg: ${formatMs(avg(results.sharpMs))} | Max: ${formatMs(max(results.sharpMs))} | Min: ${formatMs(min(results.sharpMs))}${resetColor()}`,
    );
  } else {
    console.log("   (no measurements yet)");
  }

  console.log("\n📊 File Read (fs.readFileSync)");
  if (results.fileReadMs.length > 0) {
    const severity = max(results.fileReadMs) > 500 ? "CRITICAL" : "OK";
    console.log(
      `${severityColor(severity)}   Samples: ${results.fileReadMs.length} | Avg: ${formatMs(avg(results.fileReadMs))} | Max: ${formatMs(max(results.fileReadMs))} | Min: ${formatMs(min(results.fileReadMs))}${resetColor()}`,
    );
  } else {
    console.log("   (no measurements yet)");
  }

  console.log("\n📊 Buffer Generation (total)");
  if (results.totalBuffer.length > 0) {
    const severity = max(results.totalBuffer) > 5000 ? "CRITICAL" : max(results.totalBuffer) > 1500 ? "WARN" : "OK";
    console.log(
      `${severityColor(severity)}   Samples: ${results.totalBuffer.length} | Avg: ${formatMs(avg(results.totalBuffer))} | Max: ${formatMs(max(results.totalBuffer))} | Min: ${formatMs(min(results.totalBuffer))}${resetColor()}`,
    );
  } else {
    console.log("   (no measurements yet)");
  }

  console.log("\n📊 Render Total (renderCupomConteudo)");
  if (results.totalRender.length > 0) {
    const severity = max(results.totalRender) > 5000 ? "CRITICAL" : max(results.totalRender) > 1400 ? "WARN" : "OK";
    console.log(
      `${severityColor(severity)}   Samples: ${results.totalRender.length} | Avg: ${formatMs(avg(results.totalRender))} | Max: ${formatMs(max(results.totalRender))} | Min: ${formatMs(min(results.totalRender))}${resetColor()}`,
    );
  } else {
    console.log("   (no measurements yet)");
  }

  console.log("\n📊 Logo Total (full logo impression)");
  if (results.imageLogo.length > 0) {
    const severity = max(results.imageLogo) > 2000 ? "CRITICAL" : "OK";
    console.log(
      `${severityColor(severity)}   Samples: ${results.imageLogo.length} | Avg: ${formatMs(avg(results.imageLogo))} | Max: ${formatMs(max(results.imageLogo))} | Min: ${formatMs(min(results.imageLogo))}${resetColor()}`,
    );
  } else {
    console.log("   (no measurements yet)");
  }

  console.log("\n" + "─".repeat(80));
  console.log("\n🔍 Diagnosis:");

  if (results.imageLoad.length > 0 && max(results.imageLoad) > 100000) {
    console.log(
      "\n⭐⭐⭐⭐⭐ escpos.Image.load() is the PRIMARY culprit",
    );
    console.log(`   Max: ${formatMs(max(results.imageLoad))} — suggests Defender/disk I/O issue`);
  } else if (results.sharpMs.length > 0 && max(results.sharpMs) > 100000) {
    console.log(
      "\n⭐⭐⭐⭐ Sharp image processing is the PRIMARY culprit",
    );
    console.log(`   Max: ${formatMs(max(results.sharpMs))} — check image format/size`);
  } else if (results.fileReadMs.length > 0 && max(results.fileReadMs) > 100000) {
    console.log(
      "\n⭐⭐⭐ File I/O is the PRIMARY culprit",
    );
    console.log(
      `   Max: ${formatMs(max(results.fileReadMs))} — check Windows Defender/disk performance`,
    );
  } else if (results.totalBuffer.length > 0 && max(results.totalBuffer) < 5000) {
    console.log("\n✅ All metrics are within acceptable range");
    console.log("   No performance issue detected");
  } else if (results.totalBuffer.length > 0) {
    console.log("\n⚠️  Performance issue detected, but exact cause unclear");
    console.log("   Check the individual component timings above");
  }

  console.log("\n" + "═".repeat(80) + "\n");
}

/**
 * Main entry point
 */
function main() {
  const logfile = process.argv[2];

  console.log("Print Performance Monitor");
  console.log("═".repeat(80));
  console.log(`\nMonitoring metrics: ${METRICS.length} key measurements`);
  console.log(`Source: ${logfile ? `file: ${logfile}` : "stdin (run agent in another terminal)"}`);
  console.log(`\nPress Ctrl+C to exit and see final report\n`);
  console.log("═".repeat(80));

  let rl;
  if (logfile && fs.existsSync(logfile)) {
    rl = readline.createInterface({
      input: fs.createReadStream(logfile),
      crlfDelay: Infinity,
    });
  } else {
    rl = readline.createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    });
  }

  rl.on("line", (line) => {
    lineCount++;

    const metric = parseMetric(line);
    if (metric) {
      metricsFound++;
      const severity = metric.severity === "CRITICAL" ? "🔴" : metric.severity === "WARN" ? "🟡" : "🟢";
      console.log(`${severity} [${metric.type}] ${formatMs(metric.ms)}`);
    }

    // Print stats every 50 metrics
    if (metricsFound % 50 === 0) {
      printStats();
    }
  });

  rl.on("close", () => {
    printStats();
    console.log(`\nProcessed ${lineCount} lines, found ${metricsFound} metrics\n`);
    process.exit(0);
  });

  // Handle Ctrl+C
  process.on("SIGINT", () => {
    rl.close();
  });
}

main();

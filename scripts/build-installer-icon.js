#!/usr/bin/env node
/**
 * Gera assets/margin-engine.ico — ícone oficial do instalador (múltiplos tamanhos).
 * Fonte: margin-engine-front/public/favicon.svg (ou PNG informado).
 */
const fs = require("fs");
const path = require("path");

const agentRoot = path.join(__dirname, "..");
const defaultSvg = path.join(agentRoot, "..", "margin-engine-front", "public", "favicon.svg");
const src = process.argv[2] || defaultSvg;
const dest = process.argv[3] || path.join(agentRoot, "assets", "margin-engine.ico");
const sizes = [16, 32, 48, 256];

async function pngFromSource(sourcePath, size) {
  const sharp = require("sharp");
  if (/\.svg$/i.test(sourcePath)) {
    return sharp(sourcePath, { density: Math.max(72, size * 2) })
      .resize(size, size)
      .png()
      .toBuffer();
  }
  return sharp(sourcePath).resize(size, size).png().toBuffer();
}

function buildIco(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  let offset = 6 + count * 16;
  const entries = [];
  const bodies = [];

  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry[4] = 1;
    entry[5] = 0;
    entry[6] = 32;
    entry[7] = 0;
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    bodies.push(png);
    offset += png.length;
  }

  return Buffer.concat([header, ...entries, ...bodies]);
}

async function main() {
  if (!fs.existsSync(src)) {
    console.error("[build-icon] Fonte não encontrada:", src);
    process.exit(1);
  }

  const images = [];
  for (const size of sizes) {
    const png = await pngFromSource(src, size);
    images.push({ size, png });
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buildIco(images));
  console.log("[build-icon] ICO gerado:", dest, `(${sizes.join(", ")} px)`);
}

main().catch((err) => {
  console.error("[build-icon] Falha:", err.message);
  process.exit(1);
});

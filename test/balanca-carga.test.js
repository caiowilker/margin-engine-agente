#!/usr/bin/env node
"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "me-balanca-"));
process.env.MARGIN_ENGINE_ROOT = tmpRoot;
process.env.BALANCA_CONFIG_OVERRIDE = path.join(tmpRoot, "balanca-carga.json");
process.env.LOG_SILENT = "true";

const { resetDirectoryManager } = require("../runtime/directoryManager");
resetDirectoryManager();

const config = require("../src/balanca/config");
const allowlist = require("../src/balanca/allowlist");
const pasta = require("../src/balanca/pasta");
const atomic = require("../src/balanca/atomicWrite");
const { processarLote } = require("../src/balanca/loteRunner");
const { iniciarSimuladorMgv } = require("../src/balanca/mgvSimulator");
const balanca = require("../src/balanca");

after(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test("schema rejeita gerenciador inválido com enabled", () => {
  assert.throws(
    () => config.validar({ enabled: true, gerenciadorId: "x", pastaCarga: "C:\\x", modoSombra: false }),
    /UUID/,
  );
});

test("allowlist bloqueia nome estranho", () => {
  assert.equal(allowlist.nomePermitido("ITENSMGV.TXT"), true);
  assert.throws(() => allowlist.exigirPermitido("../evil.txt"), /não permitido/);
});

test("pasta: ping escrita + ocupada", () => {
  const dir = path.join(tmpRoot, "mgv");
  fs.mkdirSync(dir, { recursive: true });
  const ok = pasta.diagnosticarPasta(dir);
  assert.equal(ok.ok, true);
  fs.writeFileSync(path.join(dir, "ARQSOK.TXT"), "");
  const ocup = pasta.diagnosticarPasta(dir);
  assert.equal(ocup.ocupada, true);
  fs.unlinkSync(path.join(dir, "ARQSOK.TXT"));
});

test("escrita atômica + encoding windows-1252 com acentos", () => {
  const dir = path.join(tmpRoot, "write");
  fs.mkdirSync(dir, { recursive: true });
  const r = atomic.escreverAtomico(dir, "ITENSMGV.TXT", "Picanha çãé\r\n", "windows-1252");
  assert.equal(r.nome, "ITENSMGV.TXT");
  const buf = fs.readFileSync(path.join(dir, "ITENSMGV.TXT"));
  assert.ok(buf.includes(0x0d) && buf.includes(0x0a));
  const iconv = require("iconv-lite");
  assert.match(iconv.decode(buf, "windows-1252"), /Picanha/);
});

test("SHA-256 diverge → erro", () => {
  assert.throws(
    () => atomic.validarSha256(Buffer.from("abc").toString("base64"), "deadbeef"),
    /SHA-256/,
  );
});

test("fluxo completo com simulador MGV → IMPORTADO", async () => {
  const dir = path.join(tmpRoot, "fluxo");
  fs.mkdirSync(dir, { recursive: true });
  pasta.limparTemporariosOrfaos(dir);
  const sim = iniciarSimuladorMgv(dir, { delayMs: 80, modo: "ok" });
  const body = Buffer.from("000001000100\r\n", "ascii");
  const sha = crypto.createHash("sha256").update(body).digest("hex");
  const lote = {
    loteId: "11111111-1111-1111-1111-111111111111",
    timeoutImportacaoSeg: 5,
    arquivos: [
      {
        nome: "PRECOMGV.TXT",
        sha256: sha,
        tamanho: body.length,
        conteudoBase64: body.toString("base64"),
      },
      {
        nome: "ARQSOK.TXT",
        sha256: crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
        tamanho: 0,
        conteudoBase64: "",
      },
    ],
  };
  const cfg = {
    pastaCarga: dir,
    encoding: "windows-1252",
    timeoutImportacaoSeg: 5,
    intervaloPollingBakMs: 50,
    modoSombra: false,
  };
  const r = await processarLote(lote, cfg);
  sim.stop();
  assert.equal(r.status, "IMPORTADO", r.detalhe);
  assert.ok(r.evidenciasBak.length >= 1);
});

test("simulador nunca importa → TIMEOUT_IMPORTACAO", async () => {
  const dir = path.join(tmpRoot, "timeout");
  fs.mkdirSync(dir, { recursive: true });
  const sim = iniciarSimuladorMgv(dir, { modo: "nunca" });
  const body = Buffer.from("x\r\n");
  const lote = {
    loteId: "22222222-2222-2222-2222-222222222222",
    timeoutImportacaoSeg: 1,
    arquivos: [
      {
        nome: "PRECOMGV.TXT",
        sha256: crypto.createHash("sha256").update(body).digest("hex"),
        conteudoBase64: body.toString("base64"),
      },
      {
        nome: "ARQSOK.TXT",
        sha256: crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
        conteudoBase64: "",
      },
    ],
  };
  const r = await processarLote(lote, {
    pastaCarga: dir,
    encoding: "windows-1252",
    timeoutImportacaoSeg: 1,
    intervaloPollingBakMs: 50,
    modoSombra: false,
  });
  sim.stop();
  assert.equal(r.status, "TIMEOUT_IMPORTACAO");
  assert.match(r.detalhe, /MGV não importou/);
});

test("pasta ocupada → PASTA_OCUPADA sem escrever", async () => {
  const dir = path.join(tmpRoot, "ocupada");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ITENSMGV.TXT"), "old");
  const body = Buffer.from("new\r\n");
  const r = await processarLote(
    {
      loteId: "33333333-3333-3333-3333-333333333333",
      arquivos: [
        {
          nome: "PRECOMGV.TXT",
          sha256: crypto.createHash("sha256").update(body).digest("hex"),
          conteudoBase64: body.toString("base64"),
        },
      ],
    },
    {
      pastaCarga: dir,
      encoding: "windows-1252",
      timeoutImportacaoSeg: 2,
      intervaloPollingBakMs: 50,
      modoSombra: false,
    },
  );
  assert.equal(r.status, "PASTA_OCUPADA");
  assert.equal(fs.existsSync(path.join(dir, "PRECOMGV.TXT")), false);
});

test("modo sombra não toca pasta MGV e ACK indica SOMBRA", async () => {
  const mgv = path.join(tmpRoot, "mgv-sombra");
  fs.mkdirSync(mgv, { recursive: true });
  const body = Buffer.from("sombra\r\n");
  const r = await processarLote(
    {
      loteId: "44444444-4444-4444-4444-444444444444",
      arquivos: [
        {
          nome: "ITENSMGV.TXT",
          sha256: crypto.createHash("sha256").update(body).digest("hex"),
          conteudoBase64: body.toString("base64"),
        },
        {
          nome: "ARQSOK.TXT",
          sha256: crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
          conteudoBase64: "",
        },
      ],
    },
    {
      pastaCarga: mgv,
      encoding: "windows-1252",
      modoSombra: true,
      timeoutImportacaoSeg: 2,
      intervaloPollingBakMs: 50,
    },
  );
  assert.equal(r.status, "ENTREGUE");
  assert.match(r.detalhe, /SOMBRA/);
  assert.equal(fs.existsSync(path.join(mgv, "ITENSMGV.TXT")), false);
  assert.equal(fs.existsSync(path.join(mgv, "ARQSOK.TXT")), false);
});

test("limpa tmp órfãos na inicialização", () => {
  const dir = path.join(tmpRoot, "orphans");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".me-balanca-ITENSMGV.TXT.1.tmp"), "x");
  const n = pasta.limparTemporariosOrfaos(dir);
  assert.ok(n >= 1);
  assert.equal(fs.existsSync(path.join(dir, ".me-balanca-ITENSMGV.TXT.1.tmp")), false);
});

test("diagnostico expõe campos esperados", () => {
  config.salvar({
    enabled: false,
    modoSombra: true,
    pastaCarga: path.join(tmpRoot, "diag"),
  });
  fs.mkdirSync(path.join(tmpRoot, "diag"), { recursive: true });
  const d = balanca.getDiagnostico();
  assert.equal(d.modulo, "balanca");
  assert.ok(d.config);
  assert.ok(d.versaoModulo);
});

test("heartbeat payload aceita balanca sem quebrar filaFiscal", () => {
  const { montarPayloadHeartbeat, normalizarFilaFiscal } = require("../heartbeatPayload");
  const fila = { pendentes: 1, pausada: false };
  const p = montarPayloadHeartbeat(fila, {
    balanca: { enabled: true, modoSombra: true },
  });
  assert.deepEqual(p.filaFiscal, normalizarFilaFiscal(fila));
  assert.equal(p.balanca.enabled, true);
});

test("simulador importa parcialmente → TIMEOUT com pendentes", async () => {
  const dir = path.join(tmpRoot, "parcial");
  fs.mkdirSync(dir, { recursive: true });
  const sim = iniciarSimuladorMgv(dir, {
    delayMs: 60,
    modo: "parcial",
    parcial: ["ARQSOK.TXT"],
  });
  const body = Buffer.from("parcial\r\n");
  const r = await processarLote(
    {
      loteId: "55555555-5555-5555-5555-555555555555",
      timeoutImportacaoSeg: 1,
      arquivos: [
        {
          nome: "PRECOMGV.TXT",
          sha256: crypto.createHash("sha256").update(body).digest("hex"),
          conteudoBase64: body.toString("base64"),
        },
        {
          nome: "ARQSOK.TXT",
          sha256: crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
          conteudoBase64: "",
        },
      ],
    },
    {
      pastaCarga: dir,
      encoding: "windows-1252",
      timeoutImportacaoSeg: 1,
      intervaloPollingBakMs: 40,
      modoSombra: false,
    },
  );
  sim.stop();
  assert.equal(r.status, "TIMEOUT_IMPORTACAO");
  assert.match(r.detalhe, /Pendentes:.*PRECOMGV/i);
});

test("simulador trava arquivo → TIMEOUT_IMPORTACAO", async () => {
  const dir = path.join(tmpRoot, "trava");
  fs.mkdirSync(dir, { recursive: true });
  const sim = iniciarSimuladorMgv(dir, { delayMs: 40, modo: "trava" });
  const body = Buffer.from("trava\r\n");
  const r = await processarLote(
    {
      loteId: "66666666-6666-6666-6666-666666666666",
      timeoutImportacaoSeg: 1,
      arquivos: [
        {
          nome: "PRECOMGV.TXT",
          sha256: crypto.createHash("sha256").update(body).digest("hex"),
          conteudoBase64: body.toString("base64"),
        },
        {
          nome: "ARQSOK.TXT",
          sha256: crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
          conteudoBase64: "",
        },
      ],
    },
    {
      pastaCarga: dir,
      encoding: "windows-1252",
      timeoutImportacaoSeg: 1,
      intervaloPollingBakMs: 40,
      modoSombra: false,
    },
  );
  sim.stop();
  assert.equal(r.status, "TIMEOUT_IMPORTACAO");
  assert.match(r.detalhe, /MGV não importou/);
});

test("disco cheio simulado (ENOSPC) → mensagem específica", () => {
  const err = Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
  const e = pasta.enriquecerErroRede(err);
  assert.equal(e.code, "BALANCA_DISCO_CHEIO");
  assert.match(e.message, /Disco cheio/);
});

test("caminho com espaços e acentos (estilo Windows)", () => {
  const dir = path.join(tmpRoot, "Pasta Carga São José");
  fs.mkdirSync(dir, { recursive: true });
  const r = atomic.escreverAtomico(dir, "ITENSMGV.TXT", "Açúcar\r\n", "windows-1252");
  assert.equal(r.nome, "ITENSMGV.TXT");
  assert.ok(fs.existsSync(path.join(dir, "ITENSMGV.TXT")));
  const diag = pasta.diagnosticarPasta(dir);
  assert.equal(diag.ocupada, true);
});

test("erro de rede/UNC enriquece mensagem de serviço Windows", () => {
  const err = Object.assign(new Error("network path not found"), { code: "EACCES" });
  const e = pasta.enriquecerErroRede(err);
  assert.match(e.message, /conta de serviço/i);
  assert.match(e.causaProvavel, /UNC|rede/i);
});

test("entrega MANUAL → ENTREGUE_SEM_CONFIRMACAO + arquivo em auditoria", async () => {
  const { entregarManual } = require("../src/balanca/entrega");
  const conteudo = Buffer.from("LINHA\r\n");
  const sha = crypto.createHash("sha256").update(conteudo).digest("hex");
  const r = await entregarManual(
    { loteId: "manual-1" },
    { pastaCarga: path.join(tmpRoot, "manual-pasta"), encoding: "windows-1252", retencaoSnapshots: 3 },
    [{ nome: "RAMUZA_ORIGINAL.TXT", conteudoBase64: conteudo.toString("base64"), sha256: sha }],
  );
  assert.equal(r.status, "ENTREGUE_SEM_CONFIRMACAO");
  assert.match(r.detalhe, /MANUAL/);
});

test("PASTA com evidencia NENHUMA → ENTREGUE_SEM_CONFIRMACAO", async () => {
  const dir = path.join(tmpRoot, "sem-evid");
  fs.mkdirSync(dir, { recursive: true });
  const conteudo = Buffer.from("X\r\n");
  const sha = crypto.createHash("sha256").update(conteudo).digest("hex");
  const r = await processarLote(
    {
      loteId: "ne-1",
      modoEntrega: "PASTA_MONITORADA",
      evidenciaEstrategia: "NENHUMA",
      arquivos: [{ nome: "CADTXT.TXT", conteudoBase64: conteudo.toString("base64"), sha256: sha }],
    },
    {
      pastaCarga: dir,
      encoding: "windows-1252",
      timeoutImportacaoSeg: 5,
      intervaloPollingBakMs: 50,
      modoSombra: false,
    },
  );
  assert.equal(r.status, "ENTREGUE_SEM_CONFIRMACAO");
});

test("retencao remove lotes antigos na sombra", () => {
  const { aplicarRetencaoSnapshots } = require("../src/balanca/retencao");
  const audit = path.join(tmpRoot, "ret-audit");
  fs.mkdirSync(audit, { recursive: true });
  for (let i = 0; i < 7; i++) {
    const d = path.join(audit, `lote-${i}`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "x.txt"), String(i));
    const t = new Date(Date.now() - (7 - i) * 1000);
    fs.utimesSync(d, t, t);
  }
  const rem = aplicarRetencaoSnapshots(audit, 3);
  assert.equal(rem, 4);
  assert.equal(fs.readdirSync(audit).length, 3);
});

test("gatilho por data rejeita path fora da pasta (traversal)", async () => {
  const { entregarGatilhoPorData } = require("../src/balanca/entrega");
  const dir = path.join(tmpRoot, "gatilho-ok");
  fs.mkdirSync(dir, { recursive: true });
  const conteudo = Buffer.from("X\r\n");
  const sha = crypto.createHash("sha256").update(conteudo).digest("hex");
  const r = await entregarGatilhoPorData(
    {
      loteId: "gat-1",
      evidenciaEstrategia: "NENHUMA",
      arquivoGatilhoConfig: "../escape.cfg",
    },
    {
      pastaCarga: dir,
      encoding: "windows-1252",
      timeoutImportacaoSeg: 2,
      intervaloPollingBakMs: 40,
    },
    [{ nome: "PRODUTOS.TXT", conteudoBase64: conteudo.toString("base64"), sha256: sha }],
  );
  assert.equal(r.status, "ERRO");
  assert.match(r.detalhe, /path rejeitado|fora da pasta/i);
});

test("dois lotes seguidos com mesmo conteúdo em sombra — ambos ENTREGUE", async () => {
  const mgv = path.join(tmpRoot, "mgv-dup");
  fs.mkdirSync(mgv, { recursive: true });
  const body = Buffer.from("mesmo\r\n");
  const lote = {
    arquivos: [
      {
        nome: "CADTXT.TXT",
        sha256: crypto.createHash("sha256").update(body).digest("hex"),
        conteudoBase64: body.toString("base64"),
      },
    ],
  };
  const cfg = {
    pastaCarga: mgv,
    encoding: "windows-1252",
    modoSombra: true,
    timeoutImportacaoSeg: 2,
    intervaloPollingBakMs: 40,
    retencaoSnapshots: 5,
  };
  const r1 = await processarLote({ ...lote, loteId: "dup-1" }, cfg);
  const r2 = await processarLote({ ...lote, loteId: "dup-2" }, cfg);
  assert.equal(r1.status, "ENTREGUE");
  assert.equal(r2.status, "ENTREGUE");
  assert.equal(fs.existsSync(path.join(mgv, "CADTXT.TXT")), false);
});

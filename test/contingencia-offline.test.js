/**
 * Contingência off-line NFC-e (tpEmis=9) — isolada da emissão normal e do EPEC.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");

const originalFlag = process.env.CONTINGENCIA_OFFLINE_AUTO;
const originalProbe = process.env.CONTINGENCIA_OFFLINE_PROBE_MS;

test.after(() => {
  if (originalFlag === undefined) delete process.env.CONTINGENCIA_OFFLINE_AUTO;
  else process.env.CONTINGENCIA_OFFLINE_AUTO = originalFlag;
  if (originalProbe === undefined) delete process.env.CONTINGENCIA_OFFLINE_PROBE_MS;
  else process.env.CONTINGENCIA_OFFLINE_PROBE_MS = originalProbe;
});

test("flag desligada por padrão; liga só com true", () => {
  delete process.env.CONTINGENCIA_OFFLINE_AUTO;
  const offline = require("../fiscal/contingenciaOffline");
  assert.equal(offline.isEnabled(), false);
  process.env.CONTINGENCIA_OFFLINE_AUTO = "true";
  assert.equal(offline.isEnabled(), true);
  process.env.CONTINGENCIA_OFFLINE_AUTO = "false";
  assert.equal(offline.isEnabled(), false);
});

test("probeTimeoutMs fica entre 3s e 5s", () => {
  const offline = require("../fiscal/contingenciaOffline");
  process.env.CONTINGENCIA_OFFLINE_PROBE_MS = "1000";
  assert.equal(offline.probeTimeoutMs(), 3000);
  process.env.CONTINGENCIA_OFFLINE_PROBE_MS = "9000";
  assert.equal(offline.probeTimeoutMs(), 5000);
  process.env.CONTINGENCIA_OFFLINE_PROBE_MS = "4000";
  assert.equal(offline.probeTimeoutMs(), 4000);
});

test("aplicarTpEmisOffline troca tpEmis e inclui dhCont/xJust sem alterar o restante", () => {
  const { aplicarTpEmisOffline } = require("../fiscal/contingenciaOffline");
  const ini = "[Identificacao]\ntpEmis=1\nnNF=10\nserie=1\n";
  const out = aplicarTpEmisOffline(ini, {
    dhCont: new Date(2026, 7, 14, 12, 0, 0),
    xJust: "Falha de comunicacao com a SEFAZ",
  });
  assert.match(out, /tpEmis=9/);
  assert.doesNotMatch(out, /tpEmis=1/);
  assert.match(out, /dhCont=14\/08\/2026 12:00:00/);
  assert.match(out, /xJust=Falha de comunicacao com a SEFAZ/);
  assert.match(out, /nNF=10/);
});

test("statusServicoOperacional reconhece 107 e rejeita vazio", () => {
  const { statusServicoOperacional } = require("../fiscal/contingenciaOffline");
  assert.equal(statusServicoOperacional({ cStat: "107" }), true);
  assert.equal(statusServicoOperacional({ cStat: "0", xMotivo: "" }), false);
  assert.equal(
    statusServicoOperacional({ cStat: "108", xMotivo: "Servico Paralisado Momentaneamente" }),
    true,
  );
});

test("probe restaura Timeout da sessão e não chama Enviar", () => {
  process.env.CONTINGENCIA_OFFLINE_PROBE_MS = "4000";
  const { probeStatusServico } = require("../fiscal/contingenciaOffline");
  const gravados = [];
  const inst = {
    configLerValor(sec, key) {
      if (key === "Timeout") return "30000";
      return "0";
    },
    configGravarValor(sec, key, val) {
      gravados.push([sec, key, val]);
    },
    statusServico() {
      return JSON.stringify({ Status: { CStat: 107, XMotivo: "Servico em Operacao" } });
    },
    enviar() {
      throw new Error("NFE_Enviar não deve ser chamado no probe");
    },
  };
  const acbrLibResposta = {
    parseRespostaLib() {
      return { cStat: "107", xMotivo: "Servico em Operacao" };
    },
  };
  const r = probeStatusServico(inst, acbrLibResposta, null);
  assert.equal(r.ok, true);
  assert.ok(
    gravados.some(
      (g) => g[1] === "Timeout" && ["3000", "4000", "5000"].includes(String(g[2])),
    ),
  );
  const lastTimeout = [...gravados].reverse().find((g) => g[1] === "Timeout");
  assert.equal(lastTimeout[2], "30000");
});

test("gravarFormaEmissao não chama configGravar (disco) — só Valor em sessão", () => {
  const { gravarFormaEmissao, FORMA_OFFLINE, FORMA_NORMAL } = require("../fiscal/contingenciaOffline");
  const calls = [];
  const inst = {
    configGravarValor(...a) {
      calls.push(["valor", ...a]);
    },
    configGravar() {
      throw new Error("não persistir INI");
    },
  };
  gravarFormaEmissao(inst, FORMA_OFFLINE, null);
  gravarFormaEmissao(inst, FORMA_NORMAL, null);
  assert.ok(calls.every((c) => c[0] === "valor"));
  assert.ok(calls.some((c) => c[3] === "9"));
  assert.ok(calls.some((c) => c[3] === "0"));
});

test("fila SQLite enqueue / transmitido / falha permanece pendente", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nfce-off-"));
  const db = new Database(path.join(dir, "fila.db"));
  const queue = require("../fiscal/contingenciaOfflineQueue");
  queue.bind(db);
  queue.enqueue({
    chave: "35260814256223000155650010000000011000000010",
    numero: "1",
    serie: "1",
    xmlPath: path.join(dir, "a.xml"),
    numeroVenda: "V1",
  });
  assert.equal(queue.contarPendentes(), 1);
  queue.marcarFalha("35260814256223000155650010000000011000000010", "sefaz down");
  assert.equal(queue.contarPendentes(), 1);
  const pend = queue.listPendentes();
  assert.equal(pend[0].tentativas, 1);
  queue.marcarTransmitido("35260814256223000155650010000000011000000010", "123");
  assert.equal(queue.contarPendentes(), 0);
  db.close();
});

test("probe retry: primeira falha + segunda OK não entra em off-line", async () => {
  process.env.CONTINGENCIA_OFFLINE_PROBE_MS = "4000";
  process.env.CONTINGENCIA_OFFLINE_PROBE_RETRY_MS = "300";
  const { probeStatusServicoComRetry } = require("../fiscal/contingenciaOffline");
  let n = 0;
  const inst = {
    configLerValor() {
      return "30000";
    },
    configGravarValor() {},
    statusServico() {
      n += 1;
      if (n === 1) throw new Error("timeout");
      return "{}";
    },
  };
  const parser = {
    parseRespostaLib() {
      return { cStat: "107", xMotivo: "Servico em Operacao" };
    },
  };
  const r = await probeStatusServicoComRetry(inst, parser, null);
  assert.equal(r.ok, true);
  assert.equal(r.tentativas, 2);
  assert.equal(n, 2);
});

test("classificarResultadoSync: timeout retem; rejeição 215 sai da fila; 204 consulta", () => {
  const { classificarResultadoSync } = require("../fiscal/contingenciaOffline");
  const rede = classificarResultadoSync(new Error("NFE_Enviar timeout após 4000ms"));
  assert.equal(rede.tipo, "REDE");
  assert.equal(rede.reter, true);

  const rej = classificarResultadoSync({ message: "NFC-e rejeitada (cStat 215): Falha no schema", cStat: "215", permanente: true });
  assert.equal(rej.tipo, "REJEICAO");
  assert.equal(rej.reter, false);

  const dup = classificarResultadoSync({ message: "Duplicidade", cStat: "204" });
  assert.equal(dup.tipo, "DUPLICIDADE");
  assert.equal(dup.consultar, true);
});

test("mesma janela de dhCont para notas consecutivas; fecha e reabre com timestamp novo", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nfce-jan-"));
  const db = new Database(path.join(dir, "fila.db"));
  const queue = require("../fiscal/contingenciaOfflineQueue");
  queue.bind(db);
  const t1 = new Date(2026, 7, 14, 10, 0, 0);
  const t2 = new Date(2026, 7, 14, 10, 15, 0);
  const a = queue.obterOuAbrirJanelaDhCont(t1);
  const b = queue.obterOuAbrirJanelaDhCont(t2);
  assert.equal(a, b);
  assert.match(a, /14\/08\/2026 10:00:00/);
  assert.equal(queue.fecharJanelaDhCont(), true);
  const c = queue.obterOuAbrirJanelaDhCont(t2);
  assert.match(c, /14\/08\/2026 10:15:00/);
  db.close();
});

test("claim atômico: segundo claim não pega a mesma nota enquanto o lock vale", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nfce-claim-"));
  const db = new Database(path.join(dir, "fila.db"));
  const queue = require("../fiscal/contingenciaOfflineQueue");
  queue.bind(db);
  const chave = "35260814256223000155650010000000011000000011";
  queue.enqueue({
    chave,
    numero: "2",
    serie: "1",
    xmlPath: path.join(dir, "b.xml"),
  });
  const c1 = queue.claimPendentes(10, 120000);
  assert.equal(c1.rows.length, 1);
  const c2 = queue.claimPendentes(10, 120000);
  assert.equal(c2.rows.length, 0);
  queue.marcarRejeicao(chave, "schema", "215");
  assert.equal(queue.contarPendentes(), 0);
  assert.equal(queue.contarRejeicoes(), 1);
  db.close();
});

test("GravarXML verifica disco antes de qualquer impressão", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nfce-xml-"));
  const chave = "35260814256223000155650010000000011000000012";
  const xml = `<infNFe Id="NFe${chave}"><ide><nNF>12</nNF><serie>1</serie></ide></infNFe>`;
  let imprimiu = false;
  const inst = {
    obterXml() {
      return xml;
    },
    gravarXml() {
      fs.writeFileSync(path.join(dir, `${chave}-nfe.xml`), xml, "utf8");
    },
    imprimirPDF() {
      imprimiu = true;
      throw new Error("impressora não deve ser chamada em gravarXmlAssinado");
    },
  };
  const { gravarXmlAssinado, xmlTemChave } = require("../fiscal/contingenciaOffline");
  const r = gravarXmlAssinado(inst, dir, chave);
  assert.equal(imprimiu, false);
  assert.ok(fs.existsSync(r.xmlPath));
  assert.ok(xmlTemChave(fs.readFileSync(r.xmlPath, "utf8"), chave));
});

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

test("jobEhEmissaoNfce65 — NFC-e sim, NF-e 55 não", () => {
  const { jobEhEmissaoNfce65, jobPermitidoComFilaPausada } = require("../filaFiscal");
  assert.equal(jobEhEmissaoNfce65({ tipo: "EMISSAO", payload: "{}" }), true);
  assert.equal(
    jobEhEmissaoNfce65({
      tipo: "EMISSAO",
      payload: JSON.stringify({ modeloDocumento: "65" }),
    }),
    true,
  );
  assert.equal(
    jobEhEmissaoNfce65({
      tipo: "EMISSAO",
      payload: JSON.stringify({ modeloDocumento: "55" }),
    }),
    false,
  );
  assert.equal(jobPermitidoComFilaPausada({ tipo: "CALLBACK_BACKEND" }), true);
  assert.equal(jobPermitidoComFilaPausada({ tipo: "EPEC" }), false);
});

test("lerEstadoContingenciaArquivo só liga com ativa true", () => {
  const { lerEstadoContingenciaArquivo } = require("../fiscal/contingenciaOffline");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cont-json-"));
  const p = path.join(dir, "contingencia.json");
  assert.equal(lerEstadoContingenciaArquivo(p).ativa, false);
  fs.writeFileSync(p, JSON.stringify({ ativa: false }), "utf8");
  assert.equal(lerEstadoContingenciaArquivo(p).ativa, false);
  fs.writeFileSync(p, JSON.stringify({ ativa: true, motivo: "SEFAZ_OFFLINE" }), "utf8");
  assert.equal(lerEstadoContingenciaArquivo(p).ativa, true);
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

test("FORMA_OFFLINE da Lib é 8 (teOffLine); tpEmis XML é 9", () => {
  const { FORMA_OFFLINE, FORMA_NORMAL, TP_EMIS_XML_OFFLINE, normalizarFormaEmissaoLib } =
    require("../fiscal/contingenciaOffline");
  assert.equal(FORMA_NORMAL, "0");
  assert.equal(FORMA_OFFLINE, "8");
  assert.equal(TP_EMIS_XML_OFFLINE, "9");
  assert.equal(normalizarFormaEmissaoLib("9"), "0");
  assert.equal(normalizarFormaEmissaoLib("8"), "8");
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

test("aplicarTpEmisOffline injeta dhCont/xJust em [Identificacao], não no fim do INI", () => {
  const { aplicarTpEmisOffline } = require("../fiscal/contingenciaOffline");
  const ini =
    "[Identificacao]\ntpEmis=1\nnNF=10\nserie=1\n\n[Emitente]\nCNPJCPF=14256223000155\n";
  const out = aplicarTpEmisOffline(ini, {
    dhCont: new Date(2026, 7, 14, 12, 0, 0),
    xJust: "Falha de comunicacao com a SEFAZ",
  });
  const ident = out.split("[Emitente]")[0];
  const emitente = out.split("[Emitente]")[1];
  assert.match(ident, /tpEmis=9/);
  assert.match(ident, /dhCont=14\/08\/2026 12:00:00/);
  assert.match(ident, /xJust=Falha de comunicacao com a SEFAZ/);
  assert.doesNotMatch(emitente, /dhCont=/);
  assert.doesNotMatch(emitente, /xJust=/);
  assert.doesNotMatch(emitente, /tpEmis=/);
});

test("aplicarTpEmisOffline substitui dhCont=0 do modelo ACBr", () => {
  const { aplicarTpEmisOffline } = require("../fiscal/contingenciaOffline");
  const ini = "[Identificacao]\ntpEmis=1\ndhCont=0\nxJust=\n";
  const out = aplicarTpEmisOffline(ini, {
    dhCont: new Date(2026, 7, 14, 12, 0, 0),
    xJust: "Falha de comunicacao com a SEFAZ",
  });
  assert.match(out, /dhCont=14\/08\/2026 12:00:00/);
  assert.doesNotMatch(out, /dhCont=0/);
  assert.match(out, /xJust=Falha de comunicacao com a SEFAZ/);
  assert.equal((out.match(/^tpEmis=/gm) || []).length, 1);
  assert.equal((out.match(/^dhCont=/gm) || []).length, 1);
});

test("xmlNfceOfflineValido distingue 556, 557 e XML off-line ok", () => {
  const { xmlNfceOfflineValido } = require("../fiscal/contingenciaOffline");
  const ok = xmlNfceOfflineValido(
    `<ide><tpEmis>9</tpEmis><dhCont>2026-08-14T12:00:00-03:00</dhCont>` +
      `<xJust>Falha de comunicacao com a SEFAZ</xJust></ide>`,
  );
  assert.equal(ok.ok, true);

  const rej556 = xmlNfceOfflineValido(
    `<ide><tpEmis>1</tpEmis><dhCont>2026-08-14T12:00:00-03:00</dhCont>` +
      `<xJust>Falha de comunicacao com a SEFAZ</xJust></ide>`,
  );
  assert.equal(rej556.ok, false);
  assert.equal(rej556.motivo, "556");

  const rej557 = xmlNfceOfflineValido(`<ide><tpEmis>9</tpEmis></ide>`);
  assert.equal(rej557.ok, false);
  assert.equal(rej557.motivo, "557");

  const chaveOff = "35260814256223000155650010000000019000000010";
  const chaveOn = "35260814256223000155650010000000011000000010";
  assert.equal(require("../fiscal/contingenciaOffline").tpEmisDaChave(chaveOff), "9");
  assert.equal(require("../fiscal/contingenciaOffline").tpEmisDaChave(chaveOn), "1");
  const chaveErrada = xmlNfceOfflineValido(
    `<infNFe Id="NFe${chaveOn}"><ide><tpEmis>9</tpEmis>` +
      `<dhCont>2026-08-14T12:00:00-03:00</dhCont>` +
      `<xJust>Falha de comunicacao com a SEFAZ</xJust></ide></infNFe>`,
  );
  assert.equal(chaveErrada.ok, false);
  assert.equal(chaveErrada.motivo, "chave");

  const idDest2 = xmlNfceOfflineValido(
    `<ide><tpEmis>9</tpEmis><idDest>2</idDest>` +
      `<dhCont>2026-08-14T12:00:00-03:00</dhCont>` +
      `<xJust>Falha de comunicacao com a SEFAZ</xJust></ide>`,
  );
  assert.equal(idDest2.ok, false);
  assert.equal(idDest2.motivo, "idDest");
});

test("statusServicoOperacional reconhece 107 e rejeita vazio", () => {
  const { statusServicoOperacional } = require("../fiscal/contingenciaOffline");
  assert.equal(statusServicoOperacional({ cStat: "107" }), true);
  assert.equal(statusServicoOperacional({ cStat: "0", xMotivo: "" }), false);
  assert.equal(
    statusServicoOperacional({ cStat: "108", xMotivo: "Servico Paralisado Momentaneamente" }),
    false,
  );
  assert.equal(
    statusServicoOperacional({ cStat: "109", xMotivo: "Servico Paralisado sem Previsao" }),
    false,
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

test("lazyEnsureDb abre fila.db antes do bind do index", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nfce-lazy-"));
  const prevDb = process.env.DB_PATH;
  process.env.DB_PATH = path.join(dir, "fila.db");
  try {
    delete require.cache[require.resolve("../fila")];
    delete require.cache[require.resolve("../fiscal/contingenciaOfflineQueue")];
    const fila = require("../fila");
    const queue = require("../fiscal/contingenciaOfflineQueue");
    assert.equal(fila.getDatabase(), null);
    assert.equal(queue.lazyEnsureDb(), true);
    const dh = queue.obterOuAbrirJanelaDhCont(new Date(2026, 7, 14, 11, 0, 0));
    assert.match(dh, /14\/08\/2026 11:00:00/);
    fila.inicializar();
    assert.ok(fila.getDatabase());
  } finally {
    if (prevDb === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prevDb;
  }
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
  assert.ok(calls.some((c) => c[3] === "8"));
  assert.ok(calls.some((c) => c[3] === "0"));
  assert.ok(calls.every((c) => c[3] !== "9"));
});

test("garantirFormaEmissaoOffline reaplica teOffLine após CarregarINI resetar sessão", () => {
  const { garantirFormaEmissaoOffline, FORMA_OFFLINE } = require("../fiscal/contingenciaOffline");
  let forma = "0";
  const inst = {
    configGravarValor(_sec, key, val) {
      if (key === "FormaEmissao") forma = String(val);
    },
    configLerValor(_sec, key) {
      if (key === "FormaEmissao") return forma;
      return "0";
    },
  };
  garantirFormaEmissaoOffline(inst, null);
  assert.equal(forma, FORMA_OFFLINE);
});

test("lerXmlAssinadoDaLista tenta índices alternativos da ACBrLib", () => {
  const { lerXmlAssinadoDaLista } = require("../fiscal/contingenciaOffline");
  const xml =
    "<NFe><ide><tpEmis>9</tpEmis><dhCont>2026-08-14T12:00:00-03:00</dhCont>" +
    "<xJust>Falha de comunicacao com a SEFAZ</xJust></ide></NFe>";
  const inst = {
    obterXml(idx) {
      if (idx === 0) throw new Error("idx 0 indisponível");
      if (idx === -1) return xml;
      return "";
    },
  };
  assert.equal(lerXmlAssinadoDaLista(inst), xml);
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

test("assertXmlProntoParaTransmissao exige assinatura e a mesma chave", () => {
  const {
    assertXmlProntoParaTransmissao,
    xmlTemAssinatura,
    prazoLegalHoras,
    dvChaveNfe,
    chaveNfeDvValido,
  } = require("../fiscal/contingenciaOffline");
  const base43 = "3526081425622300015565001000000001900000001";
  const chave = base43 + dvChaveNfe(base43);
  assert.equal(chaveNfeDvValido(chave), true);
  assert.equal(chave.length, 44);
  const xml =
    `<NFe><infNFe Id="NFe${chave}"><ide><tpEmis>9</tpEmis><idDest>1</idDest>` +
    `<dhCont>2026-08-14T12:00:00-03:00</dhCont>` +
    `<xJust>Falha de comunicacao com a SEFAZ</xJust></ide></infNFe>` +
    `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"></Signature></NFe>`;
  assert.equal(xmlTemAssinatura(xml), true);
  const r = assertXmlProntoParaTransmissao(xml, chave);
  assert.equal(r.ok, true);
  assert.equal(r.chave, chave);
  assert.throws(
    () => assertXmlProntoParaTransmissao(xml.replace("<Signature", "<X"), chave),
    /assinatura/i,
  );
  assert.equal(prazoLegalHoras(), 24);
});

test("cDV inválido recusa XML mesmo com tpEmis=9", () => {
  const { xmlNfceOfflineValido } = require("../fiscal/contingenciaOffline");
  const chaveRuim = "35260814256223000155650010000000019000000010";
  const r = xmlNfceOfflineValido(
    `<infNFe Id="NFe${chaveRuim}"><ide><tpEmis>9</tpEmis><idDest>1</idDest>` +
      `<dhCont>2026-08-14T12:00:00-03:00</dhCont>` +
      `<xJust>Falha de comunicacao com a SEFAZ</xJust></ide></infNFe>`,
  );
  assert.equal(r.ok, false);
  assert.equal(r.motivo, "cDV");
});

test("persistirXmlFilaAposDanfe só grava se chave e assinatura baterem", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nfce-danfe-"));
  const { dvChaveNfe, persistirXmlFilaAposDanfe } = require("../fiscal/contingenciaOffline");
  const chave = "3526081425622300015565001000000001900000001" + dvChaveNfe("3526081425622300015565001000000001900000001");
  const xmlPath = path.join(dir, `${chave}-nfe.xml`);
  const xml =
    `<NFe><infNFe Id="NFe${chave}"><ide><tpEmis>9</tpEmis><idDest>1</idDest>` +
    `<dhCont>2026-08-14T12:00:00-03:00</dhCont>` +
    `<xJust>Falha de comunicacao com a SEFAZ</xJust></ide></infNFe>` +
    `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"></Signature></NFe>`;
  fs.writeFileSync(xmlPath, xml, "utf8");
  const comQr = xml.replace("</ide>", "</ide><infNFeSupl><qrCode>https://qr</qrCode></infNFeSupl>");
  const out = persistirXmlFilaAposDanfe(xmlPath, comQr, chave);
  assert.ok(out.includes("https://qr"));
  assert.ok(fs.readFileSync(xmlPath, "utf8").includes("https://qr"));
  const recusado = persistirXmlFilaAposDanfe(xmlPath, comQr.replace("<Signature", "<X"), chave);
  assert.equal(recusado, null);
});

test("classificarResultadoSync: XML inválido sai da fila (não retenta)", () => {
  const { classificarResultadoSync } = require("../fiscal/contingenciaOffline");
  const r = classificarResultadoSync(
    new Error("[ContingenciaOffline] XML sem assinatura — não transmitir"),
  );
  assert.equal(r.tipo, "REJEICAO");
  assert.equal(r.reter, false);
  const diverge = classificarResultadoSync(
    new Error("[ContingenciaOffline] chave devolvida (aaa) diverge da impressa (bbb)"),
  );
  assert.equal(diverge.tipo, "REJEICAO");
  assert.equal(diverge.reter, false);
});

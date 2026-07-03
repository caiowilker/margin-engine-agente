/**
 * Teste explícito de deduplicação de correlationId em filaFiscal.enfileirar
 *
 * Valida os requisitos:
 *  1. Enfileirar o mesmo correlationId duas vezes → segundo retorna deduplicado=true
 *  2. Dois correlationIds diferentes → dois jobs criados (sem falso positivo)
 *  3. Simulação "duplo clique" frontend: apenas UMA NFC-e é processada
 *  4. Job já AUTORIZADO com o mesmo correlationId → deduplicado=true, concluido=true
 *  5. Job com correlationId diferente mas mesmo numeroVenda → deduplicado=true (venda ativa)
 *  6. Correlação nula não causa deduplicação incorreta
 */
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

// ─── Isolar banco de dados para este test ────────────────────────────────────
const DB_PATH = path.join(__dirname, `data-corrdedup-${Date.now()}.db`);
const METRICS_DB = path.join(__dirname, `data-corrdedup-metrics-${Date.now()}.db`);
process.env.FISCAL_DB_PATH = DB_PATH;
process.env.FISCAL_METRICS_DB = METRICS_DB;
// Desabilitar rate-limit por UF para isolar deduplicação
process.env.SEFAZ_RL_UF_HABILITADO = "false";

const filaFiscal = require("../filaFiscal");

const PAYLOAD_BASE = {
  tipo: "NFCE",
  numeroVenda: "TEST-CORR-001",
  total: 100,
  cnpj: "12345678000199",
  uf: "SP",
  itens: [{ nome: "Produto A", quantidade: 1, valorUnitario: 100 }],
};

before(() => {
  filaFiscal.resetDbForTests?.();
});

after(() => {
  filaFiscal.fecharDb?.();
  [DB_PATH, METRICS_DB].forEach((f) => {
    try { fs.unlinkSync(f); } catch { /* ignora */ }
  });
});

test("1. mesmo correlationId → segundo enfileiramento retorna deduplicado=true", () => {
  const corrId = "corr-dedup-test-1";
  const payload = { ...PAYLOAD_BASE, numeroVenda: "TEST-CORR-D1" };

  const primeiro = filaFiscal.enfileirar("EMISSAO", payload, corrId, payload.numeroVenda);
  assert.ok(primeiro.id, "primeiro job deve ter id");
  assert.ok(!primeiro.deduplicado, "primeiro não deve ser marcado como deduplicado");

  const segundo = filaFiscal.enfileirar("EMISSAO", payload, corrId, payload.numeroVenda);
  assert.strictEqual(segundo.deduplicado, true, "segundo deve ser marcado como deduplicado");
  assert.strictEqual(segundo.id, primeiro.id, "deve retornar o ID do job original");
  assert.strictEqual(segundo.correlationId, corrId, "deve retornar o correlationId original");
});

test("2. correlationIds diferentes → dois jobs distintos criados", () => {
  const payload1 = { ...PAYLOAD_BASE, numeroVenda: "TEST-CORR-D2A" };
  const payload2 = { ...PAYLOAD_BASE, numeroVenda: "TEST-CORR-D2B" };

  const job1 = filaFiscal.enfileirar("EMISSAO", payload1, "corr-d2-alpha", payload1.numeroVenda);
  const job2 = filaFiscal.enfileirar("EMISSAO", payload2, "corr-d2-beta", payload2.numeroVenda);

  assert.ok(job1.id, "job1 deve ter id");
  assert.ok(job2.id, "job2 deve ter id");
  assert.notStrictEqual(job1.id, job2.id, "jobs distintos devem ter IDs diferentes");
  assert.ok(!job1.deduplicado, "job1 não deve ser deduplicado");
  assert.ok(!job2.deduplicado, "job2 não deve ser deduplicado");
});

test("3. simulação duplo clique: apenas UM job ativo para a venda", () => {
  const corrId = "corr-duplo-clique-frontend";
  const numeroVenda = "TEST-CORR-D3";
  const payload = { ...PAYLOAD_BASE, numeroVenda };

  // Simula primeiro clique
  const click1 = filaFiscal.enfileirar("EMISSAO", payload, corrId, numeroVenda);
  assert.ok(click1.id, "primeiro clique deve criar job");
  assert.ok(!click1.deduplicado, "primeiro clique não é duplicata");

  // Simula segundo clique imediato (mesmo correlationId → mesmo job)
  const click2 = filaFiscal.enfileirar("EMISSAO", payload, corrId, numeroVenda);
  assert.strictEqual(click2.deduplicado, true, "segundo clique deve ser deduplicado");
  assert.strictEqual(click2.id, click1.id, "segundo clique deve referenciar o mesmo job");

  // Simula terceiro envio (timeout + retry com mesmo correlationId)
  const click3 = filaFiscal.enfileirar("EMISSAO", payload, corrId, numeroVenda);
  assert.strictEqual(click3.deduplicado, true, "terceiro envio deve ser deduplicado");
  assert.strictEqual(click3.id, click1.id, "terceiro envio deve referenciar o mesmo job");
});

test("4. mesmo numeroVenda com correlationId diferente → deduplica por venda ativa", () => {
  const numeroVenda = "TEST-CORR-D4";
  const payload = { ...PAYLOAD_BASE, numeroVenda };

  // Primeiro enfileiramento cria o job
  const jobOriginal = filaFiscal.enfileirar("EMISSAO", payload, "corr-original-d4", numeroVenda);
  assert.ok(jobOriginal.id, "job original deve existir");
  assert.ok(!jobOriginal.deduplicado);

  // Segundo enfileiramento com correlationId diferente mas mesma venda
  // (cenário: frontend gerou novo ID mas venda já tem job ativo)
  const jobDuplicado = filaFiscal.enfileirar("EMISSAO", payload, "corr-diferente-d4", numeroVenda);
  assert.strictEqual(jobDuplicado.deduplicado, true,
    "deve deduplicar pelo numeroVenda (venda com job ativo)");
});

test("5. correlationId nulo não causa deduplicação incorreta entre vendas distintas", () => {
  const payload1 = { ...PAYLOAD_BASE, numeroVenda: "TEST-CORR-D5A" };
  const payload2 = { ...PAYLOAD_BASE, numeroVenda: "TEST-CORR-D5B" };

  // Sem correlationId — cada venda é distinta
  const job1 = filaFiscal.enfileirar("EMISSAO", payload1, null, payload1.numeroVenda);
  const job2 = filaFiscal.enfileirar("EMISSAO", payload2, null, payload2.numeroVenda);

  assert.ok(job1.id, "job1 deve ter id");
  assert.ok(job2.id, "job2 deve ter id");
  assert.notStrictEqual(job1.id, job2.id,
    "vendas distintas sem correlationId não devem ser deduplicadas entre si");
});

test("6. venda já concluída (emissao_resultados CONCLUIDO) → enfileirar retorna concluido=true", () => {
  const corrId = "corr-ja-concluido-d6";
  const numeroVenda = "TEST-CORR-D6";
  const payload = { ...PAYLOAD_BASE, numeroVenda };

  // Registra diretamente um resultado CONCLUIDO na tabela emissao_resultados
  // (como acontece após a NFC-e ser autorizada com sucesso pelo SEFAZ)
  filaFiscal.salvarResultadoEmissao(corrId, numeroVenda, "CONCLUIDO", { chave: "3524000000001" }, null);

  // Simula frontend reenviando após timeout — mesma venda
  const reenvio = filaFiscal.enfileirar("EMISSAO", payload, corrId, numeroVenda);
  assert.strictEqual(reenvio.deduplicado, true,
    "reenvio após conclusão deve ser deduplicado");
  assert.strictEqual(reenvio.concluido, true,
    "deve indicar que a emissão já foi concluída");
});

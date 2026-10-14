/**
 * B7 — checklist dourados.
 *
 * Sem XML autorizado: marca como **todo/pending** (não skip), para o CI mostrar
 * cobertura incompleta em vez de parecer “verde sem teste”.
 * Com XML em test/fixtures/fiscal-dourados/<caso>.xml: executa asserts mínimos.
 */
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "fixtures", "fiscal-dourados");

const CASOS = [
  { id: "frete-na-base", titulo: "Frete na base ICMS próprio / ST" },
  { id: "st-com-ipi", titulo: "ST com IPI na base ST" },
  { id: "cst-60-500", titulo: "CST 60 / CSOSN 500 sem ST novo" },
  { id: "difal-b2c", titulo: "DIFAL B2C base única" },
  { id: "difal-cst20-uf", titulo: "DIFAL CST 20 por UF" },
  { id: "fem-fecop", titulo: "FEM/FECOP (destaca e/ou MVA)" },
  { id: "devolucao", titulo: "Devolução / refNFe" },
];

describe("Checklist dourados (XML autorizado)", () => {
  for (const c of CASOS) {
    const xmlPath = path.join(ROOT, `${c.id}.xml`);
    const temXml = fs.existsSync(xmlPath);
    const rel = path.relative(process.cwd(), xmlPath);

    if (!temXml) {
      // node:test "todo" aparece como pending no relatório — não conta como pass.
      test(`${c.id}: ${c.titulo}`, { todo: `PENDENTE — forneça ${rel} autorizado anonimizado` });
      continue;
    }

    test(`${c.id}: ${c.titulo}`, () => {
      const xml = fs.readFileSync(xmlPath, "utf8");
      assert.ok(xml.includes("<NFe") || xml.includes("<nfeProc"), "XML NF-e esperado");
      assert.ok(
        !/\b\d{11}\b/.test(xml.replace(/<chNFe>\d{44}<\/chNFe>/g, "")),
        "evitar CPF em fixture",
      );
      assert.ok(true);
    });
  }
});

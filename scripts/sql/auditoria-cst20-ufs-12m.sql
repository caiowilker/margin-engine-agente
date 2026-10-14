-- B1 — Auditoria agregada CST 20 (últimos 12 months)
-- Somente leitura. Sem CNPJ/CPF/nome/chave no SELECT.
-- Schema margin-engine (PostgreSQL) — consulta 14/10/2026.

-- A) UFs da carteira (destino típico = UF do tenant)
SELECT uf AS uf_tenant, COUNT(*) AS qtd_tenants
FROM tenant
WHERE uf IS NOT NULL AND btrim(uf) <> ''
GROUP BY uf
ORDER BY qtd_tenants DESC;

-- B) Entrada: UF origem fornecedor × NCM com CST 20
SELECT
  n.uf_emitente AS uf_origem_fornecedor,
  i.ncm,
  COUNT(*) AS qtd_itens,
  COUNT(DISTINCT n.id) AS qtd_notas
FROM nota_fiscal_entrada n
JOIN nota_fiscal_entrada_item i ON i.nota_fiscal_entrada_id = n.id
WHERE n.data_emissao >= (CURRENT_DATE - INTERVAL '12 months')
  AND n.status NOT IN ('CANCELADA', 'CANCELADA_SEFAZ')
  AND TRIM(COALESCE(i.cst_icms, '')) = '20'
GROUP BY n.uf_emitente, i.ncm
ORDER BY qtd_itens DESC, uf_origem_fornecedor, i.ncm;

-- C) Saída PDV: docs XML com alguma tag <CST>20</CST> × UF destino (enderDest)
WITH docs AS (
  SELECT id, xml_content
  FROM pdv_documento_fiscal
  WHERE criado_em >= (CURRENT_DATE - INTERVAL '12 months')
    AND tipo = 'XML'
    AND xml_content IS NOT NULL
    AND length(xml_content) > 200
),
marcados AS (
  SELECT
    id,
    xml_content,
    substring(xml_content from '(?s)<dest[^>]*>.*?<UF>([A-Z]{2})</UF>') AS uf_dest,
    (SELECT COUNT(*) FROM regexp_matches(xml_content, '<CST>20</CST>', 'g')) AS hits_cst20
  FROM docs
)
SELECT uf_dest, SUM(hits_cst20) AS hits_cst20, COUNT(*) FILTER (WHERE hits_cst20 > 0) AS docs_com_cst20
FROM marcados
GROUP BY uf_dest
ORDER BY hits_cst20 DESC NULLS LAST;

-- D) NCMs em XMLs que contêm ao menos um CST 20 (aproximação; não amarra NCM ao item)
WITH docs AS (
  SELECT xml_content
  FROM pdv_documento_fiscal
  WHERE criado_em >= (CURRENT_DATE - INTERVAL '12 months')
    AND tipo = 'XML'
    AND xml_content IS NOT NULL
    AND xml_content ~ '<CST>20</CST>'
),
ncms AS (
  SELECT unnest(regexp_matches(xml_content, '<NCM>([0-9]{8})</NCM>', 'g')) AS ncm
  FROM docs
)
SELECT ncm, COUNT(*) AS ocorrencias
FROM ncms
GROUP BY ncm
ORDER BY ocorrencias DESC
LIMIT 50;

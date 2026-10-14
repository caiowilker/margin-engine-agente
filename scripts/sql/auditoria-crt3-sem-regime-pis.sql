-- Pré-publicação acbr.js: CRT 3 sem LUCRO_PRESUMIDO/LUCRO_REAL
-- Somente leitura. Sem CNPJ/razão social — só prefixo de UUID + regime/CRT.

-- 1) Cadastro atual
SELECT
  LEFT(t.id::text, 8) AS tenant_prefix,
  t.regime_tributario AS regime_storage,
  CASE
    WHEN UPPER(TRIM(t.regime_tributario)) IN ('LUCRO_PRESUMIDO', 'LUCRO_REAL') THEN 'OK_PIS_COFINS'
    WHEN UPPER(TRIM(t.regime_tributario)) IN ('SIMPLES', 'SIMPLES_NACIONAL', 'MEI') THEN 'CRT1_OU_4'
    WHEN UPPER(TRIM(t.regime_tributario)) LIKE '%EXCESSO%' OR UPPER(TRIM(t.regime_tributario)) = 'SIMPLES_EXCESSO'
      THEN 'CRT2'
    ELSE 'CRT3_SEM_PRESUMIDO_OU_REAL'
  END AS gate_acbr_crt3
FROM tenant t
ORDER BY gate_acbr_crt3, regime_storage;

-- 2) CRT oficial vigente (histórico) × storage
SELECT
  LEFT(t.id::text, 8) AS tenant_prefix,
  h.crt_oficial,
  h.regime_storage AS regime_hist,
  t.regime_tributario AS regime_cadastro,
  h.vigente_desde,
  h.vigente_ate,
  CASE
    WHEN h.crt_oficial = '3'
     AND UPPER(TRIM(COALESCE(t.regime_tributario, h.regime_storage, '')))
         NOT IN ('LUCRO_PRESUMIDO', 'LUCRO_REAL')
      THEN 'RISCO_FALHA_EMISSAO_CRT3'
    ELSE 'OK'
  END AS risco
FROM tenant t
JOIN LATERAL (
  SELECT *
  FROM tenant_crt_historico h
  WHERE h.tenant_id = t.id
    AND (h.vigente_ate IS NULL OR h.vigente_ate >= CURRENT_DATE)
  ORDER BY h.vigente_desde DESC NULLS LAST
  LIMIT 1
) h ON true
WHERE h.crt_oficial = '3'
   OR UPPER(TRIM(t.regime_tributario)) IN ('LUCRO_PRESUMIDO', 'LUCRO_REAL', 'NORMAL')
ORDER BY risco DESC, tenant_prefix;

-- 3) Contagem agregada do risco
SELECT
  CASE
    WHEN h.crt_oficial = '3'
     AND UPPER(TRIM(COALESCE(t.regime_tributario, ''))) NOT IN ('LUCRO_PRESUMIDO', 'LUCRO_REAL')
      THEN 'CRT3_SEM_REGIME_PIS'
    WHEN h.crt_oficial = '3' THEN 'CRT3_OK'
    ELSE 'OUTROS'
  END AS bucket,
  COUNT(*) AS qtd
FROM tenant t
LEFT JOIN LATERAL (
  SELECT crt_oficial, regime_storage, vigente_ate
  FROM tenant_crt_historico h
  WHERE h.tenant_id = t.id
    AND (h.vigente_ate IS NULL OR h.vigente_ate >= CURRENT_DATE)
  ORDER BY h.vigente_desde DESC NULLS LAST
  LIMIT 1
) h ON true
GROUP BY 1
ORDER BY 1;

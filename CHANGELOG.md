# Changelog

## [1.0.161] — 2026-10-15

### Fixed / hardened
- Preview da faixa com gap/perfuração proporcional (rolo duplo/triplo).
- Calibração ZPL com molduras + marca no meio; botões Calibrar/Teste 1× em destaque.
- Ajuste fino L×A/colunas (personalizado); presets duplo alinhados a rolos reais.

## [1.0.160] — 2026-10-15

### Fixed
- Presets 2 e 3 colunas exclusivos (seleção por `id`, não por mm).
- Inputs numéricos permitem apagar/digitar sem forçar 0 no meio da edição.
- Rolo duplo com presets maiores (40×30, 50×25, 50×40); UX Central e avulsa.

## [1.0.159] — 2026-10-15

### Added
- Central de impressão de etiquetas (`/pdv/etiquetas/central`): lote multi-produto, mídia multi-coluna ZPL (1–4, padrão 33×22·3 col), calibração, histórico Postgres, CSV codigo;qtd.
- Backend: `POST /pdv/etiquetas/lote/preparar`, calibração, histórico; grouper multi-coluna com ^PQ; busca de produtos sem acento + categoria/estoque.

### Fixed / hardened
- Orquestrador: só marca OK após envio RAW; cancelamento/pendentes → FALHA; histórico sempre gravado; exige porta.
- Gaps padrão 2 mm → linha 104 mm (cabe na L42 Pro); aviso de largura na UI e na calibração.
- Preview da 1ª faixa com `colunaInicial`; teste 1×; `modelo` no gerarDeProduto/preview.

### Notes
- Multi-coluna só em ZPL na v1 (PPLA desabilitado com colunas>1).
- Preset 33×22·3 col: margem 1 + 3×33 + 2×2 = 104 mm (área útil típica da L42 Pro).

T
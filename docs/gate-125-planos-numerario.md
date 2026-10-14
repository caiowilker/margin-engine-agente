# Gate 1.0.126 — Numerário em todos os planos com PDV

## Problema

O botão **Ligar $** em Lojas chamava `PUT /retail/lojas/{id}/controle-numerario`.
`PlanFeaturePathFilter` mapeia `/retail/**` → `ERP_RETAIL` (Rede+), gerando **HTTP 402**
em MERCADO/ESSENTIAL. Efeito colateral de path, não regra de produto.

## Correção

1. **Exceção estreita** no filter: só
   `/retail/lojas/{id}/controle-numerario` e `.../auditoria` ficam sem gate de plano.
   Demais `/retail/**` (listagem CRUD, etc.) continuam exigindo `ERP_RETAIL`.
2. **Caminho PDV canônico**: `GET/PUT /pdv/caixa/lojas[...]` — listagem operacional +
   toggle/status/auditoria. Front usa este path.
3. **UX canônica**: toggle **somente** em **Configurações do PDV**
   (`/configuracoes/pdv-operacional`) — ADMIN/OWNER em qualquer plano com PDV.
   A tela **Lojas** não tem mais o botão de numerário (só CRUD de filiais / ERP).
4. Lojas com flag OFF permanecem no fluxo antigo.

## Requisitos de plano por endpoint do fluxo

| Endpoint | Feature de plano |
|---|---|
| `PUT/GET /pdv/caixa/lojas/{id}/controle-numerario` | nenhuma (core PDV) |
| `GET /pdv/caixa/lojas/{id}/controle-numerario/auditoria` | nenhuma |
| `GET /pdv/caixa/lojas` | nenhuma |
| `PUT/GET /retail/lojas/{id}/controle-numerario[+ /auditoria]` | nenhuma (exceção) |
| `GET/POST/PUT /retail/lojas` (CRUD) | **ERP_RETAIL** (Rede+) |
| `GET /pdv/tesouraria/contas` | nenhuma |
| `POST /pdv/caixa/abrir` / `fechar` (destinos OPERADOR) | nenhuma |
| `GET /pdv/caixa/{id}/gaveta` | nenhuma |
| `GET /pdv/caixa/fechamentos/{id}/pdf` | nenhuma |
| `GET /pdv/numerario/abertura-preview` | nenhuma |
| `GET /pdv/numerario/transferencias-pendentes` | nenhuma |
| `POST .../resolver` / `resolver-disputa` | nenhuma |
| `POST /pdv/vendas` | nenhuma |

Nenhum endpoint do fluxo exige plano acima de PDV. Tesouraria avançada (CRUD) também não
está sob gate de plano — **não foi introduzido gate novo** nesta entrega.

## Teste HTTP real (sem `FORCE_NUMERARIO_SQL`)

Script: `margin-engine/scripts/smoke-numerario-planos.mjs`  
Log: `docs/gate-126-numerario-planos-http.log`

### MERCADO (`caiotest@gmail.com`, loja `75fc1146-…`)

- Ligar via `PUT /pdv/caixa/lojas/.../controle-numerario` → **200**
- `GET /retail/lojas` → **402** (ERP intacto)
- Abrir → vender DINHEIRO R$10 → fechar destino OPERADOR → pendência → aceite → saldo 1000 → abrir com saldo → **PASS**

### ESSENTIAL (`amw@gmail.com`, loja `25ebdf24-…`, dispositivo 22)

- Ligar via HTTP → **200** (sem SQL force do flag)
- `GET /retail/lojas` → **402**
- Mesmo fluxo ponta a ponta → **PASS**

Nota de fixture (não é force do numerário): assinatura ESSENTIAL estava expirada
(`assinatura_expirada`) — `subscription_expires_at` estendido para o teste; loja/dispositivo
ESSENTIAL provisionados porque o tenant não tinha PDV operacional.

# Rate Limiting SEFAZ por UF

Descrição do mecanismo implementado, valores default e como ajustar por ambiente.

## Contexto

O SEFAZ impõe limites de requisição por certificado emitente e por UF, sem documentação oficial pública sobre os valores exatos. Baseado em experiência de produção e documentação de integradores, as UFs mais restritivas (MG, SP, RS) costumam bloquear emissores que ultrapassam ~3–5 req/s por certificado durante picos.

O agente já possuía rate-limit por CNPJ (min/hora). Este módulo adiciona uma camada ortogonal: **token-bucket por UF**, que limita a taxa de envio ao ACBr/SEFAZ independentemente do CNPJ emitente.

## Como funciona

O módulo `fiscal/ufRateLimit.js` implementa um token-bucket por UF:

- Cada UF tem um bucket com capacidade `burst` (tokens acumulados).
- A cada segundo, `taxa` tokens são adicionados ao bucket (até o limite `burst`).
- Antes de enviar ao ACBr, `fiscalService.js` chama `consumir(uf)`:
  - Se há ≥ 1 token: consome, retorna `{ ok: true }`.
  - Se não há token: retorna `{ ok: false, aguardarMs }` com jitter aleatório.
- Quando bloqueado, o job é devolvido à fila (`filaFiscal.adiarJob`) com `proxima_tentativa = agora + aguardarMs`, **sem incrementar a contagem de tentativas**.
- Jitter (0–JITTER_MAX_MS) distribui reenvios para evitar thundering-herd quando SEFAZ retorna.

## Variáveis de ambiente

| Variável | Default | Descrição |
|---|---|---|
| `SEFAZ_RL_UF_HABILITADO` | `true` | Ativa/desativa o rate-limit por UF globalmente |
| `SEFAZ_RL_TAXA_PADRAO` | `3` | Taxa padrão (tokens/segundo) para UFs sem configuração específica |
| `SEFAZ_RL_BURST_PADRAO` | `5` | Burst máximo padrão (tokens acumulados no bucket) |
| `SEFAZ_RL_JITTER_MS` | `2000` | Jitter máximo (ms) adicionado ao aguardarMs para distribuir reenvios |
| `SEFAZ_RL_<UF>_TAXA` | — | Taxa específica por UF (ex.: `SEFAZ_RL_SP_TAXA=2`) |
| `SEFAZ_RL_<UF>_BURST` | — | Burst específico por UF (ex.: `SEFAZ_RL_SP_BURST=3`) |

Todas as variáveis são lidas dinamicamente — não é necessário reiniciar o agente para ajustar.

## Valores default escolhidos

- **Taxa: 3 tokens/segundo** — Conservador para a maioria das UFs. A SEFAZ SP e MG já reportaram bloqueios acima de 5/s em produção (cStat 999 em sequência durante picos).
- **Burst: 5 tokens** — Permite um pequeno pico de até 5 emissões imediatas (ex.: checkout simultâneo de caixas em horário de pico) antes de entrar em rate-limiting sustentado.
- **Jitter: 2000ms** — Distribui reenvios em até 2 segundos adicionais, evitando que todas as lojas de uma rede retomem ao mesmo tempo após indisponibilidade SEFAZ.

## Configurações sugeridas por UF de maior volume

| UF | Taxa sugerida | Burst sugerido | Observação |
|---|---|---|---|
| SP | 2 | 4 | SEFAZ SP é mais restritivo em picos |
| MG | 2 | 4 | Regra 656 MG bloqueia após rajadas |
| RS | 3 | 5 | Default adequado |
| RJ, PR, SC | 3 | 5 | Default adequado |
| Demais UFs | 3 | 5 | Default global |

Para ajustar SP especificamente:

```
SEFAZ_RL_SP_TAXA=2
SEFAZ_RL_SP_BURST=4
```

## Métricas e observabilidade

- O endpoint `/diagnostico/alertas` inclui dados de rate-limit por CNPJ (módulo existente `fiscalRateLimit`).
- O módulo `fiscal/ufRateLimit.js` expõe `metricas()` com contagem `emitidos` e `bloqueados` por UF.
- `fiscalMetrics.registrarBloqueioUf(uf)` contabiliza cada bloqueio por UF — visível no snapshot de métricas.
- Logs de bloqueio são gerados como WARN com campo `uf`, `aguardarMs`, `tokensDisponiveis`.

Exemplo de log de bloqueio:

```json
{
  "level": "WARN",
  "modulo": "uf_rate_limit",
  "uf": "SP",
  "tokensDisponiveis": "0.12",
  "aguardarMs": 734,
  "taxaConfigurada": 2,
  "burst": 4,
  "message": "[UF Rate Limit] Token esgotado — emissão adiada"
}
```

## Interação com rate-limit por CNPJ existente

Os dois mecanismos são independentes e complementares:

- **Por CNPJ** (`fiscalRateLimit.js`): janela deslizante min/hora + backoff por cStat. Protege contra tempestade após rejeições SEFAZ.
- **Por UF** (`fiscal/ufRateLimit.js`): token-bucket de throughput. Protege contra excesso de taxa em picos normais de venda.

Um job pode ser bloqueado por qualquer um dos dois. A checagem por CNPJ ocorre primeiro; se passar, a checagem por UF ocorre logo em seguida.

## Como desativar (emergência)

Para desativar imediatamente sem deploy:

```
SEFAZ_RL_UF_HABILITADO=false
```

Recarregue o arquivo `.env` ou reinicie o agente.

## Testes

Os testes estão em `test/uf-rate-limit.test.js` (10 casos):

- Burst da mesma UF é escalonado
- UFs diferentes não bloqueiam uma à outra
- Tokens se regeneram proporcionalmente ao tempo
- Jitter aplicado ao aguardarMs
- `extrairUf` funciona com diferentes formatos de payload
- Módulo desabilitado deixa tudo passar
- Métricas por UF registram corretamente
- Configuração por UF via env
- `aguardarMs` calculado com precisão
- `filaFiscal.adiarJob` devolve job para PENDENTE sem incrementar tentativas

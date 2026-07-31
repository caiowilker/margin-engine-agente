# Checklist de campo — impressora térmica (produção)

Use em cada PC de caixa antes de liberar o turno.

## Hardware / Windows (PDV real)

1. Impressora `POSPrinter POS80` (ou modelo da loja) aparece em **Dispositivos e Impressoras**.
2. Preferir **driver do fabricante** (Epson APD / Star / Elgin), não só o genérico Microsoft.
3. Teste fora do PDV: página de teste / Notepad em modo **RAW** na mesma fila.
4. Cabo USB direto no PC (evitar hub barato); trocar porta USB se houver hang.
5. Propriedades da impressora:
   - **Desmarcar** “Habilitar suporte bidirecional” (evita timeout de status no spooler).
   - Avançado: testar “Iniciar a imprimir imediatamente”; se hang, limpar fila e USB.
6. Gerenciador de dispositivos → Hubs USB raiz → **desmarcar** “Permitir que o computador desligue este dispositivo para economizar energia”.
7. Plano de energia → Desativar **suspensão seletiva de USB**.
8. Nenhum outro app (ACBr Monitor, utilitário do fabricante, outro PDV) deve segurar a fila da POS80.
9. **Topology USB:** se térmica **e** token/cert/pinpad estão no **mesmo hub USB**, no `.env` do agente:
   - `PHYSICAL_USB_TOPOLOGY=shared`
   - (default `separate` — portas traseiras distintas, sem serializar NFC-e×print)

## Agente Margin Engine

1. Serviço **Margin Engine** em execução; build **1.0.5+** (fail-fast worker + TCP validado).
2. Configuração → Impressão: porta `RAW:…` **ou** `TCP:192.168.x.x:9100` **com pontos** (nunca `192168150`); modelo Epson/POS = `1`.
3. Imprimir página de teste pelo PDV — deve sair em poucos segundos. Se USB hangar de forma crônica, preferir TCP:9100 na rede local.
4. Se o **primeiro** cupom via ACBr der timeout: log de circuito RAW aberto; o **segundo** cupom vai **native direto** (sem tentar ACBr; tipicamente &lt; 2 s).
5. Poll de status por alguns minutos: **não** spammar `Configuração salva`.
6. Abort/timeout na UI: mensagem de **ocupado / 2ª via**, não “Agente off”, se `/health` responde.
7. Hard drain: **sem** segunda via automática no mesmo job (anti-dupla). Use 2ª via se o papel não saiu.
8. Worker PosPrinter (`ACBR_POS_WORKER=true`): se hang, log `print.worker_kill` + circuito; rollback emergencial: `ACBR_POS_WORKER=false` + reiniciar serviço.
9. Timeouts no `.env` devem bater com o bloco `PRINT_ENV_SCHEMA` do `.env.example` (não usar 8000 legado).
10. Em máquina lenta (~2 min): logs esperados `print.taskkill_attempt` + `print.child_exit` / `print.late_abandoned` com `lateMs`; `/health` e caixa devem continuar OK. Se `print.taskkill_still_alive` → processar checklist USB acima. Notepad na mesma fila é o teste decisivo.
11. **Diagnóstico Win32 (máquina lenta):** rode `scripts/diagnose-raw-print.ps1` **nessa PC e na PC boa** e compare. No agente, o log `print.raw_win32_timing` mostra `slowest=` (`WritePrinter` / `EndDocPrinter` / `OpenPrinter`). Se a etapa lenta for WritePrinter/EndDocPrinter com fila RAW ok → problema abaixo do agente (USB/driver/spooler).
12. **Após update / falha ACBr:** o circuito fica aberto (comerciais via native) até **Salvar** porta/modelo ou **Detectar force**. TTL padrão é `0` (não reabre sozinho). Opcional: `ACBR_POS_CIRCUIT_TTL_MS=900000` para half-open em 15 min. Confirme modelo Epson (`1`) e porta `RAW:`/`TCP:` válida.

## Critérios de aceite rápidos

| Cenário | Esperado |
|--------|----------|
| Poll 10 min sem mudar config | Sem `Configuração salva` repetido |
| Circuito aberto + cupom | Factory/native direto; sem `POS_Ativar` |
| POST print Abort | `timeout_impressao`, caixa online |
| Hard drain | Job `ERRO`; **sem** fallback físico no mesmo job |
| Reinício do serviço | Circuito permanece aberto até Detectar force |
| Worker kill | `/health` responde; próximo cupom native |
| RAW soft kill | `printTimedOut` / `RAW_PRINT_TIMEOUT`; physicalLock só libera após kill confirmado ou `PRINTER_RAW_KILL_HOLD_MS` |
| `PHYSICAL_USB_TOPOLOGY=shared` | NFC-e e print não se sobrepõem no hub |
| Build | Agente/instalador **1.0.5+** |

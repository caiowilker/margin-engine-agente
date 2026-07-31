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

## Agente Margin Engine

1. Serviço **Margin Engine** em execução; build **1.0.3+**.
2. Configuração → Impressão: porta `RAW:…` correta; modelo Epson/POS = `1`.
3. Imprimir página de teste pelo PDV — deve sair em poucos segundos.
4. Se o **primeiro** cupom via ACBr der timeout: log de circuito RAW aberto; o **segundo** cupom vai **native direto** (sem tentar ACBr; tipicamente &lt; 2 s).
5. Poll de status por alguns minutos: **não** spammar `Configuração salva`.
6. Abort/timeout na UI: mensagem de **ocupado / 2ª via**, não “Agente off”, se `/health` responde.
7. Hard drain: **sem** segunda via automática no mesmo job (anti-dupla). Use 2ª via se o papel não saiu.

## Critérios de aceite rápidos

| Cenário | Esperado |
|--------|----------|
| Poll 10 min sem mudar config | Sem `Configuração salva` repetido |
| Circuito aberto + cupom | Factory/native direto; sem `POS_Ativar` |
| POST print Abort | `timeout_impressao`, caixa online |
| Hard drain | Job `ERRO`; **sem** fallback físico no mesmo job |
| Reinício do serviço | Circuito permanece aberto até Detectar force |
| Build | Agente/instalador/front **1.0.3** |

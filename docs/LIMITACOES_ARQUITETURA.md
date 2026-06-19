# Limitações de arquitetura — Agente Local

Documento formal das restrições de design que **não são bugs** e não serão eliminadas por código sem trocar componentes externos.

---

## Limitação 1 — 1 agente = 1 ACBr = 1 caixa

**Causa:** o cliente ACBr usa mutex TCP; não é thread-safe para múltiplas conexões simultâneas.

**Impacto:** throughput máximo de ~60–120 NFC-e/hora por instância do agente.

**Cenários afetados:** supermercado, multi-caixa com alto volume, operação 24×7 sem janela de baixo movimento.

**Solução para escalar:** rodar uma instância do agente por caixa físico, cada um com sua própria porta e seu próprio ACBr. O front já suporta isso via `AGENTE_URL` por caixa.

**Não há solução de código** que elimine esse limite sem trocar o cliente ACBr.

---

## Limitação 2 — Line endings Windows vs Linux no SHA-256 do manifest

**Causa:** `npm run manifest` calcula SHA-256 do arquivo como está no disco. Se o ambiente de build usa LF e o deploy Windows usa CRLF (ou vice-versa), o hash muda.

**Impacto:** `manifestUpdater.js` rejeita o update como adulterado.

**Solução:**

- Sempre rodar `npm run manifest` no **mesmo ambiente** onde os arquivos finais serão copiados (ou configurar `.gitattributes` com `* text=auto eol=lf`).
- Documentado no `README.md`: o manifest deve ser gerado **pós-cópia** no servidor de destino quando houver risco de conversão de line endings.

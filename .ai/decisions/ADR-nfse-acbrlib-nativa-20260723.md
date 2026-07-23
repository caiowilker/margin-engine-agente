# ADR — NFS-e via ACBrLib nativa

**Data:** 2026-07-23  
**Status:** Aceito

## Contexto

A emissão de NFS-e no agente usava apenas ACBr Monitor (`NFSe.CriarEnviar`). A DLL `ACBrNFSe64.dll` passou a existir em `acbrlib/lib/`, alinhada ao modelo já usado para NF-e/NFC-e com `@projetoacbr/acbrlib-nfe-node`.

## Decisão

1. Adotar `@projetoacbr/acbrlib-nfse-node` (`ACBrLibNFSeMT`) para emissão nativa FFI no Windows.
2. Resolver a biblioteca por `ACBR_NFSE_LIB_PATH` ou `acbrlib/lib/ACBrNFSe64.dll`.
3. Sequência: `carregarINI` → `assinar` → `validar` → `emitir(lote, modo, false)` (modo padrão `LOTE_SINCRONO=2`).
4. Sem FFI nativo (Linux/CI ou DLL ausente): fallback automático para Monitor (`nfseAcbr.emitirNfseCore`).
5. Reutilizar parse/normalização de `nfseAcbr.js` e o mesmo `acbrlib.ini` / sessão runtime com fingerprint por `libPath`.

## Consequências

- Paridade operacional com NF-e Lib no caixa Windows.
- Homologação municipal / schemas XSD do provedor continuam responsabilidade de configuração local (`[NFSe]` no INI).
- Instalador grava `ACBR_NFSE_LIB_PATH` quando a DLL está presente.

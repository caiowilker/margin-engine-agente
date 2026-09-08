# ADR — Solidez update/reboot :9100 (tela preta + serviço morto)

**Status:** Aceito  
**Data:** 2026-09-08 (rev. extrema)  
**Repo:** agente-local

## Incidentes de campo

1. **Tela preta** em `localhost:9100` — update parcial: `index.html` aponta para
   assets hashed ausentes; shell Vite dark + `#root` vazio.
2. **Update → “reinicie o PC” → após reboot nada sobe** — agente tinha aberto
   antes do reboot; depois `:9100` morto.

## Causas

| Sintoma | Causa raiz |
|--------|------------|
| Tela preta | SPA inconsistente; sem fallback legível |
| Morto pós-reboot | `AUTO_UPDATE` fazia `process.exit(0)` — SCM **não** reinicia em exit limpo |
| Pedido de reboot | Mensagens/Inno sugeriam PC; o correto é **só reiniciar o serviço** |
| Crash mid-apply | Marcador só após apply; heal exigia marcador → black SPA eterna |
| Install lento | Credenciais/DB antes do listen; sleep SCM 12s; `/health` sem `ui.ok` |

## Decisões

1. **Integridade `frontend-dist`**: refs do `index.html` + pasta `assets/` com `.js`;
   cache por mtime; página 503 clara; watchdog `#root` **3s**; `ui.ok` em `/health`.
2. **Apply SPA**: staging `.next` → validate → rename; marcador `apply-in-progress`
   **antes** de mutar; heal no boot **sem** exigir marcador se houver backup.
3. **Exit code 1** após AUTO_UPDATE / rollback / recycle / LAN bind —
   `exitCodeParaScmRestart()`.
4. **SCM harden**: `start= auto` (não delayed) + `failure` restart 1s/3s/15s.
5. **Listen-first**: HTTP antes de credenciais (15s) e `integrity_check` SQLite.
6. **Instalador**: wait-online exige `ui.ok`; schemas ProgramData em install/update/repair;
   `validatePostUpdate` fail-hard; netsh-first firewall; preinstall stop ≤10s;
   poll SCM ~200ms.
7. Inno sem pedir reboot do Windows.

## Consequências

- Reboot → serviço sobe na hora; `/health` com `ui.ok`.
- Crash mid-update → boot faz rollback se backup existir.
- Instalador não abre painel com SPA quebrada.

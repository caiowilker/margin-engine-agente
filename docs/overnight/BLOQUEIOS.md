# Bloqueios — modo autônomo noturno (2026-10-06)

Formato: o quê · por quê · o que foi tentado · próximo passo.

## CI remoto não verificável (gh sem autenticação)

- **O quê:** checar CI com `gh` antes/depois de cada push.
- **Por quê:** `gh` não tem token (`gh auth login` exigiria credenciais; proibido mexer em credenciais).
- **Tentado:** `gh run list` com e sem `CI=true` → "To get started with GitHub CLI, please run: gh auth login".
- **Seguindo com:** gates locais completos (build, lint, typecheck, suites completas, E2E dos fluxos tocados).
  Conferir o CI pela manhã.

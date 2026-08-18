# Instalador Windows — Margin Engine (Enterprise)

Instalador profissional via **Inno Setup** (`pdv-agente-installer.iss`).

## Princípios

- Linguagem do produto: apenas **Margin Engine**
- Componentes internos (bibliotecas fiscais, impressão, etc.) **não aparecem** no wizard nem nas mensagens ao operador
- Configuração fiscal e impressora: **painel** `http://localhost:9100` após instalar (não no wizard)

## Fluxo do wizard

| Etapa | Conteúdo |
|-------|----------|
| Bem-vindo | Apresentação do Margin Engine |
| Licença | `LICENSE.txt` |
| Diretório | Pasta de instalação (`Program Files\Margin Engine`) |
| Atalhos | Área de trabalho + menu Iniciar |
| Instalar | Cópia de arquivos + bootstrap automático |
| Finalizar | Diagnóstico rápido (popup se houver problemas) |

**Nenhuma tela extra** (certificado, CSC, porta, etc.).

## Velocidade no caixa

O `.exe` já traz Node, `node_modules` nativo, manifest e frontend. Extração usa `lzma2/fast`; binários (Node/DLLs) saem sem recompressão LZMA. O bootstrap no caixa **não** refaz `npm ci` nem SHA-256 quando `BUILD_STAMP.json` está presente **e** o manifest lista só arquivos existentes (sem `.br`/`.gz`). Reparo aplica ACL em árvore (`/T`).

## Modos (mesmo `.exe`)

| Modo | Como executar |
|------|----------------|
| **Instalar** | Assistente normal |
| **Reparar** | `Margin-Engine-Setup-1.0.0.exe /MODE=repair` |
| **Atualizar** | `Margin-Engine-Setup-1.0.0.exe /MODE=update` ou upgrade sobre versão existente |
| **Desinstalar** | `Margin-Engine-Setup-1.0.0.exe /MODE=uninstall` ou Painel de Controle |

## O que o bootstrap faz automaticamente

Script: `scripts/installer-bootstrap.js`

1. Cria diretórios (`DirectoryManager` → `ProgramData\MarginEngine`)
2. Aplica permissões (Windows)
3. Cria logs e configuração inicial (`.env` padrão)
4. Valida dependências (Node, SQLite, manifest)
5. Dependências nativas, manifest e predeploy **já vêm do build** (`prepare-build.ps1`). No caixa o bootstrap **não** roda `npm ci` nem recalcula SHA-256 se existir `BUILD_STAMP.json` e `node_modules`.
6. Regra de firewall na porta do agente (instalação/atualização)
7. Registra serviço Windows automaticamente
8. Gera diagnóstico inicial em `Diagnostics/install-last-report.txt`

## Diagnóstico

```bash
node scripts/installer-diagnostic.js
```

Códigos de problema: `ME-001` … `ME-013` com mensagem e solução em linguagem Margin Engine.

## Build do instalador

```bash
cd agente-local
npm run check:release-alignment
npm run auditoria:hardening
npm run sync:windows-build    # WSL
# ou .\scripts\sync-windows-build.ps1 no Windows

cd C:\build\pdv-agente
.\validate-build.ps1
.\prepare-build.ps1 -Compile
```

Saída: `output\Margin-Engine-Setup-1.0.0.exe`

## Pós-instalação (operador)

1. Abrir `http://localhost:9100`
2. Ativar terminal com código do painel ERP
3. Configurar certificado, CSC e impressora **no painel** (se necessário)

## Dados preservados

`ProgramData\MarginEngine` **não é removido** na desinstalação (`uninsneveruninstall`).

## Referência técnica (suporte)

Configuração avançada pós-instalação: `.env` e painel de diagnóstico — ver `docs/OPERACAO.md`.

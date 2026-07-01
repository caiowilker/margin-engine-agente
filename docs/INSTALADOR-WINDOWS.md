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
5. `npm ci`, `rebuild better-sqlite3`, `manifest`, `predeploy`
6. Regra de firewall na porta do agente (instalação/atualização)
7. Registra serviço Windows (se marcado)
8. Gera diagnóstico inicial em `Diagnostics/install-last-report.txt`

## Diagnóstico

```bash
node scripts/installer-diagnostic.js
```

Códigos de problema: `ME-001` … `ME-013` com mensagem e solução em linguagem Margin Engine.

## Build do instalador

```bash
cd agente-local
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

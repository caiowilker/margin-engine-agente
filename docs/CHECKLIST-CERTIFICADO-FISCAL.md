# Checklist — certificado A1 e logs fiscais (Windows)

Use após trocar o PFX ou quando o diagnóstico fiscal parecer parado.

## 1. Provar o certificado em ProgramData

```powershell
$pwd = Read-Host "Senha do PFX" -AsSecureString
Get-PfxData -FilePath "$env:ProgramData\MarginEngine\cert\cert.pfx" -Password $pwd |
  Select-Object -ExpandProperty EndEntityCertificates |
  Format-List Subject, Thumbprint, NotBefore, NotAfter
Get-FileHash "$env:ProgramData\MarginEngine\cert\cert.pfx" -Algorithm SHA256
```

Confirme `NotAfter` no futuro e anote o `Thumbprint`.

## 2. Comparar com o staging do runtime

```powershell
$src = Get-FileHash "$env:ProgramData\MarginEngine\cert\cert.pfx" -Algorithm SHA256
$stg = Get-FileHash "$env:TEMP\margin-acbrlib\cert\cert.pfx" -Algorithm SHA256
"ProgramData=$($src.Hash)"
"Staging=$($stg.Hash)"
"Iguais=$($src.Hash -eq $stg.Hash)"
```

Se divergirem: salve o certificado novamente no painel e reinicie o serviço **Margin Engine**.

## 3. Confirmar SSL no INI de runtime

Arquivo: `%TEMP%\margin-acbrlib\config\acbrlib.runtime.ini`

Deve conter (stack A1 arquivo — mesma base da emissão OK em 19/07/2026):

```ini
SSLCryptLib=1
SSLHttpLib=3
SSLXmlSignLib=4
SSLType=5
```

`DFe.Senha` no runtime.ini deve ser Base64+StrCrypt (não plaintext).
`Certificado.Senha` no INI fica vazio — a senha plaintext vai via API após `Inicializar`
(necessário para mTLS: a SEFAZ-MG pede certificado de cliente no handshake TLS).

`LogNivel=4` é o padrão (paridade com a emissão OK em 19/07). Para silenciar: `ACBR_LIB_LOG_NIVEL=0`.

## 4. Reiniciar e validar

1. Reinicie o serviço Windows **Margin Engine**.
2. Abra o diagnóstico / `/status` e confira `fiscalEstado.certificado` (hash, thumbprint, `notAfter`).
3. Confirme nos logs JSON do agente linhas com `acbrlib.cert_proof` ou `cert` no `testar() falhou`.
4. `testar`/SEFAZ só deve falhar por senha/SEFAZ reais — nunca por certificado antigo (validade 22/07/2026).

## 5. Log nativo sob demanda (opcional)

No `.env` do agente:

```env
ACBR_LIB_LOG_NIVEL=4
```

Reinicie o serviço. Logs nativos em `%TEMP%\margin-acbrlib\log`. Volte para `0` após a análise.

## Erros típicos de senha / OpenSSL

| Mensagem | Causa mais comum | Ação |
|---|---|---|
| `PKCS12_parse:mac verify failure` | Senha errada **ou** OpenSSL 3 sem `legacy.dll` | Confirmar senha; staging deve ter OpenSSL **1.1** + `legacy.dll` (sem `libcrypto-3*`) |
| `PFXDataToCertContextWinApi: Senha informada está errada` | Stack WinCrypt + senha mal codificada no INI | Runtime atual usa OpenSSL A1; `DFe.Senha` = StringToB64Crypt; cofre em `.fiscal-vault` |
| `CStat=0` / XMotivo vazio | mTLS sem client cert (handshake TLS falha) | Regravar senha; garantir `Certificado.Arquivo/Senha` + `DFe.*` via API; deps OpenSSL no staging |
| `Data de Validade do Certificado já expirou` | PFX antigo ainda no staging | Comparar hashes (passo 2) e reiniciar o serviço |

Deps oficiais (x64) ficam no cwd do staging (`%TEMP%\margin-acbrlib`): `ACBrNFe64.dll`, `libxml2.dll`, `libxslt.dll`, `libiconv.dll`, `libcrypto-1_1-x64.dll`, `libssl-1_1-x64.dll`, `legacy.dll`.

## Critério de pronto

- Hash ProgramData = hash staging
- Thumbprint/`NotAfter` no status do agente batem com o PowerShell
- Mensagem de senha errada **não** aparece como “certificado expirado”
- Emissão/statusServico usa o PFX atual
- Staging **sem** `libcrypto-3*` misturado com 1.1

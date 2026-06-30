; ============================================================
; PDV Margin Engine — Instalador do Agente Local v1.0 (Inno Setup)
;
; Sincronize MyAppVersion com dist\app\package.json (agente-local = 1.0.0).
; Saída: output\PDV-Agente-Setup-<versão>.exe
;
; Margin Platform 1.0:
;   - Fiscal: ACBrLib Pro (padrão) · ACBr Monitor (fallback)
;   - Impressão: ACBrPosPrinter (padrão) · ESC/POS native (fallback)
;   - Sem ACBR_LIB_ALLOW_PARITY / PRINTER_ALLOW_PARITY em produção
;
; Pré-requisito de build (Windows):
;   1. Copiar agente-local → dist\app\ (sem node_modules, .env, data\, test\, homolog-acbrlib\)
;   2. Copiar Node.js portátil x64 → dist\node\
;   3. (Opcional) DLLs extras → dist\acbrlib\lib\ e dist\posprinter\lib\
;   4. Compilar este .iss no Inno Setup 6+
;
; Estrutura esperada em dist\app\ (cópia do repositório agente-local):
;   acbrlib\lib\ACBrNFe64.dll + deps + data\Schemas + data\config\
;   posprinter\lib\ACBrPosPrinter64.dll + deps
;   fiscal\, print\, scripts\, templates\, index.js, package.json, …
;
; Dados em ProgramData\MarginEngine NUNCA são apagados (uninsneveruninstall).
; ============================================================

#define MyAppName "PDV Margin Engine"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Margin Engine"
#define MyAppURL "https://marginengine.com.br"
#define MyInstallDir "PDV Margin Engine"
#define MarginDataRoot "{commonappdata}\MarginEngine"

[Setup]
AppId={{B2E2B6B0-5F2A-4B6B-9D2C-1A2B3C4D5E6F}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\{#MyInstallDir}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=output
OutputBaseFilename=PDV-Agente-Setup-{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
PrivilegesRequired=admin
WizardStyle=modern

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Tasks]
Name: "installservice"; Description: "Registrar e iniciar o agente como serviço Windows"; GroupDescription: "Serviço:"; Flags: checkedonce
Name: "openpanel"; Description: "Abrir o painel local após a instalação (http://localhost:9100)"; GroupDescription: "Finalização:"; Flags: checkedonce

[Files]
; ── Node.js portátil ──
Source: "dist\node\*"; DestDir: "{app}\node"; Flags: recursesubdirs createallsubdirs

; ── Agente (cópia completa de agente-local) ──
Source: "dist\app\*"; DestDir: "{app}\app"; \
    Flags: ignoreversion recursesubdirs createallsubdirs; \
    Excludes: "node_modules\*,data\*,daemon\*,frontend-dist\*,.env,homolog-acbrlib\*,test\*,.git\*,RESULTADO-*.md,*.log"

Source: "dist\app\.env.example"; DestDir: "{app}\app"; DestName: ".env.example"; Flags: ignoreversion

Source: "dist\app\frontend-dist\*"; DestDir: "{app}\app\frontend-dist"; \
    Flags: recursesubdirs createallsubdirs ignoreversion skipifsourcedoesntexist

Source: "dist\app\docs\*"; DestDir: "{app}\app\docs"; \
    Flags: recursesubdirs createallsubdirs ignoreversion skipifsourcedoesntexist

Source: "dist\app\templates\*"; DestDir: "{app}\app\templates"; \
    Flags: recursesubdirs createallsubdirs ignoreversion skipifsourcedoesntexist

; ── ACBrLib NFe (overlay opcional do build) ──
Source: "dist\acbrlib\*"; DestDir: "{app}\app\acbrlib"; \
    Flags: recursesubdirs createallsubdirs ignoreversion skipifsourcedoesntexist

; Legado: dist\lib\ → acbrlib\lib\
Source: "dist\lib\*"; DestDir: "{app}\app\acbrlib\lib"; \
    Flags: recursesubdirs createallsubdirs ignoreversion skipifsourcedoesntexist

; ── ACBrPosPrinter (overlay opcional) ──
Source: "dist\posprinter\*"; DestDir: "{app}\app\posprinter"; \
    Flags: recursesubdirs createallsubdirs ignoreversion skipifsourcedoesntexist

[Dirs]
Name: "{app}\app\data"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{app}\app\data\logs"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{app}\app\acbrlib\data\config"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{app}\app\posprinter\data\config"; Permissions: users-modify; Flags: uninsneveruninstall

Name: "{#MarginDataRoot}"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\cert"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\acbr"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\acbr\config"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\acbr\schemas"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\acbr\schemas\NFe"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\acbr\xml"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\acbr\pdf"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\acbr\cancelamentos"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\acbr\backup"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\acbr\entrada"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\acbr\saida"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\acbr\ini"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\acbr\logs"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\fila"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\spool"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\impressao"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\temp"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\data"; Permissions: users-modify; Flags: uninsneveruninstall

[Run]
; 1. .env inicial
Filename: "{cmd}"; \
    Parameters: "/c if not exist ""{app}\app\.env"" copy /Y ""{app}\app\.env.example"" ""{app}\app\.env"""; \
    WorkingDir: "{app}\app"; \
    Flags: runhidden; \
    StatusMsg: "Configurando ambiente (.env)..."

; 2. Config fiscal (wizard → fiscal-install.json)
Filename: "{app}\node\node.exe"; \
    Parameters: """{app}\app\scripts\installer-apply-fiscal-config.js"" ""{app}\app"" ""{tmp}\fiscal-install.json"""; \
    WorkingDir: "{app}\app"; \
    Flags: runhidden waituntilterminated; \
    StatusMsg: "Aplicando configuração fiscal (ACBrLib / certificado / CSC)..."

; 3. Config impressora (wizard → print-install.json)
Filename: "{app}\node\node.exe"; \
    Parameters: """{app}\app\scripts\installer-apply-print-config.js"" ""{app}\app"" ""{tmp}\print-install.json"""; \
    WorkingDir: "{app}\app"; \
    Flags: runhidden waituntilterminated; \
    StatusMsg: "Aplicando configuração da impressora (ACBrPosPrinter)..."

; 4. Dependências npm
Filename: "{app}\node\npm.cmd"; \
    Parameters: "ci --omit=dev"; \
    WorkingDir: "{app}\app"; \
    Flags: runhidden waituntilterminated; \
    StatusMsg: "Instalando dependências Node.js (1–3 min)..."

Filename: "{app}\node\npm.cmd"; \
    Parameters: "rebuild better-sqlite3"; \
    WorkingDir: "{app}\app"; \
    Flags: runhidden waituntilterminated; \
    StatusMsg: "Compilando módulo nativo SQLite..."

Filename: "{app}\node\npm.cmd"; \
    Parameters: "run manifest"; \
    WorkingDir: "{app}\app"; \
    Flags: runhidden waituntilterminated; \
    StatusMsg: "Gerando manifest de integridade..."

Filename: "{cmd}"; \
    Parameters: "/c cd /d ""{app}\app"" && ""{app}\node\npm.cmd"" run predeploy > ""{app}\app\data\predeploy-install.log"" 2>&1 || exit /b 0"; \
    Flags: runhidden waituntilterminated; \
    StatusMsg: "Verificando instalação (pre-deploy)..."

Filename: "{app}\node\node.exe"; \
    Parameters: """{app}\app\install-service.js"""; \
    WorkingDir: "{app}\app"; \
    Flags: runhidden waituntilterminated; \
    Tasks: installservice; \
    StatusMsg: "Registrando serviço do Windows..."

Filename: "{cmd}"; \
    Parameters: "/c start http://localhost:9100"; \
    Flags: postinstall nowait skipifsilent runhidden shellexec; \
    Tasks: openpanel; \
    Description: "Abrir painel do agente"

[UninstallRun]
Filename: "{app}\node\node.exe"; \
    Parameters: """{app}\app\install-service.js"" --uninstall"; \
    WorkingDir: "{app}\app"; \
    Flags: runhidden waituntilterminated; \
    RunOnceId: "RemoverServicoPDV"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\app\node_modules"
Type: filesandordirs; Name: "{app}\app\daemon"

[Messages]
brazilianportuguese.WelcomeLabel2=Este instalador configura o Agente Local PDV Margin Engine v1.0.%n%nVocê poderá configurar emissão fiscal (ACBrLib Pro), impressora térmica (ACBrPosPrinter) e certificado A1.%n%nDados em ProgramData\MarginEngine não são removidos na desinstalação.

[Code]
var
  FiscalEnablePage: TInputOptionWizardPage;
  FiscalDriverPage: TInputOptionWizardPage;
  CertFilePage: TInputFileWizardPage;
  FiscalParamsPage: TInputQueryWizardPage;
  LibDllPage: TInputFileWizardPage;
  PrintProviderPage: TInputOptionWizardPage;
  PrintParamsPage: TInputQueryWizardPage;

function JsonEscape(const S: String): String;
var
  I: Integer;
  C: String;
begin
  Result := '';
  for I := 1 to Length(S) do
  begin
    C := S[I];
    if C = '\' then
      Result := Result + '\\'
    else if C = '"' then
      Result := Result + '\"'
    else if Ord(C[1]) < 32 then
      Result := Result + ' '
    else
      Result := Result + C;
  end;
end;

function FiscalEmissaoAtiva: Boolean;
begin
  Result := (FiscalEnablePage.SelectedValueIndex = 0);
end;

function FiscalDriverLib: Boolean;
begin
  Result := FiscalEmissaoAtiva and (FiscalDriverPage.SelectedValueIndex = 0);
end;

function PrintProviderAcbr: Boolean;
begin
  Result := (PrintProviderPage.SelectedValueIndex = 0);
end;

procedure InitializeWizard;
begin
  FiscalEnablePage := CreateInputOptionPage(
    wpSelectTasks,
    'Emissão fiscal',
    'Habilitar NFC-e / NF-e via SEFAZ?',
    'Com emissão desligada o PDV opera cupom não fiscal. ' +
    'Com emissão ligada, informe certificado A1 e CSC nas próximas telas.',
    True, False);
  FiscalEnablePage.Add('Sim — emitir NFC-e/NF-e (requer certificado A1)');
  FiscalEnablePage.Add('Não — cupom não fiscal (padrão)');
  FiscalEnablePage.Values[1] := True;

  FiscalDriverPage := CreateInputOptionPage(
    FiscalEnablePage.ID,
    'Motor fiscal',
    'Provider fiscal do agente',
    'Padrão Margin 1.0: ACBrLib Pro (DLL nativa). ' +
    'ACBr Monitor permanece disponível como fallback de rollback.',
    True, False);
  FiscalDriverPage.Add('ACBrLib Pro (ACBrNFe64.dll) — padrão 1.0');
  FiscalDriverPage.Add('ACBr Monitor Pro (TCP :9200) — fallback');
  FiscalDriverPage.Values[0] := True;

  CertFilePage := CreateInputFilePage(
    FiscalDriverPage.ID,
    'Certificado digital A1',
    'Selecione o arquivo .pfx do emitente',
    'O certificado assina NFC-e e NF-e. Uma cópia será guardada em ProgramData\MarginEngine\cert.',
    'Certificados A1 (*.pfx)|*.pfx|Todos os arquivos (*.*)|*.*');

  CertFilePage.Add(
    'Arquivo do certificado (.pfx):',
    'Certificados A1 (*.pfx)|*.pfx|Todos os arquivos (*.*)|*.*',
    '.pfx');

  FiscalParamsPage := CreateInputQueryPage(
    CertFilePage.ID,
    'Parâmetros SEFAZ e NFC-e',
    'Ambiente, UF e CSC (Token) da NFC-e',
    'CSC: cadastre na SEFAZ da UF (homologação e produção têm tokens distintos).');

  FiscalParamsPage.Add('Senha do certificado A1:', False);
  FiscalParamsPage.Add('UF do emitente (ex: MG):', False);
  FiscalParamsPage.Add('Ambiente (homologacao ou producao):', False);
  FiscalParamsPage.Add('Id CSC NFC-e (ex: 000001):', False);
  FiscalParamsPage.Add('Token CSC NFC-e:', False);

  FiscalParamsPage.Values[1] := 'MG';
  FiscalParamsPage.Values[2] := 'homologacao';
  FiscalParamsPage.Values[3] := '000001';

  LibDllPage := CreateInputFilePage(
    FiscalParamsPage.ID,
    'Biblioteca ACBrLib NFe',
    'Localização da ACBrNFe64.dll',
    'Padrão: {app}\app\acbrlib\lib\ACBrNFe64.dll. ' +
    'Inclua libxml2, OpenSSL e demais DLLs na mesma pasta.',
    'Biblioteca ACBr (*.dll)|*.dll|Todos (*.*)|*.*');

  LibDllPage.Add(
    'ACBrNFe64.dll:',
    'ACBrNFe64.dll|ACBrNFe64.dll|Bibliotecas (*.dll)|*.dll|Todos (*.*)|*.*',
    '.dll');

  PrintProviderPage := CreateInputOptionPage(
    LibDllPage.ID,
    'Impressora térmica',
    'Provider de impressão',
    'Padrão 1.0: ACBrPosPrinter (DLL nativa). Fallback: ESC/POS nativo (USB/rede/spooler).',
    True, False);
  PrintProviderPage.Add('ACBrPosPrinter (ACBrPosPrinter64.dll) — padrão 1.0');
  PrintProviderPage.Add('ESC/POS nativo (USB / rede / spooler Windows)');
  PrintProviderPage.Values[0] := True;

  PrintParamsPage := CreateInputQueryPage(
    PrintProviderPage.ID,
    'Parâmetros da impressora',
    'Porta e nome no Windows',
    'Porta USB para térmica USB. Para rede use PRINTER_HOST no painel após instalação.');

  PrintParamsPage.Add('Porta ACBr (USB, COM1, RAW, etc.):', False);
  PrintParamsPage.Add('Nome da impressora no Windows (opcional):', False);

  PrintParamsPage.Values[0] := 'USB';
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = FiscalParamsPage.ID then
    FiscalParamsPage.Edits[0].PasswordChar := '*';

  if CurPageID = LibDllPage.ID then
  begin
    if Trim(LibDllPage.Values[0]) = '' then
      LibDllPage.Values[0] := ExpandConstant('{app}\app\acbrlib\lib\ACBrNFe64.dll');
  end;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;

  if (PageID = FiscalDriverPage.ID) or (PageID = CertFilePage.ID) or
     (PageID = FiscalParamsPage.ID) then
    Result := not FiscalEmissaoAtiva;

  if PageID = LibDllPage.ID then
    Result := (not FiscalEmissaoAtiva) or (not FiscalDriverLib);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Uf, Amb: String;
begin
  Result := True;

  if CurPageID = CertFilePage.ID then
  begin
    if Trim(CertFilePage.Values[0]) = '' then
    begin
      MsgBox('Selecione o arquivo do certificado A1 (.pfx).', mbError, MB_OK);
      Result := False;
      Exit;
    end;
    if not FileExists(CertFilePage.Values[0]) then
    begin
      MsgBox('Arquivo de certificado não encontrado.', mbError, MB_OK);
      Result := False;
    end;
  end;

  if CurPageID = FiscalParamsPage.ID then
  begin
    if Trim(FiscalParamsPage.Values[0]) = '' then
    begin
      MsgBox('Informe a senha do certificado A1.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
    Uf := UpperCase(Trim(FiscalParamsPage.Values[1]));
    if Length(Uf) <> 2 then
    begin
      MsgBox('UF deve ter 2 letras (ex: MG, SP).', mbError, MB_OK);
      Result := False;
      Exit;
    end;
    Amb := LowerCase(Trim(FiscalParamsPage.Values[2]));
    if (Amb <> 'homologacao') and (Amb <> 'producao') then
    begin
      MsgBox('Ambiente deve ser "homologacao" ou "producao".', mbError, MB_OK);
      Result := False;
    end;
  end;

  if CurPageID = LibDllPage.ID then
  begin
    if Trim(LibDllPage.Values[0]) = '' then
    begin
      MsgBox('Informe o caminho da ACBrNFe64.dll para o modo ACBrLib.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
    if not FileExists(LibDllPage.Values[0]) then
    begin
      if MsgBox(
        'DLL não encontrada no caminho informado. Continuar mesmo assim?',
        mbConfirmation, MB_YESNO) = IDNO then
        Result := False;
    end;
  end;
end;

procedure SaveFiscalInstallConfig;
var
  JsonPath: String;
  Driver, Emissao, Cert, Senha, Uf, Amb, CscId, CscTok, LibDll, LibIni: String;
  Lines: TArrayOfString;
begin
  JsonPath := ExpandConstant('{tmp}\fiscal-install.json');

  if FiscalEmissaoAtiva then
    Emissao := 'true'
  else
    Emissao := 'false';

  if FiscalDriverLib then
    Driver := 'lib'
  else
    Driver := 'monitor';

  Cert := JsonEscape(CertFilePage.Values[0]);
  Senha := JsonEscape(FiscalParamsPage.Values[0]);
  Uf := JsonEscape(UpperCase(Trim(FiscalParamsPage.Values[1])));
  Amb := JsonEscape(LowerCase(Trim(FiscalParamsPage.Values[2])));
  CscId := JsonEscape(Trim(FiscalParamsPage.Values[3]));
  CscTok := JsonEscape(Trim(FiscalParamsPage.Values[4]));
  LibDll := JsonEscape(LibDllPage.Values[0]);
  LibIni := JsonEscape(ExpandConstant('{app}\app\acbrlib\data\config\acbrlib.ini'));

  SetArrayLength(Lines, 1);
  Lines[0] :=
    '{' +
    '"emissaoFiscal":' + Emissao + ',' +
    '"driver":"' + Driver + '",' +
    '"certPath":"' + Cert + '",' +
    '"certSenha":"' + Senha + '",' +
    '"uf":"' + Uf + '",' +
    '"ambiente":"' + Amb + '",' +
    '"cscId":"' + CscId + '",' +
    '"cscToken":"' + CscTok + '",' +
    '"libPath":"' + LibDll + '",' +
    '"libIni":"' + LibIni + '"' +
    '}';

  SaveStringsToFile(JsonPath, Lines, False);
end;

procedure SavePrintInstallConfig;
var
  JsonPath: String;
  Provider, Porta, Nome, LibPath, IniPath: String;
  Lines: TArrayOfString;
begin
  JsonPath := ExpandConstant('{tmp}\print-install.json');

  if PrintProviderAcbr then
    Provider := 'acbr-posprinter'
  else
    Provider := 'native';

  Porta := JsonEscape(Trim(PrintParamsPage.Values[0]));
  Nome := JsonEscape(Trim(PrintParamsPage.Values[1]));
  LibPath := JsonEscape(ExpandConstant('{app}\app\posprinter\lib\ACBrPosPrinter64.dll'));
  IniPath := JsonEscape(ExpandConstant('{app}\app\data\posprinter.ini'));

  SetArrayLength(Lines, 1);
  Lines[0] :=
    '{' +
    '"provider":"' + Provider + '",' +
    '"fallback":"native",' +
    '"porta":"' + Porta + '",' +
    '"modelo":"0",' +
    '"encoding":"UTF8",' +
    '"cut":"partial",' +
    '"nomeImpressora":"' + Nome + '",' +
    '"libPath":"' + LibPath + '",' +
    '"iniPath":"' + IniPath + '",' +
    '"testarImpressao":false' +
    '}';

  SaveStringsToFile(JsonPath, Lines, False);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
  begin
    SaveFiscalInstallConfig;
    SavePrintInstallConfig;
  end;
end;

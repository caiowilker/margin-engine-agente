; ============================================================
; Margin Engine — Instalador Enterprise (Inno Setup 6+)
;
; Wizard: Bem-vindo → Licença → Diretório → Atalhos → Instalar → Finalizar
; Linguagem do produto: apenas "Margin Engine" (sem termos internos).
;
; Modos (mesmo executável):
;   Instalar   — padrão
;   Reparar    — /MODE=repair
;   Atualizar  — /MODE=update ou upgrade automático
;   Desinstalar — /MODE=uninstall
;
; Build: npm run sync:windows-build → compile-installer.ps1
; Saída: output\Margin-Engine-Setup-<versão>.exe
; ============================================================

#define MyAppName "Margin Engine"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Margin Engine"
#define MyAppURL "https://marginengine.com.br"
#define MyInstallDir "Margin Engine"
#define MarginDataRoot "{commonappdata}\MarginEngine"
#define MyAppId "B2E2B6B0-5F2A-4B6B-9D2C-1A2B3C4D5E6F"

[Setup]
AppId={{{#MyAppId}}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\{#MyInstallDir}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=no
OutputDir=output
OutputBaseFilename=Margin-Engine-Setup-{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
PrivilegesRequired=admin
WizardStyle=modern
LicenseFile=LICENSE.txt
UninstallDisplayName={#MyAppName}
SetupIconFile=compiler:SetupClassicIcon.ico
ChangesEnvironment=no
MinVersion=10.0

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Tasks]
Name: "desktopicon"; Description: "Criar atalho do Margin Engine na Área de Trabalho"; GroupDescription: "Atalhos:"; Flags: unchecked
Name: "installservice"; Description: "Registrar e iniciar o Margin Engine como serviço Windows"; GroupDescription: "Serviço:"; Flags: checkedonce
Name: "openpanel"; Description: "Abrir o painel local após a instalação (http://localhost:9100)"; GroupDescription: "Finalização:"; Flags: checkedonce

[Files]
Source: "dist\node\*"; DestDir: "{app}\node"; Flags: recursesubdirs createallsubdirs
Source: "dist\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "node_modules\*,data\*,daemon\*,frontend-dist\*,.env,homolog-acbrlib\*,test\*,.git\*,RESULTADO-*.md,*.log"
Source: "dist\app\acbrlib\data\Schemas\*"; DestDir: "{app}\app\acbrlib\data\Schemas"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "dist\app\acbrlib\data\config\ACBrNFeServicos.ini"; DestDir: "{app}\app\acbrlib\data\config"; Flags: ignoreversion skipifsourcedoesntexist
Source: "dist\app\.env.example"; DestDir: "{app}\app"; DestName: ".env.example"; Flags: ignoreversion
Source: "dist\app\frontend-dist\*"; DestDir: "{app}\app\frontend-dist"; Flags: recursesubdirs createallsubdirs ignoreversion skipifsourcedoesntexist
Source: "dist\app\docs\*"; DestDir: "{app}\app\docs"; Flags: recursesubdirs createallsubdirs ignoreversion skipifsourcedoesntexist
Source: "dist\app\templates\*"; DestDir: "{app}\app\templates"; Flags: recursesubdirs createallsubdirs ignoreversion skipifsourcedoesntexist
Source: "LICENSE.txt"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
Name: "{app}\app\data"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\cert"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\Logs"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\Config"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\Backup"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\Fiscal"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\Fiscal\XML"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\Fiscal\PDF"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\Temp"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\Cache"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\Diagnostics"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\acbr"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\acbr\xml"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\acbr\pdf"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\acbr\logs"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\acbr\config"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\data"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\fila"; Permissions: users-modify; Flags: uninsneveruninstall

[Icons]
Name: "{group}\Margin Engine — Painel"; Filename: "http://localhost:9100/"
Name: "{commondesktop}\Margin Engine"; Filename: "http://localhost:9100/"; Tasks: desktopicon

[Run]
Filename: "{app}\node\node.exe"; Parameters: """{app}\app\scripts\installer-bootstrap.js"" ""{app}\app"" --mode={code:GetBootstrapMode}{code:GetBootstrapFlags} --npm={app}\node\npm.cmd"; WorkingDir: "{app}\app"; Flags: runhidden waituntilterminated; StatusMsg: "Configurando Margin Engine..."
Filename: "{cmd}"; Parameters: "/c start http://localhost:9100"; Flags: postinstall nowait skipifsilent runhidden shellexec; Tasks: openpanel; Description: "Abrir painel do Margin Engine"

[UninstallRun]
Filename: "{app}\node\node.exe"; Parameters: """{app}\app\install-service.js"" --uninstall"; WorkingDir: "{app}\app"; Flags: runhidden waituntilterminated; RunOnceId: "RemoverServicoMarginEngine"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\app\node_modules"
Type: filesandordirs; Name: "{app}\app\daemon"

[Messages]
brazilianportuguese.WelcomeLabel2=Este assistente instala o **Margin Engine** no ponto de venda.%n%nO agente local conecta impressão, documentos fiscais e operação offline ao navegador do PDV.%n%nOs dados do caixa em ProgramData\MarginEngine **não são removidos** na desinstalação.%n%nPara reparar ou atualizar uma instalação existente, execute o mesmo instalador com /MODE=repair ou /MODE=update.
brazilianportuguese.FinishedLabel=O Margin Engine foi instalado no computador.%n%nNa próxima tela você verá o resultado do diagnóstico rápido.%n%nAbra o painel em http://localhost:9100 para ativar o terminal.

[Code]
var
  BootstrapMode: String;

function GetModeParam: String;
begin
  Result := LowerCase(Trim(ExpandConstant('{param:MODE|}')));
end;

function IsExistingInstall: Boolean;
begin
  Result := RegKeyExists(HKLM,
    'Software\Microsoft\Windows\CurrentVersion\Uninstall\{#MyAppId}_is1');
end;

function InitializeSetup: Boolean;
var
  UninstallString: String;
  ErrorCode: Integer;
begin
  Result := True;
  BootstrapMode := GetModeParam;

  if BootstrapMode = 'uninstall' then
  begin
    if RegQueryStringValue(HKLM,
      'Software\Microsoft\Windows\CurrentVersion\Uninstall\{#MyAppId}_is1',
      'UninstallString', UninstallString) then
    begin
      Exec(RemoveQuotes(UninstallString), '', '', SW_SHOW, ewWaitUntilTerminated, ErrorCode);
    end
    else
      MsgBox('Margin Engine não encontrado para desinstalação.', mbInformation, MB_OK);
    Result := False;
    Exit;
  end;

  if BootstrapMode = '' then
  begin
    if IsExistingInstall then
      BootstrapMode := 'update'
    else
      BootstrapMode := 'install';
  end;
end;

function GetBootstrapMode(Param: String): String;
begin
  Result := BootstrapMode;
end;

function GetBootstrapFlags(Param: String): String;
begin
  Result := '';
  if IsTaskSelected('installservice') then
    Result := Result + ' --service';
  if (BootstrapMode = 'install') or (BootstrapMode = 'update') then
    Result := Result + ' --firewall';
end;

function ReadDiagnosticReport: String;
var
  ReportPath: String;
  Lines: TArrayOfString;
  I: Integer;
begin
  Result := '';
  ReportPath := ExpandConstant('{#MarginDataRoot}\Diagnostics\install-last-report.txt');
  if not FileExists(ReportPath) then
  begin
    Result := 'Diagnóstico não gerado. Verifique os logs do instalador.';
    Exit;
  end;
  if LoadStringsFromFile(ReportPath, Lines) then
  begin
    for I := 0 to GetArrayLength(Lines) - 1 do
    begin
      if I > 0 then
        Result := Result + #13#10;
      Result := Result + Lines[I];
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Report: String;
begin
  if CurStep = ssDone then
  begin
    Report := ReadDiagnosticReport;
    if Pos('ATENÇÃO', Report) > 0 then
      MsgBox(Report, mbError, MB_OK)
    else if Pos('Problemas encontrados', Report) > 0 then
      MsgBox(Report, mbInformation, MB_OK)
    else if Report <> '' then
      MsgBox(Report, mbInformation, MB_OK);
  end;
end;

function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo,
  MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
var
  ModeLabel: String;
begin
  if BootstrapMode = 'repair' then
    ModeLabel := 'Reparar instalacao existente'
  else if BootstrapMode = 'update' then
    ModeLabel := 'Atualizar Margin Engine'
  else
    ModeLabel := 'Instalacao nova';

  Result := '';
  if MemoDirInfo <> '' then
    Result := Result + MemoDirInfo + NewLine + NewLine;
  if MemoTasksInfo <> '' then
    Result := Result + MemoTasksInfo + NewLine + NewLine;

  Result := Result +
    'Modo: ' + ModeLabel + NewLine + NewLine +
    'Produto: Margin Engine {#MyAppVersion}' + NewLine + NewLine +
    'Dados: ' + ExpandConstant('{commonappdata}\MarginEngine') +
    ' (preservados na desinstalacao)';
end;

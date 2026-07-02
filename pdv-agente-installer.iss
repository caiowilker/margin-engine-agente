; ============================================================
; Margin Engine — Instalador Enterprise (Inno Setup 6+)
;
; Assistente: Bem-vindo → Licença → Pasta → Instalação → Concluído
; Linguagem do produto: apenas "Margin Engine" (sem termos internos).
;
; Modos (mesmo executável):
;   Instalar   — padrão
;   Reparar    — /MODE=repair ou opção na tela de tarefas
;   Atualizar  — /MODE=update ou upgrade automático
;   Desinstalar — /MODE=uninstall
;
; Build: npm run sync:windows-build → prepare-build.ps1 -Compile
; Saída: output\Margin-Engine-Setup-<versão>.exe
; ============================================================

#define MyAppName "Margin Engine"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Margin Engine"
#define MyAppCompany "Margin Engine"
#define MyAppURL "https://marginengine.com.br"
#define MyAppCopyright "Copyright (C) 2026 Margin Engine. Todos os direitos reservados."
#define MyAppDescription "Agente local do Margin Engine para PDV, impressão e documentos fiscais."
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
AppCopyright={#MyAppCopyright}
VersionInfoCompany={#MyAppCompany}
VersionInfoDescription={#MyAppDescription}
VersionInfoProductName={#MyAppName}
VersionInfoProductVersion={#MyAppVersion}
VersionInfoVersion={#MyAppVersion}
VersionInfoCopyright={#MyAppCopyright}
VersionInfoTextVersion={#MyAppVersion}
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
SetupIconFile=assets\margin-engine.ico
UninstallDisplayIcon={app}\app\assets\margin-engine.ico
ChangesEnvironment=no
MinVersion=10.0
DisableDirPage=no
DisableReadyPage=no
ShowLanguageDialog=no

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Tasks]
Name: "desktopicon"; Description: "Criar atalho do Margin Engine na Área de Trabalho"; GroupDescription: "Atalhos:"; Flags: unchecked
Name: "repairmode"; Description: "Reparar instalação (serviço, atalhos, firewall e dependências)"; GroupDescription: "Manutenção:"; Flags: unchecked

[Files]
Source: "dist\node\*"; DestDir: "{app}\node"; Flags: recursesubdirs createallsubdirs
Source: "dist\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "node_modules\*,data\*,daemon\*,frontend-dist\*,.env,homolog-acbrlib\*,test\*,.git\*,RESULTADO-*.md,*.log,*.db,*.db-shm,*.db-wal"
Source: "dist\app\acbrlib\data\Schemas\*"; DestDir: "{app}\app\acbrlib\data\Schemas"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "dist\app\acbrlib\data\config\ACBrNFeServicos.ini"; DestDir: "{app}\app\acbrlib\data\config"; Flags: ignoreversion onlyifdoesntexist skipifsourcedoesntexist
Source: "dist\app\acbrlib\data\config\acbrlib.ini"; DestDir: "{app}\app\acbrlib\data\config"; Flags: ignoreversion onlyifdoesntexist skipifsourcedoesntexist
Source: "dist\app\data\acbrlib.ini"; DestDir: "{app}\app\data"; Flags: ignoreversion onlyifdoesntexist skipifsourcedoesntexist
Source: "dist\app\.env.example"; DestDir: "{app}\app"; DestName: ".env.example"; Flags: ignoreversion
Source: "dist\app\frontend-dist\*"; DestDir: "{app}\app\frontend-dist"; Flags: recursesubdirs createallsubdirs ignoreversion skipifsourcedoesntexist
Source: "dist\app\docs\*"; DestDir: "{app}\app\docs"; Flags: recursesubdirs createallsubdirs ignoreversion skipifsourcedoesntexist
Source: "dist\app\templates\*"; DestDir: "{app}\app\templates"; Flags: recursesubdirs createallsubdirs ignoreversion skipifsourcedoesntexist
Source: "LICENSE.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "assets\margin-engine.ico"; DestDir: "{app}\app\assets"; Flags: ignoreversion

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
Name: "{#MarginDataRoot}\storage"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\storage\produtos"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\spool"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\impressao"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\fila"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\data"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\acbr"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\acbr\xml"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\acbr\pdf"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\acbr\logs"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\acbr\config"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\acbr\ini"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MarginDataRoot}\acbr\backup"; Permissions: users-modify; Flags: uninsneveruninstall

[Icons]
Name: "{group}\Margin Engine"; Filename: "http://localhost:9100/"; IconFilename: "{app}\app\assets\margin-engine.ico"
Name: "{commondesktop}\Margin Engine"; Filename: "http://localhost:9100/"; IconFilename: "{app}\app\assets\margin-engine.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\node\node.exe"; Parameters: """{app}\app\scripts\installer-bootstrap.js"" ""{app}\app"" --mode={code:GetBootstrapMode}{code:GetBootstrapFlags} --npm={app}\node\npm.cmd"; WorkingDir: "{app}\app"; Flags: runhidden waituntilterminated; StatusMsg: "Configurando Margin Engine (serviço, firewall e diagnóstico)..."

[UninstallRun]
Filename: "{app}\node\node.exe"; Parameters: """{app}\app\install-service.js"" --uninstall"; WorkingDir: "{app}\app"; Flags: runhidden waituntilterminated; RunOnceId: "RemoverServicoMarginEngine"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\app\node_modules"
Type: filesandordirs; Name: "{app}\app\daemon"

[Messages]
brazilianportuguese.WelcomeLabel2=Este assistente instala o **Margin Engine** no ponto de venda.%n%nO sistema conecta impressão, documentos fiscais e operação offline ao navegador do PDV.%n%nSe já existe uma instalação, seus dados (configurações, certificados, vendas e logs) serão preservados automaticamente.%n%nAo concluir, o serviço será instalado e iniciado — não é necessário abrir o Gerenciador de Serviços do Windows.
brazilianportuguese.FinishedLabel=O Margin Engine foi instalado neste computador.%n%nO serviço local foi configurado, o firewall atualizado e o sistema deve abrir automaticamente no navegador.%n%nUse o atalho **Margin Engine** para acessar o painel e ativar o terminal de caixa.

[Code]
var
  BootstrapMode: String;
  UninstallKeepData: Boolean;
  InstalledVersion: String;

function GetModeParam: String;
begin
  Result := LowerCase(Trim(ExpandConstant('{param:MODE|}')));
end;

function IsExistingInstall: Boolean;
begin
  Result := RegKeyExists(HKLM,
    'Software\Microsoft\Windows\CurrentVersion\Uninstall\{#MyAppId}_is1');
end;

function GetInstalledVersion: String;
begin
  Result := '';
  if RegQueryStringValue(HKLM,
    'Software\Microsoft\Windows\CurrentVersion\Uninstall\{#MyAppId}_is1',
    'DisplayVersion', Result) then
    Exit;
  Result := '';
end;

function StopMarginEngineService: Boolean;
var
  ErrorCode: Integer;
  NodeExe: String;
  ScriptPath: String;
begin
  Result := True;
  if not IsExistingInstall then
    Exit;
  if (BootstrapMode <> 'update') and (BootstrapMode <> 'repair') then
    Exit;
  NodeExe := ExpandConstant('{app}\node\node.exe');
  ScriptPath := ExpandConstant('{app}\app\scripts\installer-service-control.js');
  if (not FileExists(NodeExe)) or (not FileExists(ScriptPath)) then
    Exit;
  if not Exec(NodeExe, '"' + ScriptPath + '" stop', ExpandConstant('{app}\app'),
    SW_HIDE, ewWaitUntilTerminated, ErrorCode) then
  begin
    MsgBox('Não foi possível parar o serviço Margin Engine antes da atualização.' + #13#10 +
      'Pare manualmente em Serviços do Windows e execute o instalador novamente.',
      mbError, MB_OK);
    Result := False;
    Exit;
  end;
  if ErrorCode <> 0 then
  begin
    MsgBox('O serviço Margin Engine não parou dentro do tempo esperado.' + #13#10 +
      'Verifique Serviços do Windows e tente novamente.',
      mbError, MB_OK);
    Result := False;
  end;
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

  if (BootstrapMode = 'update') or (BootstrapMode = 'repair') then
  begin
    InstalledVersion := GetInstalledVersion;
    if (InstalledVersion <> '') and (CompareVersion('{#MyAppVersion}', InstalledVersion) < 0) then
    begin
      MsgBox(
        'Não é possível instalar uma versão anterior do Margin Engine.' + #13#10 + #13#10 +
        'Versão do instalador: {#MyAppVersion}' + #13#10 +
        'Versão instalada: ' + InstalledVersion + #13#10 + #13#10 +
        'Use o instalador da mesma versão (reparo) ou de uma versão mais recente (atualização).',
        mbError, MB_OK);
      Result := False;
      Exit;
    end;
  end;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpFinished then
    Exit;
  if CurPageID = wpSelectTasks then
  begin
    if IsTaskSelected('repairmode') then
      BootstrapMode := 'repair';
  end;
end;

function InitializeUninstall: Boolean;
begin
  Result := True;
  UninstallKeepData := True;
  if MsgBox(
    'Deseja manter os dados do caixa?' + #13#10 + #13#10 +
    'Inclui configurações, certificados, banco local, XML, backup, cache, imagens e logs.' + #13#10 + #13#10 +
    '**Sim** — remove apenas o programa, o serviço e os atalhos.' + #13#10 +
    '**Não** — apaga também a pasta de dados do Margin Engine.',
    mbConfirmation, MB_YESNO or MB_DEFBUTTON1) = IDYES then
    UninstallKeepData := True
  else
    UninstallKeepData := False;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataRoot: String;
begin
  if (CurUninstallStep = usPostUninstall) and (not UninstallKeepData) then
  begin
    DataRoot := ExpandConstant('{commonappdata}\MarginEngine');
    if DirExists(DataRoot) then
    begin
      if MsgBox(
        'Confirma apagar permanentemente os dados em:' + #13#10 + DataRoot + '?',
        mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
      begin
        DelTree(DataRoot, True, True, True);
      end;
    end;
  end;
end;

function GetBootstrapMode(Param: String): String;
begin
  Result := BootstrapMode;
end;

function GetBootstrapFlags(Param: String): String;
begin
  Result := ' --service --firewall --open';
  if IsTaskSelected('desktopicon') then
    Result := Result + ' --desktop';
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  NeedsRestart := False;
  if not StopMarginEngineService then
    Result := 'O serviço Margin Engine precisa estar parado para concluir a instalação.';
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
    ModeLabel := 'Reparar instalação existente'
  else if BootstrapMode = 'update' then
    ModeLabel := 'Atualizar Margin Engine (dados preservados)'
  else
    ModeLabel := 'Instalação nova';

  Result := '';
  if MemoDirInfo <> '' then
    Result := Result + MemoDirInfo + NewLine + NewLine;
  if MemoTasksInfo <> '' then
    Result := Result + MemoTasksInfo + NewLine + NewLine;

  Result := Result +
    'Modo: ' + ModeLabel + NewLine + NewLine +
    'Produto: Margin Engine {#MyAppVersion}' + NewLine +
    'Editor: {#MyAppPublisher}' + NewLine + NewLine +
    'Dados do caixa: ' + ExpandConstant('{commonappdata}\MarginEngine') +
    ' (preservados na atualização e desinstalação padrão)' + NewLine + NewLine +
    'Ao concluir: serviço instalado, firewall configurado, sistema aberto no navegador.';
end;

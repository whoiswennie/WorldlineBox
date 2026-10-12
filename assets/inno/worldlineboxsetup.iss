; WorldlineBox Windows 安装器（Inno Setup，参考 VS Code build/win32/code.iss）。
; 多语言：ShowLanguageDialog=yes 始终显示语言选择（默认选中系统语言，
; 见 [Languages] 顺序与 Inno 检测逻辑）；向导含安装路径选择页；per-machine
; 安装（UAC 一开始提示）；卸载器 unins000.exe 自动生成。
; 构建：ISCC.exe assets\inno\worldlineboxsetup.iss（SourceDir 指向打包产物父目录）

#define AppName "WorldlineBox"
; 版本由 inno-build.mjs 从 package.json 以 -DAppVersion 传入（npm version 提升后
; 安装器版本自动跟随）；缺省 0.1.0 仅为直接手工编译 ISCC 时的兜底。
#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#define AppExeName "WorldlineBox.exe"

[Setup]
AppId={{A2C67D80-AA1A-4100-B5B1-477AF2D20202}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=whoiswennie
AppPublisherURL=https://github.com/whoiswennie/WorldlineBox
; autopf：按 PrivilegesRequired 自动选择（admin → Program Files）
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
AllowNoIcons=yes
OutputDir=..\..\out\make\inno
OutputBaseFilename=WorldlineBoxSetup
Compression=lzma
SolidCompression=yes
SetupIconFile=..\..\assets\icons\app.ico
UninstallDisplayIcon={app}\{#AppExeName}
MinVersion=10.0
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; 语言选择：yes = 安装启动时始终显示语言选择对话框（默认选中系统语言）
ShowLanguageDialog=yes
WizardStyle=modern
; per-machine：安装到 Program Files，UAC 提权（产品要求"一开始提示"）
PrivilegesRequired=admin
CloseApplications=force

[Languages]
; 英文在前 → 系统语言不匹配时默认英文
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "..\..\out\WorldlineBox-win32-x64\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "ChineseSimplified.LICENSE.txt"; DestDir: "{app}\resources"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    SaveStringToFile(ExpandConstant('{app}\.worldlinebox-installed'), 'installed', False);
end;

procedure CurUninstallStepChanged(UninstallStep: TUninstallStep);
begin
  if UninstallStep = usUninstall then
    DeleteFile(ExpandConstant('{app}\.worldlinebox-installed'));
end;

[Run]
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

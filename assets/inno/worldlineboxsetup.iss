; WorldlineBox Windows 安装器（Inno Setup，参考 VS Code build/win32/code.iss）。
; 单文件原生向导负责全用户安装。
; 构建：ISCC.exe assets\inno\worldlineboxsetup.iss（SourceDir 指向打包产物父目录）

#define AppName "WorldlineBox"
; 版本由 inno-build.mjs 从 package.json 以 -DAppVersion 传入（npm version 提升后
; 安装器版本自动跟随）；缺省 0.1.0 仅为直接手工编译 ISCC 时的兜底。
#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#define AppExeName "WorldlineBox.exe"
#ifndef AppSourceDir
  #define AppSourceDir "..\..\out\WorldlineBox-win32-x64"
#endif

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
DiskSpanning=no
Compression=lzma2/ultra64
; Keep the offline installer within the release host's single-file limit.
LZMAUseSeparateProcess=yes
LZMADictionarySize=262144
SolidCompression=yes
SetupIconFile=..\..\assets\icons\app.ico
UninstallDisplayIcon={app}\{#AppExeName}
MinVersion=10.0
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; 语言选择框早于 InitializeSetup。同一时间多次启动时直接进入同一个向导。
ShowLanguageDialog=no
WizardStyle=modern
; per-machine：安装到 Program Files，UAC 提权（产品要求"一开始提示"）
PrivilegesRequired=admin
SetupMutex=WorldlineBox.InnoSetup
CloseApplications=force

[Languages]
; 英文在前 → 系统语言不匹配时默认英文
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#AppSourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "ChineseSimplified.LICENSE.txt"; DestDir: "{app}\resources"; Flags: ignoreversion

[Icons]
Name: "{group}\世界线盒子"; Filename: "{app}\{#AppExeName}"; IconFilename: "{app}\{#AppExeName}"; IconIndex: 0; AppUserModelID: "com.worldlinebox.app"; AppUserModelToastActivatorCLSID: "24BC5C0E-9196-41EA-90D5-8037889B7B7D"
Name: "{autodesktop}\世界线盒子"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon; IconFilename: "{app}\{#AppExeName}"; IconIndex: 0; AppUserModelID: "com.worldlinebox.app"; AppUserModelToastActivatorCLSID: "24BC5C0E-9196-41EA-90D5-8037889B7B7D"

[Code]
const
  InstallerMutex = 'Local\WorldlineBox.NativeSetup';
  WizardProperty = 'WorldlineBox.NativeSetup.Wizard';
  ErrorAlreadyExists = 183;

var
  InstanceHandle: THandle;

function CreateMutex(Attributes: LongWord; InitialOwner: Boolean; Name: String): THandle;
  external 'CreateMutexW@kernel32.dll stdcall setuponly';
function CloseHandle(Handle: THandle): Boolean;
  external 'CloseHandle@kernel32.dll stdcall setuponly';
function FindNextWizard(Parent, Previous: HWND; ClassName: String; Title: LongWord): HWND;
  external 'FindWindowExW@user32.dll stdcall setuponly';
function SetProp(Window: HWND; Name: String; Value: THandle): Boolean;
  external 'SetPropW@user32.dll stdcall setuponly';
function GetProp(Window: HWND; Name: String): THandle;
  external 'GetPropW@user32.dll stdcall setuponly';
function IsIconic(Window: HWND): Boolean;
  external 'IsIconic@user32.dll stdcall setuponly';
function ShowWindow(Window: HWND; Command: Integer): Boolean;
  external 'ShowWindow@user32.dll stdcall setuponly';
function GetLastActivePopup(Window: HWND): HWND;
  external 'GetLastActivePopup@user32.dll stdcall setuponly';
function SetForegroundWindow(Window: HWND): Boolean;
  external 'SetForegroundWindow@user32.dll stdcall setuponly';

procedure ActivateExistingWizard;
var
  Window: HWND;
begin
  Window := FindNextWizard(0, 0, 'TWizardForm', 0);
  while Window <> 0 do begin
    if GetProp(Window, WizardProperty) <> 0 then begin
      if IsIconic(Window) then ShowWindow(Window, 9);  { SW_RESTORE }
      SetForegroundWindow(GetLastActivePopup(Window));
      Exit;
    end;
    Window := FindNextWizard(0, Window, 'TWizardForm', 0);
  end;
end;

function InitializeSetup: Boolean;
begin
  { Claim the instance atomically, including while the first wizard is starting. }
  InstanceHandle := CreateMutex(0, False, InstallerMutex);
  Result := (InstanceHandle = 0) or (DLLGetLastError <> ErrorAlreadyExists);
  if not Result then begin
    CloseHandle(InstanceHandle);
    InstanceHandle := 0;
    if not WizardSilent then ActivateExistingWizard;
  end;
end;

procedure InitializeWizard;
begin
  SetProp(WizardForm.Handle, WizardProperty, 1);
end;

procedure DeinitializeSetup;
begin
  if InstanceHandle <> 0 then CloseHandle(InstanceHandle);
end;

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

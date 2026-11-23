#ifndef Delivery
  #error Specify the path to the signed Forge delivery with /DDelivery
#endif
#ifndef Version
  #error Specify the release version with /DVersion
#endif

#define Bootstrap "Forge-Setup-" + Version + ".exe"
#define Package "forge-" + Version + "-windows-x64.zip"
#define Launcher "{app}\Installation\Forge Launcher.exe"

#ifdef LocalPreview
  #define Name "Forge Local"
  #define SetupId "Forge.Local." + Version
  #define UninstallKey SetupId + "_is1"
  #define DestinationFolder "Forge " + Version + " Local"
  #define OutputName "Forge-Installer-" + Version + "-local"
#else
  #define Name "Forge"
  #define SetupId "{{738940DB-1491-459D-92DF-8571C6C3460C}"
  #define UninstallKey "{738940DB-1491-459D-92DF-8571C6C3460C}_is1"
  #define DestinationFolder "Forge"
  #define OutputName "Forge-Installer-" + Version
#endif

[Setup]
AppId={#SetupId}
AppName={#Name}
AppVersion={#Version}
AppPublisher=Forge
DefaultDirName={localappdata}\{#DestinationFolder}
DefaultGroupName={#Name}
DisableDirPage=no
DisableProgramGroupPage=no
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.22000
AllowNetworkDrive=no
AllowUNCPath=no
AllowRootDirectory=no
WizardStyle=modern
OutputBaseFilename={#OutputName}
SetupIconFile=..\..\apps\desktop\anvil.ico
Compression=none
SetupLogging=yes
UninstallDisplayIcon={#Launcher}
UninstallFilesDir={app}\Installer
CloseApplications=no

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#Delivery}\{#Bootstrap}"; Flags: dontcopy
Source: "{#Delivery}\forge-release.json"; Flags: dontcopy
Source: "{#Delivery}\forge-release.sig"; Flags: dontcopy
Source: "{#Delivery}\{#Package}"; Flags: dontcopy

[Icons]
Name: "{group}\{#Name}"; Filename: "{#Launcher}"; WorkingDir: "{app}\Installation"; AppUserModelID: "Forge.Desktop"
Name: "{userdesktop}\{#Name}"; Filename: "{#Launcher}"; WorkingDir: "{app}\Installation"; Tasks: desktopicon; AppUserModelID: "Forge.Desktop"

[Run]
Filename: "{#Launcher}"; WorkingDir: "{app}\Installation"; Description: "{cm:LaunchProgram,{#Name}}"; Flags: nowait postinstall unchecked skipifsilent

[UninstallDelete]
Type: dirifempty; Name: "{app}"

[Code]
function RemoveProgramFiles(): Boolean;
begin
  Result := ExpandConstant('{param:FORGE_SHELL_ONLY|0}') <> '1';
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpReady) and FileExists(AddBackslash(WizardDirValue) + 'Installation\active.json') then begin
    WizardForm.ReadyLabel.Caption := 'Setup will reinstall Forge in the selected folder.';
    WizardForm.NextButton.Caption := '&Reinstall';
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Status, Index: Integer;
  InputDir, Parameters, PreviousPath, Destination: String;
  Output: TExecOutput;
begin
  Result := '';
  Destination := RemoveBackslashUnlessRoot(WizardDirValue);
  if RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{#UninstallKey}',
    'InstallLocation', PreviousPath) and
    (CompareText(RemoveBackslashUnlessRoot(PreviousPath), Destination) <> 0) then begin
    Result := 'Forge is already registered in ' + PreviousPath + '. Select that folder to reinstall.';
    Exit;
  end;
  InputDir := ExpandConstant('{tmp}\');
  try
    ExtractTemporaryFile('{#Bootstrap}');
    ExtractTemporaryFile('forge-release.json');
    ExtractTemporaryFile('forge-release.sig');
    ExtractTemporaryFile('{#Package}');
    Parameters := 'install-at ' + AddQuotes(Destination) + ' ' +
      AddQuotes(InputDir + 'forge-release.json') + ' ' +
      AddQuotes(InputDir + 'forge-release.sig') + ' ' +
      AddQuotes(InputDir + '{#Package}');
    if not ExecAndCaptureOutput(InputDir + '{#Bootstrap}', Parameters, InputDir,
      SW_HIDE, ewWaitUntilTerminated, Status, Output) then
      Result := 'Forge could not start its release verifier. ' + SysErrorMessage(Status)
    else if Status <> 0 then begin
      Result := 'Forge could not install the signed release.';
      for Index := 0 to GetArrayLength(Output.StdErr) - 1 do
        Result := Result + #13#10 + Output.StdErr[Index];
    end;
  except
    Result := GetExceptionMessage;
  end;
end;

function InitializeUninstall(): Boolean;
var
  Launcher, Directory: String;
  Status: Integer;
begin
  if not RemoveProgramFiles() then begin
    Result := True;
    Exit;
  end;
  Directory := ExpandConstant('{app}\Installation');
  Launcher := ExpandConstant('{#Launcher}');
  Result := not DirExists(Directory) or
    (Exec(Launcher, 'check-uninstall', Directory, SW_HIDE, ewWaitUntilTerminated, Status) and (Status = 0));
  if not Result and not UninstallSilent then
    MsgBox('Close Forge and retry. If it is already closed, the installation directory could not be verified.', mbError, MB_OK);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Launcher, Remover, Directory, Parameters, Message: String;
  Status, Index: Integer;
  Output: TExecOutput;
begin
  if (CurUninstallStep <> usUninstall) or not RemoveProgramFiles() then
    Exit;
  Directory := ExpandConstant('{app}\Installation');
  if not DirExists(Directory) then
    Exit;
  Launcher := ExpandConstant('{#Launcher}');
  Remover := ExpandConstant('{tmp}\forge-runtime-remover.exe');
  if not CopyFile(Launcher, Remover, True) then
    RaiseException('Forge could not prepare the runtime uninstaller.');
  Parameters := 'remove-runtime ' + AddQuotes(Directory);
  if not ExecAndCaptureOutput(Remover, Parameters, ExpandConstant('{tmp}'),
    SW_HIDE, ewWaitUntilTerminated, Status, Output) then
    RaiseException('Forge could not start the runtime uninstaller. ' + SysErrorMessage(Status));
  if Status <> 0 then begin
    Message := 'Forge could not remove the installed runtime.';
    for Index := 0 to GetArrayLength(Output.StdErr) - 1 do
      Message := Message + #13#10 + Output.StdErr[Index];
    RaiseException(Message);
  end;
end;

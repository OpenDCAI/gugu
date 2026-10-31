!macro customInit
  # Older clients invoke the new installer with --stage before the user confirms installation.
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--stage" $R1
  ${IfNot} ${Errors}
    SetErrorLevel 1
    Quit
  ${EndIf}
  ClearErrors
  ${If} ${isUpdated}
    SetSilent normal # older clients also pass /S when the user confirms the update
  ${EndIf}
  # @@@win-beta-install-dir - Earlier Windows beta installers shared the production package name
  # (`gugu`), so the uninstall registry can point beta upgrades back at %LOCALAPPDATA%\Programs\gugu.
  # Force a per-user beta to its tier-owned install root after electron-builder reads any existing InstallLocation;
  # a per-machine one keeps its own (Program Files): $LocalAppData there would be ProgramData.
  ${If} $installMode != "all"
    StrCpy $INSTDIR "$LocalAppData\Programs\gugu-beta"
  ${EndIf}
!macroend

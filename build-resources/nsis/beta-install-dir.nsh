!include "${BUILD_RESOURCES_DIR}\nsis\staged-update.nsh"

!macro customInit
  # @@@win-beta-install-dir - Earlier Windows beta installers shared the production package name
  # (`gugu`), so the uninstall registry can point beta upgrades back at %LOCALAPPDATA%\Programs\gugu.
  # Force a per-user beta to its tier-owned install root after electron-builder reads any existing InstallLocation;
  # a per-machine one keeps its own (Program Files): $LocalAppData there would be ProgramData.
  ${If} $installMode != "all"
    StrCpy $INSTDIR "$LocalAppData\Programs\gugu-beta"
  ${EndIf}
  !insertmacro guguStagedUpdate
!macroend

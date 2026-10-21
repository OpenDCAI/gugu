!macro customInit
  # @@@win-beta-install-dir - Earlier Windows beta installers shared the production package name
  # (`gugu`), so the uninstall registry can point beta upgrades back at %LOCALAPPDATA%\Programs\gugu.
  # Force beta to its tier-owned install root after electron-builder reads any existing InstallLocation.
  StrCpy $INSTDIR "$LocalAppData\Programs\gugu-beta"
!macroend

!macro customInit
  # #2482: v0.1.0's uninstaller exits with code 2 when electron-builder copies it to
  # $PLUGINSDIR and appends /KEEP_APP_DATA, --updated, and _?=<install dir>. Running
  # that legacy uninstaller in place with its supported arguments succeeds. Remove
  # only this known-bad version here; after success the normal upgrade path sees no
  # old uninstall registry entry. Any failure is left for electron-builder's normal
  # retry/error handling instead of being hidden.
  ReadRegStr $R0 HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ${If} $R0 == "0.1.0"
    ReadRegStr $R0 HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    ${If} $R0 != ""
      ExecWait '$R0 /S' $R1
    ${EndIf}
  ${EndIf}
!macroend

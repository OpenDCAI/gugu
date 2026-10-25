# @@@staged-update - the update is extracted to a stage directory while the app still runs; the restart only swaps
# directories. (The template's update closes the app, runs the old uninstaller and writes every file twice: 2-7 min.)
#   --stage    from the app once the download is verified: extract to the stage, open every file once (Defender
#              scans a file on first open; doing it now keeps it off the first launch), then mark the version.
#   --updated  autoUpdater.quitAndInstall: with this very version staged, $INSTDIR -> .old, stage -> $INSTDIR, start the
#              app. Anything else falls through to the template's update. Both run in .onInit (customInit) and Quit.
# The stage sits where this user can write on the install's disk (a swap is a rename, never a copy): $INSTDIR.next for
# a per-user install; for a per-machine one (Program Files) this user's updater cache, and the swap elevates once —
# the same UAC prompt the template's update shows.
!define GUGU_PS `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -C`

!macro guguStageDir
  ${If} $installMode == "all"
    SetShellVarContext current # electron-updater's cache is per user, as the template's own store files are
    ${StdUtils.GetParentPath} $R7 "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
    StrCpy $R7 "$R7\staged"
    SetShellVarContext all
  ${Else}
    StrCpy $R7 "$INSTDIR.next"
  ${EndIf}
!macroend

!macro guguStagedUpdate
  !insertmacro guguStageDir
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--stage" $R1
  ${IfNot} ${Errors}
    InitPluginsDir
    RMDir /r "$R7"
    RMDir /r "$INSTDIR.old"
    StrCpy $R8 "$R7" 2
    StrCpy $R9 "$INSTDIR" 2
    ${If} $R8 != $R9 # the user profile on another disk than Program Files: no rename can swap, the restart installs
      SetErrorLevel 4
      Quit
    ${EndIf}
    ClearErrors
    CreateDirectory "$R7"
    ${If} ${Errors}
      SetErrorLevel 3
      Quit
    ${EndIf}
    SetOutPath "$R7"
    # stored like the template's own copy, so makensis keeps one data block for both
    !ifdef COMPRESS
      SetCompress off
    !endif
    File /oname=$PLUGINSDIR\app-64.7z "${APP_64}"
    !ifdef COMPRESS
      SetCompress "${COMPRESS}"
    !endif
    Nsis7z::Extract "$PLUGINSDIR\app-64.7z"
    File "/oname=$R7\${UNINSTALL_FILENAME}" "${UNINSTALLER_OUT_FILE}"
    SetOutPath $TEMP
    ${IfNot} ${FileExists} "$R7\${APP_EXECUTABLE_FILENAME}"
      SetErrorLevel 2
      Quit
    ${EndIf}
    ${If} $installMode == "all"
      SetShellVarContext current
    ${EndIf}
    CopyFiles /SILENT "$EXEPATH" "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}" # next differential base, as the template keeps it
    nsExec::Exec `${GUGU_PS} "Get-ChildItem -LiteralPath '$R7' -Recurse -File | % { $$_.OpenRead().Dispose() }"`
    Pop $R5
    FileOpen $R2 "$R7\.staged-version" w
    FileWrite $R2 "${VERSION}"
    FileClose $R2
    SetErrorLevel 0
    Quit
  ${EndIf}

  ${If} ${isUpdated}
  ${AndIf} ${FileExists} "$R7\.staged-version"
    FileOpen $R2 "$R7\.staged-version" r
    FileRead $R2 $R3
    FileClose $R2
    ${If} $R3 == "${VERSION}"
      ${If} $installMode == "all"
      ${AndIfNot} ${UAC_IsAdmin}
        # The elevated copy of this installer runs this same macro (swap, or the template's update should the swap give
        # up) and starts the app. Refused or failed: the app has already quit, so bring this version back; the stage
        # stays for the next restart.
        !insertmacro UAC_RunElevated
        ${If} $0 = 0
        ${AndIf} $1 = 1
        ${AndIf} $2 = 0
          Quit
        ${EndIf}
        ${StdUtils.ExecShellAsUser} $0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "open" ""
        SetErrorLevel 1223
        Quit
      ${EndIf}
      RMDir /r "$INSTDIR.old" # normally gone with the --stage; a per-machine one only if its cleanup was cut short
      # A directory cannot be renamed while anything runs from it. The quitting app gets 3 s (it exits in ~1 s; the
      # template's own check closes it after ~1.3 s); then whatever still runs from the old directory (typically the
      # user reopening it) is closed, again every 5 s should they reopen it once more; give up after 30 s.
      StrCpy $R4 0
      ${Do}
        ClearErrors
        Rename "$INSTDIR" "$INSTDIR.old"
        ${IfNot} ${Errors}
          ${Break}
        ${EndIf}
        IntOp $R4 $R4 + 1
        ${If} $R4 >= 300
          ${Break}
        ${EndIf}
        IntOp $R6 $R4 % 50
        ${If} $R6 = 30
          nsExec::Exec `${GUGU_PS} "Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith('$INSTDIR\', 'CurrentCultureIgnoreCase')} | % { Stop-Process -Id $$_.ProcessId -Force }"`
          Pop $R5
        ${EndIf}
        Sleep 100
      ${Loop}
      ${If} $R4 < 300
        ClearErrors
        Rename "$R7" "$INSTDIR"
        ${If} ${Errors}
          Rename "$INSTDIR.old" "$INSTDIR"
        ${Else}
          Delete "$INSTDIR\.staged-version"
          WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" DisplayVersion "${VERSION}"
          WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" DisplayName "${UNINSTALL_DISPLAY_NAME}"
          ${StdUtils.ExecShellAsUser} $0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "open" "--updated"
          ${If} $installMode == "all"
            # The moved tree still carries the user's profile ACL (owned by the user, unreadable to other accounts).
            # Owner first: /reset re-inherits Program Files' CREATOR OWNER entry, which would hand the owner write back.
            # After the launch, so the app starts meanwhile; the files stay user-writable for these seconds.
            nsExec::Exec `"$SYSDIR\icacls.exe" "$INSTDIR" /setowner *S-1-5-32-544 /T /C /Q`
            Pop $R5
            nsExec::Exec `"$SYSDIR\icacls.exe" "$INSTDIR" /reset /T /C /Q`
            Pop $R5
            RMDir /r "$INSTDIR.old" # the next --stage cannot: it runs without elevation
          ${EndIf}
          SetErrorLevel 0 # a per-user .old goes with the next --stage: deleting ~7000 files now would slow this launch
          Quit
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

# the template's update (no stage, a stale one, or a swap that gave up) leaves no copy behind; neither does a removal
!macro customInstall
  RMDir /r "$INSTDIR.next"
  RMDir /r "$INSTDIR.old"
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    !insertmacro guguStageDir
    RMDir /r "$R7"
    RMDir /r "$INSTDIR.old"
  ${endIf}
!macroend

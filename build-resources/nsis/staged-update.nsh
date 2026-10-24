# @@@staged-update - the update is extracted next to the install dir while the app still runs; the restart only swaps
# directories. (The template's update closes the app, runs the old uninstaller and writes every file twice: 2-7 min.)
#   --stage    from the app once the download is verified: extract to $INSTDIR.next, open every file once (Defender
#              scans a file on first open; doing it now keeps it off the first launch), then mark the version.
#   --updated  autoUpdater.quitAndInstall: with this very version staged, $INSTDIR -> .old, .next -> $INSTDIR, start the
#              app. Anything else falls through to the template's update. Both run in .onInit (customInit) and Quit.
!define GUGU_PS `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -C`

!macro guguStagedUpdate
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--stage" $R1
  ${IfNot} ${Errors}
    InitPluginsDir
    RMDir /r "$INSTDIR.next"
    RMDir /r "$INSTDIR.old"
    ClearErrors
    CreateDirectory "$INSTDIR.next"
    ${If} ${Errors} # e.g. a per-machine install this user cannot write: the restart takes the template's update
      SetErrorLevel 3
      Quit
    ${EndIf}
    SetOutPath "$INSTDIR.next"
    # stored like the template's own copy, so makensis keeps one data block for both
    !ifdef COMPRESS
      SetCompress off
    !endif
    File /oname=$PLUGINSDIR\app-64.7z "${APP_64}"
    !ifdef COMPRESS
      SetCompress "${COMPRESS}"
    !endif
    Nsis7z::Extract "$PLUGINSDIR\app-64.7z"
    File "/oname=$INSTDIR.next\${UNINSTALL_FILENAME}" "${UNINSTALLER_OUT_FILE}"
    SetOutPath $TEMP
    ${IfNot} ${FileExists} "$INSTDIR.next\${APP_EXECUTABLE_FILENAME}"
      SetErrorLevel 2
      Quit
    ${EndIf}
    CopyFiles /SILENT "$EXEPATH" "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}" # next differential base, as the template keeps it
    nsExec::Exec `${GUGU_PS} "Get-ChildItem -LiteralPath '$INSTDIR.next' -Recurse -File | % { $$_.OpenRead().Dispose() }"`
    Pop $R5
    FileOpen $R2 "$INSTDIR.next\.staged-version" w
    FileWrite $R2 "${VERSION}"
    FileClose $R2
    SetErrorLevel 0
    Quit
  ${EndIf}

  ${If} ${isUpdated}
  ${AndIf} ${FileExists} "$INSTDIR.next\.staged-version"
    FileOpen $R2 "$INSTDIR.next\.staged-version" r
    FileRead $R2 $R3
    FileClose $R2
    ${If} $R3 == "${VERSION}"
      # A directory cannot be renamed while anything runs from it. The quitting app gets 5 s; whatever still runs from
      # the old directory after that (typically the user reopening it) is closed; give up after 30 s.
      StrCpy $R4 0
      ${Do}
        ClearErrors
        Rename "$INSTDIR" "$INSTDIR.old"
        ${IfNot} ${Errors}
          ${Break}
        ${EndIf}
        IntOp $R4 $R4 + 1
        ${If} $R4 = 50
          nsExec::Exec `${GUGU_PS} "Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith('$INSTDIR\', 'CurrentCultureIgnoreCase')} | % { Stop-Process -Id $$_.ProcessId -Force }"`
          Pop $R5
        ${ElseIf} $R4 >= 300
          ${Break}
        ${EndIf}
        Sleep 100
      ${Loop}
      ${If} $R4 < 300
        ClearErrors
        Rename "$INSTDIR.next" "$INSTDIR"
        ${If} ${Errors}
          Rename "$INSTDIR.old" "$INSTDIR"
        ${Else}
          Delete "$INSTDIR\.staged-version"
          WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" DisplayVersion "${VERSION}"
          WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" DisplayName "${UNINSTALL_DISPLAY_NAME}"
          ${StdUtils.ExecShellAsUser} $0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "open" "--updated"
          SetErrorLevel 0 # .old goes with the next --stage: deleting ~7000 files now would slow this launch
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
    RMDir /r "$INSTDIR.next"
    RMDir /r "$INSTDIR.old"
  ${endIf}
!macroend

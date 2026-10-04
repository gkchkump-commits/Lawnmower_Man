; Lawnmower Man - NSIS customisation (package.json build.nsis.include).
;
; Always install for the current user only: skip the "for me / for all users" page and never
; ask for administrator rights. The app lives in %LOCALAPPDATA%\Programs\Lawnmower Man, writes
; its settings to %APPDATA%\Lawnmower Man and the optional local voice to
; %LOCALAPPDATA%\LawnmowerMan\voice, so nothing needs a machine-wide install.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; Uninstall from Settings > Apps (interactive, not an update): offer to delete the local voice
; (Python environment + models, several GB) and the settings, default No. An update or reinstall
; runs the previous version's uninstaller with /S --updated: it never asks and keeps both, and so
; does a silent uninstall (/S). Only these two folders are ever touched: never the Claude work
; folder (%USERPROFILE%\LawnmowerMan), a models folder chosen with -ModelsDir, or ~/.claude.
!macro customUnInstall
  ${ifNot} ${isUpdated}
  ${andIfNot} ${Silent}
  ${andIf} $LOCALAPPDATA != ""
  ${andIf} $APPDATA != ""
    StrCpy $R8 ""
    ${if} ${FileExists} "$LOCALAPPDATA\LawnmowerMan\voice\*.*"
      StrCpy $R8 "$R8$\r$\n    $LOCALAPPDATA\LawnmowerMan\voice  (local voice: Python and models, several GB)"
    ${endIf}
    ${if} ${FileExists} "$APPDATA\${APP_FILENAME}\*.*"
      StrCpy $R8 "$R8$\r$\n    $APPDATA\${APP_FILENAME}  (settings and logs)"
    ${endIf}
    ${if} $R8 != ""
      ${if} ${Cmd} `MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your Lawnmower Man data?$\r$\n$R8$\r$\n$\r$\nChoose No to keep it for a later reinstall." /SD IDNO IDYES`
        ; the local voice server exits a moment after the app (it watches its parent process)
        Sleep 2500
        RMDir /r "$LOCALAPPDATA\LawnmowerMan\voice"
        RMDir "$LOCALAPPDATA\LawnmowerMan"
        RMDir /r "$APPDATA\${APP_FILENAME}"
        ${if} ${FileExists} "$LOCALAPPDATA\LawnmowerMan\voice\*.*"
        ${orIf} ${FileExists} "$APPDATA\${APP_FILENAME}\*.*"
          MessageBox MB_OK|MB_ICONEXCLAMATION "Some files were in use and could not be deleted. Delete what is left of these folders yourself:$\r$\n$R8" /SD IDOK
        ${endIf}
      ${endIf}
    ${endIf}
  ${endIf}
!macroend

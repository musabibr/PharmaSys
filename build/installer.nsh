; PharmaSys custom NSIS script
; 1. Clears previous database and config for a clean install
; 2. PRESERVES data/backups/ and data/.backup-key so old backups remain restorable
; 3. Writes a fresh_install marker so the app resets admin credentials on first run.
;
; The marker is written to $INSTDIR (the app's installation folder) rather than
; $APPDATA, because $APPDATA resolves to the ADMIN profile when the installer is
; run elevated (UAC), which is a different path from what the app sees as the
; current user's AppData. $INSTDIR is always correct and always writable by the
; installer regardless of elevation context.

!macro customInstall
  ; ── Clean up previous installation data ──────────────────────────────────
  ; Delete database and config (reset to clean state)
  ; PRESERVE: data/backups/ and data/.backup-key so old backups remain restorable
  Delete "$APPDATA\PharmaSys\data\pharmasys.db"
  Delete "$APPDATA\PharmaSys\data\device-config.json"
  Delete "$APPDATA\PharmaSys\data\.fresh_install_processed"
  RMDir /r "$APPDATA\PharmaSys\data\tmp"
  ; Remove Electron caches and session storage
  RMDir /r "$APPDATA\PharmaSys\Cache"
  RMDir /r "$APPDATA\PharmaSys\Code Cache"
  RMDir /r "$APPDATA\PharmaSys\DawnCache"
  RMDir /r "$APPDATA\PharmaSys\GPUCache"
  RMDir /r "$APPDATA\PharmaSys\Local Storage"
  RMDir /r "$APPDATA\PharmaSys\Network"
  RMDir /r "$APPDATA\PharmaSys\Session Storage"
  RMDir /r "$APPDATA\PharmaSys\Shared Dictionary"
  RMDir /r "$APPDATA\PharmaSys\SharedStorage"
  RMDir /r "$APPDATA\PharmaSys\blob_storage"
  Delete "$APPDATA\PharmaSys\Preferences"
  Delete "$APPDATA\PharmaSys\Local State"
  Delete "$APPDATA\PharmaSys\debug.txt"
  Delete "$APPDATA\PharmaSys\debug_sql.txt"
  ; NOTE: pharmasys.license is intentionally preserved so the user doesn't
  ; need to re-activate after reinstalling/updating.

  ; ── Write fresh-install marker ───────────────────────────────────────────
  ; The app looks for it at path.dirname(process.execPath)/fresh_install.
  FileOpen $0 "$INSTDIR\fresh_install" w
  FileClose $0
!macroend

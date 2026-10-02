' mmx-status :: launch-mmx-status.vbs
' Hidden launcher wrapper. The .lnk used to call powershell.exe directly; even
' with "-WindowStyle Hidden" in the arguments AND WindowStyle=7 on the .lnk,
' powershell.exe still CREATES the console window first and hides it after --
' the user saw a black window titled "mmx-fix" flash (and, over RDP, sometimes
' linger) on every red-M click (reported 2026-10-02).
'
' wscript.exe has no console at all, so a shell that never shows a window is:
'   WScript.Shell.Run "<command>", 0 (hidden), false (don't wait)
'
' Same proven pattern as the ocx-patch-guard fix (2026-10-01) and
' BBWeb2GlineGuard on this machine.

Dim shell, fso, here, target
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' The .vbs lives in src\, the .ps1 next to it. Build the path relative to THIS
' file so the pair can be moved together without editing anything here.
here = fso.GetParentFolderName(WScript.ScriptFullName)
target = here & "\launch-mmx-status.ps1"

If Not fso.FileExists(target) Then
  MsgBox "mmx-fix: launch-mmx-status.ps1 not found at" & vbCrLf & target, 16, "mmx-fix"
  WScript.Quit 1
End If

' -WindowStyle Hidden is kept as belt-and-braces: it applies to the console
' wscript creates for powershell (which is none anyway) and costs nothing.
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & target & """", 0, False
Option Explicit

Dim shell, fso, root, command, logFile
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
logFile = root & "\.run\launcher-start.log"
If fso.FileExists(root & "\runtime\pythonw.exe") Then
  command = Chr(34) & root & "\runtime\pythonw.exe" & Chr(34) & " " & _
    Chr(34) & root & "\desktop_launcher.py" & Chr(34)
Else
  command = Chr(34) & shell.ExpandEnvironmentStrings("%ComSpec%") & Chr(34) & _
    " /d /c call " & Chr(34) & root & "\silent-start.cmd" & Chr(34)
End If
On Error Resume Next
shell.Run command, 0, True
If Err.Number <> 0 Then
  MsgBox "Could not start the local app. Check " & logFile & vbCrLf & Err.Description, _
    vbExclamation, "Warehouse startup"
End If
On Error GoTo 0

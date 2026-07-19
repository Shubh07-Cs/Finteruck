Set WshShell = CreateObject("WScript.Shell")
' 0 means hide the window, False means do not wait for the command to complete
WshShell.Run "cmd.exe /c npm run dev", 0, False

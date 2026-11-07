# engines

Put the Stockfish 19 executable here as **`stockfish19.exe`**. It is not in the repository: the
file is about 100 MB, over GitHub's file size limit, and Stockfish has its own license (GPLv3).

Download it with PowerShell from the project root:

```powershell
$ProgressPreference = 'SilentlyContinue'   # makes Invoke-WebRequest much faster
Invoke-WebRequest "https://github.com/official-stockfish/Stockfish/releases/download/sf_19/stockfish-windows-x86-64-universal.zip" -OutFile "$env:TEMP\stockfish19.zip"
Expand-Archive "$env:TEMP\stockfish19.zip" -DestinationPath "$env:TEMP\stockfish19" -Force
Copy-Item "$env:TEMP\stockfish19\stockfish\stockfish-windows-x86-64-universal.exe" engines\stockfish19.exe
```

Or download it by hand from <https://stockfishchess.org/download/> (or the
[sf_19 GitHub release](https://github.com/official-stockfish/Stockfish/releases/tag/sf_19)), unzip
it, and rename the `.exe` to `stockfish19.exe` in this folder.

To use an engine somewhere else, set `STOCKFISH_PATH` before starting:
`$env:STOCKFISH_PATH = "D:\engines\stockfish.exe"; .\start.bat`

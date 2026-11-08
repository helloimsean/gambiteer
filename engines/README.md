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

## Maia (optional)

Maia is the human-like bot: 9 neural networks, one per 100 rating points from 1100 to 1900, trained
on real Lichess games. They run inside the [lc0](https://github.com/LeelaChessZero/lc0) engine. Neither
is in the repository (both are GPL-3.0). From the project root:

```powershell
python tools\install_maia.py
```

This downloads lc0 v0.32.1 (CPU build) to `engines\lc0\` and the nets to `engines\maia\`, and checks
every download against a pinned SHA-256. It is safe to run again. Use `--build dnnl` for the other CPU
build (the default is `openblas`). Then restart Gambiteer.

lc0 needs the [Microsoft Visual C++ 2015-2022 x64 Redistributable](https://aka.ms/vs/17/release/vc_redist.x64.exe),
which is not in its zip. Most Windows PCs already have it.

To check that the engine works on your PC:

```powershell
python tools\check_maia.py
```

On Linux or macOS the script downloads only the nets; build lc0 yourself and set `LC0_PATH` to it.
`MAIA_WEIGHTS_DIR` points at a different folder of nets.

## Fairy-Stockfish (optional)

[Fairy-Stockfish](https://github.com/fairy-stockfish/Fairy-Stockfish) (GPL-3.0) plays the variants
Stockfish 19 does not know: Crazyhouse, King of the Hill, Three-Check, Antichess, Atomic, Horde and
Racing Kings. From the project root:

```powershell
python tools\install_fairy.py
```

This downloads release `fairy_sf_14` (x86-64-modern build) to `engines\fairy\fairy-stockfish.exe` and
checks it against a pinned SHA-256. Then restart Gambiteer. `python tools\check_fairy.py` asks it for
a move in every variant. To use a copy somewhere else, or on Linux or macOS, set `FAIRY_PATH`.

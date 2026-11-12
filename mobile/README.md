# Gambiteer for Android

The desktop app, running fully offline on a phone. Built for and tuned to a Samsung Galaxy S26 Ultra.

This folder lives on the `mobile` branch; `main` is the desktop app alone. Built APKs are attached to
the GitHub releases tagged `mobile-v*`.

## Put it on the phone

1. On the phone: Settings > About phone > Software information, tap **Build number** seven times.
   Then Settings > Developer options > turn on **USB debugging**.
2. Plug the phone into the PC and tap **Allow** on the prompt.
3. From this folder:

   ```powershell
   python scripts\build-apk.py --install
   ```

Or copy `Gambiteer.apk` to the phone and open it (Android asks you to allow installs from that app).

The first launch unpacks the app and takes about half a minute. Then open **Settings** (the gear) to
download the AI coach. Stockfish and everything else work before that.

## How it works

```
Android app (Kotlin, one Activity)
├─ WebView  ──http/ws──>  127.0.0.1:8000  the desktop FastAPI backend, unchanged (Chaquopy, Python 3.14)
│                             ├─ UCI ─> libstockfish.so   Stockfish 19
│                             ├─ UCI ─> liblc0.so         lc0 v0.32.1 + the nine Maia networks
│                             ├─ UCI ─> libfairy.so       Fairy-Stockfish 14 (variants)
│                             └─ http ─> 127.0.0.1:11434  CoachServer.kt
└─ CoachServer.kt: speaks the two Ollama endpoints the backend uses, answered by Gemma 4 through LiteRT-LM
```

* **No code is copied.** `backend/`, `data/openings/` and `frontend/src/` are read from the repo at
  build time, so a desktop fix reaches the phone on the next build. Only the phone shell, its layout
  (`web/src`) and a few user-facing strings (`web/text-patches.mjs`) are separate.
* **Languages** come from the desktop catalogs (`frontend/src/i18n`). The phone adds its own for the
  shell and the patched strings (`web/src/i18n`), and Android's texts are in `res/values-<code>`.
  Settings > Language sets both: the web app tells `MainActivity.Bridge.setLanguage`, which sets the
  app locale. Check with `npm run check:i18n:mobile` in `frontend/`.
* **The engines are executables named `lib*.so`.** Android only lets an app run files from its native
  library directory, and packaging them as libraries puts them there.
* **The coach** is Gemma 4 from Hugging Face (Apache-2.0, no account). E4B is 3.7 GB and recommended;
  E2B is 2.6 GB. The app downloads it itself over eight connections (Android's DownloadManager managed
  about 2 MB/s), resumes after an interruption, and checks it against a pinned revision and SHA-256. It
  uses the GPU and falls back to the CPU, and it unloads after five idle minutes to free memory. It runs
  in its own Android process (`:coach`), so a native crash costs one explanation, not the app; if the
  GPU crashes it, the coach stays on the CPU until the next app update.
* **Only the app can use its servers.** Every app on a phone can reach 127.0.0.1, so both servers want
  a key that is made once per install and kept in the app's private files (`AccessKey.kt`). The
  WebView sends it as a cookie, and the backend sends it to the coach as a bearer token. Anything
  without it gets 403 (backend) or 401 (coach). A debug build lets `adb shell run-as` read it, which is
  how `scripts/smoke-test.py` gets in.

## Layout of this folder

| Path | What |
|---|---|
| `Gambiteer.apk` | the last build |
| `android/` | Gradle project: Kotlin shell, Python boot file, launcher icon |
| `web/` | phone build of the React app: shell, phone layout per tab, `shots.mjs` for screenshots |
| `scripts/build-apk.py` | builds everything, `--install` puts it on the phone |
| `scripts/build-engines.py` | cross-compiles the engines |
| `scripts/build-pydantic-core.py` | compiles the one native Python dependency for Android |
| `scripts/smoke-test.py`, `drive-app.mjs` | test every engine, or drive the running app |
| `third_party/` | built wheels and the Maia networks |

The toolchain lives outside this folder, in `%LOCALAPPDATA%\Android` (JDK 21, Android SDK and NDK, Rust,
an emulator, about 10 GB). Nothing was added to PATH or the registry; delete that folder to remove it.
Versions: SDK platform 36, build-tools 36.1.0, NDK 29.0.14206865, Rust with the `aarch64-linux-android`
target.

The engines, wheels, Maia networks, web build and APK are build outputs, so git leaves them out (see
`.gitignore`). `scripts/build-apk.py` makes them again; on a fresh checkout, first run
`python tools/install_maia.py` from the repository root, since the Maia networks come from the desktop
install.

## Working on it

Phone layout, against the PC backend on port 8000, in a desktop browser at <http://localhost:5180>:

```powershell
node web\dev.mjs
node web\shots.mjs some\folder     # phone-sized screenshots of every tab
```

The emulator's ARM translation cannot run Stockfish's dot-product instructions, so it needs its own
Stockfish build. `build-apk.py` swaps the right one in by itself:

```powershell
python scripts\build-apk.py --emulator   # for the emulator
python scripts\build-apk.py              # for the phone (always the fast build)
```

With the app open, `adb forward tcp:18000 tcp:8000` and `python scripts\smoke-test.py` exercises every
engine and variant.

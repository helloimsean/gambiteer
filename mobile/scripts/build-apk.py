#!/usr/bin/env python3
"""Build Gambiteer.apk from the current desktop code.

    python scripts/build-apk.py             build
    python scripts/build-apk.py --install   build, then install on the phone connected over USB
    python scripts/build-apk.py --emulator  build for the Android emulator (see mobile/README.md)

Steps that already ran (engines, wheels) are skipped, so a normal rebuild takes about a minute.
The APK lands at mobile/Gambiteer.apk.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

MOBILE = Path(__file__).resolve().parents[1]
REPO = MOBILE.parent
ANDROID_HOME = Path(os.environ["LOCALAPPDATA"]) / "Android"
SDK = ANDROID_HOME / "Sdk"
JNI = MOBILE / "android" / "app" / "src" / "main" / "jniLibs" / "arm64-v8a"
WHEELS = MOBILE / "third_party" / "wheels"
ADB = SDK / "platform-tools" / "adb.exe"
OUTPUT = MOBILE / "android" / "app" / "build" / "outputs" / "apk" / "debug" / "app-debug.apk"
FINAL = MOBILE / "Gambiteer.apk"
CHESS_PIN = "1.11.2"
BASELINE_MARKER = MOBILE / "third_party" / "stockfish-baseline.marker"


def run(*command: object, cwd: Path = MOBILE, env: dict[str, str] | None = None) -> None:
    subprocess.run([str(part) for part in command], cwd=cwd, env=env, check=True)


def prerequisites(emulator: bool) -> None:
    missing = [p for p in (ANDROID_HOME / "jdk-21" / "bin" / "java.exe", SDK / "platforms" / "android-36") if not p.exists()]
    if missing:
        raise SystemExit(f"Android toolchain missing: {missing}. See mobile/README.md.")
    if not (REPO / "frontend" / "node_modules").is_dir():
        run("npm.cmd", "install", cwd=REPO / "frontend")
    if not list(WHEELS.glob("pydantic_core-*.whl")):
        run(sys.executable, MOBILE / "scripts" / "build-pydantic-core.py")
    if not list(WHEELS.glob(f"chess-{CHESS_PIN}-*.whl")):
        # This release is source only, and Chaquopy's pip only accepts wheels.
        run(sys.executable, "-m", "pip", "wheel", f"chess=={CHESS_PIN}", "--no-deps", "-w", WHEELS)
    if not all((JNI / f"lib{name}.so").is_file() for name in ("stockfish", "fairy", "lc0")):
        run(sys.executable, MOBILE / "scripts" / "build-engines.py")
    # The Stockfish in the APK has to match the target: the fast build crashes on the emulator and
    # the emulator's build would be needlessly slow on a phone.
    if BASELINE_MARKER.is_file() != emulator:
        run(sys.executable, MOBILE / "scripts" / "build-engines.py", "stockfish", *(["--baseline"] if emulator else []))


def gradle_env() -> dict[str, str]:
    env = dict(os.environ)
    env["JAVA_HOME"] = str(ANDROID_HOME / "jdk-21")
    env["ANDROID_HOME"] = str(SDK)
    return env


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--install", action="store_true", help="install on the connected phone")
    parser.add_argument("--emulator", action="store_true", help="use the Stockfish build the emulator can run")
    args = parser.parse_args()

    prerequisites(args.emulator)
    local = MOBILE / "android" / "local.properties"
    local.write_text(f"sdk.dir={SDK.as_posix()}\n", encoding="utf-8")
    run("node", MOBILE / "web" / "build.mjs")
    android = MOBILE / "android"
    # --rerun: incremental packaging stores the engines uncompressed, adding about 70 MB.
    run(android / "gradlew.bat", ":app:packageDebug", "--rerun", "assembleDebug", "--console=plain", cwd=android, env=gradle_env())
    shutil.copy2(OUTPUT, FINAL)
    print(f"built {FINAL} ({FINAL.stat().st_size / 1e6:.0f} MB)")
    if args.install:
        run(ADB, "install", "-r", FINAL)
        print("installed: open Gambiteer on the phone")
    return 0


if __name__ == "__main__":
    sys.exit(main())

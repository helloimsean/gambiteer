#!/usr/bin/env python3
r"""Download Fairy-Stockfish, the engine that plays the variants Stockfish 19 cannot.

    python tools\install_fairy.py

The file lands in engines\fairy\ (git-ignored) and is checked against the SHA-256 digest pinned
below, so it is safe to run this again. It only downloads: to try the engine afterwards, run
tools\check_fairy.py. On other systems, build Fairy-Stockfish by hand and set FAIRY_PATH.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from install_maia import InstallError, download, sha256_of

ROOT = Path(__file__).resolve().parents[1]

VERSION = "fairy_sf_14"
BUILD = "fairy-stockfish_x86-64-modern.exe"  # runs on any 64-bit CPU from the last decade
BUILD_URL = f"https://github.com/fairy-stockfish/Fairy-Stockfish/releases/download/{VERSION}/{BUILD}"
BUILD_SHA256 = "8ee199af88faebc4c87e1cfb5fb965716ea5eaf784ce59365900c96f2937ee2d"


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download Fairy-Stockfish into engines/fairy/.")
    # Hidden: for tests with a local file.
    parser.add_argument("--dest", default=str(ROOT / "engines"), help=argparse.SUPPRESS)
    parser.add_argument("--url", default=BUILD_URL, help=argparse.SUPPRESS)
    parser.add_argument("--sha256", default=BUILD_SHA256, help=argparse.SUPPRESS)
    parser.add_argument(
        "--platform", choices=("windows", "other"), default="windows" if sys.platform == "win32" else "other", help=argparse.SUPPRESS
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.platform != "windows":
        print(
            "Fairy-Stockfish is only downloaded on Windows. On this system, build it from\n"
            "https://github.com/fairy-stockfish/Fairy-Stockfish and start the app with FAIRY_PATH set to the executable."
        )
        return 0
    target = Path(args.dest) / "fairy" / "fairy-stockfish.exe"
    if target.is_file() and sha256_of(target) == args.sha256:
        print(f"Fairy-Stockfish ({VERSION}): already installed in {target.parent}")
        return 0
    print(f"Fairy-Stockfish ({VERSION}) -> {target.parent}")
    try:
        download(args.url, target, args.sha256)
    except InstallError as exc:
        print(f"\nERROR: {exc}", file=sys.stderr)
        return 1
    except PermissionError as exc:
        print(f"\nERROR: {exc}\nClose Gambiteer and run this again.", file=sys.stderr)
        return 1
    print("\nDone. Restart Gambiteer to play the variants. To test the engine now: python tools\\check_fairy.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

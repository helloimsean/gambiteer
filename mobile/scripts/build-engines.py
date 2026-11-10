#!/usr/bin/env python3
"""Cross-compile the chess engines for Android arm64 and collect the Maia networks.

    python scripts/build-engines.py [stockfish] [fairy] [lc0] [maia]     (no arguments: all)
    python scripts/build-engines.py stockfish --baseline     for the emulator, see below

The emulator's ARM translation cannot run the dot-product instructions Stockfish is built with for
phones, so testing there needs a --baseline build. Always rebuild without it for the real APK.

The versions match what the desktop app uses (Stockfish 19, and the pins in tools/install_fairy.py
and tools/install_maia.py). Fairy-Stockfish and lc0 publish no current Android build. Stockfish does,
but it is a fixed-address static executable that could not be tested on the emulator's ARM
translation, so it is compiled here the same way as the other two. Compiling happens in %LOCALAPPDATA%\\Android\\build
because the NDK tools do not cope with the apostrophe in this folder's name. Results go to
android/app/src/main/jniLibs/arm64-v8a/lib{stockfish,fairy,lc0}.so and third_party/maia/.
"""
from __future__ import annotations

import concurrent.futures
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import venv
from pathlib import Path

NDK_VERSION = "29.0.14206865"
API = 33
TRIPLE = f"aarch64-linux-android{API}"

STOCKFISH_TAG = "sf_19"
STOCKFISH_SHA256 = "519b653d0d1ffb96531d982ccbe5c6a19425e8388e0e3c2f70f34b424ab32d76"
FAIRY_TAG = "fairy_sf_14"
FAIRY_SHA256 = "db5e96cf47faf4bfd4a500f58ae86e46fee92c2f5544e78750fc01ad098cbad2"
LC0_TAG = "v0.32.1"
LC0_SHA256 = "78b17e8e8d29da30492c86fdac69c519816f4a9d9c3b787dc41a6f9e8d20fde3"
LCZERO_COMMON = "b326b154221a6eb91977bdccf11d6f89e8547875"  # the submodule commit of lc0 v0.32.1

MOBILE = Path(__file__).resolve().parents[1]
REPO = MOBILE.parent
JNI = MOBILE / "android" / "app" / "src" / "main" / "jniLibs" / "arm64-v8a"
ANDROID_HOME = Path(os.environ["LOCALAPPDATA"]) / "Android"
NDK_BIN = ANDROID_HOME / "Sdk" / "ndk" / NDK_VERSION / "toolchains" / "llvm" / "prebuilt" / "windows-x86_64" / "bin"
WORK = ANDROID_HOME / "build"
PAGE_SIZE_FLAG = "-Wl,-z,max-page-size=16384"
BASELINE_MARKER = MOBILE / "third_party" / "stockfish-baseline.marker"  # build-apk.py reads this


def fetch(url: str, target: Path, sha256: str | None) -> None:
    if not target.is_file():
        print(f"downloading {url}", flush=True)
        with urllib.request.urlopen(url, timeout=120) as response, target.open("wb") as out:
            shutil.copyfileobj(response, out, 1 << 20)
    if sha256 is not None:
        actual = hashlib.sha256(target.read_bytes()).hexdigest()
        if actual != sha256:
            target.unlink()
            raise SystemExit(f"{target.name}: SHA-256 mismatch (got {actual})")


def unpack(archive: Path, into: Path, marker: str) -> Path:
    tops = sorted(p for p in into.iterdir() if p.is_dir() and (p / marker).exists())
    if tops:
        return tops[0]
    with tarfile.open(archive) as tar:
        tar.extractall(into, filter="data")
    return next(p for p in into.iterdir() if p.is_dir() and (p / marker).exists())


def strip_to(source: Path, name: str) -> None:
    JNI.mkdir(parents=True, exist_ok=True)
    target = JNI / name
    subprocess.run([str(NDK_BIN / "llvm-strip.exe"), "--strip-unneeded", "-o", str(target), str(source)], check=True)
    print(f"installed {target.name} ({target.stat().st_size / 1e6:.1f} MB)")


def build_stockfish(baseline: bool = False) -> None:
    work = WORK / "stockfish"
    work.mkdir(parents=True, exist_ok=True)
    archive = work / "s.tgz"
    fetch(f"https://github.com/official-stockfish/Stockfish/archive/refs/tags/{STOCKFISH_TAG}.tar.gz", archive, STOCKFISH_SHA256)
    src = unpack(archive, work, "src") / "src"

    header = (src / "evaluate.h").read_text(encoding="utf-8")
    net = re.search(r"nn-([0-9a-f]{12})\.nnue", header)
    if net is None:
        raise SystemExit("no network name in evaluate.h")
    net_file = src / net.group(0)
    if not net_file.is_file():
        fetch(f"https://github.com/official-stockfish/networks/raw/master/{net.group(0)}", net_file, None)
    if hashlib.sha256(net_file.read_bytes()).hexdigest()[:12] != net.group(1):
        net_file.unlink()
        raise SystemExit(f"{net.group(0)} does not match the hash in its name")

    # The flags are the Makefile's for ARCH=armv8-dotprod COMP=ndk. Every phone from the last several
    # years, the S26 Ultra included, has the dot-product instructions.
    sources = (
        "attacks benchmark bitboard evaluate main misc movegen movepick position search thread timeman tt uci "
        "ucioption tune syzygy/tbprobe nnue/nnue_accumulator nnue/nnue_misc nnue/network "
        "nnue/features/half_ka_v2_hm nnue/features/full_threats nnue/features/pp_3wide engine score memory"
    ).split()
    objects = work / ("obj-baseline" if baseline else "obj")
    objects.mkdir(exist_ok=True)
    clang = str(NDK_BIN / "clang++.exe")
    arch = [] if baseline else ["-march=armv8.2-a+dotprod"]
    flags = [
        f"--target={TRIPLE}", "-std=c++17", "-O3", "-funroll-loops", "-flto=full", "-fPIE", "-fno-exceptions",
        "-stdlib=libc++", "-w", "-DNDEBUG", "-DUSE_PTHREADS", "-DIS_64BIT", "-DUSE_POPCNT", "-DUSE_NEON=8",
        *arch, *([] if baseline else ["-DUSE_NEON_DOTPROD"]),
        f"-DARCH={'armv8' if baseline else 'armv8-dotprod'}", "-I.",
    ]

    def compile_one(stem: str) -> Path:
        output = objects / (stem.replace("/", "_") + ".o")
        # Run from src: the network is embedded with a path relative to the working directory.
        subprocess.run([clang, *flags, "-c", f"{stem}.cpp", "-o", str(output)], cwd=src, check=True)
        return output

    with concurrent.futures.ThreadPoolExecutor(max_workers=os.cpu_count()) as pool:
        built = list(pool.map(compile_one, sources))
    binary = work / "stockfish"
    subprocess.run(
        [clang, f"--target={TRIPLE}", "-O3", "-flto=full", *arch, "-static-libstdc++", "-pie",
         PAGE_SIZE_FLAG, *map(str, built), "-lm", "-latomic", "-o", str(binary)],
        cwd=src,  # link-time optimization embeds the network, so it also needs the relative path
        check=True,
    )
    strip_to(binary, "libstockfish.so")
    BASELINE_MARKER.unlink(missing_ok=True)
    if baseline:
        BASELINE_MARKER.write_text("libstockfish.so is the emulator-only build\n", encoding="utf-8")


def build_fairy() -> None:
    work = WORK / "fairy"
    work.mkdir(parents=True, exist_ok=True)
    archive = work / "f.tgz"
    fetch(f"https://github.com/fairy-stockfish/Fairy-Stockfish/archive/refs/tags/{FAIRY_TAG}.tar.gz", archive, FAIRY_SHA256)
    src = unpack(archive, work, "src") / "src"
    # The source list and flags are the Makefile's for ARCH=armv8 COMP=ndk nnue=no. Its detection
    # logic relies on Unix tools and misidentifies a Windows host, so the compiler is run directly.
    sources = (
        "benchmark bitbase bitboard endgame evaluate main material misc movegen movepick pawns position psqt search "
        "thread timeman tt uci ucioption tune syzygy/tbprobe nnue/evaluate_nnue nnue/features/half_ka_v2 "
        "partner parser piece variant xboard nnue/features/half_ka_v2_variants"
    ).split()
    objects = work / "obj"
    objects.mkdir(exist_ok=True)
    clang = str(NDK_BIN / "clang++.exe")
    flags = [
        f"--target={TRIPLE}", "-std=c++17", "-O3", "-fPIE", "-fno-exceptions", "-stdlib=libc++", "-w",
        "-DNDEBUG", "-DUSE_PTHREADS", "-DIS_64BIT", "-DUSE_POPCNT", "-DUSE_NEON", "-DNNUE_EMBEDDING_OFF",
        f"-I{src}",
    ]

    def compile_one(stem: str) -> Path:
        output = objects / (stem.replace("/", "_") + ".o")
        subprocess.run([clang, *flags, "-c", str(src / f"{stem}.cpp"), "-o", str(output)], check=True)
        return output

    with concurrent.futures.ThreadPoolExecutor(max_workers=os.cpu_count()) as pool:
        built = list(pool.map(compile_one, sources))
    binary = work / "fairy-stockfish"
    subprocess.run(
        [clang, f"--target={TRIPLE}", "-static-libstdc++", "-pie", PAGE_SIZE_FLAG, *map(str, built), "-lm", "-latomic", "-o", str(binary)],
        check=True,
    )
    strip_to(binary, "libfairy.so")


def build_lc0() -> None:
    work = WORK / "lc0"
    work.mkdir(parents=True, exist_ok=True)
    archive = work / "l.tgz"
    fetch(f"https://github.com/LeelaChessZero/lc0/archive/refs/tags/{LC0_TAG}.tar.gz", archive, LC0_SHA256)
    source = unpack(archive, work, "meson.build")

    common = source / "libs" / "lczero-common"
    if not (common / "proto").is_dir():
        tgz = work / "lczero-common.tgz"
        fetch(f"https://github.com/LeelaChessZero/lczero-common/archive/{LCZERO_COMMON}.tar.gz", tgz, None)
        with tarfile.open(tgz) as tar:
            tar.extractall(work / "common-x", filter="data")
        unpacked = next((work / "common-x").iterdir())
        shutil.rmtree(common, ignore_errors=True)
        shutil.move(str(unpacked), str(common))

    tools = work / "venv"
    if not (tools / "Scripts" / "meson.exe").is_file():
        venv.create(tools, with_pip=True)
        subprocess.run([str(tools / "Scripts" / "python.exe"), "-m", "pip", "install", "-q", "meson", "ninja"], check=True)

    bin_dir = NDK_BIN.as_posix()
    cross = work / "android.ini"
    cross.write_text(
        f"""[host_machine]
system = 'android'
cpu_family = 'aarch64'
cpu = 'aarch64'
endian = 'little'

[binaries]
c = ['{bin_dir}/clang.exe', '--target={TRIPLE}']
cpp = ['{bin_dir}/clang++.exe', '--target={TRIPLE}']
ar = '{bin_dir}/llvm-ar.exe'
strip = '{bin_dir}/llvm-strip.exe'
ranlib = '{bin_dir}/llvm-ranlib.exe'

[built-in options]
c_args = ['-fPIE']
cpp_args = ['-fPIE']
c_link_args = ['-pie', '-llog', '{PAGE_SIZE_FLAG}']
cpp_link_args = ['-pie', '-llog', '-static-libstdc++', '{PAGE_SIZE_FLAG}']
""",
        encoding="utf-8",
    )
    build = work / "out"
    env = dict(os.environ)
    env["PATH"] = str(tools / "Scripts") + os.pathsep + env["PATH"]
    if not (build / "build.ninja").is_file():
        subprocess.run(
            [
                str(tools / "Scripts" / "meson.exe"), "setup", str(build), str(source),
                "--cross-file", str(cross), "--buildtype=release", "-Db_lto=false", "-Db_vscrt=none",
                "-Ddefault_library=static", "-Dnative_arch=false", "-Dgtest=false", "-Dembed=false",
                "-Dblas=true", "-Dopenblas=false", "-Dmkl=false", "-Ddnnl=false", "-Daccelerate=false",
                "-Dispc=false", "-Dplain_cuda=false", "-Dopencl=false", "-Dmetal=disabled", "-Dneon=false",
                "-Dpopcnt=false", "-Df16c=false", "-Dpext=false", "-Drescorer=false",
            ],
            env=env,
            check=True,
        )
    subprocess.run([str(tools / "Scripts" / "ninja.exe"), "-C", str(build), "lc0"], env=env, check=True)
    strip_to(build / "lc0", "liblc0.so")


def collect_maia() -> None:
    source = REPO / "engines" / "maia"
    target = MOBILE / "third_party" / "maia"
    target.mkdir(parents=True, exist_ok=True)
    nets = sorted(source.glob("maia-*.pb.gz"))
    if len(nets) != 9:
        raise SystemExit(f"expected 9 Maia nets in {source}, found {len(nets)} (run tools/install_maia.py first)")
    for net in nets:
        shutil.copy2(net, target / net.name)
    print(f"copied {len(nets)} Maia nets")


def main() -> int:
    steps = {"stockfish": build_stockfish, "fairy": build_fairy, "lc0": build_lc0, "maia": collect_maia}
    arguments = sys.argv[1:]
    baseline = "--baseline" in arguments
    for name in [a for a in arguments if a != "--baseline"] or list(steps):
        print(f"== {name} ==", flush=True)
        if name == "stockfish":
            build_stockfish(baseline)
        else:
            steps[name]()
    return 0


if __name__ == "__main__":
    sys.exit(main())

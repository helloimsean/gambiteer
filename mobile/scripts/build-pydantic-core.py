#!/usr/bin/env python3
"""Compile pydantic-core for Android arm64 and pack it as a wheel Chaquopy can install.

PyPI publishes no Android wheels for pydantic-core and Chaquopy's index has none either, so the
wheel is built from the official source release with Rust and the Android NDK.

    python scripts/build-pydantic-core.py

Output: third_party/wheels/pydantic_core-<version>-cp314-cp314-android_24_arm64_v8a.whl
Compiling happens in %LOCALAPPDATA%\\Android\\build because cargo and the NDK clang wrappers do not
cope with the apostrophe and parentheses in this folder's name.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

VERSION = "2.46.5"  # must match the pydantic pin in android/app/requirements.txt
PYTHON_MINOR = "3.14"
CHAQUOPY_TARGET = "3.14.8-0"
ABI = "arm64-v8a"
RUST_TARGET = "aarch64-linux-android"
ANDROID_API = 24
NDK_VERSION = "29.0.14206865"

MOBILE = Path(__file__).resolve().parents[1]
ANDROID_HOME = Path(os.environ["LOCALAPPDATA"]) / "Android"
NDK_BIN = ANDROID_HOME / "Sdk" / "ndk" / NDK_VERSION / "toolchains" / "llvm" / "prebuilt" / "windows-x86_64" / "bin"
RUST = ANDROID_HOME / "rust"
WORK = ANDROID_HOME / "build" / "pydantic-core"
WHEELS = MOBILE / "third_party" / "wheels"


def download(url: str, target: Path, sha256: str | None = None) -> None:
    if not target.is_file():
        print(f"downloading {url}", flush=True)
        part = target.with_suffix(target.suffix + ".part")
        with urllib.request.urlopen(url, timeout=120) as response, part.open("wb") as out:
            shutil.copyfileobj(response, out, 1 << 20)
        part.replace(target)
    if sha256 is not None:
        actual = hashlib.sha256(target.read_bytes()).hexdigest()
        if actual != sha256:
            target.unlink()
            raise SystemExit(f"{target.name}: SHA-256 mismatch (got {actual}, expected {sha256})")


def sdist_info() -> tuple[str, str]:
    with urllib.request.urlopen(f"https://pypi.org/pypi/pydantic-core/{VERSION}/json", timeout=60) as response:
        data = json.load(response)
    for entry in data["urls"]:
        if entry["packagetype"] == "sdist":
            return entry["url"], entry["digests"]["sha256"]
    raise SystemExit("no sdist on PyPI")


def prepare_source() -> Path:
    url, digest = sdist_info()
    WORK.mkdir(parents=True, exist_ok=True)
    archive = WORK / f"pydantic_core-{VERSION}.tar.gz"
    download(url, archive, digest)
    source = WORK / f"pydantic_core-{VERSION}"
    if not (source / "Cargo.toml").is_file():
        with tarfile.open(archive) as tar:
            tar.extractall(WORK, filter="data")
    return source


def libpython_dir() -> Path:
    """libpython from Chaquopy's own Python build: Android extension modules must link against it."""
    out = WORK / f"libpython-{CHAQUOPY_TARGET}"
    so = out / f"libpython{PYTHON_MINOR}.so"
    if so.is_file():
        return out
    base = "https://repo1.maven.org/maven2/com/chaquo/python/target"
    name = f"target-{CHAQUOPY_TARGET}-{ABI}.zip"
    archive = WORK / name
    download(f"{base}/{CHAQUOPY_TARGET}/{name}", archive)
    out.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as z:
        members = [n for n in z.namelist() if n.endswith(f"libpython{PYTHON_MINOR}.so")]
        if not members:
            raise SystemExit(f"libpython{PYTHON_MINOR}.so is not in {name}: {z.namelist()[:30]}")
        so.write_bytes(z.read(members[0]))
    return out


def build(source: Path, lib_dir: Path) -> Path:
    clang = NDK_BIN / f"{RUST_TARGET}{ANDROID_API}-clang.cmd"
    if not clang.is_file():
        raise SystemExit(f"NDK clang not found at {clang}")
    config = WORK / "pyo3-config.txt"
    config.write_text(
        "\n".join(
            [
                "implementation=CPython",
                f"version={PYTHON_MINOR}",
                "shared=true",
                "abi3=false",
                f"lib_name=python{PYTHON_MINOR}",
                f"lib_dir={lib_dir.as_posix()}",
                "pointer_width=64",
                "build_flags=",
                "suppress_build_script_link_lines=false",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    target_upper = RUST_TARGET.upper().replace("-", "_")
    target_lower = RUST_TARGET.replace("-", "_")
    env = dict(os.environ)
    env.update(
        {
            "CARGO_HOME": str(RUST / "cargo"),
            "RUSTUP_HOME": str(RUST / "rustup"),
            "PATH": str(RUST / "cargo" / "bin") + os.pathsep + env["PATH"],
            "PYO3_CONFIG_FILE": str(config),
            "PYTHON": sys.executable,
            f"CARGO_TARGET_{target_upper}_LINKER": str(clang),
            f"CC_{target_lower}": str(clang),
            f"AR_{target_lower}": str(NDK_BIN / "llvm-ar.exe"),
            "CARGO_PROFILE_RELEASE_LTO": "thin",
            "CARGO_PROFILE_RELEASE_CODEGEN_UNITS": "16",
            "CARGO_PROFILE_RELEASE_STRIP": "none",
        }
    )
    subprocess.run(
        ["cargo", "build", "--release", "--target", RUST_TARGET, "--features", "pyo3/extension-module"],
        cwd=source,
        env=env,
        check=True,
    )
    built = source / "target" / RUST_TARGET / "release" / "lib_pydantic_core.so"
    if not built.is_file():
        raise SystemExit(f"cargo finished but {built} is missing")
    stripped = WORK / "_pydantic_core.so"
    subprocess.run([str(NDK_BIN / "llvm-strip.exe"), "--strip-unneeded", "-o", str(stripped), str(built)], check=True)
    return stripped


def record_line(name: str, data: bytes) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
    return f"{name},sha256={digest},{len(data)}"


def pack(source: Path, extension: Path) -> Path:
    tag = f"cp{PYTHON_MINOR.replace('.', '')}"
    platform = f"android_{ANDROID_API}_{ABI.replace('-', '_')}"
    name = f"pydantic_core-{VERSION}-{tag}-{tag}-{platform}.whl"
    WHEELS.mkdir(parents=True, exist_ok=True)
    target = WHEELS / name

    pyproject = (source / "pyproject.toml").read_text(encoding="utf-8")
    block = re.search(r"dependencies\s*=\s*\[(.*?)\]", pyproject, re.S)
    requires = re.findall(r"['\"]([^'\"]+)['\"]", block.group(1)) if block else []

    dist_info = f"pydantic_core-{VERSION}.dist-info"
    files: dict[str, bytes] = {}
    package = source / "python" / "pydantic_core"
    for path in sorted(package.rglob("*")):
        if path.is_file() and path.suffix in (".py", ".pyi", ".typed") or path.name == "py.typed":
            files[f"pydantic_core/{path.relative_to(package).as_posix()}"] = path.read_bytes()
    files[f"pydantic_core/_pydantic_core.cpython-{tag[2:]}-aarch64-linux-android.so"] = extension.read_bytes()
    metadata = [f"Metadata-Version: 2.1", "Name: pydantic-core", f"Version: {VERSION}"]
    metadata += [f"Requires-Dist: {r}" for r in requires]
    files[f"{dist_info}/METADATA"] = ("\n".join(metadata) + "\n").encode()
    files[f"{dist_info}/WHEEL"] = (
        "Wheel-Version: 1.0\nGenerator: gambiteer-mobile\nRoot-Is-Purelib: false\n"
        f"Tag: {tag}-{tag}-{platform}\n"
    ).encode()
    record = [record_line(n, d) for n, d in files.items()] + [f"{dist_info}/RECORD,,"]
    files[f"{dist_info}/RECORD"] = ("\n".join(record) + "\n").encode()

    with tempfile.NamedTemporaryFile(dir=WHEELS, suffix=".part", delete=False) as handle:
        part = Path(handle.name)
    with zipfile.ZipFile(part, "w", zipfile.ZIP_DEFLATED) as z:
        for member, data in files.items():
            z.writestr(member, data)
    part.replace(target)
    return target


def main() -> int:
    source = prepare_source()
    lib_dir = libpython_dir()
    extension = build(source, lib_dir)
    wheel = pack(source, extension)
    print(f"built {wheel} ({wheel.stat().st_size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

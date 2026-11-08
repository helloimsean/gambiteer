#!/usr/bin/env python3
r"""Download what the Maia bot needs: the 9 Maia nets and the lc0 engine that runs them.

    python tools\install_maia.py                  (the default lc0 build, openblas)
    python tools\install_maia.py --build dnnl

Files land in engines\maia\ and engines\lc0\ (both git-ignored). Every download is checked against
the SHA-256 digests pinned below, and valid files are skipped, so it is safe to run this again.

Only the standard library is used, and this script never starts lc0. To try the engine after
installing, run tools\check_maia.py. On other systems the nets are downloaded, but lc0 has to be
built by hand and pointed at with LC0_PATH.
"""
from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
import shutil
import sys
import tempfile
import urllib.request
import zipfile
from collections.abc import Mapping
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]

LC0_VERSION = "v0.32.1"
LC0_BASE_URL = f"https://github.com/LeelaChessZero/lc0/releases/download/{LC0_VERSION}"
NETS_BASE_URL = "https://github.com/CSSLab/maia-chess/releases/download/v1.0"

LC0_ARCHIVES = {
    "openblas": f"lc0-{LC0_VERSION}-windows-cpu-openblas.zip",
    "dnnl": f"lc0-{LC0_VERSION}-windows-cpu-dnnl.zip",
}
LC0_DIGESTS = {
    "openblas": "b2caa8443f0e0cb15cf76c335c53985f2973cd6438e77d3e2366cd21d2effa38",
    "dnnl": "b9cfcfbd3dabffbfd452f6e8e087c22273721bef48eba19640b6d92006c142f5",
}
NET_DIGESTS = {
    "1100": "e1cf1cd0c96b8a4fa6a275f4b9fd54ed1ffebf9fe44641b9fceded310e9619c4",
    "1200": "ead4ba953f233ae732999ebc1e2b675378148527ebcfad2f0acbc5e4c224d98e",
    "1300": "36195f87bf4761834baa0bf87472b18509a7261a9d7d6f1a8443261369a733f2",
    "1400": "d5353ea6766356dad2d28920c6692f37a5f30963767f1a3105d33b4d0af011e8",
    "1500": "35ab6f20421d59e1df3b17c5a5016947af4c6761368ef84044a9a9c7619a9a00",
    "1600": "d2c9e5948581acf4b9fc0b1e720c5dc0fe64ce80cfc4a239d3f8a42e1176c876",
    "1700": "d277eacd792d340a30abb464dc65127254e65cac57abca17facc469889b96478",
    "1800": "0031ad7c4256b1fd09fbebd28418d644d68b26cd2a45df4967ccf5c7ec9c4965",
    "1900": "e2f565f42d7cd9f122557e6dc4eb84e5bbaedceda1d404dc485d3611c7c97a12",
}

MANIFEST = "install-manifest.json"  # records the installed lc0 build and its files
CHUNK_SIZE = 1 << 16
TIMEOUT_S = 60


class InstallError(Exception):
    """The install failed. The message tells the user what happened."""


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(CHUNK_SIZE):
            digest.update(chunk)
    return digest.hexdigest()


def download(url: str, target: Path, expected: str) -> None:
    """Download to a .part file, verify it, then move it into place."""
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_name(target.name + ".part")
    digest = hashlib.sha256()
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT_S) as response, part.open("wb") as out:
            while chunk := response.read(CHUNK_SIZE):
                digest.update(chunk)
                out.write(chunk)
    except (OSError, http.client.HTTPException) as exc:  # URLError is an OSError
        part.unlink(missing_ok=True)
        raise InstallError(f"could not download {url}: {exc}\nCheck your internet connection and run this again.") from exc
    if digest.hexdigest() != expected:
        part.unlink(missing_ok=True)
        raise InstallError(
            f"{url} does not match its pinned SHA-256 digest, so it was not installed.\n"
            f"  expected {expected}\n  got      {digest.hexdigest()}"
        )
    os.replace(part, target)


def install_nets(dest: Path, base_url: str, digests: Mapping[str, str]) -> None:
    maia_dir = dest / "maia"
    print(f"Maia nets -> {maia_dir}")
    for rating, digest in digests.items():
        name = f"maia-{rating}.pb.gz"
        target = maia_dir / name
        if target.is_file() and sha256_of(target) == digest:
            print(f"  {name}: already installed")
            continue
        print(f"  {name}: downloading")
        download(f"{base_url}/{name}", target, digest)


def is_wanted(name: str) -> bool:
    """lc0, its DLLs and their licenses. Not the bundled 18 MB network."""
    lower = name.lower()
    return lower in ("lc0.exe", "copying") or lower.endswith(".dll") or "license" in lower or "third-party" in lower


def refuse_unsafe_path(name: str) -> None:
    normal = name.replace("\\", "/")
    if normal.startswith("/") or ":" in normal or ".." in normal.split("/"):
        raise InstallError(f"the archive contains an unsafe path, so nothing was installed: {name!r}")


def extract_wanted(archive_path: Path, staging: Path) -> dict[str, str]:
    """Extract the wanted files flat into ``staging``; returns {file name: SHA-256}."""
    try:
        with zipfile.ZipFile(archive_path) as archive:
            members = [member for member in archive.infolist() if not member.is_dir()]
            for member in members:  # the whole archive is checked before anything is written
                refuse_unsafe_path(member.filename)
            chosen: dict[str, zipfile.ZipInfo] = {}
            for member in members:
                name = PurePosixPath(member.filename.replace("\\", "/")).name
                if not is_wanted(name):
                    continue
                if name in chosen:
                    raise InstallError(f"the archive contains {name!r} twice, so nothing was installed")
                chosen[name] = member
            if "lc0.exe" not in chosen:
                raise InstallError("the archive does not contain lc0.exe")
            files: dict[str, str] = {}
            for name, member in chosen.items():
                target = staging / name
                with archive.open(member) as source, target.open("wb") as out:
                    shutil.copyfileobj(source, out)
                files[name] = sha256_of(target)
    except zipfile.BadZipFile as exc:
        raise InstallError(f"the lc0 archive is not a valid zip file: {exc}") from exc
    return files


def read_manifest(lc0_dir: Path) -> dict[str, object]:
    try:
        manifest = json.loads((lc0_dir / MANIFEST).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return manifest if isinstance(manifest, dict) else {}


def manifest_files(manifest: Mapping[str, object]) -> dict[str, str]:
    files = manifest.get("files")
    return {str(name): str(digest) for name, digest in files.items()} if isinstance(files, dict) else {}


def lc0_is_installed(lc0_dir: Path, build: str, archive_digest: str) -> bool:
    manifest = read_manifest(lc0_dir)
    files = manifest_files(manifest)
    if manifest.get("build") != build or manifest.get("archive_sha256") != archive_digest or "lc0.exe" not in files:
        return False
    return all((lc0_dir / name).is_file() and sha256_of(lc0_dir / name) == digest for name, digest in files.items())


def install_lc0(dest: Path, build: str, base_url: str, digests: Mapping[str, str]) -> None:
    lc0_dir = dest / "lc0"
    archive_name = LC0_ARCHIVES[build]
    archive_digest = digests[build]
    if lc0_is_installed(lc0_dir, build, archive_digest):
        print(f"lc0 {LC0_VERSION} ({build}): already installed in {lc0_dir}")
        return
    print(f"lc0 {LC0_VERSION} ({build}) -> {lc0_dir}")
    print(f"  {archive_name}: downloading")
    dest.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=dest, prefix=".install-lc0-") as tmp:
        archive_path = Path(tmp) / archive_name
        download(f"{base_url}/{archive_name}", archive_path, archive_digest)
        staging = Path(tmp) / "staging"
        staging.mkdir()
        files = extract_wanted(archive_path, staging)
        previous = manifest_files(read_manifest(lc0_dir))
        lc0_dir.mkdir(parents=True, exist_ok=True)
        try:
            for name in files:
                os.replace(staging / name, lc0_dir / name)
            for name in previous.keys() - files.keys():  # files of a build that was replaced
                if Path(name).name == name:
                    (lc0_dir / name).unlink(missing_ok=True)
        except PermissionError as exc:
            raise InstallError(f"could not replace a file in {lc0_dir} ({exc}). Close Gambiteer and run this again.") from exc
    manifest = {"version": LC0_VERSION, "build": build, "archive_sha256": archive_digest, "files": files}
    (lc0_dir / MANIFEST).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"  installed: {', '.join(sorted(files))}")


def load_digests(path: str | None) -> tuple[dict[str, str], dict[str, str]]:
    """The pinned digests, or the ones in a JSON file (only for testing with local archives)."""
    if path is None:
        return dict(LC0_DIGESTS), dict(NET_DIGESTS)
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return dict(data["lc0"]), dict(data["nets"])


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download the Maia nets and the lc0 engine into engines/.")
    parser.add_argument("--build", choices=sorted(LC0_ARCHIVES), default="openblas", help="lc0 CPU build (default: openblas)")
    # Hidden: for tests with local archives.
    parser.add_argument("--dest", default=str(ROOT / "engines"), help=argparse.SUPPRESS)
    parser.add_argument("--lc0-url", default=LC0_BASE_URL, help=argparse.SUPPRESS)
    parser.add_argument("--nets-url", default=NETS_BASE_URL, help=argparse.SUPPRESS)
    parser.add_argument("--checksums", default=None, help=argparse.SUPPRESS)
    parser.add_argument(
        "--platform", choices=("windows", "other"), default="windows" if sys.platform == "win32" else "other", help=argparse.SUPPRESS
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    dest = Path(args.dest)
    lc0_digests, net_digests = load_digests(args.checksums)
    try:
        install_nets(dest, args.nets_url, net_digests)
        if args.platform == "windows":
            install_lc0(dest, args.build, args.lc0_url, lc0_digests)
        else:
            print(
                "\nlc0 is only downloaded on Windows. On this system, build it from\n"
                "https://github.com/LeelaChessZero/lc0 and start the app with LC0_PATH set to the lc0 executable."
            )
    except InstallError as exc:
        print(f"\nERROR: {exc}", file=sys.stderr)
        return 1
    except PermissionError as exc:
        print(f"\nERROR: {exc}\nClose Gambiteer and run this again.", file=sys.stderr)
        return 1
    print("\nDone. Restart Gambiteer to play Maia. To test the engine now: python tools\\check_maia.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

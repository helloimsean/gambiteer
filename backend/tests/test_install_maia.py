"""tools/install_maia.py, tested only with local fake archives in a temp folder.

Nothing is downloaded from the internet and no lc0 is started: the "lc0.exe" here is a few bytes.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import zipfile
from dataclasses import dataclass
from pathlib import Path

import pytest

from app.config import ROOT_DIR

INSTALLER = ROOT_DIR / "tools" / "install_maia.py"
RATINGS = ("1100", "1500", "1900")
OPENBLAS_ZIP = "lc0-v0.32.1-windows-cpu-openblas.zip"
DNNL_ZIP = "lc0-v0.32.1-windows-cpu-dnnl.zip"

# The same names as the real release archives.
OPENBLAS_FILES = {
    "791556.pb.gz": b"the bundled network",
    "COPYING": b"gpl text",
    "lc0.exe": b"not really an executable (openblas)",
    "libopenblas.dll": b"blas",
    "mimalloc-LICENSE": b"mit text",
    "mimalloc-override.dll": b"override",
    "mimalloc-readme.md": b"readme",
    "mimalloc-redirect.dll": b"redirect",
}
DNNL_FILES = {
    "791556.pb.gz": b"the bundled network",
    "COPYING": b"gpl text",
    "DNNL-LICENSE": b"apache text",
    "DNNL-THIRD-PARTY-PROGRAMS": b"third party text",
    "dnnl.dll": b"dnnl",
    "lc0.exe": b"not really an executable (dnnl)",
    "mimalloc-LICENSE": b"mit text",
    "mimalloc-override.dll": b"override",
    "mimalloc-readme.md": b"readme",
    "mimalloc-redirect.dll": b"redirect",
}
EXPECTED_OPENBLAS = {
    "COPYING",
    "lc0.exe",
    "libopenblas.dll",
    "mimalloc-LICENSE",
    "mimalloc-override.dll",
    "mimalloc-redirect.dll",
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def make_zip(path: Path, files: dict[str, bytes]) -> None:
    with zipfile.ZipFile(path, "w") as archive:
        for name, data in files.items():
            archive.writestr(name, data)


@dataclass
class Source:
    lc0_dir: Path
    nets_dir: Path
    checksums: Path
    dest: Path

    def write_checksums(self) -> None:
        data = {
            "lc0": {
                "openblas": sha256(self.lc0_dir / OPENBLAS_ZIP),
                "dnnl": sha256(self.lc0_dir / DNNL_ZIP),
            },
            "nets": {rating: sha256(self.nets_dir / f"maia-{rating}.pb.gz") for rating in RATINGS},
        }
        self.checksums.write_text(json.dumps(data), encoding="utf-8")


@pytest.fixture
def source(tmp_path: Path) -> Source:
    lc0_dir = tmp_path / "source lc0"
    nets_dir = tmp_path / "source nets"
    lc0_dir.mkdir()
    nets_dir.mkdir()
    make_zip(lc0_dir / OPENBLAS_ZIP, OPENBLAS_FILES)
    make_zip(lc0_dir / DNNL_ZIP, DNNL_FILES)
    for rating in RATINGS:
        (nets_dir / f"maia-{rating}.pb.gz").write_bytes(f"net {rating}".encode())
    src = Source(lc0_dir, nets_dir, tmp_path / "checksums.json", tmp_path / "engines")
    src.write_checksums()
    return src


def run_installer(
    source: Source,
    *args: str,
    platform: str = "windows",
    lc0_url: str | None = None,
    nets_url: str | None = None,
) -> subprocess.CompletedProcess[str]:
    command = [
        sys.executable,
        str(INSTALLER),
        "--dest",
        str(source.dest),
        "--lc0-url",
        lc0_url or source.lc0_dir.as_uri(),
        "--nets-url",
        nets_url or source.nets_dir.as_uri(),
        "--checksums",
        str(source.checksums),
        "--platform",
        platform,
        *args,
    ]
    return subprocess.run(command, capture_output=True, text=True, timeout=60, check=False)


def installed_lc0_files(source: Source) -> set[str]:
    return {path.name for path in (source.dest / "lc0").iterdir() if path.name != "install-manifest.json"}


def assert_no_leftovers(source: Source) -> None:
    assert list(source.dest.glob(".install-lc0-*")) == []
    assert list(source.dest.rglob("*.part")) == []


def test_fresh_install_extracts_only_what_is_needed(source: Source) -> None:
    result = run_installer(source)
    assert result.returncode == 0, result.stdout + result.stderr
    assert installed_lc0_files(source) == EXPECTED_OPENBLAS
    assert not (source.dest / "lc0" / "791556.pb.gz").exists()
    assert (source.dest / "lc0" / "lc0.exe").read_bytes() == OPENBLAS_FILES["lc0.exe"]
    for rating in RATINGS:
        assert (source.dest / "maia" / f"maia-{rating}.pb.gz").read_bytes() == f"net {rating}".encode()
    assert_no_leftovers(source)


def test_dnnl_build_keeps_its_license_files(source: Source) -> None:
    assert run_installer(source, "--build", "dnnl").returncode == 0
    assert installed_lc0_files(source) == {
        "COPYING",
        "DNNL-LICENSE",
        "DNNL-THIRD-PARTY-PROGRAMS",
        "dnnl.dll",
        "lc0.exe",
        "mimalloc-LICENSE",
        "mimalloc-override.dll",
        "mimalloc-redirect.dll",
    }


def test_changing_build_removes_the_old_builds_files(source: Source) -> None:
    assert run_installer(source).returncode == 0
    assert run_installer(source, "--build", "dnnl").returncode == 0
    assert "libopenblas.dll" not in installed_lc0_files(source)
    assert (source.dest / "lc0" / "lc0.exe").read_bytes() == DNNL_FILES["lc0.exe"]


def test_running_again_skips_valid_files_without_downloading(source: Source, tmp_path: Path) -> None:
    assert run_installer(source).returncode == 0
    nowhere = (tmp_path / "nothing here").as_uri()
    result = run_installer(source, lc0_url=nowhere, nets_url=nowhere)
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.count("already installed") == len(RATINGS) + 1


def test_a_damaged_net_is_downloaded_again(source: Source) -> None:
    assert run_installer(source).returncode == 0
    damaged = source.dest / "maia" / "maia-1500.pb.gz"
    damaged.write_bytes(b"truncated")
    assert run_installer(source).returncode == 0
    assert damaged.read_bytes() == b"net 1500"


def test_a_damaged_lc0_is_installed_again(source: Source) -> None:
    assert run_installer(source).returncode == 0
    exe = source.dest / "lc0" / "lc0.exe"
    exe.write_bytes(b"damaged")
    assert run_installer(source).returncode == 0
    assert exe.read_bytes() == OPENBLAS_FILES["lc0.exe"]


def test_a_wrong_net_digest_is_refused(source: Source) -> None:
    (source.nets_dir / "maia-1100.pb.gz").write_bytes(b"tampered")
    result = run_installer(source)
    assert result.returncode == 1 and "SHA-256" in result.stderr
    assert not (source.dest / "maia" / "maia-1100.pb.gz").exists()
    assert_no_leftovers(source)


def test_a_wrong_archive_digest_is_refused(source: Source) -> None:
    make_zip(source.lc0_dir / OPENBLAS_ZIP, {**OPENBLAS_FILES, "lc0.exe": b"tampered"})
    result = run_installer(source)
    assert result.returncode == 1 and "SHA-256" in result.stderr
    assert not (source.dest / "lc0").exists()
    assert_no_leftovers(source)


@pytest.mark.parametrize(
    "unsafe",
    ["../evil.dll", "dir/../../evil.dll", "/absolute/evil.dll", "C:/windows/evil.dll", "C:evil.dll", "..\\evil.dll"],
)
def test_unsafe_zip_paths_are_refused(source: Source, tmp_path: Path, unsafe: str) -> None:
    make_zip(source.lc0_dir / OPENBLAS_ZIP, {**OPENBLAS_FILES, unsafe: b"evil"})
    source.write_checksums()
    result = run_installer(source)
    assert result.returncode == 1 and "unsafe path" in result.stderr
    assert not (source.dest / "lc0").exists()
    assert list(tmp_path.rglob("evil.dll")) == []
    assert_no_leftovers(source)


def test_an_archive_without_lc0_is_refused(source: Source) -> None:
    make_zip(source.lc0_dir / OPENBLAS_ZIP, {"COPYING": b"gpl"})
    source.write_checksums()
    result = run_installer(source)
    assert result.returncode == 1 and "lc0.exe" in result.stderr
    assert not (source.dest / "lc0").exists()


def test_a_corrupt_archive_is_refused_with_a_clear_error(source: Source) -> None:
    (source.lc0_dir / OPENBLAS_ZIP).write_bytes(b"this is not a zip file")
    source.write_checksums()
    result = run_installer(source)
    assert result.returncode == 1 and "not a valid zip" in result.stderr


def test_a_failed_download_gives_a_clear_error(source: Source, tmp_path: Path) -> None:
    result = run_installer(source, nets_url=(tmp_path / "no such folder").as_uri())
    assert result.returncode == 1 and "could not download" in result.stderr
    assert_no_leftovers(source)


def test_other_platforms_get_the_nets_and_an_explanation(source: Source) -> None:
    result = run_installer(source, platform="other")
    assert result.returncode == 0, result.stdout + result.stderr
    assert "LC0_PATH" in result.stdout
    assert (source.dest / "maia" / "maia-1100.pb.gz").is_file()
    assert not (source.dest / "lc0").exists()


def test_the_installer_cannot_launch_anything() -> None:
    text = INSTALLER.read_text(encoding="utf-8")
    for forbidden in ("subprocess", "os.system", "os.startfile", "os.exec", "os.spawn", "Popen"):
        assert forbidden not in text


def test_every_rating_is_pinned_and_the_default_destination_is_engines() -> None:
    """Read from the source: running it with the default destination is not allowed in tests."""
    spec_text = INSTALLER.read_text(encoding="utf-8")
    for rating in range(1100, 2000, 100):
        assert f'"{rating}":' in spec_text
    assert 'ROOT / "engines"' in spec_text

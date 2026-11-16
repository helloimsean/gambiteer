"""How much of this machine Stockfish may be given: CPU threads and memory for its hash table."""
from __future__ import annotations

import ctypes
import os
import sys

HASH_MIN_MB = 16
HASH_CAP_MB = 8192  # past this a review at depth 30 or less gains nothing
HASH_UNKNOWN_MB = 1024  # the cap when the system does not say how much memory it has


def cpu_threads() -> int:
    return os.cpu_count() or 1


def total_memory_mb() -> int | None:
    """Physical memory in MB, or None when the system does not say."""
    if sys.platform == "win32":
        return _windows_memory_mb()
    try:
        return os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE") // (1024 * 1024)
    except (AttributeError, OSError, ValueError):
        return None


def _windows_memory_mb() -> int | None:
    class MemoryStatus(ctypes.Structure):
        _fields_ = [
            ("dwLength", ctypes.c_ulong),
            ("dwMemoryLoad", ctypes.c_ulong),
            ("ullTotalPhys", ctypes.c_ulonglong),
            ("ullAvailPhys", ctypes.c_ulonglong),
            ("ullTotalPageFile", ctypes.c_ulonglong),
            ("ullAvailPageFile", ctypes.c_ulonglong),
            ("ullTotalVirtual", ctypes.c_ulonglong),
            ("ullAvailVirtual", ctypes.c_ulonglong),
            ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
        ]

    status = MemoryStatus()
    status.dwLength = ctypes.sizeof(MemoryStatus)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):  # type: ignore[attr-defined]
        return None
    return int(status.ullTotalPhys) // (1024 * 1024)


def max_hash_mb(total_mb: int | None) -> int:
    """The largest hash worth offering: a power of two up to a quarter of the memory."""
    if total_mb is None:
        return HASH_UNKNOWN_MB
    limit = min(HASH_CAP_MB, total_mb // 4)
    size = HASH_MIN_MB
    while size * 2 <= limit:
        size *= 2
    return size

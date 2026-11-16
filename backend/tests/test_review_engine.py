"""Game Review's advanced engine settings: threads, hash and a time limit per move."""
from __future__ import annotations

import time
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.hardware import HASH_CAP_MB, HASH_UNKNOWN_MB, cpu_threads, max_hash_mb, total_memory_mb
from app.main import create_app

from .conftest import needs_stockfish, test_settings

MOVES = ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"]


@pytest.mark.parametrize(
    ("total", "expected"),
    [(None, HASH_UNKNOWN_MB), (100, 16), (8192, 2048), (12_000, 2048), (16_384, 4096), (262_144, HASH_CAP_MB)],
)
def test_max_hash_is_a_power_of_two_up_to_a_quarter_of_memory(total: int | None, expected: int) -> None:
    assert max_hash_mb(total) == expected


def test_this_machine_reports_its_threads_and_memory() -> None:
    assert cpu_threads() >= 1
    memory = total_memory_mb()
    assert memory is None or memory > 256


@pytest.fixture(scope="module")
def client() -> Iterator[TestClient]:
    with TestClient(create_app(test_settings())) as c:
        yield c


def test_health_reports_the_review_engine(client: TestClient) -> None:
    engine = client.get("/api/health").json()["reviewEngine"]
    settings = test_settings()
    assert engine["threads"] == settings.review_threads and engine["hashMb"] == settings.review_hash_mb
    assert engine["maxThreads"] >= engine["threads"] and engine["maxHashMb"] >= engine["hashMb"]


@pytest.mark.parametrize("bad", [{"threads": 0}, {"hashMb": 0}, {"moveTimeMs": 50}, {"moveTimeMs": 700_000}])
def test_out_of_range_settings_are_refused(client: TestClient, bad: dict[str, int]) -> None:
    assert client.post("/api/review", json={"moves": MOVES, "depth": 6, **bad}).status_code == 422


def wait_done(client: TestClient, job_id: str) -> dict:
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        job = client.get(f"/api/review/{job_id}").json()
        if job["status"] in ("done", "error"):
            return job
        time.sleep(0.05)
    raise AssertionError("review did not finish")


@needs_stockfish
def test_a_review_runs_with_its_own_settings_and_hands_them_back(client: TestClient) -> None:
    services = client.app.state.services
    job_id = client.post("/api/review", json={"moves": MOVES, "depth": 6, "threads": 1, "hashMb": 32}).json()["jobId"]
    assert services.reviews.get(job_id).options == {"Threads": 1, "Hash": 32}
    assert wait_done(client, job_id)["status"] == "done"
    # the single-move coach shares the review engine, so it gets the backend's settings back
    config = services.engines._slots["review"].protocol.config
    assert (config["Threads"], config["Hash"]) == (test_settings().review_threads, test_settings().review_hash_mb)


@needs_stockfish
def test_settings_above_this_machine_are_lowered(client: TestClient) -> None:
    limits = client.get("/api/health").json()["reviewEngine"]
    job_id = client.post("/api/review", json={"moves": MOVES, "depth": 4, "threads": 1024, "hashMb": 1_048_576}).json()["jobId"]
    assert client.app.state.services.reviews.get(job_id).options == {"Threads": limits["maxThreads"], "Hash": limits["maxHashMb"]}
    assert wait_done(client, job_id)["status"] == "done"


@needs_stockfish
def test_the_time_limit_stops_deep_searches_early(client: TestClient) -> None:
    started = time.monotonic()
    job = wait_done(client, client.post("/api/review", json={"moves": MOVES, "depth": 30, "moveTimeMs": 100}).json()["jobId"])
    assert job["status"] == "done" and len(job["result"]["moves"]) == len(MOVES)
    assert time.monotonic() - started < 10  # depth 30 on seven positions takes minutes without it

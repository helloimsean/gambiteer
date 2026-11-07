"""EngineManager: a small pool of Stockfish processes driven by python-chess's asyncio API.

Three engines, each started lazily on first use and guarded by its own ``asyncio.Lock``:

* ``analysis``: Threads 4, Hash 512, MultiPV per request (live WebSocket + one-shot analysis)
* ``review``:   Threads 4, Hash 512 (game review jobs)
* ``bot``:      Threads 2, Hash 128 (strength-limited play; UCI_LimitStrength never reaches the
  analysis process because it is a separate process)

Event loops: the manager binds to the running loop in :meth:`EngineManager.start` (called from the
FastAPI lifespan) and normally runs every engine coroutine on that loop. uvicorn's default loop on
Windows is the ProactorEventLoop, which can spawn subprocesses. When the app loop cannot spawn
subprocesses (a SelectorEventLoop on Windows, which is what ``uvicorn --reload`` uses), the
manager falls back to a private ProactorEventLoop on one background thread and proxies every call
to it, so the engines keep working; callers never notice the difference because they only use
:class:`EngineProxy` and :class:`AnalysisStream`.
"""
from __future__ import annotations

import asyncio
import logging
import sys
import threading
from collections.abc import AsyncIterator, Callable, Coroutine, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TypeVar

import chess
import chess.engine

log = logging.getLogger(__name__)

T = TypeVar("T")
ENGINE_NAMES = ("analysis", "review", "bot")
Snapshot = list[dict[str, Any]]  # one python-chess info dict per MultiPV line


class EngineUnavailable(RuntimeError):
    """Stockfish is missing, failed to start, or the manager is shut down."""


def loop_can_spawn_subprocesses(loop: asyncio.AbstractEventLoop) -> bool:
    if sys.platform != "win32":
        return True
    proactor = getattr(asyncio, "ProactorEventLoop", None)
    return proactor is not None and isinstance(loop, proactor)


class _EngineLoopThread:
    """A private ProactorEventLoop running forever on a daemon thread (Windows fallback)."""

    def __init__(self) -> None:
        self.loop: asyncio.AbstractEventLoop = asyncio.ProactorEventLoop()  # type: ignore[attr-defined]
        self._thread = threading.Thread(target=self._main, name="stockfish-loop", daemon=True)
        self._thread.start()

    def _main(self) -> None:
        asyncio.set_event_loop(self.loop)
        try:
            self.loop.run_forever()
        finally:
            try:
                self.loop.run_until_complete(self.loop.shutdown_asyncgens())
            finally:
                self.loop.close()

    def stop(self) -> None:
        if self.loop.is_closed():
            return
        self.loop.call_soon_threadsafe(self.loop.stop)
        self._thread.join(timeout=5)


@dataclass
class _Slot:
    name: str
    options: dict[str, Any]
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    start_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    transport: asyncio.SubprocessTransport | None = None
    protocol: chess.engine.UciProtocol | None = None
    on_preempt: Callable[[], None] | None = None


class EngineManager:
    def __init__(self, path: Path | str, options: Mapping[str, Mapping[str, Any]]) -> None:
        self.path = Path(path)
        self._slots: dict[str, _Slot] = {name: _Slot(name, dict(opts)) for name, opts in options.items()}
        self._app_loop: asyncio.AbstractEventLoop | None = None
        self._engine_loop: asyncio.AbstractEventLoop | None = None
        self._thread: _EngineLoopThread | None = None
        self._streams: set[AnalysisStream] = set()
        self._closed = False
        self._engine_name: str = ""

    @classmethod
    def from_settings(cls, settings: Any) -> "EngineManager":
        return cls(
            settings.stockfish_path,
            {
                "analysis": {"Threads": settings.analysis_threads, "Hash": settings.analysis_hash_mb},
                "review": {"Threads": settings.review_threads, "Hash": settings.review_hash_mb},
                "bot": {"Threads": settings.bot_threads, "Hash": settings.bot_hash_mb},
            },
        )

    # ------------------------------------------------------------------ lifecycle

    async def start(self) -> None:
        """Bind to the running loop. Call from the FastAPI lifespan (never from a thread)."""
        self._bind()

    def _bind(self) -> asyncio.AbstractEventLoop:
        if self._engine_loop is not None:
            return self._engine_loop
        loop = asyncio.get_running_loop()
        self._app_loop = loop
        if loop_can_spawn_subprocesses(loop):
            self._engine_loop = loop
        else:
            log.warning(
                "the running event loop (%s) cannot spawn subprocesses; running Stockfish on a "
                "private ProactorEventLoop thread instead (this happens with uvicorn --reload on Windows)",
                type(loop).__name__,
            )
            self._thread = _EngineLoopThread()
            self._engine_loop = self._thread.loop
        return self._engine_loop

    @property
    def available(self) -> bool:
        return self.path.is_file()

    @property
    def bridged(self) -> bool:
        """True when engines live on the fallback thread instead of the app loop."""
        return self._thread is not None

    @property
    def engine_name(self) -> str:
        """Engine id name (e.g. 'Stockfish 19') once any engine has started, else ''."""
        return self._engine_name

    async def warm_up(self, name: str = "analysis") -> None:
        """Start an engine in the background so the first request does not pay the start-up cost."""
        try:
            await self.get(name)
        except EngineUnavailable as exc:
            log.warning("engine warm-up skipped: %s", exc)

    async def close(self) -> None:
        """Stop live analyses, quit every engine (kill after 3 s), stop the fallback thread."""
        self._closed = True
        for stream in list(self._streams):
            stream.request_stop()
        for stream in list(self._streams):
            try:
                await asyncio.wait_for(stream.wait_closed(), timeout=2)
            except (asyncio.TimeoutError, Exception):  # noqa: BLE001 - shutting down anyway
                pass
        for slot in self._slots.values():
            protocol, transport = slot.protocol, slot.transport
            slot.protocol = slot.transport = None
            if protocol is None:
                continue
            try:
                await asyncio.wait_for(self._run(protocol.quit()), timeout=3)
            except Exception as exc:  # noqa: BLE001
                log.warning("engine %s did not quit cleanly (%s); killing it", slot.name, exc)
                if transport is not None:
                    self._call_soon(transport.close)
        if self._thread is not None:
            await asyncio.sleep(0.05)  # let the kill callbacks run
            self._thread.stop()
            self._thread = None

    # ------------------------------------------------------------------ loop plumbing

    async def _run(self, coro: Coroutine[Any, Any, T]) -> T:
        """Await ``coro`` on the engine loop (directly when that is the current loop)."""
        loop = self._bind()
        if loop is asyncio.get_running_loop():
            return await coro
        return await asyncio.wrap_future(asyncio.run_coroutine_threadsafe(coro, loop))

    def _spawn(self, coro: Coroutine[Any, Any, T]) -> asyncio.Future[T]:
        """Start ``coro`` on the engine loop; returns a future awaitable from the app loop."""
        loop = self._bind()
        if loop is asyncio.get_running_loop():
            return asyncio.ensure_future(coro)
        return asyncio.wrap_future(asyncio.run_coroutine_threadsafe(coro, loop))

    def _call_soon(self, fn: Callable[..., Any], *args: Any) -> None:
        loop = self._engine_loop
        if loop is None or loop.is_closed():
            return
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if loop is running:
            fn(*args)
        else:
            loop.call_soon_threadsafe(fn, *args)

    # ------------------------------------------------------------------ engines

    async def get(self, name: str) -> "EngineProxy":
        """The named engine, started (or restarted after a crash) on demand."""
        slot = self._slots[name]
        async with slot.start_lock:
            proto = slot.protocol
            if proto is None or proto.returncode.done():
                if proto is not None:
                    log.warning("engine %s exited unexpectedly; restarting", name)
                slot.transport, slot.protocol = await self._start_engine(slot)
            assert slot.protocol is not None
            return EngineProxy(self, slot.name, slot.protocol)

    async def _start_engine(self, slot: _Slot) -> tuple[asyncio.SubprocessTransport, chess.engine.UciProtocol]:
        if self._closed:
            raise EngineUnavailable("engine manager is shut down")
        if not self.path.is_file():
            raise EngineUnavailable(f"Stockfish not found at {self.path} (set STOCKFISH_PATH)")
        path = str(self.path)
        options = dict(slot.options)

        async def boot() -> tuple[asyncio.SubprocessTransport, chess.engine.UciProtocol]:
            transport, protocol = await chess.engine.popen_uci(path)
            try:
                supported = {k: v for k, v in options.items() if k in protocol.options}
                if supported:
                    await protocol.configure(supported)
            except BaseException:
                transport.close()
                raise
            return transport, protocol

        try:
            transport, protocol = await self._run(boot())
        except (OSError, NotImplementedError, chess.engine.EngineError) as exc:
            raise EngineUnavailable(f"could not start Stockfish ({type(exc).__name__}: {exc})") from exc
        self._engine_name = protocol.id.get("name", "Stockfish")
        log.info("started engine %s: %s %s", slot.name, self._engine_name, slot.options)
        return transport, protocol

    @asynccontextmanager
    async def use(
        self,
        name: str,
        *,
        preempt: bool = False,
        on_preempt: Callable[[], None] | None = None,
    ) -> AsyncIterator["EngineProxy"]:
        """Hold the engine's lock for the duration of the block.

        ``preempt=True`` asks the current holder to finish early (if it registered
        ``on_preempt``, as live analysis streams do) instead of waiting for it indefinitely.
        """
        slot = self._slots[name]
        if preempt and slot.lock.locked() and slot.on_preempt is not None:
            try:
                slot.on_preempt()
            except Exception:  # noqa: BLE001
                log.exception("preempt callback failed")
        async with slot.lock:
            slot.on_preempt = on_preempt
            try:
                yield await self.get(name)
            finally:
                slot.on_preempt = None

    def lock(self, name: str) -> asyncio.Lock:
        return self._slots[name].lock


class EngineProxy:
    """The python-chess calls the app needs, executed on the engine loop."""

    def __init__(self, manager: EngineManager, name: str, protocol: chess.engine.UciProtocol) -> None:
        self._mgr = manager
        self.slot_name = name
        self._protocol = protocol

    @property
    def id(self) -> dict[str, str]:
        return dict(self._protocol.id)

    @property
    def name(self) -> str:
        return self._protocol.id.get("name", "Stockfish")

    async def configure(self, options: Mapping[str, Any]) -> None:
        supported = {k: v for k, v in options.items() if k in self._protocol.options}
        await self._mgr._run(self._protocol.configure(supported))

    async def analyse(
        self,
        board: chess.Board,
        limit: chess.engine.Limit,
        *,
        multipv: int | None = None,
        info: chess.engine.Info = chess.engine.INFO_ALL,
    ) -> Any:
        return await self._mgr._run(self._protocol.analyse(board.copy(), limit, multipv=multipv, info=info))

    async def play(
        self,
        board: chess.Board,
        limit: chess.engine.Limit,
        *,
        info: chess.engine.Info = chess.engine.INFO_NONE,
    ) -> chess.engine.PlayResult:
        return await self._mgr._run(self._protocol.play(board.copy(), limit, info=info))

    async def analysis_stream(
        self, board: chess.Board, *, multipv: int = 1, limit: chess.engine.Limit | None = None
    ) -> "AnalysisStream":
        stream = AnalysisStream(self._mgr, self._protocol, board, multipv, limit)
        await stream.start()
        return stream


class AnalysisStream:
    """A running (usually infinite) analysis with coalesced snapshots.

    The engine pushes infos as fast as it likes; consumers call :meth:`next` and always get the
    newest aggregated snapshot (a list with one info dict per MultiPV line), so a slow consumer
    never builds up a backlog.
    """

    def __init__(
        self,
        manager: EngineManager,
        protocol: chess.engine.UciProtocol,
        board: chess.Board,
        multipv: int,
        limit: chess.engine.Limit | None,
    ) -> None:
        self._mgr = manager
        self._protocol = protocol
        self.board = board.copy()
        self.multipv = multipv
        self._limit = limit
        self._consumer_loop = asyncio.get_running_loop()
        self._event = asyncio.Event()
        self._latest: Snapshot | None = None
        self._finished = False
        self.error: BaseException | None = None
        self._analysis: chess.engine.AnalysisResult | None = None
        self._pump: asyncio.Future[None] | None = None
        self._stop_requested = False
        self._stop_sent = False

    async def start(self) -> None:
        self._analysis = await self._mgr._run(
            self._protocol.analysis(self.board.copy(), self._limit, multipv=self.multipv)
        )
        self._mgr._streams.add(self)
        self._pump = self._mgr._spawn(self._pump_infos())
        if self._stop_requested:
            self._send_stop()

    async def _pump_infos(self) -> None:
        """Runs on the engine loop: forward aggregated snapshots to the consumer loop."""
        analysis = self._analysis
        assert analysis is not None
        try:
            async for _info in analysis:
                self._to_consumer(self._set_latest, [dict(d) for d in analysis.multipv])
        except Exception as exc:  # noqa: BLE001 - reported to the consumer
            self._to_consumer(self._set_error, exc)
        finally:
            self._to_consumer(self._set_finished)

    def _to_consumer(self, fn: Callable[..., None], *args: Any) -> None:
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is self._consumer_loop:
            fn(*args)
            return
        try:
            self._consumer_loop.call_soon_threadsafe(fn, *args)
        except RuntimeError:  # consumer loop already closed
            pass

    def _set_latest(self, snapshot: Snapshot) -> None:
        self._latest = snapshot
        self._event.set()

    def _set_error(self, exc: BaseException) -> None:
        self.error = exc
        self._event.set()

    def _set_finished(self) -> None:
        self._finished = True
        self._mgr._streams.discard(self)
        self._event.set()

    # ---------------------------------------------------------------- consumer API

    @property
    def finished(self) -> bool:
        return self._finished

    async def next(self) -> Snapshot | None:
        """Wait for a snapshot newer than the last one returned; None once the search ended."""
        while True:
            if self._latest is not None:
                snapshot, self._latest = self._latest, None
                return snapshot
            if self._finished:
                return None
            self._event.clear()
            await self._event.wait()

    def take_latest(self) -> Snapshot | None:
        """The pending snapshot, if any, without waiting."""
        snapshot, self._latest = self._latest, None
        return snapshot

    def request_stop(self) -> None:
        """Ask the engine to stop (non-blocking, idempotent)."""
        self._stop_requested = True
        if self._analysis is not None:
            self._send_stop()

    def _send_stop(self) -> None:
        if self._stop_sent or self._analysis is None:
            return
        self._stop_sent = True
        self._mgr._call_soon(self._analysis.stop)

    async def wait_closed(self) -> None:
        if self._pump is not None:
            try:
                await asyncio.shield(self._pump)
            except Exception:  # noqa: BLE001 - errors were reported via .error
                pass

    async def stop(self) -> None:
        """Stop the search and wait until the engine has acknowledged it (bestmove)."""
        self.request_stop()
        try:
            await asyncio.wait_for(self.wait_closed(), timeout=5)
        except asyncio.TimeoutError:
            log.warning("analysis did not stop within 5 s")

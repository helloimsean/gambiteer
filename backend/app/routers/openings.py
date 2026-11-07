"""GET /api/openings, /api/openings/{id}, /api/openings/{id}/quiz."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request

from ..deps import services
from ..schemas import OpeningFull, OpeningSummary, QuizItem

router = APIRouter(prefix="/api/openings", tags=["openings"])


def _store(request: Request):
    store = services(request).openings
    store.refresh_if_changed()
    return store


@router.get("", response_model=list[OpeningSummary])
async def list_openings(request: Request) -> list[OpeningSummary]:
    return _store(request).summaries()


@router.get("/{opening_id}", response_model=OpeningFull)
async def get_opening(opening_id: str, request: Request) -> OpeningFull:
    opening = _store(request).get(opening_id)
    if opening is None:
        raise HTTPException(status_code=404, detail=f"unknown opening '{opening_id}'")
    return opening.full_model()


@router.get("/{opening_id}/quiz", response_model=list[QuizItem], response_model_exclude_none=True)
async def get_quiz(
    opening_id: str,
    request: Request,
    mode: Literal["positions", "traps"] = "positions",
    limit: int = Query(default=50, ge=1, le=10_000),
) -> list[QuizItem]:
    opening = _store(request).get(opening_id)
    if opening is None:
        raise HTTPException(status_code=404, detail=f"unknown opening '{opening_id}'")
    return opening.quiz(mode, limit)

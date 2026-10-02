from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter
from fastapi.responses import PlainTextResponse

router = APIRouter()
_health_check: Callable[[], bool] | None = None


def bind_health(check: Callable[[], bool]) -> None:
    global _health_check
    _health_check = check


def _is_up() -> bool:
    if _health_check is None:
        return False
    try:
        return _health_check()
    except Exception:
        return False


@router.get("/metrics")
def metrics() -> PlainTextResponse:
    up = _is_up()
    return PlainTextResponse(
        f"ipam_up {1 if up else 0}\n",
        status_code=200 if up else 503,
        media_type="text/plain; version=0.0.4",
    )

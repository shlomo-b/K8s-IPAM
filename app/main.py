import ipaddress
import json
import logging
import os
import secrets
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import quote_plus

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from pymongo import MongoClient
from starlette.middleware.sessions import SessionMiddleware

ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "data" / "ipam.json"
STATIC = ROOT / "static"

logging.basicConfig(level=logging.INFO, format="%(levelname)s:     %(message)s")
log = logging.getLogger("ipam")


def require_env(name: str) -> str:
    value = os.environ[name]
    if not value.strip():
        raise RuntimeError(f"Environment variable {name} must not be empty")
    return value


IPAM_USER = require_env("IPAM_USER")
IPAM_PASSWORD = require_env("IPAM_PASSWORD")
MONGO_HOST = os.environ.get("MONGO_HOST", "mongo")
MONGO_DB_NAME = os.environ.get("MONGO_DB", "ipam")
MONGO_USER = require_env("MONGO_INITDB_ROOT_USERNAME")
MONGO_PASSWORD = require_env("MONGO_INITDB_ROOT_PASSWORD")

_mongo: MongoClient | None = None


def mongo_uri() -> str:
    user = quote_plus(MONGO_USER)
    password = quote_plus(MONGO_PASSWORD)
    return f"mongodb://{user}:{password}@{MONGO_HOST}:27017/{MONGO_DB_NAME}?authSource=admin"


def mongo() -> MongoClient:
    global _mongo
    if _mongo is None:
        _mongo = MongoClient(mongo_uri(), serverSelectionTimeoutMS=5000)
    return _mongo


def mongo_db():
    return mongo()[MONGO_DB_NAME]


def without_mongo_id(doc: dict[str, Any] | None) -> dict[str, Any] | None:
    if not doc:
        return doc
    clean = dict(doc)
    clean.pop("_id", None)
    return clean


def wait_for_mongo(tries: int = 30) -> None:
    log.info("Connecting to MongoDB at %s database=%s user=%s", MONGO_HOST, MONGO_DB_NAME, MONGO_USER)
    last_error: Exception | None = None
    for attempt in range(1, tries + 1):
        try:
            mongo().admin.command("ping")
            log.info("MongoDB ping ok (%s/%s)", attempt, tries)
            return
        except Exception as exc:
            last_error = exc
            log.warning("MongoDB not ready yet (%s/%s): %s", attempt, tries, exc)
            time.sleep(1)
    raise RuntimeError(f"MongoDB is not reachable: {last_error}") from last_error


def migrate_json_if_empty() -> None:
    database = mongo_db()
    pools_count = database.pools.count_documents({})
    alloc_count = database.allocations.count_documents({})
    if pools_count or alloc_count:
        log.info("MongoDB already has data: pools=%s allocations=%s", pools_count, alloc_count)
        return
    if not DATA_FILE.exists():
        log.info("MongoDB is empty and no JSON seed file was found")
        return
    payload = json.loads(DATA_FILE.read_text())
    pools = payload.get("pools") or []
    allocations = payload.get("allocations") or []
    if pools:
        database.pools.insert_many(pools)
    if allocations:
        database.allocations.insert_many(allocations)
    log.info("Imported JSON seed into MongoDB: pools=%s allocations=%s", len(pools), len(allocations))


def load_or_create_session_secret() -> str:
    database = mongo_db()
    row = database.settings.find_one({"_id": "session"})
    if row and row.get("secret"):
        return row["secret"]
    value = secrets.token_hex(32)
    database.settings.update_one({"_id": "session"}, {"$set": {"secret": value}}, upsert=True)
    return value


wait_for_mongo()
migrate_json_if_empty()
SESSION_SECRET = load_or_create_session_secret()
log.info("Connected to MongoDB host=%s db=%s", MONGO_HOST, MONGO_DB_NAME)

KINDS = ("Pod", "Service", "Ingress", "Node", "Reserved")
STATUSES = ("allocated", "reserved", "free")

app = FastAPI(title="Kubernetes IPAM")
app.add_middleware(SessionMiddleware, secret_key=SESSION_SECRET, same_site="lax")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


def load_db() -> dict[str, Any]:
    database = mongo_db()
    return {
        "pools": [without_mongo_id(doc) for doc in database.pools.find()],
        "allocations": [without_mongo_id(doc) for doc in database.allocations.find()],
    }


def save_db(db: dict[str, Any]) -> None:
    database = mongo_db()
    pools = [dict(item) for item in db.get("pools", [])]
    allocations = [dict(item) for item in db.get("allocations", [])]
    for item in pools:
        item.pop("_id", None)
    for item in allocations:
        item.pop("_id", None)
    database.pools.delete_many({})
    database.allocations.delete_many({})
    if pools:
        database.pools.insert_many([dict(item) for item in pools])
    if allocations:
        database.allocations.insert_many([dict(item) for item in allocations])


def require_login(request: Request) -> None:
    if not request.session.get("user"):
        raise HTTPException(status_code=401, detail="Not logged in")


def ip_int(ip: str) -> int:
    return int(ipaddress.ip_address(ip))


MAP_LIMIT = 512


def looks_like_cidr(value: str) -> bool:
    return "/" in value.strip()


def parse_pool_spec(cidr: str = "", start: str = "", end: str = "") -> dict[str, Any]:
    cidr = (cidr or "").strip()
    start = (start or "").strip()
    end = (end or "").strip()
    if not cidr and looks_like_cidr(start):
        cidr = start
    if not cidr and looks_like_cidr(end):
        cidr = end
    if cidr:
        net = ipaddress.ip_network(cidr, strict=False)
        return {
            "cidr": str(net),
            "start": str(net.network_address),
            "end": str(net.broadcast_address),
            "total": net.num_addresses,
        }
    if not start or not end:
        raise ValueError("provide a CIDR like 10.0.0.0/24 or a start and end IP")
    a, b = ip_int(start), ip_int(end)
    if b < a:
        raise ValueError("end must be >= start")
    return {
        "cidr": "",
        "start": start,
        "end": end,
        "total": b - a + 1,
    }


def pool_network(pool: dict[str, Any]) -> ipaddress.IPv4Network | ipaddress.IPv6Network | None:
    if pool.get("cidr"):
        return ipaddress.ip_network(pool["cidr"], strict=False)
    return None


def expand_pool_map(pool: dict[str, Any]) -> list[str]:
    spec = parse_pool_spec(pool.get("cidr", ""), pool.get("start", ""), pool.get("end", ""))
    if spec["total"] > MAP_LIMIT:
        return []
    net = pool_network({**pool, **spec})
    if net is not None:
        return [str(ip) for ip in net]
    return [str(ipaddress.ip_address(i)) for i in range(ip_int(spec["start"]), ip_int(spec["end"]) + 1)]


def ip_in_pool(ip: str, pool: dict[str, Any]) -> bool:
    addr = ipaddress.ip_address(ip)
    net = pool_network(pool)
    if net is not None:
        return addr in net
    return ip_int(pool["start"]) <= int(addr) <= ip_int(pool["end"])


def find_pool(db: dict[str, Any], pool_id: str) -> dict[str, Any] | None:
    return next((p for p in db.get("pools", []) if p.get("id") == pool_id), None)


def require_pool(db: dict[str, Any], pool_id: str) -> dict[str, Any]:
    pool = find_pool(db, pool_id)
    if not pool:
        raise HTTPException(status_code=400, detail="Choose a pool for this IP")
    return pool


def validate_allocation_ip(db: dict[str, Any], body: "AllocationBody", item_id: str | None = None) -> dict[str, Any]:
    pool = require_pool(db, body.pool)
    spec = parse_pool_spec(pool.get("cidr", ""), pool.get("start", ""), pool.get("end", ""))
    pool_spec = {**pool, **spec}
    if not ip_in_pool(body.ip, pool_spec):
        range_label = spec["cidr"] or f"{spec['start']} – {spec['end']}"
        raise HTTPException(status_code=400, detail=f"IP {body.ip} is not in pool {pool['name']} ({range_label})")
    for row in db.get("allocations", []):
        if item_id and row.get("id") == item_id:
            continue
        if row.get("pool") != body.pool:
            continue
        if row["ip"] == body.ip and row.get("status") != "free":
            raise HTTPException(status_code=409, detail=f"IP {body.ip} is already used in this pool")
    return pool


class LoginBody(BaseModel):
    username: str
    password: str


class PoolBody(BaseModel):
    name: str
    cidr: str = ""
    start: str = ""
    end: str = ""
    purpose: str = ""
    mode: str = "cidr"
    id: str | None = None


class AllocationBody(BaseModel):
    kind: str
    namespace: str
    name: str
    ip: str
    pool: str
    status: str = "allocated"
    notes: str = ""
    id: str | None = None


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


@app.post("/api/login")
def login(body: LoginBody, request: Request) -> dict[str, str]:
    if body.username != IPAM_USER or body.password != IPAM_PASSWORD:
        raise HTTPException(status_code=401, detail="Invalid username or password")
    request.session["user"] = body.username
    return {"user": body.username}


@app.post("/api/logout")
def logout(request: Request) -> dict[str, bool]:
    request.session.clear()
    return {"ok": True}


@app.get("/api/me")
def me(request: Request) -> JSONResponse:
    user = request.session.get("user")
    if not user:
        return JSONResponse({"user": None}, status_code=401)
    return JSONResponse({"user": user})


@app.get("/api/pools")
def list_pools(request: Request) -> dict[str, Any]:
    require_login(request)
    return {"pools": load_db().get("pools", [])}


@app.post("/api/pools")
def create_pool(body: PoolBody, request: Request) -> dict[str, Any]:
    require_login(request)
    try:
        spec = parse_pool_spec("" if body.mode == "range" else body.cidr, body.start, body.end)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    db = load_db()
    pool = body.model_dump()
    pool["id"] = body.id or uuid.uuid4().hex[:10]
    pool["mode"] = "range" if not spec["cidr"] else "cidr"
    pool["cidr"] = spec["cidr"]
    pool["start"] = spec["start"]
    pool["end"] = spec["end"]
    db.setdefault("pools", []).append(pool)
    save_db(db)
    return pool


@app.put("/api/pools/{pool_id}")
def update_pool(pool_id: str, body: PoolBody, request: Request) -> dict[str, Any]:
    require_login(request)
    try:
        spec = parse_pool_spec("" if body.mode == "range" else body.cidr, body.start, body.end)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    db = load_db()
    for i, pool in enumerate(db.get("pools", [])):
        if pool["id"] == pool_id:
            updated = body.model_dump()
            updated["id"] = pool_id
            updated["mode"] = "range" if not spec["cidr"] else "cidr"
            updated["cidr"] = spec["cidr"]
            updated["start"] = spec["start"]
            updated["end"] = spec["end"]
            db["pools"][i] = updated
            save_db(db)
            return updated
    raise HTTPException(status_code=404, detail="Pool not found")


@app.delete("/api/pools/{pool_id}")
def delete_pool(pool_id: str, request: Request) -> dict[str, bool]:
    require_login(request)
    db = load_db()
    before = len(db.get("pools", []))
    db["pools"] = [p for p in db.get("pools", []) if p["id"] != pool_id]
    if len(db["pools"]) == before:
        raise HTTPException(status_code=404, detail="Pool not found")
    db["allocations"] = [a for a in db.get("allocations", []) if a.get("pool") != pool_id]
    save_db(db)
    return {"ok": True}


@app.get("/api/allocations")
def list_allocations(request: Request, pool: str | None = None) -> dict[str, Any]:
    require_login(request)
    rows = load_db().get("allocations", [])
    if pool:
        rows = [row for row in rows if row.get("pool") == pool]
    return {"allocations": rows}


@app.post("/api/allocations")
def create_allocation(body: AllocationBody, request: Request) -> dict[str, Any]:
    require_login(request)
    if body.kind not in KINDS:
        raise HTTPException(status_code=400, detail=f"kind must be one of {KINDS}")
    if body.status not in STATUSES:
        raise HTTPException(status_code=400, detail=f"status must be one of {STATUSES}")
    try:
        ipaddress.ip_address(body.ip)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="invalid IP") from exc
    db = load_db()
    validate_allocation_ip(db, body)
    item = body.model_dump()
    item["id"] = body.id or uuid.uuid4().hex[:12]
    db.setdefault("allocations", []).append(item)
    save_db(db)
    return item


@app.put("/api/allocations/{item_id}")
def update_allocation(item_id: str, body: AllocationBody, request: Request) -> dict[str, Any]:
    require_login(request)
    if body.kind not in KINDS:
        raise HTTPException(status_code=400, detail=f"kind must be one of {KINDS}")
    db = load_db()
    for i, row in enumerate(db.get("allocations", [])):
        if row["id"] == item_id:
            validate_allocation_ip(db, body, item_id)
            updated = body.model_dump()
            updated["id"] = item_id
            db["allocations"][i] = updated
            save_db(db)
            return updated
    raise HTTPException(status_code=404, detail="Allocation not found")


@app.delete("/api/allocations/{item_id}")
def delete_allocation(item_id: str, request: Request) -> dict[str, bool]:
    require_login(request)
    db = load_db()
    before = len(db.get("allocations", []))
    db["allocations"] = [a for a in db.get("allocations", []) if a["id"] != item_id]
    if len(db["allocations"]) == before:
        raise HTTPException(status_code=404, detail="Allocation not found")
    save_db(db)
    return {"ok": True}


@app.get("/api/ip-map")
def ip_map(request: Request, pool: str | None = None) -> dict[str, Any]:
    require_login(request)
    db = load_db()
    pools = db.get("pools", [])
    if not pools:
        return {"pool": None, "addresses": []}
    selected = next((p for p in pools if p["id"] == pool), pools[0])
    try:
        spec = parse_pool_spec(selected.get("cidr", ""), selected.get("start", ""), selected.get("end", ""))
        ips = expand_pool_map({**selected, **spec})
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    in_pool = [row for row in db.get("allocations", []) if row.get("pool") == selected.get("id")]
    reserved = sum(1 for row in in_pool if row.get("status") == "reserved")
    used = sum(1 for row in in_pool if row.get("status") != "free")
    free = spec["total"] - used
    by_ip: dict[str, list[dict[str, Any]]] = {}
    for row in in_pool:
        by_ip.setdefault(row["ip"], []).append(row)
    addresses = []
    for ip in ips:
        rows = by_ip.get(ip, [])
        if len(rows) > 1:
            state = "conflict"
        elif not rows:
            state = "free"
        else:
            state = rows[0].get("status") or "allocated"
        addresses.append({"ip": ip, "state": state, "items": rows})
    selected = {**selected, "cidr": spec["cidr"] or selected.get("cidr", ""), "start": spec["start"], "end": spec["end"]}
    return {
        "pool": selected,
        "total": spec["total"],
        "used": used,
        "reserved": reserved,
        "free": max(free, 0),
        "addresses": addresses,
        "map_limited": spec["total"] > MAP_LIMIT,
    }

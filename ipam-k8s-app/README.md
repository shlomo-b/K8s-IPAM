# Kubernetes IPAM

Manual IP address inventory for Kubernetes clusters.

Record which address belongs to a Pod, Service, Ingress, Node, or reserved VIP. The dashboard shows pool utilization and a clickable IP map so the same address is not assigned twice.

This application does **not** connect to the Kubernetes API. Allocations are entered and maintained by operators.

---

## Features

- Session login (`IPAM_USER` / `IPAM_PASSWORD`)
- Welcome bar with signed-in user and logout
- Idle timeout (3 minutes, 30-second warning)
- CIDR pools (example: `10.0.0.0/24`, `10.244.0.0/16`)
- Start–end ranges (example: `10.0.0.100`–`10.0.0.150`)
- Allocations: kind, namespace, name, IP, status, notes
- Dashboard: used, free, reserved, and IP map
- Duplicate-IP check within a pool
- IP must belong to the selected pool or range
- MongoDB persistence
- Optional JSON seed import when the database is empty

## Limitations

- No live sync from the cluster
- No automatic IP assignment to Kubernetes objects
- No overlap warning between pools
- No “next free IP” helper
- Single shared login (no roles)

The IP map is shown only when a pool has **512 or fewer** addresses. Larger prefixes (for example `/16`) still show counts; add addresses under Allocations.

---

## Requirements

- Docker
- Docker Compose

---

## Quick start

From the repository root:

```bash
docker compose up --build -d
```

Open http://localhost:8088 and sign in with `IPAM_USER` / `IPAM_PASSWORD`.

```bash
docker compose down      # stop
docker compose down -v   # stop and delete MongoDB data
```

After UI changes, rebuild and hard-refresh the browser so cached assets are not used.

---

## Configuration

Set these variables on the `ipam` service:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `IPAM_USER` | yes | — | Login username |
| `IPAM_PASSWORD` | yes | — | Login password |
| `MONGO_HOST` | no | `mongo` | MongoDB hostname |
| `MONGO_DB` | no | `ipam` | Database name |
| `MONGO_INITDB_ROOT_USERNAME` | yes | — | MongoDB user |
| `MONGO_INITDB_ROOT_PASSWORD` | yes | — | MongoDB password |

The MongoDB service uses the same root username and password. The application will not start if a required variable is missing or empty.

---

## Architecture

```
Browser  →  FastAPI (port 8088)  →  MongoDB (port 27017)
```

| Service | Image | Role |
|---------|-------|------|
| `mongo` | `mongo:7` | Pools, allocations, session secret |
| `ipam` | `ipam-k8s:v1.0.0` | Web UI and REST API |

Startup order:

1. Wait for MongoDB healthcheck
2. Ping MongoDB
3. Import `data/ipam.json` if `pools` and `allocations` are empty
4. Load or create the session secret in `settings`
5. Serve the UI on port 8088

```
.
├── app/main.py
├── static/                 # UI
├── data/ipam.json          # seed (imported once)
├── docker-compose.yml
├── Dockerfile
└── requirements.txt
```

---

## Concepts

### Pool vs range

| Type | Input | Typical use |
|------|--------|-------------|
| Pool | CIDR, e.g. `10.0.0.0/24` | Subnet (nodes, load balancer, VIP, or pod CIDR) |
| Range | Start and end IP | Load balancer block or node block |

Each pool or range appears in the Pool selector. The dashboard and allocation list follow the selection.

### Kind

| Kind | Meaning |
|------|---------|
| Pod | Pod address |
| Service | ClusterIP or LoadBalancer address |
| Ingress | Ingress / controller VIP |
| Node | Cluster node |
| Reserved | Address that must not be reused |

### Status

| Status | Meaning |
|--------|---------|
| allocated | In use |
| reserved | Held on purpose (gateway, API VIP) |
| free | No record (shown on the map) |

Example: node `node-1` at `10.0.0.10` is **allocated**. API VIP `10.0.0.5` is **reserved**.

### Conflict

An address is marked conflict if more than one non-free record exists for it in the same pool. The API also rejects a second allocation of the same IP in that pool.

---

## User interface

**Login** uses `IPAM_USER` and `IPAM_PASSWORD`. After sign-in the top bar shows `Welcome, <username>` and **Log out**.

**Session** is a cookie (`SameSite=Lax`). The signing secret is stored in MongoDB. After 3 minutes idle the session ends; a warning appears 30 seconds before logout.

**Dashboard** — utilization and IP map. Click a cell to add or edit that address.

**Allocations** — table for the selected pool. Filter by kind or search name, namespace, or IP.

**Pools** — **Add pool** (CIDR) or **Add range** (start–end). Deleting a pool deletes its allocations.

---

## Example layout

Documentation examples only. Use addresses that match your cluster.

| Name | Type | Addresses | Purpose |
|------|------|-----------|---------|
| pods | pool | `10.244.0.0/16` | Pod network |
| nodes-net | pool | `10.0.0.0/24` | Node / load-balancer network |
| lb-pool | range | `10.0.0.100`–`10.0.0.150` | Load balancer |
| nodes | range | `10.0.0.10`–`10.0.0.20` | Nodes |

Reserved examples on `10.0.0.0/24`:

| IP | Kind / status | Why |
|----|----------------|-----|
| `10.0.0.0` | Reserved / reserved | Network |
| `10.0.0.1` | Reserved / reserved | Gateway |
| `10.0.0.5` | Reserved / reserved | API VIP |
| `10.0.0.255` | Reserved / reserved | Broadcast |

`data/ipam.json` is imported only when MongoDB has no pools and no allocations. Later edits to that file do not update an existing database.

---

## MongoDB

Database: `ipam` (or `MONGO_DB`).

| Collection | Contents |
|------------|----------|
| `pools` | CIDR pools and ranges |
| `allocations` | IP records |
| `settings` | Session secret (`_id: session`) |

Connection: `mongodb://<user>:<password>@mongo:27017/ipam?authSource=admin`

Volume: `ipam_mongo_data` → `/data/db`

### Pool document

```json
{
  "id": "pool-id-1",
  "name": "nodes-net",
  "mode": "cidr",
  "cidr": "10.0.0.0/24",
  "start": "10.0.0.0",
  "end": "10.0.0.255",
  "purpose": "node and load balancer network"
}
```

`mode` is `cidr` or `range`. For a range, `cidr` is empty.

### Allocation document

```json
{
  "id": "alloc-id-1",
  "kind": "Node",
  "namespace": "default",
  "name": "node-1",
  "ip": "10.0.0.10",
  "pool": "pool-id-1",
  "status": "allocated",
  "notes": ""
}
```

`pool` is the pool `id`, not the name.

Writes load the collections, apply the change, and persist them. This is intended for a single operator, not concurrent editors.

Validation: CIDR or start/end must parse; end ≥ start; allocation IP must be valid and inside the pool; the same IP cannot be allocated or reserved twice in one pool.

---

## HTTP API

Unauthenticated: `/`, `/static/*`, `POST /api/login`, `GET /api/me`. All other `/api/*` routes require a session cookie.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | UI |
| `POST` | `/api/login` | `{ "username", "password" }` |
| `POST` | `/api/logout` | Clear session |
| `GET` | `/api/me` | Current user or `401` |
| `GET` | `/api/pools` | List pools |
| `POST` | `/api/pools` | Create pool or range |
| `PUT` | `/api/pools/{id}` | Update pool |
| `DELETE` | `/api/pools/{id}` | Delete pool and its allocations |
| `GET` | `/api/allocations?pool=` | List allocations |
| `POST` | `/api/allocations` | Create allocation |
| `PUT` | `/api/allocations/{id}` | Update allocation |
| `DELETE` | `/api/allocations/{id}` | Delete allocation |
| `GET` | `/api/ip-map?pool=` | Stats and map for one pool |

Create pool (range):

```json
{
  "name": "lb-pool",
  "mode": "range",
  "start": "10.0.0.100",
  "end": "10.0.0.150",
  "purpose": "load balancer"
}
```

Create pool (CIDR):

```json
{
  "name": "pods",
  "mode": "cidr",
  "cidr": "10.244.0.0/16",
  "purpose": "all pods"
}
```

Create allocation:

```json
{
  "kind": "Ingress",
  "namespace": "ingress",
  "name": "ingress",
  "ip": "10.0.0.80",
  "pool": "pool-id-1",
  "status": "allocated",
  "notes": ""
}
```

`kind`: `Pod`, `Service`, `Ingress`, `Node`, `Reserved`  
`status`: `allocated`, `reserved`, `free`

| Code | Meaning |
|------|---------|
| `400` | Invalid CIDR/IP, IP outside pool, invalid kind/status |
| `401` | Not authenticated |
| `404` | Not found |
| `409` | IP already used in this pool |

```bash
curl -c cookies.txt -X POST http://localhost:8088/api/login \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$IPAM_USER\",\"password\":\"$IPAM_PASSWORD\"}"

curl -b cookies.txt http://localhost:8088/api/pools
curl -b cookies.txt 'http://localhost:8088/api/ip-map?pool=YOUR_POOL_ID'
```

---

## Docker

- Base image: `python:3.10-slim`
- Process user: `appuser` (uid 1000)
- Command: `uvicorn app.main:app --host 0.0.0.0 --port 8088`
- Image tag: `ipam-k8s:v1.0.0`

```bash
docker compose up --build -d
```

---

## Security

- Use strong values for `IPAM_USER`, `IPAM_PASSWORD`, and MongoDB credentials.
- Port 8088 has no TLS. Place a reverse proxy in front for remote access.
- The session cookie is not marked Secure (HTTP).
- One shared account for the application.

---

## Troubleshooting

| Symptom | What to check |
|---------|----------------|
| Login UI stays after sign-in | Hard-refresh the browser |
| Used count is 0 | Addresses are outside the selected pool CIDR/range |
| IP map is hidden | Pool has more than 512 addresses; use Allocations |
| Seed JSON did not load | MongoDB already has data; import runs only on an empty database |
| Container will not start | Required environment variables are set; `docker compose logs ipam` and `docker compose logs mongo` |
| Unexpected logout | Idle timeout is 3 minutes; use **Stay signed in** on the warning |

---

## Stack

FastAPI, Uvicorn, MongoDB 7, Docker Compose, HTML/CSS/JavaScript.

---

Copyright © 2026 Shlomo Barzilai. All rights reserved.

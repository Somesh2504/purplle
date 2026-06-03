# Store Intelligence System
### Purplle Tech Challenge 2026 — Store 1

An end-to-end AI-powered retail analytics system that processes CCTV footage to track customer journeys and compute business KPIs.

---

## Prerequisites

| Tool | Version |
|---|---|
| Docker | 24.x+ |
| Docker Compose | 2.x+ (plugin syntax: `docker compose`) |
| Free RAM | ≥ 4 GB recommended |
| CPU | Any x86-64; GPU not required |

---

## Quick Start

### 1. Clone and place data files

```
purplle-tech-challenge/
└── data/
    ├── videos/
    │   ├── entry_cam.mp4
    │   ├── zone_1.mp4
    │   ├── zone_2.mp4
    │   └── billing.mp4
    └── Brigade_Bangalore_10_April_26.csv
```

> The `data/` directory is mounted read-only into both services at runtime. No data files are baked into the Docker images.

### 2. Start the system

```bash
docker compose up --build
```

On first run, the build step will:
- Install all Node.js dependencies inside the backend image
- Install all Python dependencies inside the cv-pipeline image
- **Pre-download YOLOv8n weights** (`yolov8n.pt`) into the cv-pipeline image

Subsequent runs reuse the cached layers and start in seconds.

### 3. Verify the system is running

```bash
# Health check (should return 200 OK with status: "ok")
curl http://localhost:3000/api/health

# Store KPIs
curl http://localhost:3000/api/metrics

# Shopping funnel
curl http://localhost:3000/api/funnel
```

### 4. Watch live logs

```bash
# All services
docker compose logs -f

# Backend only
docker compose logs -f backend

# CV pipeline only
docker compose logs -f cv-pipeline
```

### 5. Stop

```bash
docker compose down

# To also wipe the MongoDB volume (resets all session data)
docker compose down -v
```

---

## Architecture Overview

```
cv-pipeline (Python)  ──POST /api/events──▶  backend (Node.js)  ──▶  MongoDB
     │                                              │
     │ reads                                        │ reads
     ▼                                              ▼
 data/videos/*.mp4                         data/*.csv (POS data)
```

| Service | Role |
|---|---|
| `cv-pipeline` | YOLOv8n detection + spatial event emission |
| `backend` | Session state machine + business logic API |
| `mongodb` | Persistent session storage |

See [`DESIGN.md`](./DESIGN.md) for the full architecture document.
See [`CHOICES.md`](./CHOICES.md) for engineering decision rationale.

---

## API Reference

### `GET /api/health`
Service health check. Always responds, even before the database connects.

```json
{
  "status": "ok",
  "service": "store-intelligence-backend",
  "database": "connected",
  "uptime_seconds": 42,
  "timestamp": "2026-04-10T10:00:00.000Z"
}
```

---

### `POST /api/events`
Inbound webhook from the CV pipeline. Not intended for direct use.

**Request body:**
```json
{
  "event_type": "entry",
  "camera_id": "entry_cam",
  "timestamp": "2026-04-10T10:05:23.000Z",
  "track_id": 7,
  "zone_name": "entrance_door"
}
```

**Response:** `202 Accepted`
```json
{
  "status": "accepted",
  "event_type": "entry",
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "session_status": "active",
  "is_staff": false
}
```

---

### `GET /api/metrics`
Store-level KPIs for the evaluation day.

```json
{
  "store_id": "store_1",
  "date": "2026-04-10",
  "total_consumer_sessions": 87,
  "active_sessions": 3,
  "completed_sessions": 84,
  "group_visits": 12,
  "avg_dwell_time_min": 14,
  "total_unique_invoices": 52,
  "pos_raw_row_count": 54,
  "store_conversion_rate_pct": 59.77,
  "anomaly_detected": false,
  "anomaly_reason": null,
  "generated_at": "2026-04-10T18:00:00.000Z"
}
```

---

### `GET /api/funnel`
4-level shopping funnel with drop-off analysis.

```json
{
  "store_id": "store_1",
  "date": "2026-04-10",
  "funnel": [
    { "level": 1, "stage": "walk_in",          "count": 87,  "pct_of_top": 100,  "drop_off_from_prev": 0  },
    { "level": 2, "stage": "zone_engagement",  "count": 61,  "pct_of_top": 70.1, "drop_off_from_prev": 26 },
    { "level": 3, "stage": "billing_queue",    "count": 55,  "pct_of_top": 63.2, "drop_off_from_prev": 6  },
    { "level": 4, "stage": "converted",        "count": 52,  "pct_of_top": 59.8, "drop_off_from_prev": 3  }
  ],
  "summary": {
    "total_walk_ins": 87,
    "total_converted": 52,
    "overall_conversion_rate_pct": 59.77,
    "biggest_drop_off_stage": "walk_in→browsing"
  },
  "generated_at": "2026-04-10T18:00:00.000Z"
}
```

---

## Configuration

All configuration is handled via environment variables set in `docker-compose.yml`. No `.env` file is required.

| Variable | Service | Default | Description |
|---|---|---|---|
| `MONGO_URI` | backend | `mongodb://mongodb:27017/store_analytics` | MongoDB connection string |
| `PORT` | backend | `3000` | HTTP port |
| `NODE_ENV` | backend | `production` | Runtime environment |
| `BACKEND_URL` | cv-pipeline | `http://backend:3000` | Backend webhook target |
| `DATA_DIR` | cv-pipeline | `/app/data` | Path to data mount |

---

## Project Structure

```
purplle-tech-challenge/
├── docker-compose.yml          # Service orchestration
├── DESIGN.md                   # Architecture document
├── CHOICES.md                  # Engineering decisions
├── README.md                   # This file
├── .gitignore
│
├── data/                       # ← Mount point (not in git)
│   ├── videos/
│   │   ├── entry_cam.mp4
│   │   ├── zone_1.mp4
│   │   ├── zone_2.mp4
│   │   └── billing.mp4
│   └── Brigade_Bangalore_10_April_26.csv
│
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   ├── server.js               # Express app + DB retry loop
│   ├── models/
│   │   └── Session.js          # Mongoose schema
│   ├── controllers/
│   │   ├── eventController.js  # State machine logic
│   │   └── metricsController.js# KPI + funnel computation
│   └── routes/
│       ├── events.js
│       ├── metrics.js
│       └── funnel.js
│
└── cv-pipeline/
    ├── Dockerfile
    ├── requirements.txt
    └── tracker.py              # YOLO + spatial logic + webhooks
```

---

## Troubleshooting

**`cv-pipeline` exits immediately with "Missing video files"**
→ Ensure all 4 `.mp4` files are placed in `data/videos/` before running `docker compose up`.

**`backend` keeps printing "MongoDB not ready — retrying"**
→ Normal during startup. MongoDB takes 10–20 seconds to initialise on first run. The backend retries up to 10 times. Wait for the healthcheck to pass.

**`docker compose up` fails with "port 3000 already in use"**
→ Another process is using port 3000. Run `docker compose down` and check for orphan containers with `docker ps`.

**Want to reprocess videos from scratch (reset all sessions)**
```bash
docker compose down -v    # removes MongoDB volume
docker compose up
```

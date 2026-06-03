# DESIGN.md — Store Intelligence System Architecture
## Purplle Tech Challenge 2026 | Store 1

---

## 1. Problem Statement

Given 4 simultaneous CCTV feeds from a single retail store and a POS transaction CSV, design a system that:
- Counts valid customer walk-ins (excluding staff, re-entries, and groups counted as individuals)
- Tracks customer journeys across store zones
- Calculates a store conversion rate against actual invoices
- Exposes structured API endpoints for business metrics

The primary constraint: **must run on a standard CPU without crashing.**

---

## 2. High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        Docker Network: store_net                  │
│                                                                   │
│  ┌─────────────────┐    HTTP POST     ┌──────────────────────┐   │
│  │  cv-pipeline    │  ─────────────▶  │  backend (Node.js)   │   │
│  │  (Python)       │  /api/events     │  Express + Mongoose   │   │
│  │                 │                  │                        │   │
│  │  YOLOv8n Nano   │                  │  Session State Machine │   │
│  │  OpenCV         │                  │  Business Logic        │   │
│  │  Frame-skipping │                  │  CSV Parser            │   │
│  └─────────────────┘                  └──────────┬─────────────┘  │
│         │ reads                                  │ read/write     │
│         ▼                                        ▼                │
│  ┌─────────────────┐                  ┌──────────────────────┐   │
│  │   /app/data/    │                  │  MongoDB 7.0          │   │
│  │   videos/*.mp4  │                  │  sessions collection  │   │
│  │   *.csv         │                  │  (persistent volume)  │   │
│  └─────────────────┘                  └──────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘

External: GET /api/metrics  GET /api/funnel  GET /api/health
          ◀──────────────────────────────────────────────────
```

---

## 3. Component Design

### Component A — CV Pipeline (`cv-pipeline/tracker.py`)

**Responsibility:** Detect humans in video frames and emit atomic spatial events to the backend. It does **not** track state, manage sessions, or correlate across cameras.

**Stack:**
- `YOLOv8n.pt` — lightest YOLO variant (3.2M parameters). Loaded once, shared across all 4 camera processors.
- `OpenCV VideoCapture` — sequential per-file processing.
- `ByteTrack` (built into Ultralytics) — maintains track IDs within a single camera view.
- `requests.post` — fire-and-forget HTTP webhook with full error suppression.

**Frame-skip strategy:**
```
Frame N:  run YOLO inference  → get bounding boxes + track IDs
Frame N+1 to N+4:  carry forward last result  → zero inference cost
Effective rate: 80% CPU reduction vs. processing every frame
```

**Spatial logic per camera:**

| Camera | Trigger Mechanism | Event Type |
|---|---|---|
| `entry_cam` | Horizontal virtual line at 55% frame height. Track bottom-center crosses line. Direction determines entry/exit. | `entry` / `exit` |
| `zone_1` | Point-in-polygon test against Makeup Unit polygon. Centroid must dwell ≥ 45 frames continuously. | `zone_dwell` |
| `zone_2` | Point-in-polygon test against DermDoc polygon. Same 45-frame threshold. | `zone_dwell` |
| `billing` | Rectangular ROI covering billing counter area. Any track centroid inside fires once per visit. | `billing_queue` |

**Execution model:** Sequential, not parallel. All 4 cameras process in order. See `CHOICES.md` for detailed rationale.

---

### Component B — Backend State Machine (`backend/`)

**Responsibility:** The intelligence layer. Receives dumb atomic events and assembles them into coherent `CustomerSession` documents using temporal logic and business rules.

**Stack:** Node.js 20, Express, Mongoose, MongoDB 7.0

#### Session Lifecycle

```
entry event received
        │
        ▼
 Active session exists                   → append timeline entry (dedup)
 for same track_id?
        │ No
        ▼
 Completed session exists                → reopen session (re-entry stitching)
 within last 60 seconds?
        │ No
        ▼
 Create new Session document             → start_time = eventTimestamp
                                           status = "active"

zone_dwell / billing_queue received
        │
        ▼
 Find most recent active non-staff       → append to session.timeline
 session (temporal proximity)

exit event received
        │
        ▼
 Find active session for track_id        → status = "completed"
                                           end_time = eventTimestamp
```

#### Business Rules

**A. Re-Entry Stitching (60-second window)**
When a customer briefly steps outside and re-enters, YOLO loses the track and fires a new `entry` event. The backend detects the gap (< 60s since last `exit` for the same track_id) and reopens the original session — preventing a double-count in walk-in totals.

**B. Zone Timeline Enrichment**
Zone camera track IDs are camera-local — they cannot be matched to `entry_cam` track IDs without a ReID model. We use temporal proximity: the most recently started active session receives the zone event. This is an acceptable engineering trade-off for CPU-only hardware.

**C. Group Detection (1.5-second window)**
A rolling in-memory buffer holds session_ids for the last 1.5 seconds of entry events. If 3 or more entries arrive in this window, a shared `group_id` UUID is stamped across all matching session documents. Groups are counted as one shopping unit in funnel analytics.

**D. Staff Heuristic Filter**
Sessions meeting either condition are flagged `is_staff: true` and excluded from all consumer metrics:
- Total dwell time > 4 hours (240 minutes)
- More than 15 zone/billing events in the timeline

---

### Component C — Business Logic (`metricsController.js`)

**Conversion Rate Formula:**
```
Store Conversion Rate (%) = (Unique POS Invoices / Total Valid Consumer Sessions) × 100
```

Where:
- `Unique POS Invoices` = distinct `invoice_number` values parsed from `Brigade_Bangalore_10_April_26.csv`
- `Total Valid Consumer Sessions` = MongoDB count of `{ is_staff: false }` sessions

**Anomaly Detection:**
If sessions > 300 AND conversion rate < 1.5%, inject `anomaly_detected: true` — signals either a checkout bottleneck or a camera coverage failure.

**4-Level Shopping Funnel:**

```
L1: Walk-ins          → All consumer sessions (is_staff: false)
    │
    ▼ drop-off
L2: Browsing          → Sessions with ≥1 zone_dwell in timeline
    │
    ▼ drop-off
L3: Checkout Ready    → Sessions with ≥1 billing_queue in timeline
    │
    ▼ drop-off
L4: Converted         → Unique POS invoice count (ground truth)
```

---

## 4. Data Flow

```
1. docker-compose up
2. MongoDB starts → healthcheck passes
3. Backend starts → begins retry-loop to MongoDB
4. Backend HTTP server starts immediately (health endpoint live)
5. CV pipeline starts → polls /api/health until backend is ready
6. CV pipeline processes entry_cam.mp4 sequentially
   → emits entry/exit events via POST /api/events
7. CV pipeline processes zone_1.mp4
   → emits zone_dwell events
8. CV pipeline processes zone_2.mp4
   → emits zone_dwell events
9. CV pipeline processes billing.mp4
   → emits billing_queue events
10. Evaluator calls GET /api/metrics → returns KPIs
11. Evaluator calls GET /api/funnel  → returns funnel
```

---

## 5. MongoDB Schema

### `sessions` Collection

```javascript
{
  session_id       : UUID string (indexed, unique),
  primary_track_id : Number (indexed),
  start_time       : Date,
  end_time         : Date | null,
  status           : "active" | "completed",
  is_staff         : Boolean,
  group_id         : String | null,
  timeline         : [
    {
      event_type : "entry" | "exit" | "zone_dwell" | "billing_queue",
      camera_id  : String,
      zone_name  : String,
      track_id   : Number,
      timestamp  : Date
    }
  ]
}
```

**Compound Indexes:**
- `{ primary_track_id: 1, status: 1, end_time: -1 }` — re-entry lookup
- `{ start_time: 1, status: 1 }` — group detection query

---

## 6. API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Service health + DB state. Always responds, even before DB connects. |
| `POST` | `/api/events` | Inbound CV webhook. Returns `202 Accepted`. |
| `GET` | `/api/metrics` | Store KPIs: conversion rate, sessions, anomaly flags. |
| `GET` | `/api/funnel` | 4-level shopping funnel with drop-off counts. |

---

## 7. Production Readiness Features

- **Structured JSON logging** — every operation emits a `{ level, message, timestamp, ...meta }` JSON line. Machine-readable by any log aggregator.
- **Graceful shutdown** — `SIGTERM`/`SIGINT` handlers close MongoDB connection before process exits.
- **Docker health checks** — MongoDB is health-checked before backend starts. Backend HTTP server is up before DB connects.
- **Non-root Docker user** — backend container runs as `appuser`, not root.
- **Multi-stage Docker build** — separates `npm ci` layer from source layer for fast rebuilds.
- **Retry-loop DB connection** — 10 attempts × 5s backoff. Survives Docker startup race conditions.
- **YOLOv8n pre-downloaded at build time** — no runtime model download dependency.

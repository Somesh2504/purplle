# Store Intelligence System
### Purplle Tech Challenge 2026 — Store 1

An end-to-end AI-powered retail analytics system that processes CCTV footage to track customer journeys and compute business KPIs.

---

## Prerequisites

| Tool | Version |
|---|---|
| OS | Windows 10/11 (PowerShell) |
| Node.js | v20.x+ |
| Python | v3.10+ |
| Database | MongoDB Atlas (Cloud) |
| Free RAM | ≥ 4 GB recommended |

---

## Quick Start (Native Windows Setup)

We have transitioned away from Docker to provide a faster, native execution environment on Windows using PowerShell. 

### 1. Clone and place data files

Ensure your `data` folder is structured as follows at the project root:

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

### 2. Configure MongoDB Atlas & Whitelist your IP

The system uses a cloud-hosted MongoDB Atlas cluster for data persistence. 
**Crucial Step:** MongoDB Atlas blocks unauthorized IPs by default. You must whitelist your IP address before running the system.

1. Log into your [MongoDB Atlas dashboard](https://cloud.mongodb.com/).
2. On the left sidebar, under **Security**, click **Network Access**.
3. Click the **+ ADD IP ADDRESS** button.
4. Click **ALLOW ACCESS FROM ANYWHERE** (this will fill in `0.0.0.0/0`) or add your current IP.
5. Click **Confirm** and wait ~30 seconds for the status to turn "Active".

### 3. Install Dependencies

Open PowerShell and run the setup script to install all Node and Python dependencies:

```powershell
.\setup.ps1
```

### 4. Start the system

Run the main orchestration script:

```powershell
.\start_system.ps1
```

This script will:
- Boot up the Node.js backend on port 3000.
- Wait for it to connect to MongoDB Atlas and become healthy.
- Launch the Python CV pipeline to begin analyzing the videos and pushing events.

### 5. Verify the system is running

Open a **new** PowerShell window and test the endpoints:

```powershell
# Health check (should return 200 OK with database: "connected")
curl.exe http://localhost:3000/api/health

# Store KPIs
curl.exe http://localhost:3000/api/metrics

# Shopping funnel
curl.exe http://localhost:3000/api/funnel
```

### 6. Stop

To stop all services, simply press **ENTER** in the terminal running `start_system.ps1`, or press `Ctrl+C`.

---

## Architecture Overview

```
cv-pipeline (Python)  ──POST /api/events──▶  backend (Node.js)  ──▶  MongoDB Atlas
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

Configuration is handled via the `.env` file in the `backend/` directory and variables inside the Python scripts.

| Variable | File | Description |
|---|---|---|
| `MONGO_URI` | `backend/.env` | MongoDB Atlas connection string |
| `PORT` | `backend/.env` | HTTP port (default: 3000) |
| `BACKEND_URL` | `cv-pipeline/tracker.py` | Webhook target (default: http://localhost:3000) |

---

## Project Structure

```
purplle-tech-challenge/
├── setup.ps1                   # Dependency installation script
├── start_system.ps1            # Main execution orchestrator
├── DESIGN.md                   # Architecture document
├── CHOICES.md                  # Engineering decisions
├── README.md                   # This file
├── .gitignore
│
├── data/                       # ← Required dataset directory
│   ├── videos/
│   │   ├── entry_cam.mp4
│   │   ├── zone_1.mp4
│   │   ├── zone_2.mp4
│   │   └── billing.mp4
│   └── Brigade_Bangalore_10_April_26.csv
│
├── backend/
│   ├── .env                    # Environment variables
│   ├── package.json
│   ├── server.js               # Express app + DB connection
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
    ├── requirements.txt
    └── tracker.py              # YOLO + spatial logic + webhooks
```

---

## Troubleshooting

**`cv-pipeline` crashes or throws missing file errors**
→ Ensure all 4 `.mp4` files are placed in `data/videos/` and the `.csv` file is in `data/`.

**`backend` keeps printing "MongoDB not ready — retrying" or throws TLS/SSL errors**
→ This means your IP address is not whitelisted in MongoDB Atlas. Go to the Atlas dashboard, under Network Access, and add `0.0.0.0/0`.

**The startup script fails with "port 3000 already in use"**
→ Another process is using port 3000. Run `Stop-Process -Name node -Force` to clear any orphaned background backend instances.

**Metrics API returns `POS CSV not found`**
→ Make sure the CSV file is named exactly `Brigade_Bangalore_10_April_26.csv` and is placed in the `data/` directory, not `backend/data/`.

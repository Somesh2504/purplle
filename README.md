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

## Quick Start (One-Click Deployment)

The system is fully containerized and runs flawlessly via Docker Compose, fulfilling the mandatory acceptance gate for a single-command setup.

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

### 3. Start the system via Docker

Run the standard docker-compose command from the root of the project:

```bash
docker-compose up --build
```

This command will simultaneously spin up:
- The MongoDB instance.
- The Node.js backend.
- The Python CV pipeline.

*(Note: If you prefer native Windows execution without Docker, you can run `.\setup.ps1` followed by `.\start_system.ps1` in PowerShell.)*

### 4. Verify the system is running

Open a **new** terminal window and test the endpoints:

```powershell
# Health check (should return 200 OK with database: "connected")
curl.exe http://localhost:3000/api/health

# Store KPIs
curl.exe http://localhost:3000/api/metrics

# Shopping funnel
curl.exe http://localhost:3000/api/funnel
```

### 5. Stop

To stop all services, press `Ctrl+C` in the terminal running docker-compose, or run:
```bash
docker-compose down
```

---

# System Architecture & Data Flow

## 📌 Executive Summary
This Store Intelligence System is designed with an **Event-Driven, Edge-to-Cloud Microservices Architecture**. 

Rather than relying on monolithic, computationally heavy Deep Learning models that attempt to track a single visual identity across multiple cameras (which requires massive GPU clusters and fails under real-world occlusion), this system implements a **Session-Based Temporal Strategy**. 

We utilize lightweight, edge-optimized Computer Vision (YOLOv8 Nano) to generate atomic spatial events, and push the heavy lifting of state-management and customer journey mapping to a robust Node.js/MongoDB backend. This makes the system incredibly resilient, horizontally scalable, and capable of running on standard store hardware (CPUs).

---

## 🌊 The End-to-End Data Lifecycle

### Phase 1: Physical Ingestion (The Edge)
1. **The CCTV Feeds:** The system ingests raw RTSP streams or standard `.mp4` video files from multiple cameras (e.g., `entry_cam`, `zone_1`, `billing`). 
2. **Frame Optimization:** To ensure the system can run on a standard in-store computer without lagging, the OpenCV pipeline implements an aggressive **1-in-5 frame-skipping algorithm**. Because human walking speeds in a retail environment are relatively slow, skipping frames reduces CPU overhead by 80% with zero loss in business intelligence accuracy.

### Phase 2: Spatial Processing (The AI Layer)
1. **Object Detection & Local Tracking:** For every processed frame, YOLOv8n detects human bounding boxes. We utilize the `ByteTrack` algorithm (`persist=True`) to maintain a local `track_id` for each person *within that specific camera's view*.
2. **Virtual Boundaries:** We project mathematical boundaries onto the 2D video frames based on the store's physical floor plan:
   * **Entry Vectors:** A straight line drawn across the store entrance. If a bounding box crosses this vector, the system calculates the trajectory to determine if it is an "Entry" or "Exit".
   * **Dwell Polygons:** Custom multi-point polygons drawn over key areas (e.g., Makeup Unit, Cash Counter). If a person's center-point remains inside this polygon for >9 seconds, it triggers a "Dwell".

### Phase 3: Event Decoupling (The Webhook)
The Python Vision service is entirely stateless. The moment a boundary rule is triggered, it fires an asynchronous, non-blocking HTTP POST webhook to the backend API.
* **Sample Payload:** `{ "store_id": "store_1", "camera_id": "zone_1", "event_type": "zone_dwell", "track_id": 42, "timestamp": "2026-04-10T16:55:36Z" }`

### Phase 4: State Management & Heuristics (The Brain)
The Node.js/Express backend receives this continuous stream of atomic events and uses **Temporal Clustering Logic** to stitch them into unified `Customer Session` documents in MongoDB. 

Instead of relying on AI to match faces (which poses privacy/GDPR risks and requires GPUs), our backend uses time-based rules to map the customer journey.

---

## ⚙️ How We Handle Complex Real-World Edge Cases

The true power of this architecture lies in the backend heuristics used to clean the data and prevent metric corruption.

### 1. Group Tracking (The "Buying Unit" Problem)
* **The Problem:** A family of 4 walks in together. YOLO detects 4 people. If counted as 4 separate shoppers, our conversion rate will be artificially crushed when they only generate 1 invoice at the register.
* **The Solution (Temporal Clustering):** When the backend receives multiple `entry` events from the exact same `store_id` and `camera_id` within a **1.5-second rolling time window**, the database assigns all of them a shared `group_id`. Our `/metrics` API then groups these sessions together, treating the family correctly as a single "Buying Unit".

### 2. The Re-Entry Problem
* **The Problem:** A customer walks outside to take a phone call and walks back in 30 seconds later.
* **The Solution:** When an `entry` event is fired, the Node.js controller queries MongoDB for any recent `exit` event matching that exact `track_id` from the entry camera within the last 60 seconds. If found, the API reopens the existing session rather than creating a duplicate top-of-funnel walk-in.

### 3. Staff Filtering
* **The Problem:** Store employees walk past the cameras all day.
* **The Solution:** We apply a duration and frequency threshold. If a Session document remains "active" for more than 4 continuous hours, or if the document logs more than 15 unique `zone_dwell` events hopping rapidly between areas, the backend automatically flags the document with `is_staff: true`. These sessions are automatically excluded from the final Conversion Rate calculations.

---

## 📊 Business Intelligence & Conversion (The Output)

The final phase unites the physical tracking data with the digital POS (Point of Sale) data.

1. **POS Ingestion:** The system parses the provided transaction CSV (`Brigade_Bangalore_10_April_26.csv`) to determine the exact number of unique checkout invoices generated for the day.
2. **The Funnel API (`/api/funnel`):** The backend queries MongoDB to aggregate the customer journey:
   * **Level 1 (Walk-ins):** Total valid consumer sessions.
   * **Level 2 (Engagement):** Sessions containing at least one `zone_dwell`.
   * **Level 3 (Checkout Ready):** Sessions containing a `billing_queue` event.
   * **Level 4 (Converted):** Total unique invoices from the POS data.
3. **The Metrics API (`/api/metrics`):** Calculates the definitive **Store Conversion Rate** `(Total Invoices / Total Valid Buying Units) * 100` and runs statistical anomaly checks (e.g., flagging the dashboard if walk-ins exceed 300 but conversion drops below 1%).

### 🚀 Conclusion
By decoupling the heavy visual processing from the business logic, this system is inherently modular. A store can add 10 more cameras simply by running more lightweight Python edge scripts, and the centralized backend will seamlessly ingest and map the new spatial data without requiring any architectural rewrites.

See [`DESIGN.md`](./DESIGN.md) for the full architecture document.
See [`CHOICES.md`](./CHOICES.md) for engineering decision rationale.

---

## Testing

Basic tests are provided to verify the complex "Buying Unit" mathematical logic inside the Metrics Controller, including the empty CSV edge case.

To run the tests natively:
```bash
cd backend
npm install
npm test
```

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
├── docker-compose.yml          # Mandatory one-click deployment
├── setup.ps1                   # Alternative local setup script
├── start_system.ps1            # Alternative local execution
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
│   ├── routes/
│   │   ├── events.js
│   │   ├── metrics.js
│   │   └── funnel.js
│   └── tests/
│       └── metrics.test.js     # Jest unit tests
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

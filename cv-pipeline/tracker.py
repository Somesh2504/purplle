"""
cv-pipeline/tracker.py
======================
Store Intelligence CV Pipeline — Purplle Tech Challenge 2026

Architecture: 4 independent camera workers run sequentially in a tight loop.
              Each worker processes every 5th frame with YOLOv8n + ByteTrack,
              carries forward bounding boxes on skipped frames, and fires
              dumb atomic HTTP webhooks to the backend state machine.

CPU Budget rationale:
  - Frame skip 1-in-5   → ~80% inference reduction
  - YOLOv8 Nano (3.2M)  → lightest detection backbone
  - No ReID network     → zero cross-camera embedding cost
  - Sequential workers  → no GIL contention, predictable memory ceiling
"""

import os
import time
import threading
import datetime
import logging
import json
from pathlib import Path

import cv2
import numpy as np
import requests
from dotenv import load_dotenv
from ultralytics import YOLO

# ──────────────────────────────────────────────────────────────────────────────
# Configuration
# ──────────────────────────────────────────────────────────────────────────────

load_dotenv()

BACKEND_URL = os.getenv("BACKEND_URL", "http://backend:3000")
EVENTS_ENDPOINT = f"{BACKEND_URL}/api/events"
DATA_DIR = Path(os.getenv("DATA_DIR", "/app/data"))
VIDEOS_DIR = DATA_DIR / "videos"

# Inference runs on 1 out of every FRAME_SKIP frames
FRAME_SKIP = 5

# Number of frames a track must dwell inside a zone to trigger zone_dwell
DWELL_THRESHOLD_FRAMES = 45  # ≈ 9 seconds at 5 fps effective rate

# HTTP request timeout — we never want to block the CV loop
HTTP_TIMEOUT_SECONDS = 2

# Logging — structured JSON to stdout (picked up by Docker)
logging.basicConfig(
    level=logging.INFO,
    format="%(message)s",
)
logger = logging.getLogger("cv-pipeline")


def log(level: str, message: str, **kwargs):
    """Emit a structured JSON log line."""
    record = {
        "level": level,
        "message": message,
        "timestamp": datetime.datetime.utcnow().isoformat() + "Z",
        **kwargs,
    }
    print(json.dumps(record), flush=True)


# ──────────────────────────────────────────────────────────────────────────────
# Webhook Emitter
# ──────────────────────────────────────────────────────────────────────────────

def fire_event(event_type: str, track_id: int, camera_id: str, zone_name: str):
    """
    Send a single atomic event webhook to the backend.
    Completely swallows network errors so the CV loop is never interrupted.
    Runs synchronously but with a hard timeout so it can't stall the loop.
    """
    payload = {
        "timestamp": datetime.datetime.utcnow().isoformat() + "Z",
        "event_type": event_type,
        "track_id": int(track_id),
        "camera_id": camera_id,
        "zone_name": zone_name,
    }
    try:
        response = requests.post(
            EVENTS_ENDPOINT,
            json=payload,
            timeout=HTTP_TIMEOUT_SECONDS,
        )
        log(
            "info",
            "Event fired",
            event_type=event_type,
            camera_id=camera_id,
            track_id=int(track_id),
            zone_name=zone_name,
            http_status=response.status_code,
        )
    except requests.exceptions.ConnectionError:
        # Backend not ready yet — silently drop. The CV loop must not crash.
        log("warn", "Backend unreachable — event dropped", event_type=event_type, camera_id=camera_id)
    except requests.exceptions.Timeout:
        log("warn", "Backend timeout — event dropped", event_type=event_type, camera_id=camera_id)
    except Exception as exc:  # noqa: BLE001
        log("error", "Unexpected webhook error", error=str(exc), camera_id=camera_id)


def fire_event_async(event_type: str, track_id: int, camera_id: str, zone_name: str):
    """
    Non-blocking wrapper — dispatches fire_event on a daemon thread so
    the main CV loop is never held waiting for HTTP.
    """
    t = threading.Thread(
        target=fire_event,
        args=(event_type, track_id, camera_id, zone_name),
        daemon=True,
    )
    t.start()


# ──────────────────────────────────────────────────────────────────────────────
# Geometry Helpers
# ──────────────────────────────────────────────────────────────────────────────

def point_in_polygon(point: tuple, polygon: np.ndarray) -> bool:
    """
    Ray-casting algorithm for point-in-convex-polygon test.
    polygon: np.ndarray of shape (N, 2) with dtype int32.
    """
    result = cv2.pointPolygonTest(polygon, (float(point[0]), float(point[1])), False)
    return result >= 0


def crosses_line(prev_y: float, curr_y: float, line_y: float) -> str | None:
    """
    Detect if a point crossed a horizontal line between two consecutive frames.
    Returns 'down' (entry), 'up' (exit), or None.
    """
    if prev_y < line_y <= curr_y:
        return "down"
    if prev_y >= line_y > curr_y:
        return "up"
    return None


# ──────────────────────────────────────────────────────────────────────────────
# Camera Workers
# ──────────────────────────────────────────────────────────────────────────────

def process_entry_cam(model: YOLO, video_path: Path):
    """
    CAMERA: entry_cam.mp4
    Logic  : Virtual horizontal line at 55% of frame height.
             Track bottom-center crossing direction → entry / exit events.

    State  : prev_positions  — {track_id: prev_bottom_center_y}
             crossed_ids     — set of track IDs that already fired to avoid
                               duplicate events on consecutive crossing frames.
    """
    camera_id = "entry_cam"
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        log("error", "Cannot open video", camera_id=camera_id, path=str(video_path))
        return

    frame_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    frame_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    # Virtual line Y coordinate — 55 % down the frame height
    LINE_Y = int(frame_h * 0.55)

    log("info", "Worker started", camera_id=camera_id,
        resolution=f"{frame_w}x{frame_h}", total_frames=total_frames, line_y=LINE_Y)

    frame_idx = 0
    prev_results = None          # carry-forward inference results
    prev_positions: dict = {}    # track_id → last known bottom-center y
    crossed_ids: set = set()     # tracks that already fired this crossing

    while True:
        ret, frame = cap.read()
        if not ret:
            log("info", "Video exhausted", camera_id=camera_id, frames_processed=frame_idx)
            break

        frame_idx += 1
        run_inference = (frame_idx % FRAME_SKIP == 0)

        if run_inference:
            results = model.track(
                frame,
                persist=True,
                classes=[0],         # person only
                verbose=False,
                conf=0.35,
                iou=0.45,
            )
            prev_results = results
        else:
            results = prev_results  # carry forward

        if results is None or results[0].boxes is None:
            continue

        boxes = results[0].boxes
        if boxes.id is None:
            continue

        current_positions: dict = {}

        for box, track_id in zip(boxes.xyxy.cpu().numpy(), boxes.id.cpu().numpy()):
            x1, y1, x2, y2 = box
            bottom_center_y = float(y2)
            current_positions[int(track_id)] = bottom_center_y

        # Evaluate line crossings
        for tid, curr_y in current_positions.items():
            prev_y = prev_positions.get(tid)
            if prev_y is None:
                # First time we see this track — no crossing possible yet
                prev_positions[tid] = curr_y
                continue

            direction = crosses_line(prev_y, curr_y, LINE_Y)

            if direction == "down" and tid not in crossed_ids:
                crossed_ids.add(tid)
                fire_event_async("entry", tid, camera_id, "entrance_door")
            elif direction == "up" and tid not in crossed_ids:
                crossed_ids.add(tid)
                fire_event_async("exit", tid, camera_id, "entrance_door")
            elif direction is None and tid in crossed_ids:
                # Track has moved away from line — reset so it can cross again
                if abs(curr_y - LINE_Y) > frame_h * 0.1:
                    crossed_ids.discard(tid)

            prev_positions[tid] = curr_y

        # Prune stale track IDs from state dicts
        active_ids = set(current_positions.keys())
        stale = set(prev_positions.keys()) - active_ids
        for tid in stale:
            prev_positions.pop(tid, None)
            crossed_ids.discard(tid)

    cap.release()
    log("info", "Worker finished", camera_id=camera_id)


def process_zone_cam(model: YOLO, video_path: Path, camera_id: str, zone_name: str,
                     polygon_pct: list[tuple[float, float]]):
    """
    CAMERA: zone_1.mp4 (Makeup Unit) and zone_2.mp4 (DermDoc)
    Logic  : Polygon dwell detection.
             If a track ID's centroid spends DWELL_THRESHOLD_FRAMES consecutive
             frames inside the polygon, fire a zone_dwell event.
             Resets counter when track leaves the polygon.

    polygon_pct: list of (x_pct, y_pct) tuples — percentages of frame size.
                 Expressed as percentages so the pipeline works regardless of
                 the exact video resolution.
    """
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        log("error", "Cannot open video", camera_id=camera_id, path=str(video_path))
        return

    frame_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    frame_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    # Convert percentage polygon to absolute pixel coordinates
    polygon = np.array(
        [(int(x * frame_w), int(y * frame_h)) for x, y in polygon_pct],
        dtype=np.int32,
    )

    log("info", "Worker started", camera_id=camera_id, zone=zone_name,
        resolution=f"{frame_w}x{frame_h}", total_frames=total_frames,
        polygon_px=polygon.tolist())

    frame_idx = 0
    prev_results = None
    dwell_counters: dict = {}    # track_id → consecutive frames inside zone
    already_fired: set = set()   # track IDs that already triggered dwell this visit

    while True:
        ret, frame = cap.read()
        if not ret:
            log("info", "Video exhausted", camera_id=camera_id, frames_processed=frame_idx)
            break

        frame_idx += 1
        run_inference = (frame_idx % FRAME_SKIP == 0)

        if run_inference:
            results = model.track(
                frame,
                persist=True,
                classes=[0],
                verbose=False,
                conf=0.35,
                iou=0.45,
            )
            prev_results = results
        else:
            results = prev_results

        if results is None or results[0].boxes is None:
            continue

        boxes = results[0].boxes
        if boxes.id is None:
            continue

        active_ids_this_frame: set = set()

        for box, track_id in zip(boxes.xyxy.cpu().numpy(), boxes.id.cpu().numpy()):
            tid = int(track_id)
            x1, y1, x2, y2 = box
            centroid = ((x1 + x2) / 2, (y1 + y2) / 2)
            active_ids_this_frame.add(tid)

            inside = point_in_polygon(centroid, polygon)

            if inside:
                dwell_counters[tid] = dwell_counters.get(tid, 0) + 1
                if (dwell_counters[tid] >= DWELL_THRESHOLD_FRAMES
                        and tid not in already_fired):
                    already_fired.add(tid)
                    fire_event_async("zone_dwell", tid, camera_id, zone_name)
            else:
                # Track left the zone — reset state so it can trigger again
                # if it re-enters (e.g. briefly stepped out then came back)
                if tid in dwell_counters:
                    dwell_counters[tid] = 0
                already_fired.discard(tid)

        # Clean up stale tracks
        stale = set(dwell_counters.keys()) - active_ids_this_frame
        for tid in stale:
            dwell_counters.pop(tid, None)
            already_fired.discard(tid)

    cap.release()
    log("info", "Worker finished", camera_id=camera_id, zone=zone_name)


def process_billing_cam(model: YOLO, video_path: Path):
    """
    CAMERA: billing.mp4
    Logic  : Rectangular ROI boundary detection.
             Any track whose centroid enters the billing boundary fires a
             billing_queue event (once per track visit — resets on exit).

    The billing queue is a horizontal strip across the lower-middle portion
    of the frame, expressed as percentages.
    """
    camera_id = "billing"
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        log("error", "Cannot open video", camera_id=camera_id, path=str(video_path))
        return

    frame_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    frame_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    # Billing queue ROI — a rectangular region expressed as % of frame
    # Covers the central-lower 40% width × 35% height band of the frame
    # where a typical billing counter queue forms.
    ROI_X1 = int(frame_w * 0.20)
    ROI_Y1 = int(frame_h * 0.45)
    ROI_X2 = int(frame_w * 0.80)
    ROI_Y2 = int(frame_h * 0.80)

    log("info", "Worker started", camera_id=camera_id,
        resolution=f"{frame_w}x{frame_h}", total_frames=total_frames,
        roi=f"({ROI_X1},{ROI_Y1})-({ROI_X2},{ROI_Y2})")

    frame_idx = 0
    prev_results = None
    in_queue: set = set()      # track IDs currently inside billing ROI
    already_fired: set = set() # fired this visit — reset on ROI exit

    while True:
        ret, frame = cap.read()
        if not ret:
            log("info", "Video exhausted", camera_id=camera_id, frames_processed=frame_idx)
            break

        frame_idx += 1
        run_inference = (frame_idx % FRAME_SKIP == 0)

        if run_inference:
            results = model.track(
                frame,
                persist=True,
                classes=[0],
                verbose=False,
                conf=0.35,
                iou=0.45,
            )
            prev_results = results
        else:
            results = prev_results

        if results is None or results[0].boxes is None:
            continue

        boxes = results[0].boxes
        if boxes.id is None:
            continue

        active_ids_this_frame: set = set()

        for box, track_id in zip(boxes.xyxy.cpu().numpy(), boxes.id.cpu().numpy()):
            tid = int(track_id)
            x1, y1, x2, y2 = box
            cx = (x1 + x2) / 2
            cy = (y1 + y2) / 2
            active_ids_this_frame.add(tid)

            inside_roi = (ROI_X1 <= cx <= ROI_X2) and (ROI_Y1 <= cy <= ROI_Y2)

            if inside_roi:
                in_queue.add(tid)
                if tid not in already_fired:
                    already_fired.add(tid)
                    fire_event_async("billing_queue", tid, camera_id, "billing_counter")
            else:
                if tid in in_queue:
                    in_queue.discard(tid)
                    already_fired.discard(tid)

        # Prune tracks that disappeared from the frame entirely
        stale = in_queue - active_ids_this_frame
        for tid in stale:
            in_queue.discard(tid)
            already_fired.discard(tid)

    cap.release()
    log("info", "Worker finished", camera_id=camera_id)


# ──────────────────────────────────────────────────────────────────────────────
# Startup Readiness Check
# ──────────────────────────────────────────────────────────────────────────────

def wait_for_backend(max_retries: int = 15, delay: float = 5.0):
    """
    Poll /api/health until the backend is ready before starting CV processing.
    This prevents the pipeline from firing thousands of events into a deaf socket
    during the backend's own startup sequence.
    """
    health_url = f"{BACKEND_URL}/api/health"
    for attempt in range(1, max_retries + 1):
        try:
            r = requests.get(health_url, timeout=3)
            if r.status_code == 200:
                log("info", "Backend is healthy — starting CV pipeline",
                    attempt=attempt, status=r.json().get("status"))
                return
        except Exception:  # noqa: BLE001
            pass
        log("warn", "Backend not ready — retrying",
            attempt=attempt, max_retries=max_retries, retry_in_sec=delay)
        time.sleep(delay)

    log("warn", "Backend health check timed out — proceeding anyway")


# ──────────────────────────────────────────────────────────────────────────────
# Zone Polygon Definitions
# ──────────────────────────────────────────────────────────────────────────────
#
# All polygons are defined as (x_pct, y_pct) pairs — fractions of frame size.
# This makes the pipeline resolution-agnostic.
#
# Zone 1: Makeup Unit — left-centre region of zone_1.mp4
# Zone 2: DermDoc     — right-centre region of zone_2.mp4
#
# These are sensible defaults based on typical store-camera placements.
# Fine-tune these values once you have the actual video to inspect frame dims.

ZONE_1_POLYGON_PCT = [
    (0.10, 0.20),
    (0.65, 0.20),
    (0.65, 0.90),
    (0.10, 0.90),
]

ZONE_2_POLYGON_PCT = [
    (0.15, 0.15),
    (0.80, 0.15),
    (0.80, 0.85),
    (0.15, 0.85),
]


# ──────────────────────────────────────────────────────────────────────────────
# Main Entrypoint
# ──────────────────────────────────────────────────────────────────────────────

def main():
    log("info", "CV Pipeline initialising",
        backend_url=BACKEND_URL,
        frame_skip=FRAME_SKIP,
        dwell_threshold_frames=DWELL_THRESHOLD_FRAMES)

    # ── Wait for backend to be healthy ────────────────
    wait_for_backend()

    # ── Verify video files exist ───────────────────────
    video_map = {
        "entry_cam": VIDEOS_DIR / "entry_cam.mp4",
        "zone_1":    VIDEOS_DIR / "zone_1.mp4",
        "zone_2":    VIDEOS_DIR / "zone_2.mp4",
        "billing":   VIDEOS_DIR / "billing.mp4",
    }

    missing = [name for name, path in video_map.items() if not path.exists()]
    if missing:
        log("error", "Missing video files — cannot proceed", missing=missing,
            videos_dir=str(VIDEOS_DIR))
        raise FileNotFoundError(f"Missing videos: {missing}")

    # ── Load model once — shared across all workers ────
    # YOLOv8n.pt was pre-downloaded at Docker build time.
    log("info", "Loading YOLOv8 Nano model")
    model = YOLO("yolov8n.pt")

    # Force CPU explicitly — prevents accidental CUDA attempts that would
    # crash on standard evaluation hardware.
    model.to("cpu")
    log("info", "Model loaded on CPU")

    # ──────────────────────────────────────────────────
    # Sequential Processing Strategy
    # ──────────────────────────────────────────────────
    # We process each camera sequentially (not in parallel threads) because:
    #   1. Python GIL means true CPU parallelism requires multiprocessing,
    #      which quadruples peak memory (each process loads YOLO separately).
    #   2. Sequential + frame-skipping is deterministic and easy to reason about.
    #   3. All 4 videos are pre-recorded files, not live streams — sequential
    #      processing of the entire video is perfectly valid.
    #
    # Execution order mirrors the customer journey:
    #   entry → zone_1 → zone_2 → billing

    log("info", "Processing entry_cam.mp4")
    process_entry_cam(model, video_map["entry_cam"])

    log("info", "Processing zone_1.mp4 (Makeup Unit)")
    process_zone_cam(
        model,
        video_map["zone_1"],
        camera_id="zone_1",
        zone_name="makeup_unit",
        polygon_pct=ZONE_1_POLYGON_PCT,
    )

    log("info", "Processing zone_2.mp4 (DermDoc)")
    process_zone_cam(
        model,
        video_map["zone_2"],
        camera_id="zone_2",
        zone_name="dermdoc_section",
        polygon_pct=ZONE_2_POLYGON_PCT,
    )

    log("info", "Processing billing.mp4 (Billing Counter)")
    process_billing_cam(model, video_map["billing"])

    log("info", "All cameras processed — CV Pipeline complete")


if __name__ == "__main__":
    main()

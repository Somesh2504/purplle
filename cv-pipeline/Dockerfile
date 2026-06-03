FROM python:3.10-slim

# ─── System dependencies required by OpenCV ────────
# libglib2.0-0  : GLib runtime (used internally by OpenCV)
# libgl1-mesa-glx: OpenGL (required even for headless video decoding)
# libgthread-2.0-0: GLib threading support
# --no-install-recommends keeps the layer lean
RUN apt-get update && apt-get install -y --no-install-recommends \
        libglib2.0-0 \
        libgl1-mesa-glx \
        libgthread-2.0-0 \
        libsm6 \
        libxext6 \
        libxrender1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ─── Python dependencies ───────────────────────────
# Copy requirements first to exploit Docker layer caching.
# A source-code change won't bust the pip install layer.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the YOLOv8 Nano weights at build time.
# This avoids a cold-start network download inside the container
# and guarantees the model is available on air-gapped test machines.
RUN python -c "from ultralytics import YOLO; YOLO('yolov8n.pt')"

# ─── Application source ────────────────────────────
COPY . .

# /app/data is the mount-point for video files (from docker-compose volume)
RUN mkdir -p /app/data/videos

# No exposed port — this is a pure worker container.
# It only makes outbound HTTP calls to the backend service.

CMD ["python", "-u", "tracker.py"]

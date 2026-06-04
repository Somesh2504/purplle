"""
cv-pipeline/setup_camera.py
Visual setup tool for configuring the entrance tripwire line.

Usage:
    python setup_camera.py

A window will open showing the first frame of your entry camera.
Click where the door threshold is to draw a green line.
Press ENTER to save, or ESC to cancel.
"""

import cv2
import json
import os
from pathlib import Path

# ── Paths ──────────────────────────────────────────────────────────────────────
DATA_DIR = Path(os.getenv("DATA_DIR", str(Path(__file__).resolve().parent.parent / "data")))
VIDEO_PATH = DATA_DIR / "videos" / "entry_cam.mp4"
CONFIG_PATH = DATA_DIR / "camera_config.json"
PREVIEW_PATH = DATA_DIR / "setup_preview.jpg"

# ── State ──────────────────────────────────────────────────────────────────────
state = {"clicked_y": None}

def draw_frame(base_frame, y=None):
    """Return a copy of base_frame with optional tripwire drawn on it."""
    img = base_frame.copy()
    h, w = img.shape[:2]

    if y is not None:
        cv2.line(img, (0, y), (w, y), (0, 255, 0), 2)
        label = f"Tripwire at {y}px  ({y/h*100:.1f}%)  --  Press ENTER to save, ESC to cancel"
        cv2.putText(img, label, (20, y - 12 if y > 40 else y + 24),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.65, (0, 255, 0), 2, cv2.LINE_AA)
    else:
        cv2.putText(img, "Click on the door to place the tripwire line",
                    (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.75, (0, 0, 255), 2, cv2.LINE_AA)
        cv2.putText(img, "Then press ENTER to save  |  ESC to cancel",
                    (20, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255, 255, 255), 2, cv2.LINE_AA)
    return img

def mouse_callback(event, x, y, flags, userdata):
    base_frame = userdata
    if event == cv2.EVENT_LBUTTONDOWN:
        state["clicked_y"] = y
        img = draw_frame(base_frame, y)
        cv2.imshow("Purplle Camera Setup", img)

def main():
    print("=" * 60)
    print("  Purplle Camera Setup — Entrance Tripwire Configurator")
    print("=" * 60)
    print(f"\nOpening video: {VIDEO_PATH}")

    if not VIDEO_PATH.exists():
        print(f"\n[ERROR] Video not found: {VIDEO_PATH}")
        print("Make sure entry_cam.mp4 is in the data/videos/ folder.")
        return

    cap = cv2.VideoCapture(str(VIDEO_PATH))
    if not cap.isOpened():
        print("[ERROR] Could not open video file.")
        return

    ret, base_frame = cap.read()
    cap.release()

    if not ret:
        print("[ERROR] Could not read first frame from video.")
        return

    h, w = base_frame.shape[:2]
    print(f"Video resolution: {w}x{h}")

    # Save a preview image so user can inspect it even if the window won't show
    cv2.imwrite(str(PREVIEW_PATH), base_frame)
    print(f"Preview saved to: {PREVIEW_PATH}")

    # Build the window
    win_name = "Purplle Camera Setup"
    cv2.namedWindow(win_name, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(win_name, min(w, 1280), min(h, 720))

    # Pass base_frame as userdata so the callback can redraw it
    cv2.setMouseCallback(win_name, mouse_callback, base_frame)

    print("\n>>> A window has opened. Click on the door threshold in the image.")
    print(">>> Press ENTER to save | ESC to cancel | Q to quit without saving\n")

    # Show initial frame
    cv2.imshow(win_name, draw_frame(base_frame))
    cv2.setWindowProperty(win_name, cv2.WND_PROP_TOPMOST, 1)  # bring to front

    while True:
        key = cv2.waitKey(100) & 0xFF   # 100ms poll — gives OS time to render events
        if cv2.getWindowProperty(win_name, cv2.WND_PROP_VISIBLE) < 1:
            # Window was closed with the X button
            print("Window closed — setup cancelled.")
            break
        if key in (13, 10):  # ENTER
            break
        if key in (27, ord("q"), ord("Q")):  # ESC or Q
            print("Setup cancelled.")
            cv2.destroyAllWindows()
            return

    cv2.destroyAllWindows()

    if state["clicked_y"] is None:
        print("\nNo tripwire was placed. Configuration not saved.")
        print(f"TIP: A preview image was saved to {PREVIEW_PATH}")
        print("     Open it, note the Y pixel position you want, and re-run this script.")
        return

    # Save as percentage so it works regardless of resolution
    y_pct = state["clicked_y"] / h
    config = {"entry_cam": {"line_y_pct": round(y_pct, 6)}}

    with open(CONFIG_PATH, "w") as f:
        json.dump(config, f, indent=4)

    print(f"\n[SUCCESS] Tripwire saved!")
    print(f"  Pixel position : {state['clicked_y']}px  ({y_pct*100:.1f}% from top)")
    print(f"  Config file    : {CONFIG_PATH}")
    print("\nRun .\\start_system.ps1 — the AI will now use your custom door line.")


if __name__ == "__main__":
    main()

"use strict";

/**
 * controllers/eventController.js
 * ═══════════════════════════════
 * The State Machine Brain.
 *
 * Receives atomic CV webhook payloads and orchestrates them into coherent
 * CustomerSession documents. All temporal logic lives here — the CV pipeline
 * is intentionally kept "dumb" and fires individual events without any
 * cross-camera or cross-time awareness.
 *
 * Business rules implemented:
 *   A. Re-Entry Stitching    — reopens a recently-closed session instead of
 *                              creating a duplicate walk-in count.
 *   B. Timeline Enrichment   — zone_dwell / billing_queue appended to the
 *                              most recent active session.
 *   C. Group Detection       — ≥3 entries within 1.5 s → shared group_id.
 *   D. Staff Heuristic       — >4 h dwell OR >15 zone events → is_staff=true.
 */

const Session = require("../models/Session");
const { v4: uuidv4 } = require("uuid");

// ─── Constants ────────────────────────────────────────────────────────────────

// A. Re-Entry: if the last exit was within this window we reopen the session
const REENTRY_WINDOW_MS = 60 * 1000; // 60 seconds

// C. Group Detection: entries within this window are considered a group
const GROUP_WINDOW_MS = 1500; // 1.5 seconds

// Minimum group size to stamp a group_id
const GROUP_MIN_SIZE = 3;

// ─── In-Memory Group Detection Buffer ────────────────────────────────────────
// We hold a short rolling buffer of recent entry events (just session_ids and
// timestamps). This is intentionally in-memory because:
//   1. Group detection window is 1.5 s — far too short for a DB round-trip.
//   2. The data is ephemeral — we only need it to stamp group_id, after which
//      it is persisted in MongoDB.
//   3. This is a single-process Node.js server — no distributed state issues.
//
// Buffer entry shape: { session_id: String, timestamp: Date }
const recentEntryBuffer = [];

/**
 * Prune entries older than GROUP_WINDOW_MS from the front of the buffer.
 * Call this before every group check to keep the buffer lean.
 */
function pruneEntryBuffer(now) {
  const cutoff = new Date(now.getTime() - GROUP_WINDOW_MS);
  while (recentEntryBuffer.length > 0 && recentEntryBuffer[0].timestamp < cutoff) {
    recentEntryBuffer.shift();
  }
}

// ─── Helper: structured log ───────────────────────────────────────────────────
function log(level, message, meta = {}) {
  console.log(
    JSON.stringify({
      level,
      message,
      timestamp: new Date().toISOString(),
      ...meta,
    })
  );
}

// ─── Handler: Entry Event ─────────────────────────────────────────────────────
/**
 * Rule A — Re-Entry Stitching
 * ───────────────────────────
 * Query: find the most recent session for this track_id whose status is
 * "completed" AND whose end_time is within the last REENTRY_WINDOW_MS.
 *
 * If found  → reopen it (status → "active", clear end_time, append timeline).
 * If not    → create a fresh Session document.
 *
 * We also check "active" sessions: if the same track_id has an already-open
 * session (e.g. a duplicate entry webhook), we append to it rather than
 * creating a second session.
 *
 * Rule C — Group Detection
 * ────────────────────────
 * After creating/reopening a session, push its session_id into the in-memory
 * buffer. If the buffer now holds ≥ GROUP_MIN_SIZE entries, all of them belong
 * to a group. Generate a UUID group_id and bulk-update all matching docs.
 */
async function handleEntry(payload, eventTimestamp) {
  const { track_id, camera_id, zone_name } = payload;

  const timelineEntry = {
    event_type: "entry",
    camera_id,
    zone_name: zone_name || null,
    track_id,
    timestamp: eventTimestamp,
  };

  // ── Check 1: Already-active session for this track_id ──────────────────
  let session = await Session.findOne({
    primary_track_id: track_id,
    status: "active",
  }).sort({ start_time: -1 });

  if (session) {
    // Duplicate entry webhook — enrich timeline but do not open a new session
    session.timeline.push(timelineEntry);
    session.checkStaffHeuristic();
    await session.save();

    log("info", "Duplicate entry — enriched existing active session", {
      session_id: session.session_id,
      track_id,
    });
    return session;
  }

  // ── Check 2: Recently-completed session → Re-Entry ──────────────────────
  const reentryWindowStart = new Date(eventTimestamp.getTime() - REENTRY_WINDOW_MS);

  const recentlyClosed = await Session.findOne({
    primary_track_id: track_id,
    status: "completed",
    end_time: { $gte: reentryWindowStart },
  }).sort({ end_time: -1 });

  if (recentlyClosed) {
    // Reopen — customer stepped out briefly (e.g. glanced outside) and returned
    recentlyClosed.status = "active";
    recentlyClosed.end_time = null;
    recentlyClosed.timeline.push(timelineEntry);
    recentlyClosed.checkStaffHeuristic();
    await recentlyClosed.save();

    log("info", "Re-entry detected — session reopened", {
      session_id: recentlyClosed.session_id,
      track_id,
      original_end_time: recentlyClosed.end_time,
    });

    // Re-entry counts for group detection too — push to buffer
    pushToGroupBuffer(recentlyClosed.session_id, eventTimestamp);
    await runGroupDetection(eventTimestamp);

    return recentlyClosed;
  }

  // ── Check 3: Brand new session ──────────────────────────────────────────
  session = new Session({
    primary_track_id: track_id,
    start_time: eventTimestamp,
    status: "active",
    timeline: [timelineEntry],
  });

  await session.save();

  log("info", "New session created", {
    session_id: session.session_id,
    track_id,
  });

  // Group detection
  pushToGroupBuffer(session.session_id, eventTimestamp);
  await runGroupDetection(eventTimestamp);

  return session;
}

// ─── Handler: Exit Event ──────────────────────────────────────────────────────
/**
 * Find the most recent active session for this track_id and close it.
 * We do NOT delete — completed sessions are the source of truth for
 * conversion rate calculations.
 */
async function handleExit(payload, eventTimestamp) {
  const { track_id, camera_id, zone_name } = payload;

  const session = await Session.findOne({
    primary_track_id: track_id,
    status: "active",
  }).sort({ start_time: -1 });

  if (!session) {
    // Exit without a matching entry — orphan event (common at video start if
    // someone was already in the store when recording began). Log and discard.
    log("warn", "Exit event received but no active session found — orphan discarded", {
      track_id,
      camera_id,
    });
    return null;
  }

  session.status = "completed";
  session.end_time = eventTimestamp;
  session.timeline.push({
    event_type: "exit",
    camera_id,
    zone_name: zone_name || null,
    track_id,
    timestamp: eventTimestamp,
  });

  session.checkStaffHeuristic();
  await session.save();

  log("info", "Session completed on exit", {
    session_id: session.session_id,
    track_id,
    dwell_minutes: session.dwell_duration_minutes,
    is_staff: session.is_staff,
  });

  return session;
}

// ─── Handler: Zone Dwell & Billing Queue ─────────────────────────────────────
/**
 * Rule B — Timeline Enrichment
 * ────────────────────────────
 * Find the most recently started ACTIVE session and append this zone event
 * to its timeline.
 *
 * We intentionally do NOT match by track_id here. Zone camera track IDs are
 * independent integers (each camera has its own ByteTrack instance) and cannot
 * be reliably correlated to entry_cam track IDs without a ReID model.
 *
 * Instead we use temporal proximity: the most recently started active session
 * is the most likely candidate to be in a zone. This is the core of our
 * "session-based strategy" — push complexity to the backend, not the CV model.
 *
 * For higher accuracy in a production system, you would also pass bounding box
 * centroids and use the last known position — but for this challenge, temporal
 * matching is both sufficient and explainable.
 */
async function handleZoneEvent(payload, eventTimestamp) {
  const { track_id, camera_id, zone_name, event_type } = payload;

  // Find the most recent active session — temporal proximity match
  const session = await Session.findOne({ status: "active", is_staff: false })
    .sort({ start_time: -1 });

  if (!session) {
    log("warn", "Zone event received but no active consumer session found — discarded", {
      event_type,
      camera_id,
      zone_name,
    });
    return null;
  }

  session.timeline.push({
    event_type,
    camera_id,
    zone_name: zone_name || camera_id,
    track_id,
    timestamp: eventTimestamp,
  });

  // Re-evaluate staff heuristic after every timeline append
  session.checkStaffHeuristic();
  await session.save();

  log("info", "Zone event appended to session timeline", {
    session_id: session.session_id,
    event_type,
    zone_name,
    timeline_length: session.timeline.length,
    is_staff: session.is_staff,
  });

  return session;
}

// ─── Group Detection Helpers ──────────────────────────────────────────────────

function pushToGroupBuffer(session_id, timestamp) {
  recentEntryBuffer.push({ session_id, timestamp });
}

/**
 * Rule C — Group Detection
 * ────────────────────────
 * After pruning stale entries from the buffer, if ≥ GROUP_MIN_SIZE entries
 * remain (all within GROUP_WINDOW_MS of each other), generate a UUID group_id
 * and bulk-stamp it on all matching Session documents.
 *
 * A session that already has a group_id is not overwritten — this handles the
 * edge case where a 4th person joins a group that was already stamped.
 */
async function runGroupDetection(now) {
  pruneEntryBuffer(now);

  if (recentEntryBuffer.length < GROUP_MIN_SIZE) return;

  // Generate a single group_id for this cohort
  const group_id = `grp_${uuidv4()}`;

  const session_ids = recentEntryBuffer.map((e) => e.session_id);

  const result = await Session.updateMany(
    {
      session_id: { $in: session_ids },
      group_id: null, // don't overwrite an already-stamped group
    },
    { $set: { group_id } }
  );

  if (result.modifiedCount > 0) {
    log("info", "Group detected — group_id stamped across sessions", {
      group_id,
      session_ids,
      members_stamped: result.modifiedCount,
    });
  }

  // Clear buffer — these sessions are now stamped, prevent re-processing
  recentEntryBuffer.length = 0;
}

// ─── Main Route Handler ───────────────────────────────────────────────────────
/**
 * POST /api/events
 * ────────────────
 * Entry point called by the Express router.
 * Validates the payload, routes to the appropriate handler, and returns a
 * standardised 202 Accepted response.
 *
 * We use 202 (Accepted) rather than 200 (OK) because event processing is
 * asynchronous from the CV pipeline's perspective — the pipeline fires and
 * forgets. Using 202 accurately signals this contract.
 */
async function recordEvent(req, res) {
  try {
    const { event_type, camera_id, timestamp, track_id, zone_name } = req.body;

    // ── Input Validation ──────────────────────────────────────────────────
    if (!event_type || !camera_id || !timestamp || track_id === undefined) {
      return res.status(400).json({
        error: "Missing required fields: event_type, camera_id, timestamp, track_id",
      });
    }

    const validEventTypes = ["entry", "exit", "zone_dwell", "billing_queue"];
    if (!validEventTypes.includes(event_type)) {
      return res.status(400).json({
        error: `Invalid event_type. Must be one of: ${validEventTypes.join(", ")}`,
      });
    }

    const validCameras = ["entry_cam", "zone_1", "zone_2", "billing"];
    if (!validCameras.includes(camera_id)) {
      return res.status(400).json({
        error: `Invalid camera_id. Must be one of: ${validCameras.join(", ")}`,
      });
    }

    // Parse timestamp — accept ISO strings from the CV pipeline
    const eventTimestamp = new Date(timestamp);
    if (isNaN(eventTimestamp.getTime())) {
      return res.status(400).json({ error: "Invalid timestamp format. Use ISO-8601." });
    }

    // ── Route to appropriate handler ──────────────────────────────────────
    let session = null;

    switch (event_type) {
      case "entry":
        session = await handleEntry(req.body, eventTimestamp);
        break;

      case "exit":
        session = await handleExit(req.body, eventTimestamp);
        break;

      case "zone_dwell":
      case "billing_queue":
        session = await handleZoneEvent(req.body, eventTimestamp);
        break;
    }

    // ── Response ──────────────────────────────────────────────────────────
    return res.status(202).json({
      status: "accepted",
      event_type,
      session_id: session?.session_id || null,
      session_status: session?.status || null,
      is_staff: session?.is_staff || false,
    });
  } catch (err) {
    log("error", "Unhandled error in recordEvent", {
      error: err.message,
      stack: err.stack,
    });
    return res.status(500).json({ error: "Internal server error" });
  }
}

module.exports = { recordEvent };

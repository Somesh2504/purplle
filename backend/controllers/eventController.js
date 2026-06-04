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
 * WebSocket Push:
 *   After every DB write, we emit a 'live_event' via Socket.io so the
 *   dashboard updates instantly without any polling delay.
 *
 * Session Scoping:
 *   Every session and event is tagged with the server's session_id so
 *   the dashboard only sees data from the current live run.
 *
 * Business rules implemented:
 *   A. Re-Entry Stitching    — reopens a recently-closed session instead of
 *                              creating a duplicate walk-in count.
 *   B. Timeline Enrichment   — zone_dwell / billing_queue appended to the
 *                              most recent active session.
 *   C. Group Detection       — ≥2 entries within 2.0 s on same store+camera
 *                              → shared group_id ("Buying Unit").
 *   D. Staff Heuristic       — >4 h dwell OR >50 zone events → is_staff=true.
 */

const Session = require("../models/Session");
const { v4: uuidv4 } = require("uuid");

// ─── Constants ────────────────────────────────────────────────────────────────

// A. Re-Entry: if the last exit was within this window we reopen the session
const REENTRY_WINDOW_MS = 60 * 1000; // 60 seconds

// C. Group Detection: entries within this window are considered a group
const GROUP_WINDOW_MS = 2000; // 2.0 seconds

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
 * Rule C — Group Detection (DB-based, 2.0s window)
 * ───────────────────────────────────────────────
 * After creating/reopening a session, query MongoDB for any other sessions
 * created at the SAME store within the last 2.0 seconds. If a neighbour is
 * found, they share a group_id (friends/family walking in together).
 * This replaces the old in-memory buffer approach and survives server restarts.
 */
async function handleEntry(payload, eventTimestamp, sessionId) {
  const { track_id, camera_id, zone_name } = payload;

  const timelineEntry = {
    event_type: "entry",
    camera_id,
    zone_name: zone_name || null,
    track_id,
    timestamp: eventTimestamp,
  };

  // ── Check 1: Already-active session for this track_id (current run only) ──
  let session = await Session.findOne({
    primary_track_id: track_id,
    status: "active",
    run_session_id: sessionId,
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
    run_session_id: sessionId,
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

    // Re-entry counts for group detection too
    await detectGroupWalkin(recentlyClosed, camera_id, eventTimestamp, sessionId);

    return recentlyClosed;
  }

  // ── Check 3: Brand new session ──────────────────────────────────────────
  session = new Session({
    primary_track_id: track_id,
    start_time: eventTimestamp,
    status: "active",
    timeline: [timelineEntry],
    run_session_id: sessionId,
  });

  await session.save();

  log("info", "New session created", {
    session_id: session.session_id,
    track_id,
  });

  // ── Group Detection (DB-based) ───────────────────────────────────
  await detectGroupWalkin(session, camera_id, eventTimestamp, sessionId);

  return session;
}

// ─── Handler: Exit Event ──────────────────────────────────────────────────────
/**
 * Find the most recent active session for this track_id and close it.
 * We do NOT delete — completed sessions are the source of truth for
 * conversion rate calculations.
 */
async function handleExit(payload, eventTimestamp, sessionId) {
  const { track_id, camera_id, zone_name } = payload;

  const session = await Session.findOne({
    primary_track_id: track_id,
    status: "active",
    run_session_id: sessionId,
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
async function handleZoneEvent(payload, eventTimestamp, sessionId) {
  const { track_id, camera_id, zone_name, event_type } = payload;

  // Find the most recent active session — temporal proximity match (current run only)
  // NOTE: We intentionally do NOT filter by is_staff here. If a session has
  // already been flagged as staff, it should keep absorbing zone events rather
  // than cascading them to the next session (which would then also get flagged).
  const session = await Session.findOne({
    status: "active",
    run_session_id: sessionId,
  })
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

// ─── Group Detection: DB-Based Temporal Query ──────────────────────────────

/**
 * Rule C — Group Walk-in Detection
 * ────────────────────────────────
 * When a new entry event creates a session, query MongoDB for other sessions
 * at the SAME store_id + SAME entry camera that were created within the last
 * GROUP_WINDOW_MS (2.0 seconds). If any neighbours are found:
 *
 *   Case A: Neighbour already has a group_id → copy it to the new session.
 *   Case B: Neighbour has no group_id → generate a new UUID, stamp BOTH.
 *
 * This ensures friends/families entering together are counted as a single
 * "buying unit" for conversion rate math.
 *
 * Why DB-based instead of in-memory:
 *   - Survives server restarts and process crashes.
 *   - Works in multi-process / clustered deployments.
 *   - GROUP_WINDOW_MS is 2000ms — a single indexed MongoDB query takes <5ms,
 *     so there's no latency concern.
 */
async function detectGroupWalkin(newSession, camera_id, eventTimestamp, runSessionId) {
  const windowStart = new Date(eventTimestamp.getTime() - GROUP_WINDOW_MS);

  // Find any other session created at the same store within the 2s window
  // Exclude the session we just created (by _id)
  const neighbour = await Session.findOne({
    _id: { $ne: newSession._id },
    store_id: newSession.store_id,
    run_session_id: runSessionId,
    start_time: { $gte: windowStart, $lte: eventTimestamp },
    // Only match sessions that entered via the same camera
    "timeline.0.camera_id": camera_id,
  }).sort({ start_time: -1 });

  if (!neighbour) return; // No temporal neighbour — solo walk-in

  // Determine which group_id to use
  let groupId;

  if (neighbour.group_id) {
    // Case A: neighbour is already part of a group → join it
    groupId = neighbour.group_id;
  } else {
    // Case B: neither has a group_id → create a new one, stamp both
    groupId = `grp_${uuidv4()}`;
    neighbour.group_id = groupId;
    await neighbour.save();
  }

  // Stamp the new session
  newSession.group_id = groupId;
  await newSession.save();

  // Also stamp any OTHER sessions in this window that may not have the group_id yet
  // (handles 3+ people entering together over multiple webhook firings)
  await Session.updateMany(
    {
      _id: { $ne: newSession._id },
      store_id: newSession.store_id,
      run_session_id: runSessionId,
      start_time: { $gte: windowStart, $lte: eventTimestamp },
      "timeline.0.camera_id": camera_id,
      group_id: null,
    },
    { $set: { group_id: groupId } }
  );

  log("info", "Group walk-in detected", {
    group_id: groupId,
    new_session_id: newSession.session_id,
    neighbour_session_id: neighbour.session_id,
    window_ms: GROUP_WINDOW_MS,
  });
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

    // ── Get Socket.io instance and run session_id from app.locals ─────────
    const io = req.app.locals.io;
    const runSessionId = req.app.locals.session_id;

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
        session = await handleEntry(req.body, eventTimestamp, runSessionId);
        break;

      case "exit":
        session = await handleExit(req.body, eventTimestamp, runSessionId);
        break;

      case "zone_dwell":
      case "billing_queue":
        session = await handleZoneEvent(req.body, eventTimestamp, runSessionId);
        break;
    }

    // ── WebSocket Push — broadcast live event to all dashboard clients ────
    // This is the key: we push to the dashboard the INSTANT the DB is written.
    // Dashboard does NOT need to poll — it reacts to this event immediately.
    if (io && session) {
      io.emit("live_event", {
        event_type,
        camera_id,
        zone_name: zone_name || null,
        track_id: parseInt(track_id),
        session_id: session.session_id,
        session_status: session.status,
        is_staff: session.is_staff,
        group_id: session.group_id || null,
        timestamp: eventTimestamp.toISOString(),
        run_session_id: runSessionId,
      });
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

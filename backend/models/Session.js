"use strict";

/**
 * models/Session.js
 * ═════════════════
 * Represents one complete visit by a single customer (or staff member)
 * to the store. A session is opened on an "entry" event, enriched by
 * downstream zone/billing events, and closed on an "exit" event.
 *
 * Design note — why one Session per person, not per track_id:
 *   YOLO track IDs are camera-local integers that reset when the tracker
 *   loses a bounding box (occlusion, lighting change, etc.). The re-entry
 *   logic in eventController.js re-stitches broken tracks into the SAME
 *   session document, so the session represents the person, not the track.
 */

const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

// ─── Timeline Sub-Document ────────────────────────────────────────────────────
// Each entry records one atomic event fired by the CV pipeline.
// We deliberately keep this flat and append-only — no updates inside the array.
const timelineEventSchema = new mongoose.Schema(
  {
    event_type: {
      type: String,
      enum: ["entry", "exit", "zone_dwell", "billing_queue"],
      required: true,
    },
    camera_id: {
      type: String,
      required: true,
      enum: ["entry_cam", "zone_1", "zone_2", "billing"],
    },
    zone_name: {
      type: String,
      default: null,
    },
    // The raw track_id from YOLO — may differ from primary_track_id if the
    // tracker re-assigned an ID after occlusion. Stored for audit/debug.
    track_id: {
      type: Number,
      default: null,
    },
    timestamp: {
      type: Date,
      required: true,
    },
  },
  { _id: false } // no extra ObjectId per timeline entry — keeps docs lean
);

// ─── Session Schema ───────────────────────────────────────────────────────────
const sessionSchema = new mongoose.Schema(
  {
    // Stable human-readable identifier surfaced in API responses
    session_id: {
      type: String,
      default: () => uuidv4(),
      unique: true,
      index: true,
    },

    // Multi-store architecture: identifies which physical store this
    // session belongs to. Defaults to "store_1" for single-store demo.
    store_id: {
      type: String,
      default: "store_1",
      index: true,
    },

    // The YOLO track_id from the first "entry" event on entry_cam.
    // Used as the primary lookup key for re-entry stitching.
    primary_track_id: {
      type: Number,
      required: true,
      index: true,
    },

    // Wall-clock times of store entry and exit
    start_time: {
      type: Date,
      required: true,
    },
    end_time: {
      type: Date,
      default: null,
    },

    status: {
      type: String,
      enum: ["active", "completed"],
      default: "active",
      index: true,
    },

    // Heuristic flag — set to true if the session looks like staff behaviour.
    // Excluded from all consumer-facing metrics calculations.
    is_staff: {
      type: Boolean,
      default: false,
      index: true,
    },

    // Group walk-in detection: when ≥2 entries arrive at the same
    // store + camera within a 2-second window, they share a group_id.
    // Used for "Buying Unit" math — a group counts as ONE buying unit.
    group_id: {
      type: String,
      default: null,
      index: true,
    },

    // Server-generated session ID that scopes data to a single
    // backend run. Prevents historical data from leaking into the
    // live dashboard. Generated fresh on every backend boot.
    run_session_id: {
      type: String,
      default: null,
      index: true,
    },

    // Ordered list of every CV event that touched this session
    timeline: {
      type: [timelineEventSchema],
      default: [],
    },
  },
  {
    timestamps: true, // adds createdAt / updatedAt automatically
    collection: "sessions",
  }
);

// ─── Compound Indexes ─────────────────────────────────────────────────────────
// Used by the re-entry lookup: find active/completed sessions
// for a given track_id sorted by most-recent first.
sessionSchema.index({ primary_track_id: 1, status: 1, end_time: -1 });

// Used by the group detection query: find sessions created at the same store
// and camera within the 2-second temporal window.
sessionSchema.index({ store_id: 1, run_session_id: 1, start_time: -1 });

// Used by buying-unit aggregation: count distinct group_ids
sessionSchema.index({ is_staff: 1, run_session_id: 1, group_id: 1 });

// ─── Virtual: dwell_duration_minutes ─────────────────────────────────────────
sessionSchema.virtual("dwell_duration_minutes").get(function () {
  if (!this.end_time) {
    // Session still active — compute against now
    return Math.floor((Date.now() - this.start_time.getTime()) / 60000);
  }
  return Math.floor(
    (this.end_time.getTime() - this.start_time.getTime()) / 60000
  );
});

// ─── Virtual: unique_zones_visited ───────────────────────────────────────────
sessionSchema.virtual("unique_zones_visited").get(function () {
  const zones = this.timeline
    .filter((e) => e.event_type === "zone_dwell" || e.event_type === "billing_queue")
    .map((e) => e.zone_name);
  return new Set(zones).size;
});

// ─── Instance Method: checkStaffHeuristic ────────────────────────────────────
/**
 * Evaluate whether this session looks like a staff member.
 * Criteria (OR logic — either alone is sufficient):
 *   1. Active duration > 4 hours (240 minutes)
 *   2. More than 15 unique zone_dwell / billing_queue events in timeline
 *
 * Called after every timeline append so the flag stays current.
 * Returns true if staff criteria met (caller is responsible for saving).
 */
sessionSchema.methods.checkStaffHeuristic = function () {
  const durationMinutes = this.dwell_duration_minutes;
  const zoneEventCount = this.timeline.filter(
    (e) => e.event_type === "zone_dwell" || e.event_type === "billing_queue"
  ).length;

  const likelyStaff = durationMinutes > 240 || zoneEventCount > 50;

  if (likelyStaff && !this.is_staff) {
    this.is_staff = true;
  }

  return likelyStaff;
};

module.exports = mongoose.model("Session", sessionSchema);

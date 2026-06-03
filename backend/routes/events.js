"use strict";

const express = require("express");
const router = express.Router();
const { recordEvent } = require("../controllers/eventController");

/**
 * POST /api/events
 * Inbound webhook fired by the CV pipeline for every detected spatial event.
 * Full validation and state-machine logic is in eventController.js.
 */
router.post("/", recordEvent);

module.exports = router;

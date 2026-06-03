"use strict";

const express = require("express");
const router = express.Router();
const { getFunnel } = require("../controllers/metricsController");

/**
 * GET /api/funnel
 * 4-level shopping funnel with drop-off analysis.
 * Full logic in metricsController.js.
 */
router.get("/", getFunnel);

module.exports = router;

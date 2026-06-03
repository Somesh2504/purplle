"use strict";

const express = require("express");
const router = express.Router();
const { getMetrics } = require("../controllers/metricsController");

/**
 * GET /api/metrics
 * Store-level KPIs: conversion rate, session counts, anomaly flags.
 * Full logic in metricsController.js.
 */
router.get("/", getMetrics);

module.exports = router;

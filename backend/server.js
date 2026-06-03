"use strict";

require("dotenv").config();

// Force Google public DNS so MongoDB Atlas SRV records resolve correctly
// on Windows machines where the system DNS blocks SRV lookups.
const dns = require("dns");
dns.setServers(["8.8.8.8", "8.8.4.4", "1.1.1.1"]);

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

// ─────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const MONGO_URI =
  process.env.MONGO_URI || "mongodb://mongodb:27017/store_analytics";
const MAX_RETRIES = 10;
const RETRY_INTERVAL_MS = 5000; // 5 seconds between retries

// ─────────────────────────────────────────────
// Express App Setup
// ─────────────────────────────────────────────
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

// Structured request logger
app.use((req, _res, next) => {
  console.log(
    JSON.stringify({
      level: "info",
      type: "request",
      method: req.method,
      path: req.path,
      timestamp: new Date().toISOString(),
    })
  );
  next();
});

// ─────────────────────────────────────────────
// Health Check (no DB dependency — must always respond)
// Used by Docker healthcheck and load balancers.
// ─────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  const dbState = mongoose.connection.readyState;
  // 0: disconnected | 1: connected | 2: connecting | 3: disconnecting
  const dbStatus = ["disconnected", "connected", "connecting", "disconnecting"][
    dbState
  ];
  const isHealthy = dbState === 1;

  // Always return 200 so startup scripts and load balancers can detect
  // that the HTTP server is alive even while DB is still connecting.
  res.status(200).json({
    status: isHealthy ? "ok" : "starting",
    service: "store-intelligence-backend",
    timestamp: new Date().toISOString(),
    database: dbStatus,
    uptime_seconds: Math.floor(process.uptime()),
  });
});

// ─────────────────────────────────────────────
// Route Placeholders (controllers wired in Phase 2)
// ─────────────────────────────────────────────

// Inbound webhook from CV pipeline — fires on every detected event
const eventsRouter = require("./routes/events");
app.use("/api/events", eventsRouter);

// Business intelligence endpoints
const metricsRouter = require("./routes/metrics");
app.use("/api/metrics", metricsRouter);

const funnelRouter = require("./routes/funnel");
app.use("/api/funnel", funnelRouter);

// ─────────────────────────────────────────────
// 404 & Global Error Handler
// ─────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(
    JSON.stringify({
      level: "error",
      message: err.message,
      stack: err.stack,
      timestamp: new Date().toISOString(),
    })
  );
  res.status(500).json({ error: "Internal server error" });
});

// ─────────────────────────────────────────────
// MongoDB Connection — Retry Loop
// We don't crash if Mongo isn't ready yet. We keep
// retrying every RETRY_INTERVAL_MS up to MAX_RETRIES.
// This is the correct pattern for Docker service startup
// race conditions — more robust than just relying on
// depends_on healthcheck alone.
// ─────────────────────────────────────────────
async function connectWithRetry(attempt = 1) {
  try {
    console.log(
      JSON.stringify({
        level: "info",
        message: `MongoDB connection attempt ${attempt}/${MAX_RETRIES}`,
        uri: MONGO_URI,
        timestamp: new Date().toISOString(),
      })
    );

    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 15000, // give Atlas more time for DNS+TLS
      socketTimeoutMS: 45000,
      family: 4,               // force IPv4 — avoids IPv6 DNS issues on Windows
    });

    console.log(
      JSON.stringify({
        level: "info",
        message: "MongoDB connected successfully",
        timestamp: new Date().toISOString(),
      })
    );
  } catch (err) {
    if (attempt >= MAX_RETRIES) {
      console.error(
        JSON.stringify({
          level: "fatal",
          message: `MongoDB connection failed after ${MAX_RETRIES} attempts. Exiting.`,
          error: err.message,
          timestamp: new Date().toISOString(),
        })
      );
      process.exit(1);
    }

    console.warn(
      JSON.stringify({
        level: "warn",
        message: `MongoDB not ready. Retrying in ${RETRY_INTERVAL_MS / 1000}s...`,
        error: err.message,
        attempt,
        timestamp: new Date().toISOString(),
      })
    );

    await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
    return connectWithRetry(attempt + 1);
  }
}

// ─────────────────────────────────────────────
// Mongoose Connection Event Listeners
// ─────────────────────────────────────────────
mongoose.connection.on("disconnected", () => {
  console.warn(
    JSON.stringify({
      level: "warn",
      message: "MongoDB disconnected. Reconnect will be attempted.",
      timestamp: new Date().toISOString(),
    })
  );
});

mongoose.connection.on("error", (err) => {
  console.error(
    JSON.stringify({
      level: "error",
      message: "MongoDB runtime error",
      error: err.message,
      timestamp: new Date().toISOString(),
    })
  );
});

// ─────────────────────────────────────────────
// Graceful Shutdown
// ─────────────────────────────────────────────
async function shutdown(signal) {
  console.log(
    JSON.stringify({
      level: "info",
      message: `${signal} received. Shutting down gracefully...`,
      timestamp: new Date().toISOString(),
    })
  );
  await mongoose.connection.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ─────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────
(async () => {
  // Start HTTP server immediately — health endpoint must respond
  // even before DB is connected (important for Docker readiness probes)
  app.listen(PORT, () => {
    console.log(
      JSON.stringify({
        level: "info",
        message: `Store Intelligence Backend listening on port ${PORT}`,
        environment: process.env.NODE_ENV || "development",
        timestamp: new Date().toISOString(),
      })
    );
  });

  // Connect to MongoDB with retry logic
  await connectWithRetry();
})();

"use strict";

require("dotenv").config();

// Force Google public DNS so MongoDB Atlas SRV records resolve correctly
// on Windows machines where the system DNS blocks SRV lookups.
const dns = require("dns");
dns.setServers(["8.8.8.8", "8.8.4.4", "1.1.1.1"]);

const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");

// ─────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const MONGO_URI =
  process.env.MONGO_URI || "mongodb://mongodb:27017/store_analytics";
const MAX_RETRIES = 10;
const RETRY_INTERVAL_MS = 5000;

// ─────────────────────────────────────────────
// Session Management
// A new session_id is generated every time the
// backend boots. All CV events and DB queries
// are scoped to this ID — so old data from
// previous runs is never mixed with live data.
// ─────────────────────────────────────────────
const SESSION_ID = `session_${new Date().toISOString().replace(/[:.]/g, "-")}`;

console.log(
  JSON.stringify({
    level: "info",
    message: "New system session started",
    session_id: SESSION_ID,
    timestamp: new Date().toISOString(),
  })
);

// ─────────────────────────────────────────────
// Express + HTTP Server + Socket.io
// We wrap express in a raw http.Server so that
// Socket.io can share the same port (3000).
// ─────────────────────────────────────────────
const app = express();
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// ─────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────
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
// Expose session_id + io to controllers
// We attach them to app.locals so any controller
// can access them without circular imports.
// ─────────────────────────────────────────────
app.locals.io = io;
app.locals.session_id = SESSION_ID;

// ─────────────────────────────────────────────
// WebSocket — Connection Handler
// ─────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(
    JSON.stringify({
      level: "info",
      message: "Dashboard client connected via WebSocket",
      socket_id: socket.id,
      timestamp: new Date().toISOString(),
    })
  );

  // Immediately send the current session_id so the dashboard
  // knows which session to scope its REST fallback queries to.
  socket.emit("session_info", { session_id: SESSION_ID });

  socket.on("disconnect", () => {
    console.log(
      JSON.stringify({
        level: "info",
        message: "Dashboard client disconnected",
        socket_id: socket.id,
        timestamp: new Date().toISOString(),
      })
    );
  });
});

// ─────────────────────────────────────────────
// Health Check
// ─────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  const dbState = mongoose.connection.readyState;
  const dbStatus = ["disconnected", "connected", "connecting", "disconnecting"][dbState];
  const isHealthy = dbState === 1;

  res.status(200).json({
    status: isHealthy ? "ok" : "starting",
    service: "store-intelligence-backend",
    session_id: SESSION_ID,
    timestamp: new Date().toISOString(),
    database: dbStatus,
    uptime_seconds: Math.floor(process.uptime()),
  });
});

// Session info endpoint — used by the CV pipeline on startup
app.get("/api/session", (_req, res) => {
  res.status(200).json({ session_id: SESSION_ID });
});

// ─────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────
const eventsRouter = require("./routes/events");
app.use("/api/events", eventsRouter);

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
      serverSelectionTimeoutMS: 15000,
      socketTimeoutMS: 45000,
      family: 4,
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
  io.emit("system_stopped", { message: "Backend shutting down" });
  await mongoose.connection.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ─────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────
(async () => {
  // Start HTTP + WebSocket server immediately
  httpServer.listen(PORT, () => {
    console.log(
      JSON.stringify({
        level: "info",
        message: `Store Intelligence Backend listening on port ${PORT}`,
        session_id: SESSION_ID,
        environment: process.env.NODE_ENV || "development",
        timestamp: new Date().toISOString(),
      })
    );
  });

  // Connect to MongoDB with retry logic
  await connectWithRetry();
})();

# ─────────────────────────────────────────────
# Stage 1: Dependencies
# Install only production dependencies first to
# leverage Docker layer caching on subsequent builds.
# ─────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copy manifests only — cache this layer independently
COPY package.json package-lock.json* ./

# Install production deps only
RUN npm ci --omit=dev

# ─────────────────────────────────────────────
# Stage 2: Production image
# Lean final image — no dev tools, no source cruft
# ─────────────────────────────────────────────
FROM node:20-alpine AS runner

# Create a non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy pre-built node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY . .

# Ensure the data mount-point exists so Docker doesn't create it as root
RUN mkdir -p /app/data && chown -R appuser:appgroup /app

USER appuser

EXPOSE 3000

# Use exec form to avoid shell signal-trapping issues
CMD ["node", "server.js"]

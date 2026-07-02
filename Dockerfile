# ---- Stage 1: Build TypeScript ----
FROM node:20-alpine AS builder

WORKDIR /app

# Install build tools for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# Remove devDependencies to get a clean production node_modules
RUN npm prune --omit=dev

# ---- Stage 2: Production image ----
FROM node:20-alpine AS runner

LABEL maintainer="Collab Notepad"
LABEL description="LAN real-time collaborative notepad with file sharing"

# Security: run as non-root
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup

WORKDIR /app

# Copy production node_modules (with pre-built native modules) from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy compiled output from builder stage
COPY --from=builder /app/dist ./dist

# Copy non-compiled assets
COPY convert-worker.js ./
COPY public/ ./public/

# Data directory (will be mounted as volume)
RUN mkdir -p /app/data && chown -R appuser:appgroup /app/data

# Switch to non-root user
USER appuser

# Expose port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8000/api/health || exit 1

# Default environment
ENV NODE_ENV=production \
    PORT=8000 \
    DATA_DIR=/app/data

# Start compiled server
CMD ["node", "dist/server.js"]

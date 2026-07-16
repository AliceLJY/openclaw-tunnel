# Task API Dockerfile
# Build context is ./task-api

FROM node:22-alpine

WORKDIR /app

# Install exactly the audited production dependency graph.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application. The image intentionally carries no Docker CLI/socket access.
# Keep the existing container UID for compatibility with root-owned /data
# volumes created by v1.1 and earlier; changing that requires an explicit data
# ownership migration in a future major release.
COPY server.js ./

# Expose port
EXPOSE 3456

# Start server
CMD ["node", "server.js"]

# Task API Dockerfile
# Build context is ./task-api

FROM node:22-alpine

# Install Docker CLI for callback (docker exec into bot containers)
RUN apk add --no-cache docker-cli

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install --production

# Copy application
COPY server.js ./

# Expose port
EXPOSE 3456

# Start server
CMD ["node", "server.js"]

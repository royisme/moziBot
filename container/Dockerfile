FROM node:22-bookworm-slim

# System dependencies
RUN apt-get update && apt-get install -y \
    chromium git curl \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm and agent dependencies
RUN npm install -g pnpm

# Install agent dependencies
WORKDIR /app
COPY agent-runner/package.json ./
RUN pnpm install --prod

# Copy source
COPY agent-runner/ ./
COPY entrypoint.sh ./

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/ipc && \
    chown -R node:node /workspace /app

# Non-root user
USER node
WORKDIR /workspace/group

ENTRYPOINT ["/app/entrypoint.sh"]

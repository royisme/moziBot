#!/bin/bash
set -e

# The entrypoint for the agent container
# It should run the agent-runner with node/tsx

cd /app
node --import tsx src/index.ts

#!/bin/bash
set -e

# Bun output format: JSON
# We need to make sure we're in the right directory
cd "$(dirname "$0")"

# Compile or check the runner code
# Since we use Bun, we don't necessarily need to compile it to JS, 
# but we can check it.

# Build the docker image
sudo docker build -t mozi-agent:latest .

echo "Container built successfully: mozi-agent:latest"

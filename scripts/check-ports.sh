#!/bin/bash

# Check for port conflicts before starting services
# This checks for external services, not Docker containers from our stack

echo "🔍 Checking for port conflicts..."
echo "=================================="

PORTS=(
  "80:nginx"
  "3000:node-api"
  "5433:postgres"
  "8080:dashboard"
  "11434:ollama"
)

CONFLICTS=0

# Get list of our container names to exclude
OUR_CONTAINERS=("home-ai-postgres" "home-ai-ollama" "home-ai-node-api" "home-ai-dashboard" "home-ai-nginx")

for port_info in "${PORTS[@]}"; do
  IFS=':' read -r port service <<< "$port_info"
  PORT_IN_USE=false
  IS_OUR_CONTAINER=false
  IS_DOCKER_CONTAINER=false
  LSOF_OUTPUT=""
  
  if command -v lsof > /dev/null 2>&1; then
    if sudo lsof -i :$port > /dev/null 2>&1; then
      PORT_IN_USE=true
      LSOF_OUTPUT=$(sudo lsof -i :$port 2>/dev/null)
      # Check if it's a Docker proxy (which means it's a container)
      if echo "$LSOF_OUTPUT" | grep -q "docker-pr"; then
        IS_DOCKER_CONTAINER=true
        # It's a Docker container, check if it's from our stack
        CONTAINER_INFO=$(sudo docker ps --format "{{.Names}}" --filter "publish=$port" 2>/dev/null || echo "")
        for container in "${OUR_CONTAINERS[@]}"; do
          if echo "$CONTAINER_INFO" | grep -q "$container"; then
            IS_OUR_CONTAINER=true
            break
          fi
        done
      fi
    fi
  elif command -v netstat > /dev/null 2>&1; then
    if sudo netstat -tlnp 2>/dev/null | grep -q ":$port "; then
      PORT_IN_USE=true
    fi
  elif command -v ss > /dev/null 2>&1; then
    if sudo ss -tlnp 2>/dev/null | grep -q ":$port "; then
      PORT_IN_USE=true
    fi
  fi
  
  if [ "$PORT_IN_USE" = true ]; then
    if [ "$IS_OUR_CONTAINER" = true ]; then
      echo "  ℹ️  Port $port ($service) is in use by our container (will be stopped)"
    elif [ "$IS_DOCKER_CONTAINER" = true ]; then
      echo "  ⚠️  Port $port ($service) is in use by a Docker container"
      echo "     This might be from a previous run. It will be stopped."
      echo "     If the issue persists, run: sudo docker ps -a | grep $port"
      # Don't count Docker containers as conflicts since docker compose down should handle them
    else
      echo "  ⚠️  Port $port ($service) is already in use by external service"
      if command -v lsof > /dev/null 2>&1; then
        sudo lsof -i :$port 2>/dev/null | head -3
      fi
      CONFLICTS=$((CONFLICTS + 1))
    fi
  else
    echo "  ✅ Port $port ($service) is available"
  fi
done

echo ""
if [ $CONFLICTS -gt 0 ]; then
  echo "⚠️  Found $CONFLICTS port conflict(s)"
  echo ""
  echo "Options:"
  echo "  1. Stop the conflicting service"
  echo "  2. Change the port in docker-compose.yml"
  echo "  3. Remove the port mapping if not needed externally"
  exit 1
else
  echo "✅ All ports are available"
  exit 0
fi


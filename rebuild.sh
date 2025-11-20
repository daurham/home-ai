#!/bin/bash

# Rebuild and restart Home AI Docker stack
# This script rebuilds the containers with latest code changes and restarts the stack

set -e  # Exit on error

echo "🔄 Rebuilding Home AI Docker Stack..."
echo "====================================="

# Stop the current stack first (this will free up ports)
echo "📦 Stopping current containers..."
sudo docker compose down

# Wait a moment for ports to be released
sleep 2

# Check for port conflicts (after stopping our containers)
if [ -f "./check-ports.sh" ] && [ "${SKIP_PORT_CHECK:-}" != "1" ]; then
  echo "🔍 Checking for port conflicts..."
  ./check-ports.sh || {
    echo ""
    echo "⚠️  Port conflicts detected from external services."
    echo "   These are NOT from the home-ai stack."
    echo "   You can skip this check by setting SKIP_PORT_CHECK=1"
    read -p "Continue anyway? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      exit 1
    fi
  }
  echo ""
fi

# Rebuild the node-api container (with latest code changes)
echo "🔨 Rebuilding node-api container..."
sudo docker compose build --no-cache node-api

# Rebuild the dashboard container (with latest code changes)
echo "🔨 Rebuilding dashboard container..."
sudo docker compose build --no-cache dashboard

# Start the stack
echo "🚀 Starting the stack..."
sudo docker compose up -d

# Wait for PostgreSQL to be healthy
echo "⏳ Waiting for PostgreSQL to be ready..."
MAX_WAIT=60
WAIT_COUNT=0
while [ $WAIT_COUNT -lt $MAX_WAIT ]; do
  if sudo docker compose ps postgres | grep -q "healthy"; then
    echo "✅ PostgreSQL is healthy!"
    break
  fi
  echo "   Waiting for PostgreSQL... ($WAIT_COUNT/$MAX_WAIT seconds)"
  sleep 2
  WAIT_COUNT=$((WAIT_COUNT + 2))
done

if [ $WAIT_COUNT -ge $MAX_WAIT ]; then
  echo "⚠️  Warning: PostgreSQL may not be fully ready"
fi

# Wait a bit more for other services to start
echo "⏳ Waiting for services to initialize..."
sleep 5

# Check if all services are running
echo "📊 Checking service status..."
sudo docker compose ps

# Verify all critical services are up
echo "🔍 Verifying services..."
SERVICES=("postgres" "ollama" "node-api" "dashboard" "nginx")
ALL_UP=true

for service in "${SERVICES[@]}"; do
  if sudo docker compose ps | grep -q "$service.*Up"; then
    echo "  ✅ $service is running"
  else
    echo "  ❌ $service is not running"
    ALL_UP=false
  fi
done

# Test database connectivity
echo "🗄️  Testing database connectivity..."
if sudo docker exec home-ai-postgres pg_isready -U homeai > /dev/null 2>&1; then
  echo "  ✅ Database connection successful (internal)"
  echo "  ℹ️  External access: localhost:5433"
else
  echo "  ⚠️  Warning: Database connection test failed"
fi

# Test the API
echo ""
echo "🧪 Testing the API..."
echo "===================="
if [ -f "./test_api.sh" ]; then
  ./test_api.sh
else
  echo "  ⚠️  test_api.sh not found, skipping API test"
fi

# Test API health endpoint (includes database check)
echo ""
echo "🏥 Testing API health endpoint..."
if curl -s http://localhost/api/health > /dev/null 2>&1; then
  HEALTH_RESPONSE=$(curl -s http://localhost/api/health)
  if echo "$HEALTH_RESPONSE" | grep -q "healthy"; then
    echo "  ✅ API health check passed"
    echo "  📋 Response: $HEALTH_RESPONSE"
  else
    echo "  ⚠️  API health check returned: $HEALTH_RESPONSE"
  fi
else
  echo "  ⚠️  Could not reach API health endpoint (may still be starting)"
fi

echo ""
echo "✅ Rebuild and restart complete!"
echo ""
echo "📋 Service Summary:"
echo "=================="
echo "🌐 Dashboard:     http://localhost/dashboard/"
echo "🌐 API:           http://localhost/api/ (or http://localhost:3000)"
echo "🗄️  PostgreSQL:    localhost:5433 (internal: 5432)"
echo "🤖 Ollama:        localhost:11434"
echo ""
echo "📖 Useful Commands:"
echo "==================="
echo "  View all logs:        sudo docker compose logs -f"
echo "  View dashboard logs:  sudo docker compose logs -f dashboard"
echo "  View API logs:         sudo docker compose logs -f node-api"
echo "  View database logs:    sudo docker compose logs -f postgres"
echo "  View nginx logs:       sudo docker compose logs -f nginx"
echo "  Check status:         sudo docker compose ps"
echo "  Restart service:       sudo docker compose restart <service-name>"
echo ""
if [ "$ALL_UP" = false ]; then
  echo "⚠️  Warning: Some services may not be running properly. Check logs above."
  exit 1
fi

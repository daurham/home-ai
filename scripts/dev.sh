#!/bin/bash

# Development script for Home AI project
# Usage: ./scripts/dev.sh [command]
# Commands: rebuild, restart, logs, test, status, clean

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
SCRIPTS="$ROOT/scripts"

case "${1:-rebuild}" in
  "rebuild")
    echo "🔄 Rebuilding Home AI Docker Stack..."
    echo "====================================="
    
    # Stop the current stack
    echo "📦 Stopping current containers..."
    sudo docker compose down
    
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
    
    # Wait a bit more for other services to start
    echo "⏳ Waiting for services to initialize..."
    sleep 5
    
    # Check if services are running
    echo "📊 Checking service status..."
    sudo docker compose ps
    
    # Test the API
    echo "🧪 Testing the API..."
    echo "===================="
    if [ -f "$SCRIPTS/test_api.sh" ]; then
      "$SCRIPTS/test_api.sh"
    else
      echo "  ⚠️  scripts/test_api.sh not found, skipping API test"
    fi
    
    echo ""
    echo "✅ Rebuild and restart complete!"
    echo "🌐 Dashboard is available at: http://localhost/dashboard/"
    echo "🌐 API is available at: http://localhost/api/ (or http://localhost:3000)"
    echo "🗄️  PostgreSQL is available at: localhost:5432"
    ;;
    
  "restart")
    echo "🔄 Restarting Home AI Docker Stack..."
    echo "====================================="
    
    sudo docker compose restart
    sleep 3
    sudo docker compose ps
    echo "✅ Restart complete!"
    ;;
    
  "logs")
    SERVICE="${2:-}"
    if [ -z "$SERVICE" ]; then
      echo "📋 Showing Home AI logs (all services)..."
      echo "========================================"
      sudo docker compose logs -f
    else
      echo "📋 Showing logs for $SERVICE..."
      echo "==============================="
      sudo docker compose logs -f "$SERVICE"
    fi
    ;;
    
  "test")
    echo "🧪 Testing Home AI API..."
    echo "========================="
    if [ -f "$SCRIPTS/test_api.sh" ]; then
      "$SCRIPTS/test_api.sh"
    else
      echo "  ⚠️  scripts/test_api.sh not found (copy scripts/example.test_api.sh)"
    fi
    echo ""
    echo "🧪 Testing Streaming API..."
    echo "==========================="
    if [ -f "$SCRIPTS/test_stream.sh" ]; then
      "$SCRIPTS/test_stream.sh"
    else
      echo "  ⚠️  scripts/test_stream.sh not found (copy scripts/example.test_stream.sh)"
    fi
    ;;
    
  "status")
    echo "📊 Home AI Service Status..."
    echo "============================"
    echo "Docker Compose Status:"
    sudo docker compose ps
    echo ""
    echo "Service Health:"
    SERVICES=("postgres" "ollama" "node-api" "dashboard" "nginx")
    for service in "${SERVICES[@]}"; do
      if sudo docker compose ps | grep -q "$service.*Up"; then
        echo "  ✅ $service is running"
      else
        echo "  ❌ $service is not running"
      fi
    done
    echo ""
    echo "Database Connectivity:"
    if sudo docker exec home-ai-postgres pg_isready -U homeai > /dev/null 2>&1; then
      echo "  ✅ Database connection successful"
    else
      echo "  ❌ Database connection failed"
    fi
    echo ""
    echo "API Health:"
    if curl -s http://localhost/api/health > /dev/null 2>&1; then
      HEALTH_RESPONSE=$(curl -s http://localhost/api/health)
      if echo "$HEALTH_RESPONSE" | grep -q "healthy"; then
        echo "  ✅ API is healthy"
      else
        echo "  ⚠️  API health check: $HEALTH_RESPONSE"
      fi
    else
      echo "  ❌ API health endpoint unreachable"
    fi
    echo ""
    echo "Systemd Service Status:"
    sudo systemctl status home-ai-api.service --no-pager 2>/dev/null || echo "  ⚠️  Systemd service not found or not accessible"
    ;;
    
  "clean")
    echo "🧹 Cleaning up Home AI Docker resources..."
    echo "=========================================="
    
    # Stop and remove containers
    sudo docker compose down
    
    # Remove unused images
    sudo docker image prune -f
    
    # Remove unused volumes (be careful with this!)
    read -p "⚠️  Remove unused volumes? This will delete AI models! (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        sudo docker volume prune -f
        echo "🗑️  Volumes removed. You'll need to re-download AI models."
    else
        echo "📦 Volumes preserved."
    fi
    
    echo "✅ Cleanup complete!"
    ;;
    
  "help"|"-h"|"--help")
    echo "🛠️  Home AI Development Script"
    echo "=============================="
    echo ""
    echo "Usage: ./scripts/dev.sh [command]"
    echo ""
    echo "Commands:"
    echo "  rebuild [service]  - Rebuild containers with latest code and restart (default)"
    echo "  restart            - Restart existing containers"
    echo "  logs [service]     - Show live logs (all services or specific service)"
    echo "  test               - Run all API tests (regular + streaming)"
    echo "  status             - Show status of Docker and systemd services"
    echo "  clean              - Clean up Docker resources (containers, images, volumes)"
    echo "  help               - Show this help message"
    echo ""
    echo "Examples:"
    echo "  ./scripts/dev.sh                # Rebuild and restart (default)"
    echo "  ./scripts/dev.sh restart        # Just restart containers"
    echo "  ./scripts/dev.sh logs           # Watch all logs"
    echo "  ./scripts/dev.sh logs dashboard # Watch dashboard logs only"
    echo "  ./scripts/dev.sh logs postgres  # Watch database logs only"
    echo "  ./scripts/dev.sh test           # Run tests"
    echo "  ./scripts/dev.sh status         # Check service status"
    ;;
    
  *)
    echo "❌ Unknown command: $1"
    echo "Run './scripts/dev.sh help' for available commands"
    exit 1
    ;;
esac

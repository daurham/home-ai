#!/bin/bash

# Test script for Home AI API Streaming endpoint
API_KEY="API_KEY"
BASE_URL="http://localhost:3000"

echo "Testing Home AI API Streaming..."
echo "================================="

# Test streaming endpoint
echo "Testing Streaming AI endpoint..."
echo "Query: Explain quantum computing in simple terms (in one sentence)"
echo "Response (streaming):"
echo "---------------------"

curl -X POST "$BASE_URL/api/ai/stream" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"query": "Explain quantum computing in simple terms (in one sentence)"}' \
  --no-buffer

echo -e "\n"
echo "Streaming test complete!"

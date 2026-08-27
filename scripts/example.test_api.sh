#!/bin/bash

# Test script for Home AI API
API_KEY="FILL_IN_API_KEY"
BASE_URL="http://localhost:3000"

echo "Testing Home AI API..."
echo "========================="

# Test 1: Nutrition endpoint
echo "1. Testing Nutrition endpoint..."
curl -X POST "$BASE_URL/api/nutrition" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"query": "What are the nutritional benefits of eating apples? (in one sentence)"}' \
  | jq '.' 2>/dev/null || echo "Response received (install jq for formatted output)"

echo -e "\n"

# Test 2: Home Assistant endpoint
echo "2. Testing Home Assistant endpoint..."
curl -X POST "$BASE_URL/api/home-assistant" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"message": "Turn on the living room lights (in one sentence)"}' \
  | jq '.' 2>/dev/null || echo "Response received (install jq for formatted output)"

echo -e "\n"

# Test 3: Generic AI endpoint
echo "3. Testing Generic AI endpoint..."
curl -X POST "$BASE_URL/api/ai" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"query": "Explain quantum computing in simple terms (in one sentence)"}' \
  | jq '.' 2>/dev/null || echo "Response received (install jq for formatted output)"

echo -e "\n"
echo "API testing complete!"

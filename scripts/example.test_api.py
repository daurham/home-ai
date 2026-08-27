#!/usr/bin/env python3
"""
Test script for Home AI API
"""
import requests
import json

API_KEY = "FILL_IN_API_KEY"
BASE_URL = "http://localhost:3000"

def test_endpoint(endpoint, data, description):
    """Test a specific API endpoint"""
    print(f"\n{description}")
    print("-" * 50)
    
    try:
        response = requests.post(
            f"{BASE_URL}{endpoint}",
            headers={
                "Content-Type": "application/json",
                "x-api-key": API_KEY
            },
            json=data,
            timeout=30
        )
        
        if response.status_code == 200:
            result = response.json()
            print("✅ Success!")
            print(f"Response: {json.dumps(result, indent=2)}")
        else:
            print(f"❌ Error {response.status_code}: {response.text}")
            
    except requests.exceptions.RequestException as e:
        print(f"❌ Request failed: {e}")

def main():
    print("🤖 Testing Home AI API")
    print("=" * 50)
    
    # Test 1: Nutrition endpoint
    test_endpoint(
        "/api/nutrition",
        {"query": "What are the nutritional benefits of eating apples? (in one sentence)"},
        "1. Testing Nutrition endpoint"
    )
    
    # Test 2: Home Assistant endpoint
    test_endpoint(
        "/api/home-assistant",
        {"message": "Turn on the living room lights (in one sentence)"},
        "2. Testing Home Assistant endpoint"
    )
    
    # Test 3: Generic AI endpoint
    test_endpoint(
        "/api/ai",
        {"query": "Explain quantum computing in simple terms (in one sentence)"},
        "3. Testing Generic AI endpoint"
    )
    
    print("\n" + "=" * 50)
    print("🎉 API testing complete!")

if __name__ == "__main__":
    main()

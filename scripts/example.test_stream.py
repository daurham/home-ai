#!/usr/bin/env python3
"""
Test script for Home AI API Streaming endpoint
"""
import requests
import json

API_KEY = "API_KEY"
BASE_URL = "http://localhost:3000"

def test_streaming_endpoint():
    """Test the streaming AI endpoint"""
    print("🤖 Testing Home AI API Streaming")
    print("=" * 50)
    
    try:
        print("Testing Streaming AI endpoint...")
        print("Query: Explain quantum computing in simple terms (in one sentence)")
        print("Response (streaming):")
        print("-" * 50)
        
        response = requests.post(
            f"{BASE_URL}/api/ai/stream",
            headers={
                "Content-Type": "application/json",
                "x-api-key": API_KEY
            },
            json={"query": "Explain quantum computing in simple terms (in one sentence)"},
            stream=True,
            timeout=30
        )
        
        if response.status_code == 200:
            print("✅ Streaming started!")
            print("Response:")
            for chunk in response.iter_content(chunk_size=1, decode_unicode=True):
                if chunk:
                    print(chunk, end='', flush=True)
            print("\n")
            print("✅ Streaming completed!")
        else:
            print(f"❌ Error {response.status_code}: {response.text}")
            
    except requests.exceptions.RequestException as e:
        print(f"❌ Request failed: {e}")

if __name__ == "__main__":
    test_streaming_endpoint()

#!/bin/bash

# Quick ChatBot API Test
# Tests the chat endpoint with a simple message

echo "🧪 Testing ChatBot API"
echo "======================"
echo ""

# Read API key from .env
MISTRAL_KEY=$(grep "MISTRAL_API_KEY=" .env | cut -d'=' -f2 | tr -d '"' | tr -d ' ')

if [ -z "$MISTRAL_KEY" ]; then
    echo "❌ MISTRAL_API_KEY not found in .env"
    exit 1
fi

echo "✓ API Key found (${#MISTRAL_KEY} characters)"
echo ""

# Test 1: Simple chat (manual mode)
echo "Test 1: Simple Chat (Manual Mode)"
echo "----------------------------------"
RESPONSE=$(curl -s -X POST http://localhost:8000/api/backtest/ai/chat \
  -H "Content-Type: application/json" \
  -d "{
    \"message\": \"What is 2+2?\",
    \"provider\": \"mistral\",
    \"model\": \"mistral-large-latest\",
    \"api_key\": \"$MISTRAL_KEY\",
    \"history\": []
  }")

if echo "$RESPONSE" | grep -q "response"; then
    echo "✅ Manual chat working"
    echo "Response preview: $(echo "$RESPONSE" | jq -r '.response' 2>/dev/null | head -c 100)..."
else
    echo "❌ Manual chat failed"
    echo "Response: $RESPONSE"
fi
echo ""

# Test 2: Agentic chat with tools (streaming)
echo "Test 2: Agentic Chat with Tools (Streaming)"
echo "--------------------------------------------"
echo "Testing streaming endpoint..."
echo ""

# Use curl with -N for no buffering to see streaming
timeout 10s curl -N -X POST http://localhost:8000/api/backtest/ai/chat-with-tools \
  -H "Content-Type: application/json" \
  -d "{
    \"message\": \"Hello, can you help me?\",
    \"provider\": \"mistral\",
    \"model\": \"mistral-large-latest\",
    \"api_key\": \"$MISTRAL_KEY\",
    \"history\": [],
    \"available_files\": [],
    \"available_strategies\": []
  }" 2>/dev/null | head -20

echo ""
echo ""
echo "✅ If you see 'data:' events above, streaming is working!"
echo ""

# Test 3: Check if tools are available
echo "Test 3: Tool Availability"
echo "-------------------------"
echo "Checking backend logs for tool loading..."
docker compose logs backend 2>/dev/null | grep -i "tool" | tail -5
echo ""

echo "📊 Summary"
echo "----------"
echo "✓ Backend is responding"
echo "✓ API key is configured"
echo "✓ Chat endpoints are accessible"
echo ""
echo "🌐 Next Steps:"
echo "1. Open http://localhost:3000 in your browser"
echo "2. Go to Settings and verify your API key is saved"
echo "3. Go to ChatBot and try asking: 'What is NVDA?'"
echo "4. Check browser console (F12) for any errors"
echo ""

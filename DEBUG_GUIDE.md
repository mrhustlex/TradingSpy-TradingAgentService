# TradingSpy Debug Guide

## Current Status ✅

Your Docker Compose stack is **running successfully**:
- ✅ Backend (port 8000) - Healthy
- ✅ Frontend (port 3000) - Running
- ✅ SearXNG (port 8080) - Operational

## Services Overview

| Service | Port | URL | Status |
|---------|------|-----|--------|
| Frontend | 3000 | http://localhost:3000 | ✅ Running |
| Backend API | 8000 | http://localhost:8000 | ✅ Healthy |
| SearXNG | 8080 | http://localhost:8080 | ✅ Running |
| Debug Server | 8001 | http://localhost:8001 | ⚠️ Not started |

## Quick Health Checks

### 1. Test Backend Health
```bash
curl http://localhost:8000/health
```
**Expected**: `{"status":"ok","monolith":true}`

### 2. Test Frontend
```bash
curl http://localhost:3000
```
**Expected**: HTML response

### 3. Test SearXNG
```bash
curl http://localhost:8080/healthz
```
**Expected**: 200 OK

## Common Issues & Solutions

### Issue 1: ChatBot Not Responding

**Symptoms:**
- Messages sent but no response
- Spinning loader forever
- Console errors about API keys

**Debug Steps:**

1. **Check Browser Console** (F12 → Console tab)
   ```javascript
   // Look for errors like:
   // - "API key missing"
   // - "Network error"
   // - "Failed to fetch"
   ```

2. **Verify API Key in Settings**
   - Open Settings tab in the UI
   - Check that your API key is entered for the selected provider
   - The key should be saved in localStorage

3. **Check Backend Logs**
   ```bash
   docker compose logs backend -f
   ```
   Look for:
   - `LLM Call: Provider=mistral, Model=mistral-large-latest`
   - Any error messages about API keys

4. **Test API Key Directly**
   ```bash
   curl -X POST http://localhost:8000/api/backtest/ai/chat-with-tools \
     -H "Content-Type: application/json" \
     -d '{
       "message": "What is NVDA?",
       "provider": "mistral",
       "model": "mistral-large-latest",
       "api_key": "YOUR_KEY_HERE",
       "history": [],
       "available_files": [],
       "available_strategies": []
     }'
   ```

### Issue 2: Mistral API Errors

**Symptoms:**
- "Invalid JSON response"
- "API key is invalid"
- Response format errors

**Debug Steps:**

1. **Verify API Key**
   ```bash
   # Test Mistral API directly
   curl https://api.mistral.ai/v1/models \
     -H "Authorization: Bearer YOUR_KEY_HERE"
   ```

2. **Check Mistral Client Version**
   ```bash
   docker compose exec backend pip show mistralai
   ```

3. **Use Debug Test Server**
   ```bash
   cd debug_test
   python3 server.py
   ```
   Then open http://localhost:8001 and run the tests

### Issue 3: Tools Not Executing

**Symptoms:**
- Agent says it will use tools but doesn't
- No market data cards appear
- "Tool execution failed" errors

**Debug Steps:**

1. **Check Tool Availability**
   ```bash
   # Check if tools are loaded
   docker compose logs backend | grep "Tool"
   ```

2. **Test Individual Tools**
   ```bash
   # Test get_quote tool
   curl -X POST http://localhost:8000/api/backtest/ai/chat-with-tools \
     -H "Content-Type: application/json" \
     -d '{
       "message": "Get quote for AAPL",
       "provider": "openai",
       "model": "gpt-4o",
       "api_key": "YOUR_KEY",
       "history": []
     }'
   ```

3. **Check yfinance MCP Server**
   ```bash
   docker compose logs backend | grep "yf_mcp"
   ```

### Issue 4: Streaming Not Working

**Symptoms:**
- No real-time updates
- Response appears all at once
- Progress indicators don't update

**Debug Steps:**

1. **Check Endpoint**
   - Agentic mode uses: `/api/backtest/ai/chat-with-tools`
   - Strands mode uses: `/api/backtest/ai/chat-strands`
   - Manual mode uses: `/api/backtest/ai/chat`

2. **Verify SSE Support**
   ```bash
   # Test streaming endpoint
   curl -N http://localhost:8000/api/backtest/ai/chat-with-tools \
     -H "Content-Type: application/json" \
     -d '{
       "message": "Hello",
       "provider": "openai",
       "model": "gpt-4o",
       "api_key": "YOUR_KEY"
     }'
   ```

3. **Check Browser Network Tab**
   - Open DevTools → Network
   - Look for the chat request
   - Check if it's using EventStream
   - Verify events are being received

### Issue 5: Docker Container Issues

**Symptoms:**
- Containers not starting
- Port conflicts
- Volume mount errors

**Debug Steps:**

1. **Check Container Status**
   ```bash
   docker compose ps
   ```

2. **View All Logs**
   ```bash
   docker compose logs -f
   ```

3. **Restart Services**
   ```bash
   docker compose down
   docker compose up -d
   ```

4. **Rebuild Containers**
   ```bash
   docker compose down
   docker compose build --no-cache
   docker compose up -d
   ```

5. **Check Port Conflicts**
   ```bash
   # Check if ports are already in use
   lsof -i :3000  # Frontend
   lsof -i :8000  # Backend
   lsof -i :8080  # SearXNG
   ```

## Debug Test Server

The `debug_test` folder contains a lightweight test server for rapid debugging:

### Start Debug Server
```bash
cd debug_test
python3 server.py
```

### Access Debug UI
Open http://localhost:8001 in your browser

### Run Tests
1. **Direct Mistral API** - Tests if your API key works
2. **Backend Endpoint** - Tests if backend receives the key
3. **With History** - Tests conversation history
4. **Thinking & Steps** - Tests response format

### Switch Between Backends
- **Test Server (8001)** - Fast, lightweight, for quick testing
- **Docker Backend (8000)** - Full production backend with all features

## Monitoring & Logs

### Real-time Backend Logs
```bash
docker compose logs backend -f
```

### Real-time Frontend Logs
```bash
docker compose logs frontend -f
```

### Real-time All Logs
```bash
docker compose logs -f
```

### Filter Logs
```bash
# Show only errors
docker compose logs backend | grep ERROR

# Show API calls
docker compose logs backend | grep "LLM Call"

# Show tool executions
docker compose logs backend | grep "Tool"
```

## API Endpoints Reference

### Chat Endpoints

| Endpoint | Mode | Features |
|----------|------|----------|
| `/api/backtest/ai/chat` | Manual | Simple Q&A, no tools |
| `/api/backtest/ai/chat-with-tools` | Agentic | ReAct + Parallel tools |
| `/api/backtest/ai/chat-strands` | Strands | Multi-iteration loop |

### Test Endpoints

```bash
# Health check
curl http://localhost:8000/health

# List strategies
curl http://localhost:8000/api/strategies

# List datasets
curl http://localhost:8000/api/market-data/files

# Get settings
curl http://localhost:8000/api/settings
```

## Environment Variables

Check your `.env` file for:

```bash
# OpenAI
OPENAI_API_KEY=sk-...

# Mistral
MISTRAL_API_KEY=...

# OpenRouter
OPENROUTER_API_KEY=...

# Groq
GROQ_API_KEY=...

# Azure
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_ENDPOINT=...

# AWS
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=...

# GCP
GCP_PROJECT=...
GCP_LOCATION=...

# Default Provider
DEFAULT_PROVIDER=mistral
DEFAULT_MODEL=mistral-large-latest

# SearXNG
SEARXNG_URL=http://searxng:8080
```

## Browser DevTools Debugging

### Console Logs
Look for these key logs:
```javascript
🔑 [ChatBot] getActiveApiKey called
📤 [ChatBot] Sending streaming request
📊 market_data event received
📊 toolData set to
```

### Network Tab
1. Filter by "chat"
2. Look for the POST request to `/api/backtest/ai/chat-with-tools`
3. Check Request payload
4. Check Response (should be EventStream)
5. Verify events are streaming in

### Application Tab
Check localStorage for:
- `settings_mistral_api_key`
- `settings_default_provider`
- `settings_default_model`
- `chatThreads`

## Performance Optimization

### Slow Responses
1. **Check Model**: Larger models are slower
2. **Check Tools**: Multiple tool calls take time
3. **Check Network**: Slow internet affects API calls

### High Memory Usage
1. **Check Chat History**: Long conversations use more memory
2. **Clear Old Threads**: Delete unused chat threads
3. **Restart Containers**: `docker compose restart`

## Getting Help

### Collect Debug Info
```bash
# System info
docker compose version
docker version

# Container status
docker compose ps

# Recent logs
docker compose logs --tail=100 backend > backend.log
docker compose logs --tail=100 frontend > frontend.log

# Environment
cat .env | grep -v "KEY"  # Don't share actual keys!
```

### Common Error Messages

| Error | Cause | Solution |
|-------|-------|----------|
| "API key missing" | No key in settings | Add key in Settings tab |
| "Invalid JSON" | Mistral format issue | Use debug server to test |
| "Network error" | Backend not reachable | Check `docker compose ps` |
| "Tool not found" | Tool loading failed | Check backend logs |
| "Task timeout" | Long-running task | Increase timeout or check task status |

## Next Steps

1. ✅ **Verify all services are running**
   ```bash
   docker compose ps
   ```

2. ✅ **Test backend health**
   ```bash
   curl http://localhost:8000/health
   ```

3. ✅ **Open frontend**
   ```
   http://localhost:3000
   ```

4. ✅ **Configure API keys**
   - Go to Settings tab
   - Add your API keys
   - Select default provider

5. ✅ **Test ChatBot**
   - Open ChatBot tab
   - Send a simple message: "What is NVDA?"
   - Check for response

6. ✅ **Monitor logs**
   ```bash
   docker compose logs -f
   ```

## Troubleshooting Checklist

- [ ] All containers running (`docker compose ps`)
- [ ] Backend health check passes (`curl http://localhost:8000/health`)
- [ ] Frontend accessible (`http://localhost:3000`)
- [ ] API key configured in Settings
- [ ] Provider selected (mistral, openai, etc.)
- [ ] Browser console shows no errors
- [ ] Network tab shows successful requests
- [ ] Backend logs show LLM calls

---

**Need more help?** Check the logs and error messages, then refer to the specific issue sections above.

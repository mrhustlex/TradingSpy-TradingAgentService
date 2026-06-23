# Archived Agent Files

This folder contains agent implementations that are **NOT currently used** in the production system.

## Archived Files

### 1. `langgraph_agent.py`
- **Status**: Not used
- **Why archived**: ChatBot now uses `tool_calling_agent.py` instead
- **Contains**: LangGraph-based agent with web_search tool
- **Note**: The `web_search` tool from this file was copied to `tool_calling_agent.py`

### 2. `agent_graph.py`
- **Status**: Not used
- **Why archived**: Legacy implementation, replaced by simpler tool-calling approach
- **Contains**: Graph-based agent workflow

## Currently Active Agents

### 1. `tool_calling_agent.py` ✅ ACTIVE
- **Used by**: ChatBot (agentic mode)
- **Endpoint**: `/api/backtest/ai/chat-with-tools`
- **Features**:
  - 30 tools (market data + trading platform)
  - Streaming responses
  - Async workflow support (generate_strategy, download_market_data, run_backtest)
  - Web search (Tavily + DuckDuckGo)
- **Providers**: OpenAI, OpenRouter, Groq, Mistral

### 2. `simple_agent.py` ✅ ACTIVE
- **Used by**: ChatBot (non-agentic mode)
- **Endpoint**: `/api/backtest/ai/chat`
- **Features**: Simple Q&A without tool calling
- **Providers**: All (OpenAI, OpenRouter, Groq, Mistral, Azure, AWS, GCP)

---

## LLM Call Flow Explained

### Architecture Overview

```
User Message
    ↓
Frontend (ChatBot.jsx)
    ↓
Backend Endpoint (main.py)
    ↓
Agent Module (tool_calling_agent.py or simple_agent.py)
    ↓
LangChain LLM Wrapper
    ↓
External LLM API (OpenAI, OpenRouter, Groq, Mistral, etc.)
```

### Detailed Flow for ChatBot Agentic Mode

#### 1. User Sends Message
```javascript
// frontend/src/components/ChatBot.jsx
const response = await fetch('/api/backtest/ai/chat-with-tools', {
  method: 'POST',
  body: JSON.stringify({
    message: "can you generate a strategy for TQQQ?",
    provider: "openrouter",
    model: "arcee-ai/trinity-large-preview:free",
    history: [...previousMessages]
  })
});
```

#### 2. Backend Receives Request
```python
# backend/main.py line ~2878
@app.post("/api/backtest/ai/chat-with-tools")
async def chat_with_tools_streaming(request: AIChatRequest):
    from modules.tool_calling_agent import ALL_TOOLS, SYSTEM_PROMPT
    
    # Get provider settings
    provider = request.provider or settings.get("default_provider") or "openai"
    model = request.model or settings.get("default_model") or "gpt-4o"
    api_key = get_api_key_for_provider(provider)
```

#### 3. Initialize LLM with Provider
```python
# Different initialization based on provider
if provider == "openai":
    from langchain_openai import ChatOpenAI
    llm = ChatOpenAI(model=model, api_key=api_key, temperature=0)

elif provider == "openrouter":
    from langchain_openai import ChatOpenAI
    llm = ChatOpenAI(
        model=model,
        api_key=api_key,
        base_url="https://openrouter.ai/api/v1",  # Key difference!
        temperature=0
    )

elif provider == "groq":
    from langchain_groq import ChatGroq
    llm = ChatGroq(model=model, api_key=api_key, temperature=0)

elif provider == "mistral":
    from langchain_mistralai.chat_models import ChatMistralAI
    llm = ChatMistralAI(model=model, api_key=api_key, temperature=0)
```

#### 4. Bind Tools to LLM
```python
# backend/main.py line ~2940
llm_with_tools = llm.bind_tools(ALL_TOOLS)  # ALL_TOOLS from tool_calling_agent.py

# This tells the LLM about available tools:
# - get_quote, get_technicals, get_news, web_search, etc.
# - generate_strategy, download_market_data, run_backtest
# - wait_seconds, list_available_strategies, etc.
```

#### 5. Build Message History
```python
# Convert chat history to LangChain format
lc_messages = []
for h in request.history[-12:]:  # Last 12 messages for context
    if h["role"] == "user":
        lc_messages.append(HumanMessage(content=h["content"]))
    elif h["role"] == "assistant":
        lc_messages.append(AIMessage(content=h["content"]))

# Add system prompt and current message
if not lc_messages:
    lc_messages.append(HumanMessage(content=f"{SYSTEM_PROMPT}\n\n{request.message}"))
else:
    lc_messages.append(HumanMessage(content=request.message))
```

#### 6. Call LLM API
```python
# This makes the actual HTTP request to the LLM provider
response = llm_with_tools.invoke(lc_messages)

# What happens under the hood:
# 1. LangChain formats the request according to provider's API spec
# 2. Sends HTTP POST to provider's endpoint:
#    - OpenAI: https://api.openai.com/v1/chat/completions
#    - OpenRouter: https://openrouter.ai/api/v1/chat/completions
#    - Groq: https://api.groq.com/openai/v1/chat/completions
#    - Mistral: https://api.mistral.ai/v1/chat/completions
# 3. Provider's LLM processes the request
# 4. Returns response with tool calls or text
```

#### 7. Process LLM Response
```python
# Check if LLM wants to use tools
if response.tool_calls:
    for tool_call in response.tool_calls:
        tool_name = tool_call["name"]
        tool_args = tool_call["args"]
        
        # Find and execute the tool
        tool_func = next(t for t in ALL_TOOLS if t.name == tool_name)
        result = tool_func.invoke(tool_args)
        
        # Stream the tool execution to frontend
        yield f"data: {json.dumps({
            'type': 'tool_call',
            'tool': tool_name,
            'args': tool_args,
            'result': result
        })}\n\n"
```

#### 8. Stream Response to Frontend
```python
# Stream the final response
yield f"data: {json.dumps({
    'type': 'response',
    'content': response.content
})}\n\n"
```

### Example: Complete Flow for "generate a strategy for TQQQ"

```
1. User types: "can you generate a strategy for TQQQ?"
   ↓
2. Frontend sends POST to /api/backtest/ai/chat-with-tools
   ↓
3. Backend initializes OpenRouter LLM with tools
   ↓
4. Sends to OpenRouter API:
   {
     "model": "arcee-ai/trinity-large-preview:free",
     "messages": [
       {"role": "system", "content": "You are a trading assistant..."},
       {"role": "user", "content": "can you generate a strategy for TQQQ?"}
     ],
     "tools": [
       {"name": "generate_strategy", "description": "...", "parameters": {...}},
       {"name": "wait_seconds", ...},
       {"name": "list_available_strategies", ...},
       ... 27 more tools
     ]
   }
   ↓
5. OpenRouter's LLM decides to use tools:
   {
     "tool_calls": [
       {"name": "generate_strategy", "args": {"description": "strategy for TQQQ", "count": 1}}
     ]
   }
   ↓
6. Backend executes generate_strategy tool:
   - Makes HTTP POST to http://localhost:8000/api/backtest/ai/generate
   - Returns: {"task_id": "abc-123", "status": "started", "next_steps": "..."}
   ↓
7. Backend sends tool result back to LLM
   ↓
8. LLM decides next action (should call wait_seconds, then list_available_strategies)
   ↓
9. Backend streams all actions and final response to frontend
   ↓
10. Frontend displays thinking, tool calls, and response in real-time
```

### Key Differences Between Providers

| Provider | Base URL | API Format | Notes |
|----------|----------|------------|-------|
| OpenAI | api.openai.com | OpenAI native | Original format |
| OpenRouter | openrouter.ai | OpenAI-compatible | Proxies to multiple models |
| Groq | api.groq.com | OpenAI-compatible | Fast inference |
| Mistral | api.mistral.ai | Mistral native | Different tool format |

### Tool Execution Flow

```python
# Tool definition in tool_calling_agent.py
@tool
def generate_strategy(description: str, count: int = 1) -> dict:
    """Generate a new trading strategy using AI..."""
    import requests
    
    response = requests.post(
        "http://localhost:8000/api/backtest/ai/generate",
        json={"prompt": description, "count": count, "mode": "random_agnostic"},
        timeout=60
    )
    
    if response.status_code == 200:
        data = response.json()
        return {
            "task_id": data.get("task_id"),
            "status": "started",
            "message": "✅ Strategy generation started!",
            "next_steps": "1. wait_seconds(90)  2. list_available_strategies"
        }
```

### Async Operations Pattern

```
User: "generate a strategy for TQQQ"
    ↓
LLM calls: generate_strategy("strategy for TQQQ")
    ↓
Tool returns: {"task_id": "abc-123", "next_steps": "1. wait_seconds(90) 2. list_available_strategies"}
    ↓
LLM should call: wait_seconds(90, "Waiting for strategy generation")
    ↓
Tool sleeps for 90 seconds (backend processes in background)
    ↓
LLM calls: list_available_strategies()
    ↓
Tool returns: {"strategies": [...new strategy...]}
    ↓
LLM responds: "I've generated a TQQQ momentum strategy! Here's what it does..."
```

### Why This Architecture?

1. **Separation of Concerns**:
   - `tool_calling_agent.py`: Defines tools and system prompt
   - `main.py`: Handles HTTP, streaming, provider initialization
   - LangChain: Abstracts provider differences

2. **Provider Flexibility**:
   - Same tool definitions work with all providers
   - LangChain handles API format differences
   - Easy to add new providers

3. **Streaming Support**:
   - Real-time feedback to user
   - Shows thinking, tool calls, and responses
   - Better UX for long operations

4. **Tool Modularity**:
   - Each tool is independent
   - Easy to add/remove tools
   - Tools can call backend endpoints or external APIs

### How to Test LLM Calls Yourself

1. **Direct API Test** (no agent):
```python
import requests

response = requests.post(
    "https://openrouter.ai/api/v1/chat/completions",
    headers={"Authorization": f"Bearer {api_key}"},
    json={
        "model": "arcee-ai/trinity-large-preview:free",
        "messages": [
            {"role": "user", "content": "What's 2+2?"}
        ]
    }
)
print(response.json())
```

2. **With Tools** (like the agent does):
```python
response = requests.post(
    "https://openrouter.ai/api/v1/chat/completions",
    headers={"Authorization": f"Bearer {api_key}"},
    json={
        "model": "arcee-ai/trinity-large-preview:free",
        "messages": [
            {"role": "user", "content": "Get the price of AAPL"}
        ],
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "get_quote",
                    "description": "Get real-time price quote for a stock",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "ticker": {"type": "string", "description": "Stock symbol"}
                        },
                        "required": ["ticker"]
                    }
                }
            }
        ]
    }
)
print(response.json())
# Will return: {"tool_calls": [{"name": "get_quote", "arguments": {"ticker": "AAPL"}}]}
```

3. **Test Backend Endpoint Directly**:
```bash
curl -X POST http://localhost:8000/api/backtest/ai/chat-with-tools \
  -H "Content-Type: application/json" \
  -d '{
    "message": "What is the price of NVDA?",
    "provider": "openrouter",
    "model": "arcee-ai/trinity-large-preview:free"
  }'
```

### Debugging Tips

1. **Check backend logs**:
```bash
docker logs tradingspy-service-backend-1 --tail 100 -f
```

2. **Enable verbose logging**:
```python
# In main.py
import logging
logging.basicConfig(level=logging.DEBUG)
```

3. **Test tools directly**:
```python
from modules.tool_calling_agent import get_quote
result = get_quote.invoke({"ticker": "AAPL"})
print(result)
```

4. **Check LLM response format**:
```python
# Add this in main.py after llm_with_tools.invoke()
logger.info(f"LLM Response: {response}")
logger.info(f"Tool Calls: {response.tool_calls}")
```

---

## Why These Files Were Archived

### langgraph_agent.py
- Used LangGraph's complex state machine approach
- ChatBot now uses simpler tool-calling with streaming
- The `web_search` tool was the only unique feature, now copied to `tool_calling_agent.py`

### agent_graph.py
- Legacy graph-based workflow
- Replaced by direct tool-calling approach
- More complex than needed for current use cases

## Can These Be Restored?

Yes! If you want to use LangGraph or graph-based workflows:
1. Move files back to `backend/modules/`
2. Import in `main.py`
3. Create new endpoint using the agent

The files are fully functional, just not currently used in production.

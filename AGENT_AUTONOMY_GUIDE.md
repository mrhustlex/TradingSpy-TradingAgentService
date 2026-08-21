# Agent Autonomy & Tool Freedom

## Overview

The redesigned agent has **full autonomy to decide what tools to use and when**. It's not following pre-written SOPs (standard operating procedures). Instead, it reasons about what information it needs and picks the right tools.

## How It Works

### Old Approach (Rule-Based)
```
User: "Any bullish setups in tech?"
  ↓
System: "User said 'bullish' + 'tech'
         → Check rule 'bullish patterns'
         → Use scan_bullish_patterns"
  ↓
Returns patterns
```

### New Approach (Autonomous Reasoning)
```
User: "Any bullish setups in tech?"
  ↓
Agent thinks:
  1. "User wants trading setups (pattern scan)"
  2. "I should understand market regime first"
  3. "Market context will help me rank patterns"
  ↓
Agent autonomously decides:
  → Call get_market_overview (understand regime)
  → Call scan_bullish_patterns (get setups)
  → Rank patterns based on regime fit
  → Return top setup with entry/stop/target
```

The difference: **Agent decided** the approach, not a template rule.

---

## Agent Autonomy Principles

### 1. **Assess → Plan → Execute → Stop**

```python
# Agent's reasoning (happens internally):
1. ASSESS: "What does the user want?"
   - Pattern scan? Ticker analysis? Strategy work? News research?
   - Confidence in this assessment: 85%

2. PLAN: "What tools do I need?"
   - Market overview first? Yes (context)
   - Then pattern scan? Yes (if patterns are the goal)
   - Then deep dive on top setup? Maybe (depends on result)

3. EXECUTE: Call tools one at a time
   - Tool 1: get_market_overview ✓
   - Tool 2: scan_bullish_patterns ✓
   - Check: Do I have enough to respond? Yes
   - STOP (don't call unnecessary tools)

4. SYNTHESIZE: Build response from collected data
```

### 2. **Dynamic Tool Selection**

The agent doesn't follow a fixed sequence. It adapts:

```
If user asks "analyze NVDA":
  → Is market overview needed? Maybe not—they want a specific ticker
  → Call get_stock_deep_dive (includes technicals, fundamentals, news)
  → If NVDA is near earnings, maybe get_news too
  → Otherwise, stop and respond

If user asks "what's the market doing?":
  → Market overview always needed first
  → Maybe industry heatmap for sector context
  → Maybe web_search for current news
  → Pattern scan? Only if user hints at trading

If user asks "generate a strategy for QQQ":
  → Market context? Yes (shapes strategy type)
  → Generate strategy
  → Backtest it
  → Compare to buy-and-hold
  → Done
```

### 3. **Freedom Within Constraints**

**Agent has freedom to:**
- ✓ Skip tools (if not relevant to the question)
- ✓ Use tools in any order (market context, then patterns; OR patterns directly if time-critical)
- ✓ Chain tools dynamically (output of one tool → input for next)
- ✓ Stop early (once confident enough to respond)
- ✓ Use novel combinations (not templated)

**Agent has constraints to:**
- ✗ Max 5 tools per request (prevent infinite loops, API waste)
- ✗ Max 30 seconds per analysis (timeout)
- ✗ Must show reasoning (transparency)
- ✗ Must handle tool failures gracefully (fallbacks)

---

## Example: "Any Bullish Setups in Tech?"

### Agent's Autonomous Reasoning

```
ASSESS:
  Intent: Pattern scan in tech sector
  Confidence: 90%
  ├─ User said "bullish" → pattern scan ✓
  ├─ User said "tech" → specific sector ✓
  └─ No specific ticker, so universe scan

PLAN:
  Step 1: Get market context (need to know regime)
    - Is market trending or choppy? (affects pattern quality)
    - Is tech leading or lagging? (affects timing)
    - What's VIX? (affects stop placement)
  
  Step 2: Scan for bullish patterns in tech
    - Use market regime to adjust probability rankings
    - Filter for setups that fit current regime
  
  Step 3: Rank & present top opportunity
    - Best entry/stop/target
    - Why this setup fits the regime

EXECUTE:
  Tool 1: get_market_overview()
    Result: SPY +1.2%, QQQ +1.8%, VIX 18, breadth 60/40
    Agent thinks: "Tech leading, market trending, calm vol"
    Confidence so far: 60%
  
  Tool 2: scan_bullish_patterns(universe="software", intervals=["1h", "1d"])
    Result: MSFT (1d), ORCL (1h), CRM (1h) showing bullish patterns
    Agent thinks: "Got patterns, high confidence now"
    Confidence so far: 85%
  
  STOP? Agent thinks:
    - "I have market context ✓"
    - "I have top patterns ✓"
    - "I can rank them by regime fit ✓"
    - "Confidence is 85% ✓"
    → YES, STOP HERE. Respond now.

SYNTHESIZE & RESPOND:
  Agent: "Tech is leading today (QQQ +1.8%, breadth strong, VIX calm). 
           Trending market favors breakouts.
           
           Top setup: **MSFT** (1d interval, 1.8% expected return)
           • Entry: Current price ~$415 (at resistance)
           • Stop: $408 (2% below support)
           • Target: $425 (1.8% upside)
           • Risk/Reward: 1:2.4 (good)
           • Probability: 75% (strong volume, sector momentum)
           
           Why this? Breakout fits trending regime, MSFT leading software group,
           volume confirms conviction. This is the highest-probability setup."
```

### Key Points

1. **Agent decided the tools**, not a template
2. **Agent stopped early** (didn't call unnecessary tools)
3. **Agent ranked by regime**, not just return %
4. **Agent showed reasoning** (why this setup)

---

## Comparison: Old vs. New

| Aspect | Old (SOP-Based) | New (Autonomous) |
|--------|---|---|
| **Tool Selection** | "If pattern → use scan_bullish_patterns" | "What info do I need? → Pick best tool" |
| **Sequence** | Fixed (always same order) | Dynamic (adapts to situation) |
| **Stopping** | All tools called (wasteful) | Stop when confident (efficient) |
| **Decision Making** | Template rules | Agent reasoning |
| **Flexibility** | Low (limited workflows) | High (infinite combinations) |
| **Failure Handling** | Retry tool (rigid) | Fallback to alternative (smart) |
| **Transparency** | Minimal | Full reasoning shown |

---

## How to Give More Freedom

### Current Architecture
The system prompt already enables autonomy:
- Agent thinks first, picks tools second
- Can chain tools dynamically
- Shows full reasoning

### To Extend Further
You can add:
1. **Custom tool definitions** (agent sees tool descriptions, picks best fit)
2. **Confidence tracking** (agent stops when confident, continues when uncertain)
3. **Feedback loops** (user tells agent to go deeper or stop early)
4. **Tool composition** (agent combines tools in novel ways)

Example:
```python
# Give agent tool descriptions, let it pick
tools_available = {
    "get_market_overview": "Global market indices, breadth, sentiment",
    "scan_bullish_patterns": "Find bullish setups in ticker universe",
    "get_stock_deep_dive": "Full analysis: quote, technicals, fundamentals, news",
    "web_search": "Current news, catalysts, research",
    "generate_strategy": "Create trading strategy from description",
    # ... etc
}

# Agent's reasoning:
"User wants strategies. I should:
 1. Understand market context (get_market_overview)
 2. Form trading thesis (maybe web_search for catalysts)
 3. Generate strategy (generate_strategy)
 4. Backtest it (run_backtest)
 
 Which tools? I'll pick based on this reasoning, not templates."
```

---

## What Agent Autonomy Means in Practice

### Before (Your Previous System)
```
User: "Scan tech for bullish"
Bot: [Calls scan_bullish_patterns directly, no context]
Bot: "Found 5 patterns: AAPL, MSFT, NVDA, GOOGL, AMD"
(Lists them in a table, no reasoning)
```

### After (Autonomous)
```
User: "Scan tech for bullish"
Agent: 
  THOUGHT: "User wants bullish tech setups. Market context needed first."
  ACTION: 
    1. Get market overview → Understand if trending/mean-reverting
    2. Scan patterns → Find bullish setups
    3. Rank by regime fit → Pick best opportunity
  OBSERVATION: "Market is up 1.2% on good breadth, tech leading. 
                 Semis especially strong. Scanning tech universe..."
  VERDICT: "Top setup is NVDA ($1d interval, 1.8% expected). 
            Entry $900, Stop $895, Target $920. 
            Probability 75% because strong volume + sector momentum.
            This fits the trending regime we're in."
```

**Difference**: Agent autonomously reasoned, picked tools, ranked by context. Not just a list.

---

## Implementation

The autonomous reasoning module is in:
- `backend/modules/agentic_reasoning.py`

Key functions:
- `build_tool_plan()`: Agent plans what to do
- `ToolComposer`: Executes tools dynamically
- `autonomous_reasoning_loop()`: Main loop (agent reasons → calls tools → stops when confident)

To use it in your agent:
```python
from modules.agentic_reasoning import build_tool_plan, autonomous_reasoning_loop

# When user sends a message:
plan = build_tool_plan(user_message, conversation_history)

# Agent executes the plan
result = autonomous_reasoning_loop(
    user_message=user_message,
    conversation_history=conversation_history,
    available_tools=ALL_TOOLS,
    max_iterations=5
)

# Agent now has full autonomy to decide what to do
```

---

## Summary

✓ **Agent has full freedom** to pick tools based on situation  
✓ **No pre-written SOPs** – just reasoning and tools  
✓ **Intelligent stopping** – stops when confident, continues when uncertain  
✓ **Dynamic chaining** – can combine tools in novel ways  
✓ **Full transparency** – shows reasoning to user  

This is the foundation for **agent autonomy**. You can extend it further by giving agents feedback, custom objectives, or tool definitions—but the core freedom is there.

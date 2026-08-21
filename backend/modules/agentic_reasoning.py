"""
Agentic Reasoning: Tool Composition & Decision Freedom
Lets the agent autonomously decide which tools to use and when, based on the current situation.
No pre-written SOPs—just tools and reasoning.
"""

import logging
from typing import Dict, List, Any, Optional, Tuple
from enum import Enum

logger = logging.getLogger(__name__)


class ToolActionType(str, Enum):
    """Types of tool actions the agent can decide to take."""
    ANALYZE_MARKET = "analyze_market"
    SCAN_PATTERNS = "scan_patterns"
    ANALYZE_TICKER = "analyze_ticker"
    GET_FUNDAMENTALS = "get_fundamentals"
    SEARCH_CONTEXT = "search_context"
    GET_TECHNICALS = "get_technicals"
    GET_NEWS = "get_news"
    BACKTEST_STRATEGY = "backtest_strategy"
    GENERATE_STRATEGY = "generate_strategy"
    STOP_AND_RESPOND = "stop_and_respond"


class AgentThoughtProcess:
    """
    Represents the agent's autonomous reasoning about what to do next.
    NOT a pre-written SOP—but a live assessment of the situation.
    """
    
    def __init__(self):
        self.steps = []
        self.context = {}
        self.available_data = {}
        self.actions_taken = []
        self.confidence = 0.0
    
    def add_step(self, reasoning: str, next_action: Optional[ToolActionType] = None):
        """Agent adds a reasoning step and decides next action."""
        self.steps.append({
            "reasoning": reasoning,
            "next_action": next_action,
            "timestamp": None
        })
    
    def should_continue_reasoning(self) -> bool:
        """Agent decides: do I have enough info to respond, or do I need more data?"""
        # This is the agent's autonomous decision—not a rule
        if self.confidence >= 0.7:
            return False
        if len(self.actions_taken) >= 5:  # Prevent infinite loops
            return False
        return True
    
    def next_tool_to_call(self) -> Optional[ToolActionType]:
        """Agent autonomously decides which tool to call next (or stops)."""
        
        # If high confidence, respond
        if self.confidence >= 0.7:
            return ToolActionType.STOP_AND_RESPOND
        
        # If no context yet, start with market overview
        if not self.context:
            return ToolActionType.ANALYZE_MARKET
        
        # Once market is understood, decide based on what was asked
        user_intent = self._infer_user_intent()
        
        if user_intent == "pattern_scan":
            if "market_regime" in self.available_data:
                return ToolActionType.SCAN_PATTERNS
            else:
                return ToolActionType.ANALYZE_MARKET
        
        elif user_intent == "ticker_analysis":
            if "market_overview" not in self.available_data:
                return ToolActionType.ANALYZE_MARKET
            if "ticker_fundamentals" not in self.available_data:
                return ToolActionType.GET_FUNDAMENTALS
            if "ticker_technicals" not in self.available_data:
                return ToolActionType.GET_TECHNICALS
            if "ticker_news" not in self.available_data:
                return ToolActionType.GET_NEWS
            return ToolActionType.STOP_AND_RESPOND
        
        elif user_intent == "strategy_work":
            if "market_context" not in self.available_data:
                return ToolActionType.ANALYZE_MARKET
            return ToolActionType.GENERATE_STRATEGY
        
        else:
            # Default: search for context
            if len(self.actions_taken) < 2:
                return ToolActionType.SEARCH_CONTEXT
            return ToolActionType.STOP_AND_RESPOND
    
    def _infer_user_intent(self) -> str:
        """Agent infers what the user is actually trying to do."""
        # This would be based on the conversation, not pre-written rules
        # Simplified version here
        return "pattern_scan"  # Default—would analyze real user message
    
    def add_data(self, data_type: str, data: Dict[str, Any], confidence_increase: float = 0.2):
        """Agent notes that it got data, increases confidence."""
        self.available_data[data_type] = data
        self.confidence = min(1.0, self.confidence + confidence_increase)
        logger.info(f"Agent: Got {data_type}, confidence now {self.confidence:.1%}")


def build_tool_plan(user_message: str, conversation_history: List[Dict] = None) -> Dict[str, Any]:
    """
    Agent autonomously builds a plan for what tools to use and in what order.
    This is NOT a pre-written SOP—it's dynamic reasoning.
    
    Returns:
        Dict with:
        - planned_actions: list of ToolActionType to execute
        - reasoning: why this plan
        - stop_conditions: when to stop (e.g., "confidence >= 0.7")
        - fallbacks: alternative actions if a tool fails
    """
    
    thought = AgentThoughtProcess()
    
    # Step 1: Understand the request
    intent = _analyze_user_intent(user_message, conversation_history)
    thought.add_step(
        f"User is asking about: {intent['category']} (confidence: {intent['confidence']:.0%})",
        next_action=None
    )
    
    # Step 2: Plan the tool sequence
    planned_actions = []
    
    if intent["needs_market_context"]:
        planned_actions.append(ToolActionType.ANALYZE_MARKET)
        thought.add_step("Need market context first—check regime, breadth, leading sectors")
    
    if intent["needs_pattern_scan"]:
        planned_actions.append(ToolActionType.SCAN_PATTERNS)
        thought.add_step("Will scan for bullish patterns using detected regime")
    
    if intent["needs_ticker_deep_dive"]:
        planned_actions.append(ToolActionType.ANALYZE_TICKER)
        thought.add_step("Will analyze ticker using deep dive + news + technicals")
    
    if intent["needs_fundamentals"]:
        planned_actions.append(ToolActionType.GET_FUNDAMENTALS)
        thought.add_step("Will check fundamentals and valuation")
    
    if intent["needs_news"]:
        planned_actions.append(ToolActionType.GET_NEWS)
        thought.add_step("Will search for recent news and catalysts")
    
    if intent["needs_strategy_work"]:
        planned_actions.append(ToolActionType.GENERATE_STRATEGY)
        thought.add_step("Will generate and backtest strategy")
    
    # If no specific actions needed, just respond with what we have
    if not planned_actions:
        planned_actions.append(ToolActionType.STOP_AND_RESPOND)
        thought.add_step("Can respond with existing knowledge")
    
    # Step 3: Build the response plan
    return {
        "user_intent": intent["category"],
        "confidence": intent["confidence"],
        "planned_actions": [str(a) for a in planned_actions],
        "reasoning_steps": thought.steps,
        "stop_conditions": {
            "max_tools": 5,
            "min_confidence": 0.7,
            "timeout_seconds": 30
        },
        "fallback_actions": {
            ToolActionType.ANALYZE_MARKET: "Use cached market data or skip to pattern scan",
            ToolActionType.SCAN_PATTERNS: "Use cached patterns or analyze manually",
            ToolActionType.ANALYZE_TICKER: "Return empty result, continue with other tools"
        }
    }


def _analyze_user_intent(user_message: str, history: List[Dict] = None) -> Dict[str, Any]:
    """
    Agent analyzes what the user is actually asking for.
    Returns structured intent with confidence.
    """
    
    msg_lower = (user_message or "").lower()
    
    # Intent detection (simplified—production would use NLU/LLM)
    needs_market = any(w in msg_lower for w in ["market", "what's moving", "sector", "overview", "breadth"])
    needs_patterns = any(w in msg_lower for w in ["bullish", "setup", "trade", "pattern", "upward", "short", "quick"])
    needs_ticker = any(w in msg_lower for w in ["analyze", "deep dive", "bull case", "bear case", "$", "ticker"])
    needs_news = any(w in msg_lower for w in ["news", "catalyst", "catalyst", "earnings", "announcement"])
    needs_strategy = any(w in msg_lower for w in ["strategy", "backtest", "create", "generate"])
    needs_fundamentals = any(w in msg_lower for w in ["fundamental", "pe", "valuation", "growth", "margin"])
    
    # Infer primary intent
    intent_signals = [
        ("market_overview", needs_market),
        ("pattern_scan", needs_patterns),
        ("ticker_analysis", needs_ticker),
        ("news_research", needs_news),
        ("strategy_work", needs_strategy),
        ("fundamentals", needs_fundamentals),
    ]
    
    primary_intent = max(intent_signals, key=lambda x: x[1])[0] if any(x[1] for x in intent_signals) else "general_chat"
    
    # Calculate confidence based on how many signals match
    signal_count = sum(1 for _, matches in intent_signals if matches)
    confidence = min(0.95, 0.5 + (signal_count * 0.15))
    
    return {
        "category": primary_intent,
        "confidence": confidence,
        "needs_market_context": needs_market or needs_patterns,
        "needs_pattern_scan": needs_patterns,
        "needs_ticker_deep_dive": needs_ticker,
        "needs_fundamentals": needs_fundamentals,
        "needs_news": needs_news,
        "needs_strategy_work": needs_strategy,
    }


class ToolComposer:
    """
    Dynamically composes tool calls based on agent reasoning.
    NOT pre-written SOPs—agent decides what to do based on context.
    """
    
    def __init__(self, available_tools: List[Any]):
        self.tools = {tool.name: tool for tool in available_tools}
        self.call_log = []
        self.max_calls = 5
    
    def should_call_tool(self, tool_name: str, reasoning: str) -> bool:
        """Agent decides if calling this tool makes sense given current context."""
        
        # Don't call same tool twice
        if tool_name in [log["tool"] for log in self.call_log]:
            logger.info(f"Agent: {tool_name} already called, skipping to avoid redundancy")
            return False
        
        # Don't exceed max calls
        if len(self.call_log) >= self.max_calls:
            logger.info(f"Agent: Max tool calls ({self.max_calls}) reached, stopping")
            return False
        
        logger.info(f"Agent: Calling {tool_name} ({reasoning})")
        return True
    
    def execute_action(self, action: ToolActionType, params: Dict[str, Any]) -> Dict[str, Any]:
        """
        Agent executes a planned action.
        This is where the actual tool gets called.
        """
        
        if action == ToolActionType.STOP_AND_RESPOND:
            return {"type": "final", "message": "Agent stopping, ready to respond"}
        
        tool_name_map = {
            ToolActionType.ANALYZE_MARKET: "get_market_overview",
            ToolActionType.SCAN_PATTERNS: "scan_bullish_patterns",
            ToolActionType.ANALYZE_TICKER: "get_stock_deep_dive",
            ToolActionType.GET_FUNDAMENTALS: "get_fundamentals",
            ToolActionType.GET_TECHNICALS: "get_technicals",
            ToolActionType.GET_NEWS: "get_news",
            ToolActionType.SEARCH_CONTEXT: "web_search",
            ToolActionType.GENERATE_STRATEGY: "generate_strategy",
            ToolActionType.BACKTEST_STRATEGY: "run_backtest",
        }
        
        tool_name = tool_name_map.get(action)
        if not tool_name or tool_name not in self.tools:
            logger.warning(f"Tool {tool_name} not available")
            return {"type": "error", "error": f"Tool {tool_name} not available"}
        
        tool = self.tools[tool_name]
        
        try:
            result = tool.invoke(params)
            self.call_log.append({
                "tool": tool_name,
                "action": action,
                "params": params,
                "success": True
            })
            return {"type": "success", "tool": tool_name, "result": result}
        except Exception as e:
            self.call_log.append({
                "tool": tool_name,
                "action": action,
                "params": params,
                "success": False,
                "error": str(e)
            })
            logger.error(f"Tool {tool_name} failed: {e}")
            return {"type": "error", "tool": tool_name, "error": str(e)}
    
    def get_call_summary(self) -> str:
        """Agent reports what it did."""
        if not self.call_log:
            return "No tools called"
        
        successful = [log["tool"] for log in self.call_log if log["success"]]
        failed = [log["tool"] for log in self.call_log if not log["success"]]
        
        summary = f"Called {len(self.call_log)} tool(s): "
        if successful:
            summary += f"✓ {', '.join(successful)}"
        if failed:
            summary += f" ✗ {', '.join(failed)}"
        
        return summary


def autonomous_reasoning_loop(
    user_message: str,
    conversation_history: List[Dict] = None,
    available_tools: List[Any] = None,
    max_iterations: int = 5
) -> Dict[str, Any]:
    """
    Main loop: Agent autonomously reasons about what to do.
    NOT following SOPs—just tools and reasoning.
    
    Returns:
        Dict with:
        - reasoning: agent's thought process
        - actions_taken: what tools were called
        - data_collected: what info was gathered
        - ready_to_respond: whether agent has enough to answer
    """
    
    if available_tools is None:
        available_tools = []
    
    # Step 1: Agent plans what to do
    plan = build_tool_plan(user_message, conversation_history)
    
    # Step 2: Agent executes the plan
    composer = ToolComposer(available_tools)
    data_collected = {}
    iteration = 0
    
    for action_str in plan["planned_actions"]:
        if iteration >= max_iterations:
            logger.info("Agent: Max iterations reached, stopping autonomous reasoning")
            break
        
        try:
            action = ToolActionType[action_str.replace("TOOLACTIONTYPE.", "")]
        except (KeyError, ValueError):
            action = ToolActionType.STOP_AND_RESPOND
        
        if action == ToolActionType.STOP_AND_RESPOND:
            break
        
        # Agent decides to execute this action
        result = composer.execute_action(action, {})
        
        if result["type"] == "success":
            data_collected[result["tool"]] = result["result"]
        
        iteration += 1
    
    return {
        "user_intent": plan["user_intent"],
        "intent_confidence": plan["confidence"],
        "reasoning_steps": plan["reasoning_steps"],
        "actions_taken": composer.get_call_summary(),
        "data_collected": list(data_collected.keys()),
        "ready_to_respond": len(data_collected) > 0 or plan["confidence"] > 0.7,
        "iteration_count": iteration
    }

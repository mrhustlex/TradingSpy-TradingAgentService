"""
LangGraph-based trading agent for flexible, composable workflows.
Replaces the custom ReAct loop with a proper state machine.
"""

import json
import logging
from typing import Any, Dict, List, Optional, Annotated
from dataclasses import dataclass, field
from enum import Enum

from langgraph.graph import StateGraph, START, END
from langgraph.types import StreamWriter
from langchain_core.messages import BaseMessage, HumanMessage, AIMessage
from langchain_openai import ChatOpenAI

logger = logging.getLogger(__name__)


class ActionType(Enum):
    """Types of actions the agent can take."""
    API_CALL = "api_call"
    CONFIRM = "confirm"
    WAIT = "wait"
    DONE = "done"


@dataclass
class AgentState:
    """State maintained across agent loop iterations."""
    # Input
    user_message: str
    intent: str
    available_files: List[str] = field(default_factory=list)
    available_strategies: List[str] = field(default_factory=list)
    
    # LLM config
    provider: str = "openai"
    model: str = "gpt-4o"
    api_key: Optional[str] = None
    
    # Execution state
    messages: List[BaseMessage] = field(default_factory=list)
    actions: List[Dict[str, Any]] = field(default_factory=list)
    action_results: List[Dict[str, Any]] = field(default_factory=list)
    
    # Output
    response: str = ""
    reasoning: str = ""
    execution_steps: List[Dict[str, Any]] = field(default_factory=list)
    market_data: List[Dict[str, Any]] = field(default_factory=list)
    backtest_results: List[Dict[str, Any]] = field(default_factory=list)
    
    # Control flow
    done: bool = False
    iteration: int = 0
    max_iterations: int = 8
    
    # Streaming
    stream_writer: Optional[StreamWriter] = None


def emit_event(state: AgentState, event_type: str, **kwargs):
    """Emit an SSE event to the frontend."""
    if state.stream_writer:
        event = {"type": event_type, **kwargs}
        state.stream_writer(json.dumps(event))


def plan_node(state: AgentState) -> AgentState:
    """LLM planning node — decides what actions to take."""
    state.iteration += 1
    emit_event(state, "progress", label=f"🧠 Agent iteration {state.iteration}/{state.max_iterations}", pct=None, detail="Planning actions…")
    
    # Build system prompt
    system_prompt = f"""You are a sharp, no-BS trading buddy with real-time market data and platform tools.

Available tools:
- get_quote: Real-time price, change%, volume, market cap
- get_chart: OHLCV price chart data
- get_technicals: RSI, SMA20/50/200, trend, support/resistance
- get_news: Latest news headlines
- get_full_analysis: Quote + technicals + news combined
- list_datasets: List all downloaded datasets
- list_strategies: List all saved strategies
- download_data: Download historical CSV data
- run_backtest: Run a backtest
- generate_strategy: Generate a new AI trading strategy
- fetch_article: Fetch and read article text
- wait: Pause for N seconds
- confirm: Ask user a yes/no question

Available Datasets: {state.available_files}
Available Strategies: {state.available_strategies}

RULES:
- For strategy generation: ask clarifying questions first, propose an idea, use confirm before generating
- Always list datasets/strategies before running backtest/generate
- Use exact names from list_strategies/list_datasets
- Never hallucinate data — use real fetched data only

Return JSON: {{"response": "...", "reasoning": "...", "done": true/false, "actions": [...]}}
"""
    
    # Call LLM
    llm = ChatOpenAI(model=state.model, api_key=state.api_key, temperature=0)
    messages = state.messages + [HumanMessage(content=state.user_message)]
    response = llm.invoke(messages)
    
    # Parse response
    try:
        plan = json.loads(response.content)
    except json.JSONDecodeError:
        logger.error(f"Failed to parse LLM response: {response.content}")
        state.done = True
        state.response = "❌ Failed to parse agent response"
        return state
    
    state.messages.append(HumanMessage(content=state.user_message))
    state.messages.append(AIMessage(content=response.content))
    state.response = plan.get("response", "")
    state.reasoning = plan.get("reasoning", "")
    state.actions = plan.get("actions", [])
    state.done = plan.get("done", False)
    
    return state


def execute_node(state: AgentState) -> AgentState:
    """Execute planned actions."""
    if not state.actions:
        return state
    
    emit_event(state, "progress", label="⚡ Executing actions…", pct=None, detail=f"{len(state.actions)} action(s)")
    
    # TODO: Execute actions (API calls, confirmations, waits)
    # For now, just mark as done
    state.action_results = [{"status": "pending"} for _ in state.actions]
    
    return state


def should_continue(state: AgentState) -> str:
    """Decide whether to continue the loop or finish."""
    if state.done or state.iteration >= state.max_iterations:
        return "end"
    if not state.actions:
        return "end"
    return "execute"


def build_agent_graph() -> StateGraph:
    """Build the LangGraph state machine."""
    graph = StateGraph(AgentState)
    
    # Add nodes
    graph.add_node("plan", plan_node)
    graph.add_node("execute", execute_node)
    
    # Add edges
    graph.add_edge(START, "plan")
    graph.add_conditional_edges("plan", should_continue, {"execute": "execute", "end": END})
    graph.add_edge("execute", "plan")
    
    return graph.compile()


# Singleton agent
_agent_graph = None


def get_agent_graph():
    """Get or create the agent graph."""
    global _agent_graph
    if _agent_graph is None:
        _agent_graph = build_agent_graph()
    return _agent_graph

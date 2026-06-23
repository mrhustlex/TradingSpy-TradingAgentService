"""
Workflow orchestration for trading agent.
Handles: generate → backtest → optimize flows.
Keeps agent conversational throughout.
"""

import json
import logging
from typing import Dict, Any, List, Optional
from enum import Enum

logger = logging.getLogger(__name__)


class WorkflowStage(Enum):
    """Stages in a trading workflow."""
    CLARIFY = "clarify"  # Ask user clarifying questions
    PROPOSE = "propose"  # Propose a strategy idea
    CONFIRM = "confirm"  # Get user confirmation
    GENERATE = "generate"  # Generate the strategy
    BACKTEST = "backtest"  # Run backtest
    ANALYZE = "analyze"  # Analyze results
    OPTIMIZE = "optimize"  # Optimize the strategy
    DONE = "done"


class StrategyWorkflow:
    """Orchestrates: clarify → propose → confirm → generate → backtest → analyze → optimize"""
    
    def __init__(self):
        self.stage = WorkflowStage.CLARIFY
        self.user_inputs = {}
        self.generated_strategy = None
        self.backtest_results = None
    
    def get_clarifying_questions(self, ticker: str) -> Dict[str, Any]:
        """Generate clarifying questions for strategy generation."""
        return {
            "response": f"Cool, let's build a strategy for {ticker}. I need to understand what you're going for.\n\n"
                       f"A few quick questions:\n"
                       f"1. **Timeframe** — are you thinking 1-hour swings, daily holds, or longer?\n"
                       f"2. **Entry signal** — what gets you in? RSI oversold? SMA crossover? Momentum?\n"
                       f"3. **Risk tolerance** — how much drawdown can you stomach? 5%? 10%?\n\n"
                       f"Give me your thoughts and I'll put together a strategy.",
            "reasoning": "Asking clarifying questions before generating strategy",
            "thinking": "Need to understand user's preferences: timeframe, entry signal, risk tolerance. This will guide the strategy generation.",
            "actions": []
        }
    
    def propose_strategy(self, ticker: str, timeframe: str, signal: str, risk: str) -> Dict[str, Any]:
        """Propose a concrete strategy idea based on user inputs."""
        self.user_inputs = {
            "ticker": ticker,
            "timeframe": timeframe,
            "signal": signal,
            "risk": risk
        }
        
        # Build a natural proposal
        proposal = f"Alright, here's what I'm thinking for {ticker}:\n\n"
        proposal += f"**Setup**: {signal} entry on {timeframe} timeframe\n"
        proposal += f"**Risk**: {risk} stop loss\n"
        proposal += f"**Idea**: Catch oversold bounces when RSI dips, exit on profit target or trailing stop\n\n"
        proposal += f"Sound good? If you want me to tweak anything, just say so. Otherwise I'll generate the code and backtest it."
        
        return {
            "response": proposal,
            "reasoning": "Proposing concrete strategy based on user inputs",
            "thinking": "User wants a strategy. I've gathered their preferences and proposed a concrete idea. Now waiting for confirmation.",
            "actions": [
                {
                    "type": "confirm",
                    "method": "CONFIRM",
                    "body": {
                        "question": "Ready to generate and backtest this strategy?",
                        "options": ["Yes, let's go", "Tweak it first"],
                        "default": "Yes, let's go"
                    },
                    "label": "Confirm Strategy",
                    "group": 1
                }
            ]
        }
    
    def generate_and_backtest(self, ticker: str) -> Dict[str, Any]:
        """Generate strategy and backtest it."""
        self.stage = WorkflowStage.GENERATE
        
        # Build prompt for strategy generation
        prompt = (
            f"Create a {self.user_inputs.get('timeframe', '1d')} trading strategy for {ticker}. "
            f"Entry: {self.user_inputs.get('signal', 'RSI oversold')}. "
            f"Risk: {self.user_inputs.get('risk', '5%')} stop loss. "
            f"Make it practical and testable."
        )
        
        return {
            "response": "Generating strategy and running backtest… this might take a minute.",
            "reasoning": "Generating strategy and backtesting",
            "thinking": "User confirmed. Now I need to: 1) generate the strategy, 2) wait for it to save, 3) backtest it.",
            "actions": [
                {
                    "type": "api_call",
                    "method": "POST",
                    "path": "/api/backtest/ai/generate",
                    "body": {"prompt": prompt, "mode": "agnostic"},
                    "label": "Generate Strategy",
                    "group": 1,
                    "comment": "Creating AI strategy"
                },
                {
                    "type": "wait",
                    "method": "WAIT",
                    "body": {"seconds": 5, "reason": "Waiting for strategy to save"},
                    "label": "Wait for Save",
                    "group": 2
                },
                {
                    "type": "api_call",
                    "method": "GET",
                    "path": "/api/backtest/strategies",
                    "body": {},
                    "label": "List Strategies",
                    "group": 3,
                    "comment": "Getting saved strategy name"
                }
            ]
        }
    
    def analyze_results(self, strategy_name: str, backtest_results: List[Dict]) -> Dict[str, Any]:
        """Analyze backtest results and propose next steps."""
        self.stage = WorkflowStage.ANALYZE
        self.generated_strategy = strategy_name
        self.backtest_results = backtest_results
        
        if not backtest_results:
            return {
                "response": "Hmm, backtest didn't return results. Let me check what happened.",
                "reasoning": "No backtest results to analyze",
                "actions": []
            }
        
        best = backtest_results[0]
        roi = best.get("roi", 0)
        win_rate = best.get("statistics", {}).get("win_rate", 0) * 100
        
        response = f"Backtest results for **{strategy_name}**:\n\n"
        response += f"**ROI**: {roi:.2f}%\n"
        response += f"**Win Rate**: {win_rate:.1f}%\n"
        response += f"**Trades**: {best.get('statistics', {}).get('total_trades', 0)}\n\n"
        
        if roi > 10:
            response += "That's solid! Want me to optimize it further to squeeze out more gains?"
        elif roi > 0:
            response += "Not bad, but there's room to improve. Want me to optimize it?"
        else:
            response += "Needs work. Want me to tweak it and try again?"
        
        return {
            "response": response,
            "reasoning": "Analyzed backtest results and proposing next steps",
            "thinking": f"Strategy generated and backtested. ROI is {roi:.2f}%. User might want to optimize or iterate.",
            "actions": [
                {
                    "type": "confirm",
                    "method": "CONFIRM",
                    "body": {
                        "question": "Optimize this strategy?",
                        "options": ["Yes, optimize", "No, I'm good"],
                        "default": "Yes, optimize"
                    },
                    "label": "Optimize?",
                    "group": 1
                }
            ]
        }


def create_strategy_workflow() -> StrategyWorkflow:
    """Factory for strategy workflow."""
    return StrategyWorkflow()

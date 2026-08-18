"""
ACP (Agent Communication Protocol) — RESTful agent interoperability layer.

Exposes trading platform capabilities as ACP-compliant agents so external
ACP/A2A agents can discover, invoke, and monitor runs.
"""

import uuid
import json
import logging
import os
import time
import asyncio
import threading
from datetime import datetime, timezone
from typing import List, Optional, Dict, Any
from fastapi import APIRouter, HTTPException, Query, Body
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Schemas (ACP v0.2.0)
# ---------------------------------------------------------------------------

class Error(BaseModel):
    code: str
    message: str
    data: Optional[dict] = None

class AgentName(str): ...

class AgentManifest(BaseModel):
    name: str
    description: str
    input_content_types: List[str] = ["application/json", "text/plain"]
    output_content_types: List[str] = ["application/json", "text/plain"]
    metadata: Optional[dict] = None
    status: Optional[dict] = None

class AgentsListResponse(BaseModel):
    agents: List[AgentManifest]

class MessagePart(BaseModel):
    content_type: str = "text/plain"
    content: Optional[str] = None
    content_url: Optional[str] = None
    name: Optional[str] = None

class Message(BaseModel):
    role: str = "user"
    parts: List[MessagePart] = []

class RunCreateRequest(BaseModel):
    agent_name: Optional[str] = None
    input: List[Message]
    session_id: Optional[str] = None
    mode: Optional[str] = "async"

class RunResumeRequest(BaseModel):
    run_id: str
    await_resume: dict = {}
    mode: str = "async"

class Run(BaseModel):
    agent_name: str
    run_id: str
    session_id: Optional[str] = None
    status: str = "created"
    output: List[Message] = []
    error: Optional[Error] = None
    created_at: str = ""
    finished_at: Optional[str] = None

class Event(BaseModel):
    type: str
    data: Optional[dict] = None

class RunEventsListResponse(BaseModel):
    events: List[Event] = []

class Session(BaseModel):
    id: str
    history: List[str] = []
    state: Optional[dict] = None

# ---------------------------------------------------------------------------
# Agent definitions
# ---------------------------------------------------------------------------

AGENTS = {
    "market-data": AgentManifest(
        name="market-data",
        description="Download and list market data files. Supports tickers across US, HK, and crypto markets. Can download Daily/Max data and list available datasets.",
        input_content_types=["application/json", "text/plain"],
        output_content_types=["application/json"],
        metadata={
            "capabilities": [
                {"name": "Download Data", "description": "Download historical market data for a ticker (default Daily/Max)."},
                {"name": "List Datasets", "description": "List all available local dataset files."},
                {"name": "Check Data", "description": "Check if data exists for a specific ticker."},
            ],
            "domains": ["finance", "market-data"],
            "framework": "custom",
            "programming_language": "Python",
        },
        status={"success_rate": 100, "avg_run_time_seconds": 5.0},
    ),
    "backtest": AgentManifest(
        name="backtest",
        description="Run backtests against market data using built-in and custom trading strategies. Supports stake ranges, trailing stops, and date filtering.",
        input_content_types=["application/json"],
        output_content_types=["application/json"],
        metadata={
            "capabilities": [
                {"name": "Run Backtest", "description": "Execute a backtest with selected dataset and strategies."},
                {"name": "List Strategies", "description": "Return available trading strategies."},
                {"name": "Get Results", "description": "Fetch completed backtest results by task ID."},
            ],
            "domains": ["finance", "trading", "backtesting"],
            "framework": "custom",
            "programming_language": "Python",
        },
        status={"success_rate": 100, "avg_run_time_seconds": 30.0},
    ),
    "intelligence": AgentManifest(
        name="intelligence",
        description="Market intelligence: search tickers, fetch insider trades, ETF holdings, and news for equities and industries.",
        input_content_types=["application/json", "text/plain"],
        output_content_types=["application/json"],
        metadata={
            "capabilities": [
                {"name": "Search Tickers", "description": "Autocomplete search for ticker symbols."},
                {"name": "Insider Trades", "description": "Recent insider trading activity for given tickers."},
                {"name": "ETF Holdings", "description": "Top holdings of ETFs."},
                {"name": "News", "description": "Recent news articles for a ticker."},
            ],
            "domains": ["finance", "intelligence"],
            "framework": "custom",
            "programming_language": "Python",
        },
        status={"success_rate": 100, "avg_run_time_seconds": 8.0},
    ),
    "strategy": AgentManifest(
        name="strategy",
        description="Manage trading strategies. List built-in and custom strategies with their parameters and categories.",
        input_content_types=["application/json"],
        output_content_types=["application/json"],
        metadata={
            "capabilities": [
                {"name": "List Strategies", "description": "Return all available strategies with metadata."},
                {"name": "Get Strategy", "description": "Return details of a specific strategy by name."},
            ],
            "domains": ["finance", "trading", "strategies"],
            "framework": "custom",
            "programming_language": "Python",
        },
        status={"success_rate": 100, "avg_run_time_seconds": 1.0},
    ),
    "ui-assistant": AgentManifest(
        name="ui-assistant",
        description="Run the same UI assistant runtime: general chat via /api/backtest/ai/chat-with-tools and explicit workflows via /api/agent/runs (market_review, strategy_create, strategy_race).",
        input_content_types=["application/json", "text/plain"],
        output_content_types=["application/json"],
        metadata={
            "capabilities": [
                {"name": "General Assistant Chat", "description": "Same tool-using assistant path as the web UI chat."},
                {"name": "Market Review", "description": "Same market review workflow as the UI."},
                {"name": "Strategy Create", "description": "Same strategy generation workflow as the UI."},
                {"name": "Strategy Race", "description": "Same iterative benchmark workflow as the UI."},
                {"name": "Fundamental Screener", "description": "Same screener workflow as the UI."},
            ],
            "domains": ["finance", "trading", "assistant"],
            "framework": "ui-runtime-proxy",
            "programming_language": "Python",
        },
        status={"success_rate": 100, "avg_run_time_seconds": 45.0},
    ),
}

# ---------------------------------------------------------------------------
# In-memory run store
# ---------------------------------------------------------------------------

runs: Dict[str, dict] = {}
sessions: Dict[str, dict] = {}

def _now():
    return datetime.now(timezone.utc).isoformat()

def _run_id():
    return str(uuid.uuid4())

def _session_id():
    return str(uuid.uuid4())

def _run_async_in_thread(coro):
    """Run an async coroutine from sync code even when an event loop is already running."""
    result = {"value": None, "error": None}

    def _runner():
        try:
            result["value"] = asyncio.run(coro)
        except Exception as exc:
            result["error"] = exc

    thread = threading.Thread(target=_runner, daemon=True)
    thread.start()
    thread.join()
    if result["error"] is not None:
        raise result["error"]
    return result["value"]

def _get_or_create_session(session_id: str) -> dict:
    if session_id not in sessions:
        sessions[session_id] = {
            "id": session_id,
            "history": [],
            "state": {
                "active_agent": None,
                "sticky": True,
                "route_reason": None,
            },
        }
    sessions[session_id].setdefault("history", [])
    state = sessions[session_id].setdefault("state", {})
    if not isinstance(state, dict):
        state = {"active_agent": None, "sticky": True, "route_reason": None}
        sessions[session_id]["state"] = state
    state.setdefault("active_agent", None)
    state.setdefault("sticky", True)
    state.setdefault("route_reason", None)
    return sessions[session_id]

# ---------------------------------------------------------------------------
# Run execution helpers (called in background)
# ---------------------------------------------------------------------------

def _execute_market_data(run: dict, input_text: str):
    """Execute a market-data agent run."""
    from main import MARKET_DATA_DIR, LOCAL_USER_ID, get_user_dirs
    from downloader import download_ticker_data

    try:
        cmd = json.loads(input_text) if input_text.startswith("{") else {"action": "list", "ticker": input_text.strip()}
    except json.JSONDecodeError:
        cmd = {"action": "list", "ticker": input_text.strip()}

    action = cmd.get("action", "list")
    run["status"] = "in-progress"

    try:
        if action == "list":
            _, _, user_dir = get_user_dirs(LOCAL_USER_ID)
            files = sorted([f for f in os.listdir(user_dir) if f.endswith((".txt", ".csv"))])
            result = {"files": files, "count": len(files)}
            run["output"] = [Message(role="agent", parts=[MessagePart(content_type="application/json", content=json.dumps(result))])]
            run["status"] = "completed"

        elif action in ("download", "sync"):
            ticker = cmd.get("ticker", "").strip().upper()
            if not ticker:
                raise ValueError("ticker is required")
            _, _, user_dir = get_user_dirs(LOCAL_USER_ID)
            dest = download_ticker_data(
                ticker, interval=cmd.get("interval", "1d"),
                period=cmd.get("period", "max"), output_dir=user_dir
            )
            if dest:
                result = {"ticker": ticker, "file": os.path.basename(dest), "status": "downloaded"}
            else:
                result = {"ticker": ticker, "status": "no data returned"}
            run["output"] = [Message(role="agent", parts=[MessagePart(content_type="application/json", content=json.dumps(result))])]
            run["status"] = "completed"

        elif action == "check":
            ticker = cmd.get("ticker", "").strip().upper()
            _, _, user_dir = get_user_dirs(LOCAL_USER_ID)
            files = [f for f in os.listdir(user_dir)
                     if f.upper().startswith(ticker + "-") and f.endswith((".txt", ".csv"))]
            result = {"ticker": ticker, "available": len(files) > 0, "files": sorted(files)}
            run["output"] = [Message(role="agent", parts=[MessagePart(content_type="application/json", content=json.dumps(result))])]
            run["status"] = "completed"

        else:
            raise ValueError(f"Unknown action: {action}")

    except Exception as e:
        logger.exception("market-data run failed")
        run["status"] = "failed"
        run["error"] = Error(code="server_error", message=str(e))

    run["finished_at"] = _now()


def _execute_backtest(run: dict, input_text: str):
    """Execute a backtest agent run."""
    from main import run_backtests_task

    try:
        cmd = json.loads(input_text)
    except json.JSONDecodeError:
        run["status"] = "failed"
        run["error"] = Error(code="invalid_input", message="Expected JSON input")
        run["finished_at"] = _now()
        return

    run["status"] = "in-progress"

    try:
        if cmd.get("action") == "list_strategies":
            from strategies import STRATEGY_MAP, STRATEGY_CATEGORIES
            strats = []
            for name, fn in STRATEGY_MAP.items():
                strats.append({
                    "name": name,
                    "category": STRATEGY_CATEGORIES.get(name, "General"),
                    "is_custom": False,
                })
            run["output"] = [Message(role="agent", parts=[MessagePart(
                content_type="application/json", content=json.dumps({"strategies": strats})
            )])]
            run["status"] = "completed"

        elif cmd.get("action") == "run":
            task_id = _run_id()
            _run_async_in_thread(run_backtests_task(
                    task_id=task_id,
                    dataset_filename=cmd["dataset"],
                    strategies=cmd["strategies"],
                    stake_range=cmd.get("stake_range", [10, 50, 95]),
                    trail_range=cmd.get("trail_range", [0.0, 0.05, 0.15]),
                    start_date=cmd.get("start_date", ""),
                    end_date=cmd.get("end_date", ""),
                    sequential=cmd.get("sequential", False),
                    user_id="local_user",
                ))
            run["output"] = [Message(role="agent", parts=[MessagePart(
                content_type="application/json", content=json.dumps({"task_id": task_id, "status": "started"})
            )])]
            run["status"] = "completed"

        elif cmd.get("action") == "list_datasets":
            from main import MARKET_DATA_DIR, LOCAL_USER_ID, get_user_dirs
            _, _, user_dir = get_user_dirs(LOCAL_USER_ID)
            files = sorted([f for f in os.listdir(user_dir) if f.endswith((".txt", ".csv"))])
            run["output"] = [Message(role="agent", parts=[MessagePart(
                content_type="application/json", content=json.dumps({"files": files})
            )])]
            run["status"] = "completed"

        else:
            raise ValueError(f"Unknown action: {cmd.get('action')}")

    except Exception as e:
        logger.exception("backtest run failed")
        run["status"] = "failed"
        run["error"] = Error(code="server_error", message=str(e))

    run["finished_at"] = _now()


def _execute_intelligence(run: dict, input_text: str):
    """Execute an intelligence agent run."""
    from main import LOCAL_USER_ID

    try:
        cmd = json.loads(input_text) if input_text.startswith("{") else {"action": "search", "query": input_text.strip()}
    except json.JSONDecodeError:
        cmd = {"action": "search", "query": input_text.strip()}

    run["status"] = "in-progress"

    try:
        action = cmd.get("action", "search")

        if action == "search":
            query = cmd.get("query", "")
            import yfinance as yf
            results_obj = yf.Search(query, max_results=8)
            quotes = results_obj.quotes if hasattr(results_obj, 'quotes') else []
            results = [
                {"symbol": r.get("symbol", ""), "name": r.get("longname") or r.get("shortname", ""), "type": r.get("quoteType", "")}
                for r in quotes
            ]
            run["output"] = [Message(role="agent", parts=[MessagePart(
                content_type="application/json", content=json.dumps({"results": results})
            )])]
            run["status"] = "completed"

        elif action == "insider_trades":
            tickers = cmd.get("tickers", [])
            days_back = cmd.get("days_back", 90)
            limit = cmd.get("limit", 30)
            from market_intelligence import market_intel
            trades = market_intel.get_insider_transactions(tickers, days_back=days_back, limit=limit, offset=0)
            run["output"] = [Message(role="agent", parts=[MessagePart(
                content_type="application/json", content=json.dumps(trades)
            )])]
            run["status"] = "completed"

        elif action == "news":
            ticker = cmd.get("ticker", "")
            limit = cmd.get("limit", 10)
            from market_intelligence import market_intel
            news = market_intel.get_ticker_news(ticker, limit=limit)
            run["output"] = [Message(role="agent", parts=[MessagePart(
                content_type="application/json", content=json.dumps({"news": news})
            )])]
            run["status"] = "completed"

        elif action == "etf_holdings":
            etfs = cmd.get("etfs", [])
            import yfinance as yf
            holdings = {}
            for etf in etfs:
                try:
                    t = yf.Ticker(etf)
                    info = t.info or {}
                    top_holdings = []
                    try:
                        h = t.holdings
                        if h:
                            for hh in h[:10]:
                                top_holdings.append({"symbol": hh.get("symbol", ""), "name": hh.get("holdingName", ""), "percent": hh.get("holdingPercent", 0)})
                    except Exception:
                        pass
                    holdings[etf] = {"name": info.get("shortName", etf), "top_holdings": top_holdings}
                except Exception as e:
                    holdings[etf] = {"error": str(e)}
            run["output"] = [Message(role="agent", parts=[MessagePart(
                content_type="application/json", content=json.dumps({"holdings": holdings})
            )])]
            run["status"] = "completed"

        else:
            raise ValueError(f"Unknown action: {action}")

    except Exception as e:
        logger.exception("intelligence run failed")
        run["status"] = "failed"
        run["error"] = Error(code="server_error", message=str(e))

    run["finished_at"] = _now()


def _execute_strategy(run: dict, input_text: str):
    """Execute a strategy agent run."""
    from strategies import STRATEGY_MAP, STRATEGY_CATEGORIES

    try:
        cmd = json.loads(input_text) if input_text.startswith("{") else {"action": "list"}
    except json.JSONDecodeError:
        cmd = {"action": "list"}

    run["status"] = "in-progress"

    try:
        action = cmd.get("action", "list")

        if action == "list":
            strats = []
            for name, fn in STRATEGY_MAP.items():
                strats.append({
                    "name": name,
                    "category": STRATEGY_CATEGORIES.get(name, "General"),
                })
            run["output"] = [Message(role="agent", parts=[MessagePart(
                content_type="application/json", content=json.dumps({"strategies": strats})
            )])]
            run["status"] = "completed"

        elif action == "get":
            name = cmd.get("name", "")
            if name in STRATEGY_MAP:
                run["output"] = [Message(role="agent", parts=[MessagePart(
                    content_type="application/json", content=json.dumps({
                        "name": name,
                        "category": STRATEGY_CATEGORIES.get(name, "General"),
                    })
                )])]
                run["status"] = "completed"
            else:
                raise ValueError(f"Strategy not found: {name}")

        else:
            raise ValueError(f"Unknown action: {action}")

    except Exception as e:
        logger.exception("strategy run failed")
        run["status"] = "failed"
        run["error"] = Error(code="server_error", message=str(e))

    run["finished_at"] = _now()

def _execute_ui_assistant(run: dict, input_text: str):
    """Execute the same workflow runtime used by the UI /api/agent/runs."""
    from main import (
        AgentRunRequest,
        AIChatRequest,
        LOCAL_USER_ID,
        _agent_plan_for_request,
        _safe_agent_run,
        agent_run_task,
        agent_runs,
        agent_runs_table,
        chat_with_tools_streaming,
        normalize_agent_run_request,
    )
    from tinydb import Query

    class _InternalRequest:
        async def is_disconnected(self):
            return False

    async def _run_ui_chat(cmd: Dict[str, Any], prompt: str) -> Dict[str, Any]:
        request = AIChatRequest(
            message=prompt,
            intent=cmd.get("intent") or "general",
            api_key=cmd.get("api_key"),
            provider_config=cmd.get("provider_config"),
            provider=cmd.get("provider"),
            model=cmd.get("model"),
            available_files=cmd.get("available_files") or [],
            available_strategies=cmd.get("available_strategies") or [],
            context=cmd.get("context") or {},
            history=cmd.get("history") or [],
            history_limit=int(cmd.get("history_limit") or 20),
            thinking_detail=cmd.get("thinking_detail") or "normal",
            agent_instructions=cmd.get("agent_instructions"),
            max_tokens=int(cmd.get("max_tokens") or 8192),
        )
        streaming = await chat_with_tools_streaming(request, _InternalRequest())

        done_event = None
        latest_response = ""
        error_message = None
        buffer = ""

        async for chunk in streaming.body_iterator:
            text = chunk.decode("utf-8", errors="ignore") if isinstance(chunk, (bytes, bytearray)) else str(chunk)
            buffer += text
            lines = buffer.split("\n")
            buffer = lines.pop() if lines else ""
            for line in lines:
                if not line.startswith("data: "):
                    continue
                raw = line[6:].strip()
                if not raw:
                    continue
                try:
                    event = json.loads(raw)
                except Exception:
                    continue
                event_type = event.get("type")
                if event_type == "response" and isinstance(event.get("content"), str):
                    latest_response = event["content"]
                elif event_type == "done":
                    done_event = event
                elif event_type == "error":
                    error_message = event.get("content") or "Chat streaming failed"

        if done_event is None and error_message:
            raise RuntimeError(error_message)

        return {
            "response": latest_response,
            "thinking": (done_event or {}).get("thinking"),
            "steps": (done_event or {}).get("steps") or [],
            "tools_used": (done_event or {}).get("tools_used") or [],
            "data": (done_event or {}).get("data") or {},
            "triggered_tasks": (done_event or {}).get("triggered_tasks") or [],
            "suggestions": (done_event or {}).get("suggestions") or [],
        }

    try:
        cmd = json.loads(input_text) if input_text.startswith("{") else {"prompt": input_text.strip()}
    except json.JSONDecodeError:
        cmd = {"prompt": input_text.strip()}

    prompt = (cmd.get("prompt") or cmd.get("message") or input_text or "").strip()
    if not prompt:
        raise ValueError("prompt is required")

    run["status"] = "in-progress"

    try:
        workflow = cmd.get("workflow")

        # General assistant questions (no explicit workflow) use the same
        # frontend path: /api/backtest/ai/chat-with-tools.
        if not workflow:
            chat_payload = _run_async_in_thread(_run_ui_chat(cmd, prompt))
            run["output"] = [Message(role="agent", parts=[MessagePart(
                content_type="application/json", content=json.dumps(chat_payload, default=str)
            )])]
            run["status"] = "completed"
            run["finished_at"] = _now()
            return

        request = normalize_agent_run_request(AgentRunRequest(
            workflow=workflow,
            prompt=prompt,
            ticker=cmd.get("ticker"),
            dataset_filename=cmd.get("dataset_filename"),
            period=cmd.get("period") or "5y",
            interval=cmd.get("interval") or "1d",
            extended_hours=bool(cmd.get("extended_hours", False)),
            candidate_count=int(cmd.get("candidate_count") or 3),
            max_backtest_workers=int(cmd.get("max_backtest_workers") or 4),
            max_rounds=int(cmd.get("max_rounds") or 30),
            stop_after_no_improvement=int(cmd.get("stop_after_no_improvement") or 5),
            benchmark_buy_hold=bool(cmd.get("benchmark_buy_hold", True)),
            benchmark_strategy=cmd.get("benchmark_strategy"),
            benchmark_mode=cmd.get("benchmark_mode") or "auto",
            require_fresh_data=bool(cmd.get("require_fresh_data", True)),
            strategies=cmd.get("strategies") or [],
            start_date=cmd.get("start_date"),
            end_date=cmd.get("end_date"),
            stake_range=cmd.get("stake_range"),
            trail_range=cmd.get("trail_range"),
            sequential=bool(cmd.get("sequential", False)),
            initial_cash=float(cmd.get("initial_cash") or 100000.0),
            commission=float(cmd.get("commission") or 0.001),
            available_files=cmd.get("available_files") or [],
            available_strategies=cmd.get("available_strategies") or [],
            history=cmd.get("history") or [],
            history_limit=int(cmd.get("history_limit") or 20),
            thinking_detail=cmd.get("thinking_detail") or "normal",
            agent_instructions=cmd.get("agent_instructions"),
            max_tokens=int(cmd.get("max_tokens") or 8192),
            api_key=cmd.get("api_key"),
            provider_config=cmd.get("provider_config"),
            provider=cmd.get("provider"),
            model=cmd.get("model"),
            screen_universe=cmd.get("screen_universe"),
            screen_requirements=cmd.get("screen_requirements"),
            screen_max_results=int(cmd.get("screen_max_results") or 5),
            screen_max_checked=int(cmd.get("screen_max_checked") or 30),
            target_min_roi=cmd.get("target_min_roi"),
        ))

        agent_run_id = f"AGENT_{uuid.uuid4().hex[:10].upper()}"
        ui_run = {
            "run_id": agent_run_id,
            "workflow": request.workflow,
            "status": "queued",
            "progress": 0,
            "current_step": "Queued from ACP",
            "events": [{"ts": _now(), "type": "queued", "message": "Queued from ACP ui-assistant"}],
            "plan_steps": _agent_plan_for_request(request),
            "config": request.dict(),
            "created_at": datetime.now().isoformat(),
            "user_id": LOCAL_USER_ID,
            "stop_requested": False,
            "source": "acp",
        }
        agent_runs[agent_run_id] = ui_run
        agent_runs_table.upsert(_safe_agent_run(ui_run), Query().run_id == agent_run_id)

        _run_async_in_thread(agent_run_task(agent_run_id, request))

        final = agent_runs.get(agent_run_id) or agent_runs_table.get(Query().run_id == agent_run_id) or {}
        final_status = (final.get("status") or "failed").lower()
        payload = {
            "agent_run_id": agent_run_id,
            "workflow": request.workflow,
            "status": final_status,
            "current_step": final.get("current_step"),
            "progress": final.get("progress"),
            "summary_text": final.get("summary_text"),
            "summary": final.get("summary"),
            "outcome": final.get("outcome"),
            "accepted_version": final.get("accepted_version"),
            "comparison_benchmark": final.get("comparison_benchmark"),
            "baseline_result": final.get("baseline_result"),
            "error": final.get("error"),
            "events_tail": (final.get("events") or [])[-20:],
            "plan_steps": final.get("plan_steps"),
            "dataset_filename": final.get("dataset_filename"),
            "ticker": final.get("ticker"),
        }
        run["output"] = [Message(role="agent", parts=[MessagePart(
            content_type="application/json", content=json.dumps(payload, default=str)
        )])]
        run["status"] = final_status if final_status in {"completed", "failed", "stopped", "cancelled"} else "completed"
        if run["status"] == "failed":
            err = final.get("error") or "UI runtime workflow failed"
            run["error"] = Error(code="ui_runtime_failed", message=str(err))

    except Exception as e:
        logger.exception("ui-assistant run failed")
        run["status"] = "failed"
        run["error"] = Error(code="server_error", message=str(e))

    run["finished_at"] = _now()


_EXECUTORS = {
    "market-data": _execute_market_data,
    "backtest": _execute_backtest,
    "intelligence": _execute_intelligence,
    "strategy": _execute_strategy,
    "ui-assistant": _execute_ui_assistant,
}

# ---------------------------------------------------------------------------
# FastAPI router
# ---------------------------------------------------------------------------

router = APIRouter()


@router.get("/ping")
async def ping():
    return {"status": "ok", "protocol": "acp", "version": "0.2.0"}


@router.get("/agents", response_model=AgentsListResponse)
async def list_agents(limit: int = Query(10, ge=1, le=1000), offset: int = Query(0, ge=0)):
    all_agents = list(AGENTS.values())
    sliced = all_agents[offset:offset + limit]
    return AgentsListResponse(agents=sliced)


@router.get("/agents/{name}", response_model=AgentManifest)
async def get_agent(name: str):
    agent = AGENTS.get(name)
    if not agent:
        raise HTTPException(status_code=404, detail=Error(code="not_found", message=f"Agent '{name}' not found").model_dump())
    return agent


@router.post("/runs", response_model=Run)
async def create_run(request: RunCreateRequest):
    run_id = _run_id()
    session_id = request.session_id or _session_id()
    session = _get_or_create_session(session_id)
    session_state = session["state"]
    requested_agent = (request.agent_name or "").strip() or None
    active_agent = session_state.get("active_agent")

    if active_agent:
        agent_name = active_agent
        route_reason = "sticky_session"
    elif requested_agent:
        agent_name = requested_agent
        session_state["active_agent"] = agent_name
        route_reason = "initial_route"
    else:
        raise HTTPException(
            status_code=400,
            detail=Error(
                code="missing_agent",
                message="agent_name is required for the first run in a session. Later runs can omit it because the session keeps the active agent.",
            ).model_dump(),
        )

    session_state["route_reason"] = route_reason
    session_state["last_requested_agent"] = requested_agent

    if agent_name not in AGENTS:
        raise HTTPException(status_code=404, detail=Error(code="not_found", message=f"Agent '{agent_name}' not found").model_dump())

    # Extract input text
    input_text = ""
    for msg in request.input:
        for part in msg.parts:
            if part.content:
                input_text += part.content + "\n"
    input_text = input_text.strip()

    run = {
        "agent_name": agent_name,
        "run_id": run_id,
        "session_id": session_id,
        "status": "created",
        "output": [],
        "error": None,
        "created_at": _now(),
        "finished_at": None,
        "_input": input_text,
        "_route_reason": route_reason,
    }
    runs[run_id] = run

    # Execute synchronously for simplicity
    executor = _EXECUTORS.get(agent_name)
    if executor:
        executor(run, input_text)

    session["history"].append(f"user: {input_text}")
    if run.get("output"):
        output_text = "\n".join(
            part.content or ""
            for msg in run["output"]
            for part in msg.parts
            if part.content
        ).strip()
        if output_text:
            session["history"].append(f"{agent_name}: {output_text[:1000]}")
    session_state["last_run_id"] = run_id
    session_state["current_agent"] = agent_name
    session_state["updated_at"] = _now()

    return Run(
        agent_name=run["agent_name"],
        run_id=run["run_id"],
        session_id=run.get("session_id"),
        status=run["status"],
        output=run["output"],
        error=run.get("error"),
        created_at=run["created_at"],
        finished_at=run.get("finished_at"),
    )


@router.get("/runs/{run_id}", response_model=Run)
async def get_run(run_id: str):
    run = runs.get(run_id)
    if not run:
        raise HTTPException(status_code=404, detail=Error(code="not_found", message=f"Run '{run_id}' not found").model_dump())
    return Run(
        agent_name=run["agent_name"],
        run_id=run["run_id"],
        session_id=run.get("session_id"),
        status=run["status"],
        output=run["output"],
        error=run.get("error"),
        created_at=run["created_at"],
        finished_at=run.get("finished_at"),
    )


@router.post("/runs/{run_id}")
async def resume_run(run_id: str, request: RunResumeRequest):
    run = runs.get(run_id)
    if not run:
        raise HTTPException(status_code=404, detail=Error(code="not_found", message=f"Run '{run_id}' not found").model_dump())
    run["status"] = "in-progress"
    return Run(
        agent_name=run["agent_name"],
        run_id=run["run_id"],
        session_id=run.get("session_id"),
        status=run["status"],
        output=run["output"],
        error=run.get("error"),
        created_at=run["created_at"],
        finished_at=run.get("finished_at"),
    )


@router.post("/runs/{run_id}/cancel")
async def cancel_run(run_id: str):
    run = runs.get(run_id)
    if not run:
        raise HTTPException(status_code=404, detail=Error(code="not_found", message=f"Run '{run_id}' not found").model_dump())
    run["status"] = "cancelled"
    run["finished_at"] = _now()
    return Run(
        agent_name=run["agent_name"],
        run_id=run["run_id"],
        session_id=run.get("session_id"),
        status=run["status"],
        output=run["output"],
        error=run.get("error"),
        created_at=run["created_at"],
        finished_at=run.get("finished_at"),
    )


@router.get("/runs/{run_id}/events", response_model=RunEventsListResponse)
async def list_run_events(run_id: str):
    run = runs.get(run_id)
    if not run:
        raise HTTPException(status_code=404, detail=Error(code="not_found", message=f"Run '{run_id}' not found").model_dump())
    return RunEventsListResponse(events=[
        Event(type="run.created", data={"run_id": run_id}),
        Event(type=f"run.{run['status']}", data={"run_id": run_id}),
    ])


@router.get("/session/{session_id}", response_model=Session)
async def get_session(session_id: str):
    s = _get_or_create_session(session_id)
    return Session(id=s["id"], history=s.get("history", []), state=s.get("state"))

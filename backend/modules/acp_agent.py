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
from datetime import datetime, timezone
from typing import List, Optional, Dict
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
            import asyncio
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                task_id = _run_id()
                loop.run_until_complete(run_backtests_task(
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
            finally:
                loop.close()
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


_EXECUTORS = {
    "market-data": _execute_market_data,
    "backtest": _execute_backtest,
    "intelligence": _execute_intelligence,
    "strategy": _execute_strategy,
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

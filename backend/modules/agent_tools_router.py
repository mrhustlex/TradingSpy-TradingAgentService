"""
Agent Tools router — three surfaces over the shared tool registry:

  POST /mcp                    MCP (Model Context Protocol) server, stateless
                               streamable-HTTP mode: JSON-RPC over HTTP with
                               plain application/json responses.
  GET  /api/tools/manifest     OpenAI function-calling "tools" array.
  POST /api/tools/invoke       Generic dispatcher: {"name", "arguments"}.

Enable/disable and bearer-token auth are handled centrally by
AssistantOutputGateMiddleware in main.py (toggle: enable_agent_tools_output /
ENABLE_AGENT_TOOLS env; token: remote_agent_auth_token / REMOTE_AGENT_AUTH_TOKEN).
"""

import base64
import json
import logging
from typing import Any, Dict

from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse, Response

from agent_tools import (
    ImageResult,
    TOOLS,
    dispatch_tool,
    dumps_safe,
    mcp_tool_definitions,
    openai_manifest,
)


def _result_to_mcp_content(result: Any) -> Dict[str, Any]:
    """Wrap a tool result as MCP tools/call content (text or image)."""
    if isinstance(result, ImageResult):
        return {
            "content": [
                {
                    "type": "image",
                    "data": base64.b64encode(result.data).decode("ascii"),
                    "mimeType": result.mime_type,
                }
            ],
            "isError": False,
        }
    return {"content": [{"type": "text", "text": dumps_safe(result)}], "isError": False}

logger = logging.getLogger(__name__)

router = APIRouter()

JSONRPC_PARSE_ERROR = -32700
JSONRPC_INVALID_REQUEST = -32600
JSONRPC_METHOD_NOT_FOUND = -32601


def _rpc_result(msg_id: Any, result: dict) -> dict:
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


def _rpc_error(msg_id: Any, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}


async def _call_tool(name: str, arguments: Dict[str, Any]) -> dict:
    """Run a tool and wrap the outcome as an MCP tools/call result."""
    try:
        result = await dispatch_tool(name, arguments)
        return _result_to_mcp_content(result)
    except KeyError:
        return {
            "content": [{"type": "text", "text": dumps_safe({"error": f"Unknown tool '{name}'"})}],
            "isError": True,
        }
    except TypeError as exc:
        return {
            "content": [{"type": "text", "text": dumps_safe({"error": f"Invalid arguments: {exc}"})}],
            "isError": True,
        }
    except Exception as exc:
        logger.exception("Agent tool '%s' failed", name)
        return {
            "content": [{"type": "text", "text": dumps_safe({"error": str(exc)})}],
            "isError": True,
        }


@router.post("/mcp")
async def mcp_endpoint(request: Request):
    try:
        message = await request.json()
    except Exception:
        return JSONResponse(_rpc_error(None, JSONRPC_PARSE_ERROR, "Parse error"), status_code=400)

    if not isinstance(message, dict):
        return JSONResponse(_rpc_error(None, JSONRPC_INVALID_REQUEST, "Batch requests are not supported"), status_code=400)

    method = message.get("method")
    msg_id = message.get("id")
    params = message.get("params") or {}

    if method == "initialize":
        requested = str(params.get("protocolVersion") or "2024-11-05")
        return _rpc_result(msg_id, {
            "protocolVersion": requested,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "tradingspy", "version": "1.0.0"},
            "instructions": (
                "TradingSpy deterministic market tools: datasets, quotes, news, technicals, "
                "insider trades, fundamental screening and backtesting. You provide the reasoning; "
                "these tools provide the data and compute."
            ),
        })

    if method == "notifications/initialized":
        return Response(status_code=202)

    if method is None:
        # A response from client to server; nothing to do in stateless mode.
        return Response(status_code=202)

    if method == "tools/list":
        return _rpc_result(msg_id, {"tools": mcp_tool_definitions()})

    if method == "tools/call":
        tool_params = params if isinstance(params, dict) else {}
        result = await _call_tool(tool_params.get("name"), tool_params.get("arguments") or {})
        return _rpc_result(msg_id, result)

    if method == "ping":
        return _rpc_result(msg_id, {})

    if msg_id is None:
        return Response(status_code=202)
    return JSONResponse(_rpc_error(msg_id, JSONRPC_METHOD_NOT_FOUND, f"Method not found: {method}"))


@router.get("/api/tools/manifest")
async def tools_manifest():
    return {"tools": openai_manifest()}


@router.post("/api/tools/invoke")
async def tools_invoke(body: Dict[str, Any] = Body(default_factory=dict)):
    name = body.get("name")
    arguments = body.get("arguments") or {}
    if not isinstance(arguments, dict):
        return JSONResponse({"error": "'arguments' must be an object"}, status_code=400)
    try:
        result = await dispatch_tool(name, arguments)
    except KeyError:
        available = ", ".join(sorted(t["name"] for t in TOOLS))
        return JSONResponse({"error": f"Unknown tool '{name}'. Available tools: {available}"}, status_code=404)
    except TypeError as exc:
        return JSONResponse({"error": f"Invalid arguments: {exc}"}, status_code=400)
    except Exception as exc:
        logger.exception("Agent tool '%s' failed", name)
        return JSONResponse({"error": str(exc)}, status_code=500)
    if isinstance(result, ImageResult):
        return {
            "name": name,
            "image": {
                "mime_type": result.mime_type,
                "data": base64.b64encode(result.data).decode("ascii"),
            },
        }
    return {"name": name, "result": json.loads(dumps_safe(result))}

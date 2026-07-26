# TradingSpy ACP Skills

This folder exposes reusable skills so other agents can call TradingSpy through ACP without using the UI.

## Skill: `tradingspy-ui-assistant-acp`

Use this skill when an external agent needs the **same workflow runtime as the web UI**.

- Protocol: ACP v0.2
- Base URL: `http://localhost:8000/acp`
- ACP agent name: `ui-assistant`
- Auth: optional bearer token (`Authorization: Bearer <REMOTE_AGENT_AUTH_TOKEN>`) when configured

### General assistant mode (same as UI chat)

If you send plain text (or JSON with `prompt` / `message`) **without `workflow`**, ACP `ui-assistant` uses the same backend chat path as the UI:

- `/api/backtest/ai/chat-with-tools`

This supports normal questions, analysis, and tool-using conversational requests.

### Supported UI workflows

- `market_review`
- `strategy_create`
- `strategy_race`
- `fundamental_screener`

## How to call

### 1. Discover agents

`GET /acp/agents`

### 2. Create a run

`POST /acp/runs`

Body:

```json
{
  "agent_name": "ui-assistant",
  "input": [
    {
      "role": "user",
      "parts": [
        {
          "content_type": "application/json",
          "content": "{\"workflow\":\"strategy_race\",\"prompt\":\"Generate until it beats buy and hold for QQQ\",\"ticker\":\"QQQ\"}"
        }
      ]
    }
  ]
}
```

If `workflow` is omitted, runtime intent fallback is used from `prompt`.

For general chat mode, you can also send:

```json
{
  "agent_name": "ui-assistant",
  "input": [
    {
      "role": "user",
      "parts": [
        {
          "content_type": "text/plain",
          "content": "What are the strongest and weakest industries today?"
        }
      ]
    }
  ]
}
```

### 3. Check run

`GET /acp/runs/{run_id}`

The run output includes:

- `agent_run_id` (underlying UI runtime run id)
- `workflow`
- `status`
- `progress`
- `current_step`
- `summary_text` / `summary` / `outcome`
- `accepted_version` and benchmark fields (when applicable)

## Skill presets

### Market review

```json
{"workflow":"market_review","prompt":"Give me a short market review for today","period":"1d"}
```

### Strategy create

```json
{"workflow":"strategy_create","prompt":"Create a momentum strategy for NVDA daily candles","ticker":"NVDA"}
```

### Strategy race

```json
{"workflow":"strategy_race","prompt":"Generate until it beats buy and hold for QQQ","ticker":"QQQ"}
```

### Fundamental screener

```json
{"workflow":"fundamental_screener","prompt":"Scan AI stocks and return 5 strong candidates","screen_max_results":5}
```

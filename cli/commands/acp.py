"""ACP remote-agent commands."""

import json
from urllib import error, request

import click


def _request(api_url, method, path, payload=None, token=None):
    base = api_url.rstrip("/")
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"

    req = request.Request(f"{base}{path}", data=data, headers=headers, method=method)
    try:
        with request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode("utf-8")
            return resp.status, json.loads(body) if body else {}
    except error.HTTPError as exc:
        body = exc.read().decode("utf-8")
        try:
            parsed = json.loads(body) if body else {}
        except json.JSONDecodeError:
            parsed = {"error": "http_error", "message": body or str(exc)}
        return exc.code, parsed
    except error.URLError as exc:
        raise click.ClickException(f"Backend not reachable at {base}: {exc.reason}") from exc


def _echo_json(data):
    click.echo(json.dumps(data, indent=2, sort_keys=True))


def _fail_if_error(status, data):
    if status < 400:
        return
    message = data.get("message") or data.get("detail") or data.get("error") or data
    raise click.ClickException(f"ACP request failed ({status}): {message}")


@click.group()
@click.option("--api", default="http://localhost:8000", show_default=True, help="Backend API URL")
@click.option("--token", envvar="TRADINGSPY_REMOTE_AGENT_TOKEN", help="Bearer token for protected ACP/A2A outputs")
@click.pass_context
def acp_group(ctx, api, token):
    """Call TradingSpy's ACP Agent endpoints from the terminal."""
    ctx.ensure_object(dict)
    ctx.obj["api"] = api
    ctx.obj["token"] = token


@acp_group.command()
@click.option("--json-output", "--json", "json_output", is_flag=True, help="Print raw JSON")
@click.pass_context
def ping(ctx, json_output):
    """Check whether ACP is enabled and reachable."""
    status, data = _request(ctx.obj["api"], "GET", "/acp/ping", token=ctx.obj["token"])
    _fail_if_error(status, data)
    if json_output:
        _echo_json(data)
    else:
        click.secho(f"ACP {data.get('version', '')} is reachable", fg="green")


@acp_group.command()
@click.option("--json-output", "--json", "json_output", is_flag=True, help="Print raw JSON")
@click.pass_context
def agents(ctx, json_output):
    """List exposed ACP agents."""
    status, data = _request(ctx.obj["api"], "GET", "/acp/agents", token=ctx.obj["token"])
    _fail_if_error(status, data)
    if json_output:
        _echo_json(data)
        return
    for agent in data.get("agents", []):
        click.secho(agent.get("name", "unknown"), fg="cyan", bold=True)
        click.echo(f"  {agent.get('description', '')}")


@acp_group.command("agent")
@click.argument("name")
@click.option("--json-output", "--json", "json_output", is_flag=True, help="Print raw JSON")
@click.pass_context
def agent_info(ctx, name, json_output):
    """Show one ACP agent manifest."""
    status, data = _request(ctx.obj["api"], "GET", f"/acp/agents/{name}", token=ctx.obj["token"])
    _fail_if_error(status, data)
    if json_output:
        _echo_json(data)
    else:
        click.secho(data.get("name", name), fg="cyan", bold=True)
        click.echo(data.get("description", ""))
        capabilities = (data.get("metadata") or {}).get("capabilities") or []
        for capability in capabilities:
            click.echo(f"  - {capability.get('name')}: {capability.get('description', '')}")


@acp_group.command()
@click.argument("agent_name")
@click.option("--input", "input_text", required=True, help="Plain text or JSON command sent as ACP message content")
@click.option("--session-id", help="Reuse an ACP session ID")
@click.option("--json-output", "--json", "json_output", is_flag=True, help="Print raw JSON")
@click.pass_context
def run(ctx, agent_name, input_text, session_id, json_output):
    """Run an ACP agent once."""
    payload = {
        "agent_name": agent_name,
        "session_id": session_id,
        "input": [
            {
                "role": "user",
                "parts": [{"content_type": "text/plain", "content": input_text}],
            }
        ],
    }
    status, data = _request(ctx.obj["api"], "POST", "/acp/runs", payload=payload, token=ctx.obj["token"])
    _fail_if_error(status, data)
    if json_output:
        _echo_json(data)
        return
    click.secho(f"Run {data.get('run_id')} · {data.get('status')}", fg="green")
    for message in data.get("output", []):
        for part in message.get("parts", []):
            content = part.get("content")
            if content:
                click.echo(content)


@acp_group.command("get")
@click.argument("run_id")
@click.option("--json-output", "--json", "json_output", is_flag=True, help="Print raw JSON")
@click.pass_context
def get_run(ctx, run_id, json_output):
    """Fetch an ACP run by ID."""
    status, data = _request(ctx.obj["api"], "GET", f"/acp/runs/{run_id}", token=ctx.obj["token"])
    _fail_if_error(status, data)
    if json_output:
        _echo_json(data)
    else:
        click.secho(f"Run {data.get('run_id')} · {data.get('status')}", fg="green")
        if data.get("error"):
            click.echo(data["error"])


@acp_group.command()
@click.argument("run_id")
@click.pass_context
def cancel(ctx, run_id):
    """Cancel an ACP run."""
    status, data = _request(ctx.obj["api"], "POST", f"/acp/runs/{run_id}/cancel", token=ctx.obj["token"])
    _fail_if_error(status, data)
    click.secho(f"Run {data.get('run_id')} · {data.get('status')}", fg="yellow")


if __name__ == "__main__":
    acp_group()

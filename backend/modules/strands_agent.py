"""
Strands Agent Loop Implementation
Implements the Strands agent loop pattern: Reasoning → Tool Selection → Tool Execution → Repeat
Reference: https://strandsagents.com/docs/user-guide/concepts/agents/agent-loop/
"""

import json
import asyncio
import logging
from typing import List, Dict, Any, AsyncGenerator
from langchain_core.messages import HumanMessage, AIMessage

logger = logging.getLogger(__name__)


class StrandsAgentLoop:
    """
    Implements the Strands agent loop pattern for autonomous reasoning and tool use.
    
    The loop operates on a simple principle:
    1. Reasoning: Invoke the model with accumulated context
    2. Tool Selection: Check if model wants to use tools
    3. Tool Execution: Execute selected tools in parallel
    4. Loop: Add results to context and repeat until model produces final response
    """
    
    def __init__(self, llm, tools: List[Any], max_iterations: int = 10, response_length: str = "normal"):
        self.llm = llm
        self.tools = tools
        # NO MAX ITERATION LIMIT - Use timeout-based control instead
        # The agent continues until model produces final response OR user stops OR timeout reached
        self.max_iterations = float('inf')  # Unlimited iterations
        self.response_length = response_length  # Track for logging
        self.tool_map = {tool.name: tool for tool in tools}
        # Task tracking for user stop feature
        self.stop_requested = False
        import uuid
        self.task_id = str(uuid.uuid4())
        logger.info(f"StrandsAgentLoop initialized with unlimited iterations (task_id: {self.task_id})")
    
    async def run(
        self,
        user_message: str,
        history: List[Dict[str, str]] = None,
        system_prompt: str = ""
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Run the Strands agent loop.
        
        Yields events:
        - {'type': 'thinking', 'content': str}
        - {'type': 'step', 'step': {...}}
        - {'type': 'progress', 'label': str, 'pct': int, 'detail': str}
        - {'type': 'task_started', 'task_id': str, 'task_type': str, 'label': str}
        - {'type': 'response', 'content': str}
        - {'type': 'done', 'thinking': str, 'steps': list, 'tools_used': list, 'data': dict, 'loop_iterations': int}
        - {'type': 'error', 'content': str}
        """
        
        try:
            # Initialize conversation history
            conversation_history = []
            
            # Add history if provided
            if history:
                for h in history[-12:]:
                    role, content = h.get("role"), h.get("content", "")
                    if role == "user":
                        conversation_history.append(HumanMessage(content=content))
                    elif role == "assistant" and content:
                        conversation_history.append(AIMessage(content=content))
            
            # Add current user message
            conversation_history.append(HumanMessage(content=user_message))
            
            # Initialize tracking
            loop_iteration = 0
            tools_used_total = []
            all_steps = []
            triggered_tasks = []
            tool_data = {}
            
            yield {"type": "thinking", "content": "Starting Strands agent loop (unlimited iterations, timeout-based)..."}
            
            # Main loop - continues until model responds, user stops, or timeout reached
            while True:  # Unlimited iterations
                loop_iteration += 1
                logger.info(f"[LOOP {loop_iteration}] Starting iteration (response_length={self.response_length})")
                
                # Yield loop progress indicator (shows user the agent is actively thinking/looping)
                yield {"type": "thinking", "content": f"Loop {loop_iteration}: Reasoning phase starting..."}
                yield {"type": "progress", "label": f"🔄 Agent Loop {loop_iteration}", "pct": 0, "detail": "Analyzing context and planning next steps..."}
                
                # CHECK FOR STOP SIGNAL
                if self.stop_requested:
                    logger.info(f"[LOOP {loop_iteration}] Stop signal received by agent")
                    stop_step = {
                        "label": "⏹️ User Stopped",
                        "status": "warning",
                        "comment": "Task stopped by user request",
                        "note": f"Completed {loop_iteration - 1} iterations before stop"
                    }
                    all_steps.append(stop_step)
                    yield {"type": "step", "step": stop_step}
                    yield {
                        "type": "done",
                        "thinking": f"Agent stopped by user after {loop_iteration - 1} iterations",
                        "steps": all_steps,
                        "tools_used": list(set(tools_used_total)),
                        "data": tool_data,
                        "triggered_tasks": triggered_tasks,
                        "loop_iterations": loop_iteration - 1
                    }
                    break
                
                # REASONING PHASE
                yield {"type": "thinking", "content": f"[Loop {loop_iteration}] Reasoning phase: analyzing context..."}
                
                llm_with_tools = self.llm.bind_tools(self.tools)
                try:
                    loop = asyncio.get_event_loop()
                    response = await asyncio.wait_for(
                        loop.run_in_executor(None, lambda: llm_with_tools.invoke(conversation_history)),
                        timeout=60
                    )
                except asyncio.TimeoutError:
                    logger.error(f"[LOOP {loop_iteration}] LLM reasoning timed out after 60s")
                    yield {"type": "error", "content": f"LLM reasoning timed out after 60 seconds. Try again or simplify your request."}
                    return
                
                # TOOL SELECTION PHASE
                if hasattr(response, "tool_calls") and response.tool_calls:
                    yield {"type": "thinking", "content": f"[Loop {loop_iteration}] Tool selection: LLM selected {len(response.tool_calls)} tools"}
                    
                    # TOOL EXECUTION PHASE
                    tool_results = []
                    
                    for tool_call in response.tool_calls:
                        tool_name = tool_call.get("name")
                        tool_input = tool_call.get("args", {})
                        
                        yield {"type": "thinking", "content": f"[Loop {loop_iteration}] Executing tool: {tool_name}"}
                        
                        step_start = {
                            "label": f"🔧 {tool_name}",
                            "status": "running",
                            "comment": f"Executing {tool_name}",
                            "note": str(tool_input)[:100]
                        }
                        all_steps.append(step_start)
                        yield {"type": "step", "step": step_start}
                        
                        # Execute tool
                        if tool_name in self.tool_map:
                            try:
                                tool = self.tool_map[tool_name]
                                loop = asyncio.get_event_loop()
                                result = await loop.run_in_executor(None, lambda: tool.func(**tool_input))
                                
                                tool_results.append({
                                    "tool_name": tool_name,
                                    "result": result,
                                    "error": None
                                })
                                
                                tool_data[tool_name] = result
                                tools_used_total.append(tool_name)
                                
                                # Handle async tasks
                                if isinstance(result, dict) and result.get("task_id"):
                                    async for item in self._handle_async_task(
                                        tool_name, result, loop_iteration, triggered_tasks, tool_data, all_steps
                                    ):
                                        yield item
                                
                                step_success = {
                                    "label": f"✅ {tool_name}",
                                    "status": "success",
                                    "comment": "Tool executed successfully",
                                    "note": str(result)[:100]
                                }
                                all_steps.append(step_success)
                                yield {"type": "step", "step": step_success}
                                
                                logger.info(f"✓ Tool {tool_name} executed in loop iteration {loop_iteration}")
                                
                            except Exception as e:
                                logger.error(f"Tool {tool_name} error: {e}")
                                tool_results.append({
                                    "tool_name": tool_name,
                                    "result": None,
                                    "error": str(e)
                                })
                                
                                step_error = {
                                    "label": f"❌ {tool_name}",
                                    "status": "error",
                                    "comment": "Tool execution failed",
                                    "note": str(e)[:100]
                                }
                                all_steps.append(step_error)
                                yield {"type": "step", "step": step_error}
                        else:
                            tool_results.append({
                                "tool_name": tool_name,
                                "result": None,
                                "error": "Tool not found"
                            })
                    
                    # Add tool results to conversation history (accumulate context)
                    # Convert response to AIMessage to avoid tool_calls mismatch
                    conversation_history.append(AIMessage(content=response.content if hasattr(response, 'content') else ""))
                    
                    tool_summary = ""
                    for tr in tool_results:
                        if tr["error"]:
                            tool_summary += f"\n{tr['tool_name']}: ERROR - {tr['error']}"
                        else:
                            tool_summary += f"\n{tr['tool_name']}: {json.dumps(tr['result'], indent=2)[:300]}"
                    
                    conversation_history.append(HumanMessage(content=tool_summary))
                    
                    # Loop continues
                    yield {"type": "thinking", "content": f"[Loop {loop_iteration}] Tool results added to context. Continuing loop..."}
                
                else:
                    # NO TOOLS SELECTED: Generate final response
                    yield {"type": "thinking", "content": f"[Loop {loop_iteration}] No tools selected. Generating final response..."}
                    
                    response_text = ""
                    if hasattr(response, 'content'):
                        response_text = response.content
                    else:
                        # Stream from LLM
                        for chunk in self.llm.stream(conversation_history):
                            if hasattr(chunk, 'content') and chunk.content:
                                response_text += chunk.content
                                yield {"type": "response", "content": response_text}
                    
                    # Exit loop
                    final_step = {
                        "label": "💬 Final Response",
                        "status": "success",
                        "comment": f"Generated after {loop_iteration} loop iterations",
                        "note": f"Response length: {len(response_text)} chars"
                    }
                    all_steps.append(final_step)
                    yield {"type": "step", "step": final_step}
                    
                    # Send completion
                    tools_summary = f"Strands loop completed in {loop_iteration} iterations. Used {len(set(tools_used_total))} unique tools: {', '.join(set(tools_used_total)) if tools_used_total else 'none'}"
                    logger.info(f"[DONE] Agent completed after {loop_iteration} iterations (tools: {tools_summary})")
                    yield {
                        "type": "done",
                        "thinking": tools_summary,
                        "steps": all_steps,
                        "tools_used": list(set(tools_used_total)),
                        "data": tool_data,
                        "triggered_tasks": triggered_tasks,
                        "loop_iterations": loop_iteration
                    }
                    break
        
        except Exception as e:
            logger.error(f"Strands loop error: {e}", exc_info=True)
            yield {"type": "error", "content": str(e)}
    
    async def _handle_async_task(self, tool_name, result, loop_iteration, triggered_tasks, tool_data, all_steps):
        """Handle async task polling and completion with dynamic timeout and observability."""
        task_id = result.get("task_id")
        if not task_id:
            logger.warning(f"[LOOP {loop_iteration}] No task_id found in result from {tool_name}")
            return
        
        task_label = f"{tool_name}: {result.get('ticker', result.get('strategy', 'Task'))}"
        
        # Determine task type
        if tool_name == "generate_strategy":
            task_type = "forge"
        elif tool_name == "run_backtest":
            task_type = "backtest"
        elif tool_name == "download_market_data":
            task_type = "download"
        else:
            task_type = "task"
        
        triggered_tasks.append({"task_id": task_id, "task_type": task_type, "label": task_label})
        logger.info(f"[LOOP {loop_iteration}] Task started: {task_type}={task_id}, label={task_label}")
        yield {"type": "task_started", "task_id": task_id, "task_type": task_type, "label": task_label}
        
        yield {"type": "thinking", "content": f"[Loop {loop_iteration}] Waiting for {tool_name} (task_id: {task_id}) to complete..."}
        
        # Dynamic timeout based on task type (matching agentic agent logic)
        if tool_name == "download_market_data":
            max_seconds = 300  # 5 minutes
        elif tool_name == "generate_strategy":
            max_seconds = 600  # 10 minutes
        elif tool_name == "run_backtest":
            max_seconds = 1800  # 30 minutes for backtests
        else:
            max_seconds = 1200  # 20 minutes default
        
        # Poll with 1-second interval (2x faster than 2-second)
        max_polls = max_seconds
        poll_count = 0
        task_completed = False
        
        logger.info(f"[LOOP {loop_iteration}] Polling strategy: max_seconds={max_seconds}, task_type={tool_name}, max_polls={max_polls}")
        
        while poll_count < max_polls:
            await asyncio.sleep(1)  # 1-second interval instead of 2
            poll_count += 1
            
            # Call check_task_status tool
            if "check_task_status" in self.tool_map:
                try:
                    check_tool = self.tool_map["check_task_status"]
                    loop = asyncio.get_event_loop()
                    status_result = await loop.run_in_executor(None, lambda: check_tool.func(task_id))
                    
                    status = status_result.get("status", "unknown")
                    progress = status_result.get("progress", 0)
                    current = status_result.get("current", "")
                    
                    if poll_count % 30 == 0:  # Log every 30 seconds
                        logger.info(f"[LOOP {loop_iteration}] Poll {poll_count}/{max_polls}: status={status}, progress={progress}%, label={task_label}")
                    
                    # Yield progress update
                    progress_pct = min(50 + (poll_count % 50), 99)
                    detail = f"{current}" if current else f"Processing... ({progress}% complete)"
                    yield {"type": "progress", "label": task_label, "pct": progress_pct, "detail": detail}
                    
                    if status == "completed":
                        # Task completed successfully
                        results = status_result.get("results", {})
                        tool_data[task_id] = results
                        
                        # For download tasks, extract filenames for agent use
                        filenames = results.get("filenames", [])
                        filenames_note = f" Files: {', '.join(filenames)}" if filenames else ""
                        
                        step_complete = {
                            "label": f"✅ {task_label}",
                            "status": "success",
                            "comment": "Task completed successfully",
                            "note": f"Completed after {poll_count} status checks ({poll_count} seconds){filenames_note}"
                        }
                        all_steps.append(step_complete)
                        yield {"type": "step", "step": step_complete}
                        
                        # For downloads, also yield filename info so agent can use it
                        if tool_name == "download_market_data" and filenames:
                            yield {"type": "info", "label": "Downloaded Files", "details": {
                                "filenames": filenames,
                                "ready_for_backtest": True
                            }}
                        
                        yield {"type": "progress", "label": task_label, "pct": 100, "detail": "Task completed"}
                        logger.info(f"[LOOP {loop_iteration}] ✓ Task {task_id} completed after {poll_count} polls ({tool_name})")
                        task_completed = True
                        return
                    
                    elif status == "failed":
                        # Task failed
                        error = status_result.get("error", "Unknown error")
                        
                        step_failed = {
                            "label": f"❌ {task_label}",
                            "status": "error",
                            "comment": "Task failed",
                            "note": f"Error: {str(error)[:100]}"
                        }
                        all_steps.append(step_failed)
                        yield {"type": "step", "step": step_failed}
                        logger.error(f"[LOOP {loop_iteration}] ✗ Task {task_id} failed after {poll_count} polls: {error}")
                        task_completed = True
                        return
                    
                    # Status is "running" or "initializing" - continue polling
                    if poll_count % 10 == 0:  # Log every 10 seconds
                        logger.info(f"[LOOP {loop_iteration}] Task {task_id} still running ({status}). Poll {poll_count}/{max_polls}")
                    
                except Exception as e:
                    logger.error(f"[LOOP {loop_iteration}] Error checking task status for {task_id}: {e}")
                    # Continue polling even if status check fails
                    yield {"type": "progress", "label": task_label, "pct": min(50 + poll_count, 99), "detail": f"Polling... (attempt {poll_count})"}
            else:
                logger.warning(f"[LOOP {loop_iteration}] check_task_status tool not available")
                yield {"type": "progress", "label": task_label, "pct": min(50 + poll_count, 99), "detail": f"Processing..."}
        
        # Max polls exceeded - timeout
        if not task_completed:
            step_timeout = {
                "label": f"⏱️ {task_label}",
                "status": "info",
                "comment": "Task polling timeout",
                "note": f"Task still running after {max_polls} seconds ({max_seconds}s limit). Continuing in background."
            }
            all_steps.append(step_timeout)
            yield {"type": "step", "step": step_timeout}
            logger.warning(f"[LOOP {loop_iteration}] Task {task_id} polling timeout after {max_polls} seconds ({tool_name})")

---
name: luna-agent
description: Use before creating a subagent or assigning work to an existing agent. Manage one Luna agent for simple operations in browsers, documents, and other tools.
---

# Luna

Luna handles simple, explicit operations. The main agent owns analysis, decisions, descriptions, and prepared text; delegate a concrete task to Luna instead of issuing a long sequence of MCP calls yourself.

## One agent

- First call `collaboration.list_agents`; check the existing subagent's model, status, and current task. Ask it for missing details if needed.
- Reuse an existing subagent: use `send_message` while it is active and `followup_task` when idle. Queue the next task without unnecessarily interrupting current work. Do not create a second agent.
- If no subagent exists, call `collaboration.spawn_agent` with `task_name="luna"`, `model="gpt-6-luna"`, `reasoning_effort="high"`, and `fork_turns="none"`. Supply necessary context, paths, and constraints explicitly. Luna must not spawn other agents.

## Tasks

- Give one concrete goal or short ordered steps, exact text to insert, a completion criterion, and a report format. Keep complex analysis and decisions with the main agent.
- Only when contents or locations are unknown in advance, ask Luna to open the target and report what it sees: tab names, available controls, or all document sections. Decide the next actions yourself after inspection.
- When the details are known, send precise actions directly: "Open X, find Y, insert this text: ..., verify it was saved." Skip another general inspection.
- If inspection may be incomplete, obtain a current screenshot and inspect it yourself; check the relevant regions for long content.
- If a required element is missing or an action is ambiguous, Luna stops and reports facts. Keep reports brief: actions completed, result, remaining work or blockers.

## Waiting and context

- Set an explicit polling interval and deadline, e.g. "Check every 30 seconds for up to 5 minutes; report completion or timeout." Use a waiting tool between checks; do not poll every second.
- Do independent work while Luna runs. If none remains, end the current turn with a brief note that the task was delegated and its result is pending. Do not poll or call `wait_agent`; Luna's message will resume work.
- Around 70% context usage, use available compaction while preserving the goal, completed actions, current state, references, and next step. If usage metrics or compaction tools are unavailable, do not invent them and tell about that.

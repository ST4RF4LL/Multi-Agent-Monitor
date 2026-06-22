# Multi-Agent Monitor

A web-based monitor and orchestrator for running multiple OpenCode instances in parallel to perform security auditing on microservices. Uses **tmux** for per-instance process isolation and **xterm.js + WebSocket** for real-time terminal access in the browser.

## Features

*   **tmux-based Isolation:** Each instance runs in its own tmux session (`mam-<id>`) — true process isolation, clean lifecycle, human-in-the-loop via `tmux attach`.
*   **Web Terminal:** Real-time terminal streaming via WebSocket + xterm.js — watch each instance's `opencode serve` output live in the browser.
*   **Parallel Execution:** Configurable concurrency limit for batch auditing (e.g., 3 instances at a time).
*   **Real-time Monitoring:** Dashboard using Server-Sent Events (SSE) to track status of all instances.
*   **Interactive Chat:** Select any instance to view audit progress or interact with it via chat (REST API).

## Architecture

```
┌──────────────────────────────────────────────────┐
│     Multi-Agent Monitor (Express + WebSocket)    │
│     http://localhost:8888                         │
├──────────────────────────────────────────────────┤
│  tmux sessions         WebSocket /terminals/ws    │
│  ┌─────────────┐       ┌──────────────────┐      │
│  │ mam-inst-A  │ ←───→ │ xterm.js (chat)  │      │
│  │ :4100       │       │ xterm.js (term)  │      │
│  ├─────────────┤       └──────────────────┘      │
│  │ mam-inst-B  │                                 │
│  │ :4101       │       SSE /api/events            │
│  ├─────────────┤       REST API /api/instances/*  │
│  │ ...         │                                 │
│  └─────────────┘                                 │
└──────────────────────────────────────────────────┘
```

Each instance gets:
- A **dedicated port** (portStart + index)
- A **tmux session** (`mam-<instance-id>`) running `opencode serve`
- **Web terminal** in browser via xterm.js + WebSocket
- **REST API** for programmatic interaction (send prompts, read messages)

## Prerequisites

*   Node.js (v14+)
*   **tmux** (macOS: `brew install tmux`, Linux: `apt install tmux`)
*   OpenCode installed globally or accessible in PATH

## Installation

1.  Clone this repository.
2.  Install dependencies:
    ```bash
    npm install
    ```

## Usage

1.  Start the monitor server:
    ```bash
    npm start
    ```
    *(Optional: `PORT=3030 npm start` for a custom port)*
2.  Open `http://localhost:8888` in your browser.
3.  In the Setup screen, provide:
    *   **OpenCode Root:** Directory containing your OpenCode agent/config settings.
    *   **Project Root:** Directory to scan for Git repositories to audit.
    *   **Audit Prompt:** The initial prompt to send to each instance.
    *   **Max Concurrent:** Number of instances to run simultaneously.
    *   **Starting Port:** Base port — each instance gets portStart + index.
4.  Click "扫描并启动" (Scan and Launch).
5.  In the Monitor dashboard:
    *   **对话 (Chat):** View messages, send prompts, abort sessions.
    *   **终端 (Terminal):** Watch real-time `opencode serve` output via xterm.js.
    *   Click "批量审计" (Batch Audit) to start auditing all instances.

### tmux Attach

To attach to an instance's terminal locally:
```bash
tmux attach -t mam-<instance-id>
```
Example: `tmux attach -t mam-my-service`

### Kill all sessions
```bash
tmux kill-server  # kills all tmux sessions
# Or list and kill specific ones:
tmux list-sessions -F '#{session_name}' -f '#{m:#{session_name},mam-*}'
```

## Configuration

Create a `config.json` (see `config.example.json`):

```json
{
  "openCodeRoot": "/path/to/opencode-agent-config",
  "projectRoot": "/path/to/microservices",
  "auditPrompt": "请对当前微服务项目进行全面的安全审计...",
  "portStart": 4100,
  "backendPort": 8888,
  "maxConcurrent": 3,
  "model": ""
}
```

- `openCodeRoot`: OpenCode agent/config working directory.
- `projectRoot`: Scanned recursively for Git repositories.
- If `openCodeRoot` is omitted, falls back to `projectRoot`.

## API

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/api/events` | SSE stream for real-time updates |
| GET/POST | `/api/config` | Read/update global configuration |
| POST | `/api/scan` | Scan project root for Git repositories |
| GET | `/api/models` | Fetch available models |
| POST | `/api/global-model` | Set global model |
| GET | `/api/instances` | List all instances |
| GET | `/api/instances/:id` | Get single instance |
| POST | `/api/instances/start-all` | Start all instances |
| POST | `/api/instances/stop-all` | Stop all instances |
| POST | `/api/instances/:id/start` | Start single instance |
| POST | `/api/instances/:id/stop` | Stop single instance |
| POST | `/api/instances/:id/model` | Set per-instance model |
| POST | `/api/audit/start` | Start batch audit |
| POST | `/api/audit/:id/start` | Start single audit |
| POST | `/api/audit/:id/abort` | Abort audit |
| GET/POST | `/api/instances/:id/messages/:sessionId` | Read/send messages |
| POST | `/api/instances/:id/prompt/:sessionId` | Send prompt to session |
| POST | `/api/instances/:id/session` | Create new session |
| WS | `/terminals/ws?id=<instanceId>` | WebSocket terminal stream |

## Graceful Shutdown

`SIGINT` / `SIGTERM` kills all `mam-*` tmux sessions and exits cleanly.

# Multi-Agent Monitor

A web-based monitor and orchestrator for running multiple OpenCode CLI instances in parallel to perform security auditing on microservices. Uses **tmux** for per-instance process isolation and **xterm.js + WebSocket** for real-time terminal access in the browser.

## Features

*   **tmux-based Isolation:** Each instance runs in its own tmux session (`mam-<id>`) — true process isolation, clean lifecycle, human-in-the-loop via `tmux attach`.
*   **Web Terminal:** Real-time terminal streaming via WebSocket + xterm.js — watch each instance's `opencode` CLI output live in the browser. Also supports interactive keyboard input.
*   **Parallel Execution:** Configurable concurrency limit for batch auditing with a 30-minute per-instance timeout.
*   **Real-time Monitoring:** Dashboard using Server-Sent Events (SSE) to track status of all instances (stopped, starting, ready, auditing, completed, error).
*   **tmux Terminal Interaction:** Send text/prompts directly to an instance's tmux session via the REST API or the built-in chat panel.
*   **Popup Terminal:** Open a dedicated full-screen xterm.js popup window for any instance with real-time I/O.
*   **Model Configuration:** Supports global and per-instance model selection, auto-discovered from OpenCode configuration.

## Architecture

```
┌──────────────────────────────────────────────────┐
│     Multi-Agent Monitor (Express + WebSocket)    │
│     http://localhost:8888                         │
├──────────────────────────────────────────────────┤
│  tmux sessions          WebSocket /terminals/ws   │
│  ┌─────────────┐       ┌──────────────────┐      │
│  │ mam-inst-A  │ ←───→ │ xterm.js (popup) │      │
│  │ (opencode)  │       │ Chat panel       │      │
│  ├─────────────┤       └──────────────────┘      │
│  │ mam-inst-B  │                                 │
│  │ (opencode)  │       SSE /api/events            │
│  ├─────────────┤       REST API /api/instances/*  │
│  │ ...         │                                 │
│  └─────────────┘                                 │
└──────────────────────────────────────────────────┘
```

Each instance gets:
- A **tmux session** (`mam-<instance-id>`) running `opencode` CLI
- **Web terminal** in browser via xterm.js + WebSocket with `pipe-pane` streaming
- **REST API** for lifecycle control, text input, and audit management

## Prerequisites

*   Node.js (v14+)
*   **tmux** (macOS: `brew install tmux`, Linux: `apt install tmux`)
*   OpenCode CLI installed globally or accessible in PATH

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
    *   **Audit Prompt:** The prompt to send to each instance during batch audit.
    *   **Max Concurrent:** Number of instances to run simultaneously.
    *   **Model:** Optional model override (auto-completed from OpenCode config).
4.  Click "扫描并启动" (Scan and Launch).
5.  In the Monitor dashboard:
    *   Click **启动全部** (Start All) to launch `opencode` in each instance's tmux session.
    *   Click **批量审计** (Batch Audit) to send the audit prompt to all ready instances.
    *   Select an instance to send interactive text via the chat panel.
    *   Click 🖥 to open a dedicated popup terminal for an instance.

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
  "backendPort": 8888,
  "maxConcurrent": 3,
  "model": ""
}
```

- `openCodeRoot`: OpenCode agent/config working directory. If omitted, falls back to `projectRoot` then `cwd`.
- `projectRoot`: Scanned recursively for Git repositories (skips `node_modules`, `dist`, `.git`, etc.).
- `model`: Can be set globally or per-instance from the dashboard.

## API

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/api/events` | SSE stream for real-time updates |
| GET/POST | `/api/config` | Read/update global configuration |
| POST | `/api/scan` | Scan project root for Git repositories |
| GET | `/api/models` | Fetch available models from OpenCode config |
| POST | `/api/global-model` | Set global model |
| GET | `/api/instances` | List all instances |
| GET | `/api/instances/:id` | Get single instance |
| POST | `/api/instances/start-all` | Start all instances |
| POST | `/api/instances/stop-all` | Stop all instances |
| POST | `/api/instances/:id/start` | Start single instance |
| POST | `/api/instances/:id/stop` | Stop single instance |
| POST | `/api/instances/:id/model` | Set per-instance model |
| POST | `/api/instances/:id/send` | Send text to instance terminal |
| POST | `/api/instances/:id/abort` | Abort instance (send Ctrl+C) |
| POST | `/api/audit/start` | Start batch audit |
| POST | `/api/audit/:id/start` | Start single instance audit |
| POST | `/api/audit/:id/abort` | Abort single audit |
| WS | `/terminals/ws?id=<instanceId>` | WebSocket terminal stream |

## Graceful Shutdown

`SIGINT` / `SIGTERM` kills all `mam-*` tmux sessions and exits cleanly.

## Project Structure

```
.
├── server.js              # Main Express server + REST API
├── config.example.json    # Configuration template
├── lib/
│   ├── tmux-manager.js    # Tmux session management wrapper
│   └── terminal-ws.js     # WebSocket terminal streaming via pipe-pane
└── public/
    ├── index.html         # Dashboard UI
    ├── app.js             # Frontend application logic
    ├── index.css          # Stylesheet
    └── terminal.html      # Standalone popup terminal page
```

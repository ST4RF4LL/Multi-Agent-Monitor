# Multi-Agent Monitor

A web-based monitor and orchestrator for running multiple OpenCode instances in parallel to perform security auditing on microservices.

## Features

*   **Process Management:** Manages multiple `opencode serve` child processes, assigning each a unique port.
*   **Parallel Execution:** Configurable concurrency limit for batch auditing (e.g., 3 instances at a time).
*   **Real-time Monitoring:** Real-time dashboard using Server-Sent Events (SSE) to track the status of all instances.
*   **Interactive Chat:** Select any instance to view its audit progress or interact with it via chat.

## Prerequisites

*   Node.js (v14+)
*   OpenCode installed globally or accessible in your PATH.

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
    *(Optional: You can specify a custom port by setting the PORT environment variable, e.g., `set PORT=3030 && npm start`)*
2.  Open your browser and navigate to `http://localhost:8888`.
3.  In the Setup screen, provide:
    *   **Project Root:** The directory containing your microservice subdirectories.
    *   **Audit Prompt:** The initial prompt to send to each instance.
    *   **Max Concurrent:** The number of instances to run simultaneously.
    *   **Starting Port:** The base port number for the instances.
4.  Click "扫描并启动" (Scan and Launch) to discover the subdirectories and start the monitor.
5.  In the Monitor dashboard, click "批量审计" (Batch Audit) to start the auditing process.

## Configuration

You can optionally create a `config.json` based on `config.example.json` to pre-fill settings.

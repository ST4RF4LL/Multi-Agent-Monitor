const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const treeKill = require('tree-kill');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── State ───────────────────────────────────────────────────────────────────

let CONFIG = {
  projectRoot: '',
  auditPrompt: '',
  portStart: 4100,
  backendPort: 3000,
  maxConcurrent: 3,
};

// Instance = { name, dir, port, process, pid, status, sessionId, error, startedAt }
// status: 'stopped' | 'starting' | 'ready' | 'auditing' | 'completed' | 'error'
const instances = new Map();
const sseClients = new Set();

// Queue for batch audit
let auditQueue = [];
let activeAudits = 0;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ocFetch(port, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const method = options.method || 'GET';
    const body = options.body ? JSON.stringify(options.body) : null;
    const reqOpts = {
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    };
    const req = http.request(reqOpts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null });
        } catch {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(msg);
  }
}

function getInstanceSummary(inst) {
  return {
    name: inst.name,
    dir: inst.dir,
    port: inst.port,
    pid: inst.pid || null,
    status: inst.status,
    sessionId: inst.sessionId || null,
    error: inst.error || null,
    startedAt: inst.startedAt || null,
  };
}

async function waitForHealth(port, retries = 40, interval = 1500) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await ocFetch(port, '/global/health');
      if (res.status === 200 && res.data && res.data.healthy) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

// ─── Process Manager ─────────────────────────────────────────────────────────

function startInstance(name) {
  const inst = instances.get(name);
  if (!inst) return { error: `Instance ${name} not found` };
  if (inst.status !== 'stopped' && inst.status !== 'error') {
    return { error: `Instance ${name} is already ${inst.status}` };
  }

  inst.status = 'starting';
  inst.error = null;
  broadcast('instance.update', getInstanceSummary(inst));

  const env = {
    ...process.env,
    OPENCODE_PERMISSION: 'allow',
  };

  const proc = spawn('opencode', ['serve', '--port', String(inst.port), '--hostname', '127.0.0.1'], {
    cwd: inst.dir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    windowsHide: true,
  });

  inst.process = proc;
  inst.pid = proc.pid;
  inst.startedAt = new Date().toISOString();

  proc.stdout.on('data', (data) => {
    const line = data.toString().trim();
    if (line) {
      broadcast('instance.log', { name, type: 'stdout', line });
    }
  });

  proc.stderr.on('data', (data) => {
    const line = data.toString().trim();
    if (line) {
      broadcast('instance.log', { name, type: 'stderr', line });
    }
  });

  proc.on('exit', (code) => {
    if (inst.status !== 'stopped') {
      inst.status = 'error';
      inst.error = `Process exited with code ${code}`;
      broadcast('instance.update', getInstanceSummary(inst));
    }
    inst.process = null;
    inst.pid = null;
  });

  // Wait for health in background
  waitForHealth(inst.port).then((healthy) => {
    if (healthy && inst.status === 'starting') {
      inst.status = 'ready';
      broadcast('instance.update', getInstanceSummary(inst));
    } else if (inst.status === 'starting') {
      inst.status = 'error';
      inst.error = 'Health check timed out';
      broadcast('instance.update', getInstanceSummary(inst));
    }
  });

  return { ok: true };
}

function stopInstance(name) {
  const inst = instances.get(name);
  if (!inst) return { error: `Instance ${name} not found` };
  if (inst.status === 'stopped') return { ok: true };

  inst.status = 'stopped';
  inst.sessionId = null;
  inst.error = null;

  if (inst.pid) {
    try {
      treeKill(inst.pid, 'SIGTERM');
    } catch {}
  }
  inst.process = null;
  inst.pid = null;

  broadcast('instance.update', getInstanceSummary(inst));
  return { ok: true };
}

// ─── Audit Engine ────────────────────────────────────────────────────────────

async function runAuditForInstance(name) {
  const inst = instances.get(name);
  if (!inst || inst.status !== 'ready') return;

  try {
    inst.status = 'auditing';
    broadcast('instance.update', getInstanceSummary(inst));

    // Create session
    const sessionRes = await ocFetch(inst.port, '/session', {
      method: 'POST',
      body: { title: `Audit: ${name}` },
    });

    if (!sessionRes.data || !sessionRes.data.id) {
      throw new Error('Failed to create session');
    }

    const sessionId = sessionRes.data.id;
    inst.sessionId = sessionId;
    broadcast('instance.update', getInstanceSummary(inst));

    // Send audit prompt asynchronously
    await ocFetch(inst.port, `/session/${sessionId}/prompt_async`, {
      method: 'POST',
      body: {
        parts: [{ type: 'text', text: CONFIG.auditPrompt }],
      },
    });

    // Poll for completion
    pollAuditCompletion(name, sessionId);
  } catch (err) {
    inst.status = 'error';
    inst.error = err.message;
    broadcast('instance.update', getInstanceSummary(inst));
    onAuditFinished(name);
  }
}

function pollAuditCompletion(name, sessionId) {
  const inst = instances.get(name);
  if (!inst) return;

  const interval = setInterval(async () => {
    if (inst.status !== 'auditing') {
      clearInterval(interval);
      return;
    }
    try {
      const statusRes = await ocFetch(inst.port, '/session/status');
      if (statusRes.data && statusRes.data[sessionId]) {
        const sessionStatus = statusRes.data[sessionId];
        // If not busy anymore, audit is done
        if (sessionStatus === 'idle' || sessionStatus === 'done') {
          inst.status = 'completed';
          broadcast('instance.update', getInstanceSummary(inst));
          clearInterval(interval);
          onAuditFinished(name);
        }
      }
    } catch {}
  }, 3000);

  // Timeout after 30 minutes
  setTimeout(() => {
    clearInterval(interval);
    if (inst.status === 'auditing') {
      inst.status = 'completed';
      broadcast('instance.update', getInstanceSummary(inst));
      onAuditFinished(name);
    }
  }, 30 * 60 * 1000);
}

function onAuditFinished(name) {
  activeAudits--;
  processAuditQueue();
}

function processAuditQueue() {
  while (auditQueue.length > 0 && activeAudits < CONFIG.maxConcurrent) {
    const name = auditQueue.shift();
    const inst = instances.get(name);
    if (inst && inst.status === 'ready') {
      activeAudits++;
      runAuditForInstance(name);
    }
  }
  broadcast('audit.queue', {
    queued: auditQueue.length,
    active: activeAudits,
    max: CONFIG.maxConcurrent,
  });
}

// ─── API Routes ──────────────────────────────────────────────────────────────

// SSE endpoint
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(`event: connected\ndata: ${JSON.stringify({ time: Date.now() })}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// Config
app.post('/api/config', (req, res) => {
  const { projectRoot, auditPrompt, maxConcurrent, portStart } = req.body;
  if (projectRoot) CONFIG.projectRoot = projectRoot;
  if (auditPrompt) CONFIG.auditPrompt = auditPrompt;
  if (maxConcurrent) CONFIG.maxConcurrent = Number(maxConcurrent);
  if (portStart) CONFIG.portStart = Number(portStart);
  res.json({ ok: true, config: CONFIG });
});

app.get('/api/config', (req, res) => {
  res.json(CONFIG);
});

// Scan project root for subdirectories
app.post('/api/scan', (req, res) => {
  const root = req.body.projectRoot || CONFIG.projectRoot;
  if (!root || !fs.existsSync(root)) {
    return res.status(400).json({ error: 'Invalid project root' });
  }
  CONFIG.projectRoot = root;

  const dirs = fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name);

  // Reset instances
  for (const [name, inst] of instances) {
    stopInstance(name);
  }
  instances.clear();

  dirs.forEach((name, idx) => {
    instances.set(name, {
      name,
      dir: path.join(root, name),
      port: CONFIG.portStart + idx,
      process: null,
      pid: null,
      status: 'stopped',
      sessionId: null,
      error: null,
      startedAt: null,
    });
  });

  broadcast('instances.reset', dirs.map((n) => getInstanceSummary(instances.get(n))));
  res.json({ ok: true, services: dirs });
});

// List all instances
app.get('/api/instances', (req, res) => {
  const list = [];
  for (const inst of instances.values()) {
    list.push(getInstanceSummary(inst));
  }
  res.json(list);
});

// Get single instance
app.get('/api/instances/:name', (req, res) => {
  const inst = instances.get(req.params.name);
  if (!inst) return res.status(404).json({ error: 'Not found' });
  res.json(getInstanceSummary(inst));
});

// Start all instances
app.post('/api/instances/start-all', (req, res) => {
  const results = {};
  for (const [name] of instances) {
    results[name] = startInstance(name);
  }
  res.json(results);
});

// Stop all instances
app.post('/api/instances/stop-all', (req, res) => {
  const results = {};
  for (const [name] of instances) {
    results[name] = stopInstance(name);
  }
  res.json(results);
});

// Start single instance
app.post('/api/instances/:name/start', (req, res) => {
  res.json(startInstance(req.params.name));
});

// Stop single instance
app.post('/api/instances/:name/stop', (req, res) => {
  res.json(stopInstance(req.params.name));
});

// ─── Audit Routes ────────────────────────────────────────────────────────────

// Start batch audit
app.post('/api/audit/start', (req, res) => {
  if (!CONFIG.auditPrompt) {
    return res.status(400).json({ error: 'Audit prompt not set' });
  }

  // Collect all ready or stopped instances
  auditQueue = [];
  activeAudits = 0;
  const needStart = [];

  for (const [name, inst] of instances) {
    if (inst.status === 'ready') {
      auditQueue.push(name);
    } else if (inst.status === 'stopped' || inst.status === 'error' || inst.status === 'completed') {
      needStart.push(name);
    }
  }

  // Start stopped instances, they'll be queued when ready
  for (const name of needStart) {
    startInstance(name);
    auditQueue.push(name);
  }

  // Process queue
  processAuditQueue();

  res.json({
    ok: true,
    queued: auditQueue.length,
    active: activeAudits,
  });
});

// Start single audit
app.post('/api/audit/:name/start', async (req, res) => {
  const inst = instances.get(req.params.name);
  if (!inst) return res.status(404).json({ error: 'Not found' });
  if (!CONFIG.auditPrompt) return res.status(400).json({ error: 'Audit prompt not set' });

  if (inst.status !== 'ready') {
    return res.status(400).json({ error: `Instance is ${inst.status}, not ready` });
  }

  activeAudits++;
  await runAuditForInstance(req.params.name);
  res.json({ ok: true });
});

// Abort audit
app.post('/api/audit/:name/abort', async (req, res) => {
  const inst = instances.get(req.params.name);
  if (!inst) return res.status(404).json({ error: 'Not found' });
  if (!inst.sessionId) return res.status(400).json({ error: 'No active session' });

  try {
    await ocFetch(inst.port, `/session/${inst.sessionId}/abort`, { method: 'POST' });
    inst.status = 'ready';
    broadcast('instance.update', getInstanceSummary(inst));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Proxy Routes (interact with specific opencode instance) ────────────────

// Get sessions for instance
app.get('/api/instances/:name/sessions', async (req, res) => {
  const inst = instances.get(req.params.name);
  if (!inst) return res.status(404).json({ error: 'Not found' });
  try {
    const r = await ocFetch(inst.port, '/session');
    res.json(r.data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Get messages for session
app.get('/api/instances/:name/messages/:sessionId', async (req, res) => {
  const inst = instances.get(req.params.name);
  if (!inst) return res.status(404).json({ error: 'Not found' });
  try {
    const r = await ocFetch(inst.port, `/session/${req.params.sessionId}/message`);
    res.json(r.data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Send message to instance session
app.post('/api/instances/:name/message/:sessionId', async (req, res) => {
  const inst = instances.get(req.params.name);
  if (!inst) return res.status(404).json({ error: 'Not found' });
  try {
    const r = await ocFetch(inst.port, `/session/${req.params.sessionId}/message`, {
      method: 'POST',
      body: req.body,
    });
    res.json(r.data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Send async prompt to instance session
app.post('/api/instances/:name/prompt/:sessionId', async (req, res) => {
  const inst = instances.get(req.params.name);
  if (!inst) return res.status(404).json({ error: 'Not found' });
  try {
    await ocFetch(inst.port, `/session/${req.params.sessionId}/prompt_async`, {
      method: 'POST',
      body: req.body,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Get session status for instance
app.get('/api/instances/:name/session-status', async (req, res) => {
  const inst = instances.get(req.params.name);
  if (!inst) return res.status(404).json({ error: 'Not found' });
  try {
    const r = await ocFetch(inst.port, '/session/status');
    res.json(r.data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Abort session
app.post('/api/instances/:name/abort/:sessionId', async (req, res) => {
  const inst = instances.get(req.params.name);
  if (!inst) return res.status(404).json({ error: 'Not found' });
  try {
    const r = await ocFetch(inst.port, `/session/${req.params.sessionId}/abort`, { method: 'POST' });
    res.json(r.data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Create session
app.post('/api/instances/:name/session', async (req, res) => {
  const inst = instances.get(req.params.name);
  if (!inst) return res.status(404).json({ error: 'Not found' });
  try {
    const r = await ocFetch(inst.port, '/session', {
      method: 'POST',
      body: req.body || {},
    });
    inst.sessionId = r.data.id;
    broadcast('instance.update', getInstanceSummary(inst));
    res.json(r.data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ─── Periodic health check ──────────────────────────────────────────────────

setInterval(async () => {
  for (const [name, inst] of instances) {
    if (inst.status === 'stopped' || inst.status === 'starting') continue;
    try {
      const res = await ocFetch(inst.port, '/global/health');
      if (res.status !== 200 || !res.data?.healthy) {
        if (inst.status !== 'error') {
          inst.status = 'error';
          inst.error = 'Health check failed';
          broadcast('instance.update', getInstanceSummary(inst));
        }
      }
    } catch {
      if (inst.status !== 'error' && inst.status !== 'stopped') {
        inst.status = 'error';
        inst.error = 'Unreachable';
        broadcast('instance.update', getInstanceSummary(inst));
      }
    }
  }

  // Also check for instances waiting in queue that are now ready
  for (const name of [...auditQueue]) {
    const inst = instances.get(name);
    if (inst && inst.status === 'ready') {
      // Will be picked up by processAuditQueue
    }
  }
  if (auditQueue.length > 0) {
    processAuditQueue();
  }
}, 10000);

// ─── Graceful shutdown ──────────────────────────────────────────────────────

process.on('SIGINT', () => {
  console.log('\nShutting down all instances...');
  for (const [name] of instances) {
    stopInstance(name);
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  for (const [name] of instances) {
    stopInstance(name);
  }
  process.exit(0);
});

// ─── Start ──────────────────────────────────────────────────────────────────

const PORT = CONFIG.backendPort;
app.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════════════════╗`);
  console.log(`  ║   Multi-Agent Monitor                            ║`);
  console.log(`  ║   http://localhost:${PORT}                          ║`);
  console.log(`  ╚══════════════════════════════════════════════════╝\n`);
});

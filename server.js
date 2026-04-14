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
  portStart: 4100, // Global Server Port
  backendPort: parseInt(process.env.PORT) || 8888,
  maxConcurrent: 3,
  model: '',
};

let globalServer = {
  process: null,
  pid: null,
  port: 4100,
  status: 'stopped', // 'stopped', 'starting', 'ready', 'error'
  error: null,
  lastErrorLog: null,
};

// Virtual Instances => Maps to a Session on globalServer
// Instance = { name, dir, status, sessionId, error, startedAt }
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
    port: globalServer.port, // All use the single global server port
    pid: globalServer.pid || null,
    status: inst.status,
    sessionId: inst.sessionId || null,
    error: inst.error || null,
    startedAt: inst.startedAt || null,
  };
}

// ─── Global Server Manager ───────────────────────────────────────────────────

async function startGlobalServer() {
  if (globalServer.status === 'ready') return { ok: true };
  if (globalServer.status === 'starting') {
    let retries = 0;
    while (globalServer.status === 'starting' && retries < 40) {
      await new Promise(r => setTimeout(r, 1000));
      retries++;
    }
    if (globalServer.status === 'ready') return { ok: true };
    return { error: 'Global server failed to start' };
  }

  console.log(`[SYSTEM] Starting Global OpenCode Server at ${CONFIG.projectRoot} (Port: ${CONFIG.portStart})`);
  globalServer.status = 'starting';
  globalServer.port = CONFIG.portStart;
  globalServer.error = null;

  const env = {
    ...process.env,
    PORT: String(globalServer.port + 1000), // Internal collision prevention
  };

  const proc = spawn('opencode', ['serve', '--port', String(globalServer.port), '--hostname', '127.0.0.1'], {
    cwd: CONFIG.projectRoot, // Important: Global server anchors at the root
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    windowsHide: true,
  });

  globalServer.process = proc;
  globalServer.pid = proc.pid;

  proc.stdout.on('data', (data) => {
    const line = data.toString().trim();
    if (line) {
      console.log(`[OPNCD OUT]`, line);
    }
  });

  proc.stderr.on('data', (data) => {
    const line = data.toString().trim();
    if (line) {
      console.error(`[OPNCD ERR]`, line);
      globalServer.lastErrorLog = line;
    }
  });

  proc.on('exit', (code) => {
    console.log(`[SYSTEM] Global OpenCode Server Exited (${code})`);
    globalServer.status = 'error';
    globalServer.error = `Global server exited (${code}). ${globalServer.lastErrorLog ? globalServer.lastErrorLog.substring(0, 50) : ''}`;
    globalServer.process = null;
    globalServer.pid = null;

    // Cascade failure to instances
    for (const [name, inst] of instances) {
      if (inst.status !== 'stopped' && inst.status !== 'completed') {
        inst.status = 'error';
        inst.error = 'Global server crashed or was stopped';
        broadcast('instance.update', getInstanceSummary(inst));
      }
    }
  });

  // Wait for health
  for (let i = 0; i < 40; i++) {
    try {
      const res = await ocFetch(globalServer.port, '/global/health');
      if (res.status === 200 && res.data && res.data.healthy) {
        
        // Ensure permissions are globally allowed via REST API (bypasses ENV bugs)
        try {
          await ocFetch(globalServer.port, '/config', {
            method: 'PATCH',
            body: { permission: 'allow' }
          });
        } catch (e) {
          console.error('[SYSTEM] Failed to apply global permissions:', e);
        }

        console.log(`[SYSTEM] Global OpenCode Server Ready!`);
        globalServer.status = 'ready';
        return { ok: true };
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }

  globalServer.status = 'error';
  globalServer.error = 'Health check timed out';
  return { error: 'Global server health check timeout' };
}

async function stopGlobalServer() {
  if (globalServer.pid) {
    try {
      await new Promise((resolve) => treeKill(globalServer.pid, 'SIGTERM', resolve));
    } catch {}
  }
  globalServer.process = null;
  globalServer.pid = null;
  globalServer.status = 'stopped';
}

// ─── Virtual Process Manager ─────────────────────────────────────────────────

async function startInstance(name) {
  const inst = instances.get(name);
  if (!inst) return { error: `Instance ${name} not found` };
  if (inst.status !== 'stopped' && inst.status !== 'error' && inst.status !== 'completed') {
    return { error: `Instance ${name} is already ${inst.status}` };
  }

  inst.status = 'starting';
  inst.error = null;
  broadcast('instance.update', getInstanceSummary(inst));

  const res = await startGlobalServer();
  if (res.error) {
    inst.status = 'error';
    inst.error = res.error;
    broadcast('instance.update', getInstanceSummary(inst));
    return { error: res.error };
  }

  try {
    const sessionRes = await ocFetch(globalServer.port, '/session', {
      method: 'POST',
      body: { title: `Audit: ${name}` },
    });

    if (!sessionRes.data || !sessionRes.data.id) {
      throw new Error('Failed to create session on global server');
    }

    inst.sessionId = sessionRes.data.id;
    inst.status = 'ready';
    inst.startedAt = new Date().toISOString();
    broadcast('instance.update', getInstanceSummary(inst));
    return { ok: true };
  } catch (err) {
    inst.status = 'error';
    inst.error = `Session creation failed: ${err.message}`;
    broadcast('instance.update', getInstanceSummary(inst));
    return { error: err.message };
  }
}

async function stopInstance(name) {
  const inst = instances.get(name);
  if (!inst) return { error: `Instance ${name} not found` };
  if (inst.status === 'stopped') return { ok: true };

  inst.status = 'stopped';
  inst.error = null;

  if (inst.sessionId && globalServer.status === 'ready') {
    try {
      await ocFetch(globalServer.port, `/session/${inst.sessionId}/abort`, { method: 'POST' });
    } catch {}
  }
  
  inst.sessionId = null;
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

    // The agent runs in the projectRoot, so we give it the exact relative/absolute path to focus on.
    const contextualPrompt = `⚠️ 重要指令：请只在以下子目录路径中执行此任务，不要分析外部的兄弟目录文件。\n目标工作目录: [${inst.dir}]\n\n---任务要求---\n${CONFIG.auditPrompt}`;

    const promptBody = {
      parts: [{ type: 'text', text: contextualPrompt }],
      model: CONFIG.model || undefined,
    };

    await ocFetch(globalServer.port, `/session/${inst.sessionId}/prompt_async`, {
      method: 'POST',
      body: promptBody,
    });

    pollAuditCompletion(name, inst.sessionId);
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
    // Global server might be down
    if (globalServer.status !== 'ready') {
      clearInterval(interval);
      return;
    }
    try {
      const msgsRes = await ocFetch(globalServer.port, `/session/${sessionId}/message`);
      if (msgsRes.data && Array.isArray(msgsRes.data) && msgsRes.data.length > 0) {
        const lastMsg = msgsRes.data[msgsRes.data.length - 1];
        if (lastMsg && lastMsg.info && lastMsg.info.finish) {
          inst.status = 'completed';
          broadcast('instance.update', getInstanceSummary(inst));
          clearInterval(interval);
          onAuditFinished(name);
        }
      }
    } catch {}
  }, 3000);

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
  const { projectRoot, auditPrompt, maxConcurrent, portStart, model } = req.body;
  
  if (projectRoot && projectRoot !== CONFIG.projectRoot) {
    // Root changed, stop global server
    stopGlobalServer();
  }
  
  if (projectRoot) CONFIG.projectRoot = projectRoot;
  if (auditPrompt) CONFIG.auditPrompt = auditPrompt;
  if (maxConcurrent) CONFIG.maxConcurrent = Number(maxConcurrent);
  if (portStart) CONFIG.portStart = Number(portStart);
  if (model !== undefined) CONFIG.model = model;
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

  if (root !== CONFIG.projectRoot) {
    stopGlobalServer();
  }
  CONFIG.projectRoot = root;

  const dirs = fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name);

  for (const [name, inst] of instances) {
    stopInstance(name);
  }
  instances.clear();

  dirs.forEach((name) => {
    instances.set(name, {
      name,
      dir: path.join(root, name),
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
app.post('/api/instances/start-all', async (req, res) => {
  const results = {};
  for (const [name] of instances) {
    results[name] = await startInstance(name);
  }
  res.json(results);
});

// Stop all instances
app.post('/api/instances/stop-all', async (req, res) => {
  const results = {};
  for (const [name] of instances) {
    results[name] = await stopInstance(name);
  }
  res.json(results);
});

// Start single instance
app.post('/api/instances/:name/start', async (req, res) => {
  res.json(await startInstance(req.params.name));
});

// Stop single instance
app.post('/api/instances/:name/stop', async (req, res) => {
  res.json(await stopInstance(req.params.name));
});

// ─── Audit Routes ────────────────────────────────────────────────────────────

// Start batch audit
app.post('/api/audit/start', async (req, res) => {
  if (!CONFIG.auditPrompt) {
    return res.status(400).json({ error: 'Audit prompt not set' });
  }

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

  // Pre-start the global server so we don't start it multiple times simultaneously in poor locking
  await startGlobalServer();

  for (const name of needStart) {
    await startInstance(name);
    auditQueue.push(name);
  }

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
    await ocFetch(globalServer.port, `/session/${inst.sessionId}/abort`, { method: 'POST' });
    inst.status = 'ready';
    broadcast('instance.update', getInstanceSummary(inst));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Proxy Routes (interact with specific opencode instance) ────────────────

app.get('/api/instances/:name/sessions', async (req, res) => {
  if (globalServer.status !== 'ready') return res.status(502).json({ error: 'Global server offline' });
  try {
    const r = await ocFetch(globalServer.port, '/session');
    res.json(r.data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/instances/:name/messages/:sessionId', async (req, res) => {
  if (globalServer.status !== 'ready') return res.status(502).json({ error: 'Global server offline' });
  try {
    const r = await ocFetch(globalServer.port, `/session/${req.params.sessionId}/message`);
    res.json(r.data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/instances/:name/message/:sessionId', async (req, res) => {
  if (globalServer.status !== 'ready') return res.status(502).json({ error: 'Global server offline' });
  try {
    const r = await ocFetch(globalServer.port, `/session/${req.params.sessionId}/message`, {
      method: 'POST',
      body: req.body,
    });
    res.json(r.data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/instances/:name/prompt/:sessionId', async (req, res) => {
  if (globalServer.status !== 'ready') return res.status(502).json({ error: 'Global server offline' });
  try {
    await ocFetch(globalServer.port, `/session/${req.params.sessionId}/prompt_async`, {
      method: 'POST',
      body: req.body,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/instances/:name/session-status', async (req, res) => {
  if (globalServer.status !== 'ready') return res.status(502).json({ error: 'Global server offline' });
  try {
    const r = await ocFetch(globalServer.port, '/session/status');
    res.json(r.data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/instances/:name/abort/:sessionId', async (req, res) => {
  if (globalServer.status !== 'ready') return res.status(502).json({ error: 'Global server offline' });
  try {
    const r = await ocFetch(globalServer.port, `/session/${req.params.sessionId}/abort`, { method: 'POST' });
    res.json(r.data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/instances/:name/session', async (req, res) => {
  const inst = instances.get(req.params.name);
  if (!inst) return res.status(404).json({ error: 'Not found' });
  if (globalServer.status !== 'ready') return res.status(502).json({ error: 'Global server offline' });
  
  try {
    const r = await ocFetch(globalServer.port, '/session', {
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
  // Only check global server
  if (globalServer.status === 'ready' || globalServer.status === 'starting') {
    try {
      const res = await ocFetch(globalServer.port, '/global/health');
      if (res.status !== 200 || !res.data?.healthy) {
        if (globalServer.status === 'ready') {
          console.error('[SYSTEM] Global Server Health Check Failed');
          globalServer.status = 'error';
          // Mark all instances
          for (const [name, inst] of instances) {
            if (inst.status !== 'stopped' && inst.status !== 'completed') {
              inst.status = 'error';
              inst.error = 'Global server health check failed';
              broadcast('instance.update', getInstanceSummary(inst));
            }
          }
        }
      }
    } catch {
       if (globalServer.status === 'ready') {
          globalServer.status = 'error';
          for (const [name, inst] of instances) {
            if (inst.status !== 'stopped' && inst.status !== 'completed') {
              inst.status = 'error';
              inst.error = 'Global server unreachable';
              broadcast('instance.update', getInstanceSummary(inst));
            }
          }
       }
    }
  }

  // Check queue
  for (const name of [...auditQueue]) {
    const inst = instances.get(name);
    // if virtual instance is ready, it waits...
  }
  if (auditQueue.length > 0) {
    processAuditQueue();
  }
}, 10000);

// ─── Graceful shutdown ──────────────────────────────────────────────────────

process.on('SIGINT', async () => {
  console.log('\n[SYSTEM] Shutting down global server...');
  if (globalServer.pid) {
    try { 
      await new Promise((resolve) => treeKill(globalServer.pid, 'SIGKILL', resolve)); 
    } catch (err) { 
      console.error(err); 
    }
  }
  process.exit();
});

process.on('SIGTERM', async () => {
  await stopGlobalServer();
  process.exit(0);
});

// ─── Start ──────────────────────────────────────────────────────────────────

const PORT = CONFIG.backendPort;
app.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════════════════╗`);
  console.log(`  ║   Multi-Agent Monitor (Single Server Mode)       ║`);
  console.log(`  ║   http://localhost:${PORT}                          ║`);
  console.log(`  ╚══════════════════════════════════════════════════╝\n`);
});

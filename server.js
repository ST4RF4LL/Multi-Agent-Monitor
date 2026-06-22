const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── State ───────────────────────────────────────────────────────────────────

let CONFIG = {
  openCodeRoot: '',
  projectRoot: '',
  auditPrompt: '',
  backendPort: parseInt(process.env.PORT) || 8888,
  ocPort: 4100,
  maxConcurrent: 3,
  model: '',
};

let globalServer = {
  process: null,
  pid: null,
  port: 4100,
  status: 'stopped',
  error: null,
};

let ocEventSource = null;
const instances = new Map();
const sseClients = new Set();

let auditQueue = [];
let activeAudits = 0;
let auditPaused = false;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function cleanPath(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isDirectory(dir) {
  try { return !!dir && fs.statSync(dir).isDirectory(); } catch { return false; }
}

function isGitRepository(dir) {
  return fs.existsSync(path.join(dir, '.git'));
}

const SCAN_IGNORED_DIRS = new Set([
  '.git', 'node_modules', 'vendor', 'dist', 'build', 'coverage', '.next', '.nuxt', '.cache',
]);

function shouldSkipScanDir(name) {
  return name.startsWith('.') || SCAN_IGNORED_DIRS.has(name);
}

function toPosixRelative(root, target) {
  return path.relative(root, target).replace(/\\/g, '/');
}

function createInstanceId(label, usedIds) {
  const safe = label
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'root';
  let id = safe;
  let suffix = 2;
  while (usedIds.has(id)) { id = `${safe}-${suffix}`; suffix++; }
  usedIds.add(id);
  return id;
}

function discoverGitProjects(root) {
  const projects = [];
  function walk(currentDir) {
    if (isGitRepository(currentDir)) { projects.push(currentDir); return; }
    let entries;
    try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); }
    catch (err) { console.warn(`[SCAN] Skipping ${currentDir}: ${err.message}`); return; }
    entries
      .filter(e => e.isDirectory() && !shouldSkipScanDir(e.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach(e => walk(path.join(currentDir, e.name)));
  }
  walk(root);
  const usedIds = new Set();
  return projects.map(dir => {
    const relDir = toPosixRelative(root, dir);
    return {
      id: createInstanceId(relDir || path.basename(dir) || dir, usedIds),
      name: relDir || path.basename(dir) || dir,
      relDir,
      dir,
    };
  });
}

function getOpenCodeRoot() {
  return CONFIG.openCodeRoot || process.cwd();
}

// ─── OpenCode HTTP helper ────────────────────────────────────────────────────

function ocFetch(port, apiPath, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, `http://127.0.0.1:${port}`);
    const req = http.request(url, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...options.headers },
      timeout: options.timeout || 30000,
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: body ? JSON.parse(body) : null });
        } catch {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

// ─── Config loading ──────────────────────────────────────────────────────────

function loadConfigFile() {
  const configPath = path.join(__dirname, 'config.json');
  if (!fs.existsSync(configPath)) return;
  try {
    const fc = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const root = cleanPath(fc.openCodeRoot) || cleanPath(fc.opencodeRoot) || cleanPath(fc.agentRoot);
    if (root) CONFIG.openCodeRoot = root;
    if (typeof fc.projectRoot === 'string') CONFIG.projectRoot = cleanPath(fc.projectRoot);
    if (typeof fc.auditPrompt === 'string') CONFIG.auditPrompt = fc.auditPrompt;
    if (fc.backendPort && !process.env.PORT) CONFIG.backendPort = Number(fc.backendPort);
    if (fc.ocPort) CONFIG.ocPort = Number(fc.ocPort);
    if (fc.maxConcurrent) CONFIG.maxConcurrent = Number(fc.maxConcurrent);
    if (typeof fc.model === 'string') CONFIG.model = fc.model;
  } catch (err) { console.error('[CONFIG] Failed:', err.message); }
}

loadConfigFile();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) c.write(msg);
}

function getInstanceSummary(inst) {
  return {
    id: inst.id, name: inst.name, relDir: inst.relDir, dir: inst.dir,
    status: inst.status, error: inst.error || null,
    sessionId: inst.sessionId || null,
    startedAt: inst.startedAt || null, model: inst.model || null,
  };
}

// ─── Global opencode serve management ────────────────────────────────────────

function startGlobalServer() {
  return new Promise(async (resolve) => {
    if (globalServer.status === 'ready') return resolve({ ok: true });
    if (globalServer.status === 'starting') {
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (globalServer.status === 'ready') return resolve({ ok: true });
      }
      return resolve({ error: 'OpenCode server start timed out' });
    }

    const openCodeRoot = getOpenCodeRoot();
    if (!isDirectory(openCodeRoot)) {
      globalServer.status = 'error';
      globalServer.error = `Invalid OpenCode settings root: ${openCodeRoot}`;
      return resolve({ error: globalServer.error });
    }

    globalServer.status = 'starting';
    globalServer.port = CONFIG.ocPort;
    globalServer.error = null;
    console.log(`[OC] Starting opencode serve on port ${globalServer.port} in ${openCodeRoot}`);

    const proc = spawn('opencode', ['serve', '--port', String(globalServer.port), '--hostname', '127.0.0.1'], {
      cwd: openCodeRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    globalServer.process = proc;
    globalServer.pid = proc.pid;

    proc.stderr.on('data', (d) => {
      const line = d.toString().trim();
      if (line) console.log(`[OC:stderr] ${line}`);
    });

    proc.on('error', (err) => {
      globalServer.status = 'error';
      globalServer.error = err.message;
      globalServer.process = null;
      globalServer.pid = null;
    });

    proc.on('close', (code) => {
      console.log(`[OC] opencode serve exited (${code})`);
      globalServer.status = 'stopped';
      globalServer.process = null;
      globalServer.pid = null;
      if (ocEventSource) { ocEventSource.destroy(); ocEventSource = null; }
    });

    // Wait for health check
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const res = await ocFetch(globalServer.port, '/global/health', { timeout: 3000 });
        if (res.status === 200 && res.data && res.data.healthy) {
          globalServer.status = 'ready';
          console.log('[OC] opencode serve is ready');
          subscribeToOpenCodeEvents();
          return resolve({ ok: true });
        }
      } catch {}
    }

    globalServer.status = 'error';
    globalServer.error = 'Health check timed out';
    resolve({ error: globalServer.error });
  });
}

async function stopGlobalServer() {
  if (ocEventSource) { ocEventSource.destroy(); ocEventSource = null; }
  if (globalServer.pid) {
    try { process.kill(globalServer.pid, 'SIGTERM'); } catch {}
  }
  globalServer.process = null;
  globalServer.pid = null;
  globalServer.status = 'stopped';

  // Kill any remaining opencode processes
  try {
    const { execSync } = require('child_process');
    execSync("pkill -f 'opencode serve'", { stdio: 'ignore' });
  } catch {}
}

// ─── SSE to OpenCode for session.idle events ─────────────────────────────────

function subscribeToOpenCodeEvents() {
  if (ocEventSource) { ocEventSource.destroy(); ocEventSource = null; }

  const req = http.get(`http://127.0.0.1:${globalServer.port}/global/event`, {
    headers: { 'Accept': 'text/event-stream' },
  }, (res) => {
    if (res.statusCode !== 200) {
      console.error(`[OC-SSE] Failed to connect, status: ${res.statusCode}`);
      return;
    }
    console.log('[OC-SSE] Connected to OpenCode event stream');

    let buffer = '';
    res.on('data', (chunk) => {
      buffer += chunk.toString();
      const parts = buffer.split('\n\n');
      buffer = parts.pop();

      for (const part of parts) {
        if (!part.trim()) continue;
        const lines = part.split('\n');
        let data = '';
        for (const line of lines) {
          if (line.startsWith('data:')) data = line.slice(5).trim();
        }
        if (!data) continue;

        try {
          const parsed = JSON.parse(data);
          const type = parsed.payload && parsed.payload.type;
          const props = parsed.payload && parsed.payload.properties;

          if (type === 'session.idle' && props && props.sessionID) {
            handleSessionIdle(props.sessionID);
          }
        } catch {}
      }
    });

    res.on('end', () => {
      console.log('[OC-SSE] Stream ended, reconnecting in 3s...');
      setTimeout(() => {
        if (globalServer.status === 'ready') subscribeToOpenCodeEvents();
      }, 3000);
    });
  });

  req.on('error', (err) => {
    console.error(`[OC-SSE] Connection error: ${err.message} — reconnecting in 5s...`);
    setTimeout(() => {
      if (globalServer.status === 'ready') subscribeToOpenCodeEvents();
    }, 5000);
  });

  ocEventSource = req;
}

function handleSessionIdle(sessionId) {
  for (const [id, inst] of instances) {
    if (inst.sessionId === sessionId && inst.status === 'auditing') {
      console.log(`[OC-SSE] session.idle for ${inst.name} (${sessionId})`);
      inst.status = 'completed';
      broadcast('instance.update', getInstanceSummary(inst));
      onAuditFinished(id);
      return;
    }
  }
}

// ─── Instance Lifecycle ──────────────────────────────────────────────────────

async function startInstance(id) {
  const inst = instances.get(id);
  if (!inst) return { error: `Instance ${id} not found` };
  if (inst.status !== 'stopped' && inst.status !== 'error' && inst.status !== 'completed') {
    return { error: `Instance ${inst.name} is already ${inst.status}` };
  }

  inst.status = 'starting';
  inst.error = null;
  broadcast('instance.update', getInstanceSummary(inst));

  const gs = await startGlobalServer();
  if (gs.error) {
    inst.status = 'error';
    inst.error = gs.error;
    broadcast('instance.update', getInstanceSummary(inst));
    return { error: gs.error };
  }

  try {
    // Create a session on the global opencode server
    const sessionRes = await ocFetch(globalServer.port, '/session', {
      method: 'POST',
      body: { title: inst.name, parentID: undefined },
    });

    if (!sessionRes.data || !sessionRes.data.id) {
      throw new Error('Failed to create session');
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

async function stopInstance(id) {
  const inst = instances.get(id);
  if (!inst) return { error: `Instance ${id} not found` };
  if (inst.status === 'stopped') return { ok: true };

  if (inst.sessionId && globalServer.status === 'ready') {
    try {
      await ocFetch(globalServer.port, `/session/${inst.sessionId}/abort`, { method: 'POST' });
    } catch {}
  }

  inst.sessionId = null;
  inst.status = 'stopped';
  inst.error = null;
  broadcast('instance.update', getInstanceSummary(inst));
  return { ok: true };
}

// ─── Audit Engine ────────────────────────────────────────────────────────────

async function runAuditForInstance(id) {
  const inst = instances.get(id);
  if (!inst || inst.status !== 'ready') return;

  try {
    inst.status = 'auditing';
    broadcast('instance.update', getInstanceSummary(inst));

    const promptBody = {
      parts: [{ type: 'text', text: `---任务要求---\n${CONFIG.auditPrompt}\n\n⚠️ 重要指令：请只在以下目标工作目录中执行任务，不要分析外部目录文件。\n目标工作目录: [${inst.dir}]` }],
      model: inst.model || CONFIG.model || undefined,
    };

    await ocFetch(globalServer.port, `/session/${inst.sessionId}/prompt_async`, {
      method: 'POST',
      body: promptBody,
    });

    // Safety timeout: force complete after 30 min if SSE misses the idle event
    scheduleAuditTimeout(id);
  } catch (err) {
    inst.status = 'error';
    inst.error = err.message;
    broadcast('instance.update', getInstanceSummary(inst));
    onAuditFinished(id);
  }
}

function scheduleAuditTimeout(id) {
  setTimeout(() => {
    const inst = instances.get(id);
    if (inst && inst.status === 'auditing') {
      console.log(`[TIMEOUT] Force-completing ${inst.name} after 30min`);
      inst.status = 'completed';
      broadcast('instance.update', getInstanceSummary(inst));
      onAuditFinished(id);
    }
  }, 30 * 60 * 1000);
}

function onAuditFinished(id) {
  activeAudits = Math.max(0, activeAudits - 1);
  processAuditQueue();
}

function processAuditQueue() {
  if (auditPaused) {
    broadcast('audit.queue', { queued: auditQueue.length, active: activeAudits, max: CONFIG.maxConcurrent, paused: true });
    return;
  }
  while (auditQueue.length > 0 && activeAudits < CONFIG.maxConcurrent) {
    const id = auditQueue.shift();
    const inst = instances.get(id);
    if (inst && isAuditCandidate(inst.status)) {
      activeAudits++;
      runQueuedAudit(id);
    }
  }
  broadcast('audit.queue', { queued: auditQueue.length, active: activeAudits, max: CONFIG.maxConcurrent, paused: false });
}

function isAuditCandidate(status) {
  return status === 'ready' || status === 'stopped' || status === 'error' || status === 'completed';
}

async function runQueuedAudit(id) {
  const inst = instances.get(id);
  if (!inst) { onAuditFinished(id); return; }
  try {
    if (inst.status !== 'ready') {
      const r = await startInstance(id);
      if (r.error) throw new Error(r.error);
    }
    const ready = instances.get(id);
    if (!ready || ready.status !== 'ready') throw new Error('Instance not ready');
    await runAuditForInstance(id);
  } catch (err) {
    const failed = instances.get(id);
    if (failed) { failed.status = 'error'; failed.error = err.message; broadcast('instance.update', getInstanceSummary(failed)); }
    onAuditFinished(id);
  }
}

// ─── API Routes ──────────────────────────────────────────────────────────────

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*',
  });
  res.write(`event: connected\ndata: ${JSON.stringify({ time: Date.now() })}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.post('/api/config', (req, res) => {
  const { auditPrompt, maxConcurrent, model, openCodeRoot, projectRoot } = req.body;
  if (openCodeRoot !== undefined) CONFIG.openCodeRoot = cleanPath(openCodeRoot);
  if (projectRoot !== undefined) CONFIG.projectRoot = cleanPath(projectRoot);
  if (auditPrompt) CONFIG.auditPrompt = auditPrompt;
  if (maxConcurrent) CONFIG.maxConcurrent = Number(maxConcurrent);
  if (model !== undefined) CONFIG.model = model;
  res.json({ ok: true, config: CONFIG });
});

app.get('/api/config', (req, res) => res.json(CONFIG));

app.post('/api/scan', (req, res) => {
  const root = cleanPath(req.body.projectRoot) || CONFIG.projectRoot;
  if (!isDirectory(root)) return res.status(400).json({ error: 'Invalid project root' });
  CONFIG.projectRoot = root;

  for (const [id] of instances) stopInstance(id);
  instances.clear();

  const projects = discoverGitProjects(root);
  projects.forEach(p => instances.set(p.id, {
    id: p.id, name: p.name, relDir: p.relDir, dir: p.dir,
    status: 'stopped', error: null, sessionId: null, startedAt: null, model: CONFIG.model || '',
  }));

  const summaries = projects.map(p => getInstanceSummary(instances.get(p.id)));
  broadcast('instances.reset', summaries);
  res.json({ ok: true, services: summaries.map(s => s.name), projects: summaries });
});

app.get('/api/models', async (req, res) => {
  // Discover models from the opencode serve API
  if (globalServer.status === 'ready') {
    try {
      const provRes = await ocFetch(globalServer.port, '/config/providers', { timeout: 5000 });
      if (provRes.data && provRes.data.providers) {
        const models = [];
        for (const p of provRes.data.providers) {
          const modelsList = p.models || (p.model ? [p.model] : []);
          for (const m of modelsList) {
            const mid = typeof m === 'string' ? m : (m.id || m.name || '');
            const mname = typeof m === 'string' ? m : (m.name || m.id || '');
            if (mid) models.push({ value: `${p.id}/${mid}`, label: `${p.id} / ${mname}`, providerID: p.id, modelID: mid, name: mname });
          }
        }
        // Also check config for default model
        try {
          const cfgRes = await ocFetch(globalServer.port, '/config', { timeout: 3000 });
          if (cfgRes.data && cfgRes.data.model && !models.find(m => m.value === cfgRes.data.model)) {
            models.push({ value: cfgRes.data.model, label: cfgRes.data.model, providerID: cfgRes.data.model.split('/')[0], modelID: cfgRes.data.model.split('/').slice(1).join('/'), name: cfgRes.data.model });
          }
        } catch {}
        if (models.length > 0) return res.json({ models });
      }
    } catch {}
  }
  // Fallback: read config files
  try { const m = await readModelsFromFiles(); if (m.length > 0) return res.json({ models: m }); } catch {}
  res.json({ models: [] });
});

async function readModelsFromFiles() {
  const root = getOpenCodeRoot();
  const home = process.env.HOME || process.env.USERPROFILE || '~';
  const configPaths = [
    path.join(root, 'opencode.json'), path.join(root, 'opencode.jsonc'),
    path.join(home, '.config', 'opencode', 'opencode.json'), path.join(home, '.config', 'opencode', 'opencode.jsonc'),
  ];
  const models = [];
  for (const configPath of configPaths) {
    if (!fs.existsSync(configPath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const providers = parsed.provider || {};
      for (const [pid, p] of Object.entries(providers)) {
        if (!p || typeof p !== 'object') continue;
        if (p.models && typeof p.models === 'object') {
          for (const [mid, m] of Object.entries(p.models)) {
            const name = (m && m.name) ? m.name : mid;
            if (!models.find(x => x.value === `${pid}/${mid}`)) {
              models.push({ value: `${pid}/${mid}`, label: `${pid} / ${name}`, providerID: pid, modelID: mid, name });
            }
          }
        }
      }
      if (parsed.model && typeof parsed.model === 'string') {
        if (!models.find(m => m.value === parsed.model)) {
          models.push({ value: parsed.model, label: parsed.model, providerID: parsed.model.split('/')[0], modelID: parsed.model.split('/').slice(1).join('/'), name: parsed.model });
        }
      }
    } catch {}
  }
  return models;
}

app.post('/api/global-model', (req, res) => {
  CONFIG.model = req.body.model || '';
  for (const [, inst] of instances) {
    inst.model = CONFIG.model;
    broadcast('instance.update', getInstanceSummary(inst));
  }
  res.json({ ok: true });
});

app.post('/api/instances/:id/model', (req, res) => {
  const inst = instances.get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'Not found' });
  inst.model = req.body.model || '';
  broadcast('instance.update', getInstanceSummary(inst));
  res.json({ ok: true });
});

app.get('/api/instances', (req, res) => {
  res.json([...instances.values()].map(getInstanceSummary));
});

app.get('/api/instances/:id', (req, res) => {
  const inst = instances.get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'Not found' });
  res.json(getInstanceSummary(inst));
});

app.post('/api/instances/stop-all', async (req, res) => {
  const results = {};
  for (const [id] of instances) results[id] = await stopInstance(id);
  res.json(results);
});

app.post('/api/instances/:id/start', async (req, res) => {
  res.json(await startInstance(req.params.id));
});

app.post('/api/instances/:id/stop', async (req, res) => {
  res.json(await stopInstance(req.params.id));
});

app.post('/api/instances/:id/send', async (req, res) => {
  const inst = instances.get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'Not found' });
  if (inst.status !== 'ready' && inst.status !== 'auditing') {
    return res.status(400).json({ error: `Instance is ${inst.status}` });
  }
  if (!inst.sessionId || globalServer.status !== 'ready') {
    return res.status(400).json({ error: 'OpenCode server not ready' });
  }
  const text = req.body.text || '';
  if (!text) return res.status(400).json({ error: 'No text provided' });
  try {
    await ocFetch(globalServer.port, `/session/${inst.sessionId}/prompt_async`, {
      method: 'POST',
      body: { parts: [{ type: 'text', text }] },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get messages for an instance (clean LLM output, no TUI noise)
app.get('/api/instances/:id/messages', async (req, res) => {
  const inst = instances.get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'Not found' });
  if (!inst.sessionId || globalServer.status !== 'ready') {
    return res.json({ messages: [] });
  }
  try {
    const msgRes = await ocFetch(globalServer.port, `/session/${inst.sessionId}/message`, { timeout: 10000 });
    if (msgRes.data && Array.isArray(msgRes.data)) {
      const msgs = msgRes.data.map(m => ({
        id: m.info?.id,
        role: m.info?.role,
        text: m.parts?.map(p => p.text || p.content || '').join('') || '',
        time: m.info?.time,
      }));
      return res.json({ messages: msgs });
    }
    res.json({ messages: [] });
  } catch {
    res.json({ messages: [] });
  }
});

// ─── Audit Routes ────────────────────────────────────────────────────────────

app.post('/api/audit/start', async (req, res) => {
  if (!CONFIG.auditPrompt) return res.status(400).json({ error: 'Audit prompt not set' });
  auditQueue = [];
  activeAudits = 0;
  auditPaused = false;
  for (const [id, inst] of instances) {
    if (isAuditCandidate(inst.status)) auditQueue.push(id);
  }
  processAuditQueue();
  res.json({ ok: true, queued: auditQueue.length, active: activeAudits });
});

app.post('/api/audit/:id/start', async (req, res) => {
  const inst = instances.get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'Not found' });
  if (!CONFIG.auditPrompt) return res.status(400).json({ error: 'Audit prompt not set' });
  if (inst.status !== 'ready') return res.status(400).json({ error: `Instance is ${inst.status}` });
  activeAudits++;
  await runAuditForInstance(req.params.id);
  res.json({ ok: true });
});

app.post('/api/audit/:id/abort', async (req, res) => {
  const inst = instances.get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'Not found' });
  if (inst.sessionId && globalServer.status === 'ready') {
    try {
      await ocFetch(globalServer.port, `/session/${inst.sessionId}/abort`, { method: 'POST' });
    } catch {}
  }
  inst.status = 'ready';
  broadcast('instance.update', getInstanceSummary(inst));
  res.json({ ok: true });
});

app.post('/api/instances/:id/abort', async (req, res) => {
  const inst = instances.get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'Not found' });
  if (inst.sessionId && globalServer.status === 'ready') {
    try {
      await ocFetch(globalServer.port, `/session/${inst.sessionId}/abort`, { method: 'POST' });
    } catch {}
  }
  inst.status = 'ready';
  broadcast('instance.update', getInstanceSummary(inst));
  res.json({ ok: true });
});

// ─── Pause / Resume ──────────────────────────────────────────────────────────

app.post('/api/audit/pause', (req, res) => {
  auditPaused = true;
  broadcast('audit.queue', { queued: auditQueue.length, active: activeAudits, max: CONFIG.maxConcurrent, paused: true });
  res.json({ ok: true, paused: true });
});

app.post('/api/audit/resume', (req, res) => {
  auditPaused = false;
  processAuditQueue();
  res.json({ ok: true, paused: false });
});

app.get('/api/audit/status', (req, res) => {
  res.json({ queued: auditQueue.length, active: activeAudits, max: CONFIG.maxConcurrent, paused: auditPaused });
});

// ─── Shutdown ────────────────────────────────────────────────────────────────

async function shutdown() {
  console.log('\n[SYSTEM] Shutting down...');
  await stopGlobalServer();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ─── Startup ─────────────────────────────────────────────────────────────────

const server = http.createServer(app);

const PORT = CONFIG.backendPort;
server.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════════════════╗`);
  console.log(`  ║   Multi-Agent Monitor (opencode serve)           ║`);
  console.log(`  ║   http://localhost:${PORT}                          ║`);
  console.log(`  ║   OpenCode serve port: ${CONFIG.ocPort}                       ║`);
  console.log(`  ╚══════════════════════════════════════════════════╝\n`);
});

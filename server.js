const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const tmux = require('./lib/tmux-manager');
const createTerminalWSServer = require('./lib/terminal-ws');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── State ───────────────────────────────────────────────────────────────────

let CONFIG = {
  openCodeRoot: '',
  projectRoot: '',
  auditPrompt: '',
  backendPort: parseInt(process.env.PORT) || 8888,
  maxConcurrent: 3,
  model: '',
};

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
    startedAt: inst.startedAt || null, model: inst.model || null,
  };
}

// ─── Instance Lifecycle ─────────────────────────────────────────────────────

async function startInstance(id) {
  const inst = instances.get(id);
  if (!inst) return { error: `Instance ${id} not found` };
  if (inst.status === 'ready' || inst.status === 'auditing') return { ok: true };
  if (inst.status === 'starting') {
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (inst.status === 'ready' || inst.status === 'auditing') return { ok: true };
    }
    return { error: 'Instance start timed out' };
  }

  const openCodeRoot = getOpenCodeRoot();
  const workDir = inst.dir;

  console.log(`[INSTANCE] Starting opencode CLI for ${inst.name} in ${workDir}`);
  inst.status = 'starting';
  inst.error = null;
  broadcast('instance.update', getInstanceSummary(inst));

  try {
    const env = { ...process.env };
    if (openCodeRoot && openCodeRoot !== workDir) {
      env.OPENCODE_ROOT = openCodeRoot;
    }

    await tmux.createSessionWithEnv(inst.id, 'opencode', workDir, env, { cols: 160, rows: 40 });

    inst.status = 'ready';
    inst.startedAt = new Date().toISOString();
    broadcast('instance.update', getInstanceSummary(inst));
    return { ok: true };
  } catch (err) {
    inst.status = 'error';
    inst.error = err.message;
    broadcast('instance.update', getInstanceSummary(inst));
    return { error: err.message };
  }
}

async function stopInstance(id) {
  const inst = instances.get(id);
  if (!inst) return { error: `Instance ${id} not found` };
  if (inst.status === 'stopped') return { ok: true };

  console.log(`[INSTANCE] Stopping ${inst.name}...`);

  try {
    await tmux.sendKeys(tmux.sessionName(inst.id), 'C-c');
    await new Promise(r => setTimeout(r, 1000));
    await tmux.killSession(tmux.sessionName(inst.id));
  } catch {}

  inst.status = 'stopped';
  inst.error = null;
  broadcast('instance.update', getInstanceSummary(inst));
  return { ok: true };
}

// ─── Audit Engine ────────────────────────────────────────────────────────────

async function sendPromptToTerminal(id, promptText) {
  const sessionId = tmux.sessionName(id);
  const target = tmux.windowTarget(sessionId);

  // Wait for opencode TUI to fully initialize (up to 10 seconds)
  let initialized = false;
  for (let i = 0; i < 20; i++) {
    try {
      const pane = await tmux.capturePane(sessionId);
      if (pane.includes('Build') || pane.includes('Plan') || pane.includes('\u23FA')) {
        initialized = true;
        break;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  if (!initialized) console.warn(`[AUDIT] opencode may not be ready for ${id}, sending anyway...`);

  // Send text line by line with -R (reset terminal) for reliability
  const lines = promptText.split('\n');
  for (const line of lines) {
    if (line.length > 0) {
      await tmux.exec(['send-keys', '-R', '-t', target, '-l', line]);
    }
    await tmux.sendEnter(sessionId);
  }
}

async function runAuditForInstance(id) {
  const inst = instances.get(id);
  if (!inst || inst.status !== 'ready') return;

  try {
    inst.status = 'auditing';
    broadcast('instance.update', getInstanceSummary(inst));

    const prompt = `${CONFIG.auditPrompt}\n\n⚠️ 重要指令：请只在以下目标工作目录中执行任务，不要分析外部目录文件。\n目标工作目录: [${inst.dir}]`;
    await sendPromptToTerminal(id, prompt);

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
    if (!ready || ready.status !== 'ready') throw new Error(`Instance not ready`);
    await runAuditForInstance(id);
  } catch (err) {
    const failed = instances.get(id);
    if (failed) { failed.status = 'error'; failed.error = err.message; broadcast('instance.update', getInstanceSummary(failed)); }
    onAuditFinished(id);
  }
}

// Terminal popup page — serves terminal.html with instance context
app.get('/terminal/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terminal.html'));
});

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
    status: 'stopped', error: null, startedAt: null, model: CONFIG.model || '',
  }));

  const summaries = projects.map(p => getInstanceSummary(instances.get(p.id)));
  broadcast('instances.reset', summaries);
  res.json({ ok: true, services: summaries.map(s => s.name), projects: summaries });
});

app.get('/api/models', async (req, res) => {
  // Read models from opencode.json config file
  try {
    const root = getOpenCodeRoot();
    const configPaths = [
      path.join(root, 'opencode.json'),
      path.join(root, 'opencode.jsonc'),
    ];
    let models = [];
    for (const configPath of configPaths) {
      if (!fs.existsSync(configPath)) continue;
      try {
        const raw = fs.readFileSync(configPath, 'utf8');
        const parsed = JSON.parse(raw);
        // Extract from provider definitions
        const providers = parsed.provider || {};
        for (const [pid, p] of Object.entries(providers)) {
          if (!p || typeof p !== 'object') continue;
          // If provider has explicitly listed models
          if (p.models && typeof p.models === 'object') {
            for (const [mid, m] of Object.entries(p.models)) {
              const name = (m && m.name) ? m.name : mid;
              models.push({ value: `${pid}/${mid}`, label: `${pid} / ${name}`, providerID: pid, modelID: mid, name });
            }
          } else {
            // Provider has no model list — add the provider prefix for manual entry
            models.push({ value: `${pid}/`, label: `${pid} / (手动输入)`, providerID: pid, modelID: '', name: pid });
          }
        }
        // Also include the default model if set
        if (parsed.model && typeof parsed.model === 'string') {
          const existing = models.find(m => m.value === parsed.model);
          if (!existing) {
            models.push({ value: parsed.model, label: parsed.model, providerID: parsed.model.split('/')[0], modelID: parsed.model.split('/').slice(1).join('/'), name: parsed.model });
          }
        }
      } catch { /* skip malformed config */ }
      if (models.length > 0) break;
    }
    res.json({ models });
  } catch { res.json({ models: [] }); }
});

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

// Send text to an instance's terminal
app.post('/api/instances/:id/send', async (req, res) => {
  const inst = instances.get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'Not found' });
  if (inst.status !== 'ready' && inst.status !== 'auditing') {
    return res.status(400).json({ error: `Instance is ${inst.status}` });
  }
  const text = req.body.text || '';
  if (!text) return res.status(400).json({ error: 'No text provided' });
  try {
    await sendPromptToTerminal(req.params.id, text);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
  try {
    await tmux.sendKeys(tmux.sessionName(req.params.id), 'C-c');
    inst.status = 'ready';
    broadcast('instance.update', getInstanceSummary(inst));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Pause / Resume ──────────────────────────────────────────────────────────

app.post('/api/audit/pause', (req, res) => {
  auditPaused = true;
  broadcast('audit.queue', { queued: auditQueue.length, active: activeAudits, max: CONFIG.maxConcurrent, paused: true });
  console.log('[AUDIT] Queue paused');
  res.json({ ok: true, paused: true });
});

app.post('/api/audit/resume', (req, res) => {
  auditPaused = false;
  processAuditQueue();
  console.log('[AUDIT] Queue resumed');
  res.json({ ok: true, paused: false });
});

app.get('/api/audit/status', (req, res) => {
  res.json({ queued: auditQueue.length, active: activeAudits, max: CONFIG.maxConcurrent, paused: auditPaused });
});

// Shortcut for abort from frontend
app.post('/api/instances/:id/abort', async (req, res) => {
  const inst = instances.get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'Not found' });
  try {
    await tmux.sendKeys(tmux.sessionName(req.params.id), 'C-c');
    inst.status = 'ready';
    broadcast('instance.update', getInstanceSummary(inst));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Shutdown ────────────────────────────────────────────────────────────────

async function shutdown() {
  console.log('\n[SYSTEM] Shutting down...');
  for (const [id] of instances) {
    try { await tmux.killSession(tmux.sessionName(id)); } catch {}
  }
  try {
    const sessions = await tmux.listSessions();
    for (const s of sessions) await tmux.killSession(s);
  } catch {}
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ─── Startup ─────────────────────────────────────────────────────────────────

const { execSync } = require('child_process');
let tmuxAvailable = false;
try { execSync('tmux -V', { stdio: 'ignore' }); tmuxAvailable = true; } catch {}

const server = http.createServer(app);
createTerminalWSServer(server);

const PORT = CONFIG.backendPort;
server.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════════════════╗`);
  console.log(`  ║   Multi-Agent Monitor (CLI-based, no opencode serve) ║`);
  console.log(`  ║   http://localhost:${PORT}                          ║`);
  console.log(`  ║   Terminals: tmux attach -t mam-<instance>       ║`);
  console.log(`  ║   tmux: ${tmuxAvailable ? '✓' : '✗ NOT FOUND'}                                 ║`);
  console.log(`  ╚══════════════════════════════════════════════════╝\n`);
});

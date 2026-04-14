// ═══════════════════════════════════════════════════════════════════════════
// Multi-Agent Monitor — Frontend Application
// ═══════════════════════════════════════════════════════════════════════════

const App = (() => {
  // ─── State ───────────────────────────────────────────────────────────
  let instances = [];
  let selectedInstance = null;
  let currentSessionId = null;
  let messages = [];
  let eventSource = null;
  let pollTimer = null;
  let sessionPollTimer = null;
  let totalInstances = 0;
  let currentProjectRoot = '';

  const API = '';

  // ─── Helpers ─────────────────────────────────────────────────────────

  async function api(path, options = {}) {
    const res = await fetch(API + path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Request failed');
    }
    if (res.status === 204) return null;
    return res.json();
  }

  function $(id) { return document.getElementById(id); }

  function toast(message, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    $('toast-container').appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatText(text) {
    if (!text) return '';
    // Basic markdown-like formatting
    let html = escapeHtml(text);
    // Code blocks
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      return `<pre><code>${code.trim()}</code></pre>`;
    });
    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Bold
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Newlines
    html = html.replace(/\n/g, '<br>');
    return html;
  }

  function getSessionUrl(sessionId, port = 4100) {
    if (!sessionId || !currentProjectRoot) return '#';
    try {
      // Base64Url encode the project root without padding
      const b64 = btoa(unescape(encodeURIComponent(currentProjectRoot)))
                  .replace(/=+$/, '')
                  .replace(/\+/g, '-')
                  .replace(/\//g, '_');
      return `http://127.0.0.1:${port}/${b64}/session/${sessionId}`;
    } catch {
      return `http://127.0.0.1:${port}/?session_id=${sessionId}`;
    }
  }

  // ─── SSE Connection ──────────────────────────────────────────────────

  function connectSSE() {
    if (eventSource) eventSource.close();
    eventSource = new EventSource(API + '/api/events');

    eventSource.addEventListener('connected', () => {
      console.log('[SSE] Connected');
    });

    eventSource.addEventListener('instance.update', (e) => {
      const data = JSON.parse(e.data);
      updateInstanceInList(data);
      renderStats();
      // If this is the selected instance, update chat header
        if (selectedInstance && selectedInstance.name === data.name) {
          selectedInstance = data;
          updateChatHeader();
          
          if (data.status === 'auditing') {
            const toggle = $('toggle-auto-refresh');
            if (toggle) toggle.checked = true;
          }

          // Auto-refresh messages if status changed to completed
          if (data.status === 'completed' || data.status === 'error') {
            const toggle = $('toggle-auto-refresh');
            if (toggle) toggle.checked = false;
            refreshMessages();
          }
        }
    });

    eventSource.addEventListener('instances.reset', (e) => {
      instances = JSON.parse(e.data);
      totalInstances = instances.length;
      renderInstanceList();
      renderStats();
    });

    eventSource.addEventListener('audit.queue', (e) => {
      const data = JSON.parse(e.data);
      updateQueueBar(data);
    });

    eventSource.addEventListener('instance.log', (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'stderr') {
        console.error(`[${data.name}]`, data.line);
      } else {
        console.log(`[${data.name}]`, data.line);
      }
    });

    eventSource.onerror = () => {
      console.warn('[SSE] Connection lost, reconnecting...');
    };
  }

  // ─── Instance Management ─────────────────────────────────────────────

  function updateInstanceInList(data) {
    const idx = instances.findIndex(i => i.name === data.name);
    if (idx >= 0) {
      instances[idx] = { ...instances[idx], ...data };
    } else {
      instances.push(data);
    }
    renderInstanceCard(data.name);
  }

  function renderInstanceList() {
    const container = $('instance-list');
    container.innerHTML = '';
    $('instance-count').textContent = `${instances.length} 个服务`;

    for (const inst of instances) {
      const card = createInstanceCard(inst);
      container.appendChild(card);
    }
  }

  function createInstanceCard(inst) {
    const card = document.createElement('div');
    card.className = 'instance-card' + (selectedInstance?.name === inst.name ? ' selected' : '');
    card.id = `card-${inst.name}`;
    card.dataset.status = inst.status;
    card.onclick = () => selectInstance(inst.name);

    const statusLabels = {
      stopped: '已停止',
      starting: '启动中',
      ready: '就绪',
      auditing: '审计中',
      completed: '已完成',
      error: '错误',
    };

    card.innerHTML = `
      <div class="instance-icon">📦</div>
      <div class="instance-info">
        <div class="instance-name">${escapeHtml(inst.name)}</div>
        <div class="instance-detail">
          ${inst.sessionId ? `<a href="${getSessionUrl(inst.sessionId, inst.port)}" target="_blank" class="session-link" onclick="event.stopPropagation()">🔗 ID: ${inst.sessionId.slice(-8)}</a>` : `<span>未建会话</span>`}
          ${inst.error ? `<span style="color:var(--accent-red)" title="${escapeHtml(inst.error)}">⚠</span>` : ''}
        </div>
      </div>
      <div class="instance-status-badge" data-status="${inst.status}">
        ${inst.status === 'auditing' ? '<span class="spinner spinner-sm"></span>' : ''}
        ${statusLabels[inst.status] || inst.status}
      </div>
    `;

    return card;
  }

  function renderInstanceCard(name) {
    const inst = instances.find(i => i.name === name);
    if (!inst) return;
    const old = $(`card-${name}`);
    if (old) {
      const card = createInstanceCard(inst);
      old.replaceWith(card);
    }
  }

  function renderStats() {
    const counts = { stopped: 0, starting: 0, ready: 0, auditing: 0, completed: 0, error: 0 };
    for (const inst of instances) {
      counts[inst.status] = (counts[inst.status] || 0) + 1;
    }

    const stats = $('toolbar-stats');
    stats.innerHTML = '';

    const items = [
      { key: 'auditing', label: '审计中', cls: 'dot-auditing' },
      { key: 'completed', label: '完成', cls: 'dot-completed' },
      { key: 'ready', label: '就绪', cls: 'dot-ready' },
      { key: 'error', label: '错误', cls: 'dot-error' },
      { key: 'stopped', label: '停止', cls: 'dot-stopped' },
    ];

    for (const item of items) {
      if (counts[item.key] > 0) {
        const badge = document.createElement('div');
        badge.className = 'stat-badge';
        badge.innerHTML = `<span class="dot ${item.cls}"></span>${counts[item.key]} ${item.label}`;
        stats.appendChild(badge);
      }
    }
  }

  function updateQueueBar(data) {
    const bar = $('queue-bar');
    const completed = instances.filter(i => i.status === 'completed').length;
    const total = totalInstances || instances.length;
    const active = data.active;
    const queued = data.queued;

    if (active === 0 && queued === 0) {
      bar.classList.add('hidden');
      return;
    }

    bar.classList.remove('hidden');
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    $('queue-text').textContent = `并发: ${active}/${data.max} | 队列: ${queued}`;
    $('queue-fill').style.width = `${pct}%`;
    $('queue-percent').textContent = `${completed}/${total} 完成`;
  }

  // ─── Instance Selection & Chat ───────────────────────────────────────

  async function selectInstance(name) {
    const inst = instances.find(i => i.name === name);
    if (!inst) return;

    selectedInstance = inst;
    currentSessionId = inst.sessionId;
    messages = [];

    // Update selected card visuals
    document.querySelectorAll('.instance-card').forEach(c => c.classList.remove('selected'));
    const card = $(`card-${name}`);
    if (card) card.classList.add('selected');

    // Show chat panel
    $('chat-empty').style.display = 'none';
    $('chat-content').style.display = 'flex';
    updateChatHeader();

    // Load messages if session exists
    if (currentSessionId) {
      await refreshMessages();
    } else {
      renderMessages();
    }

    // Start session status polling for this instance
    startSessionPoll();
  }

  function updateChatHeader() {
    if (!selectedInstance) return;
    const statusLabels = {
      stopped: '⏹ 已停止',
      starting: '⏳ 启动中...',
      ready: '✅ 就绪',
      auditing: '🔍 审计中...',
      completed: '✅ 审计完成',
      error: '❌ 错误',
    };
    
    $('chat-instance-name').textContent = selectedInstance.name;
    const stLabel = statusLabels[selectedInstance.status] || selectedInstance.status;
    
    $('chat-instance-status').innerHTML =
      `<span>${stLabel}</span> | ` +
      (currentSessionId 
        ? `<a href="${getSessionUrl(currentSessionId, selectedInstance.port)}" target="_blank" style="color: var(--accent-blue); text-decoration: none;">🔗 WebUI</a>` 
        : `<span>未建会话</span>`);
  }

  async function refreshMessages() {
    if (!selectedInstance || !currentSessionId) {
      messages = [];
      renderMessages();
      return;
    }

    try {
      const data = await api(`/api/instances/${selectedInstance.name}/messages/${currentSessionId}`);
      if (Array.isArray(data)) {
        messages = data;
        
        if (messages.length > 0) {
          const lastMsg = messages[messages.length - 1];
          if (lastMsg && lastMsg.info && lastMsg.info.finish) {
            const toggle = $('toggle-auto-refresh');
            if (toggle) toggle.checked = false;
          }
        }
      }
      renderMessages();
    } catch (err) {
      console.error('Failed to load messages:', err);
    }
  }

  function renderMessages() {
    const container = $('chat-messages');
    container.innerHTML = '';

    if (messages.length === 0) {
      if (selectedInstance?.status === 'stopped' || selectedInstance?.status === 'ready') {
        container.innerHTML = `
          <div style="text-align:center;color:var(--text-muted);padding:2rem;">
            <p>暂无消息。${selectedInstance?.status === 'ready' ? '可以在下方输入消息开始交互。' : ''}</p>
          </div>`;
      }
      return;
    }

    for (const msg of messages) {
      const info = msg.info;
      const parts = msg.parts || [];
      const role = info.role || 'assistant';

      const msgEl = document.createElement('div');
      msgEl.className = `message ${role}`;

      let contentHtml = '';

      for (const part of parts) {
        if (part.type === 'text') {
          contentHtml += formatText(part.text || part.content || '');
        } else if (part.type === 'tool-invocation' || part.type === 'tool_use') {
          const toolName = part.toolName || part.name || 'tool';
          contentHtml += `<div class="message-tool">
            <span class="tool-name">🔧 ${escapeHtml(toolName)}</span>
          </div>`;
        } else if (part.type === 'tool-result' || part.type === 'tool_result') {
          // Show tool results more compactly
          const resultText = typeof part.result === 'string' ? part.result :
            (part.content ? (typeof part.content === 'string' ? part.content : JSON.stringify(part.content)) : '');
          if (resultText) {
            contentHtml += `<div class="message-tool">
              <span class="tool-name">📋 结果</span><br>
              <pre><code>${escapeHtml(resultText.substring(0, 500))}${resultText.length > 500 ? '...' : ''}</code></pre>
            </div>`;
          }
        }
      }

      if (!contentHtml.trim()) {
        // If no renderable content, skip
        continue;
      }

      msgEl.innerHTML = `
        <div class="message-role">${role === 'user' ? '👤 用户' : '🤖 助手'}</div>
        <div class="message-bubble">${contentHtml}</div>
      `;

      container.appendChild(msgEl);
    }

    // Show typing indicator if auditing
    if (selectedInstance?.status === 'auditing') {
      const typing = document.createElement('div');
      typing.className = 'message assistant';
      typing.innerHTML = `
        <div class="message-role">🤖 助手</div>
        <div class="message-bubble">
          <div class="typing-indicator"><span></span><span></span><span></span></div>
        </div>`;
      container.appendChild(typing);
    }

    // Scroll to bottom
    container.scrollTop = container.scrollHeight;
  }

  function startSessionPoll() {
    if (sessionPollTimer) clearInterval(sessionPollTimer);
    sessionPollTimer = setInterval(async () => {
      if (!selectedInstance) return;
      
      const toggle = $('toggle-auto-refresh');
      if (toggle && !toggle.checked) return;
      
      if (currentSessionId) {
        await refreshMessages();
      } else if (selectedInstance.sessionId) {
        currentSessionId = selectedInstance.sessionId;
        await refreshMessages();
      }
    }, 2000); // Polling every 2 seconds for snappier chat
  }

  // ─── Chat Interaction ────────────────────────────────────────────────

  async function sendMessage() {
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text || !selectedInstance) return;

    // Enable auto-refresh when sending a message
    const toggle = $('toggle-auto-refresh');
    if (toggle) toggle.checked = true;

    // If no session, create one first
    if (!currentSessionId) {
      if (selectedInstance.status !== 'ready') {
        toast('实例未就绪，无法发送消息', 'error');
        return;
      }
      try {
        const session = await api(`/api/instances/${selectedInstance.name}/session`, {
          method: 'POST',
          body: { title: `Interactive: ${selectedInstance.name}` },
        });
        currentSessionId = session.id;
      } catch (err) {
        toast('创建会话失败: ' + err.message, 'error');
        return;
      }
    }

    input.value = '';
    autoResizeInput();

    // Optimistic UI: show user message immediately
    messages.push({
      info: { role: 'user' },
      parts: [{ type: 'text', text }],
    });
    renderMessages();

    try {
      // Send async prompt
      await api(`/api/instances/${selectedInstance.name}/prompt/${currentSessionId}`, {
        method: 'POST',
        body: {
          parts: [{ type: 'text', text }],
        },
      });

      // Update instance status to indicate activity
      if (selectedInstance.status === 'ready' || selectedInstance.status === 'completed') {
        selectedInstance.status = 'auditing';
        renderInstanceCard(selectedInstance.name);
        updateChatHeader();
      }

      // Start polling for response
      startSessionPoll();
    } catch (err) {
      toast('发送失败: ' + err.message, 'error');
    }
  }

  function onChatKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  }

  function autoResizeInput() {
    const input = $('chat-input');
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  }

  async function abortCurrentSession() {
    if (!selectedInstance || !currentSessionId) return;
    try {
      await api(`/api/instances/${selectedInstance.name}/abort/${currentSessionId}`, {
        method: 'POST',
      });
      toast('已发送中止请求', 'info');
    } catch (err) {
      toast('中止失败: ' + err.message, 'error');
    }
  }

  // ─── Launch / Setup ──────────────────────────────────────────────────

  async function launch() {
    const projectRoot = $('input-project-root').value.trim();
    const auditPrompt = $('input-audit-prompt').value.trim();
    const maxConcurrent = parseInt($('input-max-concurrent').value) || 3;
    const portStart = parseInt($('input-port-start').value) || 4100;

    if (!projectRoot) {
      toast('请输入项目根目录', 'error');
      return;
    }
    if (!auditPrompt) {
      toast('请输入审计 Prompt', 'error');
      return;
    }

    const btn = $('btn-launch');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 扫描中...';

    try {
      // Save config
      await api('/api/config', {
        method: 'POST',
        body: { projectRoot, auditPrompt, maxConcurrent, portStart },
      });

      // Scan project directory
      const result = await api('/api/scan', {
        method: 'POST',
        body: { projectRoot },
      });

      if (!result.services || result.services.length === 0) {
        toast('未找到子目录', 'error');
        btn.disabled = false;
        btn.innerHTML = '🚀 扫描并启动';
        return;
      }

      totalInstances = result.services.length;
      toast(`发现 ${result.services.length} 个微服务`, 'success');

      // Switch to monitor screen
      $('setup-screen').style.display = 'none';
      $('monitor-screen').style.display = 'flex';

      // Connect SSE
      connectSSE();

      // Load instances
      instances = await api('/api/instances');
      renderInstanceList();
      renderStats();

      // Start periodic instance refresh
      startPeriodicRefresh();

    } catch (err) {
      toast('启动失败: ' + err.message, 'error');
    }

    btn.disabled = false;
    btn.innerHTML = '🚀 扫描并启动';
  }

  function backToSetup() {
    $('setup-screen').style.display = 'flex';
    $('monitor-screen').style.display = 'none';
    if (eventSource) eventSource.close();
    if (pollTimer) clearInterval(pollTimer);
    if (sessionPollTimer) clearInterval(sessionPollTimer);
    selectedInstance = null;
    currentSessionId = null;
  }

  // ─── Batch Operations ────────────────────────────────────────────────

  async function startAllInstances() {
    try {
      await api('/api/instances/start-all', { method: 'POST' });
      toast('正在启动所有实例...', 'info');
    } catch (err) {
      toast('启动失败: ' + err.message, 'error');
    }
  }

  async function stopAllInstances() {
    try {
      await api('/api/instances/stop-all', { method: 'POST' });
      toast('正在停止所有实例...', 'info');
    } catch (err) {
      toast('停止失败: ' + err.message, 'error');
    }
  }

  async function startBatchAudit() {
    const btn = $('btn-start-audit');
    btn.disabled = true;

    try {
      const result = await api('/api/audit/start', { method: 'POST' });
      toast(`批量审计已启动，${result.queued} 个在队列中`, 'success');
    } catch (err) {
      toast('审计启动失败: ' + err.message, 'error');
    }

    setTimeout(() => { btn.disabled = false; }, 2000);
  }

  // ─── Periodic Refresh ────────────────────────────────────────────────

  function startPeriodicRefresh() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const latest = await api('/api/instances');
        if (Array.isArray(latest)) {
          instances = latest;
          renderInstanceList();
          renderStats();

          // Update selected instance if it changed
          if (selectedInstance) {
            const updated = instances.find(i => i.name === selectedInstance.name);
            if (updated) {
              const statusChanged = selectedInstance.status !== updated.status;
              const sessionChanged = selectedInstance.sessionId !== updated.sessionId;
              selectedInstance = updated;

              if (sessionChanged && updated.sessionId) {
                currentSessionId = updated.sessionId;
              }

              if (statusChanged || sessionChanged) {
                updateChatHeader();
              }
            }
          }
        }
      } catch {}
    }, 8000);
  }

  // ─── Auto-resize textarea ─────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', async () => {
    const input = $('chat-input');
    if (input) {
      input.addEventListener('input', autoResizeInput);
    }

    // Auto-resume: if server already has instances, skip setup
    try {
      const existing = await api('/api/instances');
      if (Array.isArray(existing) && existing.length > 0) {
        const config = await api('/api/config');
        currentProjectRoot = config.projectRoot;
        instances = existing;
        totalInstances = instances.length;

        // Pre-fill setup form with existing config
        if (config.projectRoot) $('input-project-root').value = config.projectRoot;
        if (config.auditPrompt) $('input-audit-prompt').value = config.auditPrompt;
        if (config.maxConcurrent) $('input-max-concurrent').value = config.maxConcurrent;
        if (config.portStart) $('input-port-start').value = config.portStart;

        // Switch to monitor
        $('setup-screen').style.display = 'none';
        $('monitor-screen').style.display = 'flex';
        connectSSE();
        renderInstanceList();
        renderStats();
        startPeriodicRefresh();
      }
    } catch {}
  });

  // ─── Public API ──────────────────────────────────────────────────────

  return {
    launch,
    backToSetup,
    startBatchAudit,
    startAllInstances,
    stopAllInstances,
    sendMessage,
    onChatKeyDown,
    refreshMessages,
    abortCurrentSession,
    selectInstance,
  };
})();

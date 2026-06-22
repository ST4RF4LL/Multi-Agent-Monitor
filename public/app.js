// ═══════════════════════════════════════════════════════════════════════
// Multi-Agent Monitor — Frontend (opencode serve / session-based)
// ═══════════════════════════════════════════════════════════════════════

const App = (() => {
  let instances = [];
  let selectedInstance = null;
  let eventSource = null;
  let pollTimer = null;
  let msgTimer = null;
  let seenMsgIds = new Set();
  let totalInstances = 0;
  let currentModel = '';

  const API = '';

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
  function instanceKey(inst) { return inst?.id || inst?.name || ''; }
  function escapeHtml(str) { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }
  function instPath(inst, s = '') { return `/api/instances/${encodeURIComponent(instanceKey(inst))}${s}`; }
  function cardId(inst) { return `card-${instanceKey(inst)}`; }

  function toast(msg, type = 'info') {
    const el = document.createElement('div'); el.className = `toast toast-${type}`; el.textContent = msg;
    $('toast-container').appendChild(el); setTimeout(() => el.remove(), 4000);
  }

  function normalizeModelOptions(models) {
    if (!Array.isArray(models)) return [];
    return models.map(m => {
      if (typeof m === 'string') return { value: m, label: m };
      const v = m.value || (m.providerID && m.modelID ? `${m.providerID}/${m.modelID}` : '');
      return v ? { value: v, label: m.label || m.name || v } : null;
    }).filter(Boolean);
  }

  // ─── SSE ────────────────────────────────────────────────────────────

  function connectSSE() {
    if (eventSource) eventSource.close();
    eventSource = new EventSource(API + '/api/events');
    eventSource.addEventListener('connected', () => console.log('[SSE] Connected'));
    eventSource.addEventListener('instance.update', (e) => {
      const data = JSON.parse(e.data);
      updateInList(data);
      renderStats();
      if (selectedInstance && instanceKey(selectedInstance) === instanceKey(data)) {
        selectedInstance = data;
        updateHeader();
      }
    });
    eventSource.addEventListener('instances.reset', (e) => {
      instances = JSON.parse(e.data); totalInstances = instances.length;
      seenMsgIds = new Set();
      renderList(); renderStats();
    });
    eventSource.addEventListener('audit.queue', (e) => updateQueue(JSON.parse(e.data)));
    eventSource.onerror = () => console.warn('[SSE] Lost');
  }

  // ─── Instance List ──────────────────────────────────────────────────

  function updateInList(data) {
    const key = instanceKey(data); const idx = instances.findIndex(i => instanceKey(i) === key);
    if (idx >= 0) instances[idx] = { ...instances[idx], ...data }; else instances.push(data);
    renderCard(key);
  }

  function renderList() {
    const c = $('instance-list'); c.innerHTML = '';
    $('instance-count').textContent = `${instances.length} 个项目`;
    instances.forEach(i => c.appendChild(createCard(i)));
  }

  function createCard(inst) {
    const key = instanceKey(inst);
    const card = document.createElement('div');
    card.className = 'instance-card' + (instanceKey(selectedInstance) === key ? ' selected' : '');
    card.id = cardId(key);
    card.dataset.instanceId = key;
    card.dataset.status = inst.status;
    card.onclick = () => selectInstance(key);

    const labels = { stopped:'已停止',starting:'启动中',ready:'就绪',auditing:'审计中',completed:'已完成',error:'错误' };
    card.innerHTML = `
      <div class="instance-icon">📦</div>
      <div class="instance-info">
        <div class="instance-name" title="${escapeHtml(inst.dir||inst.name)}">${escapeHtml(inst.name)}</div>
        <div class="instance-detail">${inst.error ? `<span style="color:var(--accent-red)" title="${escapeHtml(inst.error)}">⚠ ${escapeHtml(inst.error.substring(0,40))}</span>` : '<span>session 模式</span>'}</div>
      </div>
      <div class="instance-status-badge" data-status="${inst.status}">
        ${inst.status==='auditing'?'<span class="spinner spinner-sm"></span>':''}${labels[inst.status]||inst.status}
      </div>`;
    return card;
  }

  function renderCard(key) {
    const inst = instances.find(i => instanceKey(i) === key); if (!inst) return;
    const old = $(cardId(key)); if (old) old.replaceWith(createCard(inst));
  }

  function renderStats() {
    const counts = {};
    instances.forEach(i => counts[i.status] = (counts[i.status]||0)+1);
    const s = $('toolbar-stats'); s.innerHTML = '';
    [{key:'auditing',label:'审计中',cls:'dot-auditing'},{key:'completed',label:'完成',cls:'dot-completed'},
     {key:'ready',label:'就绪',cls:'dot-ready'},{key:'error',label:'错误',cls:'dot-error'},{key:'stopped',label:'停止',cls:'dot-stopped'}]
      .forEach(item => { if (counts[item.key]>0) { const b = document.createElement('div'); b.className='stat-badge'; b.innerHTML=`<span class="dot ${item.cls}"></span>${counts[item.key]} ${item.label}`; s.appendChild(b); } });
  }

  function updateQueue(data) {
    const bar = $('queue-bar');
    const pauseBtn = $('btn-pause');
    const resumeBtn = $('btn-resume');
    const done = instances.filter(i => i.status==='completed').length;
    const total = totalInstances||instances.length;
    if (data.active===0 && data.queued===0 && !data.paused) { bar.classList.add('hidden'); pauseBtn.classList.add('hidden'); resumeBtn.classList.add('hidden'); return; }
    bar.classList.remove('hidden');

    if (data.paused) { pauseBtn.classList.add('hidden'); resumeBtn.classList.remove('hidden'); }
    else { pauseBtn.classList.remove('hidden'); resumeBtn.classList.add('hidden'); }

    $('queue-text').textContent = `${data.paused ? '⏸ 已暂停 | ' : ''}并发: ${data.active}/${data.max} | 队列: ${data.queued}`;
    $('queue-fill').style.width = total>0 ? `${Math.round(done/total*100)}%` : '0%';
    $('queue-percent').textContent = `${done}/${total} 完成`;
  }

  // ─── Selection ──────────────────────────────────────────────────────

  function selectInstance(key) {
    const inst = instances.find(i => instanceKey(i) === key); if (!inst) return;
    selectedInstance = inst;
    seenMsgIds = new Set();
    document.querySelectorAll('.instance-card').forEach(c => c.classList.remove('selected'));
    const card = $(cardId(key)); if (card) card.classList.add('selected');
    $('chat-empty').style.display = 'none';
    $('chat-content').style.display = 'flex';
    $('chat-messages').innerHTML = '';
    updateHeader();
    const s = $('instance-model-select'); if (s) s.value = inst.model || '';
    startMsgPoll();
  }

  function updateHeader() {
    if (!selectedInstance) return;
    const labels = { stopped:'⏹ 已停止',starting:'⏳ 启动中...',ready:'✅ 就绪',auditing:'🔍 审计中...',completed:'✅ 完成',error:'❌ 错误' };
    $('instance-name-display').textContent = selectedInstance.name;
    $('instance-status-display').textContent = labels[selectedInstance.status] || selectedInstance.status;
  }

  // ─── Chat ───────────────────────────────────────────────────────────

  async function sendMessage() {
    const input = $('chat-input'); const text = input.value.trim();
    if (!text || !selectedInstance) return;
    if (selectedInstance.status !== 'ready' && selectedInstance.status !== 'auditing') { toast('实例未就绪', 'error'); return; }
    input.value = ''; autoResize();
    try {
      await api(instPath(selectedInstance, '/send'), { method: 'POST', body: { text } });
      toast('已发送', 'success');
    } catch (err) { toast('发送失败: ' + err.message, 'error'); }
  }

  function onChatKeyDown(e) { if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }
  function autoResize() { const i = $('chat-input'); i.style.height='auto'; i.style.height=Math.min(i.scrollHeight,120)+'px'; }

  async function abortAudit() {
    if (!selectedInstance) return;
    try { await api(instPath(selectedInstance, '/abort'), { method:'POST' }); toast('已中止', 'info'); }
    catch (err) { toast('中止失败: '+err.message, 'error'); }
  }

  // ─── Message Poll ───────────────────────────────────────────────────

  function startMsgPoll() {
    stopMsgPoll();
    pollMessages();
    msgTimer = setInterval(pollMessages, 2000);
  }

  function stopMsgPoll() {
    if (msgTimer) { clearInterval(msgTimer); msgTimer = null; }
  }

  async function pollMessages() {
    if (!selectedInstance) return;
    try {
      const data = await api(instPath(selectedInstance, '/messages'));
      if (!data.messages) return;
      const msgs = $('chat-messages');
      let newContent = false;
      for (const m of data.messages) {
        if (!m.id || seenMsgIds.has(m.id)) continue;
        seenMsgIds.add(m.id);
        newContent = true;
        const div = document.createElement('div');
        div.className = `message ${m.role === 'user' ? 'user' : 'assistant'}`;
        div.innerHTML = `<div class="message-bubble">${escapeHtml(m.text).replace(/\n/g, '<br>')}</div>`;
        msgs.appendChild(div);
      }
      if (newContent) msgs.scrollTop = msgs.scrollHeight;
    } catch {}
  }

  // ─── Launch ─────────────────────────────────────────────────────────

  async function launch() {
    const openCodeRoot = $('input-opencode-root').value.trim();
    const projectRoot = $('input-project-root').value.trim();
    const auditPrompt = $('input-audit-prompt').value.trim();
    const maxConcurrent = parseInt($('input-max-concurrent').value)||3;
    const model = $('input-model').value.trim();
    if (!projectRoot) { toast('请输入项目根目录','error'); return; }
    if (!auditPrompt) { toast('请输入审计 Prompt','error'); return; }
    const btn = $('btn-launch'); btn.disabled=true; btn.innerHTML='<span class="spinner"></span> 扫描中...';
    try {
      await api('/api/config',{method:'POST',body:{openCodeRoot,projectRoot,auditPrompt,maxConcurrent,model}});
      currentModel = model;
      const result = await api('/api/scan',{method:'POST',body:{projectRoot}});
      if (!result.services?.length) { toast('未找到 Git 仓库项目','error'); btn.disabled=false; btn.innerHTML='🚀 扫描并启动'; return; }
      totalInstances = result.services.length;
      toast(`发现 ${result.services.length} 个项目`,'success');
      $('setup-screen').style.display='none'; $('monitor-screen').style.display='flex';
      connectSSE(); instances = await api('/api/instances'); renderList(); renderStats(); startRefresh();
    } catch(err) { toast('启动失败: '+err.message,'error'); }
    btn.disabled=false; btn.innerHTML='🚀 扫描并启动';
  }

  function backToSetup() {
    $('setup-screen').style.display='flex'; $('monitor-screen').style.display='none';
    if (eventSource) eventSource.close(); if (pollTimer) clearInterval(pollTimer);
    stopMsgPoll();
    selectedInstance = null;
  }

  function applyConfigToSetup(cfg) {
    if (!cfg) return;
    if ($('input-opencode-root')) $('input-opencode-root').value = cfg.openCodeRoot||'';
    if ($('input-project-root')) $('input-project-root').value = cfg.projectRoot||'';
    if ($('input-audit-prompt')) $('input-audit-prompt').value = cfg.auditPrompt||'';
    if ($('input-max-concurrent')) $('input-max-concurrent').value = cfg.maxConcurrent||3;
    if ($('input-model')) $('input-model').value = cfg.model||'';
    currentModel = cfg.model||'';
  }

  // ─── Batch ──────────────────────────────────────────────────────────

  async function stopAllInstances() { try { await api('/api/instances/stop-all',{method:'POST'}); toast('停止中...'); } catch(err) { toast('失败: '+err.message,'error'); } }
  async function startBatchAudit() {
    $('btn-start-audit').disabled=true;
    try { const r = await api('/api/audit/start',{method:'POST'}); toast(`批量审计已启动，${r.queued} 个在队列中`,'success'); }
    catch(err) { toast('失败: '+err.message,'error'); }
    setTimeout(() => { $('btn-start-audit').disabled=false; }, 2000);
  }
  async function pauseAudit() {
    try { await api('/api/audit/pause',{method:'POST'}); toast('队列已暂停','info'); }
    catch(err) { toast('暂停失败: '+err.message,'error'); }
  }
  async function resumeAudit() {
    try { await api('/api/audit/resume',{method:'POST'}); toast('队列已恢复','success'); }
    catch(err) { toast('恢复失败: '+err.message,'error'); }
  }

  function startRefresh() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try { const latest = await api('/api/instances'); if (Array.isArray(latest)) { instances=latest; renderList(); renderStats(); if (selectedInstance) { const u = instances.find(i=>instanceKey(i)===instanceKey(selectedInstance)); if (u) { selectedInstance=u; updateHeader(); } } } } catch {}
    }, 8000);
  }

  // ─── Model ──────────────────────────────────────────────────────────

  async function setGlobalModel(model) { try { await api('/api/global-model',{method:'POST',body:{model}}); toast('✅ 全局模型已更新','success'); } catch(e) { toast('失败','error'); } }
  async function setInstanceModel(model) { if (!selectedInstance) return; try { await api(instPath(selectedInstance,'/model'),{method:'POST',body:{model}}); toast('✅ 实例模型已更新','success'); } catch(e) { toast('失败','error'); } }

  // ─── Settings ────────────────────────────────────────────────────────

  function toggleSettings() {
    const overlay = $('settings-overlay');
    if (overlay.classList.contains('hidden')) {
      api('/api/config').then(cfg => {
        $('settings-audit-prompt').value = cfg.auditPrompt || '';
        $('settings-max-concurrent').value = cfg.maxConcurrent || 3;
        $('settings-model').value = cfg.model || '';
      }).catch(() => {});
      overlay.classList.remove('hidden');
    } else {
      overlay.classList.add('hidden');
    }
  }

  async function saveSettings() {
    const auditPrompt = $('settings-audit-prompt').value.trim();
    const maxConcurrent = parseInt($('settings-max-concurrent').value) || 3;
    const model = $('settings-model').value.trim();
    try {
      await api('/api/config', { method: 'POST', body: { auditPrompt, maxConcurrent, model } });
      if (model) await api('/api/global-model', { method: 'POST', body: { model } });
      toast('设置已保存', 'success');
      $('settings-overlay').classList.add('hidden');
    } catch (err) {
      toast('保存失败: ' + err.message, 'error');
    }
  }

  // ─── Init ───────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', async () => {
    const input = $('chat-input'); if (input) input.addEventListener('input', autoResize);
    let cfg = null;
    try { cfg = await api('/api/config'); applyConfigToSetup(cfg); } catch {}
    try {
      const db = await api('/api/models');
      if (db?.models) {
        const models = normalizeModelOptions(db.models);
        const opts = models.map(m => `<option value="${escapeHtml(m.value)}">${escapeHtml(m.label)}</option>`).join('');
        const list = $('model-list'); if (list) list.innerHTML = models.map(m => `<option value="${escapeHtml(m.value)}" label="${escapeHtml(m.label)}"></option>`).join('');
        const gs = $('global-model-select'); if (gs) gs.innerHTML = `<option value="">-- 系统默认 --</option>` + opts;
        const is = $('instance-model-select'); if (is) is.innerHTML = `<option value="">系统默认</option>` + opts;
        const ms = $('model-list-settings'); if (ms) ms.innerHTML = models.map(m => `<option value="${escapeHtml(m.value)}" label="${escapeHtml(m.label)}"></option>`).join('');
      }
    } catch {}
    try {
      const existing = await api('/api/instances');
      if (Array.isArray(existing) && existing.length) {
        applyConfigToSetup(cfg||await api('/api/config'));
        instances=existing; totalInstances=instances.length;
        $('setup-screen').style.display='none'; $('monitor-screen').style.display='flex';
        connectSSE(); renderList(); renderStats(); startRefresh();
      }
    } catch {}
  });

  return { launch, backToSetup, startBatchAudit, pauseAudit, resumeAudit, stopAllInstances, sendMessage, onChatKeyDown, abortAudit, selectInstance, setGlobalModel, setInstanceModel, toggleSettings, saveSettings };
})();

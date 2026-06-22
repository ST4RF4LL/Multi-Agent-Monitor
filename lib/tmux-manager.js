const { spawn } = require('child_process');

const SESSION_PREFIX = 'mam-';

class TmuxManager {
  exec(args, timeoutOrOpts = 15000) {
    const timeout = typeof timeoutOrOpts === 'number' ? timeoutOrOpts : (timeoutOrOpts.timeout || 15000);
    const raw = typeof timeoutOrOpts === 'object' ? timeoutOrOpts.raw : false;
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const proc = spawn('tmux', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
      });
      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.stderr.on('data', (d) => (stderr += d.toString()));
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code !== 0) reject(new Error(stderr.trim() || `tmux exit ${code}`));
        else resolve(raw ? stdout : stdout.trim());
      });
    });
  }

  sessionName(instanceId) {
    return `${SESSION_PREFIX}${instanceId}`;
  }

  windowTarget(sessionId, windowIndex = 0) {
    return `${sessionId}:${windowIndex}`;
  }

  async createSession(instanceId, command, cwd) {
    return this.createSessionWithEnv(instanceId, command, cwd, {});
  }

  async createSessionWithEnv(instanceId, command, cwd, env, size) {
    const name = this.sessionName(instanceId);
    const exists = await this.hasSession(name).catch(() => false);
    if (exists) {
      await this.killSession(name).catch(() => {});
    }
    const envArgs = [];
    for (const [key, value] of Object.entries(env)) {
      envArgs.push('-e', `${key}=${value}`);
    }
    const cols = (size && size.cols) || 160;
    const rows = (size && size.rows) || 40;
    await this.exec([
      'new-session', '-d',
      '-s', name,
      '-c', cwd,
      '-x', String(cols),
      '-y', String(rows),
      ...envArgs,
      command,
    ]);
    return name;
  }

  async killSession(sessionId) {
    try {
      await this.exec(['kill-session', '-t', sessionId]);
    } catch {
      // session may already be dead
    }
  }

  async hasSession(sessionId) {
    try {
      const out = await this.exec(['has-session', '-t', sessionId]);
      return true;
    } catch {
      return false;
    }
  }

  async sendKeys(sessionId, keys) {
    const target = this.windowTarget(sessionId);
    await this.exec(['send-keys', '-t', target, keys]);
  }

  async sendKeysLiteral(sessionId, text) {
    const target = this.windowTarget(sessionId);
    await this.exec(['send-keys', '-t', target, '-l', text]);
  }

  async sendEnter(sessionId) {
    const target = this.windowTarget(sessionId);
    await this.exec(['send-keys', '-t', target, 'Enter']);
  }

  async capturePane(sessionId) {
    const target = this.windowTarget(sessionId);
    const out = await this.exec([
      'capture-pane', '-t', target,
      '-p', '-e',
      '-S', '-',
    ], { raw: true });
    return out;
  }

  async capturePanePlain(sessionId) {
    const target = this.windowTarget(sessionId);
    const out = await this.exec([
      'capture-pane', '-t', target,
      '-p',
      '-S', '-',
    ], { raw: true });
    return out;
  }

  async capturePaneSince(sessionId, lastLine) {
    const target = this.windowTarget(sessionId);
    const out = await this.exec([
      'capture-pane', '-t', target,
      '-p', '-e',
      '-S', String(lastLine),
    ], { raw: true });
    return out;
  }

  async listSessions() {
    try {
      const out = await this.exec([
        'list-sessions',
        '-F', '#{session_name}',
        '-f', `#{m:#{session_name},${SESSION_PREFIX}}`,
      ]);
      if (!out) return [];
      return out.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  async getPanePid(sessionId) {
    const target = this.windowTarget(sessionId);
    try {
      const out = await this.exec([
        'display-message', '-t', target,
        '-p', '#{pane_pid}',
      ]);
      return parseInt(out.trim(), 10);
    } catch {
      return null;
    }
  }
}

module.exports = new TmuxManager();

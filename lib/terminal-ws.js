const { WebSocketServer } = require('ws');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const tmux = require('./tmux-manager');

function createTerminalWSServer(server) {
  const wss = new WebSocketServer({ server, path: '/terminals/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const instanceId = url.searchParams.get('id');
    if (!instanceId) {
      ws.close(4000, 'Missing instance id');
      return;
    }

    const sessionId = tmux.sessionName(instanceId);
    const target = tmux.windowTarget(sessionId);
    const fifoPath = path.join(os.tmpdir(), `mam-pty-${instanceId}.fifo`);
    let fifoReader = null;
    let closed = false;
    let resized = false;
    let pipePaneActive = false;

    console.log(`[TERM-WS] Client connected: ${instanceId}`);

    const sendData = (data) => {
      if (!closed && ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    };

    const cleanup = () => {
      closed = true;
      if (fifoReader) { fifoReader.kill(); fifoReader = null; }
      // Don't delete fifo — pipe-pane still writes to it, next connection reuses
    };

    const startPipePane = () => {
      return new Promise((resolve, reject) => {
        const proc = spawn('tmux', ['pipe-pane', '-t', target, '-o', `cat > ${fifoPath}`], { stdio: 'ignore' });
        proc.on('error', reject);
        proc.on('close', (code) => {
          if (code !== 0 && !closed) reject(new Error(`pipe-pane exit ${code}`));
          else resolve();
        });
      });
    };

    const startFifoReader = () => {
      if (fifoReader) { fifoReader.kill(); fifoReader = null; }
      const cat = spawn('cat', [fifoPath], { stdio: ['ignore', 'pipe', 'ignore'] });
      fifoReader = cat;
      cat.stdout.on('data', (chunk) => {
        if (!closed) sendData(chunk.toString('utf8'));
      });
      cat.on('error', () => {});
      cat.on('close', () => {
        // Reader closed — no auto-restart, next WebSocket connection will handle
      });
    };

    const syncDimensions = async (cols, rows) => {
      await tmux.exec([
        'resize-window', '-t', target,
        '-x', String(cols), '-y', String(rows),
      ]).catch(() => {});
      sendData('\x1b[H\x1b[J');
      await tmux.sendKeys(sessionId, 'C-l');
    };

    (async () => {
      const exists = await tmux.hasSession(sessionId);
      if (!exists) {
        sendData('\r\n\x1b[33m实例未启动，请先启动实例。\x1b[0m\r\n');
        ws.close(4001);
        return;
      }

      const fifoExists = fs.existsSync(fifoPath);
      if (!fifoExists) {
        spawnSync('mkfifo', [fifoPath]);
        try {
          await startPipePane();
          pipePaneActive = true;
        } catch (err) {
          console.error(`[TERM-WS] Failed pipe-pane: ${err.message}`);
          sendData(`\r\n\x1b[31m[Error: ${err.message}]\x1b[0m\r\n`);
          return;
        }
      }

      startFifoReader();
    })();

    ws.on('message', async (raw) => {
      let data;
      try { data = JSON.parse(raw.toString()); } catch { return; }

      try {
        if (data.type === 'resize') {
          const cols = data.cols || 80;
          const rows = data.rows || 24;
          if (!resized) {
            resized = true;
            await syncDimensions(cols, rows);
          } else {
            await tmux.exec([
              'resize-window', '-t', target,
              '-x', String(cols), '-y', String(rows),
            ]).catch(() => {});
            await tmux.sendKeys(sessionId, 'C-l');
          }
        } else if (data.type === 'input') {
          const text = data.data || '';
          if (text === '\r' || text === '\n') {
            await tmux.sendEnter(sessionId);
          } else if (text === '\x03') {
            await tmux.sendKeys(sessionId, 'C-c');
          } else if (text === '\x04') {
            await tmux.sendKeys(sessionId, 'C-d');
          } else if (text === '\x1b') {
            await tmux.sendKeys(sessionId, 'Escape');
          } else if (text === '\t') {
            await tmux.sendKeys(sessionId, 'Tab');
          } else if (text.startsWith('\x1b[')) {
            const seq = text.slice(2);
            const map = {'A':'Up','B':'Down','C':'Right','D':'Left','H':'Home','F':'End','5~':'PageUp','6~':'PageDown'};
            await tmux.sendKeys(sessionId, map[seq] || seq);
          } else if (text === '\x7f' || text === '\b') {
            await tmux.sendKeys(sessionId, 'BSpace');
          } else {
            await tmux.sendKeysLiteral(sessionId, text);
          }
        }
      } catch (err) {
        console.error(`[TERM-WS] Input error: ${err.message}`);
      }
    });

    ws.on('close', () => { console.log(`[TERM-WS] Client left: ${instanceId}`); cleanup(); });
    ws.on('error', () => cleanup());
  });

  return wss;
}

module.exports = createTerminalWSServer;

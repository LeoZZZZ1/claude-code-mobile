require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const https = require('https');
const { Buffer } = require('buffer');

// ── In-memory log ring buffer ────────────────────────────────────────────────
const LOG_MAX = 200;
const logLines = [];
const origLog = console.log.bind(console);
const origErr = console.error.bind(console);
function pushLog(level, ...args) {
  const line = { t: Date.now(), level, msg: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') };
  logLines.push(line);
  if (logLines.length > LOG_MAX) logLines.shift();
}
console.log   = (...a) => { origLog(...a);   pushLog('info',  ...a); };
console.error = (...a) => { origErr(...a);   pushLog('error', ...a); };

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.CLAUDE_PASSWORD || 'changeme';
const CLAUDE_BIN = '/usr/local/bin/claude';
const UNBUFFER_BIN = '/usr/local/bin/unbuffer';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const UPLOADS_DIR = path.join(os.homedir(), 'claude-mobile', 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const SESSIONS_FILE = path.join(os.homedir(), 'claude-mobile', 'sessions.json');

// ── Global session store (persists across phone reconnects) ──────────────────
// key → { sessionKey, label, claudeSessionId, proc, lineBuffer, attachments, history }
const globalSessions = new Map();

// Load persisted sessions from disk
function loadSessions() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return;
    const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    for (const s of data) {
      globalSessions.set(s.sessionKey, {
        sessionKey: s.sessionKey,
        label: s.label,
        claudeSessionId: s.claudeSessionId,
        proc: null, lineBuffer: '', attachments: [], ws: null,
        history: s.history || [],
        effort: s.effort || 'high',
        model: s.model || 'claude-sonnet-4-6',
        planMode: s.planMode || false,
        agentName: s.agentName || null,
        liveBuffer: [],
        createdAt: s.createdAt || Date.now(),
      });
    }
    console.log(`📂 Loaded ${globalSessions.size} saved sessions`);
  } catch(e) {
    console.error('Failed to load sessions:', e.message);
  }
}

function saveSessions() {
  try {
    const data = [...globalSessions.values()].map(s => ({
      sessionKey: s.sessionKey,
      label: s.label,
      claudeSessionId: s.claudeSessionId,
      history: s.history,
      effort: s.effort || 'high',
      model: s.model || 'claude-sonnet-4-6',
      planMode: s.planMode || false,
      agentName: s.agentName || null,
      createdAt: s.createdAt || Date.now(),
    }));
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
  } catch(e) {
    console.error('Failed to save sessions:', e.message);
  }
}

loadSessions();

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.md': 'text/plain', '.txt': 'text/plain',
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.csv': 'text/csv',
  '.py': 'text/plain', '.ts': 'text/plain', '.tsx': 'text/plain',
  '.js': 'text/plain', '.jsx': 'text/plain',
};

const server = http.createServer((req, res) => {

  // ── Main app ──
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
    return;
  }

  // ── File browser UI ──
  if (req.url === '/logs') {
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Server Logs</title>
<style>
  body{background:#0d0d0d;color:#e8e8e8;font-family:'SF Mono',monospace;font-size:12px;padding:12px;margin:0}
  h2{color:#d97757;font-size:14px;margin:0 0 10px}
  .line{padding:3px 0;border-bottom:1px solid #1a1a1a;white-space:pre-wrap;word-break:break-all}
  .error{color:#d47070} .info{color:#e8e8e8}
  .ts{color:#555;margin-right:8px}
  #refresh{background:#d97757;color:white;border:none;border-radius:8px;padding:6px 14px;font-size:13px;cursor:pointer;margin-bottom:10px}
</style></head><body>
<h2>Server Logs</h2>
<button id="refresh" onclick="location.reload()">↻ Refresh</button>
<div id="logs">${logLines.slice().reverse().map(l => {
  const ts = new Date(l.t).toTimeString().slice(0,8);
  return `<div class="line ${l.level}"><span class="ts">${ts}</span>${l.msg.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>`;
}).join('')}</div>
</body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  if (req.url === '/files') {
    try {
      const files = fs.readdirSync(UPLOADS_DIR).map(name => {
        const stat = fs.statSync(path.join(UPLOADS_DIR, name));
        return { name, size: stat.size, mtime: stat.mtime };
      }).sort((a, b) => b.mtime - a.mtime);

      const rows = files.map(f => {
        const ext = path.extname(f.name).toLowerCase();
        const icon = ['.png','.jpg','.jpeg','.gif','.webp'].includes(ext) ? '🖼' :
                     ['.pdf'].includes(ext) ? '📄' :
                     ['.py','.js','.ts','.jsx','.tsx'].includes(ext) ? '💻' : '📁';
        const kb = (f.size / 1024).toFixed(1);
        const date = f.mtime.toLocaleDateString();
        return `<tr onclick="window.open('/file/${encodeURIComponent(f.name)}','_blank')" style="cursor:pointer">
          <td style="padding:10px 8px">${icon}</td>
          <td style="padding:10px 4px;word-break:break-all;font-size:13px">${f.name}</td>
          <td style="padding:10px 8px;color:#888;font-size:12px;white-space:nowrap">${kb} KB</td>
          <td style="padding:10px 8px;color:#888;font-size:12px;white-space:nowrap">${date}</td>
        </tr>`;
      }).join('');

      const html = `<!DOCTYPE html><html><head>
        <meta charset="UTF-8"/>
        <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
        <title>Files</title>
        <style>
          body{background:#0d0d0d;color:#e8e8e8;font-family:-apple-system,sans-serif;margin:0;padding:0}
          h2{margin:0;padding:16px;font-size:17px;border-bottom:1px solid #222;position:sticky;top:0;background:#0d0d0d}
          table{width:100%;border-collapse:collapse}
          tr:hover{background:#1a1a1a}
          tr{border-bottom:1px solid #1a1a1a}
          .empty{padding:40px;text-align:center;color:#666}
        </style>
      </head><body>
        <h2 style="display:flex;align-items:center;gap:10px"><button onclick="window.close()" style="background:none;border:none;color:#d97757;font-size:20px;cursor:pointer;padding:0;line-height:1">←</button>📁 Files (${files.length})</h2>
        ${files.length ? `<table>${rows}</table>` : '<div class="empty">No files yet</div>'}
      </body></html>`;

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch(e) {
      res.writeHead(500); res.end('Error: ' + e.message);
    }
    return;
  }

  // ── Serve individual file ──
  if (req.url.startsWith('/file/')) {
    const filename = decodeURIComponent(req.url.slice(6));
    const filePath = path.join(UPLOADS_DIR, path.basename(filename));
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filename).toLowerCase();
    const ct = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': ct,
      'Content-Disposition': `inline; filename="${path.basename(filename)}"`,
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // ── Whisper transcription ──
  if (req.url === '/transcribe' && req.method === 'POST') {
    let body = [];
    req.on('data', chunk => body.push(chunk));
    req.on('end', () => {
      const data = JSON.parse(Buffer.concat(body).toString());
      transcribeAudio(data.audio, data.mimeType || 'audio/webm')
        .then(text => { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({text})); })
        .catch(e => { res.writeHead(500, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); });
    });
    return;
  }

  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let authenticated = false;
  let mySessionKeys = new Set(); // sessions this WS connection is managing

  const send = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── Auth ──────────────────────────────────────────────────────────────
    if (!authenticated) {
      if (msg.type === 'auth' && msg.password === PASSWORD) {
        authenticated = true;

        // Send existing sessions back to client for restoration
        const activeSessions = [...globalSessions.values()].map(s => ({
          sessionKey: s.sessionKey,
          label: s.label,
          history: s.history,
          thinking: !!s.proc,
          effort: s.effort || 'high',
          model: s.model || 'sonnet',
        }));

        send({ type: 'auth_ok', sessions: activeSessions });
        console.log(`📱 Phone authenticated (${activeSessions.length} existing sessions)`);
        // Replay buffered output for any currently-running sessions
        for (const s of globalSessions.values()) {
          if (s.proc && s.liveBuffer.length > 0) {
            console.log(`  ↩ Replaying ${s.liveBuffer.length} events for session ${s.sessionKey}`);
            for (const event of s.liveBuffer) {
              if (ws.readyState === 1) ws.send(JSON.stringify(event));
            }
          }
        }

        // Re-attach WS to existing sessions so they stream to this client
        for (const s of globalSessions.values()) {
          s.ws = ws;
          mySessionKeys.add(s.sessionKey);
        }

        // Deliver any done events that fired while phone was disconnected
        for (const s of globalSessions.values()) {
          if (s.pendingDone) {
            console.log(`  → Delivering queued done for ${s.sessionKey}`);
            if (ws.readyState === 1) ws.send(s.pendingDone);
            s.pendingDone = null;
          }
        }
      } else {
        send({ type: 'auth_fail' });
        console.warn('🔒 Bad password attempt');
      }
      return;
    }

    const key = msg.sessionKey || 'default';

    // ── Kill session ──────────────────────────────────────────────────────
    if (msg.type === 'ping') {
      send({ type: 'pong' });
      return;
    }

    if (msg.type === 'set_effort') {
      const s = globalSessions.get(key);
      if (s) { s.effort = msg.level; saveSessions(); }
      return;
    }

    if (msg.type === 'set_model') {
      const s = globalSessions.get(key);
      if (s) { s.model = msg.model; saveSessions(); }
      return;
    }

    if (msg.type === 'set_plan_mode') {
      const s = globalSessions.get(key);
      if (s) { s.planMode = msg.enabled; saveSessions(); }
      return;
    }

    if (msg.type === 'plan_approve') {
      const s = globalSessions.get(key);
      if (s?.proc?.stdin) {
        s._planWaitingSent = false;  // allow detecting next plan cycle
        s.proc.stdin.write('yes\n');
        console.log(`✓ [${key}] Plan approved`);
      }
      return;
    }

    if (msg.type === 'plan_reject') {
      const s = globalSessions.get(key);
      if (s?.proc) {
        if (s.proc.stdin) s.proc.stdin.write('no\n');
        setTimeout(() => { try { s.proc?.kill('SIGTERM'); } catch(e){} }, 200);
        console.log(`✗ [${key}] Plan rejected`);
      }
      return;
    }

    if (msg.type === 'list_agents') {
      const agentsDir = path.join(os.homedir(), '.claude', 'agents');
      const agents = [];
      if (fs.existsSync(agentsDir)) {
        for (const f of fs.readdirSync(agentsDir)) {
          if (!f.endsWith('.md')) continue;
          try {
            const content = fs.readFileSync(path.join(agentsDir, f), 'utf8');
            const descMatch = content.match(/description:\s*(.+)/i);
            agents.push({ name: f.replace('.md',''), desc: descMatch?.[1]?.trim() || '' });
          } catch(e) {}
        }
      }
      send({ type: 'agents_list', agents });
      return;
    }

    if (msg.type === 'create_agent') {
      const agentsDir = path.join(os.homedir(), '.claude', 'agents');
      if (!fs.existsSync(agentsDir)) fs.mkdirSync(agentsDir, { recursive: true });
      const safeName = msg.name.replace(/[^a-z0-9\-_]/gi, '-').toLowerCase();
      const content = `---\nname: ${safeName}\ndescription: ${msg.prompt.slice(0,80)}\ntools: inherit\n---\n\n${msg.prompt}\n`;
      fs.writeFileSync(path.join(agentsDir, `${safeName}.md`), content);
      send({ type: 'agent_saved', name: safeName });
      console.log(`🤖 Created agent: ${safeName}`);
      return;
    }

    if (msg.type === 'run_cmd') {
      const { execFile } = require('child_process');
      const allowed = { 'doctor': [CLAUDE_BIN, ['doctor']], 'version': [CLAUDE_BIN, ['--version']] };
      const entry = allowed[msg.cmd];
      if (!entry) { send({ type: 'sys_msg', text: '⚠ Unknown command', sessionKey: key }); return; }
      execFile(entry[0], entry[1], { env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin' }, timeout: 15000 }, (err, stdout, stderr) => {
        const output = (stdout || '') + (stderr || '');
        send({ type: 'sys_msg', text: output.trim() || (err?.message || 'No output'), sessionKey: key });
      });
      return;
    }

    // ── Get history for a terminal session ───────────────────────────────
    if (msg.type === 'get_terminal_history') {
      const { sessionId, projectPath } = msg;
      try {
        // Encode project path the same way Claude Code does: replace / with -
        const projectsDir = path.join(os.homedir(), '.claude', 'projects');
        let sessionFile = null;

        // Try direct encoding first: /home/user/myapp → -home-user-myapp-
        if (projectPath) {
          const encoded = projectPath.replace(/\//g, '-') + '-';
          const candidate = path.join(projectsDir, encoded, `${sessionId}.jsonl`);
          if (fs.existsSync(candidate)) sessionFile = candidate;
        }

        // Fallback: search all project dirs for this sessionId
        if (!sessionFile && fs.existsSync(projectsDir)) {
          for (const dir of fs.readdirSync(projectsDir)) {
            const candidate = path.join(projectsDir, dir, `${sessionId}.jsonl`);
            if (fs.existsSync(candidate)) { sessionFile = candidate; break; }
          }
        }

        if (!sessionFile) {
          send({ type: 'terminal_history', sessionId, messages: [], error: 'Session file not found' });
          return;
        }

        const lines = fs.readFileSync(sessionFile, 'utf8').trim().split('\n').filter(Boolean);
        const messages = [];
        for (const line of lines) {
          try {
            const e = JSON.parse(line);
            // Claude Code JSONL format: {type: 'user'|'assistant', message: {role, content}}
            if (e.type === 'user' && e.message?.content) {
              const content = Array.isArray(e.message.content)
                ? e.message.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
                : String(e.message.content);
              if (content.trim()) messages.push({ role: 'user', text: content.trim() });
            } else if (e.type === 'assistant' && e.message?.content) {
              const content = Array.isArray(e.message.content)
                ? e.message.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
                : String(e.message.content);
              if (content.trim()) messages.push({ role: 'claude', text: content.trim() });
            }
          } catch(err) { /* skip malformed lines */ }
        }
        // Send last 20 messages to avoid overwhelming the UI
        const recent = messages.slice(-20);
        send({ type: 'terminal_history', sessionId, messages: recent });
        console.log(`📖 [${sessionId}] Sent ${recent.length} history messages`);
      } catch(e) {
        console.error('get_terminal_history error:', e.message);
        send({ type: 'terminal_history', sessionId, messages: [], error: e.message });
      }
      return;
    }

    // ── List terminal sessions from ~/.claude/history.jsonl ──────────────
    if (msg.type === 'list_terminal_sessions') {
      const histFile = path.join(os.homedir(), '.claude', 'history.jsonl');
      try {
        if (!fs.existsSync(histFile)) { send({ type: 'terminal_sessions', sessions: [] }); return; }
        const lines = fs.readFileSync(histFile, 'utf8').trim().split('\n').filter(Boolean);
        // IDs already open as mobile sessions — skip duplicates
        const openIds = new Set([...globalSessions.values()].map(s => s.claudeSessionId).filter(Boolean));
        const HOURS = 24;
        const cutoff = Date.now() - (HOURS * 60 * 60 * 1000);
        const seen = new Set();
        const sessions = lines
          .map(l => { try { return JSON.parse(l); } catch(e) { return null; } })
          .filter(e => e && e.sessionId && (e.timestamp || 0) >= cutoff)
          .reverse()
          .filter(e => {
            if (seen.has(e.sessionId) || openIds.has(e.sessionId)) return false;
            seen.add(e.sessionId);
            return true;
          })
          .slice(0, 20)
          .map(e => ({
            sessionId:   e.sessionId,
            project:     e.project ? path.basename(e.project) : 'Terminal',
            projectPath: e.project || '',
            timestamp:   e.timestamp || 0,
          }));
        send({ type: 'terminal_sessions', sessions });
        console.log(`📋 Sent ${sessions.length} terminal sessions`);
      } catch(e) {
        console.error('list_terminal_sessions error:', e.message);
        send({ type: 'terminal_sessions', sessions: [] });
      }
      return;
    }

    if (msg.type === 'kill_session') {
      const s = globalSessions.get(key);
      if (s?.proc) s.proc.kill('SIGTERM');
      globalSessions.delete(key);
      saveSessions();
      mySessionKeys.delete(key);
      send({ type: 'session_killed', sessionKey: key });
      return;
    }


    // ── Cancel ───────────────────────────────────────────────────────────
    if (msg.type === 'cancel') {
      const s = globalSessions.get(key);
      if (s?.proc) { s.proc.kill('SIGTERM'); s.proc = null; }
      send({ type: 'done', subtype: 'cancelled', sessionKey: key });
      return;
    }

    // ── Attachment ────────────────────────────────────────────────────────
    if (msg.type === 'attachment') {
      if (!globalSessions.has(key)) globalSessions.set(key, newSession(key, 'Session'));
      const s = globalSessions.get(key);
      s.ws = ws; mySessionKeys.add(key);
      try {
        const filePath = path.join(UPLOADS_DIR, `${Date.now()}_${msg.name}`);
        fs.writeFileSync(filePath, Buffer.from(msg.data, 'base64'));
        s.attachments.push({ path: filePath, name: msg.name });
        send({ type: 'attachment_ok', name: msg.name, sessionKey: key });
        console.log(`📎 [${key}] ${msg.name}`);
      } catch(e) {
        send({ type: 'error', text: `Failed to save: ${e.message}`, sessionKey: key });
      }
      return;
    }

    // ── Server control ────────────────────────────────────────────────────
    if (msg.type === 'server_ctrl') {
      const { execSync } = require('child_process');
      const plist = `${process.env.HOME}/Library/LaunchAgents/com.claudemobile.server.plist`;
      if (msg.action === 'stop') {
        setTimeout(() => { try { execSync(`launchctl unload ${plist}`); } catch(e){} }, 500);
      } else if (msg.action === 'restart') {
        setTimeout(() => {
          try {
            execSync(`launchctl unload ${plist}`);
            setTimeout(() => { try { execSync(`launchctl load ${plist}`); } catch(e){} }, 1000);
          } catch(e){}
        }, 500);
      }
      return;
    }

    if (msg.type === 'new_session') {
      if (!globalSessions.has(key)) {
        const s = newSession(key, msg.label || 'Session');
        s.planMode = msg.planMode || false;
        s.agentName = msg.agentName || null;
        // If resuming a terminal session, pre-set the claudeSessionId so
        // the first message automatically uses --resume <id>
        if (msg.resumeSessionId) s.claudeSessionId = msg.resumeSessionId;
        globalSessions.set(key, s);
      }
      const s = globalSessions.get(key);
      s.ws = ws;
      mySessionKeys.add(key);
      saveSessions();
      return;
    }

    if (msg.type !== 'message' || !msg.text?.trim()) return;

    // ── Ensure session exists ─────────────────────────────────────────────
    if (!globalSessions.has(key)) globalSessions.set(key, newSession(key, msg.label || 'Session'));
    const session = globalSessions.get(key);
    session.ws = ws;
    mySessionKeys.add(key);

    if (session.proc) { session.proc.kill('SIGTERM'); session.proc = null; }
    session.lineBuffer = '';

    // Add to history
    session.history.push({ role: 'user', text: msg.text });
    saveSessions();

    let promptText = msg.text;

    // Handle attachments sent inline with the message
    if (msg.attachments?.length > 0) {
      for (const att of msg.attachments) {
        try {
          const safeBase64 = att.data.includes(',') ? att.data.split(',')[1] : att.data;
          const filePath = path.join(UPLOADS_DIR, `${Date.now()}_${path.basename(att.name)}`);
          fs.writeFileSync(filePath, Buffer.from(safeBase64, 'base64'));
          session.attachments.push({ path: filePath, name: att.name });
          console.log(`📎 [${key}] saved inline attachment: ${att.name}`);
        } catch(e) {
          console.error(`📎 [${key}] failed to save attachment ${att.name}:`, e.message);
        }
      }
    }

    if (session.attachments?.length > 0) {
      promptText += '\n\nAttached files:\n' + session.attachments.map(a => a.path).join('\n');
      session.attachments = [];
    }

    const systemPrompt = `When creating or saving any files, always save to ${UPLOADS_DIR}. Never ask where to save — always use that directory. Tell the user the filename when done.`;
    const effortFlag = session.effort || 'high';
    const modelFlag = session.model || 'claude-sonnet-4-6';
    const isOpus = modelFlag.includes('opus');
    const isPlanMode = session.planMode || false;

    const claudeArgs = [
      '-p', promptText,
      '--output-format', 'stream-json',
      '--verbose',
      '--append-system-prompt', systemPrompt,
      '--model', modelFlag,
    ];

    // Plan mode: use plan permission mode, don't skip permissions
    if (isPlanMode) {
      claudeArgs.push('--permission-mode', 'plan');
    } else {
      claudeArgs.push('--dangerously-skip-permissions');
    }

    if (isOpus) claudeArgs.push('--effort', effortFlag);
    // Agent: read the agent's .md file and inject its system prompt
    if (session.agentName) {
      const agentsDir = require('path').join(require('os').homedir(), '.claude', 'agents');
      const agentFile = require('path').join(agentsDir, `${session.agentName}.md`);
      try {
        let agentContent = fs.readFileSync(agentFile, 'utf8');
        // Strip frontmatter (--- ... ---) if present
        agentContent = agentContent.replace(/^---[\s\S]*?---\s*/m, '').trim();
        if (agentContent) claudeArgs.push('--append-system-prompt', agentContent);
        console.log(`🤖 [${key}] Loaded agent: ${session.agentName}`);
      } catch(e) {
        console.warn(`⚠ [${key}] Could not load agent "${session.agentName}": ${e.message}`);
      }
    }
    if (session.claudeSessionId) claudeArgs.push('--resume', session.claudeSessionId);

    console.log(`→ [${key}] model=${modelFlag} effort=${isOpus?effortFlag:'n/a'} text="${msg.text.slice(0, 60)}"`);
    console.log(`  args: ${claudeArgs.join(' ')}`);

    const proc = spawn(UNBUFFER_BIN, [CLAUDE_BIN, ...claudeArgs], {
      env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin' },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    session.proc = proc;
    let claudeResponseText = '';
    let planWaitingSent = false;

    // In plan mode, detect when Claude pauses waiting for approval (2s idle after output)
    let planIdleTimer = null;
    if (session.planMode) {
      const resetPlanIdle = () => {
        clearTimeout(planIdleTimer);
        planIdleTimer = setTimeout(() => {
          if (session.proc && !planWaitingSent && claudeResponseText) {
            planWaitingSent = true;
            const evt = { type: 'plan_waiting', sessionKey: key };
            if (session.liveBuffer) session.liveBuffer.push(evt);
            if (session.ws?.readyState === 1) session.ws.send(JSON.stringify(evt));
          }
        }, 2000);
      };
      session._resetPlanIdle = resetPlanIdle;
    }

    proc.stdout.on('data', (chunk) => {
      if (session._resetPlanIdle) session._resetPlanIdle();
      const clean = chunk.toString()
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
        .replace(/\x1b\][^\x07]*\x07/g, '')
        .replace(/\r\n/g, '\n').replace(/\r/g, '\n');

      session.lineBuffer += clean;
      const lines = session.lineBuffer.split('\n');
      session.lineBuffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // sendLive: send to client and buffer for reconnect replay
        const sendLive = (obj) => {
          if (session.liveBuffer) {
            session.liveBuffer.push(obj);
            if (session.liveBuffer.length > 500) session.liveBuffer.shift();
          }
          if (session.ws?.readyState === 1) session.ws.send(JSON.stringify(obj));
        };

        if (trimmed.startsWith('{')) {
          try {
            const event = JSON.parse(trimmed);
            handleEvent(event, session, claudeResponseText, (text) => { claudeResponseText = text; }, sendLive);
            continue;
          } catch(e) {
            console.error(`[${key}] handleEvent error:`, e.message);
          }
        }
        // Log unrecognised non-JSON output and forward to client
        console.log(`[${key}] non-json: ${trimmed.slice(0, 120)}`);
        // Detect plan mode waiting for approval
        if (session.planMode && /do you want to proceed|approve|yes\/no|y\/n|\(y\)|\[y\]/i.test(trimmed)) {
          sendLive({ type: 'plan_waiting', sessionKey: key });
        } else {
          if (session.ws?.readyState === 1) session.ws.send(JSON.stringify({ type: 'sys_msg', text: trimmed, sessionKey: key }));
        }
      }
    });

    proc.stderr.on('data', chunk => {
      const text = chunk.toString().trim();
      if (text) {
        console.error(`[${key}] stderr:`, text);
        if (!/^unbuffer|^expect/i.test(text)) {
          session.ws?.readyState === 1 && session.ws.send(JSON.stringify({
            type: 'token', text: `\n⚠ ${text}`, sessionKey: key
          }));
        }
      }
    });
    proc.on('close', (code) => {
      console.log(`← [${key}] Claude exited code=${code} hadResponse=${!!claudeResponseText}`);
      session.proc = null;
      if (claudeResponseText) session.history.push({ role: 'claude', text: claudeResponseText });
      saveSessions();
      const doneMsg = { type: 'done', error: code !== 0, code, sessionKey: key };
      // Push done into liveBuffer so reconnecting phone gets it on replay
      if (session.liveBuffer) session.liveBuffer.push(doneMsg);
      if (session.ws?.readyState === 1) {
        session.ws.send(JSON.stringify(doneMsg));
      } else {
        session.pendingDone = JSON.stringify(doneMsg);
        console.log(`[${key}] WS unavailable at close — queued done for reconnect`);
      }
    });
    proc.on('error', e => {
      session.ws?.readyState === 1 && session.ws.send(JSON.stringify({ type: 'error', text: e.message, sessionKey: key }));
    });
  });

  ws.on('close', () => {
    // Don't kill sessions — they keep running, ws ref goes stale
    console.log('📱 Phone disconnected (sessions preserved)');
  });
});

function newSession(key, label) {
  return { sessionKey: key, label, claudeSessionId: null, proc: null, lineBuffer: '', attachments: [], history: [], ws: null, effort: 'high', model: 'claude-sonnet-4-6', planMode: false, agentName: null, liveBuffer: [], createdAt: Date.now() };
}

function handleEvent(event, session, claudeResponseText, setResponse, sendFn) {
  const key = session.sessionKey;
  const sendWs = sendFn || ((obj) => session.ws?.readyState === 1 && session.ws.send(JSON.stringify(obj)));

  switch (event.type) {
    case 'system':
      if (event.subtype === 'init' && event.session_id) {
        session.claudeSessionId = event.session_id;
        saveSessions();
        sendWs({ type: 'session_init', sessionKey: key, sessionId: event.session_id });
      }
      break;
    case 'assistant':
      for (const block of event.message?.content ?? []) {
        if (block.type === 'text') {
          setResponse(claudeResponseText + block.text);
          const tokEvent = { type: 'token', text: block.text, sessionKey: key };
          sendWs(tokEvent);
          if (session.liveBuffer) { session.liveBuffer.push(tokEvent); if (session.liveBuffer.length > 300) session.liveBuffer.shift(); }
        } else if (block.type === 'tool_use') {
          const toolEvent = { type: 'tool_use', name: block.name, input: block.input, id: block.id, sessionKey: key };
          sendWs(toolEvent);
          if (session.liveBuffer) { session.liveBuffer.push(toolEvent); if (session.liveBuffer.length > 300) session.liveBuffer.shift(); }
        }
      }
      break;
    case 'user':
      // Capture tool results to show in expanded pills
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_result') {
          const rawContent = Array.isArray(block.content)
            ? block.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
            : String(block.content || '');
          const resultEvent = {
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: rawContent.slice(0, 800),
            sessionKey: key,
          };
          sendWs(resultEvent);
          if (session.liveBuffer) { session.liveBuffer.push(resultEvent); if (session.liveBuffer.length > 300) session.liveBuffer.shift(); }
        }
      }
      break;
    case 'result':
      if (event.usage) {
        sendWs({ type: 'usage', inputTokens: event.usage.input_tokens || 0, outputTokens: event.usage.output_tokens || 0, contextLimit: 200000, sessionKey: key });
      }
      sendWs({ type: 'done', subtype: event.subtype, sessionKey: key });
      break;
  }
}

function transcribeAudio(base64Audio, mimeType) {
  return new Promise((resolve, reject) => {
    if (!OPENAI_KEY) return reject(new Error('No OpenAI key configured'));
    const audioBuffer = Buffer.from(base64Audio, 'base64');
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const ext = mimeType.includes('mp4') ? 'm4a' : 'webm';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${ext}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
      audioBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    const req = https.request({
      hostname: 'api.openai.com', path: '/v1/audio/transcriptions', method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { const p=JSON.parse(data); if(p.text) resolve(p.text); else reject(new Error(p.error?.message||'failed')); }
        catch(e) { reject(new Error('Parse error')); }
      });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n🚀 Claude Code Mobile');
  console.log(`   Port:       ${PORT}`);
  console.log(`   Password:   ${'*'.repeat((PASSWORD || '').length)} (set in .env)`);
  console.log(`   Voice:      ${OPENAI_KEY ? '✅ Whisper enabled' : '❌ No OpenAI key'}\n`);
});

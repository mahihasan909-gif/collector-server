const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 4000;
const API_KEY = process.env.API_KEY || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const ALLOWED_DEPT = process.env.ALLOWED_DEPT_CODE || '60'; // e.g. 60 = CSE; empty = allow all
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

if (!API_KEY || !ADMIN_KEY) {
  console.error(
    'Refusing to start with no auth configured. Set API_KEY and ADMIN_KEY env vars before running ' +
      '(anyone on the network could otherwise read/write student data). Example:\n' +
      '  set API_KEY=some-secret\n  set ADMIN_KEY=some-other-secret\n  npm start'
  );
  process.exit(1);
}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '10mb' }));

function studentDir(id) {
  const dir = path.join(DATA_DIR, safeName(id));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeName(name) {
  return String(name).replace(/[^a-zA-Z0-9_-]/g, '_');
}

const CODE_CSV_COLUMNS = [
  'studentId', 'deptCode', 'sessionId', 'machineId', 'loginAt', 'logoutAt',
  'file', 'language', 'eventCount', 'keystrokeCount', 'pasteBurstCount',
  'autoFormatCount', 'addedCharsTotal', 'removedCharsTotal', 'idleEventCount',
  'tabSwitchCount', 'code'
];

function csvEscape(v) {
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function buildCodeCsv(pkg) {
  const events = pkg.events || [];
  const files = pkg.files || [];
  const rows = [CODE_CSV_COLUMNS.join(',')];
  for (const f of files) {
    const fileEvents = events.filter((e) => e.file === f.path);
    let addedCharsTotal = 0, removedCharsTotal = 0, keystrokeCount = 0;
    let pasteBurstCount = 0, autoFormatCount = 0, idleEventCount = 0, tabSwitchCount = 0;
    for (const e of fileEvents) {
      const d = e.data || {};
      if (typeof d.addedChars === 'number') addedCharsTotal += d.addedChars;
      if (typeof d.removedChars === 'number') removedCharsTotal += d.removedChars;
      if (e.type === 'keystroke') keystrokeCount++;
      if (e.type === 'paste_burst') pasteBurstCount++;
      if (e.type === 'auto_format') autoFormatCount++;
      if (e.type === 'idle_start') idleEventCount++;
      if (e.type === 'tab_switch') tabSwitchCount++;
    }
    rows.push([
      csvEscape(pkg.studentId), csvEscape(pkg.deptCode || ''), csvEscape(pkg.sessionId),
      csvEscape(pkg.machineId), pkg.loginAt, pkg.logoutAt, csvEscape(f.path), csvEscape(f.language),
      fileEvents.length, keystrokeCount, pasteBurstCount, autoFormatCount,
      addedCharsTotal, removedCharsTotal, idleEventCount, tabSwitchCount, csvEscape(f.content)
    ].join(','));
  }
  return rows.join('\n');
}

// --- extension upload: one full session package per login/logout cycle ---
app.post('/session', (req, res) => {
  if (API_KEY && req.header('X-API-Key') !== API_KEY) {
    return res.status(401).json({ error: 'bad api key' });
  }
  const pkg = req.body;
  if (!pkg || !pkg.studentId || !pkg.sessionId) {
    return res.status(400).json({ error: 'studentId and sessionId required' });
  }
  if (ALLOWED_DEPT && pkg.deptCode !== ALLOWED_DEPT) {
    return res.status(403).json({ error: `dept code ${pkg.deptCode} not accepted here (expected ${ALLOWED_DEPT})` });
  }

  const dir = studentDir(pkg.studentId);
  fs.writeFileSync(path.join(dir, `${safeName(pkg.sessionId)}.json`), JSON.stringify(pkg), 'utf8');
  fs.writeFileSync(path.join(dir, `${safeName(pkg.sessionId)}_code.csv`), buildCodeCsv(pkg), 'utf8');

  const indexPath = path.join(dir, 'index.json');
  const index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : [];
  index.push({
    sessionId: pkg.sessionId,
    deptCode: pkg.deptCode || '',
    machineId: pkg.machineId,
    loginAt: pkg.loginAt,
    logoutAt: pkg.logoutAt,
    eventCount: (pkg.events || []).length,
    fileCount: (pkg.files || []).length
  });
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');

  res.json({ ok: true });
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// --- admin/teacher panel: simple cookie-based login, no key-in-URL needed ---
const COOKIE_NAME = 'tracker_admin';
const sessions = new Set();

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  });
  return out;
}

function isAuthed(req) {
  const cookies = parseCookies(req);
  return Boolean(cookies[COOKIE_NAME] && sessions.has(cookies[COOKIE_NAME]));
}

function checkAdmin(req, res, next) {
  if (isAuthed(req) || req.query.key === ADMIN_KEY) return next();
  res.status(401).json({ error: 'not logged in' });
}

app.post('/admin/login', (req, res) => {
  const password = (req.body && req.body.password) || '';
  if (password !== ADMIN_KEY) {
    return res.status(401).json({ error: 'wrong password' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  sessions.add(token);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=43200; SameSite=Lax`);
  res.json({ ok: true });
});

app.post('/admin/logout', (req, res) => {
  const cookies = parseCookies(req);
  sessions.delete(cookies[COOKIE_NAME]);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/students', checkAdmin, (req, res) => {
  const ids = fs.readdirSync(DATA_DIR).filter((f) => fs.statSync(path.join(DATA_DIR, f)).isDirectory());
  let students = ids.map((id) => {
    const indexPath = path.join(DATA_DIR, id, 'index.json');
    const sessions = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : [];
    return {
      studentId: id,
      deptCode: sessions.length ? sessions[sessions.length - 1].deptCode || '' : '',
      sessionCount: sessions.length,
      lastActivity: sessions.length ? Math.max(...sessions.map((s) => s.logoutAt || 0)) : 0
    };
  });
  if (req.query.dept) {
    students = students.filter((s) => s.deptCode === req.query.dept);
  }
  res.json(students);
});

app.get('/api/students/:id/sessions', checkAdmin, (req, res) => {
  const indexPath = path.join(DATA_DIR, safeName(req.params.id), 'index.json');
  res.json(fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : []);
});

app.get('/api/students/:id/sessions/:sessionId', checkAdmin, (req, res) => {
  const file = path.join(DATA_DIR, safeName(req.params.id), `${safeName(req.params.sessionId)}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'not found' });
  res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
});

app.get('/api/students/:id/sessions/:sessionId/csv', checkAdmin, (req, res) => {
  const file = path.join(DATA_DIR, safeName(req.params.id), `${safeName(req.params.sessionId)}_code.csv`);
  if (!fs.existsSync(file)) return res.status(404).send('not found');
  res.download(file);
});

app.get('/api/download-all', checkAdmin, (req, res) => {
  const ids = fs.readdirSync(DATA_DIR).filter((f) => fs.statSync(path.join(DATA_DIR, f)).isDirectory());
  const parts = [CODE_CSV_COLUMNS.join(',')];
  for (const id of ids) {
    const dir = path.join(DATA_DIR, id);
    const csvFiles = fs.readdirSync(dir).filter((f) => f.endsWith('_code.csv'));
    for (const cf of csvFiles) {
      const lines = fs.readFileSync(path.join(dir, cf), 'utf8').split('\n');
      parts.push(...lines.slice(1).filter(Boolean));
    }
  }
  res.setHeader('Content-Disposition', 'attachment; filename="all_students_dataset.csv"');
  res.type('text/csv').send(parts.join('\n'));
});

app.get('/admin', (_req, res) => {
  res.type('html').send(ADMIN_HTML.replace('__DEFAULT_DEPT__', ALLOWED_DEPT));
});

const ADMIN_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Student Tracker Admin</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;display:flex;height:100vh;background:#0f1115;color:#e6e6e6}
.col{overflow-y:auto;padding:12px;box-sizing:border-box}
#students{width:220px;border-right:1px solid #2a2d34}
#sessions{width:260px;border-right:1px solid #2a2d34}
#detail{flex:1}
h2{font-size:14px;text-transform:uppercase;color:#8a8f98;margin:0 0 8px}
.item{padding:8px;border-radius:6px;cursor:pointer;margin-bottom:4px;font-size:13px}
.item:hover{background:#1c1f26}
.item.active{background:#2b3a55}
pre{background:#1c1f26;padding:10px;border-radius:6px;overflow:auto;font-size:12px;max-height:300px}
.file{margin-bottom:14px}
.file h3{font-size:12px;color:#8a8f98;margin:0 0 4px}
.badge{display:inline-block;background:#2b3a55;border-radius:10px;padding:1px 8px;font-size:11px;margin-left:6px}
#deptFilter{width:100%;box-sizing:border-box;margin-bottom:8px;padding:6px;background:#1c1f26;border:1px solid #2a2d34;color:#e6e6e6;border-radius:6px}
button{background:#2b3a55;color:#e6e6e6;border:1px solid #3a4a6b;border-radius:6px;padding:6px 10px;font-size:12px;cursor:pointer;margin-bottom:8px}
button:hover{background:#35476b}
.session-row{display:flex;align-items:center;justify-content:space-between}
.session-row .dl{font-size:11px;color:#8fb8ff;text-decoration:none;margin-left:6px}
#loginScreen{position:fixed;inset:0;background:#0f1115;display:flex;align-items:center;justify-content:center;flex-direction:column;z-index:10}
#loginScreen h1{font-size:20px;margin-bottom:16px}
#loginScreen input{padding:10px;width:260px;background:#1c1f26;border:1px solid #2a2d34;color:#e6e6e6;border-radius:6px;margin-bottom:10px;font-size:14px}
#loginScreen button{width:260px;padding:10px}
#loginError{color:#ff6b6b;font-size:12px;height:16px;margin-bottom:6px}
#app{display:none}
</style></head>
<body>
<div id="loginScreen">
  <h1>Student Tracker &mdash; Teacher Login</h1>
  <div id="loginError"></div>
  <input id="loginPassword" type="password" placeholder="Admin password" autofocus />
  <button id="loginBtn">Login</button>
</div>
<div id="app">
<div class="col" id="students"><h2>Students</h2>
  <input id="deptFilter" placeholder="Dept code filter (blank = all)" value="__DEFAULT_DEPT__" />
  <button id="downloadAllBtn">Download All (CSV)</button>
  <button id="logoutBtn">Logout</button>
  <div id="studentList"></div>
</div>
<div class="col" id="sessions"><h2>Sessions</h2><div id="sessionList"></div></div>
<div class="col" id="detail"><h2>Detail</h2><div id="detailBody">Select a student → session.</div></div>
</div>
<script>
async function j(url){
  const r = await fetch(url);
  if (r.status === 401) { showLogin(); throw new Error('unauthorized'); }
  return r.json();
}

function showLogin(){
  document.getElementById('app').style.display = 'none';
  document.getElementById('loginScreen').style.display = 'flex';
}
function showApp(){
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  loadStudents();
}

document.getElementById('loginBtn').onclick = doLogin;
document.getElementById('loginPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

async function doLogin(){
  const password = document.getElementById('loginPassword').value;
  const r = await fetch('/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  });
  if (r.ok) { document.getElementById('loginError').textContent = ''; showApp(); }
  else { document.getElementById('loginError').textContent = 'Wrong password.'; }
}

document.getElementById('logoutBtn').onclick = async () => {
  await fetch('/admin/logout', { method: 'POST' });
  showLogin();
};

async function loadStudents(){
  const dept = document.getElementById('deptFilter').value.trim();
  const url = '/api/students?dept=' + encodeURIComponent(dept);
  const students = await j(url);
  const el = document.getElementById('studentList');
  el.innerHTML = '';
  students.forEach(s => {
    const d = document.createElement('div');
    d.className = 'item';
    d.textContent = s.studentId;
    d.innerHTML += '<span class="badge">dept ' + (s.deptCode || '?') + '</span>';
    d.innerHTML += '<span class="badge">' + s.sessionCount + '</span>';
    d.onclick = () => { document.querySelectorAll('#studentList .item').forEach(x=>x.classList.remove('active')); d.classList.add('active'); loadSessions(s.studentId); };
    el.appendChild(d);
  });
}
document.getElementById('deptFilter').addEventListener('input', loadStudents);
document.getElementById('downloadAllBtn').onclick = () => {
  window.location.href = '/api/download-all';
};

async function loadSessions(studentId){
  const sessions = await j('/api/students/' + encodeURIComponent(studentId) + '/sessions');
  const el = document.getElementById('sessionList');
  el.innerHTML = '';
  sessions.forEach(s => {
    const d = document.createElement('div');
    d.className = 'item session-row';
    const started = new Date(s.loginAt).toLocaleString();
    const left = document.createElement('span');
    left.textContent = started;
    left.innerHTML += '<div class="badge">' + s.eventCount + ' events</div>';
    left.onclick = () => { document.querySelectorAll('#sessionList .item').forEach(x=>x.classList.remove('active')); d.classList.add('active'); loadDetail(studentId, s.sessionId); };
    const dl = document.createElement('a');
    dl.className = 'dl';
    dl.textContent = 'CSV';
    dl.href = '/api/students/' + encodeURIComponent(studentId) + '/sessions/' + encodeURIComponent(s.sessionId) + '/csv';
    d.appendChild(left);
    d.appendChild(dl);
    el.appendChild(d);
  });
}

async function loadDetail(studentId, sessionId){
  const pkg = await j('/api/students/' + encodeURIComponent(studentId) + '/sessions/' + encodeURIComponent(sessionId));
  const el = document.getElementById('detailBody');
  let html = '<p>Session ' + pkg.sessionId + ' — ' + pkg.events.length + ' events, ' + pkg.files.length + ' files</p>';
  html += '<h2>Code Files</h2>';
  pkg.files.forEach(f => {
    html += '<div class="file"><h3>' + f.path + ' (' + f.language + ')</h3><pre>' + escapeHtml(f.content) + '</pre></div>';
  });
  html += '<h2>Event Log</h2><pre>' + escapeHtml(JSON.stringify(pkg.events, null, 2)) + '</pre>';
  el.innerHTML = html;
}

function escapeHtml(s){ return s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

fetch('/api/students').then(r => { if (r.ok) showApp(); }).catch(() => {});
</script>
</body></html>`;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Collector server listening on :${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin  (login with the ADMIN_KEY password)`);
});

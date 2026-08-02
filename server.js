const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { MongoClient } = require('mongodb');

const PORT = process.env.PORT || 4000;
const API_KEY = process.env.API_KEY || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const ALLOWED_DEPT = process.env.ALLOWED_DEPT_CODE || '60'; // e.g. 60 = CSE; empty = allow all
const MONGODB_URI = process.env.MONGODB_URI || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free';

if (!API_KEY || !ADMIN_KEY) {
  console.error(
    'Refusing to start with no auth configured. Set API_KEY and ADMIN_KEY env vars before running ' +
      '(anyone on the network could otherwise read/write student data). Example:\n' +
      '  set API_KEY=some-secret\n  set ADMIN_KEY=some-other-secret\n  npm start'
  );
  process.exit(1);
}

if (!MONGODB_URI) {
  console.error(
    'Refusing to start with no MONGODB_URI set. Create a free MongoDB Atlas cluster and set ' +
      'MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/?retryWrites=true&w=majority'
  );
  process.exit(1);
}

let sessionsCol;
let resultsCol;
let roomsCol;

async function connectDb() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db('student_tracker');
  sessionsCol = db.collection('sessions');
  resultsCol = db.collection('results');
  roomsCol = db.collection('rooms');
  await sessionsCol.createIndex({ studentId: 1, sessionId: 1 }, { unique: true });
  await resultsCol.createIndex({ studentId: 1 }, { unique: true });
  await roomsCol.createIndex({ roomName: 1 }, { unique: true });
  await roomsCol.createIndex({ studentIds: 1 });
  console.log('Connected to MongoDB.');
}

async function isStudentAllowed(studentId) {
  const room = await roomsCol.findOne({ studentIds: studentId });
  return Boolean(room);
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

function buildCodeCsvRows(pkg) {
  const events = pkg.events || [];
  const files = pkg.files || [];
  const rows = [];
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
  return rows;
}

function buildCodeCsv(pkg) {
  return [CODE_CSV_COLUMNS.join(','), ...buildCodeCsvRows(pkg)].join('\n');
}

// --- OpenRouter (free tier) helper ---
async function callAi(prompt) {
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not configured on server');
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENROUTER_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`OpenRouter API error ${r.status}: ${t.slice(0, 300)}`);
  }
  const data = await r.json();
  return data?.choices?.[0]?.message?.content || '';
}

function summarizeStudentForAi(sessions) {
  let totalKeystrokes = 0, totalPaste = 0, totalAutoFormat = 0, totalIdle = 0, totalTabSwitch = 0;
  const fileSummaries = [];
  for (const s of sessions) {
    const events = s.events || [];
    for (const f of (s.files || [])) {
      const fileEvents = events.filter((e) => e.file === f.path);
      let keystrokes = 0, paste = 0, autoFormat = 0, idle = 0, tabSwitch = 0;
      for (const e of fileEvents) {
        if (e.type === 'keystroke') keystrokes++;
        if (e.type === 'paste_burst') paste++;
        if (e.type === 'auto_format') autoFormat++;
        if (e.type === 'idle_start') idle++;
        if (e.type === 'tab_switch') tabSwitch++;
      }
      totalKeystrokes += keystrokes; totalPaste += paste; totalAutoFormat += autoFormat;
      totalIdle += idle; totalTabSwitch += tabSwitch;
      fileSummaries.push(
        `File: ${f.path} (${f.language})\nKeystrokes: ${keystrokes}, PasteBursts: ${paste}, AutoFormats: ${autoFormat}, IdleEvents: ${idle}, TabSwitches: ${tabSwitch}\nCode (truncated):\n${(f.content || '').slice(0, 4000)}\n---`
      );
    }
  }
  return {
    totals: { totalKeystrokes, totalPaste, totalAutoFormat, totalIdle, totalTabSwitch, sessionCount: sessions.length },
    fileSummaries
  };
}

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// --- extension upload: one full session package per login/logout cycle ---
app.post('/session', async (req, res) => {
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
  if (!(await isStudentAllowed(pkg.studentId))) {
    return res.status(403).json({ error: 'this student ID is not on any active room roster' });
  }

  await sessionsCol.updateOne(
    { studentId: pkg.studentId, sessionId: pkg.sessionId },
    { $set: pkg },
    { upsert: true }
  );

  res.json({ ok: true });
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// --- admin/teacher panel: simple cookie-based login, no key-in-URL needed ---
const COOKIE_NAME = 'tracker_admin';
const adminSessions = new Set();

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
  return Boolean(cookies[COOKIE_NAME] && adminSessions.has(cookies[COOKIE_NAME]));
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
  adminSessions.add(token);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=43200; SameSite=Lax`);
  res.json({ ok: true });
});

app.post('/admin/logout', (req, res) => {
  const cookies = parseCookies(req);
  adminSessions.delete(cookies[COOKIE_NAME]);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/students', checkAdmin, async (req, res) => {
  const docs = await sessionsCol
    .find({}, { projection: { studentId: 1, deptCode: 1, logoutAt: 1 } })
    .toArray();
  const byId = new Map();
  for (const d of docs) {
    const cur = byId.get(d.studentId) || { studentId: d.studentId, deptCode: d.deptCode || '', sessionCount: 0, lastActivity: 0 };
    cur.sessionCount++;
    cur.deptCode = d.deptCode || cur.deptCode;
    cur.lastActivity = Math.max(cur.lastActivity, d.logoutAt || 0);
    byId.set(d.studentId, cur);
  }
  let students = Array.from(byId.values());
  if (req.query.dept) {
    students = students.filter((s) => s.deptCode === req.query.dept);
  }
  res.json(students);
});

app.get('/api/students/:id/sessions', checkAdmin, async (req, res) => {
  const docs = await sessionsCol
    .find({ studentId: req.params.id })
    .sort({ loginAt: -1 })
    .toArray();
  const out = docs.map((d) => ({
    sessionId: d.sessionId,
    deptCode: d.deptCode || '',
    machineId: d.machineId,
    loginAt: d.loginAt,
    logoutAt: d.logoutAt,
    eventCount: (d.events || []).length,
    fileCount: (d.files || []).length
  }));
  res.json(out);
});

app.get('/api/students/:id/sessions/:sessionId', checkAdmin, async (req, res) => {
  const doc = await sessionsCol.findOne({ studentId: req.params.id, sessionId: req.params.sessionId });
  if (!doc) return res.status(404).json({ error: 'not found' });
  res.json(doc);
});

app.get('/api/students/:id/sessions/:sessionId/csv', checkAdmin, async (req, res) => {
  const doc = await sessionsCol.findOne({ studentId: req.params.id, sessionId: req.params.sessionId });
  if (!doc) return res.status(404).send('not found');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName(req.params.id)}_${safeName(req.params.sessionId)}_code.csv"`);
  res.type('text/csv').send(buildCodeCsv(doc));
});

app.get('/api/download-all', checkAdmin, async (req, res) => {
  const docs = await sessionsCol.find({}).toArray();
  const parts = [CODE_CSV_COLUMNS.join(',')];
  for (const doc of docs) {
    parts.push(...buildCodeCsvRows(doc));
  }
  res.setHeader('Content-Disposition', 'attachment; filename="all_students_dataset.csv"');
  res.type('text/csv').send(parts.join('\n'));
});

// --- rooms: whitelist of student IDs allowed to use extension + student panel ---

app.get('/admin/rooms', checkAdmin, async (req, res) => {
  const rooms = await roomsCol.find({}).toArray();
  res.json(rooms.map((r) => ({ roomName: r.roomName, studentIds: r.studentIds || [], createdAt: r.createdAt })));
});

app.post('/admin/rooms', checkAdmin, async (req, res) => {
  const roomName = (req.body?.roomName || '').toString().trim();
  if (!roomName) return res.status(400).json({ error: 'roomName required' });
  const ids = parseIdList(req.body?.studentIds);
  try {
    await roomsCol.insertOne({ roomName, studentIds: ids, createdAt: Date.now() });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'room already exists' });
    throw err;
  }
  res.json({ ok: true });
});

app.post('/admin/rooms/:roomName/students', checkAdmin, async (req, res) => {
  const roomName = req.params.roomName;
  const ids = parseIdList(req.body?.studentIds);
  if (!ids.length) return res.status(400).json({ error: 'studentIds required' });
  const result = await roomsCol.updateOne({ roomName }, { $addToSet: { studentIds: { $each: ids } } });
  if (!result.matchedCount) return res.status(404).json({ error: 'room not found' });
  res.json({ ok: true });
});

app.delete('/admin/rooms/:roomName/students/:studentId', checkAdmin, async (req, res) => {
  await roomsCol.updateOne({ roomName: req.params.roomName }, { $pull: { studentIds: req.params.studentId } });
  res.json({ ok: true });
});

app.delete('/admin/rooms/:roomName', checkAdmin, async (req, res) => {
  await roomsCol.deleteOne({ roomName: req.params.roomName });
  res.json({ ok: true });
});

// Danger zone: wipe all collected session/result data for every student ID in this room.
// The room roster itself (allowed IDs) is left intact.
app.delete('/admin/rooms/:roomName/data', checkAdmin, async (req, res) => {
  const room = await roomsCol.findOne({ roomName: req.params.roomName });
  if (!room) return res.status(404).json({ error: 'room not found' });
  const ids = room.studentIds || [];
  const sessRes = await sessionsCol.deleteMany({ studentId: { $in: ids } });
  const resRes = await resultsCol.deleteMany({ studentId: { $in: ids } });
  res.json({ ok: true, deletedSessions: sessRes.deletedCount, deletedResults: resRes.deletedCount });
});

function parseIdList(input) {
  if (Array.isArray(input)) return input.map((s) => String(s).trim()).filter(Boolean);
  if (typeof input === 'string') return input.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

// --- AI-generated + manual feedback/result per student ---

app.post('/admin/ai-generate/:studentId', checkAdmin, async (req, res) => {
  const studentId = req.params.studentId;
  const sessions = await sessionsCol.find({ studentId }).sort({ loginAt: -1 }).toArray();
  if (!sessions.length) return res.status(404).json({ error: 'no sessions for this student' });

  const { totals, fileSummaries } = summarizeStudentForAi(sessions);
  const prompt =
    `You are a programming instructor's assistant helping evaluate a CSE student's coding activity ` +
    `for signs of good/bad practice and possible AI-assistance overuse, based on keystroke telemetry ` +
    `and their code.\n\nActivity totals across ${totals.sessionCount} sessions: ${JSON.stringify(totals)}\n\n` +
    `Per-file details:\n${fileSummaries.join('\n')}\n\n` +
    `Write a short, constructive feedback report (150-250 words) for the STUDENT to read, covering: ` +
    `(1) what they're doing well, (2) specific areas to improve (coding habits, patterns, testing, etc.), ` +
    `(3) if paste-burst/auto-format counts look unusually high relative to keystrokes, gently note it as ` +
    `something to be mindful of without accusing them of cheating. Be encouraging and specific, not generic. ` +
    `Do not include a numeric score.`;

  let aiFeedback;
  try {
    aiFeedback = await callAi(prompt);
  } catch (err) {
    return res.status(502).json({ error: String(err.message || err) });
  }

  await resultsCol.updateOne(
    { studentId },
    { $set: { studentId, aiFeedback, aiGeneratedAt: Date.now() } },
    { upsert: true }
  );
  res.json({ ok: true, aiFeedback });
});

app.get('/admin/result/:studentId', checkAdmin, async (req, res) => {
  const doc = await resultsCol.findOne({ studentId: req.params.studentId });
  res.json(doc || { studentId: req.params.studentId });
});

app.post('/admin/result/:studentId', checkAdmin, async (req, res) => {
  const studentId = req.params.studentId;
  const { feedback, published } = req.body || {};
  const update = { studentId, finalFeedback: feedback ?? '', updatedAt: Date.now() };
  if (published !== undefined) update.published = Boolean(published);
  if (published === true) update.publishedAt = Date.now();
  await resultsCol.updateOne({ studentId }, { $set: update }, { upsert: true });
  const doc = await resultsCol.findOne({ studentId });
  res.json(doc);
});

// --- student-facing endpoints (ID only, no password) ---

app.get('/student/result', async (req, res) => {
  const studentId = (req.query.studentId || '').toString().trim();
  if (!studentId) return res.status(400).json({ error: 'studentId required' });
  if (!(await isStudentAllowed(studentId))) return res.status(403).json({ error: 'this student ID is not on any active room roster' });
  const exists = await sessionsCol.findOne({ studentId }, { projection: { _id: 1 } });
  if (!exists) return res.status(404).json({ error: 'no such student id on record' });
  const result = await resultsCol.findOne({ studentId });
  if (!result || !result.published) {
    return res.json({ studentId, published: false, feedback: null });
  }
  res.json({ studentId, published: true, feedback: result.finalFeedback || '', updatedAt: result.updatedAt });
});

// Full student dashboard: room membership, session list, published feedback (used by /student page login).
app.get('/student/me', async (req, res) => {
  const studentId = (req.query.studentId || '').toString().trim();
  if (!studentId) return res.status(400).json({ error: 'studentId required' });
  const room = await roomsCol.findOne({ studentIds: studentId });
  if (!room) return res.status(403).json({ error: 'This student ID is not on any active room roster. Ask your instructor to add you.' });

  const sessions = await sessionsCol.find({ studentId }).sort({ loginAt: -1 }).toArray();
  const result = await resultsCol.findOne({ studentId });

  res.json({
    studentId,
    roomName: room.roomName,
    sessions: sessions.map((s) => ({
      sessionId: s.sessionId,
      loginAt: s.loginAt,
      logoutAt: s.logoutAt,
      fileCount: (s.files || []).length,
      eventCount: (s.events || []).length
    })),
    published: Boolean(result && result.published),
    feedback: result && result.published ? result.finalFeedback || '' : null
  });
});

// A single one of the student's own sessions, with their code files (read-only, no admin auth needed —
// gated by room membership, same as /student/me).
app.get('/student/sessions/:sessionId', async (req, res) => {
  const studentId = (req.query.studentId || '').toString().trim();
  if (!studentId) return res.status(400).json({ error: 'studentId required' });
  if (!(await isStudentAllowed(studentId))) return res.status(403).json({ error: 'not allowed' });
  const doc = await sessionsCol.findOne({ studentId, sessionId: req.params.sessionId });
  if (!doc) return res.status(404).json({ error: 'not found' });
  res.json({
    sessionId: doc.sessionId,
    loginAt: doc.loginAt,
    logoutAt: doc.logoutAt,
    files: (doc.files || []).map((f) => ({ path: f.path, language: f.language, content: f.content }))
  });
});

app.post('/student/ai-hint', async (req, res) => {
  const { studentId, question } = req.body || {};
  const id = (studentId || '').toString().trim();
  const q = (question || '').toString().trim();
  if (!id || !q) return res.status(400).json({ error: 'studentId and question required' });
  if (!(await isStudentAllowed(id))) return res.status(403).json({ error: 'this student ID is not on any active room roster' });
  const exists = await sessionsCol.findOne({ studentId: id }, { projection: { _id: 1 } });
  if (!exists) return res.status(404).json({ error: 'no such student id on record' });

  const sessions = await sessionsCol.find({ studentId: id }).sort({ loginAt: -1 }).limit(3).toArray();
  const { fileSummaries } = summarizeStudentForAi(sessions);
  const prompt =
    `You are a friendly programming tutor helping a CSE student. You must NEVER write or output actual ` +
    `code, code snippets, or fixed versions of their code — only give conceptual hints, advice, questions ` +
    `to think about, and pointers to concepts/documentation. If the student asks for code directly, politely ` +
    `decline and redirect them to figure it out with hints instead.\n\n` +
    `Some of the student's recent code (for context only, do not repeat it back or fix it):\n` +
    `${fileSummaries.slice(0, 3).join('\n').slice(0, 6000)}\n\n` +
    `Student's question: ${q}\n\nGive a short, encouraging, hint-only answer (max 150 words).`;

  try {
    const answer = await callAi(prompt);
    res.json({ answer });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

app.get('/admin', (_req, res) => {
  res.type('html').send(ADMIN_HTML.replace('__DEFAULT_DEPT__', ALLOWED_DEPT));
});

app.get('/student', (_req, res) => {
  res.type('html').send(STUDENT_HTML);
});

const STUDENT_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Student Portal &mdash; East West University</title>
<style>
:root{--navy:#1b2a57;--navy-dark:#111c3e;--navy-light:#2e4080;--bg:#eef1f8;--card:#ffffff;--border:#dde3f0;--text:#1a1f36;--muted:#6b7280}
*{box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,sans-serif;margin:0;min-height:100vh;background:var(--bg);color:var(--text)}
header{background:linear-gradient(120deg,var(--navy-dark),var(--navy));padding:14px 28px;display:flex;align-items:center;gap:14px;box-shadow:0 2px 10px rgba(0,0,0,.15)}
header img{height:42px}
header .title{color:#fff;flex:1}
header .title h1{font-size:15px;margin:0;font-weight:600}
header .title span{font-size:10px;color:#c6cff0;letter-spacing:.5px}
header #logoutBtn{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.25);display:none}
header #logoutBtn:hover{background:rgba(255,255,255,.22)}
main{display:flex;justify-content:center;padding:36px 16px}
.wrap{width:100%;max-width:420px;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:28px;box-shadow:0 6px 24px rgba(27,42,87,.08)}
.dash{width:100%;max-width:820px}
h2{font-size:18px;margin:0 0 18px;color:var(--navy)}
h3{font-size:13px;text-transform:uppercase;letter-spacing:.4px;color:var(--muted);margin:0 0 10px;font-weight:700}
input{padding:11px 12px;width:100%;box-sizing:border-box;background:#f7f9fd;border:1px solid var(--border);color:var(--text);border-radius:8px;margin-bottom:12px;font-size:14px}
input:focus{outline:2px solid var(--navy-light);border-color:transparent}
button{background:var(--navy);color:#fff;border:none;border-radius:8px;padding:10px 16px;font-size:13px;cursor:pointer;font-weight:600;transition:background .15s}
button:hover{background:var(--navy-light)}
#loginStatus{font-size:12px;color:#c0392b;margin-bottom:6px;min-height:16px}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:22px;margin-bottom:18px;box-shadow:0 4px 16px rgba(27,42,87,.06)}
.badge{display:inline-block;background:var(--navy);color:#fff;border-radius:10px;padding:2px 10px;font-size:11px;margin-left:8px;font-weight:600}
#feedbackBox{white-space:pre-wrap;line-height:1.6;font-size:14px;background:#f7f9fd;border:1px solid var(--border);border-radius:10px;padding:16px}
.sessRow{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-radius:8px;cursor:pointer;border:1px solid var(--border);margin-bottom:8px;font-size:13px}
.sessRow:hover{background:#f1f4fb}
.sessRow.active{background:#e3e9fb;border-color:var(--navy-light)}
.file{margin-bottom:16px}
.file h4{font-size:12px;color:var(--muted);margin:0 0 6px}
pre{background:#f7f9fd;border:1px solid var(--border);padding:12px;border-radius:8px;overflow:auto;font-size:12px;max-height:340px}
#chatLog{background:#f7f9fd;border:1px solid var(--border);border-radius:8px;padding:10px;min-height:80px;max-height:300px;overflow-y:auto;font-size:13px;margin-bottom:8px}
.msg{margin-bottom:10px}
.msg.me{color:var(--navy)}
.msg.ai{color:var(--text)}
#chatRow{display:flex;gap:8px}
#chatInput{flex:1;margin-bottom:0}
#aiFab{position:fixed;right:26px;bottom:26px;width:58px;height:58px;border-radius:50%;background:linear-gradient(135deg,var(--navy),var(--navy-light));border:none;color:#fff;font-size:24px;cursor:pointer;box-shadow:0 6px 18px rgba(27,42,87,.4);z-index:20}
#aiFab:hover{filter:brightness(1.15)}
#aiModalOverlay{display:none;position:fixed;inset:0;background:rgba(17,28,62,.45);z-index:21;align-items:center;justify-content:center}
#aiModal{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:20px;width:480px;max-width:90vw;max-height:80vh;overflow-y:auto;box-sizing:border-box;box-shadow:0 10px 40px rgba(0,0,0,.25)}
#aiModal h2{margin:0 0 6px;font-size:16px}
#aiModalClose{float:right;cursor:pointer;color:var(--muted);font-size:18px}
#aiHint{font-size:12px;color:var(--muted);margin-bottom:12px}
</style></head>
<body>
<header>
  <img src="/assets/ewu-logo.png" alt="East West University" />
  <div class="title"><h1>Student Portal</h1><span id="headerSub">EAST WEST UNIVERSITY</span></div>
  <button id="logoutBtn">Switch ID</button>
</header>

<main>
<div id="loginView" class="wrap">
  <h2>Student Login</h2>
  <div id="loginStatus"></div>
  <input id="studentId" placeholder="Your student ID (e.g. 2023-1-60-053)" />
  <button id="loadBtn">Login</button>
</div>

<div id="dashView" class="dash" style="display:none">
  <div class="card">
    <h3>Feedback &amp; Result</h3>
    <div id="feedbackBox">Loading...</div>
  </div>
  <div class="card" style="display:flex;gap:24px;flex-wrap:wrap">
    <div style="flex:1;min-width:240px">
      <h3>Your Sessions</h3>
      <div id="sessionList"></div>
    </div>
    <div style="flex:2;min-width:280px">
      <h3>Code</h3>
      <div id="codeView">Select a session to view your code.</div>
    </div>
  </div>
</div>
</main>

<button id="aiFab" title="Ask the AI helper">&#10024;</button>
<div id="aiModalOverlay">
  <div id="aiModal">
    <span id="aiModalClose">&times;</span>
    <h2>Ask the AI helper</h2>
    <div id="aiHint">Hints only &mdash; it will not write code for you.</div>
    <div id="chatLog"></div>
    <div id="chatRow">
      <input id="chatInput" placeholder="e.g. Why is my loop running forever?" />
      <button id="chatBtn">Ask</button>
    </div>
  </div>
</div>

<script>
let sid = '';

document.getElementById('aiFab').onclick = () => {
  document.getElementById('aiModalOverlay').style.display = 'flex';
};
document.getElementById('aiModalClose').onclick = () => {
  document.getElementById('aiModalOverlay').style.display = 'none';
};
document.getElementById('aiModalOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'aiModalOverlay') document.getElementById('aiModalOverlay').style.display = 'none';
});

document.getElementById('loadBtn').onclick = login;
document.getElementById('studentId').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
document.getElementById('logoutBtn').onclick = () => {
  sid = '';
  document.getElementById('dashView').style.display = 'none';
  document.getElementById('loginView').style.display = 'block';
  document.getElementById('logoutBtn').style.display = 'none';
  document.getElementById('headerSub').textContent = 'EAST WEST UNIVERSITY';
  document.getElementById('studentId').value = '';
  document.getElementById('loginStatus').textContent = '';
};

async function login(){
  const id = document.getElementById('studentId').value.trim();
  const statusEl = document.getElementById('loginStatus');
  if (!id) { statusEl.textContent = 'Enter your student ID.'; return; }
  statusEl.textContent = 'Checking...';
  const r = await fetch('/student/me?studentId=' + encodeURIComponent(id));
  const data = await r.json();
  if (!r.ok) {
    statusEl.textContent = r.status === 403
      ? 'You are not on the allowed list. Contact your instructor.'
      : (data.error || 'Login failed.');
    return;
  }
  sid = id;
  statusEl.textContent = '';
  document.getElementById('loginView').style.display = 'none';
  document.getElementById('dashView').style.display = 'block';
  document.getElementById('logoutBtn').style.display = 'inline-block';
  document.getElementById('headerSub').textContent = sid + ' \\u2014 Room: ' + data.roomName;
  renderDashboard(data);
}

function renderDashboard(data){
  const fb = document.getElementById('feedbackBox');
  fb.textContent = data.published
    ? data.feedback
    : 'No feedback published yet. Check back later after your instructor reviews your work.';

  const list = document.getElementById('sessionList');
  list.innerHTML = '';
  if (!data.sessions.length) {
    list.innerHTML = '<div style="font-size:13px;color:var(--muted)">No sessions submitted yet.</div>';
    return;
  }
  data.sessions.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'sessRow';
    const when = new Date(s.loginAt).toLocaleString();
    row.innerHTML = '<span>' + when + '</span><span class="badge">' + s.fileCount + ' files</span>';
    row.onclick = () => {
      document.querySelectorAll('.sessRow').forEach((x) => x.classList.remove('active'));
      row.classList.add('active');
      loadCode(s.sessionId);
    };
    list.appendChild(row);
  });
}

async function loadCode(sessionId){
  const view = document.getElementById('codeView');
  view.textContent = 'Loading...';
  const r = await fetch('/student/sessions/' + encodeURIComponent(sessionId) + '?studentId=' + encodeURIComponent(sid));
  const data = await r.json();
  if (!r.ok) { view.textContent = data.error || 'Error loading session.'; return; }
  if (!data.files.length) { view.textContent = 'No files recorded in this session.'; return; }
  view.innerHTML = '';
  data.files.forEach((f) => {
    const div = document.createElement('div');
    div.className = 'file';
    div.innerHTML = '<h4>' + escapeHtml(f.path) + ' (' + escapeHtml(f.language) + ')</h4><pre></pre>';
    div.querySelector('pre').textContent = f.content;
    view.appendChild(div);
  });
}

document.getElementById('chatBtn').onclick = sendChat;
document.getElementById('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

async function sendChat(){
  const input = document.getElementById('chatInput');
  const q = input.value.trim();
  if (!q) return;
  if (!sid) { alert('Log in with your student ID first, then open this AI helper again.'); return; }
  const log = document.getElementById('chatLog');
  log.innerHTML += '<div class="msg me"><b>You:</b> ' + escapeHtml(q) + '</div>';
  input.value = '';
  log.innerHTML += '<div class="msg ai" id="pending">Thinking...</div>';
  log.scrollTop = log.scrollHeight;
  const r = await fetch('/student/ai-hint', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ studentId: sid, question: q })
  });
  const data = await r.json();
  document.getElementById('pending').remove();
  log.innerHTML += '<div class="msg ai"><b>Hint:</b> ' + escapeHtml(r.ok ? data.answer : (data.error || 'Something went wrong.')) + '</div>';
  log.scrollTop = log.scrollHeight;
}

function escapeHtml(s){ return s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
</script>
</body></html>`;

const ADMIN_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Admin &mdash; East West University</title>
<style>
:root{--navy:#1b2a57;--navy-dark:#111c3e;--navy-light:#2e4080;--bg:#eef1f8;--card:#ffffff;--border:#dde3f0;--text:#1a1f36;--muted:#6b7280}
*{box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,sans-serif;margin:0;height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--text)}
header{background:linear-gradient(120deg,var(--navy-dark),var(--navy));padding:12px 24px;display:flex;align-items:center;gap:14px;box-shadow:0 2px 10px rgba(0,0,0,.15);flex-shrink:0}
header img{height:38px}
header .title{color:#fff;flex:1}
header .title h1{font-size:15px;margin:0;font-weight:600}
header .title span{font-size:10px;color:#c6cff0;letter-spacing:.5px}
header #logoutBtn{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.25)}
header #logoutBtn:hover{background:rgba(255,255,255,.22)}
#app{display:flex;flex:1;min-height:0}
.col{overflow-y:auto;padding:14px;box-sizing:border-box;background:var(--card)}
#students{width:230px;border-right:1px solid var(--border)}
#sessions{width:270px;border-right:1px solid var(--border)}
#detail{flex:1;background:var(--bg)}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin:0 0 10px;font-weight:700}
.item{padding:9px 10px;border-radius:8px;cursor:pointer;margin-bottom:4px;font-size:13px;border:1px solid transparent}
.item:hover{background:#f1f4fb}
.item.active{background:#e3e9fb;border-color:var(--navy-light)}
pre{background:#f7f9fd;border:1px solid var(--border);padding:10px;border-radius:8px;overflow:auto;font-size:12px;max-height:300px}
.file{margin-bottom:14px}
.file h3{font-size:12px;color:var(--muted);margin:0 0 4px}
.badge{display:inline-block;background:var(--navy);color:#fff;border-radius:10px;padding:1px 8px;font-size:10px;margin-left:6px;font-weight:600}
#deptFilter{width:100%;box-sizing:border-box;margin-bottom:8px;padding:8px;background:#f7f9fd;border:1px solid var(--border);color:var(--text);border-radius:8px}
input,textarea,select{font-family:inherit}
button{background:var(--navy);color:#fff;border:none;border-radius:8px;padding:8px 12px;font-size:12px;cursor:pointer;margin-bottom:8px;font-weight:600;transition:background .15s}
button:hover{background:var(--navy-light)}
.session-row{display:flex;align-items:center;justify-content:space-between}
.session-row .dl{font-size:11px;color:var(--navy-light);text-decoration:none;margin-left:6px;font-weight:600}
#loginScreen{position:fixed;inset:0;background:linear-gradient(160deg,var(--navy-dark),var(--navy) 60%);display:flex;align-items:center;justify-content:center;flex-direction:column;z-index:10}
#loginScreen img{height:70px;margin-bottom:18px}
#loginScreen h1{font-size:18px;margin-bottom:18px;color:#fff;font-weight:600}
#loginScreen input{padding:11px;width:270px;background:rgba(255,255,255,.95);border:1px solid transparent;color:var(--text);border-radius:8px;margin-bottom:12px;font-size:14px}
#loginScreen button{width:270px;padding:11px;background:#fff;color:var(--navy)}
#loginScreen button:hover{background:#e3e9fb}
#loginError{color:#ffb4b4;font-size:12px;height:16px;margin-bottom:6px}
#app{display:none}
#aiFab{position:fixed;right:26px;bottom:26px;width:58px;height:58px;border-radius:50%;background:linear-gradient(135deg,var(--navy),var(--navy-light));border:none;color:#fff;font-size:24px;cursor:pointer;box-shadow:0 6px 18px rgba(27,42,87,.4);z-index:20}
#aiFab:hover{filter:brightness(1.15)}
#aiModalOverlay{display:none;position:fixed;inset:0;background:rgba(17,28,62,.45);z-index:21;align-items:center;justify-content:center}
#aiModal{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:20px;width:520px;max-width:90vw;max-height:80vh;overflow-y:auto;box-shadow:0 10px 40px rgba(0,0,0,.25)}
#aiModal h2{margin:0 0 10px;font-size:16px;text-transform:none;color:var(--text);font-weight:600}
#aiModal select{width:100%;padding:9px;background:#f7f9fd;border:1px solid var(--border);color:var(--text);border-radius:8px;margin-bottom:10px}
#aiModalClose{float:right;cursor:pointer;color:var(--muted);font-size:18px}
#feedbackText{width:100%;box-sizing:border-box;background:#f7f9fd;color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px;font-size:13px;margin-top:8px}
</style></head>
<body>
<div id="loginScreen">
  <img src="/assets/ewu-logo.png" alt="East West University" />
  <h1>Student Tracker &mdash; Teacher Login</h1>
  <div id="loginError"></div>
  <input id="loginPassword" type="password" placeholder="Admin password" autofocus />
  <button id="loginBtn">Login</button>
</div>
<header>
  <img src="/assets/ewu-logo.png" alt="East West University" />
  <div class="title"><h1>Student Tracker &mdash; Admin</h1><span>EAST WEST UNIVERSITY</span></div>
  <button id="logoutBtn">Logout</button>
</header>
<div id="app">
<div class="col" id="students"><h2>Students</h2>
  <input id="deptFilter" placeholder="Dept code filter (blank = all)" value="__DEFAULT_DEPT__" />
  <button id="downloadAllBtn">Download All (CSV)</button>
  <button id="roomsBtn">Manage Rooms</button>
  <div id="studentList"></div>
</div>
<div class="col" id="sessions"><h2>Sessions</h2><div id="sessionList"></div></div>
<div class="col" id="roomsPanel" style="display:none;width:340px;border-right:1px solid var(--border)">
  <h2>Rooms (allowed student IDs)</h2>
  <input id="newRoomName" placeholder="Room name e.g. cse103" />
  <button id="createRoomBtn">Create Room</button>
  <div id="roomList" style="margin-top:12px"></div>
</div>
<div class="col" id="detail">
  <h2>Session Detail</h2>
  <div id="detailBody">Select a student &rarr; session.</div>
</div>
</div>

<button id="aiFab" title="AI Feedback Assistant">&#10024;</button>
<div id="aiModalOverlay">
  <div id="aiModal">
    <span id="aiModalClose">&times;</span>
    <h2>AI Feedback Assistant</h2>
    <select id="aiStudentSelect"><option value="">Select a student...</option></select>
    <div id="aiModalBody" style="display:none">
      <button id="aiGenBtn">Generate AI Feedback</button>
      <span id="aiGenStatus" style="font-size:11px;color:var(--muted);margin-left:8px"></span>
      <textarea id="feedbackText" rows="8"></textarea>
      <div style="margin-top:8px">
        <button id="saveDraftBtn">Save (Draft)</button>
        <button id="publishBtn">Publish to Student</button>
        <button id="unpublishBtn">Unpublish</button>
        <span id="publishStatus" style="font-size:11px;color:var(--muted);margin-left:8px"></span>
      </div>
    </div>
  </div>
</div>

<script>
let currentFeedbackStudentId = '';
let allStudentIds = [];

document.getElementById('aiFab').onclick = () => {
  document.getElementById('aiModalOverlay').style.display = 'flex';
  populateAiStudentSelect();
  if (currentFeedbackStudentId) loadFeedback(currentFeedbackStudentId);
};
document.getElementById('aiModalClose').onclick = () => {
  document.getElementById('aiModalOverlay').style.display = 'none';
};
document.getElementById('aiModalOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'aiModalOverlay') document.getElementById('aiModalOverlay').style.display = 'none';
});

function populateAiStudentSelect(){
  const sel = document.getElementById('aiStudentSelect');
  sel.innerHTML = '<option value="">Select a student...</option>';
  allStudentIds.forEach((id) => {
    const opt = document.createElement('option');
    opt.value = id; opt.textContent = id;
    if (id === currentFeedbackStudentId) opt.selected = true;
    sel.appendChild(opt);
  });
}

document.getElementById('aiStudentSelect').onchange = (e) => {
  if (e.target.value) loadFeedback(e.target.value);
  else document.getElementById('aiModalBody').style.display = 'none';
};

async function loadFeedback(studentId){
  currentFeedbackStudentId = studentId;
  document.getElementById('aiModalBody').style.display = 'block';
  document.getElementById('aiGenStatus').textContent = '';
  document.getElementById('publishStatus').textContent = '';
  const doc = await j('/admin/result/' + encodeURIComponent(studentId));
  document.getElementById('feedbackText').value = doc.finalFeedback || doc.aiFeedback || '';
  document.getElementById('publishStatus').textContent = doc.published ? 'Published' : 'Not published';
}

document.getElementById('aiGenBtn').onclick = async () => {
  if (!currentFeedbackStudentId) return;
  document.getElementById('aiGenStatus').textContent = 'Generating...';
  const r = await fetch('/admin/ai-generate/' + encodeURIComponent(currentFeedbackStudentId), { method: 'POST' });
  const data = await r.json();
  if (!r.ok) { document.getElementById('aiGenStatus').textContent = 'Error: ' + (data.error || 'failed'); return; }
  document.getElementById('feedbackText').value = data.aiFeedback;
  document.getElementById('aiGenStatus').textContent = 'AI draft generated (not published yet).';
};

async function saveResult(published){
  if (!currentFeedbackStudentId) return;
  const feedback = document.getElementById('feedbackText').value;
  const r = await fetch('/admin/result/' + encodeURIComponent(currentFeedbackStudentId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feedback, published })
  });
  const doc = await r.json();
  document.getElementById('publishStatus').textContent = doc.published ? 'Published' : 'Saved as draft (not published)';
}

document.getElementById('saveDraftBtn').onclick = () => saveResult(false);
document.getElementById('publishBtn').onclick = () => saveResult(true);
document.getElementById('unpublishBtn').onclick = () => saveResult(false);

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
  allStudentIds = students.map((s) => s.studentId);
  const el = document.getElementById('studentList');
  el.innerHTML = '';
  students.forEach(s => {
    const d = document.createElement('div');
    d.className = 'item';
    d.textContent = s.studentId;
    d.innerHTML += '<span class="badge">dept ' + (s.deptCode || '?') + '</span>';
    d.innerHTML += '<span class="badge">' + s.sessionCount + '</span>';
    d.onclick = () => { document.querySelectorAll('#studentList .item').forEach(x=>x.classList.remove('active')); d.classList.add('active'); loadSessions(s.studentId); currentFeedbackStudentId = s.studentId; };
    el.appendChild(d);
  });
}
document.getElementById('deptFilter').addEventListener('input', loadStudents);
document.getElementById('downloadAllBtn').onclick = () => {
  window.location.href = '/api/download-all';
};

document.getElementById('roomsBtn').onclick = () => {
  const el = document.getElementById('roomsPanel');
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
  if (el.style.display === 'block') loadRooms();
};

document.getElementById('createRoomBtn').onclick = async () => {
  const roomName = document.getElementById('newRoomName').value.trim();
  if (!roomName) return;
  const r = await fetch('/admin/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomName, studentIds: [] })
  });
  if (r.ok) { document.getElementById('newRoomName').value = ''; loadRooms(); }
  else { const d = await r.json(); alert(d.error || 'failed'); }
};

async function loadRooms(){
  const rooms = await j('/admin/rooms');
  const el = document.getElementById('roomList');
  el.innerHTML = '';
  rooms.forEach(room => {
    const box = document.createElement('div');
    box.style.cssText = 'background:#1c1f26;border-radius:6px;padding:10px;margin-bottom:10px';
    box.innerHTML =
      '<div style="font-weight:bold;margin-bottom:4px">' + room.roomName +
      '<span class="badge">' + room.studentIds.length + ' ids</span></div>' +
      '<textarea rows="3" placeholder="paste student IDs, one per line or comma separated" style="width:100%;box-sizing:border-box;background:#12141a;color:#e6e6e6;border:1px solid #2a2d34;border-radius:6px;padding:6px;font-size:12px"></textarea>' +
      '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">' +
      '<button class="addIdsBtn">Add IDs</button>' +
      '<button class="delDataBtn" style="background:#5a2b2b">Delete Room Data</button>' +
      '<button class="delRoomBtn" style="background:#5a2b2b">Delete Room</button>' +
      '</div>' +
      '<div style="margin-top:6px;font-size:11px;color:#8a8f98">' + room.studentIds.join(', ') + '</div>';
    box.querySelector('.addIdsBtn').onclick = async () => {
      const ta = box.querySelector('textarea');
      const studentIds = ta.value;
      if (!studentIds.trim()) return;
      await fetch('/admin/rooms/' + encodeURIComponent(room.roomName) + '/students', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentIds })
      });
      loadRooms();
    };
    box.querySelector('.delDataBtn').onclick = async () => {
      if (!confirm('Delete ALL collected session/result data for every student in room "' + room.roomName + '"? This cannot be undone. The roster (allowed IDs) stays.')) return;
      const r = await fetch('/admin/rooms/' + encodeURIComponent(room.roomName) + '/data', { method: 'DELETE' });
      const d = await r.json();
      alert('Deleted ' + d.deletedSessions + ' sessions, ' + d.deletedResults + ' results.');
      loadStudents();
    };
    box.querySelector('.delRoomBtn').onclick = async () => {
      if (!confirm('Delete room "' + room.roomName + '"? Students in it will lose access to the extension and student panel. Their already-collected data is NOT deleted.')) return;
      await fetch('/admin/rooms/' + encodeURIComponent(room.roomName), { method: 'DELETE' });
      loadRooms();
    };
    el.appendChild(box);
  });
}

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

connectDb()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Collector server listening on :${PORT}`);
      console.log(`Admin panel: http://localhost:${PORT}/admin  (login with the ADMIN_KEY password)`);
    });
  })
  .catch((err) => {
    console.error('Failed to connect to MongoDB:', err.message);
    process.exit(1);
  });

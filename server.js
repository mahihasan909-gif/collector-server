const express = require('express');
const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcryptjs');
const { MongoClient } = require('mongodb');

const PORT = process.env.PORT || 4000;
const API_KEY = process.env.API_KEY || '';
const INVITE_CODE = process.env.INVITE_CODE || '';
const MONGODB_URI = process.env.MONGODB_URI || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-oss-20b:free';

if (!API_KEY) {
  console.error(
    'Refusing to start with no API_KEY set (the VS Code extension needs this to upload sessions). ' +
      'Example:\n  set API_KEY=some-secret\n  npm start'
  );
  process.exit(1);
}

if (!INVITE_CODE) {
  console.error(
    'Refusing to start with no INVITE_CODE set (teachers need this to register an admin account). ' +
      'Example:\n  set INVITE_CODE=some-secret-phrase\n  npm start'
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
let adminsCol;

async function connectDb() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db('student_tracker');
  sessionsCol = db.collection('sessions');
  resultsCol = db.collection('results');
  roomsCol = db.collection('rooms');
  adminsCol = db.collection('admins');
  await sessionsCol.createIndex({ studentId: 1, sessionId: 1 }, { unique: true });
  try {
    await resultsCol.dropIndex('studentId_1');
  } catch {
    // old per-student-only index doesn't exist, nothing to drop
  }
  await resultsCol.createIndex({ studentId: 1, sessionId: 1 }, { unique: true });
  try { await roomsCol.dropIndex('roomName_1'); } catch {}
  await roomsCol.createIndex({ roomName: 1, ownerAdmin: 1 }, { unique: true });
  await roomsCol.createIndex({ studentIds: 1 });
  await adminsCol.createIndex({ username: 1 }, { unique: true });
  console.log('Connected to MongoDB.');
}

// Every studentId in any room owned by this admin — used to scope all admin data queries.
async function ownedStudentIds(adminUsername) {
  const rooms = await roomsCol.find({ ownerAdmin: adminUsername }).toArray();
  const ids = new Set();
  for (const r of rooms) for (const id of r.studentIds || []) ids.add(id);
  return ids;
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

// --- admin/teacher panel: per-teacher accounts, cookie session maps to a username ---
const COOKIE_NAME = 'tracker_admin';
const adminSessions = new Map(); // token -> username

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

function currentAdmin(req) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  return token ? adminSessions.get(token) : undefined;
}

function checkAdmin(req, res, next) {
  const username = currentAdmin(req);
  if (!username) return res.status(401).json({ error: 'not logged in' });
  req.adminUsername = username;
  next();
}

function startSession(res, username) {
  const token = crypto.randomBytes(24).toString('hex');
  adminSessions.set(token, username);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=43200; SameSite=Lax`);
}

app.post('/admin/register', async (req, res) => {
  const { username, password, inviteCode } = req.body || {};
  if (inviteCode !== INVITE_CODE) return res.status(403).json({ error: 'wrong invite code' });
  const uname = (username || '').toString().trim().toLowerCase();
  const pass = (password || '').toString();
  if (!/^[a-z0-9._%+-]+@gmail\.com$/.test(uname)) {
    return res.status(400).json({ error: 'a valid @gmail.com address is required' });
  }
  if (pass.length < 6) {
    return res.status(400).json({ error: 'password must be 6+ characters' });
  }
  const passwordHash = await bcrypt.hash(pass, 10);
  try {
    await adminsCol.insertOne({ username: uname, passwordHash, createdAt: Date.now() });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'an account with this Gmail already exists' });
    throw err;
  }
  startSession(res, uname);
  res.json({ ok: true, username: uname });
});

app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body || {};
  const uname = (username || '').toString().trim();
  const admin = await adminsCol.findOne({ username: uname });
  if (!admin || !(await bcrypt.compare(password || '', admin.passwordHash))) {
    return res.status(401).json({ error: 'wrong username or password' });
  }
  startSession(res, uname);
  res.json({ ok: true, username: uname });
});

app.post('/admin/logout', (req, res) => {
  const cookies = parseCookies(req);
  adminSessions.delete(cookies[COOKIE_NAME]);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/admin/me', checkAdmin, (req, res) => {
  res.json({ username: req.adminUsername });
});

app.get('/api/students', checkAdmin, async (req, res) => {
  const owned = await ownedStudentIds(req.adminUsername);
  const docs = await sessionsCol
    .find({ studentId: { $in: Array.from(owned) } }, { projection: { studentId: 1, deptCode: 1, logoutAt: 1 } })
    .toArray();
  const byId = new Map();
  for (const d of docs) {
    const cur = byId.get(d.studentId) || { studentId: d.studentId, deptCode: d.deptCode || '', sessionCount: 0, lastActivity: 0 };
    cur.sessionCount++;
    cur.deptCode = d.deptCode || cur.deptCode;
    cur.lastActivity = Math.max(cur.lastActivity, d.logoutAt || 0);
    byId.set(d.studentId, cur);
  }
  const students = Array.from(byId.values());
  res.json(students);
});

async function assertOwnsStudent(req, res, studentId) {
  const owned = await ownedStudentIds(req.adminUsername);
  if (!owned.has(studentId)) {
    res.status(403).json({ error: 'not your student' });
    return false;
  }
  return true;
}

app.get('/api/students/:id/sessions', checkAdmin, async (req, res) => {
  if (!(await assertOwnsStudent(req, res, req.params.id))) return;
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
  if (!(await assertOwnsStudent(req, res, req.params.id))) return;
  const doc = await sessionsCol.findOne({ studentId: req.params.id, sessionId: req.params.sessionId });
  if (!doc) return res.status(404).json({ error: 'not found' });
  res.json(doc);
});

app.get('/api/students/:id/sessions/:sessionId/csv', checkAdmin, async (req, res) => {
  if (!(await assertOwnsStudent(req, res, req.params.id))) return;
  const doc = await sessionsCol.findOne({ studentId: req.params.id, sessionId: req.params.sessionId });
  if (!doc) return res.status(404).send('not found');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName(req.params.id)}_${safeName(req.params.sessionId)}_code.csv"`);
  res.type('text/csv').send(buildCodeCsv(doc));
});

app.delete('/api/students/:id/sessions/:sessionId', checkAdmin, async (req, res) => {
  if (!(await assertOwnsStudent(req, res, req.params.id))) return;
  const { id, sessionId } = req.params;
  const sessRes = await sessionsCol.deleteOne({ studentId: id, sessionId });
  await resultsCol.deleteOne({ studentId: id, sessionId });
  if (!sessRes.deletedCount) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

app.get('/api/students/:id/sessions-csv', checkAdmin, async (req, res) => {
  if (!(await assertOwnsStudent(req, res, req.params.id))) return;
  const docs = await sessionsCol.find({ studentId: req.params.id }).sort({ loginAt: -1 }).toArray();
  const parts = [CODE_CSV_COLUMNS.join(',')];
  for (const doc of docs) parts.push(...buildCodeCsvRows(doc));
  res.setHeader('Content-Disposition', `attachment; filename="${safeName(req.params.id)}_all_sessions.csv"`);
  res.type('text/csv').send(parts.join('\n'));
});

app.get('/api/download-all', checkAdmin, async (req, res) => {
  const owned = await ownedStudentIds(req.adminUsername);
  const docs = await sessionsCol.find({ studentId: { $in: Array.from(owned) } }).toArray();
  const parts = [CODE_CSV_COLUMNS.join(',')];
  for (const doc of docs) {
    parts.push(...buildCodeCsvRows(doc));
  }
  res.setHeader('Content-Disposition', 'attachment; filename="all_students_dataset.csv"');
  res.type('text/csv').send(parts.join('\n'));
});

// --- rooms: whitelist of student IDs allowed to use extension + student panel, owned by one admin ---

app.get('/admin/rooms', checkAdmin, async (req, res) => {
  const rooms = await roomsCol.find({ ownerAdmin: req.adminUsername }).toArray();
  res.json(rooms.map((r) => ({ roomName: r.roomName, studentIds: r.studentIds || [], createdAt: r.createdAt })));
});

app.post('/admin/rooms', checkAdmin, async (req, res) => {
  const roomName = (req.body?.roomName || '').toString().trim();
  if (!roomName) return res.status(400).json({ error: 'roomName required' });
  const ids = parseIdList(req.body?.studentIds);
  try {
    await roomsCol.insertOne({ roomName, studentIds: ids, ownerAdmin: req.adminUsername, createdAt: Date.now() });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'room already exists' });
    throw err;
  }
  res.json({ ok: true });
});

// One-time migration helper: attach a legacy ownerless room (from before multi-admin accounts
// existed) to whichever teacher account claims it first.
app.post('/admin/rooms/:roomName/claim', checkAdmin, async (req, res) => {
  const room = await roomsCol.findOne({ roomName: req.params.roomName });
  if (!room) return res.status(404).json({ error: 'room not found' });
  if (room.ownerAdmin) return res.status(409).json({ error: 'room already has an owner' });
  await roomsCol.updateOne({ roomName: req.params.roomName }, { $set: { ownerAdmin: req.adminUsername } });
  res.json({ ok: true });
});

async function assertOwnsRoom(req, res, roomName) {
  const room = await roomsCol.findOne({ roomName, ownerAdmin: req.adminUsername });
  if (!room) {
    res.status(404).json({ error: 'room not found' });
    return null;
  }
  return room;
}

app.post('/admin/rooms/:roomName/students', checkAdmin, async (req, res) => {
  const room = await assertOwnsRoom(req, res, req.params.roomName);
  if (!room) return;
  const ids = parseIdList(req.body?.studentIds);
  if (!ids.length) return res.status(400).json({ error: 'studentIds required' });
  await roomsCol.updateOne({ roomName: room.roomName, ownerAdmin: req.adminUsername }, { $addToSet: { studentIds: { $each: ids } } });
  res.json({ ok: true, added: ids.length });
});

app.delete('/admin/rooms/:roomName/students/:studentId', checkAdmin, async (req, res) => {
  const room = await assertOwnsRoom(req, res, req.params.roomName);
  if (!room) return;
  await roomsCol.updateOne({ roomName: room.roomName, ownerAdmin: req.adminUsername }, { $pull: { studentIds: req.params.studentId } });
  res.json({ ok: true });
});

app.delete('/admin/rooms/:roomName', checkAdmin, async (req, res) => {
  const room = await assertOwnsRoom(req, res, req.params.roomName);
  if (!room) return;
  await roomsCol.deleteOne({ roomName: room.roomName, ownerAdmin: req.adminUsername });
  res.json({ ok: true });
});

// Danger zone: wipe all collected session/result data for every student ID in this room.
// The room roster itself (allowed IDs) is left intact.
app.delete('/admin/rooms/:roomName/data', checkAdmin, async (req, res) => {
  const room = await assertOwnsRoom(req, res, req.params.roomName);
  if (!room) return;
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

// --- AI-generated + manual feedback/result, scoped to one session ---

app.post('/admin/ai-generate/:studentId/:sessionId', checkAdmin, async (req, res) => {
  const { studentId, sessionId } = req.params;
  if (!(await assertOwnsStudent(req, res, studentId))) return;
  const session = await sessionsCol.findOne({ studentId, sessionId });
  if (!session) return res.status(404).json({ error: 'session not found' });

  const { totals, fileSummaries } = summarizeStudentForAi([session]);
  const prompt =
    `You are a programming instructor's assistant helping evaluate a CSE student's coding activity ` +
    `for signs of good/bad practice and possible AI-assistance overuse, based on keystroke telemetry ` +
    `and their code, for ONE coding session.\n\nActivity totals for this session: ${JSON.stringify(totals)}\n\n` +
    `Per-file details:\n${fileSummaries.join('\n')}\n\n` +
    `Write a short, constructive feedback report (150-250 words) for the STUDENT to read, covering: ` +
    `(1) what they're doing well in this session, (2) specific areas to improve (coding habits, patterns, testing, etc.), ` +
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
    { studentId, sessionId },
    { $set: { studentId, sessionId, aiFeedback, aiGeneratedAt: Date.now() } },
    { upsert: true }
  );
  res.json({ ok: true, aiFeedback });
});

app.get('/admin/result/:studentId/:sessionId', checkAdmin, async (req, res) => {
  const { studentId, sessionId } = req.params;
  if (!(await assertOwnsStudent(req, res, studentId))) return;
  const doc = await resultsCol.findOne({ studentId, sessionId });
  res.json(doc || { studentId, sessionId });
});

app.post('/admin/result/:studentId/:sessionId', checkAdmin, async (req, res) => {
  const { studentId, sessionId } = req.params;
  if (!(await assertOwnsStudent(req, res, studentId))) return;
  const { feedback, published } = req.body || {};
  const update = { studentId, sessionId, finalFeedback: feedback ?? '', updatedAt: Date.now() };
  if (published !== undefined) update.published = Boolean(published);
  if (published === true) update.publishedAt = Date.now();
  await resultsCol.updateOne({ studentId, sessionId }, { $set: update }, { upsert: true });
  const doc = await resultsCol.findOne({ studentId, sessionId });
  res.json(doc);
});

// --- student-facing endpoints (ID only, no password) ---

// Full student dashboard: room membership, session list with per-session publish status (used by /student page login).
app.get('/student/me', async (req, res) => {
  const studentId = (req.query.studentId || '').toString().trim();
  if (!studentId) return res.status(400).json({ error: 'studentId required' });
  const room = await roomsCol.findOne({ studentIds: studentId });
  if (!room) return res.status(403).json({ error: 'This student ID is not on any active room roster. Ask your instructor to add you.' });

  const sessions = await sessionsCol.find({ studentId }).sort({ loginAt: -1 }).toArray();
  const results = await resultsCol.find({ studentId }).toArray();
  const resultBySession = new Map(results.map((r) => [r.sessionId, r]));

  res.json({
    studentId,
    roomName: room.roomName,
    sessions: sessions.map((s) => {
      const r = resultBySession.get(s.sessionId);
      return {
        sessionId: s.sessionId,
        loginAt: s.loginAt,
        logoutAt: s.logoutAt,
        fileCount: (s.files || []).length,
        eventCount: (s.events || []).length,
        hasFeedback: Boolean(r && r.published)
      };
    })
  });
});

// A single one of the student's own sessions: code files + published feedback for that session
// (read-only, no admin auth needed — gated by room membership, same as /student/me).
app.get('/student/sessions/:sessionId', async (req, res) => {
  const studentId = (req.query.studentId || '').toString().trim();
  if (!studentId) return res.status(400).json({ error: 'studentId required' });
  if (!(await isStudentAllowed(studentId))) return res.status(403).json({ error: 'not allowed' });
  const doc = await sessionsCol.findOne({ studentId, sessionId: req.params.sessionId });
  if (!doc) return res.status(404).json({ error: 'not found' });
  const result = await resultsCol.findOne({ studentId, sessionId: req.params.sessionId });
  res.json({
    sessionId: doc.sessionId,
    loginAt: doc.loginAt,
    logoutAt: doc.logoutAt,
    files: (doc.files || []).map((f) => ({ path: f.path, language: f.language, content: f.content })),
    published: Boolean(result && result.published),
    feedback: result && result.published ? result.finalFeedback || '' : null
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
  res.type('html').send(ADMIN_HTML);
});

app.get('/student', (_req, res) => {
  res.type('html').send(STUDENT_HTML);
});

const STUDENT_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Student Portal &mdash; East West University</title>
<style>
:root{--navy:#101c3c;--navy-dark:#0a1330;--navy-light:#2f6fed;--bg:#eef2fb;--card:#ffffff;--border:#dde3f0;--text:#101c3c;--muted:#6b7280}
*{box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,sans-serif;margin:0;min-height:100vh;color:var(--text);position:relative;
  background:
    radial-gradient(600px circle at 6% 8%, rgba(47,111,237,.14), transparent 60%),
    radial-gradient(560px circle at 96% 92%, rgba(47,111,237,.16), transparent 60%),
    var(--bg);
}
body::before{content:'';position:fixed;inset:0;z-index:-1;pointer-events:none;opacity:.5;
  background-image: radial-gradient(rgba(47,111,237,.18) 1px, transparent 1px);
  background-size:24px 24px;
  -webkit-mask-image: radial-gradient(circle at 6% 8%, black, transparent 45%), radial-gradient(circle at 96% 92%, black, transparent 45%);
  mask-image: radial-gradient(circle at 6% 8%, black, transparent 45%), radial-gradient(circle at 96% 92%, black, transparent 45%);
}
header{background:linear-gradient(120deg,var(--navy-dark),var(--navy));padding:14px 28px;display:flex;align-items:center;gap:14px;box-shadow:0 2px 10px rgba(0,0,0,.15)}
.logoBadge{width:46px;height:46px;border-radius:50%;background:#fff;overflow:hidden;flex-shrink:0;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,.25)}
.logoBadge img{width:150%;height:150%;object-fit:cover;object-position:50% 32%}
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
  <span class="logoBadge"><img src="/assets/logo.jpg" alt="AI Code Detection" /></span>
  <div class="title"><h1>Student Portal</h1><span id="headerSub">AI CODE DETECTION TOOL</span></div>
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
    <div id="feedbackSessionLabel" style="font-size:13px;color:var(--muted);margin-bottom:8px">Select a session below to view its feedback.</div>
    <div id="feedbackBox" style="display:none"></div>
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
    row.innerHTML = '<span>' + when + (s.hasFeedback ? ' <span class="badge">Feedback ready</span>' : '') + '</span><span class="badge">' + s.fileCount + ' files</span>';
    row.onclick = () => {
      document.querySelectorAll('.sessRow').forEach((x) => x.classList.remove('active'));
      row.classList.add('active');
      loadCode(s.sessionId, when);
    };
    list.appendChild(row);
  });
}

async function loadCode(sessionId, whenLabel){
  const view = document.getElementById('codeView');
  view.textContent = 'Loading...';
  const r = await fetch('/student/sessions/' + encodeURIComponent(sessionId) + '?studentId=' + encodeURIComponent(sid));
  const data = await r.json();
  if (!r.ok) { view.textContent = data.error || 'Error loading session.'; return; }

  document.getElementById('feedbackSessionLabel').textContent = 'Session: ' + whenLabel;
  const fb = document.getElementById('feedbackBox');
  fb.style.display = 'block';
  fb.textContent = data.published
    ? data.feedback
    : 'No feedback published for this session yet. Check back later after your instructor reviews it.';

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
:root{--navy:#101c3c;--navy-dark:#0a1330;--navy-light:#2f6fed;--bg:#eef2fb;--card:#ffffff;--border:#dde3f0;--text:#101c3c;--muted:#6b7280}
*{box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,sans-serif;margin:0;height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--text)}
header{background:linear-gradient(120deg,var(--navy-dark),var(--navy));padding:12px 24px;display:flex;align-items:center;gap:14px;box-shadow:0 2px 10px rgba(0,0,0,.15);flex-shrink:0}
.logoBadge{width:40px;height:40px;border-radius:50%;background:#fff;overflow:hidden;flex-shrink:0;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,.25)}
.logoBadge img{width:150%;height:150%;object-fit:cover;object-position:50% 32%}
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
input,textarea,select{font-family:inherit}
button{background:var(--navy);color:#fff;border:none;border-radius:8px;padding:8px 12px;font-size:12px;cursor:pointer;margin-bottom:8px;font-weight:600;transition:background .15s}
button:hover{background:var(--navy-light)}
.session-row{display:flex;align-items:center;justify-content:space-between}
.session-row .dl{font-size:11px;color:var(--navy-light);text-decoration:none;margin-left:6px;font-weight:600}
#loginScreen{position:fixed;inset:0;overflow:hidden;display:flex;align-items:center;justify-content:center;flex-direction:column;z-index:10;
  background:
    radial-gradient(700px circle at 90% 8%, rgba(47,111,237,.35), transparent 55%),
    radial-gradient(600px circle at 4% 96%, rgba(47,111,237,.25), transparent 55%),
    linear-gradient(160deg,var(--navy-dark),var(--navy) 60%);
}
#loginScreen::before{content:'';position:absolute;inset:0;pointer-events:none;opacity:.35;
  background-image: radial-gradient(rgba(255,255,255,.5) 1px, transparent 1px);
  background-size:26px 26px;
  -webkit-mask-image: radial-gradient(circle at 90% 8%, black, transparent 50%), radial-gradient(circle at 4% 96%, black, transparent 50%);
  mask-image: radial-gradient(circle at 90% 8%, black, transparent 50%), radial-gradient(circle at 4% 96%, black, transparent 50%);
}
#loginScreen::after{content:'';position:absolute;left:-10%;right:-10%;bottom:-6%;height:220px;pointer-events:none;
  background:linear-gradient(90deg, transparent, rgba(47,111,237,.55), transparent);
  filter:blur(2px);border-radius:50%;transform:scaleX(1.4);
}
.loginCorner{position:absolute;top:28px;right:28px;width:64px;height:64px;z-index:2}
#loginCard{position:relative;z-index:1;background:#fff;border-radius:16px;padding:36px 32px;width:340px;box-sizing:border-box;box-shadow:0 20px 60px rgba(0,0,0,.35);text-align:center}
#loginCard h1{font-size:17px;margin:0 0 22px;color:var(--navy);font-weight:700}
#loginTabs{display:flex;gap:0;margin-bottom:20px;border-radius:8px;overflow:hidden;border:1px solid var(--border)}
#loginTabs div{flex:1;text-align:center;padding:9px;cursor:pointer;font-size:13px;font-weight:600;color:var(--muted);background:#f7f9fd;transition:background .15s,color .15s}
#loginTabs div.activeTab{background:var(--navy);color:#fff}
#loginForm, #registerForm{display:flex;flex-direction:column;gap:12px;text-align:left}
#loginScreen input{display:block;width:100%;box-sizing:border-box;padding:11px 12px;background:#f7f9fd;border:1px solid var(--border);color:var(--text);border-radius:8px;font-size:14px}
#loginScreen input:focus{outline:2px solid var(--navy-light);border-color:transparent}
#loginScreen input:disabled{background:#eef1f8;color:var(--muted);cursor:not-allowed}
#loginScreen button{width:100%;padding:12px;background:var(--navy);color:#fff;font-weight:700;margin-top:4px}
#loginScreen button:hover{background:var(--navy-light)}
#loginScreen button:disabled{background:#c7cede;cursor:not-allowed}
#loginError{color:#c0392b;font-size:12px;min-height:16px;margin-bottom:4px;text-align:left}
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
  <span class="logoBadge loginCorner"><img src="/assets/logo.jpg" alt="AI Code Detection" /></span>
  <div id="loginCard">
    <h1>Teacher Portal</h1>
    <div id="loginTabs">
      <div id="tabLogin" class="activeTab">Login</div>
      <div id="tabRegister">Register</div>
    </div>
    <div id="loginError"></div>

    <div id="loginForm">
      <input id="loginUsername" type="email" placeholder="Gmail address" autofocus />
      <div style="position:relative">
        <input id="loginPassword" type="password" placeholder="Password" style="padding-right:40px" />
        <span class="togglePassword" data-target="loginPassword" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);cursor:pointer;color:#6b7280;font-size:16px;user-select:none">&#128065;</span>
      </div>
      <button id="loginBtn">Login</button>
    </div>

    <div id="registerForm" style="display:none">
      <input id="regInviteCode" placeholder="Invite code (ask your admin)" />
      <input id="regUsername" type="email" placeholder="Gmail address" disabled />
      <div style="position:relative">
        <input id="regPassword" type="password" placeholder="Choose a password (6+ chars)" style="padding-right:40px" disabled />
        <span class="togglePassword" data-target="regPassword" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);cursor:pointer;color:#6b7280;font-size:16px;user-select:none">&#128065;</span>
      </div>
      <button id="registerBtn" disabled>Create Account</button>
    </div>
  </div>
</div>
<header>
  <span class="logoBadge"><img src="/assets/logo.jpg" alt="AI Code Detection" /></span>
  <div class="title"><h1>Admin Panel</h1><span>AI CODE DETECTION TOOL</span></div>
  <button id="logoutBtn">Logout</button>
</header>
<div id="app">
<div class="col" id="students"><h2>Students</h2>
  <button id="downloadAllBtn">Download All (CSV)</button>
  <button id="roomsBtn">Manage Rooms</button>
  <div id="studentList"></div>
</div>
<div class="col" id="sessions"><h2>Sessions</h2>
  <button id="downloadStudentAllBtn" style="display:none">Download All (this student)</button>
  <div id="sessionList"></div>
</div>
<div class="col" id="roomsPanel" style="display:none;width:340px;border-right:1px solid var(--border)">
  <h2>Rooms (allowed student IDs)</h2>
  <input id="newRoomName" placeholder="Room name e.g. cse103" />
  <button id="createRoomBtn">Create Room</button>
  <div id="roomList" style="margin-top:12px"></div>
  <div style="margin-top:18px;padding-top:12px;border-top:1px solid var(--border)">
    <div style="font-size:12px;color:#8a8f98;margin-bottom:6px">Room name taken by an old unclaimed room? Claim it here.</div>
    <input id="claimRoomName" placeholder="Existing room name to claim" />
    <button id="claimRoomBtn">Claim Room</button>
  </div>
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
    <select id="aiSessionSelect" style="display:none"><option value="">Select a session...</option></select>
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
let currentFeedbackSessionId = '';
let allStudentIds = [];

document.getElementById('aiFab').onclick = () => {
  document.getElementById('aiModalOverlay').style.display = 'flex';
  populateAiStudentSelect();
  if (currentFeedbackStudentId) populateAiSessionSelect(currentFeedbackStudentId);
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
  document.getElementById('aiModalBody').style.display = 'none';
  if (e.target.value) populateAiSessionSelect(e.target.value);
  else document.getElementById('aiSessionSelect').style.display = 'none';
};

async function populateAiSessionSelect(studentId){
  currentFeedbackStudentId = studentId;
  const sessSel = document.getElementById('aiSessionSelect');
  sessSel.style.display = 'block';
  sessSel.innerHTML = '<option value="">Select a session...</option>';
  const sessions = await j('/api/students/' + encodeURIComponent(studentId) + '/sessions');
  sessions.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.sessionId;
    opt.textContent = new Date(s.loginAt).toLocaleString();
    if (s.sessionId === currentFeedbackSessionId) opt.selected = true;
    sessSel.appendChild(opt);
  });
  if (currentFeedbackSessionId && sessions.some((s) => s.sessionId === currentFeedbackSessionId)) {
    loadFeedback(studentId, currentFeedbackSessionId);
  }
}

document.getElementById('aiSessionSelect').onchange = (e) => {
  if (e.target.value) loadFeedback(currentFeedbackStudentId, e.target.value);
  else document.getElementById('aiModalBody').style.display = 'none';
};

async function loadFeedback(studentId, sessionId){
  currentFeedbackStudentId = studentId;
  currentFeedbackSessionId = sessionId;
  document.getElementById('aiModalBody').style.display = 'block';
  document.getElementById('aiGenStatus').textContent = '';
  document.getElementById('publishStatus').textContent = '';
  const doc = await j('/admin/result/' + encodeURIComponent(studentId) + '/' + encodeURIComponent(sessionId));
  document.getElementById('feedbackText').value = doc.finalFeedback || doc.aiFeedback || '';
  document.getElementById('publishStatus').textContent = doc.published ? 'Published' : 'Not published';
}

document.getElementById('aiGenBtn').onclick = async () => {
  if (!currentFeedbackStudentId || !currentFeedbackSessionId) return;
  document.getElementById('aiGenStatus').textContent = 'Generating...';
  const r = await fetch('/admin/ai-generate/' + encodeURIComponent(currentFeedbackStudentId) + '/' + encodeURIComponent(currentFeedbackSessionId), { method: 'POST' });
  const data = await r.json();
  if (!r.ok) { document.getElementById('aiGenStatus').textContent = 'Error: ' + (data.error || 'failed'); return; }
  document.getElementById('feedbackText').value = data.aiFeedback;
  document.getElementById('aiGenStatus').textContent = 'AI draft generated (not published yet).';
};

async function saveResult(published){
  if (!currentFeedbackStudentId || !currentFeedbackSessionId) return;
  const feedback = document.getElementById('feedbackText').value;
  const r = await fetch('/admin/result/' + encodeURIComponent(currentFeedbackStudentId) + '/' + encodeURIComponent(currentFeedbackSessionId), {
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
function showApp(username){
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  if (username) document.querySelector('header .title span').textContent = 'EAST WEST UNIVERSITY — ' + username;
  loadStudents();
}

document.querySelectorAll('.togglePassword').forEach((el) => {
  el.onclick = () => {
    const input = document.getElementById(el.dataset.target);
    const isHidden = input.type === 'password';
    input.type = isHidden ? 'text' : 'password';
    el.textContent = isHidden ? '\u{1F576}\u{FE0F}' : '\u{1F441}\u{FE0F}';
  };
});

document.getElementById('tabLogin').onclick = () => switchTab('login');
document.getElementById('tabRegister').onclick = () => switchTab('register');
function switchTab(which){
  const isLogin = which === 'login';
  document.getElementById('loginForm').style.display = isLogin ? 'flex' : 'none';
  document.getElementById('registerForm').style.display = isLogin ? 'none' : 'flex';
  document.getElementById('tabLogin').classList.toggle('activeTab', isLogin);
  document.getElementById('tabRegister').classList.toggle('activeTab', !isLogin);
  document.getElementById('loginError').textContent = '';
}

document.getElementById('loginBtn').onclick = doLogin;
document.getElementById('loginPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

async function doLogin(){
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const r = await fetch('/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await r.json();
  if (r.ok) { document.getElementById('loginError').textContent = ''; showApp(data.username); }
  else { document.getElementById('loginError').textContent = data.error || 'Login failed.'; }
}

document.getElementById('regInviteCode').addEventListener('input', (e) => {
  const unlocked = e.target.value.trim().length > 0;
  document.getElementById('regUsername').disabled = !unlocked;
  document.getElementById('regPassword').disabled = !unlocked;
  document.getElementById('registerBtn').disabled = !unlocked;
});

document.getElementById('registerBtn').onclick = doRegister;

async function doRegister(){
  const username = document.getElementById('regUsername').value.trim();
  const password = document.getElementById('regPassword').value;
  const inviteCode = document.getElementById('regInviteCode').value;
  const r = await fetch('/admin/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, inviteCode })
  });
  const data = await r.json();
  if (r.ok) { document.getElementById('loginError').textContent = ''; showApp(data.username); }
  else { document.getElementById('loginError').textContent = data.error || 'Registration failed.'; }
}

document.getElementById('logoutBtn').onclick = async () => {
  await fetch('/admin/logout', { method: 'POST' });
  showLogin();
};

async function loadStudents(){
  const students = await j('/api/students');
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

document.getElementById('claimRoomBtn').onclick = async () => {
  const roomName = document.getElementById('claimRoomName').value.trim();
  if (!roomName) return;
  const r = await fetch('/admin/rooms/' + encodeURIComponent(roomName) + '/claim', { method: 'POST' });
  const d = await r.json();
  if (r.ok) { document.getElementById('claimRoomName').value = ''; loadRooms(); }
  else { alert(d.error || 'failed'); }
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
      const r = await fetch('/admin/rooms/' + encodeURIComponent(room.roomName) + '/students', {
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
  const dlAllBtn = document.getElementById('downloadStudentAllBtn');
  dlAllBtn.style.display = 'inline-block';
  dlAllBtn.onclick = () => { window.location.href = '/api/students/' + encodeURIComponent(studentId) + '/sessions-csv'; };
  sessions.forEach(s => {
    const d = document.createElement('div');
    d.className = 'item session-row';
    const started = new Date(s.loginAt).toLocaleString();
    const left = document.createElement('span');
    left.textContent = started;
    left.innerHTML += '<div class="badge">' + s.eventCount + ' events</div>';
    left.onclick = () => { document.querySelectorAll('#sessionList .item').forEach(x=>x.classList.remove('active')); d.classList.add('active'); loadDetail(studentId, s.sessionId); currentFeedbackStudentId = studentId; currentFeedbackSessionId = s.sessionId; };
    const dl = document.createElement('a');
    dl.className = 'dl';
    dl.textContent = 'CSV';
    dl.href = '/api/students/' + encodeURIComponent(studentId) + '/sessions/' + encodeURIComponent(s.sessionId) + '/csv';
    const rm = document.createElement('a');
    rm.className = 'dl';
    rm.style.color = '#c0392b';
    rm.textContent = 'Remove';
    rm.href = '#';
    rm.onclick = async (e) => {
      e.preventDefault();
      if (!confirm('Remove this session (' + started + ') permanently? This deletes its code, events, and feedback.')) return;
      await fetch('/api/students/' + encodeURIComponent(studentId) + '/sessions/' + encodeURIComponent(s.sessionId), { method: 'DELETE' });
      loadSessions(studentId);
    };
    d.appendChild(left);
    d.appendChild(dl);
    d.appendChild(rm);
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

fetch('/admin/me').then(async (r) => { if (r.ok) { const d = await r.json(); showApp(d.username); } }).catch(() => {});
</script>
</body></html>`;

connectDb()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Collector server listening on :${PORT}`);
      console.log(`Admin panel: http://localhost:${PORT}/admin  (register a teacher account with your INVITE_CODE)`);
    });
  })
  .catch((err) => {
    console.error('Failed to connect to MongoDB:', err.message);
    process.exit(1);
  });

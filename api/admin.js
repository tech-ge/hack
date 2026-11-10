import crypto from 'crypto';
import { MongoClient, GridFSBucket, ObjectId } from 'mongodb';

// ---------- Config from env ----------
const ADMIN_EMAIL      = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD   = process.env.ADMIN_PASSWORD;
const SESSION_SECRET   = process.env.SESSION_SECRET;
const MAX_ATTEMPTS     = parseInt(process.env.MAX_ATTEMPTS || '3', 10);
const LOCKOUT_MINUTES  = parseInt(process.env.LOCKOUT_MINUTES || '30', 10);
const SESSION_MINUTES  = parseInt(process.env.SESSION_MINUTES || '30', 10);
const COOKIE_NAME      = 'techgeo_admin';

// ---------- Mongo cache ----------
let cachedClient = null;
let cachedDb = null;
let cachedBucket = null;

async function getDb() {
  if (cachedDb) return cachedDb;
  if (!cachedClient) {
    cachedClient = new MongoClient(process.env.MONGODB_URI);
    await cachedClient.connect();
  }
  cachedDb = cachedClient.db(process.env.MONGODB_DB || 'techgeo');
  return cachedDb;
}
async function getBucket() {
  if (cachedBucket) return cachedBucket;
  const db = await getDb();
  cachedBucket = new GridFSBucket(db, { bucketName: 'uploads' });
  return cachedBucket;
}

// ---------- Session token ----------
function sign(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
}
function createToken(email) {
  const exp = Date.now() + SESSION_MINUTES * 60 * 1000;
  const b64 = Buffer.from(JSON.stringify({ email, exp })).toString('base64url');
  return `${b64}.${sign(b64)}`;
}
function verifyToken(token) {
  if (!token) return null;
  const [b64, sig] = token.split('.');
  if (!b64 || !sig) return null;
  const expected = sign(b64);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const data = JSON.parse(Buffer.from(b64, 'base64url').toString());
    if (Date.now() > data.exp) return null;
    return data;
  } catch { return null; }
}
function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return Object.fromEntries(
    raw.split(';').map(c => {
      const [k, ...v] = c.trim().split('=');
      return [k, v.join('=')];
    })
  );
}
function getSession(req) { return verifyToken(parseCookies(req)[COOKIE_NAME]); }
function setSession(res, email) {
  const token = createToken(email);
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_MINUTES * 60}; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`
  );
}
function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

// ---------- Lockout ----------
async function getLockout(email) {
  const db = await getDb();
  const doc = await db.collection('admin_lockouts').findOne({ email });
  if (!doc) return { attempts: 0, lockedUntil: 0 };
  return doc;
}
async function recordFailure(email) {
  const db = await getDb();
  const doc = await getLockout(email);
  const attempts = (doc.attempts || 0) + 1;
  const lockedUntil = attempts >= MAX_ATTEMPTS
    ? Date.now() + LOCKOUT_MINUTES * 60 * 1000
    : 0;
  await db.collection('admin_lockouts').updateOne(
    { email },
    { $set: { email, attempts, lockedUntil, updatedAt: new Date() } },
    { upsert: true }
  );
  return { attempts, lockedUntil };
}
async function resetFailures(email) {
  const db = await getDb();
  await db.collection('admin_lockouts').deleteOne({ email });
}

// ---------- File meta (status: pending | done) ----------
async function getMetaMap(fileIds) {
  const db = await getDb();
  const docs = await db.collection('filemeta')
    .find({ fileId: { $in: fileIds } })
    .toArray();
  return Object.fromEntries(docs.map(d => [d.fileId, d]));
}

async function setDone(fileId, done = true) {
  const db = await getDb();
  await db.collection('filemeta').updateOne(
    { fileId },
    { $set: { fileId, status: done ? 'done' : 'pending', doneAt: done ? new Date() : null } },
    { upsert: true }
  );
}

async function deleteFileRecord(fileId) {
  const db = await getDb();
  const bucket = await getBucket();
  const _id = new ObjectId(fileId);

  // Try GridFS delete (ignore if already gone)
  try { await bucket.delete(_id); } catch (e) { /* not found */ }

  // Clean meta + lockouts (unrelated, just tidy)
  await db.collection('filemeta').deleteOne({ fileId });
  return true;
}

// ---------- Body parser ----------
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  const ct = req.headers['content-type'] || '';
  if (ct.includes('application/json')) {
    try { return JSON.parse(raw || '{}'); } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

// ---------- MAIN HANDLER ----------
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const action = req.query.action;

  try {
    // ===== LOGIN =====
    if (action === 'login') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
      const { email, password } = await readBody(req);
      if (!email || !password) return res.status(400).json({ error: 'Email & password required' });

      if (email !== ADMIN_EMAIL) return res.status(401).json({ error: 'Invalid credentials' });

      const lock = await getLockout(email);
      if (lock.lockedUntil && Date.now() < lock.lockedUntil) {
        const mins = Math.ceil((lock.lockedUntil - Date.now()) / 60000);
        return res.status(423).json({ error: `Account locked. Try again in ${mins} min.`, lockedUntil: lock.lockedUntil });
      }

      if (password !== ADMIN_PASSWORD) {
        const { attempts, lockedUntil } = await recordFailure(email);
        if (lockedUntil) return res.status(423).json({
          error: `❌ 3 failed attempts — locked for ${LOCKOUT_MINUTES} minutes.`,
          lockedUntil,
        });
        return res.status(401).json({
          error: `❌ Wrong password. ${MAX_ATTEMPTS - attempts} attempt(s) left.`,
          attemptsLeft: MAX_ATTEMPTS - attempts,
        });
      }

      await resetFailures(email);
      setSession(res, email);
      return res.status(200).json({ success: true, email, expiresIn: SESSION_MINUTES * 60 });
    }

    // ===== LOGOUT =====
    if (action === 'logout') { clearSession(res); return res.status(200).json({ success: true }); }

    // ===== SESSION =====
    if (action === 'session') {
      const s = getSession(req);
      if (!s) return res.status(401).json({ error: 'No session' });
      return res.status(200).json({ email: s.email, expiresAt: s.exp });
    }

    // ===== PROTECTED BELOW =====
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: 'Unauthorized — login required' });

    // ===== LIST FILES =====
    if (action === 'files') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
      const bucket = await getBucket();
      const files = await bucket.find({}).sort({ uploadDate: -1 }).toArray();
      const meta = await getMetaMap(files.map(f => f._id.toString()));

      return res.status(200).json({
        success: true,
        count: files.length,
        files: files.map(f => {
          const id = f._id.toString();
          const m = meta[id] || {};
          return {
            id,
            filename: f.filename,
            size: f.length,
            uploadDate: f.uploadDate,
            status: m.status || 'pending',
            doneAt: m.doneAt || null,
          };
        }),
      });
    }

    // ===== DOWNLOAD (auto-marks done) =====
    if (action === 'download') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Missing id' });
      const bucket = await getBucket();
      const _id = new ObjectId(id);
      const found = await bucket.find({ _id }).toArray();
      if (!found.length) return res.status(404).json({ error: 'Not found' });

      // Auto-mark as done
      await setDone(id, true);

      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition',
        `attachment; filename="${encodeURIComponent(found[0].filename)}"`);
      bucket.openDownloadStream(_id).pipe(res);
      return;
    }

    // ===== MARK DONE / UNDONE =====
    if (action === 'markdone') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
      const { id, done } = await readBody(req);
      if (!id) return res.status(400).json({ error: 'Missing id' });
      await setDone(id, done !== false);
      return res.status(200).json({ success: true, id, status: done !== false ? 'done' : 'pending' });
    }

    // ===== DELETE =====
    if (action === 'delete') {
      if (req.method !== 'DELETE' && req.method !== 'POST')
        return res.status(405).json({ error: 'DELETE or POST only' });
      let id = req.query.id;
      if (!id && req.method === 'POST') {
        const body = await readBody(req);
        id = body.id;
      }
      if (!id) return res.status(400).json({ error: 'Missing id' });
      await deleteFileRecord(id);
      return res.status(200).json({ success: true, id });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('[admin]', err);
    return res.status(500).json({ error: err.message });
  }
}

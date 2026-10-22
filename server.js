'use strict';
/*
 * Batman License Manager — سرور مدیریت لایسنس
 * -------------------------------------------------
 * تغییرات نسبت به نسخه‌ی قبلی:
 *  - هر لایسنس با HMAC-SHA256 امضا می‌شود (کلید مخفی فقط روی همین سرور است).
 *    یعنی هیچ‌کس بدون دسترسی به این سرور نمی‌تواند یک کلید معتبر جعل کند،
 *    چون تطبیق امضا سمت سرور چک می‌شود نه سمت کلاینت.
 *  - اتصال WebSocket برای اعلام آنیِ غیرفعال‌سازی/فعال‌سازی به پنل‌های مشتری
 *    (در کنار polling سریع سمت کلاینت، تا اگر وب‌سوکت در دسترس نبود هم کار کند).
 *  - رمز ادمین و تمام داده‌ها با همان اسکریپت قبلی (scrypt) هش می‌شوند؛
 *    دیتابیس هم اکنون فایلش chmod 600 و پوشه 700 است (بدون تغییر منطقی، تأکید مجدد).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { WebSocketServer } = require('./lib/ws-lite');

const PORT = parseInt(process.env.PORT || '3200', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || '/var/lib/batman-license';
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SECRET_FILE = path.join(DATA_DIR, 'hmac.secret');
const SESSION_MS = 7 * 24 * 3600 * 1000;

// ---------- راز امضا (HMAC secret) ----------
// یک‌بار ساخته می‌شود و فقط روی دیسک همین سرور باقی می‌ماند؛ هرگز به کلاینت فرستاده نمی‌شود.
function loadOrCreateSecret() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  if (fs.existsSync(SECRET_FILE)) {
    return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  return secret;
}
const HMAC_SECRET = loadOrCreateSecret();

function sign(payload) {
  return crypto.createHmac('sha256', HMAC_SECRET).update(payload).digest('hex');
}

// ---------- utils ----------
function hashPassword(pass) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pass, salt, 64).toString('hex');
  return salt + ':' + hash;
}
function checkPassword(pass, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const h = crypto.scryptSync(pass, salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(h, 'hex'));
  } catch (e) { return false; }
}
function uid() { return crypto.randomBytes(8).toString('hex'); }
function msgId() { return crypto.randomBytes(10).toString('hex'); }

// کلید لایسنس: BAT-xxxx-xxxx-xxxx-xxxx-SIGNATURE8
// بخش آخر، ۸ کاراکتر اول امضای HMAC روی بخش‌های قبلی کلید است.
// این یعنی هیچ کلیدی را نمی‌توان بدون دانستن HMAC_SECRET ساخت و معتبر جا زد؛
// حتی اگر کسی فایل db.json را ببیند یا کد سرور مشتری را دیکامپایل کند، امضا را نمی‌تواند بسازد.
function genKey() {
  const parts = [];
  for (let i = 0; i < 4; i++) parts.push(crypto.randomBytes(3).toString('hex').toUpperCase());
  const body = 'BAT-' + parts.join('-');
  const sig = sign(body).toUpperCase().slice(0, 8);
  return body + '-' + sig;
}
function verifyKeySignature(key) {
  const idx = key.lastIndexOf('-');
  if (idx < 0) return false;
  const body = key.slice(0, idx);
  const sig = key.slice(idx + 1);
  if (sig.length !== 8) return false;
  const expected = sign(body).toUpperCase().slice(0, 8);
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch (e) { return false; }
}
function now() { return Date.now(); }

// ---------- db ----------
function defaults() {
  return {
    version: 2,
    admin: { username: 'admin', passHash: '' },
    licenses: [],
    settings: { brandTitle: 'Batman License Manager' },
  };
}

let data = null;
function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  if (fs.existsSync(DB_FILE)) {
    try {
      data = Object.assign(defaults(), JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
      data.admin = Object.assign(defaults().admin, data.admin || {});
      data.settings = Object.assign(defaults().settings, data.settings || {});
    } catch (e) {
      console.error('db corrupt, using defaults');
      data = defaults();
    }
  } else {
    data = defaults();
  }
  return data;
}
function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DB_FILE);
}

// ---------- sessions ----------
const sessions = new Map();
setInterval(() => {
  const t = now();
  for (const [k, s] of sessions) if (s.exp < t) sessions.delete(k);
}, 60000).unref();

// ---------- اتصالات زنده‌ی پنل‌های مشتری (WebSocket push) ----------
// هر پنل مشتری با کلید لایسنس خودش وصل می‌شود؛ وقتی ادمین آن لایسنس را
// غیرفعال/فعال/حذف/ویرایش کند بلافاصله یک پیام push برایش می‌فرستیم
// تا منتظر دور بعدی polling نماند.
const liveClients = new Map(); // key(license) -> Set(ws)   -- فقط پنل مشتری (برای نشان "آنلاین")
const adminWatchers = new Map(); // key(license) -> Set(ws)  -- پنل مدیریت که این لایسنس را باز کرده (چت زنده)
function registerLiveClient(map, key, ws) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(ws);
}
function unregisterLiveClient(map, key, ws) {
  const s = map.get(key);
  if (!s) return;
  s.delete(ws);
  if (s.size === 0) map.delete(key);
}
function pushToLicense(key, msg) {
  const payload = JSON.stringify(msg);
  const targets = [liveClients.get(key), adminWatchers.get(key)];
  for (const s of targets) {
    if (!s) continue;
    for (const ws of s) {
      try { ws.send(payload); } catch (e) { /* ignore */ }
    }
  }
}

// ---------- http helpers ----------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}
function parseCookies(h) {
  const out = {};
  String(h || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------- routes ----------
const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, handler });
}

function authed(req) {
  const cookies = parseCookies(req.headers.cookie);
  const t = cookies.batman_lic_sid;
  const s = t && sessions.get(t);
  if (!s || s.exp < now()) return null;
  return s;
}

// Public: validate license (used by client panels)
// شناسایی سرور مشتری دیگر فقط با IP نیست: یک «اثر انگشت» پایدار (fingerprint،
// مشتق‌شده از کلید عمومی CA همان سرور OpenVPN) هم پذیرفته می‌شود که با تانل،
// پراکسی یا تغییر IP از بین نمی‌رود. در فعال‌سازی اول، لایسنس به همان
// fingerprint قفل می‌شود (trust-on-first-use)، دقیقاً مثل منطق قبلی IP.
// اگر لایسنس از قبل یک IP مشخص داشته باشد، آن IP هم باید مطابقت داشته باشد؛
// اگر IP لایسنس خالی باشد (دستی خالی گذاشته شده)، فقط fingerprint کافی است.
route('POST', '/api/validate', async (req, res) => {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { valid: false, error: 'invalid json' }); }
  const key = String(body.license_key || body.key || '').trim().toUpperCase();
  const clientIp = String(body.client_ip || body.ip || '').trim();
  const clientFp = String(body.client_fingerprint || body.fingerprint || '').trim();
  if (!key || (!clientIp && !clientFp)) {
    return sendJson(res, 400, { valid: false, error: 'key و حداقل یکی از client_ip یا client_fingerprint لازم است' });
  }

  // اول امضای کلید چک می‌شود؛ اگر کلید دست‌ساز/جعلی باشد حتی اگر در دیتابیس
  // هم (با دستکاری فایل) پیدا شود، بدون امضای معتبر رد می‌شود.
  if (!verifyKeySignature(key)) {
    return sendJson(res, 200, { valid: false, error: 'لایسنس نامعتبر است (امضا تأیید نشد)' });
  }

  const lic = data.licenses.find(l => l.key === key);
  if (!lic) return sendJson(res, 200, { valid: false, error: 'لایسنس پیدا نشد' });
  if (!lic.active) return sendJson(res, 200, { valid: false, error: 'لایسنس غیرفعال است' });

  // قفل‌شدن به fingerprint در اولین اتصال (trust-on-first-use)
  if (clientFp) {
    if (!lic.fingerprint) {
      lic.fingerprint = clientFp;
    } else if (lic.fingerprint !== clientFp) {
      return sendJson(res, 200, { valid: false, error: 'این لایسنس قبلاً برای سرور دیگری فعال شده است' });
    }
  }
  // IP فقط وقتی چک می‌شود که لایسنس از قبل یک IP مشخص داشته باشد (اختیاری)
  if (lic.ip && clientIp && lic.ip !== clientIp) {
    return sendJson(res, 200, { valid: false, error: 'این لایسنس برای IP دیگری صادر شده است' });
  }
  if (lic.expiresAt && lic.expiresAt < now()) return sendJson(res, 200, { valid: false, error: 'لایسنس منقضی شده است' });

  if (!lic.activatedAt) {
    lic.activatedAt = now();
    lic.lastCheck = now();
    saveDb();
  } else {
    lic.lastCheck = now();
    if (!lic._dirty) {
      lic._dirty = true;
      setTimeout(() => { delete lic._dirty; saveDb(); }, 5000);
    }
  }

  sendJson(res, 200, {
    valid: true,
    expiresAt: lic.expiresAt || null,
    note: lic.note || '',
    message: 'لایسنس معتبر است',
  });
});

// Auth
route('POST', '/api/login', async (req, res) => {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'invalid json' }); }
  const user = String(body.username || '').trim();
  const pass = String(body.password || '');
  if (user !== data.admin.username || !checkPassword(pass, data.admin.passHash)) {
    return sendJson(res, 401, { error: 'نام کاربری یا رمز عبور اشتباه است' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { role: 'admin', exp: now() + SESSION_MS });
  res.setHeader('Set-Cookie', `batman_lic_sid=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`);
  sendJson(res, 200, { ok: true, username: data.admin.username });
});

route('POST', '/api/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.batman_lic_sid) sessions.delete(cookies.batman_lic_sid);
  res.setHeader('Set-Cookie', 'batman_lic_sid=; Path=/; HttpOnly; Max-Age=0');
  sendJson(res, 200, { ok: true });
});

route('GET', '/api/me', (req, res) => {
  const s = authed(req);
  if (!s) return sendJson(res, 401, { error: 'unauthorized' });
  sendJson(res, 200, { username: data.admin.username, brandTitle: data.settings.brandTitle });
});

// Licenses CRUD (admin only)
route('GET', '/api/licenses', (req, res) => {
  if (!authed(req)) return sendJson(res, 401, { error: 'unauthorized' });
  const list = data.licenses.map(l => {
    const msgs = l.messages || [];
    const lastMsg = msgs.length ? msgs[msgs.length - 1] : null;
    return {
      id: l.id,
      key: l.key,
      ip: l.ip,
      fingerprint: l.fingerprint ? l.fingerprint.slice(0, 12) : null,
      note: l.note || '',
      active: l.active,
      createdAt: l.createdAt,
      expiresAt: l.expiresAt,
      activatedAt: l.activatedAt,
      lastCheck: l.lastCheck,
      daysLeft: l.expiresAt ? Math.ceil((l.expiresAt - now()) / 86400000) : null,
      online: liveClients.has(l.key),
      unreadForAdmin: l.unreadForAdmin || 0,
      lastMessage: lastMsg ? { from: lastMsg.from, text: lastMsg.text, at: lastMsg.at } : null,
    };
  }).sort((a, b) => b.createdAt - a.createdAt);
  sendJson(res, 200, list);
});

route('POST', '/api/licenses', async (req, res) => {
  if (!authed(req)) return sendJson(res, 401, { error: 'unauthorized' });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'invalid json' }); }

  // IP اکنون اختیاری است: برای سرورهای پشت تانل/پراکسی که IP واقعی‌شان با
  // چیزی که به مشتری دادی فرق دارد، این فیلد را خالی بگذار و شناسایی فقط با
  // «اثر انگشت» سرور (fingerprint، در فعال‌سازی اول ثبت می‌شود) انجام می‌شود.
  const ip = String(body.ip || '').trim();
  if (ip && !/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && !/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(ip)) {
    return sendJson(res, 400, { error: 'IP یا دامنه معتبر وارد کنید، یا این فیلد را کاملاً خالی بگذارید' });
  }
  const days = body.days === null || body.days === undefined || body.days === '' ? null : parseInt(body.days, 10);
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) {
    return sendJson(res, 400, { error: 'تعداد روز باید بین ۱ تا ۳۶۵۰ باشد یا خالی (دائمی)' });
  }
  const note = String(body.note || '').trim().slice(0, 200);

  let key;
  do { key = genKey(); } while (data.licenses.some(l => l.key === key));

  const lic = {
    id: uid(),
    key,
    ip,                      // می‌تواند خالی باشد (یعنی چک IP غیرفعال است)
    fingerprint: null,       // در اولین اتصال واقعی پر می‌شود (trust-on-first-use)
    note,
    active: true,
    createdAt: now(),
    expiresAt: days ? now() + days * 86400000 : null,
    activatedAt: null,
    lastCheck: null,
    messages: [],           // گفتگوی اختصاصی این لایسنس با مدیر (هر لایسنس کاملاً جدا)
    unreadForAdmin: 0,      // تعداد پیام خوانده‌نشده از طرف مشتری (برای نمایش در لیست)
  };
  data.licenses.push(lic);
  saveDb();
  sendJson(res, 200, {
    id: lic.id,
    key: lic.key,
    ip: lic.ip,
    note: lic.note,
    active: true,
    createdAt: lic.createdAt,
    expiresAt: lic.expiresAt,
    daysLeft: days,
  });
});

route('PATCH', '/api/licenses/:id', async (req, res) => {
  if (!authed(req)) return sendJson(res, 401, { error: 'unauthorized' });
  const id = req.params.id;
  const lic = data.licenses.find(l => l.id === id);
  if (!lic) return sendJson(res, 404, { error: 'پیدا نشد' });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'invalid json' }); }

  let stateChanged = false;
  if (body.active !== undefined) {
    const wasActive = lic.active;
    lic.active = !!body.active;
    if (wasActive !== lic.active) stateChanged = true;
  }
  if (body.note !== undefined) lic.note = String(body.note).trim().slice(0, 200);
  if (body.ip !== undefined) {
    const ip = String(body.ip).trim();
    // IP را می‌توان کاملاً خالی گذاشت (یعنی چک IP غیرفعال شود، فقط fingerprint ملاک باشد)
    if (ip && !/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && !/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(ip)) {
      return sendJson(res, 400, { error: 'IP نامعتبر' });
    }
    if (lic.ip !== ip) stateChanged = true;
    lic.ip = ip;
  }
  if (body.resetFingerprint === true) {
    // برای وقتی مشتری سرورش را عوض کرده و باید دوباره روی سرور جدید فعال شود
    lic.fingerprint = null;
    stateChanged = true;
  }
  if (body.extendDays !== undefined) {
    const d = parseInt(body.extendDays, 10);
    if (!Number.isInteger(d) || d < 1) return sendJson(res, 400, { error: 'روز نامعتبر' });
    const base = (lic.expiresAt && lic.expiresAt > now()) ? lic.expiresAt : now();
    lic.expiresAt = base + d * 86400000;
    stateChanged = true;
  }
  if (body.makePermanent === true) { lic.expiresAt = null; stateChanged = true; }
  saveDb();

  // بلافاصله به پنل مشتریِ همین لایسنس (اگر وصل است) اطلاع بده تا دیگر
  // منتظر دور بعدی polling نماند — قفل یا بازشدن آنی.
  if (stateChanged) {
    pushToLicense(lic.key, { type: 'license_changed', active: lic.active, at: now() });
  }
  sendJson(res, 200, { ok: true });
});

route('DELETE', '/api/licenses/:id', (req, res) => {
  if (!authed(req)) return sendJson(res, 401, { error: 'unauthorized' });
  const id = req.params.id;
  const idx = data.licenses.findIndex(l => l.id === id);
  if (idx < 0) return sendJson(res, 404, { error: 'پیدا نشد' });
  const lic = data.licenses[idx];
  data.licenses.splice(idx, 1);
  saveDb();
  pushToLicense(lic.key, { type: 'license_changed', active: false, at: now(), deleted: true });
  sendJson(res, 200, { ok: true });
});

// ---------- گفتگوی اختصاصی هر لایسنس (مدیر <-> مشتری همان لایسنس) ----------
// هر لایسنس یک گفتگوی کاملاً جدا و مستقل دارد؛ مدیر فقط پیام‌های همان
// لایسنسی که انتخاب کرده را می‌بیند، و مشتری هم فقط گفتگوی لایسنس خودش را.

// مدیر: خواندن کل گفتگوی یک لایسنس (و صفر کردن شمارنده‌ی نخوانده)
route('GET', '/api/licenses/:id/messages', (req, res) => {
  if (!authed(req)) return sendJson(res, 401, { error: 'unauthorized' });
  const lic = data.licenses.find(l => l.id === req.params.id);
  if (!lic) return sendJson(res, 404, { error: 'پیدا نشد' });
  if (lic.unreadForAdmin) { lic.unreadForAdmin = 0; saveDb(); }
  sendJson(res, 200, lic.messages || []);
});

// مدیر: ارسال پیام به مشتری یک لایسنس خاص
route('POST', '/api/licenses/:id/messages', async (req, res) => {
  if (!authed(req)) return sendJson(res, 401, { error: 'unauthorized' });
  const lic = data.licenses.find(l => l.id === req.params.id);
  if (!lic) return sendJson(res, 404, { error: 'پیدا نشد' });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'invalid json' }); }
  const text = String(body.text || '').trim().slice(0, 2000);
  if (!text) return sendJson(res, 400, { error: 'متن پیام خالی است' });

  const msg = { id: msgId(), from: 'admin', text, at: now(), readByCustomer: false };
  if (!lic.messages) lic.messages = [];
  lic.messages.push(msg);
  saveDb();

  // اگر پنل مشتری همین الان وصل است، پیام را بلافاصله push کن
  pushToLicense(lic.key, { type: 'new_message', message: msg });

  sendJson(res, 200, msg);
});

// مشتری (پنل VPN): خواندن گفتگوی لایسنس خودش — با کلید لایسنس احراز هویت می‌شود،
// نه کوکی ادمین؛ یعنی هر پنل فقط به گفتگوی لایسنس خودش دسترسی دارد و لایسنس‌ها
// کاملاً از هم جدا هستند.
route('POST', '/api/client/messages', async (req, res) => {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'invalid json' }); }
  const key = String(body.license_key || body.key || '').trim().toUpperCase();
  if (!key || !verifyKeySignature(key)) return sendJson(res, 403, { error: 'لایسنس نامعتبر' });
  const lic = data.licenses.find(l => l.key === key);
  if (!lic) return sendJson(res, 404, { error: 'لایسنس پیدا نشد' });

  // خواندن از طرف مشتری: پیام‌های مدیر را "خوانده‌شده" علامت بزن
  let changed = false;
  for (const m of (lic.messages || [])) {
    if (m.from === 'admin' && !m.readByCustomer) { m.readByCustomer = true; changed = true; }
  }
  if (changed) saveDb();
  sendJson(res, 200, lic.messages || []);
});

// مشتری (پنل VPN): ارسال پیام به مدیر، برای لایسنس خودش
route('POST', '/api/client/messages/send', async (req, res) => {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'invalid json' }); }
  const key = String(body.license_key || body.key || '').trim().toUpperCase();
  const text = String(body.text || '').trim().slice(0, 2000);
  if (!key || !verifyKeySignature(key)) return sendJson(res, 403, { error: 'لایسنس نامعتبر' });
  if (!text) return sendJson(res, 400, { error: 'متن پیام خالی است' });
  const lic = data.licenses.find(l => l.key === key);
  if (!lic) return sendJson(res, 404, { error: 'لایسنس پیدا نشد' });

  const msg = { id: msgId(), from: 'customer', text, at: now(), readByCustomer: true };
  if (!lic.messages) lic.messages = [];
  lic.messages.push(msg);
  lic.unreadForAdmin = (lic.unreadForAdmin || 0) + 1;
  saveDb();

  sendJson(res, 200, msg);
});

// Change password
route('POST', '/api/change-password', async (req, res) => {
  if (!authed(req)) return sendJson(res, 401, { error: 'unauthorized' });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'invalid json' }); }
  const oldPass = String(body.oldPassword || '');
  const newPass = String(body.newPassword || '');
  if (!checkPassword(oldPass, data.admin.passHash)) return sendJson(res, 400, { error: 'رمز فعلی اشتباه است' });
  if (newPass.length < 8) return sendJson(res, 400, { error: 'رمز جدید حداقل ۸ کاراکتر' });
  data.admin.passHash = hashPassword(newPass);
  saveDb();
  sendJson(res, 200, { ok: true });
});

// ---------- static + server ----------
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function handle(req, res) {
  const u = new URL(req.url || '/', 'http://x');
  const pathname = u.pathname;

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = pathname.match(r.re);
    if (!m) continue;
    req.params = {};
    r.keys.forEach((k, i) => { req.params[k] = decodeURIComponent(m[i + 1]); });
    try {
      await r.handler(req, res);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    }
    return;
  }

  let file = pathname === '/' ? '/index.html' : pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404); res.end('Not Found');
    return;
  }
  const ext = path.extname(full);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(full).pipe(res);
}

// ---------- start ----------
loadDb();
if (!data.admin.passHash) {
  console.error('ادمین ساخته نشده. ابتدا اجرا کنید: node cli.js init');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
  });
});

// وب‌سوکت سبک برای push آنی به پنل‌های مشتری. کلاینت به
// ws(s)://HOST:PORT/ws/license?key=KEY وصل می‌شود.
const wss = new WebSocketServer({ server, path: '/ws/license' });
wss.on('connection', (ws, req) => {
  const u = new URL(req.url, 'http://x');
  const key = String(u.searchParams.get('key') || '').trim().toUpperCase();
  const role = String(u.searchParams.get('role') || '').trim();
  if (!key || !verifyKeySignature(key)) { try { ws.close(); } catch (e) {} return; }

  if (role === 'admin-watch') {
    // این اتصال از پنل مدیریت است (برای دیدن زنده‌ی چت)؛ روی وضعیت
    // "آنلاین بودن مشتری" در لیست لایسنس‌ها هیچ تاثیری نباید بگذارد،
    // و بدون احراز هویت کوکی معتبر ادمین هم پذیرفته نمی‌شود — در غیر این
    // صورت هرکسی که فقط یک کلید لایسنس را بداند می‌توانست چت را بشنود.
    if (!authed(req)) { try { ws.close(); } catch (e) {} return; }
    registerLiveClient(adminWatchers, key, ws);
    ws.on('close', () => unregisterLiveClient(adminWatchers, key, ws));
    ws.on('error', () => unregisterLiveClient(adminWatchers, key, ws));
    return;
  }

  // اتصال پنل مشتری (VPN panel) — همان چیزی که "آنلاین" را نشان می‌دهد
  registerLiveClient(liveClients, key, ws);
  ws.on('close', () => unregisterLiveClient(liveClients, key, ws));
  ws.on('error', () => unregisterLiveClient(liveClients, key, ws));
});

server.listen(PORT, HOST, () => {
  console.log(`Batman License Manager running on http://${HOST}:${PORT}`);
});

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const DATA_DIR = process.env.DATA_DIR || '/var/lib/batman-license';
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SECRET_FILE = path.join(DATA_DIR, 'hmac.secret');

function hashPassword(pass) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pass, salt, 64).toString('hex');
  return salt + ':' + hash;
}

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(q, ans => { rl.close(); resolve(ans); }));
}

async function init() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  let data = { version: 2, admin: { username: 'admin', passHash: '' }, licenses: [], settings: { brandTitle: 'Batman License Manager' } };
  if (fs.existsSync(DB_FILE)) {
    try { data = Object.assign(data, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch {}
  }

  console.log('=== راه‌اندازی پنل مدیریت لایسنس Batman ===\n');
  const user = (await ask('نام کاربری ادمین [' + (data.admin.username || 'admin') + ']: ')).trim() || data.admin.username || 'admin';
  let pass = '';
  while (pass.length < 8) {
    pass = await ask('رمز عبور (حداقل ۸ کاراکتر): ');
    if (pass.length < 8) console.log('رمز کوتاه است.');
  }

  data.admin.username = user;
  data.admin.passHash = hashPassword(pass);
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });

  // کلید امضای HMAC هم همین‌جا (در صورت نبودن) ساخته می‌شود تا از همان
  // لحظه‌ی اول هر لایسنسی که صادر می‌شود دارای امضای معتبر و غیرقابل‌جعل باشد.
  if (!fs.existsSync(SECRET_FILE)) {
    fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    console.log('✓ کلید امضای HMAC ساخته شد (' + SECRET_FILE + ')');
  }

  console.log('\n✓ ادمین ساخته شد.');
  console.log('  فایل دیتابیس:', DB_FILE);
  console.log('  حالا سرویس را استارت کنید یا: node server.js');
}

const cmd = process.argv[2];
if (cmd === 'init') init().catch(e => { console.error(e); process.exit(1); });
else {
  console.log('استفاده: node cli.js init');
  process.exit(1);
}

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_ID = String(process.env.ADMIN_TELEGRAM_ID || '');
const USERNAME = String(process.env.MY_TELEGRAM_USERNAME || '').replace(/^@/, '');
const dataDir = path.dirname(path.resolve(process.env.DATABASE_PATH || './data/minecraft-stars.sqlite'));
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.resolve(process.env.DATABASE_PATH || './data/minecraft-stars.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  telegram_id TEXT PRIMARY KEY, username TEXT, first_name TEXT, last_name TEXT,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, last_check TEXT,
  completed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sponsors (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, channel_id TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '⭐', description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1, required INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_status (
  telegram_id TEXT NOT NULL, sponsor_id TEXT NOT NULL, is_member INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'not_checked', checked_at TEXT, api_status TEXT,
  PRIMARY KEY (telegram_id, sponsor_id),
  FOREIGN KEY (telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, type TEXT NOT NULL,
  telegram_id TEXT, details TEXT NOT NULL DEFAULT ''
);
`);
const now = () => new Date().toISOString();
const logEvent = (type, telegramId, details = '') => db.prepare('INSERT INTO events(created_at,type,telegram_id,details) VALUES(?,?,?,?)').run(now(), type, telegramId == null ? null : String(telegramId), String(details).slice(0, 500));
const starterSponsors = require('./config/sponsors');
if (db.prepare('SELECT COUNT(*) AS n FROM sponsors').get().n === 0) {
  const insert = db.prepare(`INSERT INTO sponsors(id,name,url,channel_id,icon,description,enabled,required,sort_order,updated_at) VALUES(@id,@name,@url,@channelId,@icon,@description,@enabled,@required,@sortOrder,?)`);
  const tx = db.transaction(items => items.forEach(s => insert.run({ ...s, enabled: s.enabled ? 1 : 0, required: s.required ? 1 : 0 }, now())));
  tx(starterSponsors);
}

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: true, legacyHeaders: false }));
app.use((req, res, next) => {
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin;
  if (origin && allowed.length && allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Telegram-Init-Data');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function validateInitData(initData) {
  if (!BOT_TOKEN) throw Object.assign(new Error('Сервер не налаштовано: відсутній BOT_TOKEN.'), { status: 503 });
  if (typeof initData !== 'string' || !initData || initData.length > 20_000) throw Object.assign(new Error('Відсутні дані Telegram. Відкрий Mini App через Telegram.'), { status: 401 });
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  if (!hash || !Number.isFinite(authDate)) throw Object.assign(new Error('Некоректні дані Telegram.'), { status: 401 });
  const age = Math.floor(Date.now() / 1000) - authDate;
  if (age < -60 || age > 86_400) throw Object.assign(new Error('Дані входу застаріли. Перезапусти Mini App.'), { status: 401 });
  params.delete('hash');
  const checkString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calculated = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
  const a = Buffer.from(calculated, 'hex'); const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw Object.assign(new Error('Не вдалося перевірити підпис Telegram.'), { status: 401 });
  let user;
  try { user = JSON.parse(params.get('user') || 'null'); } catch { user = null; }
  if (!user || !user.id) throw Object.assign(new Error('Telegram не передав дані користувача.'), { status: 401 });
  return user;
}
function auth(req, res, next) {
  try {
    const user = validateInitData(req.get('X-Telegram-Init-Data') || '');
    req.tgUser = user;
    const stamp = now();
    db.prepare(`INSERT INTO users(telegram_id,username,first_name,last_name,first_seen,last_seen)
      VALUES(?,?,?,?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET username=excluded.username, first_name=excluded.first_name, last_name=excluded.last_name,last_seen=excluded.last_seen`)
      .run(String(user.id), user.username || null, user.first_name || null, user.last_name || null, stamp, stamp);
    next();
  } catch (e) { res.status(e.status || 401).json({ error: e.message || 'Помилка авторизації.' }); }
}
function admin(req, res, next) {
  if (!ADMIN_ID || !/^\d+$/.test(ADMIN_ID)) return res.status(503).json({ error: 'Не налаштовано ADMIN_TELEGRAM_ID у .env.' });
  if (String(req.tgUser.id) !== ADMIN_ID) return res.status(403).json({ error: 'Доступ заборонено.' });
  next();
}
function sponsors() { return db.prepare('SELECT * FROM sponsors ORDER BY sort_order,id').all(); }
function statusForUser(telegramId) {
  const enabled = sponsors().filter(s => s.enabled && s.required);
  const statuses = db.prepare('SELECT sponsor_id,is_member,status,checked_at,api_status FROM task_status WHERE telegram_id=?').all(String(telegramId));
  const map = new Map(statuses.map(s => [s.sponsor_id, s]));
  const tasks = enabled.map(s => ({ id:s.id, name:s.name, url:s.url, icon:s.icon, description:s.description,
    confirmed: !!map.get(s.id)?.is_member, status: map.get(s.id)?.status || 'not_checked', checkedAt: map.get(s.id)?.checked_at || null }));
  const done = tasks.filter(t => t.confirmed).length;
  return { tasks, done, total: tasks.length, progress: tasks.length ? Math.round(done / tasks.length * 100) : 100, completed: done === tasks.length };
}
async function telegram(method, params) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params)
  });
  const json = await response.json().catch(() => null);
  if (!response.ok || !json?.ok) {
    const err = new Error(json?.description || `Telegram API error (${response.status})`);
    err.telegramDescription = json?.description || `HTTP ${response.status}`;
    throw err;
  }
  return json.result;
}
function memberStatus(result) { return ['creator','administrator','member'].includes(result.status) || (result.status === 'restricted' && result.is_member === true); }

app.get('/api/config', (req,res) => res.json({ appName:'Minecraft Stars', usernameConfigured: !!USERNAME }));
app.get('/api/me', auth, (req,res) => res.json({ user:{ id:String(req.tgUser.id), username:req.tgUser.username || null }, ...statusForUser(req.tgUser.id), lastCheck: db.prepare('SELECT last_check FROM users WHERE telegram_id=?').get(String(req.tgUser.id))?.last_check || null }));
app.post('/api/check', auth, async (req,res) => {
  const uid = String(req.tgUser.id); const list = sponsors().filter(s => s.enabled && s.required); const checkedAt = now();
  const update = db.prepare(`INSERT INTO task_status(telegram_id,sponsor_id,is_member,status,checked_at,api_status) VALUES(?,?,?,?,?,?)
    ON CONFLICT(telegram_id,sponsor_id) DO UPDATE SET is_member=excluded.is_member,status=excluded.status,checked_at=excluded.checked_at,api_status=excluded.api_status`);
  const tx = db.transaction(rows => rows.forEach(r => update.run(uid,r.id,r.member?1:0,r.status,checkedAt,r.apiStatus)));
  const rows = [];
  for (const s of list) {
    try {
      const member = await telegram('getChatMember', { chat_id: s.channel_id, user_id: Number(uid) });
      const isMember = memberStatus(member);
      rows.push({ id:s.id, member:isMember, status:isMember?'confirmed':'not_subscribed', apiStatus:member.status });
    } catch (e) {
      rows.push({ id:s.id, member:false, status:'error', apiStatus:e.telegramDescription || e.message });
    }
  }
  tx(rows);
  db.prepare('UPDATE users SET last_check=?,completed=? WHERE telegram_id=?').run(checkedAt, rows.every(r=>r.member)?1:0, uid);
  logEvent(rows.some(r=>r.status==='error')?'subscription_check_error':'subscription_check', uid, `${rows.filter(r=>r.member).length}/${list.length} confirmed`);
  const result = statusForUser(uid);
  const errors = rows.filter(r=>r.status==='error');
  if (errors.length) return res.status(502).json({ ...result, error:'Не вдалося перевірити частину каналів. Переконайся, що бот є адміністратором каналів, і повтори перевірку.', failedIds:errors.map(e=>e.id) });
  if (result.completed) logEvent('all_tasks_completed', uid, 'All required subscriptions confirmed');
  res.json(result);
});
app.get('/api/telegram-link', auth, (req,res) => {
  if (!/^[A-Za-z0-9_]{5,32}$/.test(USERNAME)) return res.status(503).json({ error:'Власник ще не налаштував MY_TELEGRAM_USERNAME у .env.' });
  res.json({ url:`https://t.me/${USERNAME}` });
});

// Admin API: every route uses verified Telegram initData AND a server-side ID check.
const adminRouter = express.Router();
adminRouter.use(auth, admin);
adminRouter.get('/overview', (req,res) => {
  const counts = db.prepare(`SELECT COUNT(*) total, SUM(CASE WHEN completed=1 THEN 1 ELSE 0 END) complete,
    SUM(CASE WHEN completed=0 AND last_check IS NOT NULL THEN 1 ELSE 0 END) partial,
    SUM(CASE WHEN last_check IS NULL THEN 1 ELSE 0 END) untouched FROM users`).get();
  const tasks = db.prepare('SELECT COUNT(*) n FROM task_status WHERE is_member=1').get().n;
  const last = db.prepare('SELECT MAX(created_at) t FROM events').get().t;
  res.json({ total:counts.total||0, complete:counts.complete||0, partial:counts.partial||0, untouched:counts.untouched||0, pending:Math.max(0,(counts.total||0)-(counts.complete||0)), confirmedTasks:tasks, lastEvent:last });
});
adminRouter.get('/users', (req,res) => {
  const page = Math.max(1, Math.min(100000, Number(req.query.page)||1)); const limit = 25;
  const search = String(req.query.search||'').slice(0,100); const sort = ['first_seen','last_seen','completed'].includes(req.query.sort) ? req.query.sort : 'last_seen';
  const where = search ? `WHERE telegram_id LIKE @q OR username LIKE @q OR first_name LIKE @q OR last_name LIKE @q` : '';
  const rows = db.prepare(`SELECT * FROM users ${where} ORDER BY ${sort==='completed'?'completed DESC, last_seen DESC':sort+' DESC'} LIMIT @limit OFFSET @offset`).all({ q:`%${search}%`, limit, offset:(page-1)*limit });
  const total = db.prepare(`SELECT COUNT(*) n FROM users ${where}`).get({q:`%${search}%`}).n;
  const output = rows.map(u => ({ id:u.telegram_id, username:u.username, firstName:u.first_name, lastName:u.last_name, firstSeen:u.first_seen,lastSeen:u.last_seen,lastCheck:u.last_check, ...statusForUser(u.telegram_id) }));
  res.json({ users:output, total, page, pages:Math.max(1,Math.ceil(total/limit)) });
});
adminRouter.get('/users/:id', (req,res) => {
  const u = db.prepare('SELECT * FROM users WHERE telegram_id=?').get(String(req.params.id));
  if (!u) return res.status(404).json({error:'Користувача не знайдено.'});
  const detail = statusForUser(u.telegram_id);
  const taskRows = db.prepare('SELECT sponsor_id,status,checked_at,api_status FROM task_status WHERE telegram_id=?').all(u.telegram_id);
  const statuses = new Map(taskRows.map(x=>[x.sponsor_id,x]));
  res.json({ user:{id:u.telegram_id,username:u.username,firstName:u.first_name,lastName:u.last_name,firstSeen:u.first_seen,lastSeen:u.last_seen,lastCheck:u.last_check}, ...detail,
    tasks:sponsors().filter(s=>s.enabled).map(s=>({id:s.id,name:s.name,required:!!s.required,confirmed:!!statuses.get(s.id)?.is_member,status:statuses.get(s.id)?.status||'not_checked',checkedAt:statuses.get(s.id)?.checked_at||null,apiStatus:statuses.get(s.id)?.api_status||null})) });
});
adminRouter.post('/users/:id/check', async (req,res) => {
  // Recheck through the same official Telegram API; never manually force a success state.
  const userId = String(req.params.id);
  if (!/^\d+$/.test(userId) || !db.prepare('SELECT 1 FROM users WHERE telegram_id=?').get(userId)) return res.status(404).json({error:'Користувача не знайдено.'});
  const list = sponsors().filter(s=>s.enabled&&s.required); const checkedAt=now(); const rows=[];
  for (const s of list) { try { const m=await telegram('getChatMember',{chat_id:s.channel_id,user_id:Number(userId)}); const yes=memberStatus(m); rows.push({id:s.id,member:yes,status:yes?'confirmed':'not_subscribed',apiStatus:m.status}); }
    catch(e){rows.push({id:s.id,member:false,status:'error',apiStatus:e.telegramDescription||e.message});} }
  const tx=db.transaction(items=>items.forEach(r=>db.prepare(`INSERT INTO task_status(telegram_id,sponsor_id,is_member,status,checked_at,api_status) VALUES(?,?,?,?,?,?) ON CONFLICT(telegram_id,sponsor_id) DO UPDATE SET is_member=excluded.is_member,status=excluded.status,checked_at=excluded.checked_at,api_status=excluded.api_status`).run(userId,r.id,r.member?1:0,r.status,checkedAt,r.apiStatus)));
  tx(rows); db.prepare('UPDATE users SET last_check=?,completed=? WHERE telegram_id=?').run(checkedAt,rows.every(r=>r.member)?1:0,userId); logEvent('admin_recheck',req.tgUser.id,`Rechecked user ${userId}`);
  res.json(statusForUser(userId));
});
adminRouter.get('/sponsors', (req,res)=>res.json(sponsors().map(s=>({...s,enabled:!!s.enabled,required:!!s.required}))));
adminRouter.post('/sponsors', (req,res)=>{
  const {id,name,url,channelId,icon='⭐',description='',enabled=true,required=true,sortOrder=0}=req.body||{};
  if (!/^[a-zA-Z0-9_-]{2,80}$/.test(String(id||'')) || !String(name||'').trim() || !/^https:\/\/t\.me\//.test(String(url||'')) || !/^(-100\d+|@?[A-Za-z0-9_]{5,})$/.test(String(channelId||''))) return res.status(400).json({error:'Перевір ID, назву, URL формату https://t.me/... та Telegram chat ID/username каналу.'});
  try { db.prepare(`INSERT INTO sponsors(id,name,url,channel_id,icon,description,enabled,required,sort_order,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(String(id),String(name).trim(),String(url),String(channelId),String(icon).slice(0,20),String(description).slice(0,300),enabled?1:0,required?1:0,Number(sortOrder)||0,now()); logEvent('sponsor_created',req.tgUser.id,String(id)); res.json({ok:true}); }
  catch(e){res.status(409).json({error:'Не вдалося додати спонсора. Можливо, такий ID уже існує.'});}
});
adminRouter.put('/sponsors/:id', (req,res)=>{
  const s=db.prepare('SELECT * FROM sponsors WHERE id=?').get(String(req.params.id)); if(!s)return res.status(404).json({error:'Спонсора не знайдено.'});
  const b=req.body||{}; const next={name:String(b.name??s.name).trim(),url:String(b.url??s.url),channelId:String(b.channelId??s.channel_id),icon:String(b.icon??s.icon).slice(0,20),description:String(b.description??s.description).slice(0,300),enabled:(b.enabled??!!s.enabled)?1:0,required:(b.required??!!s.required)?1:0,sortOrder:Number(b.sortOrder??s.sort_order)||0};
  if(!next.name||!/^https:\/\/t\.me\//.test(next.url)||!/^(-100\d+|@?[A-Za-z0-9_]{5,})$/.test(next.channelId))return res.status(400).json({error:'Перевір назву, URL і chat ID каналу.'});
  db.prepare('UPDATE sponsors SET name=?,url=?,channel_id=?,icon=?,description=?,enabled=?,required=?,sort_order=?,updated_at=? WHERE id=?').run(next.name,next.url,next.channelId,next.icon,next.description,next.enabled,next.required,next.sortOrder,now(),String(req.params.id)); logEvent('sponsor_updated',req.tgUser.id,String(req.params.id)); res.json({ok:true});
});
adminRouter.delete('/sponsors/:id', (req,res)=>{ const id=String(req.params.id); db.prepare('DELETE FROM sponsors WHERE id=?').run(id); db.prepare('DELETE FROM task_status WHERE sponsor_id=?').run(id); logEvent('sponsor_deleted',req.tgUser.id,id); res.json({ok:true}); });
adminRouter.get('/events', (req,res)=>res.json(db.prepare('SELECT id,created_at,type,telegram_id,details FROM events ORDER BY id DESC LIMIT 200').all()));
adminRouter.get('/export.csv', (req,res)=>{
  const users=db.prepare('SELECT * FROM users ORDER BY first_seen DESC').all();
  const quote=v=>'"'+String(v??'').replace(/"/g,'""')+'"';
  const lines=[['telegram_id','username','first_name','last_name','confirmed_tasks','required_tasks','progress_percent','status','last_check'].join(',')];
  for(const u of users){const s=statusForUser(u.telegram_id);lines.push([u.telegram_id,u.username,u.first_name,u.last_name,s.done,s.total,s.progress,s.completed?'completed':s.done?'partial':'not_started',u.last_check].map(quote).join(','));}
  logEvent('csv_export',req.tgUser.id,`${users.length} users`); res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="minecraft-stars-users.csv"');res.send('\ufeff'+lines.join('\r\n'));
});
app.use('/api/admin',adminRouter);
app.use('/admin', (req, res, next) => {
  if (req.path === '/' || req.path === '/index.html') {
    return res.sendFile(path.join(__dirname, 'index.html'));
  }
  next();
}, app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin/admin.js', (req, res) => res.sendFile(path.join(__dirname, 'admin.js')));

app.use(express.static(path.join(__dirname, 'public')));
app.get('/app.js', (req, res) => res.sendFile(path.join(__dirname, 'app.js')));
app.get('/style.css', (req, res) => res.sendFile(path.join(__dirname, 'style.css')));
app.use('/app.js', express.static(path.join(__dirname, 'app.js')));
app.use('/style.css', express.static(path.join(__dirname, 'style.css')));
app.use((err,req,res,next)=>{ console.error(err); res.status(500).json({error:'Внутрішня помилка сервера.'}); });
app.listen(PORT,()=>console.log(`Minecraft Stars is running on http://localhost:${PORT}`));

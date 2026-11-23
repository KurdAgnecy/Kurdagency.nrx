// Vercel Serverless Function: /api/x  (accounts, points, referrals, orders, notifications, admin)
// Needs: Redis (Vercel > Storage > Upstash Redis) and env vars ADMIN_USER, ADMIN_PASS.
// Optional: ADMIN_GATE (secret word before admin login), ADMIN_RESET (secret word to reset admin password),
//           META_TOKEN + META_AD_ACCOUNT (Meta insights), META_API_VERSION.
const crypto = require('crypto');
const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOK = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const DAILY = 100, REW = [1000, 1500, 2000], POINT_REWARD = 30, VER = 4, YEAR = 31536000;
const DEF_COST = 1542.77, GV = process.env.META_API_VERSION || 'v21.0';
const SITE_NOTICE = 'site-update-20261123';
const H = { Authorization: 'Bearer ' + TOK };
async function rc(...a) { const r = await fetch(URL_, { method: 'POST', headers: H, body: JSON.stringify(a) }); const j = await r.json(); if (j.error) throw new Error(j.error); return j.result; }
async function rp(c) { const r = await fetch(URL_ + '/pipeline', { method: 'POST', headers: H, body: JSON.stringify(c) }); return (await r.json()).map(x => x.result); }
const rnd = n => crypto.randomBytes(n).toString('hex');
const hash = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const day = (o = 0) => new Date(Date.now() + 3 * 3600e3 - o * 864e5).toISOString().slice(0, 10);
const dayOf = t => new Date(t + 3 * 3600e3).toISOString().slice(0, 10);
const S = (x, n) => String(x == null ? '' : x).slice(0, n);
const nph = p => { let d = String(p || '').replace(/\D/g, ''); if (d.startsWith('964') && d.length >= 12) d = '0' + d.slice(3); return d; };
const err = e => ({ ok: 0, err: e });
const waitErr = s => ({ ok: 0, err: 'wait', wait: s });
const J = x => { try { return JSON.parse(x); } catch (e) { return null; } };
const ipOf = req => S(((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0], 45) || '0';
const same = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());
const env = k => String(process.env[k] || '').trim();
async function sendOtpEmail(to, code) {
  const key = env('RESEND_API_KEY'), from = env('RESEND_FROM') || 'onboarding@resend.dev';
  if (!key) return false;
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to: [to], subject: 'کۆدی پشتڕاستکردنەوەی Kurd Agency', html: `<div dir="rtl"><h2>Kurd Agency</h2><p>کۆدی پشتڕاستکردنەوەی دروستکردنی هەژمارەکەت:</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p><p>ئەم کۆدە تەنها ١٠ خولەک کار دەکات.</p></div>` }) });
  return r.ok;
}
async function siteNotice(u) {
  if (!u || !(await rc('SETNX', 'site:notice:' + u, SITE_NOTICE))) return;
  await rp([['LPUSH', 'nt:' + u, JSON.stringify({ at: Date.now(), st: 'site' })], ['LTRIM', 'nt:' + u, 0, 49], ['INCR', 'ntu:' + u]]);
}
async function makeDailyBackup() {
  const d = day(), key = 'backup:' + d;
  if (await rc('EXISTS', key)) return { ok: 1, skipped: true, day: d };
  const [oraw, unames] = await rp([['LRANGE', 'orders', 0, 4999], ['SMEMBERS', 'users']]);
  const [orders, users] = await Promise.all([
    Promise.all((oraw || []).map(async x => J(x)).filter(Boolean)),
    Promise.all((unames || []).map(async u => J(await rc('GET', 'u:' + u))).then(xs => xs.filter(Boolean).map(({ pass, ...safe }) => safe)))
  ]);
  const out = { ok: 1, created: Date.now(), day: d, users, orders };
  await rc('SET', key, JSON.stringify(out), 'EX', 7776000);
  return { ok: 1, created: out.created, day: d };
}
const isC = s => ['ok', 'act', 'fin'].includes(s);
const sess = async u => { const t = rnd(24), now = Date.now(); await rp([['SET', 's:' + t, u, 'EX', YEAR], ['RPUSH', 'ss:' + u, JSON.stringify({ token: t, at: now, label: 'وێبگەڕ' })], ['LTRIM', 'ss:' + u, -20, -1]]); return t; };
async function banInfo(username) {
  const raw = await rc('GET', 'ban:' + username);
  if (!raw) return null;
  const info = J(raw) || { until: 0 };
  if (info.until && info.until <= Date.now()) { await rc('DEL', 'ban:' + username); return null; }
  return info;
}
async function isBanned(username) { return !!(await banInfo(username)); }
const auth = async t => { if (!t) return null; const k = 's:' + S(t, 80), u = await rc('GET', k); if (u && await isBanned(u)) { await rc('DEL', k); return null; } if (u) await rc('EXPIRE', k, YEAR); return u; };
async function locked(k) { const t = await rc('TTL', 'lk:' + k); return t > 0 ? t : 0; }
async function failed(k) { const f = await rc('INCR', 'lf:' + k); await rc('EXPIRE', 'lf:' + k, 3600); if (f % 5 === 0) { const s = f >= 15 ? 600 : f >= 10 ? 60 : 10; await rc('SET', 'lk:' + k, '1', 'EX', s); return s; } return 0; }
async function adminPassOk(pw) {
  const AP = env('ADMIN_PASS'); if (!AP) return null;
  if (same(pw, AP)) return true;                       // password from Vercel
  const ov = J(await rc('GET', 'adm:pass'));            // password changed inside the site
  if (ov) { const [s, h] = ov.h.split(':'); if (same(hash(pw, s), h)) return true; }
  return false;
}
const admUsers = () => env('ADMIN_USER').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
const gateOk = async t => !env('ADMIN_GATE') || !!(t && await rc('GET', 'ag:' + S(t, 40)));
async function profile(u) {
  const [pts, fr, nu] = await rp([['GET', 'pt:' + u.username], ['LRANGE', 'fr:' + u.username, 0, 99], ['GET', 'ntu:' + u.username]]);
  return { username: u.username, name: u.name, email: u.email, phone: u.phone, avatar: u.avatar, code: u.code, points: +pts || 0, unread: +nu || 0, friends: (fr || []).map(J).filter(Boolean) };
}
async function metaData(code, AD, TK) {
  const ck = 'mc:' + code, c = await rc('GET', ck); if (c) return JSON.parse(c);
  const q = new URLSearchParams({ level: 'campaign', fields: 'campaign_name,reach,impressions,clicks,actions', date_preset: 'maximum', limit: '50', filtering: JSON.stringify([{ field: 'campaign.name', operator: 'CONTAIN', value: code }]), access_token: TK });
  let d;
  try {
    const r = await fetch('https://graph.facebook.com/' + GV + '/' + (AD.startsWith('act_') ? AD : 'act_' + AD) + '/insights?' + q), j = await r.json();
    if (!r.ok || j.error) d = { status: 'error' };
    else if (!(j.data || []).length) d = { status: 'pending' };
    else {
      d = { status: 'ok', reach: 0, impressions: 0, clicks: 0, messages: 0, reactions: 0, comments: 0, shares: 0, saves: 0, pageLikes: 0, engagement: 0, linkClicks: 0, videoViews: 0, acts: {} };
      for (const w of j.data) {
        d.reach += +w.reach || 0; d.impressions += +w.impressions || 0; d.clicks += +w.clicks || 0;
        const A = t => +((w.actions || []).find(z => z.action_type === t) || {}).value || 0;
        d.messages += A('onsite_conversion.messaging_conversation_started_7d') || +(((w.actions || []).find(z => /messaging_conversation_started/.test(z.action_type)) || {}).value) || 0;
        d.reactions += A('post_reaction'); d.comments += A('comment');
        d.shares += A('post'); d.saves += A('onsite_conversion.post_save'); d.pageLikes += A('like'); d.engagement += A('post_engagement'); d.linkClicks += A('link_click'); d.videoViews += A('video_view');
        for (const z of (w.actions || [])) if (Object.keys(d.acts).length < 40 || d.acts[z.action_type] != null) d.acts[z.action_type] = (d.acts[z.action_type] || 0) + (+z.value || 0);
      }
    }
  } catch (e) { d = { status: 'error' }; }
  await rc('SET', ck, JSON.stringify(d), 'EX', d.status === 'error' ? 60 : 600);
  return d;
}
function dayList(from, to) {
  const ok = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  let e = ok(to) ? Date.parse(to + 'T00:00:00Z') : Date.parse(day() + 'T00:00:00Z'), s0 = ok(from) ? Date.parse(from + 'T00:00:00Z') : e - 29 * 864e5;
  if (isNaN(e) || isNaN(s0) || s0 > e) { e = Date.parse(day() + 'T00:00:00Z'); s0 = e - 29 * 864e5; }
  if ((e - s0) / 864e5 > 91) s0 = e - 91 * 864e5;
  const out = []; for (let t = s0; t <= e; t += 864e5) out.push(new Date(t).toISOString().slice(0, 10)); return out;
}
module.exports = async (req, res) => {
  if (req.method === 'GET' && req.query && req.query.cron === 'backup') {
    const secret = env('CRON_SECRET');
    if (!secret || req.headers.authorization !== 'Bearer ' + secret) return res.status(401).json({ ok: 0 });
    if (!URL_ || !TOK) return res.status(200).json(err('nodb'));
    try { return res.status(200).json(await makeDailyBackup()); } catch (e) { return res.status(200).json(err('srv')); }
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: 0 });
  if (!URL_ || !TOK) return res.status(200).json(err('nodb'));
  try { return res.status(200).json(await handle(req.body || {}, req)); } catch (e) { return res.status(200).json(err('srv')); }
};
async function lookup(id) {
  let un = id;
  if (id.includes('@')) un = await rc('GET', 'em:' + id); else if (/^[+\d\s]{9,}$/.test(id)) un = await rc('GET', 'ph:' + nph(id));
  const raw = un && await rc('GET', 'u:' + S(un, 20)); return raw && raw !== 'x' ? J(raw) : null;
}
async function handle(b, req) {
  const a = b.a, ip = ipOf(req);
  if (a === 'track') { const k = 'vis:' + day(); await rp([['PFADD', k, S(b.vid, 40)], ['EXPIRE', k, 3456000]]); return { ok: 1 }; }
  if (a === 'registerOtp') {
    const un = S(b.username, 20).toLowerCase().trim(), name = S(b.name, 60).trim(), ph = nph(b.phone), em = S(b.email, 80).toLowerCase().trim(), pw = String(b.password || ''), av = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]{20,40000}$/.test(b.avatar || '') ? b.avatar : '';
    if (!/^[a-z0-9_.]{3,20}$/.test(un) || /admin|root|kurdagency|support|owner/.test(un) || name.length < 2 || ph.length < 9 || ph.length > 15 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em) || pw.length < 6 || pw.length > 64) return err('bad');
    if (await rc('GET', 'u:' + un) || await rc('GET', 'em:' + em) || await rc('GET', 'ph:' + ph)) return err('taken');
    return handle({ ...b, a: 'register' }, req);
  }
  if (a === 'register') {
    const un = S(b.username, 20).toLowerCase().trim(), name = S(b.name, 60).trim(), ph = nph(b.phone), em = S(b.email, 80).toLowerCase().trim(), pw = String(b.password || '');
    const av = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]{20,40000}$/.test(b.avatar || '') ? b.avatar : '';
    if (!/^[a-z0-9_.]{3,20}$/.test(un) || /admin|root|kurdagency|support|owner/.test(un) || name.length < 2 || ph.length < 9 || ph.length > 15 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em) || pw.length < 6 || pw.length > 64) return err('bad');
    if (!(await rc('SETNX', 'u:' + un, 'x'))) return err('taken');
    if (!(await rc('SETNX', 'ph:' + ph, un))) { await rc('DEL', 'u:' + un); return err('taken'); }
    if (!(await rc('SETNX', 'em:' + em, un))) { await rp([['DEL', 'u:' + un], ['DEL', 'ph:' + ph]]); return err('taken'); }
    let code; do { code = 'KA' + rnd(3).toUpperCase(); } while (!(await rc('SETNX', 'rc:' + code, un)));
    const salt = rnd(8), u = { username: un, name, phone: ph, email: em, pass: salt + ':' + hash(pw, salt), avatar: av, code, created: Date.now(), by: '' };
    const rf = S(b.ref, 12).replace(/[^A-Za-z0-9]/g, '');
    if (rf) { const o = await rc('GET', 'rc:' + rf); if (o && o !== un) { u.by = o; await rc('RPUSH', 'fr:' + o, JSON.stringify({ n: name, u: un, t: 'signup', at: Date.now() })); } }
    await rp([['SET', 'u:' + un, JSON.stringify(u)], ['SADD', 'users', un]]);
    return { ok: 1, token: await sess(un), me: await profile(u) };
  }
  if (a === 'login') {
    const id = S(b.id, 80).toLowerCase().trim();
    if (admUsers().includes(id)) return err('adm');
    const gi = 'lgi:' + ip; if ((await rc('INCR', gi)) > 60) { await rc('EXPIRE', gi, 600); return waitErr(60); } await rc('EXPIRE', gi, 600);
    const lk = id.slice(0, 40), lw = await locked(lk); if (lw) return waitErr(lw);
    const u = await lookup(id);
    if (!u) { const s = await failed(lk); return s ? waitErr(s) : err('wrong'); }
    if (await isBanned(u.username)) return err('banned');
    const [s0, h0] = u.pass.split(':');
    if (!same(hash(String(b.password || ''), s0), h0)) { const s = await failed(lk); return s ? waitErr(s) : err('wrong'); }
    await rp([['DEL', 'lf:' + lk], ['DEL', 'lk:' + lk]]);
    return { ok: 1, token: await sess(u.username), me: await profile(u) };
  }
  if (a === 'fgreq') {
    const id = S(b.id, 80).toLowerCase().trim(), u = await lookup(id), rid = 'RS' + rnd(3).toUpperCase(), vid = S(b.vid, 80) || ip, cap = 'fg24:' + sha(vid);
    const count = await rc('INCR', cap); if (count === 1) await rc('EXPIRE', cap, 86400);
    if (u) await rc('SET', 'rq:' + rid, JSON.stringify({ u: u.username, at: Date.now(), manual: true }), 'EX', 172800);
    await rp([['LPUSH', 'rqs', rid], ['LTRIM', 'rqs', 0, 99]]);
    return { ok: 1, rid, manual: true };
  }
  if (a === 'fgset') {
    const rid = S(b.rid, 12).toUpperCase().trim(), pw = String(b.pass || ''); if (pw.length < 6 || pw.length > 64) return err('bad');
    const ak = 'ra:' + rid; if ((await rc('INCR', ak)) > 5) { await rc('EXPIRE', ak, 3600); return waitErr(300); } await rc('EXPIRE', ak, 3600);
    const rq = J(await rc('GET', 'rq:' + rid)), code = rq && rq.code ? rq.code : await rc('GET', 'rcode:' + rid);
    if (!code || !rq || !same(String(b.code || '').trim(), code)) return err('wrong');
    const u = J(await rc('GET', 'u:' + rq.u)); if (!u) return err('wrong');
    const salt = rnd(8); u.pass = salt + ':' + hash(pw, salt);
    await rp([['SET', 'u:' + u.username, JSON.stringify(u)], ['DEL', 'rcode:' + rid], ['DEL', 'rq:' + rid]]);
    return { ok: 1 };
  }
  if (a === 'agate') {
    const G = env('ADMIN_GATE'); if (!G) return { ok: 1, token: '' };
    const dk = 'gd:' + S(b.vid, 40) + ':' + ip; if (await rc('GET', dk)) return err('locked');
    const gi = 'gi:' + ip; if ((await rc('INCR', gi)) > 20) { await rc('EXPIRE', gi, 3600); return err('locked'); } await rc('EXPIRE', gi, 3600);
    if (!same(S(b.word, 60).trim().toLowerCase(), G.toLowerCase())) { await rc('SET', dk, '1', 'EX', 86400); return err('locked'); }
    const t = rnd(16); await rc('SET', 'ag:' + t, '1', 'EX', 900); return { ok: 1, token: t };
  }
  if (a === 'alogin') {
    if (!(await gateOk(b.gate))) return err('gate');
    const k = 'a:' + ip, lw = await locked(k); if (lw) return waitErr(lw);
    const AUs = admUsers(), pk = await adminPassOk(String(b.password || '').trim());
    if (!AUs.length || pk === null) return err('noadmin');
    const uu = S(b.user, 80).trim().toLowerCase(), okU = AUs.some(u => same(uu, u));
    if (!(okU && pk)) {
      const s = await failed(k); if (s) return waitErr(s);
      const w = err('wrong');
      if (env('ADMIN_GATE')) { const ov = J(await rc('GET', 'adm:pass')); w.u = okU; w.p = !!pk; w.src = ov ? 'site' : 'env'; }
      return w;
    }
    await rp([['DEL', 'lf:' + k], ['DEL', 'lk:' + k]]);
    const t = rnd(24); await rc('SET', 'as:' + t, '1', 'EX', YEAR); return { ok: 1, token: t };
  }
  if (a === 'areset') {
    if (!(await gateOk(b.gate))) return err('gate');
    const RW = env('ADMIN_RESET'), AP = env('ADMIN_PASS'); if (!RW || !AP) return err('noreset');
    const rk = 'rs:' + ip; if ((await rc('INCR', rk)) > 5) { await rc('EXPIRE', rk, 3600); return waitErr(600); } await rc('EXPIRE', rk, 3600);
    if (!same(S(b.word, 60).trim().toLowerCase(), RW.toLowerCase())) return err('wrong');
    if (b.revert) { await rc('DEL', 'adm:pass'); return { ok: 1 }; }
    const pw = String(b.pass || '').trim(); if (pw.length < 8 || pw.length > 64) return err('bad');
    const salt = rnd(8); await rc('SET', 'adm:pass', JSON.stringify({ h: salt + ':' + hash(pw, salt) })); return { ok: 1 };
  }
  if (a === 'order') {
    const o = b.o || {}, P = ['fb', 'ig', 'sc', 'tb', 'tp', 'tl'], price = Math.round(+o.price);
    if (!P.includes(o.p) || !(price >= 1000 && price <= 10000000)) return err('bad');
    const ol = 'ol:' + ip; if ((await rc('INCR', ol)) > 8) return err('wait'); await rc('EXPIRE', ol, 60);
    const id = Date.now().toString(36) + rnd(2), d = day(), meta = o.p === 'fb' || o.p === 'ig', cfg = meta ? (+(await rc('GET', 'cfg:cost')) || DEF_COST) : 0, usd = meta ? +(price / 2000).toFixed(2) : null;
    const code = meta && /^KA-[A-Z0-9]{6}$/.test(o.code || '') ? o.code : '', owner = meta && b.token ? ((await auth(b.token)) || '') : '';
    const r = { id, at: Date.now(), p: o.p, pn: S(o.pn, 40), pk: S(o.pk, 80), price, usd, cost: cfg > 0 ? cfg : null, profit: cfg > 0 ? Math.round(price - usd * cfg) : null, pg: S(o.pg, 100), bz: S(o.bz, 100), lk: S(o.lk, 300), tg: S(o.tg, 100), gd: S(o.gd, 30), ag: S(o.ag, 60), dy: meta ? String(Math.min(Math.max(1, parseInt(o.dy) || 1), Math.max(1, Math.floor(price / 4000)))) : S(o.dy, 10), pay: S(o.pay, 20), ref: S(o.ref, 12).replace(/[^A-Za-z0-9]/g, ''), code, owner, st: 'new' };
    await rp([['SET', 'ord:' + id, JSON.stringify(r)], ['LPUSH', 'orders', id], ['INCRBY', 'tot:all', price], ['INCR', 'cnt:all'], ['INCRBY', 'tot:d:' + d, price], ['INCR', 'cnt:d:' + d], ['INCRBY', 'tot:p:' + o.p, price]]);
    if (code) await rc('SET', 'oc:' + code, id, 'NX');
    if (owner) {
      await rp([
        ['RPUSH', 'uo:' + owner, id],
        ['LPUSH', 'nt:' + owner, JSON.stringify({ at: Date.now(), code: r.code, pg: r.pg, pn: r.pn, st: 'received' })],
        ['LTRIM', 'nt:' + owner, 0, 49],
        ['INCR', 'ntu:' + owner]
      ]);
    }
    if (r.ref) { const ow = await rc('GET', 'rc:' + r.ref); if (ow) await rc('RPUSH', 'fr:' + ow, JSON.stringify({ n: r.pg, t: 'order', p: r.pn, at: Date.now() })); }
    return { ok: 1 };
  }
  if (['astats', 'ostatus', 'asetcost', 'agencode', 'apass', 'aban', 'backup'].includes(a)) {
    const tk = 'as:' + S(b.token, 80); if ((await rc('GET', tk)) !== '1') return err('auth'); await rc('EXPIRE', tk, YEAR);
    if (a === 'apass') {
      const AP = env('ADMIN_PASS'), np = String(b.pass || '').trim(); if (!AP) return err('noadmin'); if (np.length < 8 || np.length > 64) return err('bad');
      if (!(await adminPassOk(String(b.old || '').trim()))) return err('wrong');
      const salt = rnd(8); await rc('SET', 'adm:pass', JSON.stringify({ h: salt + ':' + hash(np, salt) })); return { ok: 1 };
    }
    if (a === 'agencode') {
      const rid = S(b.rid, 12).toUpperCase().trim(), rq = J(await rc('GET', 'rq:' + rid)); if (!rq) return err('nocode');
      const code = String(crypto.randomInt(100000, 1000000)); await rp([['SET', 'rcode:' + rid, code, 'EX', 3600], ['DEL', 'ra:' + rid]]); return { ok: 1, code };
    }
    if (a === 'asetcost') { const c = +b.cost; if (!(c >= 0 && c <= 5000)) return err('bad'); await rc('SET', 'cfg:cost', String(+c.toFixed(2))); return { ok: 1 }; }
    if (a === 'backup') {
      const ids = (await rc('LRANGE', 'orders', 0, 4999)) || [], users = (await rc('SMEMBERS', 'users')) || [];
      const [ords, us] = await Promise.all([ids.length ? rc('MGET', ...ids.map(i => 'ord:' + i)) : [], users.length ? rc('MGET', ...users.map(u => 'u:' + u)) : []]);
      return { ok: 1, created: Date.now(), users: (us || []).map(J).filter(Boolean).map(u => { const { pass, ...safe } = u; return safe; }), orders: (ords || []).map(J).filter(Boolean) };
    }
    if (a === 'aban') {
      const username = S(b.username, 20).toLowerCase().trim(), seconds = Math.max(0, Math.min(31536000, Math.floor(+b.seconds || 0)));
      if (!/^[a-z0-9_.]{3,20}$/.test(username) || admUsers().includes(username)) return err('bad');
      const raw = await rc('GET', 'u:' + username); if (!raw || raw === 'x') return err('bad');
      if (b.unban) { await rc('DEL', 'ban:' + username); return { ok: 1, username, banned: false }; }
      const info = { at: Date.now(), until: seconds ? Date.now() + seconds * 1000 : 0, by: 'admin' };
      if (seconds) await rc('SET', 'ban:' + username, JSON.stringify(info), 'EX', seconds); else await rc('SET', 'ban:' + username, JSON.stringify(info));
      return { ok: 1, username, banned: true, until: info.until };
    }
    if (a === 'ostatus') {
      const raw = await rc('GET', 'ord:' + S(b.id, 30)); if (!raw) return err('bad');
      const o = JSON.parse(raw), st = ['new', 'ok', 'act', 'fin', 'x', 'ns'].includes(b.st) ? b.st : 'new', d0 = dayOf(o.at);
      if (!isC(o.st) && isC(st)) {
        await rc('INCRBY', 'tot:ok', o.price); await rp([['INCR', 'ccnt:d:' + d0], ['INCRBY', 'ctot:d:' + d0, o.price]]); o.cc = 1;
        if (o.usd) {
          const cfg = +(await rc('GET', 'cfg:cost')) || DEF_COST; if (o.cost == null && cfg > 0) o.cost = cfg;
          o.profit = o.cost > 0 ? Math.round(o.price - o.usd * o.cost) : null; o.cu = Math.round(o.usd * 100); o.cp = o.profit || 0;
          await rp([['INCRBY', 'usdc:d:' + d0, o.cu], ['INCRBY', 'prof:d:' + d0, o.cp], ['INCRBY', 'revc:d:' + d0, o.price]]);
        }
        if (o.owner && !o.rewarded && await rc('SET', 'rw:' + o.id, '1', 'EX', YEAR, 'NX')) {
          await rc('INCRBY', 'pt:' + o.owner, POINT_REWARD); o.rewarded = 1;
          await rp([['LPUSH', 'nt:' + o.owner, JSON.stringify({ at: Date.now(), code: o.code, pg: o.pg, pn: o.pn, st: 'reward', points: POINT_REWARD })], ['LTRIM', 'nt:' + o.owner, 0, 49], ['INCR', 'ntu:' + o.owner]]);
        }
      }
      if (isC(o.st) && !isC(st)) {
        await rc('DECRBY', 'tot:ok', o.price); if (o.cc) { await rp([['DECRBY', 'ccnt:d:' + d0, 1], ['DECRBY', 'ctot:d:' + d0, o.price]]); o.cc = null; }
        if (o.cu != null) { await rp([['DECRBY', 'usdc:d:' + d0, o.cu], ['DECRBY', 'prof:d:' + d0, o.cp || 0], ['DECRBY', 'revc:d:' + d0, o.price]]); o.cu = null; o.cp = null; }
      }
      if (o.st !== st && o.owner && ['ok', 'act', 'fin', 'x', 'ns'].includes(st)) await rp([['LPUSH', 'nt:' + o.owner, JSON.stringify({ at: Date.now(), code: o.code, pg: o.pg, pn: o.pn, st })], ['LTRIM', 'nt:' + o.owner, 0, 49], ['INCR', 'ntu:' + o.owner]]);
      o.st = st; await rc('SET', 'ord:' + o.id, JSON.stringify(o)); return { ok: 1 };
    }
    const rg = dayList(b.from, b.to);
    const cmds = [['SCARD', 'users'], ['GET', 'tot:all'], ['GET', 'cnt:all'], ['GET', 'tot:ok'], ['LRANGE', 'orders', 0, 299], ['SMEMBERS', 'users'], ['LRANGE', 'red', 0, 59], ['LRANGE', 'rqs', 0, 49], ['GET', 'cfg:cost']];
    const f0 = cmds.length; rg.forEach(d => cmds.push(['PFCOUNT', 'vis:' + d], ['PFCOUNT', 'ply:' + d], ['GET', 'cnt:d:' + d], ['GET', 'tot:d:' + d], ['GET', 'usdc:d:' + d], ['GET', 'prof:d:' + d], ['GET', 'revc:d:' + d], ['GET', 'ccnt:d:' + d], ['GET', 'ctot:d:' + d]));
    const r = await rp(cmds), ids = r[4] || [], un = (r[5] || []).slice(-300), rids = r[7] || [];
    const [ords, us, pts, rqs] = await Promise.all([ids.length ? rc('MGET', ...ids.map(i => 'ord:' + i)) : [], un.length ? rc('MGET', ...un.map(u => 'u:' + u)) : [], un.length ? rc('MGET', ...un.map(u => 'pt:' + u)) : [], rids.length ? rc('MGET', ...rids.map(i => 'rq:' + i)) : []]);
    let users = (us || []).map((x, i) => { const u = x && x !== 'x' ? J(x) : null; return u && { username: u.username, name: u.name, phone: u.phone, email: u.email, avatar: u.avatar, by: u.by, created: u.created, points: +pts[i] || 0 }; }).filter(Boolean).reverse();
    users = await Promise.all(users.map(async u => ({ ...u, ban: await banInfo(u.username) })));
    const byU = {}; users.forEach(u => byU[u.username] = u);
    const resets = rids.map((rid, i) => { const q = J(rqs[i]); const u = q && byU[q.u]; return q && u ? { rid, u: u.username, name: u.name, phone: u.phone, email: u.email, at: q.at } : null; }).filter(Boolean);
    return { ok: 1, ver: VER, accounts: +r[0] || 0, totAll: +r[1] || 0, cntAll: +r[2] || 0, totOk: +r[3] || 0, cost: +r[8] || DEF_COST,
      orders: (ords || []).map(J).filter(Boolean), reds: (r[6] || []).map(J).filter(Boolean), users, resets,
      rows: rg.map((d, i) => { const k = f0 + i * 9; return { d, v: +r[k] || 0, p: +r[k + 1] || 0, n: +r[k + 2] || 0, t: +r[k + 3] || 0, usd: (+r[k + 4] || 0) / 100, prof: +r[k + 5] || 0, rev: +r[k + 6] || 0, cn: +r[k + 7] || 0, ct: +r[k + 8] || 0 }; }) };
  }
  const un = await auth(b.token); if (!un) return err('auth');
  if (a === 'nread') { await rc('SET', 'ntu:' + un, '0'); return { ok: 1 }; }
  if (a === 'notifications') {
    await siteNotice(un);
    const notes = ((await rc('LRANGE', 'nt:' + un, 0, 49)) || []).map(J).filter(Boolean);
    const unread = +(await rc('GET', 'ntu:' + un)) || 0;
    return { ok: 1, unread, notes };
  }
  if (a === 'sessions' || a === 'logoutAll') {
    const raw = (await rc('LRANGE', 'ss:' + un, 0, 49)) || [], list = raw.map(J).filter(Boolean);
    if (a === 'logoutAll') { await Promise.all(list.map(x => rc('DEL', 's:' + S(x.token, 80)))); await rc('DEL', 'ss:' + un); return { ok: 1 }; }
    return { ok: 1, sessions: list.map(x => ({ at: x.at, label: x.label || 'وێبگەڕ', current: x.token === S(b.token, 80) })) };
  }
  if (a === 'me') { const raw = await rc('GET', 'u:' + un); return { ok: 1, me: await profile(JSON.parse(raw)) }; }
  if (a === 'deleteAccount') {
    const raw = await rc('GET', 'u:' + un), u = raw && J(raw), ids = (await rc('LRANGE', 'uo:' + un, 0, 4999)) || [];
    const cmds = [['DEL', 'u:' + un], ['DEL', 'ph:' + u.phone], ['DEL', 'em:' + u.email], ['DEL', 'rc:' + u.code], ['DEL', 'pt:' + un], ['DEL', 'fr:' + un], ['DEL', 'nt:' + un], ['DEL', 'ntu:' + un], ['DEL', 'uo:' + un], ['DEL', 'ss:' + un], ['SREM', 'users', un], ['DEL', 's:' + S(b.token, 80)]];
    ids.forEach(id => cmds.push(['DEL', 'ord:' + id])); await rp(cmds); return { ok: 1 };
  }
  if (a === 'logout') { await rc('DEL', 's:' + S(b.token, 80)); return { ok: 1 }; }
  if (a === 'mydata') {
    const ids = (await rc('LRANGE', 'uo:' + un, 0, 4999)) || [];
    const recs = ids.length ? (await rc('MGET', ...ids.map(i => 'ord:' + i))).map(J).filter(Boolean).reverse() : [];
    const AD = env('META_AD_ACCOUNT'), TK = env('META_TOKEN');
    const rows = await Promise.all(recs.map(async (o, i) => {
      let data = o.data || null;
      if (AD && TK && o.code && o.st !== 'x' && o.st !== 'ns' && i < 15) {
        const fresh = await metaData(o.code, AD, TK); data = fresh || data;
        if (fresh && fresh.status === 'pending' && o.st === 'act' && o.owner) {
          o.st = 'fin';
          await rp([['LPUSH', 'nt:' + o.owner, JSON.stringify({ at: Date.now(), code: o.code, pg: o.pg, pn: o.pn, st: 'fin' })], ['LTRIM', 'nt:' + o.owner, 0, 49], ['INCR', 'ntu:' + o.owner]]);
          await rc('SET', 'ord:' + o.id, JSON.stringify(o));
        }
        if (fresh && fresh.status === 'ok') {
          const changed = JSON.stringify(o.data || null) !== JSON.stringify(fresh); o.data = fresh;
          const firstActive = o.owner && await rc('SETNX', 'meta:act:' + o.id, '1');
          if (firstActive) {
            o.st = 'act';
            await rp([['LPUSH', 'nt:' + o.owner, JSON.stringify({ at: Date.now(), code: o.code, pg: o.pg, pn: o.pn, st: 'act' })], ['LTRIM', 'nt:' + o.owner, 0, 49], ['INCR', 'ntu:' + o.owner]]);
          }
          if (changed || firstActive) await rc('SET', 'ord:' + o.id, JSON.stringify(o));
        }
      }
      return { id: o.id, at: o.at, code: o.code, pn: o.pn, pg: o.pg, price: o.price, usd: o.usd, st: o.st, data };
    }));
    const nl = ((await rc('LRANGE', 'nt:' + un, 0, 49)) || []).map(J).filter(Boolean), unread = +(await rc('GET', 'ntu:' + un)) || 0;
    return { ok: 1, meta: !!(AD && TK), orders: rows, notes: nl, unread };
  }
  if (a === 'claim') {
    const code = S(b.code, 12).toUpperCase().trim(), ck = 'cl:' + un;
    if ((await rc('INCR', ck)) > 10) return err('wait'); await rc('EXPIRE', ck, 3600);
    if (!/^KA-[A-Z0-9]{6}$/.test(code)) return err('nocode');
    const id = await rc('GET', 'oc:' + code), o = id && J(await rc('GET', 'ord:' + id)); if (!o) return err('nocode');
    if (o.owner && o.owner !== un) return err('owned');
    if (!o.owner) {
      o.owner = un;
      await rp([
        ['SET', 'ord:' + o.id, JSON.stringify(o)],
        ['RPUSH', 'uo:' + un, o.id],
        ['LPUSH', 'nt:' + un, JSON.stringify({ at: Date.now(), code: o.code, pg: o.pg, pn: o.pn, st: 'received' })],
        ['LTRIM', 'nt:' + un, 0, 49],
        ['INCR', 'ntu:' + un]
      ]);
    }
    if (o.owner === un && isC(o.st) && !o.rewarded && await rc('SET', 'rw:' + o.id, '1', 'EX', YEAR, 'NX')) {
      await rc('INCRBY', 'pt:' + un, POINT_REWARD); o.rewarded = 1;
      await rp([['SET', 'ord:' + o.id, JSON.stringify(o)], ['LPUSH', 'nt:' + un, JSON.stringify({ at: Date.now(), code: o.code, pg: o.pg, pn: o.pn, st: 'reward', points: POINT_REWARD })], ['LTRIM', 'nt:' + un, 0, 49], ['INCR', 'ntu:' + un]]);
    }
    return { ok: 1 };
  }
  if (['pname', 'puser', 'pphone', 'pmail', 'ppass', 'pavatar'].includes(a)) {
    const pk = 'pf:' + un; if ((await rc('INCR', pk)) > 30) { await rc('EXPIRE', pk, 3600); return waitErr(300); } await rc('EXPIRE', pk, 3600);
    const u = J(await rc('GET', 'u:' + un)); if (!u) return err('auth');
    if (a === 'pavatar') { const av = String(b.avatar || ''); if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]{20,40000}$/.test(av)) return err('bad'); u.avatar = av; await rc('SET', 'u:' + un, JSON.stringify(u)); return { ok: 1, me: await profile(u) }; }
    if (a === 'pname') { const nm = S(b.name, 60).trim(); if (nm.length < 2) return err('bad'); u.name = nm; await rc('SET', 'u:' + un, JSON.stringify(u)); return { ok: 1, me: await profile(u) }; }
    if (a === 'pphone') {
      const ph = nph(b.phone); if (ph.length < 9 || ph.length > 15 || ph === u.phone) return err('bad');
      if (await rc('GET', 'ph:' + ph)) return err('taken');
      const cur = String(b.password || ''), [sp, hp] = u.pass.split(':'); if (!same(hash(cur, sp), hp)) return err('wrong');
      await rp([['DEL', 'ph:' + u.phone], ['SET', 'ph:' + ph, un]]); u.phone = ph; await rc('SET', 'u:' + un, JSON.stringify(u)); return { ok: 1, me: await profile(u) };
    }
    if (a === 'puser') {
      const nu = S(b.username, 20).toLowerCase().trim();
      if (!/^[a-z0-9_.]{3,20}$/.test(nu) || /admin|root|kurdagency|support|owner/.test(nu) || nu === un) return err('bad');
      if (await rc('GET', 'u:' + nu)) return err('taken');
      const cur = String(b.password || ''), [su, hu] = u.pass.split(':'); if (!same(hash(cur, su), hu)) return err('wrong');
      const ids = (await rc('LRANGE', 'uo:' + un, 0, 4999)) || [];
      const cmds = [['SET', 'u:' + nu, JSON.stringify({ ...u, username: nu })], ['DEL', 'u:' + un], ['SREM', 'users', un], ['SADD', 'users', nu], ['DEL', 'uo:' + un], ['DEL', 's:' + S(b.token, 80)], ['SET', 's:' + S(b.token, 80), nu, 'EX', YEAR]];
      if (ids.length) cmds.push(['RPUSH', 'uo:' + nu, ...ids]);
      const ords = ids.length ? (await rc('MGET', ...ids.map(i => 'ord:' + i))).map(J).filter(Boolean) : [];
      ords.forEach(o => { o.owner = nu; cmds.push(['SET', 'ord:' + o.id, JSON.stringify(o)]); });
      await rp(cmds); return { ok: 1, me: await profile({ ...u, username: nu }) };
    }
    const lk = 'p:' + un, lw = await locked(lk); if (lw) return waitErr(lw);
    const cur = String(a === 'pmail' ? b.password : b.old || ''), [s0, h0] = u.pass.split(':');
    if (!same(hash(cur, s0), h0)) { const s = await failed(lk); return s ? waitErr(s) : err('wrong'); }
    await rp([['DEL', 'lf:' + lk], ['DEL', 'lk:' + lk]]);
    if (a === 'ppass') {
      const np = String(b.pass || ''); if (np.length < 6 || np.length > 64) return err('bad');
      const salt = rnd(8); u.pass = salt + ':' + hash(np, salt); await rc('SET', 'u:' + un, JSON.stringify(u)); return { ok: 1, me: await profile(u) };
    }
    const mail = S(b.email, 80).toLowerCase().trim(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) return err('bad');
    if (mail !== u.email) { if (!(await rc('SETNX', 'em:' + mail, un))) return err('taken'); await rc('DEL', 'em:' + u.email); u.email = mail; await rc('SET', 'u:' + un, JSON.stringify(u)); }
    return { ok: 1, me: await profile(u) };
  }
  if (a === 'play') { const k = 'ply:' + day(); await rp([['PFADD', k, un], ['EXPIRE', k, 3456000]]); return { ok: 1 }; }
  if (a === 'award') {
    const p = Math.floor(+b.points); if (!(p >= 1 && p <= 20)) return err('bad');
    if (!(await rc('SET', 'al:' + un, '1', 'EX', 15, 'NX'))) return err('wait');
    const k = 'pd:' + un + ':' + day(), used = +(await rc('GET', k)) || 0, add = Math.min(p, DAILY - used);
    if (add <= 0) return err('cap');
    await rp([['INCRBY', k, add], ['EXPIRE', k, 172800]]);
    return { ok: 1, added: add, points: await rc('INCRBY', 'pt:' + un, add) };
  }
  if (a === 'redeem') {
    const c = +b.cost; if (!REW.includes(c)) return err('bad');
    const bal = +(await rc('GET', 'pt:' + un)) || 0; if (bal < c) return err('low');
    const left = await rc('DECRBY', 'pt:' + un, c); if (left < 0) { await rc('INCRBY', 'pt:' + un, c); return err('low'); }
    await rc('LPUSH', 'red', JSON.stringify({ u: un, cost: c, iqd: c * 10, at: Date.now() }));
    return { ok: 1, points: left };
  }
  return err('bad');
}

// Vercel Serverless Function: /api/x  (accounts, points, referrals, orders, admin dashboard)
// Needs a Redis database (Vercel > Storage > Upstash Redis) and env vars ADMIN_USER + ADMIN_PASS.
const crypto = require('crypto');
const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOK = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const DAILY = 100, REW = [1000, 1500, 2000];
const H = { Authorization: 'Bearer ' + TOK };
async function rc(...a) { const r = await fetch(URL_, { method: 'POST', headers: H, body: JSON.stringify(a) }); const j = await r.json(); if (j.error) throw new Error(j.error); return j.result; }
async function rp(c) { const r = await fetch(URL_ + '/pipeline', { method: 'POST', headers: H, body: JSON.stringify(c) }); return (await r.json()).map(x => x.result); }
const rnd = n => crypto.randomBytes(n).toString('hex');
const hash = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
const day = (o = 0) => new Date(Date.now() + 3 * 3600e3 - o * 864e5).toISOString().slice(0, 10);
const S = (x, n) => String(x == null ? '' : x).slice(0, n);
const nph = p => { let d = String(p || '').replace(/\D/g, ''); if (d.startsWith('964') && d.length >= 12) d = '0' + d.slice(3); return d; };
const err = e => ({ ok: 0, err: e });
const sess = async (u, rem) => { const t = rnd(24); await rc('SET', 's:' + t, u, 'EX', rem ? 2592000 : 86400); return t; };
const auth = async t => (t ? await rc('GET', 's:' + S(t, 80)) : null);
const same = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };
async function profile(u) {
  const [pts, fr] = await rp([['GET', 'pt:' + u.username], ['LRANGE', 'fr:' + u.username, 0, 99]]);
  return { username: u.username, name: u.name, avatar: u.avatar, code: u.code, points: +pts || 0, friends: (fr || []).map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean) };
}
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: 0 });
  if (!URL_ || !TOK) return res.status(200).json(err('nodb'));
  const b = req.body || {};
  try { return res.status(200).json(await handle(b, req)); } catch (e) { return res.status(200).json(err('srv')); }
};
async function handle(b, req) {
  const a = b.a;
  if (a === 'track') { const k = 'vis:' + day(); await rp([['PFADD', k, S(b.vid, 40)], ['EXPIRE', k, 3456000]]); return { ok: 1 }; }
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
    return { ok: 1, token: await sess(un, b.remember), me: await profile(u) };
  }
  if (a === 'login') {
    const id = S(b.id, 80).toLowerCase().trim(), lk = 'lg:' + id.slice(0, 40);
    const n = await rc('INCR', lk); await rc('EXPIRE', lk, 600); if (n > 8) return err('wait');
    let un = id;
    if (id.includes('@')) un = await rc('GET', 'em:' + id); else if (/^[+\d\s]{9,}$/.test(id)) un = await rc('GET', 'ph:' + nph(id));
    const raw = un && await rc('GET', 'u:' + S(un, 20)); if (!raw || raw === 'x') return err('wrong');
    const u = JSON.parse(raw), [s, h] = u.pass.split(':');
    if (!same(hash(String(b.password || ''), s), h)) return err('wrong');
    await rc('DEL', lk);
    return { ok: 1, token: await sess(u.username, b.remember), me: await profile(u) };
  }
  if (a === 'alogin') {
    const n = await rc('INCR', 'lg:admin'); await rc('EXPIRE', 'lg:admin', 600); if (n > 6) return err('wait');
    const AU = process.env.ADMIN_USER, AP = process.env.ADMIN_PASS;
    if (!AU || !AP || !same(b.user || '', AU) || !same(b.password || '', AP)) return err('wrong');
    const t = rnd(24); await rc('SET', 'as:' + t, '1', 'EX', 43200); return { ok: 1, token: t };
  }
  if (a === 'order') {
    const o = b.o || {}, P = ['fb', 'ig', 'sc', 'tb', 'tp', 'tl'], price = Math.round(+o.price);
    if (!P.includes(o.p) || !(price >= 1000 && price <= 10000000)) return err('bad');
    const ip = S((req.headers['x-forwarded-for'] || '').split(',')[0], 45), ol = 'ol:' + ip;
    if ((await rc('INCR', ol)) > 8) return err('wait'); await rc('EXPIRE', ol, 60);
    const id = Date.now().toString(36) + rnd(2), d = day();
    const r = { id, at: Date.now(), p: o.p, pn: S(o.pn, 40), pk: S(o.pk, 80), price, usd: o.usd ? +(+o.usd).toFixed(2) : null, pg: S(o.pg, 100), bz: S(o.bz, 100), lk: S(o.lk, 300), tg: S(o.tg, 100), gd: S(o.gd, 30), ag: S(o.ag, 60), dy: S(o.dy, 10), pay: S(o.pay, 20), ref: S(o.ref, 12).replace(/[^A-Za-z0-9]/g, ''), st: 'new' };
    await rp([['SET', 'ord:' + id, JSON.stringify(r)], ['LPUSH', 'orders', id], ['INCRBY', 'tot:all', price], ['INCR', 'cnt:all'], ['INCRBY', 'tot:d:' + d, price], ['INCR', 'cnt:d:' + d], ['INCRBY', 'tot:p:' + o.p, price]]);
    if (r.ref) { const ow = await rc('GET', 'rc:' + r.ref); if (ow) await rc('RPUSH', 'fr:' + ow, JSON.stringify({ n: r.pg, t: 'order', p: r.pn, at: Date.now() })); }
    return { ok: 1 };
  }
  if (a === 'astats' || a === 'ostatus') {
    if ((await rc('GET', 'as:' + S(b.token, 80))) !== '1') return err('auth');
    if (a === 'ostatus') {
      const raw = await rc('GET', 'ord:' + S(b.id, 30)); if (!raw) return err('bad');
      const o = JSON.parse(raw), st = ['new', 'ok', 'x'].includes(b.st) ? b.st : 'new';
      if (o.st !== 'ok' && st === 'ok') await rc('INCRBY', 'tot:ok', o.price); if (o.st === 'ok' && st !== 'ok') await rc('DECRBY', 'tot:ok', o.price);
      o.st = st; await rc('SET', 'ord:' + o.id, JSON.stringify(o)); return { ok: 1 };
    }
    const days = Array.from({ length: 14 }, (_, i) => day(i));
    const cmds = [['SCARD', 'users'], ['GET', 'tot:all'], ['GET', 'cnt:all'], ['GET', 'tot:ok'], ['GET', 'tot:d:' + day()], ['GET', 'cnt:d:' + day()], ['LRANGE', 'orders', 0, 149], ['SMEMBERS', 'users'], ['LRANGE', 'red', 0, 59]];
    days.forEach(d => { cmds.push(['PFCOUNT', 'vis:' + d]); cmds.push(['PFCOUNT', 'ply:' + d]); });
    const r = await rp(cmds), ids = r[6] || [], un = (r[7] || []).slice(-300);
    const [ords, us, pts] = await Promise.all([ids.length ? rc('MGET', ...ids.map(i => 'ord:' + i)) : [], un.length ? rc('MGET', ...un.map(u => 'u:' + u)) : [], un.length ? rc('MGET', ...un.map(u => 'pt:' + u)) : []]);
    const J = x => { try { return JSON.parse(x); } catch (e) { return null; } };
    return { ok: 1, accounts: +r[0] || 0, totAll: +r[1] || 0, cntAll: +r[2] || 0, totOk: +r[3] || 0, totToday: +r[4] || 0, cntToday: +r[5] || 0,
      orders: (ords || []).map(J).filter(Boolean), reds: (r[8] || []).map(J).filter(Boolean),
      users: (us || []).map((x, i) => { const u = x && x !== 'x' ? J(x) : null; return u && { username: u.username, name: u.name, phone: u.phone, email: u.email, avatar: u.avatar, by: u.by, created: u.created, points: +pts[i] || 0 }; }).filter(Boolean).reverse(),
      days: days.map((d, i) => ({ d, v: +r[9 + i * 2] || 0, p: +r[10 + i * 2] || 0 })) };
  }
  const un = await auth(b.token); if (!un) return err('auth');
  if (a === 'me') { const raw = await rc('GET', 'u:' + un); return { ok: 1, me: await profile(JSON.parse(raw)) }; }
  if (a === 'logout') { await rc('DEL', 's:' + S(b.token, 80)); return { ok: 1 }; }
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

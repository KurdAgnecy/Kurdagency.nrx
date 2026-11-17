// Vercel Serverless Function: /api/x  (accounts, points, referrals, orders, admin dashboard)
// Needs a Redis database (Vercel > Storage > Upstash Redis) and env vars ADMIN_USER + ADMIN_PASS.
const crypto = require('crypto');
const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOK = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const DAILY = 100, REW = [1000, 1500, 2000];
const DEF_COST = 1542.77, GV = process.env.META_API_VERSION || 'v21.0';
const J = x => { try { return JSON.parse(x); } catch (e) { return null; } };
const H = { Authorization: 'Bearer ' + TOK };
async function rc(...a) { const r = await fetch(URL_, { method: 'POST', headers: H, body: JSON.stringify(a) }); const j = await r.json(); if (j.error) throw new Error(j.error); return j.result; }
async function rp(c) { const r = await fetch(URL_ + '/pipeline', { method: 'POST', headers: H, body: JSON.stringify(c) }); return (await r.json()).map(x => x.result); }
const rnd = n => crypto.randomBytes(n).toString('hex');
const hash = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
const day = (o = 0) => new Date(Date.now() + 3 * 3600e3 - o * 864e5).toISOString().slice(0, 10);
const S = (x, n) => String(x == null ? '' : x).slice(0, n);
const nph = p => { let d = String(p || '').replace(/\D/g, ''); if (d.startsWith('964') && d.length >= 12) d = '0' + d.slice(3); return d; };
const dayOf = t => new Date(t + 3 * 3600e3).toISOString().slice(0, 10);
const err = e => ({ ok: 0, err: e });
const ipOf = req => S(((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0], 45) || '0';
const sess = async (u, rem) => { const t = rnd(24); await rc('SET', 's:' + t, u, 'EX', rem ? 2592000 : 86400); return t; };
const auth = async t => (t ? await rc('GET', 's:' + S(t, 80)) : null);
const same = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };
async function profile(u) {
  const [pts, fr] = await rp([['GET', 'pt:' + u.username], ['LRANGE', 'fr:' + u.username, 0, 99]]);
  return { username: u.username, name: u.name, avatar: u.avatar, code: u.code, points: +pts || 0, friends: (fr || []).map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean) };
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
      d = { status: 'ok', reach: 0, impressions: 0, clicks: 0, messages: 0, reactions: 0, comments: 0 };
      for (const w of j.data) {
        d.reach += +w.reach || 0; d.impressions += +w.impressions || 0; d.clicks += +w.clicks || 0;
        const A = t => +((w.actions || []).find(z => z.action_type === t) || {}).value || 0;
        d.messages += A('onsite_conversion.messaging_conversation_started_7d') || +(((w.actions || []).find(z => /messaging_conversation_started/.test(z.action_type)) || {}).value) || 0;
        d.reactions += A('post_reaction'); d.comments += A('comment');
      }
    }
  } catch (e) { d = { status: 'error' }; }
  await rc('SET', ck, JSON.stringify(d), 'EX', d.status === 'error' ? 60 : 600);
  return d;
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
    const AUl = String(process.env.ADMIN_USER || '').trim().toLowerCase();
    if (AUl && id === AUl) return err('adm');
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
    const ik = 'lg:a:' + ipOf(req), n = await rc('INCR', ik); await rc('EXPIRE', ik, 600); if (n > 8) return err('wait');
    const g = await rc('INCR', 'lg:ag'); await rc('EXPIRE', 'lg:ag', 600); if (g > 80) return err('wait');
    const AU = String(process.env.ADMIN_USER || '').trim(), AP = String(process.env.ADMIN_PASS || '').trim();
    if (!AU || !AP) return err('noadmin');
    const okU = same(S(b.user, 80).trim().toLowerCase(), AU.toLowerCase()), okP = same(String(b.password || '').trim(), AP);
    if (!(okU && okP)) return err('wrong');
    const t = rnd(24); await rc('SET', 'as:' + t, '1', 'EX', 43200); return { ok: 1, token: t };
  }
  if (a === 'order') {
    const o = b.o || {}, P = ['fb', 'ig', 'sc', 'tb', 'tp', 'tl'], price = Math.round(+o.price);
    if (!P.includes(o.p) || !(price >= 1000 && price <= 10000000)) return err('bad');
    const ip = S((req.headers['x-forwarded-for'] || '').split(',')[0], 45), ol = 'ol:' + ip;
    if ((await rc('INCR', ol)) > 8) return err('wait'); await rc('EXPIRE', ol, 60);
    const id = Date.now().toString(36) + rnd(2), d = day(), meta = o.p === 'fb' || o.p === 'ig', cfg = meta ? (+(await rc('GET', 'cfg:cost')) || DEF_COST) : 0, usd = meta ? +(price / 2000).toFixed(2) : null;
    const code = meta && /^KA-[A-Z0-9]{6}$/.test(o.code || '') ? o.code : '', owner = meta && b.token ? ((await auth(b.token)) || '') : '';
    const r = { id, at: Date.now(), p: o.p, pn: S(o.pn, 40), pk: S(o.pk, 80), price, usd, cost: cfg > 0 ? cfg : null, profit: cfg > 0 ? Math.round(price - usd * cfg) : null, pg: S(o.pg, 100), bz: S(o.bz, 100), lk: S(o.lk, 300), tg: S(o.tg, 100), gd: S(o.gd, 30), ag: S(o.ag, 60), dy: S(o.dy, 10), pay: S(o.pay, 20), ref: S(o.ref, 12).replace(/[^A-Za-z0-9]/g, ''), code, owner, st: 'new' };
    await rp([['SET', 'ord:' + id, JSON.stringify(r)], ['LPUSH', 'orders', id], ['INCRBY', 'tot:all', price], ['INCR', 'cnt:all'], ['INCRBY', 'tot:d:' + d, price], ['INCR', 'cnt:d:' + d], ['INCRBY', 'tot:p:' + o.p, price]]);
    if (code) await rc('SET', 'oc:' + code, id, 'NX');
    if (owner) await rc('RPUSH', 'uo:' + owner, id);
    if (r.ref) { const ow = await rc('GET', 'rc:' + r.ref); if (ow) await rc('RPUSH', 'fr:' + ow, JSON.stringify({ n: r.pg, t: 'order', p: r.pn, at: Date.now() })); }
    return { ok: 1 };
  }
  if (a === 'astats' || a === 'ostatus' || a === 'asetcost') {
    if ((await rc('GET', 'as:' + S(b.token, 80))) !== '1') return err('auth');
    if (a === 'asetcost') { const c = +b.cost; if (!(c >= 0 && c <= 5000)) return err('bad'); await rc('SET', 'cfg:cost', String(+c.toFixed(2))); return { ok: 1 }; }
    if (a === 'ostatus') {
      const raw = await rc('GET', 'ord:' + S(b.id, 30)); if (!raw) return err('bad');
      const o = JSON.parse(raw), st = ['new', 'ok', 'x'].includes(b.st) ? b.st : 'new', d0 = dayOf(o.at);
      if (o.st !== 'ok' && st === 'ok') {
        await rc('INCRBY', 'tot:ok', o.price);
        if (o.usd) {
          const cfg = +(await rc('GET', 'cfg:cost')) || DEF_COST; if (o.cost == null && cfg > 0) o.cost = cfg;
          o.profit = o.cost > 0 ? Math.round(o.price - o.usd * o.cost) : null; o.cu = Math.round(o.usd * 100); o.cp = o.profit || 0;
          await rp([['INCRBY', 'usdc:d:' + d0, o.cu], ['INCRBY', 'prof:d:' + d0, o.cp], ['INCRBY', 'revc:d:' + d0, o.price]]);
        }
      }
      if (o.st === 'ok' && st !== 'ok') {
        await rc('DECRBY', 'tot:ok', o.price);
        if (o.cu != null) { await rp([['DECRBY', 'usdc:d:' + d0, o.cu], ['DECRBY', 'prof:d:' + d0, o.cp || 0], ['DECRBY', 'revc:d:' + d0, o.price]]); o.cu = null; o.cp = null; }
      }
      o.st = st; await rc('SET', 'ord:' + o.id, JSON.stringify(o)); return { ok: 1 };
    }
    const days = Array.from({ length: 14 }, (_, i) => day(i));
    const cmds = [['SCARD', 'users'], ['GET', 'tot:all'], ['GET', 'cnt:all'], ['GET', 'tot:ok'], ['GET', 'tot:d:' + day()], ['GET', 'cnt:d:' + day()], ['LRANGE', 'orders', 0, 149], ['SMEMBERS', 'users'], ['LRANGE', 'red', 0, 59]];
    days.forEach(d => { cmds.push(['PFCOUNT', 'vis:' + d]); cmds.push(['PFCOUNT', 'ply:' + d]); });
    const f0 = cmds.length, ds = Array.from({ length: 30 }, (_, i) => day(i));
    ds.forEach(d => { cmds.push(['GET', 'usdc:d:' + d]); cmds.push(['GET', 'prof:d:' + d]); cmds.push(['GET', 'revc:d:' + d]); });
    cmds.push(['GET', 'cfg:cost']);
    const r = await rp(cmds), ids = r[6] || [], un = (r[7] || []).slice(-300);
    const sum = (n, k) => { let u = 0, p = 0, v = 0; for (let i = 0; i < n; i++) { u += +r[f0 + i * 3] || 0; p += +r[f0 + i * 3 + 1] || 0; v += +r[f0 + i * 3 + 2] || 0; } return { usd: +(u / 100).toFixed(2), profit: p, rev: v }; };
    const [ords, us, pts] = await Promise.all([ids.length ? rc('MGET', ...ids.map(i => 'ord:' + i)) : [], un.length ? rc('MGET', ...un.map(u => 'u:' + u)) : [], un.length ? rc('MGET', ...un.map(u => 'pt:' + u)) : []]);
    const J = x => { try { return JSON.parse(x); } catch (e) { return null; } };
    return { ok: 1, accounts: +r[0] || 0, totAll: +r[1] || 0, cntAll: +r[2] || 0, totOk: +r[3] || 0, totToday: +r[4] || 0, cntToday: +r[5] || 0,
      orders: (ords || []).map(J).filter(Boolean), reds: (r[8] || []).map(J).filter(Boolean),
      users: (us || []).map((x, i) => { const u = x && x !== 'x' ? J(x) : null; return u && { username: u.username, name: u.name, phone: u.phone, email: u.email, avatar: u.avatar, by: u.by, created: u.created, points: +pts[i] || 0 }; }).filter(Boolean).reverse(),
      cost: +r[f0 + 90] || DEF_COST, fin: [sum(1), sum(7), sum(30)],
      days: days.map((d, i) => ({ d, v: +r[9 + i * 2] || 0, p: +r[10 + i * 2] || 0 })) };
  }
  const un = await auth(b.token); if (!un) return err('auth');
  if (a === 'me') { const raw = await rc('GET', 'u:' + un); return { ok: 1, me: await profile(JSON.parse(raw)) }; }
  if (a === 'logout') { await rc('DEL', 's:' + S(b.token, 80)); return { ok: 1 }; }
  if (a === 'mydata') {
    const ids = (await rc('LRANGE', 'uo:' + un, 0, 49)) || [];
    const recs = ids.length ? (await rc('MGET', ...ids.map(i => 'ord:' + i))).map(J).filter(Boolean).reverse() : [];
    const AD = String(process.env.META_AD_ACCOUNT || '').trim(), TK = String(process.env.META_TOKEN || '').trim();
    const rows = await Promise.all(recs.map(async (o, i) => ({ id: o.id, at: o.at, code: o.code, pn: o.pn, pg: o.pg, price: o.price, usd: o.usd, st: o.st,
      data: AD && TK && o.code && o.st !== 'x' && i < 15 ? await metaData(o.code, AD, TK) : null })));
    return { ok: 1, meta: !!(AD && TK), orders: rows };
  }
  if (a === 'claim') {
    const code = S(b.code, 12).toUpperCase().trim(), ck = 'cl:' + un;
    if ((await rc('INCR', ck)) > 10) return err('wait'); await rc('EXPIRE', ck, 3600);
    if (!/^KA-[A-Z0-9]{6}$/.test(code)) return err('nocode');
    const id = await rc('GET', 'oc:' + code), o = id && J(await rc('GET', 'ord:' + id)); if (!o) return err('nocode');
    if (o.owner && o.owner !== un) return err('owned');
    if (!o.owner) { o.owner = un; await rp([['SET', 'ord:' + o.id, JSON.stringify(o)], ['RPUSH', 'uo:' + un, o.id]]); }
    return { ok: 1 };
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

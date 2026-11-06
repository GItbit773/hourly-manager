// Time Keeper push server — a Cloudflare Worker.
//
// The app (on your phone) sends a list of upcoming notifications: { at: epoch ms, title, body, url, tag }.
// A cron trigger runs every minute, pushes anything that's due via Web Push, and forgets it.
//
// Storage (KV binding TK):
//   "devices"      → JSON array of device ids
//   "dev:<id>"     → { secret, sub: PushSubscription JSON, items: [...] }
// Secrets: VAPID_PRIVATE_JWK (P-256 private key, JWK JSON), VAPID_PUBLIC (base64url raw public key)
// Vars:    VAPID_SUBJECT, ALLOWED_ORIGINS (comma separated)

const MAX_ITEMS = 300;
const STALE_MS = 30 * 60 * 1000; // never deliver anything more than 30 min late
// Only relay to real push services (stops the Worker being used to POST anywhere else).
const PUSH_HOSTS = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /\.googleapis\.com$/, /\.mozilla\.com$/, /\.notify\.windows\.com$/];

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0] || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    const { pathname } = new URL(req.url);
    try {
      if (req.method === 'GET' && pathname === '/vapid') return json({ key: env.VAPID_PUBLIC });
      if (req.method === 'GET' && pathname === '/health') return json({ ok: true });
      if (req.method !== 'POST') return json({ error: 'not found' }, 404);
      if (origin && allowed.length && !allowed.includes(origin)) return json({ error: 'origin not allowed' }, 403);

      const body = await req.json();
      const id = String(body.id || ''), secret = String(body.secret || '');
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(id) || secret.length < 16 || secret.length > 128) return json({ error: 'bad id' }, 400);
      const key = 'dev:' + id;
      const existing = await env.TK.get(key, 'json');
      if (existing && existing.secret !== secret) return json({ error: 'forbidden' }, 403);

      if (pathname === '/sync') {
        const sub = body.subscription;
        if (!validSub(sub)) return json({ error: 'bad subscription' }, 400);
        const items = (Array.isArray(body.items) ? body.items : []).slice(0, MAX_ITEMS).map(cleanItem).filter(Boolean);
        await env.TK.put(key, JSON.stringify({ secret, sub, items, updated: Date.now() }));
        await addDevice(env, id);
        return json({ ok: true, items: items.length });
      }
      if (pathname === '/test') {
        if (!existing) return json({ error: 'not registered' }, 404);
        const status = await sendPush(env, existing.sub, { title: body.title || 'Time Keeper', body: body.body || 'Push notifications are working.', url: './', tag: 'test' });
        return json({ ok: status < 300, status });
      }
      if (pathname === '/unsubscribe') {
        await env.TK.delete(key);
        await removeDevice(env, id);
        return json({ ok: true });
      }
      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runDue(env));
  },
};

async function runDue(env) {
  const ids = (await env.TK.get('devices', 'json')) || [];
  const now = Date.now();
  for (const id of ids) {
    const key = 'dev:' + id;
    const dev = await env.TK.get(key, 'json');
    if (!dev) { await removeDevice(env, id); continue; }
    const due = dev.items.filter(i => i.at <= now);
    if (!due.length) continue;
    // one notification per tag (the newest), and nothing that's gone stale
    const byTag = new Map();
    for (const i of due) if (now - i.at <= STALE_MS) byTag.set(i.tag || i.at, i);
    let gone = false;
    for (const item of byTag.values()) {
      const status = await sendPush(env, dev.sub, item);
      if (status === 404 || status === 410) { gone = true; break; }
    }
    if (gone) { await env.TK.delete(key); await removeDevice(env, id); continue; }
    dev.items = dev.items.filter(i => i.at > now);
    await env.TK.put(key, JSON.stringify(dev));
  }
}

function validSub(sub) {
  try {
    const u = new URL(sub.endpoint);
    return u.protocol === 'https:' && PUSH_HOSTS.some(r => r.test(u.hostname)) &&
      typeof sub.keys?.p256dh === 'string' && typeof sub.keys?.auth === 'string';
  } catch { return false; }
}
function cleanItem(i) {
  const at = Number(i && i.at);
  if (!Number.isFinite(at)) return null;
  const s = (v, n) => String(v ?? '').slice(0, n);
  return { at, title: s(i.title, 80), body: s(i.body, 240), url: s(i.url, 120), tag: s(i.tag, 40) };
}
async function addDevice(env, id) {
  const ids = (await env.TK.get('devices', 'json')) || [];
  if (!ids.includes(id)) { ids.push(id); await env.TK.put('devices', JSON.stringify(ids.slice(-50))); }
}
async function removeDevice(env, id) {
  const ids = (await env.TK.get('devices', 'json')) || [];
  if (ids.includes(id)) await env.TK.put('devices', JSON.stringify(ids.filter(x => x !== id)));
}

/* ---------------- Web Push (RFC 8030 + VAPID RFC 8292 + aes128gcm RFC 8291) ---------------- */
const te = new TextEncoder();
const b64u = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const concat = (...arrs) => { const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0)); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

async function vapidHeader(env, endpoint) {
  const aud = new URL(endpoint).origin;
  const head = b64u(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(te.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT })));
  const key = await crypto.subtle.importKey('jwk', JSON.parse(env.VAPID_PRIVATE_JWK), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(`${head}.${claims}`));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${env.VAPID_PUBLIC}`;
}

async function encrypt(sub, plaintext) {
  const uaPublic = fromB64u(sub.keys.p256dh), authSecret = fromB64u(sub.keys.auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(te.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(plaintext, new Uint8Array([2]))));
  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0); new DataView(header.buffer).setUint32(16, 4096); header[20] = asPublic.length; header.set(asPublic, 21);
  return concat(header, cipher);
}

async function sendPush(env, sub, item) {
  const payload = te.encode(JSON.stringify({ title: item.title, body: item.body, url: item.url, tag: item.tag }));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidHeader(env, sub.endpoint),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '1800',
      Urgency: 'high',
    },
    body: await encrypt(sub, payload),
  });
  return res.status;
}

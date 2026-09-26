'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 3000);
const BASE = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const CLIENT_ID = process.env.KICK_CLIENT_ID || '';
const CLIENT_SECRET = process.env.KICK_CLIENT_SECRET || '';
const subscribers = new Set();
const oauthStates = new Map();
const seenEvents = new Set();
let publicKeyPem = '';
let connectionState = 'بانتظار ربط كيك';

function badgeLabel(badge) {
  const type = String(badge?.type || '').toLowerCase();
  const label = String(badge?.text || '').toLowerCase();
  if (/moderator|moderator|\bmod\b/.test(type + ' ' + label)) return 'MOD';
  if (/\bvip\b/.test(type + ' ' + label)) return 'VIP';
  if (/\bog\b|original gangster/.test(type + ' ' + label)) return 'OG';
  return '';
}
function normalizeMessage(payload) {
  const sender = payload?.sender || {};
  const identity = sender.identity || {};
  const rawBadges = Array.isArray(identity.badges) ? identity.badges : [];
  const badges = [...new Set(rawBadges.map(badgeLabel).filter(Boolean))];
  return {
    id: String(payload?.message_id || crypto.randomUUID()),
    username: String(sender.username || 'مشاهد').slice(0, 40),
    content: String(payload?.content || '').slice(0, 600),
    color: /^#[0-9a-f]{6}$/i.test(identity.username_color || '') ? identity.username_color : '',
    badges,
    sentAt: payload?.created_at || new Date().toISOString()
  };
}
function sendEvent(client, type, data) {
  client.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(message) {
  for (const client of subscribers) sendEvent(client, 'message', message);
}
function readRequest(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(new Error('body-too-large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}
function json(res, status, obj) { send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8'); }
function verifyWebhook(headers, rawBody, pem = publicKeyPem) {
  const id = headers['kick-event-message-id'];
  const timestamp = headers['kick-event-message-timestamp'];
  const signature = headers['kick-event-signature'];
  if (!id || !timestamp || !signature || !pem) return false;
  const signed = Buffer.from(`${id}.${timestamp}.${rawBody.toString('utf8')}`);
  try {
    return crypto.verify('RSA-SHA256', signed, pem, Buffer.from(signature, 'base64'));
  } catch { return false; }
}
async function kickFetch(pathname, token, init = {}) {
  const response = await fetch(`https://api.kick.com${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(init.headers || {}) }
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!response.ok) throw new Error(data.message || `Kick API returned ${response.status}`);
  return data;
}
function page(pathname) {
  const file = path.join(__dirname, 'public', pathname);
  try { return fs.readFileSync(file); } catch { return null; }
}

const server = http.createServer(async (req, res) => {
  const base = BASE || `http://localhost:${PORT}`;
  const url = new URL(req.url, base);
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, connected: connectionState === 'متصل بكيك', state: connectionState, overlay: '294x733' });
    }
    if (req.method === 'GET' && url.pathname === '/') {
      const html = `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PRIME Chat setup</title><style>body{background:#07101f;color:#eaf5ff;font:16px Arial;max-width:700px;margin:50px auto;padding:24px}a{color:#69caff}.card{background:#101e33;padding:24px;border:1px solid #246aa3;border-radius:16px}code{color:#81d7ff}</style><div class="card"><h1>PRIME Blue Chat</h1><p>بعد إعداد التطبيق والاستضافة، اربط حساب كيك من هذا الرابط:</p><p><a href="/auth/kick">ربط حساب كيك</a></p><p>ثم أضف هذا الرابط إلى OBS كـ Browser Source:</p><p><code>${base}/overlay</code></p><p>مقاس المصدر: <b>294 × 733</b>.</p><p>الحالة: <b>${connectionState}</b></p></div></html>`;
      return send(res, 200, html, 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/overlay') {
      const html = page('index.html');
      return html ? send(res, 200, html, 'text/html; charset=utf-8') : send(res, 404, 'Overlay not found');
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write('retry: 3000\n\n');
      sendEvent(res, 'status', { state: connectionState });
      subscribers.add(res);
      const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keep-alive\n\n'); }, 20000);
      req.on('close', () => { clearInterval(heartbeat); subscribers.delete(res); });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/auth/kick') {
      if (!BASE || !CLIENT_ID || !CLIENT_SECRET) return send(res, 503, 'أكمل إعداد PUBLIC_BASE_URL وKICK_CLIENT_ID وKICK_CLIENT_SECRET في إعدادات الاستضافة.');
      const state = crypto.randomBytes(24).toString('hex');
      const verifier = crypto.randomBytes(32).toString('base64url');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      oauthStates.set(state, { verifier, created: Date.now() });
      for (const [key, value] of oauthStates) if (Date.now() - value.created > 10 * 60 * 1000) oauthStates.delete(key);
      const query = new URLSearchParams({
        response_type: 'code', client_id: CLIENT_ID, redirect_uri: `${BASE}/auth/callback`,
        scope: 'user:read events:subscribe', code_challenge: challenge, code_challenge_method: 'S256', state
      });
      res.writeHead(302, { location: `https://id.kick.com/oauth/authorize?${query}` });
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/auth/callback') {
      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      const saved = state && oauthStates.get(state);
      if (!saved || !code) return send(res, 400, 'فشل التحقق من تسجيل الدخول. ارجع وافتح رابط الربط مرة ثانية.');
      oauthStates.delete(state);
      const form = new URLSearchParams({ grant_type: 'authorization_code', client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: `${BASE}/auth/callback`, code_verifier: saved.verifier, code });
      const tokenResponse = await fetch('https://id.kick.com/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
      const tokenData = await tokenResponse.json();
      if (!tokenResponse.ok || !tokenData.access_token) throw new Error(tokenData.error_description || tokenData.error || 'تعذر إكمال ربط كيك.');
      const users = await kickFetch('/public/v1/users', tokenData.access_token);
      const user = Array.isArray(users.data) ? users.data[0] : users.data;
      const broadcasterId = user?.user_id || user?.id;
      if (!broadcasterId) throw new Error('تم الدخول، لكن لم أستطع قراءة معرّف قناة كيك.');
      const existing = await kickFetch(`/public/v1/events/subscriptions?broadcaster_user_id=${encodeURIComponent(broadcasterId)}`, tokenData.access_token);
      const hasSubscription = (existing.data || []).some(item => item.event === 'chat.message.sent' && Number(item.version) === 1);
      let subscriptionMessage = 'تم التحقق من اشتراك الرسائل الموجود.';
      if (!hasSubscription) {
        const created = await kickFetch('/public/v1/events/subscriptions', tokenData.access_token, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ broadcaster_user_id: Number(broadcasterId), method: 'webhook', events: [{ name: 'chat.message.sent', version: 1 }] })
        });
        subscriptionMessage = created.message || 'تم إنشاء اشتراك رسائل الشات.';
      }
      connectionState = 'متصل بكيك';
      for (const client of subscribers) sendEvent(client, 'status', { state: connectionState });
      return send(res, 200, `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{background:#07101f;color:#eaf5ff;font:18px Arial;padding:40px;text-align:center}a{color:#69caff}</style><h1>تم ربط كيك ✅</h1><p>${subscriptionMessage}</p><p>أضف <a href="${BASE}/overlay">واجهة PRIME</a> إلى OBS كـ Browser Source.</p></html>`, 'text/html; charset=utf-8');
    }
    if (req.method === 'POST' && url.pathname === '/webhooks/kick') {
      const rawBody = await readRequest(req);
      if (!verifyWebhook(req.headers, rawBody)) return send(res, 401, 'Invalid webhook signature');
      const messageId = req.headers['kick-event-message-id'];
      if (messageId && seenEvents.has(messageId)) return send(res, 200, 'Duplicate ignored');
      if (messageId) { seenEvents.add(messageId); if (seenEvents.size > 5000) seenEvents.delete(seenEvents.values().next().value); }
      if (req.headers['kick-event-type'] === 'chat.message.sent') {
        const payload = JSON.parse(rawBody.toString('utf8'));
        broadcast(normalizeMessage(payload));
      }
      return send(res, 200, 'OK');
    }
    return send(res, 404, 'Not found');
  } catch (error) {
    console.error('Request failed:', error.message);
    return send(res, 500, `صار خطأ في الربط: ${error.message}`);
  }
});

async function loadPublicKey() {
  try {
    const response = await fetch('https://api.kick.com/public/v1/public-key');
    const result = await response.json();
    const key = result?.data?.public_key || result?.data?.key || result?.public_key;
    if (key) publicKeyPem = key.includes('BEGIN PUBLIC KEY') ? key : `-----BEGIN PUBLIC KEY-----\n${key}\n-----END PUBLIC KEY-----`;
    if (!publicKeyPem) console.error('Kick public key missing from API response.');
  } catch (error) { console.error('Could not fetch Kick public key:', error.message); }
}
if (require.main === module) {
  loadPublicKey();
  server.listen(PORT, () => console.log(`PRIME chat server listening on ${PORT}`));
}

module.exports = { badgeLabel, normalizeMessage, verifyWebhook };

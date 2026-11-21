// Personal Helper relay: receives watch data from the HC Webhook Android app and stores it in Firestore.
//
//   POST /hc    Authorization: Bearer <HC_TOKEN>    body: HC Webhook JSON payload
//   GET  /      health check
//
// Secrets (npx wrangler secret put ...): FIREBASE_SA (service account JSON), HC_TOKEN (any long random string).
// Vars (wrangler.toml): OWNER_UID (your Firebase Auth uid).
import { transform, writes, plain, dailyWrite, bodyWrite } from './hc.js';
import { sumIntervals } from '../web/js/activity.js';

let google = null;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') return json({ ok: true, service: 'personal-helper-relay' });
    if (url.pathname !== '/hc') return json({ error: 'not found' }, 404);
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
    if (!env.HC_TOKEN || !(await sameSecret(request.headers.get('Authorization') || '', 'Bearer ' + env.HC_TOKEN))) {
      return json({ error: 'unauthorized' }, 401);
    }
    let payload;
    try { payload = await request.json(); } catch (_) { return json({ error: 'body is not JSON' }, 400); }
    try {
      const sa = JSON.parse(env.FIREBASE_SA);
      const root = `projects/${sa.project_id}/databases/(default)/documents/users/${env.OWNER_UID}`;
      const result = transform(payload);
      const all = writes(result, root, Date.now());
      const token = await googleToken(sa);
      const api = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents`;
      const call = async (path, body) => {
        const r = await fetch(api + path, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error(`Firestore ${r.status}: ${(await r.text()).slice(0, 300)}`);
        return r.json();
      };
      for (let i = 0; i < all.length; i += 400) await call(':commit', { writes: all.slice(i, i + 400) });

      // Refresh the small per-day summary from the whole day's records.
      const days = [...result.days.keys()];
      if (days.length) {
        const got = await call(':batchGet', { documents: days.map(d => `${root}/activity/${d}`), mask: { fieldPaths: ['steps', 'cal', 'dist'] } });
        const summaries = got.filter(x => x.found).map(x => {
          const f = plain({ mapValue: { fields: x.found.fields || {} } });
          return dailyWrite(root, x.found.name.split('/').pop(), {
            steps: Math.round(sumIntervals(f.steps || {})), kcal: Math.round(sumIntervals(f.cal || {})), km: sumIntervals(f.dist || {}) / 1000,
          });
        });
        if (summaries.length) await call(':commit', { writes: summaries });
      }

      // Latest weight / resting HR / VO2 max / body fat for the Plan page, kept only if newer than what's stored.
      if (Object.keys(result.body).length) {
        const got = await call(':batchGet', { documents: [`${root}/meta/body`] });
        const doc = got.find(x => x.found?.name?.endsWith('/meta/body'));
        const w = bodyWrite(root, doc ? plain({ mapValue: { fields: doc.found.fields || {} } }) : null, result.body);
        if (w) await call(':commit', { writes: [w] });
      }
      return json({ ok: true, days, exercises: result.exercises.length });
    } catch (e) {
      // 5xx makes HC Webhook retry later.
      return json({ error: String(e.message || e) }, 502);
    }
  },
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function sameSecret(a, b) {
  const te = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', te.encode(a)), crypto.subtle.digest('SHA-256', te.encode(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}

// An access token for Firestore from the service account key, kept until shortly before it expires.
async function googleToken(sa) {
  if (google && google.until > Date.now() + 60e3) return google.token;
  const now = Math.floor(Date.now() / 1000), te = new TextEncoder();
  const part = o => b64url(te.encode(JSON.stringify(o)));
  const unsigned = part({ alg: 'RS256', typ: 'JWT', kid: sa.private_key_id }) + '.' + part({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  });
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, te.encode(unsigned)));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + unsigned + '.' + b64url(sig),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error('Google refused the Firebase key (' + (d.error_description || d.error || r.status) + ')');
  google = { token: d.access_token, until: Date.now() + (d.expires_in || 3600) * 1000 };
  return google.token;
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

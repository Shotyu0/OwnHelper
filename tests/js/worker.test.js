import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import worker from '../../relay/worker.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const sa = { project_id: 'proj', client_email: 'svc@proj.iam.gserviceaccount.com', private_key_id: 'k1',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const env = { FIREBASE_SA: JSON.stringify(sa), HC_TOKEN: 'secret-token', OWNER_UID: 'uid123' };
const ROOT = 'projects/proj/databases/(default)/documents/users/uid123';

function fakeGoogle() {
  const calls = [];
  globalThis.fetch = async (url, opt = {}) => {
    calls.push({ url: String(url), body: opt.body });
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
      const assertion = new URLSearchParams(opt.body).get('assertion');
      const [h, p, sig] = assertion.split('.');
      const ok = createVerify('RSA-SHA256').update(h + '.' + p).verify(publicKey, Buffer.from(sig, 'base64url'));
      return Response.json(ok ? { access_token: 'tok', expires_in: 3600 } : { error: 'bad sig' }, { status: ok ? 200 : 400 });
    }
    if (String(url).endsWith(':batchGet')) {
      return Response.json([{ found: { name: ROOT + '/activity/2026-11-21', fields: {
        steps: { mapValue: { fields: { a_x: { mapValue: { fields: { c: { integerValue: '4321' }, s: { integerValue: '0' }, e: { integerValue: '1' } } } } } } } } } }]);
    }
    if (String(url).endsWith(':commit')) return Response.json({});
    return new Response('unexpected', { status: 500 });
  };
  return calls;
}

const post = (body, auth = 'Bearer secret-token') => new Request('https://relay.example/hc', {
  method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('relay rejects a wrong token and non-JSON bodies', async () => {
  fakeGoogle();
  assert.equal((await worker.fetch(post({}, 'Bearer nope'), env)).status, 401);
  assert.equal((await worker.fetch(new Request('https://relay.example/hc', { method: 'POST', headers: { Authorization: 'Bearer secret-token' }, body: 'x' }), env)).status, 400);
  assert.equal((await worker.fetch(new Request('https://relay.example/'), env)).status, 200);
});

test('relay signs in with the service account and writes activity + daily summary', async () => {
  const calls = fakeGoogle();
  const res = await worker.fetch(post({ timezone: 'America/New_York', steps: [{ count: 4321, start_time: '2026-11-21T05:00:00Z', end_time: '2026-11-22T05:00:00Z' }] }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, days: ['2026-11-21'], exercises: 0 });
  const commits = calls.filter(c => c.url.endsWith(':commit')).map(c => JSON.parse(c.body));
  assert.equal(commits[0].writes[0].update.name, ROOT + '/activity/2026-11-21');
  const daily = commits[1].writes[0];
  assert.equal(daily.update.name, ROOT + '/daily/2026-11-21');
  assert.equal(daily.update.fields.steps.integerValue, '4321');
});

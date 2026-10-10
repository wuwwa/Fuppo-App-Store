import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { sourceFingerprint } from '../scripts/source-fingerprint.mjs';
const origin='http://127.0.0.1:4173';
const request=path=>fetch(origin+path,{signal:AbortSignal.timeout(5000)});
let ready=false;
for(let i=0;i<30;i++){try{const r=await request('/healthz');if(r.ok&&(await r.text()).trim()==='ok'){ready=true;break;}}catch{}await delay(1000);}
assert.ok(ready,'Container health gate failed');
const page=await request('/');assert.equal(page.status,200);
assert.equal(page.headers.get('x-content-type-options'),'nosniff');
assert.equal(page.headers.get('x-frame-options'),'DENY');
assert.match(page.headers.get('content-security-policy')||'',/frame-ancestors 'none'/);
assert.match(await page.text(),/<html\b/i,'Application entrypoint must be HTML');
const response=await request('/build-info.json');assert.equal(response.status,200);
const info=await response.json();assert.equal(info.target,'web');
assert.equal(info.sharedSourceSha256,sourceFingerprint());
console.log('Container health, headers, entrypoint and source fingerprint pass.');

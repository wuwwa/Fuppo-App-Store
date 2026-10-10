import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';import {join} from 'node:path';
import {treeHash,validCache,withLock} from '../scripts/build-cache.mjs';
function fixture(t){const root=mkdtempSync(join(tmpdir(),'delivery-pipeline-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
test('cache verifies all output bytes, including extra and missing files',t=>{const root=fixture(t);writeFileSync(join(root,'one'),'a');const stamp={key:'key',outputHash:treeHash(root)};assert.equal(validCache(stamp,'key',root),true);assert.equal(validCache(stamp,'other',root),false);writeFileSync(join(root,'one'),'b');assert.equal(validCache(stamp,'key',root),false);writeFileSync(join(root,'one'),'a');writeFileSync(join(root,'extra'),'b');assert.equal(validCache(stamp,'key',root),false);rmSync(join(root,'extra'));rmSync(join(root,'one'));assert.equal(validCache(stamp,'key',root),false);});
test('active or incomplete locks cannot be stolen; exceptions release owned lock',t=>{const lock=join(fixture(t),'lock');withLock(lock,()=>assert.throws(()=>withLock(lock,()=>{}),/Another/));assert.throws(()=>withLock(lock,()=>{throw new Error('failure');}),/failure/);withLock(lock,()=>{});mkdirSync(lock);assert.throws(()=>withLock(lock,()=>{}),/Another/);});

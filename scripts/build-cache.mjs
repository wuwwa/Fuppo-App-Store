import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { projectRoot, sourceFingerprint } from './source-fingerprint.mjs';

export function digest(value) { return createHash('sha256').update(value).digest('hex'); }
export function readJson(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } }
export function saveJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
export function treeHash(root) {
  const hash = createHash('sha256');
  function walk(path, relative = '') {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        if (name === '.DS_Store' || name.startsWith('._') || name === 'xcuserdata') continue;
        walk(join(path, name), `${relative}/${name}`);
      }
    } else if (stat.isFile()) hash.update(relative).update('\0').update(digest(readFileSync(path))).update('\n');
    else throw new Error(`Unsupported build input: ${path}`);
  }
  walk(root);
  return hash.digest('hex');
}
export function withLock(path, work) {
  mkdirSync(dirname(path), { recursive: true });
  try { mkdirSync(path); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = readJson(join(path, 'owner.json'));
    // Never steal an incomplete lock: another process may still be writing it.
    let alive = true;
    if (Number.isInteger(owner?.pid) && owner.pid > 0) {
      try { process.kill(owner.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
    }
    if (alive) throw new Error(`Another iOS build owns ${path}. Wait for it; remove the lock only after confirming its process has stopped.`);
    rmSync(path, { recursive: true });
    mkdirSync(path);
  }
  saveJson(join(path, 'owner.json'), { pid: process.pid });
  try { return work(); } finally { rmSync(path, { recursive: true, force: true }); }
}
export function validCache(stamp, key, output) {
  if (stamp?.key !== key || !existsSync(output)) return false;
  try { return stamp.outputHash === treeHash(output); } catch { return false; }
}

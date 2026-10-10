import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

// Both targets build these inputs. Hashing files rather than a Git revision also
// works in Docker and lets a release identify exactly what went into its bundle.
const sharedInputs = [
  'application', 'scripts', 'package.json', 'package-lock.json', 'Dockerfile', 'deploy', 'fly.toml',
];

export function sourceFingerprint(root = projectRoot) {
  const files = [];
  function collect(path) {
    const full = join(root, path);
    const stat = lstatSync(full);
    if (stat.isDirectory()) {
      for (const name of readdirSync(full).sort()) {
        // Finder metadata can change while a release is building; it is not source.
        if (name === '.DS_Store' || name.startsWith('._')) continue;
        collect(join(path, name));
      }
    } else if (stat.isFile()) {
      files.push(path);
    } else {
      throw new Error(`Unsupported shared input: ${path}`);
    }
  }
  for (const path of sharedInputs) collect(path);
  const hash = createHash('sha256');
  for (const path of files.sort()) {
    const normalized = relative(root, join(root, path)).split(sep).join('/');
    hash.update(normalized).update('\0');
    hash.update(createHash('sha256').update(readFileSync(join(root, path))).digest('hex')).update('\n');
  }
  return hash.digest('hex');
}

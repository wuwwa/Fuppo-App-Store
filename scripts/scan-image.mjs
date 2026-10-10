import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function command(program, args) {
  const result = spawnSync(program, args, { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} failed (${result.status ?? result.signal}). Container check stopped.`);
}

// One policy shared by local releases and GitHub's container check.
export function scanImage(image, run = command) {
  if (!image || image.startsWith('-')) throw new Error('A local image name or ID is required.');
  const scan = ['image', '--image-src', 'docker', '--scanners', 'vuln',
    '--severity', 'HIGH,CRITICAL', '--no-progress', '--timeout', '10m'];
  // Refresh the database and show unfixed issues as well as fixable ones.
  run('trivy', [...scan, '--exit-code', '0', image]);
  // Block fixable High/Critical findings; scanner/database errors also fail.
  run('trivy', [...scan, '--skip-db-update', '--ignore-unfixed', '--exit-code', '1', image]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/scan-image.mjs IMAGE');
    scanImage(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

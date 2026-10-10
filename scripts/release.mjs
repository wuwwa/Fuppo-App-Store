import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scanImage } from './scan-image.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sourceIdentity(run) {
  try {
    const revision = run('git', ['rev-parse', 'HEAD'], true).trim();
    const dirty = run('git', ['status', '--porcelain', '--untracked-files=normal'], true).trim() ? '1' : '0';
    return /^[a-f0-9]{40}$/.test(revision) ? [
      '--build-arg', `PIPELINE_SOURCE_REVISION=${revision}`,
      '--build-arg', `PIPELINE_SOURCE_DIRTY=${dirty}`,
    ] : [];
  } catch { return []; }
}

function command(program, args, capture = false) {
  console.log(`\n> ${program} ${args.join(' ')}`);
  const result = spawnSync(program, args, {
    cwd: root,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw new Error(`Cannot run ${program}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${program} failed (${result.status ?? result.signal}). Release stopped.`);
  return result.stdout?.trim() ?? '';
}

function verifyDeploymentSource(run) {
  const branch = run('git', ['branch', '--show-current'], true);
  if (branch !== 'main') {
    throw new Error('Deployment requires the local main branch after its pull request has merged. Nothing was deployed.');
  }
  const dirty = run('git', ['status', '--porcelain', '--untracked-files=normal'], true);
  if (dirty) throw new Error('Deployment requires a clean checkout. Nothing was deployed.');
  run('git', ['fetch', '--quiet', 'origin', 'main']);
  const head = run('git', ['rev-parse', 'HEAD'], true);
  const remoteMain = run('git', ['rev-parse', 'origin/main'], true);
  if (!/^[a-f0-9]{40}$/.test(head) || head !== remoteMain) {
    throw new Error('Deployment requires HEAD to exactly match origin/main. Nothing was deployed.');
  }
}

// The injected runner lets tests prove failures cannot reach push/deploy.
export function release({
  deploy = false,
  containerOnly = false,
  run = command,
  npmCli = process.env.npm_execpath,
  config = readFileSync(resolve(root, 'fly.toml'), 'utf8'),
  id = randomUUID(),
} = {}) {
  if (!npmCli) throw new Error('Use npm run release:check or npm run deploy.');
  if (deploy && containerOnly) throw new Error('Deployment cannot skip the active unit suite.');
  if (!/^app\s*=\s*['"]example-app['"]\s*$/m.test(config)) {
    throw new Error('Expected Fly app example-app. Review this release script before changing deployment targets.');
  }
  if (deploy && run === command) throw new Error('Public showcase deployment is disabled. Integrate reviewed deployment adapters into your own project first.');
  if (deploy) verifyDeploymentSource(run);
  const tag = `pipeline-check:${id}`;
  const container = `pipeline-check-${id}`;
  const registry = 'registry.fly.io/example-app';
  const remoteTag = `${registry}:checked-${id}`;

  // All prerequisites and checks run before any registry push or deployment.
  let os;
  try {
    os = run('docker', ['info', '--format', '{{.OSType}}'], true);
  } catch {
    throw new Error('Docker is unavailable. Start Docker Desktop with Linux containers, then retry. Nothing was deployed.');
  }
  if (os !== 'linux') throw new Error('Switch Docker Desktop to Linux containers, then retry.');
  run('trivy', ['--version']);
  if (deploy) run('fly', ['version']);
  if (!containerOnly) run(process.execPath, [npmCli, 'run', 'test:release']);
  // Base-image tags can stay on the same digest while Alpine repositories publish
  // security fixes. Rebuild package-install layers so apk upgrade cannot reuse a
  // stale cached result after the vulnerability database learns about that fix.
  run('docker', ['build', '--pull', '--no-cache', '--platform', 'linux/amd64',
    '--build-arg', 'PIPELINE_METRICS_ENABLED=0', ...sourceIdentity(run), '--tag', tag, '.']);
  const image = run('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], true);
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Cannot identify the built image. Release stopped.');

  scanImage(image, run);

  try {
    run('docker', ['run', '--detach', '--name', container,
      '--publish', '127.0.0.1:4173:8080', image]);
    run(process.execPath, ['qa/container-smoke.mjs']);
  } finally {
    // Best-effort diagnostics/cleanup must never turn a failed check into success.
    for (const args of [['logs', container], ['rm', '--force', container]]) {
      try { run('docker', args); } catch (error) { console.warn(error.message); }
    }
  }

  if (!deploy) {
    console.log(containerOnly ? '\nContainer checks passed; units were not rerun. Nothing was pushed or deployed.'
      : '\nRelease checks passed. Nothing was pushed or deployed.');
    return;
  }

  run('fly', ['auth', 'docker']);
  run('docker', ['tag', image, remoteTag]);
  run('docker', ['push', remoteTag]);
  const digests = JSON.parse(run('docker', ['image', 'inspect', '--format', '{{json .RepoDigests}}', remoteTag], true));
  const pinned = digests?.find(digest => new RegExp(`^${registry.replaceAll('.', '\\.')}@sha256:[a-f0-9]{64}$`).test(digest));
  if (!pinned) throw new Error('Cannot identify the pushed image digest. Nothing was deployed.');
  // Use the pushed digest, not a rebuild or a mutable tag.
  run('fly', ['deploy', '--app', 'example-app', '--config', 'fly.toml', '--image', pinned, '--ha=false']);
}

export function deploymentRequested(args) {
  if (args.length === 0) return false;
  if (args.length === 1 && args[0] === '--deploy') return true;
  throw new Error('Usage: npm run release:check OR npm run deploy (no extra arguments).');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const containerOnly = args.length === 1 && args[0] === '--container-only';
    release({ deploy: containerOnly ? false : deploymentRequested(args), containerOnly });
  } catch (error) {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  }
}

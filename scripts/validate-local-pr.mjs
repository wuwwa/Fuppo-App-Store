import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const requiredContexts = ['credentials', 'dependencies', 'unit-tests', 'website-build', 'browser', 'development-touch'];
const shaPattern = /^[a-f0-9]{40}$/;

export function parseOptions(args) {
  const options = { publish: false, container: false, release: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--release') options.release = true;
    else if (args[i] === '--publish') options.publish = true;
    else if (args[i] === '--container') options.container = true;
    else if (args[i] === '--web-only') options.container = false;
    else if (['--pr', '--root', '--gitleaks'].includes(args[i])) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${args[i - 1]}.`);
      options[{ '--pr': 'pr', '--root': 'root', '--gitleaks': 'gitleaks' }[args[i - 1]]] = value;
    } else throw new Error(`Unknown option: ${args[i]}`);
  }
  if (!options.release) throw new Error('The broad baseline is release qualification. Use npm run qa:release only for an explicit release/deployment request; use npm test for development.');
  if (options.pr && !/^[1-9]\d*$/.test(options.pr)) throw new Error('--pr requires a positive PR number.');
  if (options.publish && !options.pr) throw new Error('--publish requires --pr.');
  return options;
}

function command(program, args, { cwd, input, env = process.env } = {}) {
  const result = spawnSync(program, args, {
    cwd, input, env, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.error || result.status !== 0) {
    const error = new Error(`${program} failed (${result.status ?? result.error?.message ?? result.signal}).`);
    error.output = output;
    throw error;
  }
  return output;
}

function sourceIdentity(run) {
  const sha = run('git', ['rev-parse', 'HEAD']).trim();
  if (!shaPattern.test(sha)) throw new Error('Cannot identify the source commit.');
  // Compare committed content, including staged edits. Windows generators can
  // rewrite CRLF/LF while Git's normalized diff remains empty; status alone can
  // report those equivalent bytes as modified. Never ignore a real content diff.
  try {
    run('git', ['diff', '--quiet', '--no-ext-diff', '--no-textconv', '--cached', 'HEAD', '--']);
    run('git', ['diff', '--quiet', '--no-ext-diff', '--no-textconv', 'HEAD', '--']);
  }
  catch { throw new Error('Local validation requires a clean committed checkout. Commit changes and retry.'); }
  if (run('git', ['ls-files', '--others', '--exclude-standard']).trim()) {
    throw new Error('Local validation requires a clean committed checkout. Commit changes and retry.');
  }
  return sha;
}

function repositoryName(run) {
  const remote = run('git', ['remote', 'get-url', 'origin']).trim();
  const match = remote.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!match || !/^[\w.-]+\/[\w.-]+$/.test(match[1])) throw new Error('Expected a GitHub origin remote.');
  return match[1];
}

export function validateLocalPr({
  root = process.cwd(), pr, publish = false, container = false, release = false,
  gitleaks = process.env.GITLEAKS_PATH || 'gitleaks',
  npmCli = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
  environment = process.env,
  execute = command,
  save = (path, content) => writeFileSync(path, content),
  makeDirectory = path => mkdirSync(path, { recursive: true }),
  now = () => new Date().toISOString(),
  report = message => console.log(message),
} = {}) {
  if (!release) throw new Error('Broad validation requires explicit release qualification.');
  if (publish && !pr) throw new Error('Publishing requires a PR number.');
  if (pr && !/^[1-9]\d*$/.test(String(pr))) throw new Error('Invalid PR number.');
  const run = (program, args, extra = {}) => execute(program, args, { cwd: resolve(root), env: environment, ...extra });
  const sha = sourceIdentity(run);
  const repository = repositoryName(run);
  const startedAt = now();
  const directory = resolve(root, '.local', 'validation', `${sha}-${startedAt.replace(/[:.]/g, '-')}`);
  makeDirectory(directory);
  const receipt = {
    schema: 1, repository, pr: pr ? Number(pr) : null, sha, root: resolve(root), startedAt,
    state: 'running', checks: [], published: false,
    scope: 'Configured production-browser suite, development-touch profile, credential scan, clean dependencies, active units and paired web/offline builds. Historical studies are separate.',
    container: container ? 'Requested: local container security/runtime checks.' : 'Not run: optional for contributors; owner must check the release container before deployment.',
    changeSpecificChecks: 'Application feature/browser profiles require separate evidence when relevant; they are not inferred from this baseline.',
    handsOnReview: 'Not recorded; automated browser checks do not establish visual, tactile or listening approval.',
    native: 'Swift, Simulator and physical checks not run; paired offline web content is checked separately from native qualification.',
  };
  const persist = () => save(join(directory, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  const checkPr = () => {
    if (!pr) return;
    const remote = JSON.parse(run('gh', ['pr', 'view', String(pr), '--repo', repository, '--json', 'headRefOid,state']));
    if (remote.state !== 'OPEN' || remote.headRefOid !== sha) {
      throw new Error('The open PR head must exactly match the local commit. Checkout its current head and retry.');
    }
  };
  const status = (context, state, description) => {
    if (!publish) return;
    run('gh', ['api', '--method', 'POST', `repos/${repository}/statuses/${sha}`, '--input', '-'], {
      input: JSON.stringify({ context: `local/${context}`, state, description: description.slice(0, 140) }),
    });
  };
  const assertStable = () => {
    if (sourceIdentity(run) !== sha) throw new Error('Source commit changed during validation. Results cannot pass.');
    checkPr();
  };
  const plans = [
    ['credentials', gitleaks, ['git', '--redact', '--no-banner', '--log-opts=--all']],
    ['dependencies', process.execPath, [npmCli, 'ci']],
    ['unit-tests', process.execPath, [npmCli, 'run', 'test:release']],
    ['website-build', process.execPath, [npmCli, 'run', 'build:platforms']],
    ['browser', process.execPath, [npmCli, 'run', 'qa:browser', '--', '--release', '--forbid-only']],
    ['development-touch', process.execPath, [npmCli, 'run', 'qa:touch', '--', '--forbid-only']],
    ...(container ? [['container', process.execPath, [npmCli, 'run', 'release:check', '--', '--container-only'], {
      env: { ...environment, QA_ORIGIN: 'http://127.0.0.1:4173' },
    }]] : []),
  ];
  let failedCheck;
  // Reject a wrong/closed PR before writing statuses to any commit.
  checkPr();
  try {
    persist();
    // Clear older results for this same commit before rerunning any checks.
    for (const context of ['automated', ...requiredContexts, ...(container ? ['container'] : [])]) status(context, 'pending', 'Awaiting local validation; no Actions runner used.');
    for (const [name, program, args, extra = {}] of plans) {
      assertStable();
      failedCheck = { name, program, args, startedAt: now(), state: 'running', log: `${name}.log` };
      if (name === 'container') failedCheck.targetOrigin = extra.env.QA_ORIGIN;
      receipt.checks.push(failedCheck);
      report(`Running ${name} locally for ${sha.slice(0, 12)}...`);
      persist();
      let output;
      try { output = run(program, args, extra); }
      catch (error) {
        save(join(directory, failedCheck.log), error.output ?? error.message);
        failedCheck.state = 'failed';
        throw error;
      }
      save(join(directory, failedCheck.log), output);
      assertStable();
      failedCheck.state = 'passed';
      failedCheck.completedAt = now();
      failedCheck = undefined;
      persist();
    }
    assertStable();
    receipt.state = 'passed';
    receipt.completedAt = now();
    for (const check of receipt.checks) status(check.name, 'success', `Passed locally on ${sha.slice(0, 12)} at ${receipt.completedAt}.`);
    status('automated', 'success', 'Required local baseline passed; optional container, change-specific, hands-on and native evidence separate.');
    receipt.published = publish;
  } catch (error) {
    receipt.state = 'failed';
    receipt.error = error.message;
    receipt.completedAt = now();
    if (failedCheck && failedCheck.state === 'running') failedCheck.state = 'invalidated';
    // A failure or changed source must never leave a new aggregate success.
    try {
      if (failedCheck) status(failedCheck.name, 'failure', `Local check failed or source changed: ${failedCheck.name}.`);
      status('automated', 'failure', `Local validation failed: ${error.message}`);
    } catch (statusError) { receipt.publicationError = statusError.message; }
  }
  persist();
  save(join(directory, 'report.md'), [
    '# Local validation', '', `Commit: ${sha}`, `Repository: ${repository}`,
    `PR: ${pr ?? 'not attached'}`, `Started: ${startedAt}`, `Result: ${receipt.state}`, `Scope: ${receipt.scope}`, '',
    '| Check | Result | Log |', '| --- | --- | --- |',
    ...receipt.checks.map(check => `| ${check.name} | ${check.state} | ${check.log} |`), '',
    `Container checks: ${receipt.container}`, '',
    `Change-specific checks: ${receipt.changeSpecificChecks}`, `Hands-on toy review: ${receipt.handsOnReview}`, `Native: ${receipt.native}`, '',
    ...(receipt.error ? [`Error: ${receipt.error}`, ''] : []),
    `GitHub statuses published: ${receipt.published ? 'yes' : 'no'}`, '',
  ].join('\n'));
  report(`Local receipt: ${join(directory, 'report.md')}`);
  if (receipt.state === 'failed') throw new Error(`${receipt.error} Receipt: ${directory}`);
  return { receipt, directory };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { validateLocalPr(parseOptions(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Standalone Node.js CLI has no generated declaration file.
import { parseOptions, validateLocalPr } from '../scripts/validate-local-pr.mjs';
const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
function harness() {
    const calls = [];
    const files = new Map();
    const state = { sha, dirty: false, staged: false, untracked: false, prSha: sha, prState: 'OPEN' };
    let override;
    const execute = (program, args, options) => {
        const call = { program, args, input: options.input, env: options.env };
        calls.push(call);
        override?.(call);
        if (program === 'git') {
            if (args[0] === 'rev-parse')
                return state.sha;
            if (args[0] === 'diff') {
                if (args.includes('--cached') ? state.staged : state.dirty)
                    throw new Error('tracked content differs');
                return '';
            }
            if (args[0] === 'ls-files')
                return state.untracked ? 'fixture/new-file.txt' : '';
            if (args[0] === 'remote')
                return 'https://github.com/example/delivery-pipeline-showcase.git';
        }
        if (program === 'gh' && args[0] === 'pr')
            return JSON.stringify({ headRefOid: state.prSha, state: state.prState });
        return 'check output';
    };
    const options = {
        root: process.cwd(), pr: '93', publish: true, release: true, npmCli: 'npm-cli.js', gitleaks: 'gitleaks', execute,
        save: (path, content) => files.set(path, content), makeDirectory: () => { },
        now: () => '2026-10-04T17:00:00.000Z', report: () => { },
    };
    const statuses = () => calls.filter(call => call.input).map(call => JSON.parse(call.input));
    const receipt = () => JSON.parse([...files].find(([path]) => path.endsWith('receipt.json'))[1]);
    return { calls, files, state, options, statuses, receipt, change: (fn) => { override = fn; } };
}
test('publishes success only after every local check and exact source/PR verification', () => {
    const h = harness();
    const { receipt } = validateLocalPr({ ...h.options, container: true });
    assert.equal(receipt.state, 'passed');
    assert.equal(receipt.published, true);
    assert.equal(receipt.sha, sha);
    assert.deepEqual(receipt.checks.map((check) => [check.name, check.state]), [
        ['credentials', 'passed'], ['dependencies', 'passed'], ['unit-tests', 'passed'], ['website-build', 'passed'],
        ['browser', 'passed'], ['development-touch', 'passed'], ['container', 'passed'],
    ]);
    assert.ok(h.statuses().some(status => status.context === 'local/automated' && status.state === 'success'));
    assert.ok(h.calls.filter(call => call.input).every(call => call.args.includes(`repos/example/delivery-pipeline-showcase/statuses/${sha}`)));
    assert.ok(h.calls.find(call => call.args.includes('qa:browser')).args.includes('--forbid-only'));
    assert.ok(h.calls.find(call => call.args.includes('qa:touch')).args.includes('--forbid-only'));
    assert.match(receipt.handsOnReview, /Not recorded/);
    assert.match(receipt.native, /not run/i);
});
test('a failing test stops later work, saves a failed receipt and never publishes success', () => {
    const h = harness();
    h.change(call => { if (call.args.includes('test:release') && call.args[0] === 'npm-cli.js')
        throw new Error('unit failure'); });
    assert.throws(() => validateLocalPr(h.options), /unit failure/);
    assert.equal(h.receipt().state, 'failed');
    assert.ok(!h.calls.some(call => call.args.includes('build:platforms') || call.args.includes('qa:browser') || call.args.includes('release:check')));
    assert.ok(h.statuses().every(status => status.state !== 'success'));
    assert.ok(h.statuses().some(status => status.context === 'local/automated' && status.state === 'failure'));
});
test('dirty source or a mismatched PR prevents checks from starting', () => {
    for (const reason of ['dirty', 'staged', 'untracked', 'head', 'closed']) {
        const h = harness();
        if (reason === 'dirty')
            h.state.dirty = true;
        if (reason === 'staged')
            h.state.staged = true;
        if (reason === 'untracked')
            h.state.untracked = true;
        if (reason === 'head')
            h.state.prSha = otherSha;
        if (reason === 'closed')
            h.state.prState = 'CLOSED';
        assert.throws(() => validateLocalPr(h.options), ['dirty', 'staged', 'untracked'].includes(reason) ? /clean committed checkout/ : /open PR head/);
        assert.ok(!h.calls.some(call => call.program === 'gitleaks' || call.program === process.execPath));
        assert.equal(h.statuses().length, 0, 'wrong source must not alter any commit status');
    }
});
test('source changes or a new PR commit during tests invalidate the result', () => {
    for (const reason of ['commit', 'dirty', 'pr']) {
        const h = harness();
        h.change(call => {
            if (call.args[0] !== 'npm-cli.js' || !call.args.includes('test:release'))
                return;
            if (reason === 'commit')
                h.state.sha = otherSha;
            if (reason === 'dirty')
                h.state.dirty = true;
            if (reason === 'pr')
                h.state.prSha = otherSha;
        });
        assert.throws(() => validateLocalPr(h.options), /changed|clean committed checkout|open PR head/);
        assert.equal(h.receipt().state, 'failed');
        assert.equal(h.receipt().checks.at(-1).state, 'invalidated');
        assert.ok(h.statuses().every(status => status.state !== 'success'));
    }
});
test('required checks reset first and can pass without optional container work', () => {
    const h = harness();
    const { receipt } = validateLocalPr({ ...h.options, container: false });
    assert.equal(receipt.state, 'passed');
    assert.equal(receipt.checks.length, 6);
    const firstCheck = h.calls.findIndex(call => call.program === 'gitleaks');
    const pendingBeforeChecks = h.calls.slice(0, firstCheck).filter(call => call.input).map(call => JSON.parse(call.input));
    assert.equal(pendingBeforeChecks.length, 7);
    assert.equal(pendingBeforeChecks[0].context, 'local/automated');
    assert.ok(pendingBeforeChecks.every(status => status.state === 'pending'));
    const finalStatuses = h.statuses();
    assert.equal(finalStatuses.filter(status => status.context === 'local/container').length, 0);
    assert.equal(finalStatuses.filter(status => status.context === 'local/automated').at(-1).state, 'success');
    assert.match(receipt.container, /Not run: optional/);
    assert.ok(!h.calls.some(call => call.args.includes('release:check')));
});
test('container checks cannot inherit a foreign QA origin', () => {
    const h = harness();
    const { receipt } = validateLocalPr({ ...h.options, container: true, environment: { QA_ORIGIN: 'https://foreign.example', KEEP_SETTING: 'retained' } });
    const containerCall = h.calls.find(call => call.args.includes('release:check'));
    assert.equal(containerCall.env?.QA_ORIGIN, 'http://127.0.0.1:4173');
    assert.equal(containerCall.env?.KEEP_SETTING, 'retained');
    assert.equal(receipt.checks.find((check) => check.name === 'container').targetOrigin, 'http://127.0.0.1:4173');
    assert.match(receipt.scope, /Configured production-browser suite/);
    assert.match(receipt.changeSpecificChecks, /separate evidence/);
});
test('requested container failures are recorded and never reported as passing', () => {
    const h = harness();
    h.change(call => { if (call.args.includes('release:check'))
        throw new Error('container failure'); });
    assert.throws(() => validateLocalPr({ ...h.options, container: true }), /container failure/);
    assert.equal(h.receipt().checks.at(-1).state, 'failed');
    assert.ok(h.statuses().every(status => status.state !== 'success'));
    assert.ok(h.statuses().some(status => status.context === 'local/container' && status.state === 'failure'));
});
test('publishing is opt-in and status API errors cannot produce a passing receipt', () => {
    const local = harness();
    validateLocalPr({ ...local.options, publish: false });
    assert.equal(local.statuses().length, 0);
    assert.equal(local.receipt().published, false);
    const failed = harness();
    failed.change(call => { if (call.input)
        throw new Error('status API unavailable'); });
    assert.throws(() => validateLocalPr(failed.options), /status API unavailable/);
    assert.equal(failed.receipt().state, 'failed');
    assert.equal(failed.receipt().published, false);
});
test('CLI requires an explicit PR for publishing and rejects ambiguous options', () => {
    assert.deepEqual(parseOptions(['--release', '--pr', '93', '--publish', '--web-only']), { pr: '93', publish: true, container: false, release: true });
    assert.throws(() => parseOptions([]), /release qualification/);
    assert.throws(() => validateLocalPr(), /explicit release/);
    assert.deepEqual(parseOptions(['--release', '--container']), { publish: false, container: true, release: true });
    for (const args of [['--publish'], ['--pr', '0'], ['--pr', '--publish'], ['--skip-tests']]) {
        assert.throws(() => parseOptions(args));
    }
});

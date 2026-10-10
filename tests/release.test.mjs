import assert from 'node:assert/strict';
import test from 'node:test';
// The release entry point is plain Node.js so it can run without a TS loader.
// @ts-expect-error No declaration file for the standalone JavaScript CLI.
import { deploymentRequested, release } from '../scripts/release.mjs';
const image = `sha256:${'a'.repeat(64)}`;
const digest = `registry.fly.io/example-app@sha256:${'b'.repeat(64)}`;
const revision = 'c'.repeat(40);
function harness(fail, repoDigests = [digest]) {
    const calls = [];
    const run = (program, args) => {
        const call = { program, args };
        calls.push(call);
        if (fail?.(call))
            throw new Error('simulated failure');
        if (args.includes('{{.OSType}}'))
            return 'linux';
        if (args.includes('{{.Id}}'))
            return image;
        if (args.includes('{{json .RepoDigests}}'))
            return JSON.stringify(repoDigests);
        if (program === 'git' && args[0] === 'branch')
            return 'main';
        if (program === 'git' && args[0] === 'status')
            return '';
        if (program === 'git' && args[0] === 'rev-parse')
            return revision;
        return '';
    };
    return { calls, options: { run, npmCli: 'npm-cli.js', config: "app = 'example-app'", id: 'test-run' } };
}
const isPush = (call) => call.program === 'docker' && call.args[0] === 'push';
const isDeploy = (call) => call.program === 'fly' && call.args[0] === 'deploy';
test('release defaults to checks only and requires the exact deploy flag', () => {
    assert.equal(deploymentRequested([]), false);
    assert.equal(deploymentRequested(['--deploy']), true);
    assert.throws(() => deploymentRequested(['--deply']));
    assert.throws(() => deploymentRequested(['--deploy', '--skip-scan']));
    const { calls, options } = harness();
    release(options);
    assert.ok(!calls.some(call => isPush(call) || call.program === 'fly'));
});
test('scans and checks the immutable image, then deploys the registry digest', () => {
    const { calls, options } = harness();
    release({ ...options, deploy: true });
    const build = calls.find(call => call.program === 'docker' && call.args[0] === 'build');
    assert.ok(build?.args.includes('--pull'));
    assert.ok(build?.args.includes('--no-cache'));
    const scans = calls.filter(call => call.program === 'trivy' && call.args[0] === 'image');
    assert.equal(scans.length, 2);
    assert.ok(scans.every(call => call.args.at(-1) === image));
    assert.ok(!scans[0].args.includes('--ignore-unfixed'));
    assert.ok(!scans[0].args.includes('--skip-db-update'));
    assert.ok(scans[1].args.includes('--ignore-unfixed'));
    assert.equal(scans[1].args[scans[1].args.indexOf('--exit-code') + 1], '1');
    assert.equal(calls.find(call => call.args[0] === 'run')?.args.at(-1), image);
    assert.equal(calls.find(call => call.args[0] === 'tag')?.args[1], image);
    assert.ok(calls.findIndex(call => call.args.includes('qa/container-smoke.mjs')) < calls.findIndex(isPush));
    assert.deepEqual(calls.at(-1), { program: 'fly', args: [
            'deploy', '--app', 'example-app', '--config', 'fly.toml', '--image', digest, '--ha=false',
        ] });
});
test('deployment requires clean synchronized main after merge', () => {
    const cases = [
        { name: 'topic branch', answer: (program, args) => program === 'git' && args[0] === 'branch' ? 'feature/example' : undefined, error: /local main branch/ },
        { name: 'dirty checkout', answer: (program, args) => program === 'git' && args[0] === 'status' ? ' M fixture/index.html' : undefined, error: /clean checkout/ },
        { name: 'unpublished commit', answer: (program, args) => program === 'git' && args[0] === 'rev-parse' && args[1] === 'origin\/main' ? 'd'.repeat(40) : undefined, error: /exactly match origin\/main/ },
    ];
    for (const item of cases) {
        const { calls, options } = harness();
        const baseRun = options.run;
        options.run = (program, args) => item.answer(program, args) ?? baseRun(program, args);
        assert.throws(() => release({ ...options, deploy: true }), item.error, item.name);
        assert.ok(!calls.some(call => call.program === 'docker' || call.program === 'fly'), item.name);
    }
});
for (const stage of ['prerequisites', 'tests', 'build', 'database', 'vulnerabilities', 'container', 'smoke']) {
    test(`a failure in ${stage} prevents all publishing and deployment`, () => {
        const { calls, options } = harness(({ program, args }) => {
            if (stage === 'prerequisites')
                return program === 'docker' && args[0] === 'info';
            if (stage === 'tests')
                return args.includes('test:release');
            if (stage === 'build')
                return args[0] === 'build';
            if (stage === 'database')
                return program === 'trivy' && args[0] === 'image' && !args.includes('--skip-db-update');
            if (stage === 'vulnerabilities')
                return program === 'trivy' && args.includes('--ignore-unfixed');
            if (stage === 'container')
                return program === 'docker' && args[0] === 'run';
            return args.includes('qa/container-smoke.mjs');
        });
        assert.throws(() => release({ ...options, deploy: true }), stage === 'prerequisites' ? /Docker is unavailable/ : /simulated failure/);
        assert.ok(!calls.some(call => isPush(call) || isDeploy(call)));
        if (stage === 'container' || stage === 'smoke')
            assert.ok(calls.some(call => call.args[0] === 'rm'));
    });
}
test('registry push failure prevents deployment', () => {
    const { calls, options } = harness(isPush);
    assert.throws(() => release({ ...options, deploy: true }));
    assert.ok(!calls.some(isDeploy));
});
test('missing registry digest prevents deployment rather than falling back to a tag', () => {
    const { calls, options } = harness(undefined, []);
    assert.throws(() => release({ ...options, deploy: true }), /digest/);
    assert.ok(!calls.some(isDeploy));
});
test('changing the Fly app requires explicit script review', () => {
    const { calls, options } = harness();
    assert.throws(() => release({ ...options, config: "app = 'other-app'" }), /Expected Fly app/);
    assert.equal(calls.length, 0);
});
test('container-only validation avoids a second unit run but cannot be used to deploy', () => {
    const { calls, options } = harness();
    release({ ...options, containerOnly: true });
    assert.ok(!calls.some(call => call.args.includes('test:release')));
    assert.ok(calls.some(call => call.program === 'docker' && call.args[0] === 'build'));
    assert.throws(() => release({ ...options, deploy: true, containerOnly: true }), /cannot skip/);
});

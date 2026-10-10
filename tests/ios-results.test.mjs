import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { defaultUITestIdentifiers, ordinaryUITestIdentifiers, readExpectedIdentifiers,
  validateExecutedCases } from '../scripts/validate-ios-test-results.mjs';

const expected = [...defaultUITestIdentifiers];
const makeSummary = count => ({ result: 'Passed', totalTestCount: count, passedTests: count,
  failedTests: 0, skippedTests: 0, expectedFailures: 0, testFailures: [] });
const makeCase = id => {
  const [target, klass, method] = id.split('/');
  return { nodeType: 'Test Case', name: `${method}()`, result: 'Passed',
    nodeIdentifier: `${klass}/${method}()`, nodeIdentifierURL: `test://com.apple.xcode/ExampleApp/${target}/${klass}/${method}` };
};
const makeTree = ids => ({ testNodes: [{ nodeType: 'Test Plan', name: 'ExampleApp', result: 'Passed', children: [
  { nodeType: 'UI test bundle', name: 'ExampleAppUITests', result: 'Passed', children: [
    { nodeType: 'Test Suite', name: 'ExampleAppUITests', result: 'Passed', children: ids.map(makeCase) } ] } ] }] });
const cases = tree => tree.testNodes[0].children[0].children[0].children;

test('actual-shaped hierarchy qualifies only the exact requested CLI set', () => {
  const result = validateExecutedCases(makeSummary(2), makeTree(expected.toReversed()), expected);
  assert.deepEqual(result, { schemaVersion: 1, state: 'passed', caseCount: 2, executedCases: [...expected].sort() });
});

test('successful process with actual-shaped zero/unknown xcresult is rejected', () => {
  const summary = { ...makeSummary(0), result: 'unknown' };
  const tree = { testNodes: [{ nodeType: 'Test Plan', name: 'ExampleApp', result: 'unknown' }] };
  assert.throws(() => validateExecutedCases(summary, tree, expected), /No test cases executed/);
});

test('failure, skip, expected failure and non-Passed summary never qualify', () => {
  for (const field of ['failedTests', 'skippedTests', 'expectedFailures']) {
    assert.throws(() => validateExecutedCases({ ...makeSummary(2), [field]: 1 }, makeTree(expected), expected), /cannot qualify/);
  }
  assert.throws(() => validateExecutedCases({ ...makeSummary(2), result: 'Failed' }, makeTree(expected), expected), /not Passed/);
  assert.throws(() => validateExecutedCases({ ...makeSummary(2), testFailures: [{}] }, makeTree(expected), expected), /failure records/);
});

test('same count with a wrong method, class or target is rejected', () => {
  for (const wrong of ['ExampleAppUITests/ExampleAppUITests/testUnexpected',
    'ExampleAppUITests/OtherClass/testStartup',
    'OtherTarget/ExampleAppUITests/testStartup']) {
    assert.throws(() => validateExecutedCases(makeSummary(2), makeTree([expected[1], wrong]), expected), /differ/);
  }
});

test('empty and duplicated requested selections are rejected', () => {
  assert.throws(() => validateExecutedCases(makeSummary(2), makeTree(expected), []), /nonempty/);
  assert.throws(() => validateExecutedCases(makeSummary(2), makeTree(expected), [expected[0], expected[0]]), /duplicates/);
  assert.throws(() => validateExecutedCases(makeSummary(2), makeTree(expected), ['ExampleAppUITests/testFoo']), /complete/);
});

test('duplicate executed cases cannot satisfy a count', () => {
  assert.throws(() => validateExecutedCases(makeSummary(2), makeTree([expected[0], expected[0]]), expected), /duplicate/);
});

test('missing, extra and tree/summary count disagreement are rejected', () => {
  assert.throws(() => validateExecutedCases(makeSummary(2), makeTree([expected[0]]), expected), /counts disagree/);
  assert.throws(() => validateExecutedCases(makeSummary(2), makeTree([...expected, 'ExampleAppUITests/ExampleAppUITests/testExtra']), expected), /counts disagree/);
  assert.throws(() => validateExecutedCases(makeSummary(1), makeTree([expected[0]]), expected), /requested case count/);
  assert.throws(() => validateExecutedCases({ ...makeSummary(2), passedTests: 1 }, makeTree(expected), expected), /requested case count/);
});

test('invalid numeric counts and missing failure records fail closed', () => {
  for (const count of [true, '2', -1, 1.5, NaN]) {
    assert.throws(() => validateExecutedCases({ ...makeSummary(2), totalTestCount: count }, makeTree(expected), expected), /counts are invalid/);
  }
  const summary = makeSummary(2);
  delete summary.testFailures;
  assert.throws(() => validateExecutedCases(summary, makeTree(expected), expected), /unavailable/);
});

test('non-Passed tree nodes fail even with Passed summary counts', () => {
  for (const result of ['Failed', 'Skipped', 'Expected Failure', 'unknown', undefined]) {
    const tree = makeTree(expected);
    cases(tree)[0].result = result;
    assert.throws(() => validateExecutedCases(makeSummary(2), tree, expected), /non-Passed/);
  }
  const tree = makeTree(expected);
  tree.testNodes[0].result = 'Failed';
  assert.throws(() => validateExecutedCases(makeSummary(2), tree, expected), /non-Passed/);
});

test('case URL/name/short identifier contradictions and missing URLs fail', () => {
  for (const change of [node => delete node.nodeIdentifierURL,
    node => node.nodeIdentifierURL = 'test://com.apple.xcode/testFoo',
    node => node.name = 'testDifferent()', node => node.nodeIdentifier = 'WrongClass/testDifferent()',
    node => node.nodeIdentifierURL = 'https://example.invalid/ExampleApp/ExampleAppUITests/ExampleAppUITests/testFoo']) {
    const tree = makeTree(expected);
    change(cases(tree)[0]);
    assert.throws(() => validateExecutedCases(makeSummary(2), tree, expected), /identifier/);
  }
});

test('nested repetitions and malformed trees do not silently qualify', () => {
  const tree = makeTree(expected);
  cases(tree)[0].children = [{ nodeType: 'Test Case Run', result: 'Passed' }];
  assert.throws(() => validateExecutedCases(makeSummary(2), tree, expected), /separate qualification policy/);
  assert.throws(() => validateExecutedCases(makeSummary(2), {}, expected), /tree is missing/);
  assert.throws(() => validateExecutedCases(makeSummary(2), { testNodes: [] }, expected), /zero cases/);
});

test('full ordinary inventory excludes physical methods and rejects drift/duplicates', () => {
  const source = `final class ExampleAppUITests: XCTestCase {\n    func testA() {}\n    func testPhysicalB() throws {}\n    func testC() throws {}\n}`;
  assert.deepEqual(ordinaryUITestIdentifiers(source), ['ExampleAppUITests/ExampleAppUITests/testA', 'ExampleAppUITests/ExampleAppUITests/testC']);
  for (const changed of [source.replace('class ExampleAppUITests', 'class Renamed'),
    source.replace('testC', 'testA'), source.replace('    func testC', '  func testC'),
    source + '\nclass Other: XCTestCase {}', 'final class ExampleAppUITests: XCTestCase {}']) {
    assert.throws(() => ordinaryUITestIdentifiers(changed));
  }
});

test('response reader and CLI reject empty runs without exposing test failure contents', t => {
  const directory = mkdtempSync(join(tmpdir(), 'ios-test-results-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const selection = join(directory, 'selection.txt');
  const summary = join(directory, 'summary.json');
  const tree = join(directory, 'tree.json');
  writeFileSync(selection, expected.join('\n') + '\n');
  assert.deepEqual(readExpectedIdentifiers(selection), expected);
  const script = new URL('../scripts/validate-ios-test-results.mjs', import.meta.url);
  const run = () => spawnSync(process.execPath, [fileURLToPath(script), '--summary', summary, '--tests', tree, '--expected-tests', selection], { encoding: 'utf8' });
  writeFileSync(summary, JSON.stringify(makeSummary(2)));
  writeFileSync(tree, JSON.stringify(makeTree(expected)));
  const passed = run();
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(JSON.parse(passed.stdout).caseCount, 2);
  writeFileSync(summary, JSON.stringify({ ...makeSummary(0), result: 'unknown', testFailures: [{ message: 'private-fixture-needle' }] }));
  writeFileSync(tree, JSON.stringify({ testNodes: [] }));
  const failed = run();
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /No test cases executed/);
  assert.doesNotMatch(failed.stdout + failed.stderr, /private-fixture-needle/);
  writeFileSync(selection, '');
  assert.throws(() => readExpectedIdentifiers(selection), /nonempty/);
});

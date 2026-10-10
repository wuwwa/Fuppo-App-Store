#!/usr/bin/env node
/** Verify exported xcresult summary/tree against complete CLI test identifiers.
 * This reads local JSON only; it never starts Xcode, a Simulator or a device.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const identifierPattern = /^[A-Za-z_][\w.-]*\/[A-Za-z_][\w.]*\/test\w+$/;
export const defaultUITestIdentifiers = [
  'ExampleAppUITests/ExampleAppUITests/testStartup',
  'ExampleAppUITests/ExampleAppUITests/testSettingsSurviveRelaunch',
];

function checkedIdentifiers(identifiers) {
  if (!Array.isArray(identifiers) || !identifiers.length || identifiers.some(id =>
    typeof id !== 'string' || id.length > 256 || !identifierPattern.test(id))) {
    throw new Error('Expected tests must be a nonempty list of complete target/class/testMethod CLI identifiers.');
  }
  if (new Set(identifiers).size !== identifiers.length) throw new Error('Expected test selection contains duplicates.');
  return identifiers;
}

export function readExpectedIdentifiers(path) {
  return checkedIdentifiers(readFileSync(path, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean));
}

/** The current suite has one XCTestCase and four-space member declarations.
 * Fail on a changed source shape rather than silently omitting another class.
 */
export function ordinaryUITestIdentifiers(source) {
  const classes = [...source.matchAll(/^\s*(?:final\s+)?class\s+(\w+)\s*:\s*XCTestCase\s*\{/gm)];
  if (classes.length !== 1 || classes[0][1] !== 'ExampleAppUITests') throw new Error('Review the changed UI test class inventory before selecting the full Simulator suite.');
  const methods = [...source.matchAll(/^ {4}func\s+(test\w+)\s*\(\s*\)/gm)].map(match => match[1]);
  const allDeclarations = [...source.matchAll(/^\s*func\s+(test\w+)\s*\(/gm)];
  if (!methods.length || methods.length !== allDeclarations.length) throw new Error('Review the changed UI test method inventory before selecting the full Simulator suite.');
  checkedIdentifiers(methods.map(name => `ExampleAppUITests/ExampleAppUITests/${name}`));
  return checkedIdentifiers(methods.filter(name => !name.startsWith('testPhysical'))
    .map(name => `ExampleAppUITests/ExampleAppUITests/${name}`));
}

function caseIdentifier(node) {
  let url;
  try { url = new URL(node.nodeIdentifierURL); } catch { throw new Error('Executed test case is missing its full identifier URL.'); }
  if (url.protocol !== 'test:' || url.hostname !== 'com.apple.xcode') throw new Error('Executed test case identifier URL is unsupported.');
  let parts;
  try { parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); }
  catch { throw new Error('Executed test case identifier URL is malformed.'); }
  if (parts.length < 4) throw new Error('Executed test case identifier omits target/class/method.');
  const id = parts.slice(-3).join('/');
  checkedIdentifiers([id]);
  const method = parts.at(-1);
  const short = parts.slice(-2).join('/');
  if (node.name !== `${method}()` || (node.nodeIdentifier !== undefined &&
      node.nodeIdentifier.replace(/\(\)$/, '') !== short)) throw new Error('Executed test case identifiers disagree.');
  return id;
}

export function validateExecutedCases(summary, tests, expected) {
  checkedIdentifiers(expected);
  if (!summary || typeof summary !== 'object') throw new Error('Test summary is missing.');
  const counts = ['totalTestCount', 'passedTests', 'failedTests', 'skippedTests', 'expectedFailures'];
  if (counts.some(key => !Number.isSafeInteger(summary[key]) || summary[key] < 0)) throw new Error('Test summary counts are invalid.');
  if (summary.totalTestCount === 0) throw new Error('No test cases executed; process success does not qualify the run.');
  if (summary.result !== 'Passed') throw new Error('Test summary result is not Passed.');
  if (summary.failedTests || summary.skippedTests || summary.expectedFailures) throw new Error('Failed, skipped or expected-failure tests cannot qualify this selection.');
  if (summary.passedTests !== summary.totalTestCount || summary.totalTestCount !== expected.length) throw new Error('Test summary count disagrees with the exact requested case count.');
  if (!Array.isArray(summary.testFailures) || summary.testFailures.length) throw new Error('Test failure records are present or unavailable.');
  if (!tests || !Array.isArray(tests.testNodes)) throw new Error('Executed test tree is missing.');
  const executed = [];
  const visit = nodes => {
    for (const node of nodes) {
      if (!node || typeof node !== 'object' || typeof node.nodeType !== 'string' || node.result !== 'Passed') throw new Error('Executed test tree contains a missing or non-Passed result.');
      if (node.children !== undefined && !Array.isArray(node.children)) throw new Error('Executed test tree children are invalid.');
      if (node.nodeType === 'Test Case') {
        // This qualification profile requests each case once on one destination;
        // repetitions/parameterized runs need a separately reviewed count policy.
        if (node.children?.length) throw new Error('Repeated or nested case runs require a separate qualification policy.');
        executed.push(caseIdentifier(node));
      }
      if (node.children) visit(node.children);
    }
  };
  visit(tests.testNodes);
  if (!executed.length) throw new Error('Executed test tree contains zero cases.');
  if (new Set(executed).size !== executed.length) throw new Error('Executed test tree contains duplicate cases.');
  if (executed.length !== summary.totalTestCount) throw new Error('Executed test tree and summary counts disagree.');
  const requested = new Set(expected);
  const actual = new Set(executed);
  if (expected.some(id => !actual.has(id)) || executed.some(id => !requested.has(id))) throw new Error('Executed cases differ from the exact requested target/class/method selection.');
  return { schemaVersion: 1, state: 'passed', caseCount: executed.length, executedCases: [...executed].sort() };
}

function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--summary', '--tests', '--expected-tests'].includes(key) || options[key] || !args[index + 1]) throw new Error('Use --summary FILE --tests FILE --expected-tests CLI-RESPONSE-FILE.');
    options[key] = args[index + 1];
  }
  if (Object.keys(options).length !== 3) throw new Error('Use --summary FILE --tests FILE --expected-tests CLI-RESPONSE-FILE.');
  const result = validateExecutedCases(JSON.parse(readFileSync(options['--summary'], 'utf8')),
    JSON.parse(readFileSync(options['--tests'], 'utf8')), readExpectedIdentifiers(options['--expected-tests']));
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(`iOS executed-case validation failed: ${error.message}`); process.exitCode = 1; }
}

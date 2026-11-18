import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removeTasks } from '../src/dismiss.ts';
import { parseProjectMd } from '../src/format.ts';

const FILE = `---
id: mission-control
name: Mission Control
status: active
tags: [passion]
where:
  - local: ~/Projects/mission-control
next:
  # most important first
  - task: Live with dashboard v1 for a week, then pick the momentum half-life
    due: 2026-11-16
  - task: "Check Start: the right VS Code window"
  - task: After a week, check the dollars   # cost-state
    due: 2026-11-17
updated: 2026-11-10
---

## What it is
Next: the body keeps its own "next" words.
`;

test('takes one task off, every other byte stays', () => {
  const r = removeTasks(FILE, ['Check Start: the right VS Code window']);
  assert.deepEqual(r?.removed, ['Check Start: the right VS Code window']);
  assert.equal(r!.text, FILE.replace('  - task: "Check Start: the right VS Code window"\n', ''));
});

test('a task with a due line and a trailing comment goes with both', () => {
  const r = removeTasks(FILE, ['After a week, check the dollars', 'Live with dashboard v1 for a week, then pick the momentum half-life']);
  assert.deepEqual(r?.removed.sort(), ['After a week, check the dollars', 'Live with dashboard v1 for a week, then pick the momentum half-life']);
  const p = parseProjectMd(r!.text, 'x');
  assert.equal(p.ok, true);
  if (p.ok) assert.deepEqual(p.project.next, [{ task: 'Check Start: the right VS Code window' }]);
  assert.match(r!.text, /# most important first\n  - task: "Check Start/);
  assert.doesNotMatch(r!.text, /cost-state|2026-11-1[67]/);
});

test('all tasks off leaves next: [], and the file still parses', () => {
  const r = removeTasks(FILE, ['Live with dashboard v1 for a week, then pick the momentum half-life', 'Check Start: the right VS Code window', 'After a week, check the dollars']);
  assert.equal(r?.removed.length, 3);
  assert.match(r!.text, /\nnext: \[\]\n  # most important first\nupdated: 2026-11-10\n---\n/);
  const p = parseProjectMd(r!.text, 'x');
  assert.equal(p.ok && p.project.next.length, 0);
});

test('the last line of the frontmatter can go', () => {
  const text = '---\nid: a\nname: A\nstatus: active\nwhere:\n  - local: ~/a\nupdated: 2026-11-01\nnext:\n  - task: One\n  - task: Two\n---\nBody\n';
  assert.equal(removeTasks(text, ['Two'])!.text, '---\nid: a\nname: A\nstatus: active\nwhere:\n  - local: ~/a\nupdated: 2026-11-01\nnext:\n  - task: One\n---\nBody\n');
});

test('no match, an edited task, a flow list or a broken file: left alone', () => {
  assert.equal(removeTasks(FILE, ['Not a task']), null);
  assert.equal(removeTasks(FILE, ['Check Start']), null); // only the exact text counts
  assert.equal(removeTasks(FILE, []), null);
  const flow = FILE.replace(/next:[\s\S]*?updated/, 'next: [{task: One}, {task: Two}]\nupdated');
  assert.equal(removeTasks(flow, ['One']), null);
  assert.equal(removeTasks('no frontmatter', ['One']), null);
  const bad = FILE.replace('status: active', 'status: live');
  assert.equal(removeTasks(bad, ['Check Start: the right VS Code window']), null);
});

test('an item written on one line ({task: ...}) comes off too', () => {
  const oneLine = FILE.replace(/next:[\s\S]*?updated/, 'next:\n  - {task: One, due: 2026-11-20}\n  - task: Two\nupdated');
  assert.equal(removeTasks(oneLine, ['One'])!.text, oneLine.replace('  - {task: One, due: 2026-11-20}\n', ''));
});

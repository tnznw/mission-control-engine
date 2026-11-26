import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountId } from '../src/account.ts';
import { limitDirs, parseUsage, readLimits } from '../src/limits.ts';

const answer = {
  subscription_type: 'team',
  rate_limits: {
    five_hour: { utilization: 64, resets_at: '2026-11-24T14:10:00.08+00:00' },
    limits: [
      { kind: 'session', percent: 64, resets_at: '2026-11-24T14:10:00.5+00:00', scope: null, is_active: false },
      { kind: 'weekly_all', percent: 61, resets_at: '2026-11-24T12:00:00.5+00:00', scope: null, is_active: true },
      { kind: 'weekly_scoped', percent: 21, resets_at: null, scope: { model: { id: null, display_name: 'Fable' } }, is_active: false },
      { kind: 'session_scoped', percent: 3, resets_at: null, scope: { model: { id: null, display_name: 'Fable' } }, is_active: false },
      { kind: 'session', percent: 'n/a' },
      { kind: 'session', percent: NaN },
      { kind: ' ', percent: 5 },
    ],
  },
};

test('limits: the windows as the Claude panel lists them, with reset times in epoch seconds', () => {
  assert.deepEqual(parseUsage(answer), {
    plan: 'team',
    windows: [
      { kind: 'session', label: 'Session', percent: 64, resetsAt: Date.parse('2026-11-24T14:10:00Z') / 1000, active: false },
      { kind: 'weekly_all', label: 'Weekly', percent: 61, resetsAt: Date.parse('2026-11-24T12:00:00Z') / 1000, active: true },
      { kind: 'weekly_scoped', label: 'Fable weekly', percent: 21, resetsAt: null, active: false },
      { kind: 'session_scoped', label: 'Fable session', percent: 3, resetsAt: null, active: false },
    ],
  });
  // An older Claude Code without the list: the two windows it has.
  assert.deepEqual(parseUsage({ rate_limits: { five_hour: { utilization: 120, resets_at: 'x' }, seven_day: { utilization: 5 } } })!.windows.map((w) => [w.label, w.percent, w.resetsAt]), [['Session', 100, null], ['Weekly', 5, null]]);
  assert.equal(parseUsage({ subscription_type: 'pro' }), null, 'no limits: an API key, or not signed in');
  assert.equal(parseUsage(null), null);
});

test('limits: sign-in folders, a folder of them, and each account read once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-limits-'));
  const signIn = (name: string, uuid: string) => {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: uuid } }));
  };
  signIn('b', 'u-1');
  signIn('a', 'u-2');
  signIn('c', 'u-1'); // the same account signed in twice
  mkdirSync(join(root, 'empty'));
  writeFileSync(join(root, 'file'), '');
  assert.deepEqual(limitDirs(['default', `${root}/*`, join(root, 'a')]), ['', join(root, 'a'), join(root, 'b'), join(root, 'c')]);
  assert.deepEqual(limitDirs([join(root, 'missing') + '/*']), []);
  assert.deepEqual(limitDirs(['rel/x']), [join(process.cwd(), 'rel/x')], 'a relative folder is made absolute once');

  const asked: string[] = [];
  const got = await readLimits([join(root, 'a'), join(root, 'b'), join(root, 'c'), join(root, 'empty')], async (d) => { asked.push(d); return d.endsWith('a') ? { usage: { rate_limits: {} } } : { usage: answer }; }, () => 7);
  assert.deepEqual(asked, [join(root, 'a'), join(root, 'b')], 'c is b\'s account; empty has no sign-in');
  assert.deepEqual(got.accounts.map((a) => [a.id, a.plan, a.windows.length, a.at]), [[accountId('u-1'), 'team', 4, 7]], 'a with no windows is left out');
  assert.deepEqual(got.missed.map((m) => [m.dir, m.why.split(' ')[0]]), [[join(root, 'a'), 'no'], [join(root, 'empty'), 'no']]);
  const failed = await readLimits([join(root, 'b')], async () => ({ error: 'could not start Claude Code (claude): spawn claude ENOENT' }));
  assert.deepEqual(failed, { accounts: [], missed: [{ dir: join(root, 'b'), why: 'could not start Claude Code (claude): spawn claude ENOENT' }] }, 'why it failed is kept');
});

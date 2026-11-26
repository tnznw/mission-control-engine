// The Claude account signed in, read from Claude Code's state file: only a short hash leaves the
// laptop; names and emails stay in accounts.json; a laptop shared by several people keeps each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { accountId, accountLabels, currentAccount, readAccounts, saveAccounts, updateAccounts } from '../src/account.ts';

function world() {
  const home = mkdtempSync(join(tmpdir(), 'mc-acct-'));
  process.env.MC_HOME = home;
  process.env.MC_CLAUDE_STATE = join(home, 'claude.json');
  const signIn = (uuid: string, email: string) =>
    writeFileSync(process.env.MC_CLAUDE_STATE!, JSON.stringify({ oauthAccount: { accountUuid: uuid, emailAddress: email, fullName: 'Sam Lee', organizationName: 'Acme' } }));
  return { home, signIn };
}

test('the signed-in account is a short hash; who it is stays on the laptop', () => {
  const { home, signIn } = world();
  assert.equal(currentAccount(1000), ''); // nothing signed in
  signIn('uuid-one', 'sam@example.com');
  const a = currentAccount(1000);
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.equal(a, accountId('uuid-one'));
  assert.equal(readAccounts()[a].email, 'sam@example.com');
  assert.equal(statSync(join(home, 'accounts.json')).mode & 0o777, 0o600);

  // Someone else signs in on the same laptop: a second account, the first kept.
  signIn('uuid-two', 'kim@example.com');
  const b = currentAccount(2000);
  assert.notEqual(a, b);
  assert.deepEqual(Object.keys(readAccounts()).sort(), [a, b].sort());
});

test('names given go to the hub as id and name only, never an email', () => {
  const { home, signIn } = world();
  signIn('uuid-one', 'sam@example.com');
  const a = currentAccount(1000);
  assert.deepEqual(accountLabels(), []);
  const seen = readAccounts();
  seen[a].label = 'Sam';
  saveAccounts(seen);
  assert.deepEqual(accountLabels(), [{ id: a, label: 'Sam' }]);
  assert.doesNotMatch(JSON.stringify(accountLabels()), /@/);
  // Noted at most once an hour: a prompt a minute later does not rewrite the file.
  const before = readFileSync(join(home, 'accounts.json'), 'utf8');
  currentAccount(1060);
  assert.equal(readFileSync(join(home, 'accounts.json'), 'utf8'), before);
});

test('a damaged accounts file is never rewritten from nothing', () => {
  const { home, signIn } = world();
  writeFileSync(join(home, 'accounts.json'), '{"abc": {"email": "x", "label": "Sa'); // half written
  signIn('uuid-one', 'sam@example.com');
  assert.match(currentAccount(1000), /^[0-9a-f]{12}$/); // the id still goes with the event
  assert.equal(readFileSync(join(home, 'accounts.json'), 'utf8'), '{"abc": {"email": "x", "label": "Sa');
});

test('the state file is read again only when it changes, and a name given meanwhile is kept', () => {
  const { home, signIn } = world();
  signIn('uuid-one', 'sam@example.com');
  const a = currentAccount(1000);
  writeFileSync(process.env.MC_CLAUDE_STATE!, 'not json now'); // changed, so read again
  assert.equal(currentAccount(1001), '');
  signIn('uuid-one', 'sam@example.com');
  assert.equal(currentAccount(5000), a);
  updateAccounts((all) => { all[a].label = 'Sam'; });
  currentAccount(9000); // an hour on: noted again, re-reading first
  assert.equal(readAccounts()[a].label, 'Sam');
  assert.ok(readFileSync(join(home, 'account-cache.json'), 'utf8').includes(a));
});

test('vsCodeAccount: the sign-in VS Code\'s Claude panel is set to, or the main one; unreadable is null', async () => {
  const { vsCodeAccount, accountId } = await import('../src/account.ts');
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const d = mkdtempSync(join(tmpdir(), 'mc-vscode-'));
  const profile = join(d, 'profiles', 'work');
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'uuid-work' } }));
  const home = join(d, 'home');
  mkdirSync(home);
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'uuid-main' } }));
  const ext = join(d, 'extensions');
  mkdirSync(join(ext, 'anthropic.claude-code-2.1.331-darwin-arm64'), { recursive: true });
  const settings = join(d, 'settings.json');
  const read = () => vsCodeAccount(settings, home, ext);
  writeFileSync(settings, JSON.stringify({ 'claudeCode.environmentVariables': [{ name: 'X', value: '1' }, { name: 'CLAUDE_CONFIG_DIR', value: profile }] }));
  assert.equal(read(), accountId('uuid-work'));
  writeFileSync(settings, `﻿{ // a comment\n "a": "http://x, }", /* more */ "claudeCode.environmentVariables": [{ "name": "CLAUDE_CONFIG_DIR", "value": ${JSON.stringify(profile)} }, /* x */ ], }`);
  assert.equal(read(), accountId('uuid-work'), 'comments, trailing commas and a byte-order mark are fine; strings stay as they are');
  writeFileSync(settings, '');
  assert.equal(read(), accountId('uuid-main'), 'empty settings: the main sign-in');
  writeFileSync(settings, JSON.stringify({ 'editor.fontSize': 13 }));
  assert.equal(read(), accountId('uuid-main'), 'no folder set: the main sign-in');
  writeFileSync(settings, JSON.stringify({ 'claudeCode.environmentVariables': [{ name: 'CLAUDE_CONFIG_DIR', value: '~/profiles/work' }] }));
  assert.equal(read(), null, 'not a full path: cannot tell which folder the panel uses');
  writeFileSync(settings, '{ "a": ');
  assert.equal(read(), null, 'unreadable: cannot tell');
  writeFileSync(settings, JSON.stringify({ 'claudeCode.environmentVariables': [{ name: 'CLAUDE_CONFIG_DIR', value: join(d, 'empty') }] }));
  assert.equal(read(), null, 'a folder never signed in');
  assert.equal(vsCodeAccount(settings, home, join(d, 'no-extensions')), undefined, 'VS Code without the Claude extension: nothing to say');
  assert.equal(vsCodeAccount(join(d, 'none.json'), home, ext), undefined, 'no VS Code here: nothing to say');
});

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareRestrictedCodexHome } from './codex-restricted-home.ts';
import { compileCodexRestrictedPolicy, CODEX_READ_PREFIXES } from './codex-restricted-policy.ts';
import { CodexReadBroker, READ_LINE_CAP, RESULT_CAP, readWindow } from './codex-restricted-tools.ts';
const dirs: string[] = [];
const brokers: CodexReadBroker[] = [];
afterEach(() => { for (const b of brokers.splice(0)) b.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup(tools = ['Read', 'Grep', 'Glob', 'Bash']) {
  const root = mkdtempSync(join(tmpdir(), 'cez-read-broker-')); dirs.push(root);
  const cwd = join(root, 'repo'); mkdirSync(cwd);
  const native = join(root, 'native'); mkdirSync(native);
  writeFileSync(join(cwd, 'a.txt'), 'one\ntwo\n');
  const home = prepareRestrictedCodexHome({ cwd }, { HOME: root, CEZ_HOME: join(root, 'cezar'), CODEX_HOME: native });
  const broker = new CodexReadBroker(compileCodexRestrictedPolicy({ allowedTools: tools, bashAllowlist: [...CODEX_READ_PREFIXES] })!, { cwd }, home.toolEnv);
  brokers.push(broker);
  const call = (arguments_: unknown, tool = 'cezar_read') => broker.call({ tool, arguments: arguments_ });
  return { root, cwd, home, broker, call };
}
describe.skipIf(process.platform === 'win32')('cezar executes restricted reads', () => {
  it('reads regular files and refuses symlink escapes, devices and write-shaped payloads', async () => {
    const f = setup();
    expect((await f.call({ tool: 'Read', path: 'a.txt', offset: 2, limit: 1 })).contentItems[0]?.text).toBe('two');
    writeFileSync(join(f.root, 'outside'), 'secret'); symlinkSync(join(f.root, 'outside'), join(f.cwd, 'link'));
    for (const payload of [{ tool: 'Read', path: 'link' }, { tool: 'Read', path: '../outside' }, { tool: 'Read', path: '.' }, { tool: 'Write', path: 'a.txt', content: 'bad' }, { tool: 'Read', path: 'a.txt', command: 'touch x' }]) expect((await f.call(payload)).success).toBe(false);
    expect(readFileSync(join(f.cwd, 'a.txt'), 'utf8')).toBe('one\ntwo\n');
    execFileSync('mkfifo', [join(f.cwd, 'pipe')], { timeout: 5_000 });
    expect((await f.call({ tool: 'Read', path: 'pipe' })).success).toBe(false);
  });
  it('routes replay Bash through the sandbox callback and denies unsealed or conflicting grants', async () => {
    const f = setup();
    const commands: string[] = [];
    const replayShell = async (command: string, signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
      commands.push(command);
      return { ok: true, text: 'sandbox result' };
    };
    const tools = { allowedTools: ['Read', 'Bash'], replayShell };
    expect(() => compileCodexRestrictedPolicy(tools)).toThrow();
    expect(() => compileCodexRestrictedPolicy({ ...tools, enforceReadOnly: true, bashAllowlist: [] })).toThrow();
    const policy = compileCodexRestrictedPolicy({ ...tools, enforceReadOnly: true })!;
    const broker = new CodexReadBroker(policy, { cwd: f.cwd }, f.home.toolEnv);
    brokers.push(broker);
    const command = 'printf fixture > a.txt';
    const result = await broker.call({ tool: 'cezar_read', arguments: { tool: 'Bash', command } });
    expect(result).toMatchObject({ success: true, contentItems: [{ text: 'sandbox result' }] });
    expect(commands).toEqual([command]);
    expect(readFileSync(join(f.cwd, 'a.txt'), 'utf8')).toBe('one\ntwo\n');
  });

  it('executes approved GitHub reads as argv and never invokes the binary for a mutation', async () => {
    const f = setup();
    const bin = join(f.root, 'bin'); mkdirSync(bin);
    const log = join(f.root, 'calls');
    const executable = join(bin, 'gh');
    writeFileSync(executable, `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nappendFileSync(process.env.PROBE_LOG, JSON.stringify(process.argv.slice(2))+'\\n');\nprocess.stdout.write('read-only diff');\n`);
    chmodSync(executable, 0o755);
    const broker = new CodexReadBroker(compileCodexRestrictedPolicy({ allowedTools: ['Read', 'Bash'], bashAllowlist: ['gh pr diff', 'gh repo view'] })!, { cwd: f.cwd }, { ...f.home.toolEnv, PATH: `${bin}:${f.home.toolEnv.PATH}`, PROBE_LOG: log });
    brokers.push(broker);
    execFileSync('git', ['init', '-q'], { cwd: f.cwd, timeout: 5_000 });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/o/r.git'], { cwd: f.cwd, timeout: 5_000 });
    expect((await broker.call({ tool: 'cezar_read', arguments: { tool: 'Bash', command: 'gh pr diff 3' } })).contentItems[0]?.text).toBe('read-only diff');
    for (const command of ['gh pr merge 3', 'gh pr diff 3; gh pr merge 3', 'gh pr diff 3 --web', 'gh api repos/o/r -X DELETE', 'gh pr diff https://evil.example/o/r/pull/3', 'gh pr diff 3 -R evil.example/o/r', 'gh repo view evil.example/o/r', 'gh repo view -- evil.example/o/r']) expect((await broker.call({ tool: 'cezar_read', arguments: { tool: 'Bash', command } })).success).toBe(false);
    execFileSync('git', ['remote', 'set-url', 'origin', 'https://evil.example/o/r.git'], { cwd: f.cwd, timeout: 5_000 });
    expect((await broker.call({ tool: 'cezar_read', arguments: { tool: 'Bash', command: 'gh pr diff 3' } })).success).toBe(false);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['["pr","diff","3"]']);
  });
  it('truncates an oversized read result instead of failing it', async () => {
    const f = setup();
    const bin = join(f.root, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), `#!${process.execPath}\nprocess.stdout.write('x'.repeat(400_000));\n`);
    chmodSync(join(bin, 'gh'), 0o755);
    const broker = new CodexReadBroker(compileCodexRestrictedPolicy({ allowedTools: ['Read', 'Bash'], bashAllowlist: ['gh pr diff'] })!, { cwd: f.cwd }, { ...f.home.toolEnv, PATH: `${bin}:${f.home.toolEnv.PATH}` });
    brokers.push(broker);
    execFileSync('git', ['init', '-q'], { cwd: f.cwd, timeout: 5_000 });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/o/r.git'], { cwd: f.cwd, timeout: 5_000 });
    const res = await broker.call({ tool: 'cezar_read', arguments: { tool: 'Bash', command: 'gh pr diff 3' } });
    expect(res.success).toBe(true);
    const text = res.contentItems[0]?.text ?? '';
    expect(text).toMatch(/^x{63000,}\n\[cezar: output truncated; .*use Read with `ref`/);
    // The notice counts against the cap: a result never exceeds it.
    expect(text.length).toBe(RESULT_CAP);
  });
  it('fails a GitHub read when the remote list overflows instead of validating a truncated list', async () => {
    const f = setup();
    const bin = join(f.root, 'bin'); mkdirSync(bin);
    const log = join(f.root, 'calls');
    writeFileSync(join(bin, 'gh'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.PROBE_LOG, 'called');\n`);
    chmodSync(join(bin, 'gh'), 0o755);
    const broker = new CodexReadBroker(compileCodexRestrictedPolicy({ allowedTools: ['Read', 'Bash'], bashAllowlist: ['gh pr diff'] })!, { cwd: f.cwd }, { ...f.home.toolEnv, PATH: `${bin}:${f.home.toolEnv.PATH}`, PROBE_LOG: log });
    brokers.push(broker);
    execFileSync('git', ['init', '-q'], { cwd: f.cwd, timeout: 5_000 });
    const remotes = Array.from({ length: 3_000 }, (_, i) => `[remote "r${i}"]\n\turl = https://github.com/o/repository-with-a-long-name-${i}.git\n`).join('');
    writeFileSync(join(f.cwd, '.git/config'), readFileSync(join(f.cwd, '.git/config'), 'utf8') + remotes + '[remote "zz"]\n\turl = https://evil.example/o/r.git\n');
    const res = await broker.call({ tool: 'cezar_read', arguments: { tool: 'Bash', command: 'gh pr diff 3' } });
    expect(res.success).toBe(false);
    expect(res.contentItems[0]?.text).toMatch(/maxBuffer/);
    expect(existsSync(log)).toBe(false);
  });
  it('honors the existing network-off setting for brokered GitHub reads', async () => {
    const f = setup();
    const broker = new CodexReadBroker(compileCodexRestrictedPolicy({ allowedTools: ['Read', 'Bash'], bashAllowlist: ['gh pr diff'] })!, { cwd: f.cwd }, f.home.toolEnv, false);
    brokers.push(broker);
    expect((await broker.call({ tool: 'cezar_read', arguments: { tool: 'Bash', command: 'gh pr diff 3' } })).contentItems[0]?.text).toContain('CEZ_CODEX_NETWORK=0');
  });
  it('keeps real git status read-only and prevents a configured fsmonitor from executing', async () => {
    const f = setup();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: f.cwd, stdio: 'pipe', timeout: 10_000 });
    git('init', '-q'); git('add', 'a.txt');
    const marker = join(f.root, 'executed');
    const hook = join(f.root, 'evil'); writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`); chmodSync(hook, 0o755);
    git('config', 'core.fsmonitor', hook);
    const before = statSync(join(f.cwd, '.git/index')).mtimeMs;
    expect((await f.call({ tool: 'Bash', command: 'git status --short' })).success).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(statSync(join(f.cwd, '.git/index')).mtimeMs).toBe(before);
  });
  it('never launches an executor for forbidden commands, MCP, or missing grants', async () => {
    const f = setup(); const marker = join(f.cwd, 'FORBIDDEN');
    for (const command of ['touch FORBIDDEN', 'git push', 'gh pr merge 3', 'gh pr comment 3 --body x', 'git status; touch FORBIDDEN', 'sh -c "touch FORBIDDEN"', 'gh pr view 3 --web']) expect((await f.call({ tool: 'Bash', command })).success).toBe(false);
    expect((await f.call({ tool: 'Read', path: 'a.txt' }, 'mcp__publish')).success).toBe(false);
    const read = setup(['Read']); expect((await read.call({ tool: 'Bash', command: 'git status' })).success).toBe(false);
    expect(existsSync(marker)).toBe(false);
    f.broker.close(); expect((await f.call({ tool: 'Read', path: 'a.txt' })).success).toBe(false);
  });
  it('searches through grep and git when ripgrep is not on PATH', async () => {
    const f = setup();
    execFileSync('git', ['init', '-q'], { cwd: f.cwd, timeout: 10_000 });
    writeFileSync(join(f.cwd, 'b.ts'), 'one\none\none\n');
    const bin = join(f.root, 'no-rg'); mkdirSync(bin);
    for (const tool of ['grep', 'git']) symlinkSync(execFileSync('which', [tool], { encoding: 'utf8' }).trim(), join(bin, tool));
    const broker = new CodexReadBroker(compileCodexRestrictedPolicy({ allowedTools: ['Read', 'Grep', 'Glob'] })!, { cwd: f.cwd }, { ...f.home.toolEnv, PATH: bin });
    brokers.push(broker);
    const call = (args: unknown) => broker.call({ tool: 'cezar_read', arguments: args });
    const grep = await call({ tool: 'Grep', pattern: 'one|two', glob: '*.ts', path: null, limit: 2 });
    expect(grep.success).toBe(true);
    expect(grep.contentItems[0]?.text).toMatch(/b\.ts:1:one\n.*b\.ts:2:one\n\[cezar: first 2 of 3 lines\]$/);
    // The flat schema shows `glob` to Glob too; a pattern put there still lists files.
    const glob = await call({ tool: 'Glob', glob: '*.txt', pattern: null });
    expect(glob).toMatchObject({ success: true, contentItems: [{ text: 'a.txt\n' }] });
    expect((await call({ tool: 'Glob', pattern: '../**' })).success).toBe(false);
  });
  it('names the wrong argument and says so outright when a refused call is repeated', async () => {
    const f = setup();
    const first = await f.call({ tool: 'Read', path: 'a.txt', output_mode: 'content' });
    expect(first.contentItems[0]?.text).toContain('output_mode');
    const denied = { tool: 'Bash', command: 'git grep one HEAD' };
    expect((await f.call(denied)).contentItems[0]?.text).toContain('approved read-only Bash grant');
    const again = await f.call(denied);
    expect(again.success).toBe(false);
    expect(again.contentItems[0]?.text).toContain('refused this exact call before');
  });

  it('reads a file at a pinned commit in bounded ranges, apart from the worktree copy', async () => {
    const f = setup(['Read']);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: f.cwd, encoding: 'utf8', stdio: 'pipe', timeout: 10_000 });
    git('init', '-q'); git('config', 'user.email', 't@example.invalid'); git('config', 'user.name', 't');
    const pinned = Array.from({ length: 1_500 }, (_, i) => `pinned ${i + 1}`).join('\n') + '\n';
    mkdirSync(join(f.cwd, 'src'));
    writeFileSync(join(f.cwd, 'src/big.ts'), pinned);
    git('add', '.'); git('commit', '-qm', 'pin');
    const sha = git('rev-parse', 'HEAD').trim();
    writeFileSync(join(f.cwd, 'src/big.ts'), 'worktree 1\nworktree 2\n');
    const read = async (args: Record<string, unknown>) => (await f.call({ tool: 'Read', path: 'src/big.ts', ...args })).contentItems[0]?.text ?? '';
    expect(await read({ offset: 1, limit: 2 })).toBe('worktree 1\nworktree 2');
    expect(await read({ ref: sha, offset: 1, limit: 2 })).toBe('pinned 1\npinned 2\n[cezar: lines 1-2 of 1500; next offset 3]');
    expect(await read({ ref: sha.slice(0, 12), offset: 1499, limit: 5, glob: null })).toBe('pinned 1499\npinned 1500\n');
    // The default window is 500 lines, not the whole file.
    expect(await read({ ref: sha })).toMatch(/pinned 500\n\[cezar: lines 1-500 of 1500; next offset 501\]$/);
    expect(await read({ ref: sha, offset: 1501 })).toContain('past the end of the file (1500 lines)');
    // A file the commit does not have, a directory, a non-commit, a non-hex ref or a climbing path never reads.
    for (const args of [{ ref: sha, path: 'src/none.ts' }, { ref: sha, path: 'src' }, { ref: sha, path: '../outside' }, { ref: sha, path: join(f.root, 'outside') },
      { ref: 'deadbeefdeadbeef' }, { ref: 'HEAD' }, { ref: `${sha}:a.txt` }, { ref: '--output=x' }, { ref: git('rev-parse', `${sha}:src`).trim() }]) {
      expect((await f.call({ tool: 'Read', path: 'src/big.ts', ...args })).success).toBe(false);
    }
    expect(existsSync(join(f.cwd, 'x'))).toBe(false);
    expect(git('status', '--porcelain')).toBe(' M src/big.ts\n');
  });
  it('reads the exact commit object: no ref-name lookup, tag peeling or replacement objects', async () => {
    const f = setup(['Read']);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: f.cwd, encoding: 'utf8', stdio: 'pipe', timeout: 10_000 });
    git('init', '-q'); git('config', 'user.email', 't@example.invalid'); git('config', 'user.name', 't');
    writeFileSync(join(f.cwd, 'f.txt'), 'first\n'); git('add', '.'); git('commit', '-qm', 'first');
    const first = git('rev-parse', 'HEAD').trim();
    const firstBlob = git('rev-parse', 'HEAD:f.txt').trim();
    writeFileSync(join(f.cwd, 'f.txt'), 'second\n'); git('commit', '-qam', 'second');
    const second = git('rev-parse', 'HEAD').trim();
    const secondBlob = git('rev-parse', 'HEAD:f.txt').trim();
    const read = async (ref: string) => (await f.call({ tool: 'Read', path: 'f.txt', ref })).contentItems[0]?.text;
    // A branch and a tag named like the second commit's short id point at the first: the id still wins.
    git('branch', second.slice(0, 7), first);
    git('tag', second.slice(0, 8), first);
    expect(git('rev-parse', `${second.slice(0, 7)}^{commit}`).trim()).toBe(first);
    expect(await read(second.slice(0, 7))).toBe('second\n');
    expect(await read(second.slice(0, 8))).toBe('second\n');
    expect(await read(second)).toBe('second\n');
    // An annotated tag's own id is not a commit, and is not peeled to one.
    git('tag', '-a', 'v1', '-m', 'v1', first);
    expect((await f.call({ tool: 'Read', path: 'f.txt', ref: git('rev-parse', 'v1').trim() })).success).toBe(false);
    // Replacement refs for the commit and the blob change what plain git shows, not what Read returns.
    git('replace', first, second);
    git('replace', '-f', firstBlob, secondBlob);
    expect(git('cat-file', 'blob', `${first}:f.txt`)).toBe('second\n');
    expect(await read(first)).toBe('first\n');
    expect(await read(first.slice(0, 10))).toBe('first\n');
  });
  it('bounds every Read window: long lines, the result cap and its notice', () => {
    const long = 'y'.repeat(READ_LINE_CAP + 50);
    expect(readWindow(`a\n${long}\nc\n`, 2, 1)).toBe(`${'y'.repeat(READ_LINE_CAP)}… [cezar: line 2 cut at ${READ_LINE_CAP} of ${READ_LINE_CAP + 50} characters]\n[cezar: lines 2-2 of 3; 1 long line cut; next offset 3]`);
    const wide = Array.from({ length: 2_000 }, () => 'z'.repeat(1_000)).join('\n');
    const capped = readWindow(wide, 1, 2_000);
    expect(capped.length).toBeLessThanOrEqual(RESULT_CAP);
    expect(capped).toMatch(/\[cezar: lines 1-(\d+) of 2000; stopped at the 64000-character result cap; next offset \d+\]$/);
    const [, last, next] = /lines 1-(\d+) .* next offset (\d+)/.exec(capped)!;
    expect(Number(next)).toBe(Number(last) + 1);
    // A long line the cap left out is not reported as cut.
    const tail = [...Array.from({ length: 63 }, () => 'z'.repeat(1_000)), 'y'.repeat(READ_LINE_CAP + 500), 'c'].join('\n');
    expect(readWindow(tail, 1, 100)).toMatch(/\n\[cezar: lines 1-63 of 65; stopped at the 64000-character result cap; next offset 64\]$/);
    expect(readWindow('', 1, 10)).toBe('');
    expect(readWindow('one\ntwo', 1, 500)).toBe('one\ntwo');
  });
  it('runs a granted gh from the service PATH when the sealed tool PATH has none, with the tool env unchanged', async () => {
    const f = setup();
    const service = join(f.root, 'service-bin'); mkdirSync(service);
    const log = join(f.root, 'gh-env');
    writeFileSync(join(service, 'gh'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));\nprocess.stdout.write('fallback gh');\n`);
    // Marker stubs that must never run: the fallback is for gh only. Node shebangs, so they run under any PATH.
    const marker = (name: string) => join(f.root, `ran-${name}`);
    for (const name of ['git', 'rg', 'grep']) writeFileSync(join(service, name), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker(name))}, '');\nprocess.stdout.write('stub ${name}\\n');\n`);
    for (const name of ['gh', 'git', 'rg', 'grep']) chmodSync(join(service, name), 0o755);
    const ran = () => ['git', 'rg', 'grep'].filter(name => existsSync(marker(name)));
    // The stubs do run when invoked, even with an empty PATH, so an absent marker means they were never started.
    const empty = join(f.root, 'empty'); mkdirSync(empty);
    for (const name of ['git', 'rg', 'grep']) execFileSync(join(service, name), [], { env: { PATH: empty }, timeout: 10_000 });
    expect(ran()).toEqual(['git', 'rg', 'grep']);
    for (const name of ['git', 'rg', 'grep']) rmSync(marker(name));
    const sealed = join(f.root, 'sealed'); mkdirSync(sealed);
    for (const tool of ['git', 'grep']) symlinkSync(execFileSync('which', [tool], { encoding: 'utf8' }).trim(), join(sealed, tool));
    const toolEnv: NodeJS.ProcessEnv = { ...f.home.toolEnv, PATH: sealed };
    const policy = compileCodexRestrictedPolicy({ allowedTools: ['Read', 'Grep', 'Glob', 'Bash'], bashAllowlist: ['gh pr diff', 'git status'] })!;
    const broker = new CodexReadBroker(policy, { cwd: f.cwd }, toolEnv, true, {}, `relative-dir:${service}`);
    brokers.push(broker);
    const call = (args: unknown) => broker.call({ tool: 'cezar_read', arguments: args });
    execFileSync('git', ['init', '-q'], { cwd: f.cwd, timeout: 5_000 });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/o/r.git'], { cwd: f.cwd, timeout: 5_000 });
    expect(await call({ tool: 'Bash', command: 'gh pr diff 3' })).toMatchObject({ success: true, contentItems: [{ text: 'fallback gh' }] });
    const seen = JSON.parse(readFileSync(log, 'utf8')) as { argv: string[]; env: Record<string, string> };
    expect(seen.argv).toEqual(['pr', 'diff', '3']);
    // Same isolated env: sealed PATH, isolated gh config and home, no service variables.
    expect(seen.env.PATH).toBe(sealed);
    expect(seen.env.GH_CONFIG_DIR).toBe(toolEnv.GH_CONFIG_DIR);
    expect(seen.env.HOME).toBe(toolEnv.HOME);
    for (const [key, value] of Object.entries(seen.env)) if (!['PWD', 'SHLVL', '_'].includes(key)) expect(toolEnv[key]).toBe(value);
    // Host checks still apply before the fallback binary runs.
    expect((await call({ tool: 'Bash', command: 'gh pr diff 3 -R evil.example/o/r' })).success).toBe(false);
    expect((await call({ tool: 'Bash', command: 'gh pr merge 3' })).success).toBe(false);
    // git and search keep resolving from the tool PATH only.
    expect((await call({ tool: 'Bash', command: 'git status --short' })).success).toBe(true);
    expect((await call({ tool: 'Grep', pattern: 'one' })).success).toBe(true);
    expect(ran()).toEqual([]);
    // With git, rg and grep only on the service PATH, none of them is started, while gh still is.
    const bare = new CodexReadBroker(policy, { cwd: f.cwd }, { ...toolEnv, PATH: empty }, true, {}, service);
    brokers.push(bare);
    const bareCall = (args: unknown) => bare.call({ tool: 'cezar_read', arguments: args });
    for (const args of [{ tool: 'Bash', command: 'git status --short' }, { tool: 'Grep', pattern: 'one' }, { tool: 'Glob', pattern: '*.txt' }, { tool: 'Read', path: 'a.txt', ref: 'abcdef0' }, { tool: 'Bash', command: 'gh pr diff 3' }]) {
      const res = await bareCall(args);
      expect(res.success).toBe(false);
      expect(res.contentItems[0]?.text).toMatch(/`(git|grep)` was not found on PATH/);
    }
    expect(await bareCall({ tool: 'Bash', command: 'gh pr diff 3 -R o/r' })).toMatchObject({ success: true, contentItems: [{ text: 'fallback gh' }] });
    expect((await bareCall({ tool: 'Bash', command: 'gh pr diff 3 -R evil.example/o/r' })).success).toBe(false);
    expect(ran()).toEqual([]);
    // Without a gh on either PATH the read fails as before.
    const none = new CodexReadBroker(policy, { cwd: f.cwd }, toolEnv, true, {}, sealed);
    brokers.push(none);
    expect((await none.call({ tool: 'cezar_read', arguments: { tool: 'Bash', command: 'gh pr diff 3' } })).contentItems[0]?.text).toContain('`gh` was not found on PATH');
  });
});

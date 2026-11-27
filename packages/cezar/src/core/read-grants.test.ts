import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { READ_ONLY_BASH_PREFIXES } from '../workflows/capabilities.ts';
import { prepareRestrictedCodexHome } from './codex-restricted-home.ts';
import { codexBashArgv, compileCodexRestrictedPolicy } from './codex-restricted-policy.ts';
import { CodexReadBroker, codexReadTool, partialCloneRefusal } from './codex-restricted-tools.ts';
import { GIT_SHOW_AT_REF } from './read-grants.ts';

// What `resolveAgentStepTools` hands Codex for a live built-in Plan step.
const PLAN_SPEC = { allowedTools: ['Read', 'Grep', 'Glob', 'Bash'], bashAllowlist: [GIT_SHOW_AT_REF], enforceReadOnly: true };
const REVIEW_SPEC = { allowedTools: ['Read', 'Grep', 'Glob', 'Bash'], bashAllowlist: [...READ_ONLY_BASH_PREFIXES] };

const ALLOWED = ['git show HEAD:a.txt', "git show main:'dir/a b.txt'", 'git show abc1234:a.txt', "git show 'HEAD~2:src/x.ts'", 'git show origin/main:a.txt'];
const REFUSED = [
  // Unrelated commands, and other git verbs.
  'ls', 'cat a.txt', 'rm -rf .', 'git log', 'git status', 'git diff HEAD', 'git push origin main', 'git commit -m x', 'git checkout HEAD -- a.txt',
  // Shell composition.
  'git show HEAD:a.txt && rm a.txt', 'git show HEAD:a.txt; rm a.txt', 'git show HEAD:a.txt | sh', 'git show HEAD:a.txt > out.txt',
  'git show $(echo HEAD):a.txt', 'git show `id`:a.txt', 'git show HEAD:a.txt &', 'git show HEAD:a.txt\nrm a.txt',
  // Git options and operands outside `git show <ref>:<path>`.
  'git show', 'git show HEAD', 'git show --stat HEAD', 'git show --output=out.txt HEAD:a.txt', 'git show HEAD:a.txt --output=out.txt',
  'git show --textconv HEAD:a.txt', 'git show --ext-diff HEAD:a.txt', 'git show -p HEAD:a.txt', 'git show HEAD:a.txt HEAD:b.txt',
  'git show HEAD:a.txt -- a.txt', 'git -c core.pager=sh show HEAD:a.txt', 'git --git-dir=/tmp show HEAD:a.txt', 'git show :a.txt',
  'git show -:a.txt', 'git show HEAD:', '/usr/bin/git show HEAD:a.txt',
];

describe('Plan\'s git show grant in the Codex policy', () => {
  it('admits exactly `git show <ref>:<path>` and nothing else', () => {
    const policy = compileCodexRestrictedPolicy(PLAN_SPEC)!;
    for (const command of ALLOWED) expect(codexBashArgv(command, policy), command).toBeDefined();
    for (const command of REFUSED) expect(codexBashArgv(command, policy), command).toBeUndefined();
    expect(codexReadTool(policy).description).toContain('Bash runs only `git show <ref>:<path>`');
  });

  it('leaves Review\'s grant as it was: the name is not a prefix, and Review never holds it', () => {
    const review = compileCodexRestrictedPolicy(REVIEW_SPEC)!;
    expect(review.bashPrefixes).not.toContain(GIT_SHOW_AT_REF);
    expect(codexBashArgv('git show --stat HEAD', review)).toEqual(['git', 'show', '--stat', 'HEAD']);
    expect(codexReadTool(review).description).not.toContain('Bash runs only');
  });
});

describe.skipIf(process.platform === 'win32')('Plan\'s git show grant at the Codex read broker', () => {
  const dirs: string[] = [];
  const brokers: CodexReadBroker[] = [];
  afterEach(() => { for (const b of brokers.splice(0)) b.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'cez-plan-git-show-')); dirs.push(root);
    const cwd = join(root, 'repo'); mkdirSync(join(cwd, 'src'), { recursive: true });
    const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 });
    git('init', '-q'); git('config', 'user.email', 't@example.invalid'); git('config', 'user.name', 't');
    writeFileSync(join(cwd, 'src/a.ts'), 'export const committed = 1;\n');
    writeFileSync(join(cwd, 'other.txt'), 'other\n');
    git('add', '.'); git('commit', '-qm', 'base');
    writeFileSync(join(cwd, 'src/a.ts'), 'export const edited = 2;\n');
    const native = join(root, 'native'); mkdirSync(native);
    const home = prepareRestrictedCodexHome({ cwd }, { HOME: root, CEZ_HOME: join(root, 'cezar'), CODEX_HOME: native });
    const broker = (spec: typeof PLAN_SPEC | typeof REVIEW_SPEC) => {
      const b = new CodexReadBroker(compileCodexRestrictedPolicy(spec)!, { cwd }, home.toolEnv);
      brokers.push(b);
      return async (args: Record<string, unknown>) => {
        const r = await b.call({ tool: 'cezar_read', arguments: args });
        return { ok: r.success, text: r.contentItems[0]?.text ?? '' };
      };
    };
    return { root, cwd, git, plan: broker(PLAN_SPEC), review: broker(REVIEW_SPEC) };
  }
  const show = (object: string) => ({ tool: 'Bash', command: `git show ${object}` });

  it('reads a committed file through the grant, with Read, Grep and Glob still available', async () => {
    const f = fixture();
    expect(await f.plan(show('HEAD:src/a.ts'))).toEqual({ ok: true, text: 'export const committed = 1;\n' });
    expect((await f.plan({ tool: 'Read', path: 'src/a.ts' })).text).toContain('edited');
    expect((await f.plan({ tool: 'Grep', pattern: 'edited' })).text).toContain('src/a.ts');
    expect((await f.plan({ tool: 'Glob', pattern: 'src/*.ts' })).text).toContain('src/a.ts');
  });

  it('reads only a blob: a directory, a missing path or a bad ref is refused', async () => {
    const f = fixture();
    expect(await f.plan(show('HEAD:src'))).toMatchObject({ ok: false, text: expect.stringContaining('is a tree, not a file') });
    expect(await f.plan(show('HEAD:none.ts'))).toMatchObject({ ok: false, text: expect.stringContaining('names no file') });
    expect(await f.plan(show('nobranch:src/a.ts'))).toMatchObject({ ok: false, text: expect.stringContaining('names no file') });
    // Review keeps plain `git show`, tree listing included.
    expect(await f.review(show('HEAD:src'))).toMatchObject({ ok: true, text: expect.stringContaining('a.ts') });
  });

  it('ignores replacement objects, where Review\'s git show still honors them as before', async () => {
    const f = fixture();
    f.git('replace', f.git('rev-parse', 'HEAD:src/a.ts').trim(), f.git('rev-parse', 'HEAD:other.txt').trim());
    expect((await f.plan(show('HEAD:src/a.ts'))).text).toBe('export const committed = 1;\n');
    expect((await f.review(show('HEAD:src/a.ts'))).text).toBe('other\n');
  });

  it('starts no lazy fetch or repository helper for a missing object', async () => {
    const f = fixture();
    const marker = join(f.root, 'helper-ran');
    const helper = join(f.root, 'upload-pack');
    writeFileSync(helper, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`); chmodSync(helper, 0o755);
    const tree = f.git('rev-parse', 'HEAD:src').trim();
    unlinkSync(join(f.cwd, '.git/objects', tree.slice(0, 2), tree.slice(2)));
    f.git('config', 'core.repositoryformatversion', '1');
    f.git('config', 'extensions.partialClone', 'origin');
    f.git('config', 'remote.origin.url', join(f.root, 'nowhere'));
    f.git('config', 'remote.origin.promisor', 'true');
    f.git('config', 'remote.origin.uploadpack', helper);
    writeFileSync(join(f.cwd, '.gitattributes'), 'src/a.ts diff=probe filter=probe\n');
    f.git('config', 'diff.probe.textconv', helper);
    f.git('config', 'filter.probe.smudge', helper);
    expect((await f.plan(show('HEAD:src/a.ts'))).ok).toBe(false);
    expect(existsSync(marker)).toBe(false);
    // The fixture is live: ordinary git in this repository does start the helper.
    spawnSync('git', ['cat-file', '-t', tree], { cwd: f.cwd, timeout: 10_000, env: { ...process.env, GIT_NO_LAZY_FETCH: '0' } });
    expect(existsSync(marker)).toBe(true);
  });

  it('refuses unrelated commands, shell composition, other git options and mutation without running them', async () => {
    const f = fixture();
    const status = f.git('status', '--porcelain');
    const head = f.git('rev-parse', 'HEAD');
    for (const command of REFUSED) {
      const r = await f.plan({ tool: 'Bash', command });
      expect(r.ok, command).toBe(false);
      expect(r.text, command).toContain('cezar denied');
    }
    for (const payload of [{ tool: 'Write', path: 'src/a.ts', content: 'x' }, { tool: 'Edit', path: 'src/a.ts' }]) expect((await f.plan(payload)).ok).toBe(false);
    expect(existsSync(join(f.cwd, 'out.txt'))).toBe(false);
    expect(readFileSync(join(f.cwd, 'src/a.ts'), 'utf8')).toBe('export const edited = 2;\n');
    expect(f.git('status', '--porcelain')).toBe(status);
    expect(f.git('rev-parse', 'HEAD')).toBe(head);
  });
});

describe('partial-clone classification', () => {
  it('refuses a partial clone, a promisor remote and an unclear promisor value, and passes a local repository', () => {
    expect(partialCloneRefusal('core.bare\nfalse\0remote.origin.url\n/x\0')).toBeUndefined();
    expect(partialCloneRefusal('remote.origin.promisor\nfalse\0')).toBeUndefined();
    expect(partialCloneRefusal('extensions.partialclone\norigin\0')).toContain('partial clone');
    for (const value of ['remote.origin.promisor\ntrue\0', 'remote.Up.Stream.promisor\nYes\0', 'remote.origin.promisor\0']) expect(partialCloneRefusal(value)).toContain('promisor remote');
    expect(partialCloneRefusal('remote.origin.promisor\nmaybe\0')).toContain('unclear');
  });
});

describe.skipIf(process.platform === 'win32')('broker git stays offline in a partial clone that allows file fetches', () => {
  const dirs: string[] = [];
  const brokers: CodexReadBroker[] = [];
  afterEach(() => { for (const b of brokers.splice(0)) b.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 20_000 });

  function partialClone() {
    const root = mkdtempSync(join(tmpdir(), 'cez-partial-clone-')); dirs.push(root);
    const origin = join(root, 'origin'); mkdirSync(join(origin, 'src'), { recursive: true });
    run(origin, 'init', '-q'); run(origin, 'config', 'user.email', 't@example.invalid'); run(origin, 'config', 'user.name', 't');
    writeFileSync(join(origin, 'src/a.ts'), 'export const remote = 1;\n');
    run(origin, 'add', '.'); run(origin, 'commit', '-qm', 'base');
    run(origin, 'config', 'uploadpack.allowFilter', 'true'); run(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    run(root, '-c', 'protocol.file.allow=always', 'clone', '-q', '--no-checkout', '--filter=blob:none', `file://${origin}`, 'clone');
    const cwd = join(root, 'clone');
    // The repository itself reopens file fetches, and a wrapped upload-pack records any fetch.
    run(cwd, 'config', 'protocol.file.allow', 'always');
    const marker = join(root, 'fetched');
    const uploadPack = join(root, 'upload-pack');
    writeFileSync(uploadPack, `#!/bin/sh\ntouch '${marker}'\nexec git-upload-pack "$@"\n`); chmodSync(uploadPack, 0o755);
    run(cwd, 'config', 'remote.origin.uploadpack', uploadPack);
    const sha = run(cwd, 'rev-parse', 'HEAD').trim();
    const objects = () => run(cwd, 'count-objects', '-v');
    const native = join(root, 'native'); mkdirSync(native);
    const home = prepareRestrictedCodexHome({ cwd }, { HOME: root, CEZ_HOME: join(root, 'cezar'), CODEX_HOME: native });
    const broker = (spec: typeof PLAN_SPEC | typeof REVIEW_SPEC, dir = cwd, env = home.toolEnv) => {
      const b = new CodexReadBroker(compileCodexRestrictedPolicy(spec)!, { cwd: dir }, env);
      brokers.push(b);
      return async (args: Record<string, unknown>) => {
        const r = await b.call({ tool: 'cezar_read', arguments: args });
        return { ok: r.success, text: r.contentItems[0]?.text ?? '' };
      };
    };
    return { root, cwd, sha, marker, objects, broker, toolEnv: home.toolEnv };
  }

  it('refuses Plan\'s git show and a pinned Read before any lookup, and Review\'s git show fetches nothing', async () => {
    const f = partialClone();
    const before = f.objects();
    const plan = f.broker(PLAN_SPEC);
    expect(await plan({ tool: 'Bash', command: 'git show HEAD:src/a.ts' })).toMatchObject({ ok: false, text: expect.stringContaining('every object present locally') });
    expect(await plan({ tool: 'Read', path: 'src/a.ts', ref: f.sha })).toMatchObject({ ok: false, text: expect.stringContaining('every object present locally') });
    // Review's Bash git has no lookup check: the command-line protocol overrides alone keep it offline.
    expect((await f.broker(REVIEW_SPEC)({ tool: 'Bash', command: 'git show HEAD:src/a.ts' })).ok).toBe(false);
    expect(existsSync(f.marker)).toBe(false);
    expect(f.objects()).toBe(before);
    // The fixture is live: plain git here does fetch the missing blob.
    expect(run(f.cwd, 'show', 'HEAD:src/a.ts')).toBe('export const remote = 1;\n');
    expect(existsSync(f.marker)).toBe(true);
  });

  it('keeps Review\'s git show offline on a git that ignores GIT_NO_LAZY_FETCH', async () => {
    const f = partialClone();
    const before = f.objects();
    const { GIT_NO_LAZY_FETCH: _ignored, ...olderGit } = f.toolEnv;
    expect((await f.broker(REVIEW_SPEC, f.cwd, olderGit)({ tool: 'Bash', command: 'git show HEAD:src/a.ts' })).ok).toBe(false);
    expect(existsSync(f.marker)).toBe(false);
    expect(f.objects()).toBe(before);
  });

  it('finds the partial clone from a task worktree of it', async () => {
    const f = partialClone();
    const wt = join(f.root, 'wt');
    run(f.cwd, 'worktree', 'add', '-q', '--no-checkout', '--detach', wt, f.sha);
    const before = f.objects();
    const plan = f.broker(PLAN_SPEC, wt);
    expect(await plan({ tool: 'Read', path: 'src/a.ts', ref: f.sha })).toMatchObject({ ok: false, text: expect.stringContaining('every object present locally') });
    expect(await plan({ tool: 'Bash', command: 'git show HEAD:src/a.ts' })).toMatchObject({ ok: false, text: expect.stringContaining('every object present locally') });
    expect(existsSync(f.marker)).toBe(false);
    expect(f.objects()).toBe(before);
  });
});

describe.skipIf(process.platform === 'win32')('fully local reads at a commit', () => {
  const dirs: string[] = [];
  const brokers: CodexReadBroker[] = [];
  afterEach(() => { for (const b of brokers.splice(0)) b.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  function local() {
    const root = mkdtempSync(join(tmpdir(), 'cez-local-ref-')); dirs.push(root);
    const repo = join(root, 'repo'); mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 10_000 });
    git('init', '-q'); git('config', 'user.email', 't@example.invalid'); git('config', 'user.name', 't');
    writeFileSync(join(repo, 'a.txt'), 'committed\n'); git('add', '.'); git('commit', '-qm', 'base');
    const sha = git('rev-parse', 'HEAD').trim();
    const native = join(root, 'native'); mkdirSync(native);
    const broker = (cwd: string) => {
      const home = prepareRestrictedCodexHome({ cwd }, { HOME: root, CEZ_HOME: join(root, 'cezar'), CODEX_HOME: native });
      const b = new CodexReadBroker(compileCodexRestrictedPolicy(PLAN_SPEC)!, { cwd }, home.toolEnv);
      brokers.push(b);
      return async (args: Record<string, unknown>) => {
        const r = await b.call({ tool: 'cezar_read', arguments: args });
        return { ok: r.success, text: r.contentItems[0]?.text ?? '' };
      };
    };
    return { root, repo, git, sha, broker };
  }

  it('still reads in a task worktree of a local repository', async () => {
    const f = local();
    const wt = join(f.root, 'wt');
    f.git('worktree', 'add', '-q', '--detach', wt, f.sha);
    const plan = f.broker(wt);
    expect(await plan({ tool: 'Read', path: 'a.txt', ref: f.sha })).toEqual({ ok: true, text: 'committed\n' });
    expect(await plan({ tool: 'Bash', command: 'git show HEAD:a.txt' })).toEqual({ ok: true, text: 'committed\n' });
  });

  it('refuses the read when the promisor setting is unclear or the config cannot be read', async () => {
    const f = local();
    f.git('config', 'remote.origin.promisor', 'maybe');
    const plan = f.broker(f.repo);
    expect(await plan({ tool: 'Read', path: 'a.txt', ref: f.sha })).toMatchObject({ ok: false, text: expect.stringContaining('unclear') });
    f.git('config', '--unset', 'remote.origin.promisor');
    writeFileSync(join(f.repo, '.git/config'), `${readFileSync(join(f.repo, '.git/config'), 'utf8')}[broken\n`);
    expect(await plan({ tool: 'Bash', command: 'git show HEAD:a.txt' })).toMatchObject({ ok: false, text: expect.stringContaining('cannot read') });
  });
});

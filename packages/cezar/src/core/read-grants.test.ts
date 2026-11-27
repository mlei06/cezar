import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PLAN } from '../workflows/templates.ts';
import { workflowCapabilities } from '../workflows/capabilities.ts';
import { buildAllowedTools, buildClaudeArgs, CLAUDE_WRITE_TOOLS } from './claude-cli-runner.ts';
import { prepareRestrictedCodexHome } from './codex-restricted-home.ts';
import { compileCodexRestrictedPolicy } from './codex-restricted-policy.ts';
import { CodexReadBroker } from './codex-restricted-tools.ts';
import { GIT_SHOW_AT_REF, gitShowAtRefHookCommand, gitShowAtRefHookDecision } from './read-grants.ts';

const planWork = PLAN.graph!.nodes.find((node) => node.type === 'agent' && node.id === 'work') as { allowedTools: string[]; bashAllowlist: string[] };

const ALLOWED = ['git show HEAD:a.txt', "git show main:'dir/a b.txt'", 'git show abc1234:a.txt', "git show 'HEAD~2:src/x.ts'", 'git show origin/main:a.txt'];
const REFUSED = [
  // Unrelated commands, and other git verbs.
  'ls', 'cat a.txt', 'rm -rf .', 'git log', 'git status', 'git diff HEAD', 'git push origin main', 'git commit -m x', 'git checkout HEAD -- a.txt',
  // Shell composition.
  'git show HEAD:a.txt && rm a.txt', 'git show HEAD:a.txt; rm a.txt', 'git show HEAD:a.txt | sh', 'git show HEAD:a.txt > out.txt',
  'git show $(echo HEAD):a.txt', 'git show `id`:a.txt', 'git show HEAD:a.txt &', 'git show HEAD:a.txt\nrm a.txt',
  // Git options and operands outside `git show <ref>:<path>`.
  'git show', 'git show HEAD', 'git show --output=out.txt HEAD:a.txt', 'git show HEAD:a.txt --output=out.txt', 'git show --textconv HEAD:a.txt',
  'git show --ext-diff HEAD:a.txt', 'git show -p HEAD:a.txt', 'git show HEAD:a.txt HEAD:b.txt', 'git show HEAD:a.txt -- a.txt',
  'git -c core.pager=sh show HEAD:a.txt', 'git --git-dir=/tmp show HEAD:a.txt', 'git show :a.txt', 'git show -:a.txt', 'git show HEAD:', '/usr/bin/git show HEAD:a.txt',
];

describe('the Plan workflow\'s git show grant', () => {
  it('is Plan\'s only shell grant, beside Read, Grep and Glob, and Plan stays read-only', () => {
    expect(planWork.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
    expect(planWork.bashAllowlist).toEqual([GIT_SHOW_AT_REF]);
    expect(workflowCapabilities(PLAN)).toEqual({ push: false, openPr: false, postToGithub: false });
  });

  it('allows exactly `git show <ref>:<path>` and denies everything else', () => {
    for (const command of ALLOWED) expect(gitShowAtRefHookDecision(command).decision, command).toBe('allow');
    for (const command of REFUSED) expect(gitShowAtRefHookDecision(command).decision, command).toBe('deny');
    expect(gitShowAtRefHookDecision(undefined).decision).toBe('deny');
  });

  it('holds Claude to the grant through a PreToolUse hook that outranks every allow rule', () => {
    const args = buildClaudeArgs({ userPrompt: 'x', cwd: '/tmp', allowedTools: planWork.allowedTools, bashAllowlist: planWork.bashAllowlist, enforceReadOnly: true });
    const at = (flag: string) => args[args.indexOf(flag) + 1]!;
    expect(at('--allowedTools').split(',')).toEqual(['Read', 'Grep', 'Glob', 'Bash(git show:*)']);
    expect(at('--disallowedTools').split(',')).toEqual(CLAUDE_WRITE_TOOLS.filter((tool) => tool !== 'Bash'));
    expect(at('--permission-mode')).toBe('dontAsk');
    const settings = JSON.parse(at('--settings')) as { hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> } };
    expect(settings.hooks.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [{ type: 'command', command: gitShowAtRefHookCommand() }] }]);
    // Without its hook the grant name never becomes a `git show` prefix rule, and Bash stays denied.
    expect(buildAllowedTools(planWork.allowedTools, planWork.bashAllowlist)).toEqual(['Read', 'Grep', 'Glob']);
    expect(buildAllowedTools(['Bash'], ['git show', GIT_SHOW_AT_REF])).toEqual(['Bash(git show:*)']);
  });

  it.skipIf(process.platform === 'win32')('runs the hook Claude is given and answers each call, a hook that cannot start blocking', () => {
    const command = gitShowAtRefHookCommand()!;
    const ask = (bash: string, hook = command) => spawnSync('sh', ['-c', hook], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: bash } }), encoding: 'utf8', timeout: 15_000,
    });
    const decision = (bash: string) => (JSON.parse(ask(bash).stdout) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision;
    expect(decision('git show HEAD:a.txt')).toBe('allow');
    expect(decision('git show HEAD:a.txt && touch x')).toBe('deny');
    expect(decision('git show --output=x HEAD:a.txt')).toBe('deny');
    expect(ask('git show HEAD:a.txt', `'/nonexistent/node' 'hook.js' || exit 2`).status).toBe(2);
  });
});

describe.skipIf(process.platform === 'win32')('a Plan task on isolated Codex', () => {
  const dirs: string[] = [];
  const brokers: CodexReadBroker[] = [];
  afterEach(() => { for (const b of brokers.splice(0)) b.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  function plan() {
    const root = mkdtempSync(join(tmpdir(), 'cez-plan-git-show-')); dirs.push(root);
    const cwd = join(root, 'repo'); mkdirSync(join(cwd, 'src'), { recursive: true });
    const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 });
    git('init', '-q'); git('config', 'user.email', 't@example.invalid'); git('config', 'user.name', 't');
    writeFileSync(join(cwd, 'src/a.ts'), 'export const committed = 1;\n');
    git('add', '.'); git('commit', '-qm', 'base');
    writeFileSync(join(cwd, 'src/a.ts'), 'export const edited = 2;\n');
    const native = join(root, 'native'); mkdirSync(native);
    const home = prepareRestrictedCodexHome({ cwd }, { HOME: root, CEZ_HOME: join(root, 'cezar'), CODEX_HOME: native });
    // The spec Plan's step hands Codex (`resolveAgentStepTools` in read-only mode).
    const policy = compileCodexRestrictedPolicy({ allowedTools: planWork.allowedTools, bashAllowlist: planWork.bashAllowlist, enforceReadOnly: true })!;
    const broker = new CodexReadBroker(policy, { cwd }, home.toolEnv);
    brokers.push(broker);
    const call = async (args: Record<string, unknown>) => {
      const r = await broker.call({ tool: 'cezar_read', arguments: args });
      return { ok: r.success, text: r.contentItems[0]?.text ?? '' };
    };
    return { cwd, git, call };
  }

  it('reads a committed file through the grant, with Read, Grep and Glob still available', async () => {
    const p = plan();
    expect(await p.call({ tool: 'Bash', command: 'git show HEAD:src/a.ts' })).toEqual({ ok: true, text: 'export const committed = 1;\n' });
    expect((await p.call({ tool: 'Read', path: 'src/a.ts' })).text).toContain('edited');
    expect((await p.call({ tool: 'Grep', pattern: 'edited' })).text).toContain('src/a.ts');
    expect((await p.call({ tool: 'Glob', pattern: 'src/*.ts' })).text).toContain('src/a.ts');
  });

  it('refuses unrelated commands, shell composition, other git options and mutation without running them', async () => {
    const p = plan();
    const status = p.git('status', '--porcelain');
    const head = p.git('rev-parse', 'HEAD');
    for (const command of REFUSED) {
      const r = await p.call({ tool: 'Bash', command });
      expect(r.ok, command).toBe(false);
      expect(r.text, command).toContain('cezar denied');
    }
    // Review's wider `git show` stays out of Plan's grant.
    expect((await p.call({ tool: 'Bash', command: 'git show --stat HEAD' })).ok).toBe(false);
    for (const payload of [{ tool: 'Write', path: 'src/a.ts', content: 'x' }, { tool: 'Edit', path: 'src/a.ts' }]) expect((await p.call(payload)).ok).toBe(false);
    expect(existsSync(join(p.cwd, 'out.txt'))).toBe(false);
    expect(readFileSync(join(p.cwd, 'src/a.ts'), 'utf8')).toBe('export const edited = 2;\n');
    expect(p.git('status', '--porcelain')).toBe(status);
    expect(p.git('rev-parse', 'HEAD')).toBe(head);
  });
});

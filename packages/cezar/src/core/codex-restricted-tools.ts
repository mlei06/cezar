import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { accessSync, constants, constants as fsConstants, statSync } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, posix, relative, resolve, sep, win32 } from 'node:path';
import { z } from 'zod';
import type { AgentRunSpec } from './agent-runner.ts';
import { codexBashArgv, codexGithubOperands, type CodexRestrictedPolicy } from './codex-restricted-policy.ts';
import { GIT_SHOW_AT_REF, isGitShowAtRefArgv } from './read-grants.ts';

const path = z.string().min(1).max(4_096);
const lines = z.number().int().min(1).max(2_000).optional();
// A full or abbreviated object id only: no branch names, ranges, `@{}` or `:` paths reach git (B31).
const ref = z.string().regex(/^[0-9a-f]{7,64}$/i, 'ref must be a commit id (7 to 64 hex characters)').optional();
const requestSchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('Read'), path, offset: z.number().int().min(1).max(1_000_000).optional(), limit: lines, ref }).strict(),
  z.object({ tool: z.literal('Grep'), pattern: z.string().max(4_096), path: path.optional(), glob: z.string().max(512).optional(), limit: lines }).strict(),
  z.object({ tool: z.literal('Glob'), pattern: z.string().max(512), path: path.optional(), limit: lines }).strict(),
  z.object({ tool: z.literal('Bash'), command: z.string().max(16_000) }).strict(),
]);

/** Which argument was wrong, so the model can fix the call instead of repeating it. */
function argumentIssue(err: z.ZodError): string {
  const issue = err.issues[0];
  if (!issue) return 'invalid tool arguments';
  const keys = issue.code === 'unrecognized_keys' ? ` (${issue.keys.join(', ')})` : '';
  return `invalid tool arguments: ${issue.path.join('.') || 'arguments'}: ${issue.message}${keys}`;
}

export const CODEX_READ_TOOL = {
  type: 'function', name: 'cezar_read',
  description: 'Read-only tools enforced by cezar. Use Read for files (500 lines from 1-based `offset` unless `limit`; read ranges, not whole files; add `ref` with a commit id to read the repository file as it is at that commit instead of `git show`; a partial result ends with the lines shown and the next offset), Grep for content, Glob for file names (`pattern`), Bash for a single approved git/GitHub read command. Grep and Glob take `limit` for the most result lines. At most four calls run at once. A refused call fails the same way when repeated: change it. Native shell and write tools are denied. No pipelines, shell syntax, writes, browser, pushes or GitHub mutations.',
  inputSchema: z.toJSONSchema(z.object({
    tool: z.enum(['Read', 'Grep', 'Glob', 'Bash']), path: path.nullable(),
    offset: z.number().int().nullable(), limit: z.number().int().nullable(), ref: z.string().nullable(),
    pattern: z.string().nullable(), glob: z.string().nullable(), command: z.string().nullable(),
  }).strict()),
};

/** The tool a session's model sees: a manager's shell is described by the manager. */
export function codexReadTool(policy: CodexRestrictedPolicy): typeof CODEX_READ_TOOL {
  if (policy.replayShell) return {
    ...CODEX_READ_TOOL,
    description: 'Use Read, Grep or Glob for the worktree, and Bash to edit files or run local checks in the isolated replay worktree. The sandbox has no network or Git administration. Native shell and write tools are disabled.',
  };
  if (!policy.shell) return policy.bashPrefixes.includes(GIT_SHOW_AT_REF) && policy.bashPrefixes.length === 1
    ? { ...CODEX_READ_TOOL, description: `${CODEX_READ_TOOL.description} Here Bash runs only \`git show <ref>:<path>\`, one tracked file at a git ref, with no flags.` }
    : CODEX_READ_TOOL;
  return { ...CODEX_READ_TOOL, description: `Tools enforced by cezar. Use Read for files, Grep for content, Glob for file names, Bash for one command: ${policy.shell.describe} Native shell and write tools are denied; cezar refuses every other command and any other shell syntax.` };
}

/** On every broker git call, beside the tool env's `GIT_NO_LAZY_FETCH=1` (which git before 2.45 ignores). */
export const GIT_NETWORK_OFF = ['-c', 'protocol.allow=never', ...['file', 'git', 'ssh', 'http', 'https', 'ext'].flatMap(p => ['-c', `protocol.${p}.allow=never`])];

const FALSE = new Set(['false', 'no', 'off', '0']);
const TRUE = new Set(['true', 'yes', 'on', '1', '']);

/**
 * Why an object read must not run here, from `git config --list -z`: a partial clone can fetch a
 * missing object on lookup. A `promisor` value git might read as true counts as one.
 */
export function partialCloneRefusal(list: string): string | undefined {
  for (const entry of list.split('\0')) {
    if (!entry) continue;
    const at = entry.indexOf('\n');
    const key = (at < 0 ? entry : entry.slice(0, at)).toLowerCase();
    const value = at < 0 ? '' : entry.slice(at + 1).trim().toLowerCase();
    if (key === 'extensions.partialclone') return 'this repository is a partial clone; reads at a commit need every object present locally';
    if (/^remote\..+\.promisor$/.test(key) && !FALSE.has(value)) {
      return TRUE.has(value) ? 'this repository has a promisor remote; reads at a commit need every object present locally'
        : `this repository's ${key} setting is unclear; reads at a commit are refused`;
    }
  }
  return undefined;
}

const SHELL_TIMEOUT_MS = 120_000;
// The read path's guard (`codexBashArgv`); a newline stays legal for a heredoc body.
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;
const SHELL_OUTPUT_CAP = 256_000;
// A detached Windows child gets its own console window and has no process group to signal.
const STAGE_GROUPS = process.platform !== 'win32';
const STDERR_CAP = 16_000;

/** `taskkill` by absolute path: a bare name is looked up in the current directory (the repo) first. */
export function taskkillPath(env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'taskkill.exe');
}

/** How a running stage and what it forked are killed: its process group on POSIX, `taskkill /T` on Windows. */
export function stageKillPlan(pid: number, platform: NodeJS.Platform = process.platform): { group: number } | { taskkill: { file: string; args: string[] } } {
  return platform === 'win32' ? { taskkill: { file: taskkillPath(), args: ['/pid', String(pid), '/T', '/F'] } } : { group: -pid };
}

export interface StageKillDeps {
  platform?: NodeJS.Platform;
  spawn?: typeof spawn;
  spawnSync?: typeof spawnSync;
  killGroup?: (group: number) => void;
}

const exited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null;
const killGroup = (group: number): void => { try { process.kill(group, 'SIGKILL'); } catch { /* the group is gone */ } };

const TASKKILL_TIMEOUT_MS = 5_000;
// Deduplicate async taskkill calls to narrow the pid reuse window.
const pendingKills = new WeakSet<ChildProcess>();
const hardKill = (child: ChildProcess): void => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };

/**
 * Kills a stage and what it forked. Never throws: it runs from timers, listeners and `finish()`.
 *
 * A stage that already exited is never targeted by pid: a reaped pid (and an emptied group) may
 * belong to someone else by now; on POSIX its leftovers were killed as it exited (`onStageExit`).
 *
 * Windows has no process group and Node no job object, so `taskkill /T` walks the live stage's
 * tree. An async `taskkill` can hit a reused pid if the stage exits while it starts. Server exit
 * uses `spawnSync`, which blocks the event loop and keeps the stage's handle open.
 * The reader-quit path uses `tree: false`, killing the writer by handle and leaving all of its
 * descendants alive.
 */
export function killStage(child: ChildProcess, opts: { sync?: boolean; tree?: boolean } & StageKillDeps = {}): void {
  if (!child.pid || exited(child) || opts.tree === false) { hardKill(child); return; }
  const plan = stageKillPlan(child.pid, opts.platform);
  if ('group' in plan) {
    try { (opts.killGroup ?? killGroup)(plan.group); } catch { /* the group is gone */ }
    hardKill(child);
    return;
  }
  // Dormant in production while codex-app-server-runner.ts refuses restricted Codex on Windows.
  const { file, args } = plan.taskkill;
  if (opts.sync) {
    try { (opts.spawnSync ?? spawnSync)(file, args, { stdio: 'ignore', windowsHide: true, timeout: TASKKILL_TIMEOUT_MS }); } catch { /* fall through */ }
    hardKill(child);
    return;
  }
  if (pendingKills.has(child)) return;
  pendingKills.add(child);
  let after = false;
  let bound: NodeJS.Timeout | undefined;
  const then = () => {
    if (after) return;
    after = true;
    if (bound) clearTimeout(bound);
    pendingKills.delete(child);
    hardKill(child);
  };
  // A taskkill that never returns must not keep the stage alive.
  bound = setTimeout(then, TASKKILL_TIMEOUT_MS);
  bound.unref?.();
  try {
    (opts.spawn ?? spawn)(file, args, { stdio: 'ignore', windowsHide: true, timeout: TASKKILL_TIMEOUT_MS }).on('exit', then).on('error', then);
  } catch {
    then();
  }
}

/** Whether a kill of this stage is still in flight (Windows `taskkill`). */
export function stageKillPending(child: ChildProcess): boolean {
  return pendingKills.has(child);
}

/**
 * POSIX: the moment a stage is reaped, kill whatever it left in its group (a forked grandchild
 * still holding its pipe). The group id stays reserved only while a member lives; when the stage
 * left nothing behind, this signals a just-freed id in the same tick as the reap — an accepted,
 * negligible race (it needs pid wraparound plus a `setsid` in that tick).
 *
 * Windows: nothing. Node has already closed the stage's handle and freed its pid, so a child it
 * left holding stdout is out of reach: that call settles at its timeout and the child is not killed.
 */
export function onStageExit(child: ChildProcess, deps: Pick<StageKillDeps, 'platform' | 'killGroup'> = {}): void {
  if ((deps.platform ?? process.platform) === 'win32' || !child.pid) return;
  try { (deps.killGroup ?? killGroup)(-child.pid); } catch { /* the group is gone */ }
}

// Detached stages miss the server's Ctrl-C and outlive its timers; a clean stop or a crash
// ('exit' fires for both) takes them down. A SIGKILLed server cannot, and their timeout dies with it.
// A stage leaves this set when it closes, not when its call settles: a kill still in flight is covered.
const liveStages = new Set<ChildProcess>();
let exitHookInstalled = false;
export function killLiveStages(): void {
  for (const child of liveStages) killStage(child, { sync: true });
  liveStages.clear();
}
export function liveStageCount(): number {
  return liveStages.size;
}

/**
 * A program's absolute path from the absolute PATH entries only. A bare name would otherwise be
 * looked up in the working directory first on Windows (a hostile branch's `rg.exe`), and a relative
 * PATH entry (`.`) does the same anywhere.
 */
export function resolveProgram(bin: string, env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): string | undefined {
  const windows = platform === 'win32';
  const paths = windows ? win32 : posix;
  if (paths.isAbsolute(bin)) return bin;
  if (bin.includes('/') || bin.includes('\\')) return undefined;
  const search = env.PATH ?? env.Path ?? '';
  const extensions = windows ? [...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean), ''] : [''];
  for (const entry of search.split(windows ? ';' : ':')) {
    const dir = windows ? entry.replace(/^"(.*)"$/, '$1') : entry;
    if (!paths.isAbsolute(dir)) continue;
    for (const extension of extensions) {
      const candidate = paths.join(dir, bin + extension);
      try {
        if (statSync(candidate).isFile()) { accessSync(candidate, fsConstants.X_OK); return candidate; }
      } catch { /* not here */ }
    }
  }
  return undefined;
}

/** The longest prefix that does not end in a UTF-8 sequence a byte cap cut short. */
export function wholeUtf8(buffer: Buffer): Buffer {
  let index = buffer.length - 1;
  let continuation = 0;
  while (index >= 0 && continuation < 3 && (buffer[index]! & 0xc0) === 0x80) { index--; continuation++; }
  if (index < 0) return buffer;
  const lead = buffer[index]!;
  const needs = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return needs > continuation + 1 ? buffer.subarray(0, index) : buffer;
}

export interface PipelineOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
  /** Defaults to `SHELL_TIMEOUT_MS`; tests shorten it. */
  timeoutMs?: number;
  /** Tests inject a spawn that fails; production uses node's. */
  spawn?: typeof spawn;
  /** Program lookup; defaults to `resolveProgram` over the stage env's absolute PATH entries. */
  resolve?: (bin: string) => string | undefined;
}

export const PIPELINE_REFUSED = 'cezar: refused a command with an empty stage or a control character';

/**
 * Spawns a vetted argv pipeline with no shell: what the verifier read is exactly what runs. Settles
 * exactly once — on the last stage's close, the timeout, the output cap, an abort or a stage that
 * cannot start — and each stage leads its own process group, so a kill also reaches what it forked.
 */
export function runPipeline(pipeline: readonly string[][], stdin: string | undefined, opts: PipelineOptions): Promise<{ ok: boolean; text: string }> {
  const env = Object.fromEntries(Object.entries(opts.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  // Everything spawn could refuse synchronously is refused here, before any stage starts.
  const invalid = !pipeline.length || pipeline.some((stage) => !stage.length || stage.some((arg) => typeof arg !== 'string' || CONTROL.test(arg)))
    || (stdin !== undefined && (typeof stdin !== 'string' || /\0/.test(stdin)));
  if (invalid) return Promise.resolve({ ok: false, text: PIPELINE_REFUSED });
  // Every program by absolute path, resolved before anything starts.
  const lookup = opts.resolve ?? ((bin: string) => resolveProgram(bin, env));
  const resolved: string[][] = [];
  for (const [bin, ...args] of pipeline) {
    const path = lookup(bin!);
    if (!path) return Promise.resolve({ ok: false, text: `cezar: \`${bin}\` was not found on PATH` });
    resolved.push([path, ...args]);
  }
  const start = opts.spawn ?? spawn;
  const timeoutMs = opts.timeoutMs ?? SHELL_TIMEOUT_MS;
  return new Promise((done) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let errTruncated = false;
    let failure: string | undefined;
    let open = pipeline.length;
    let code: number | null = null;
    let settled = false;
    const children: ChildProcess[] = [];
    const killOne = (child: ChildProcess, tree = true) => killStage(child, { tree });
    const killAll = () => { for (const child of children) killOne(child); };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      // Nothing here may stop `done` below: settled is already true, so a throw would hang the call.
      try {
        killAll();
        // Release pipes a surviving grandchild may hold, so nothing keeps this call's streams open.
        for (const child of children) for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
      } catch { /* the stages are being torn down either way */ }
      // A cap cuts bytes; never leave half a character (U+FFFD) in front of the marker.
      const stdoutBytes = Buffer.concat(out);
      const text = (truncated ? wholeUtf8(stdoutBytes) : stdoutBytes).toString('utf8') + (truncated ? TRUNCATED : '');
      const stderrBytes = Buffer.concat(err);
      const errText = (errTruncated ? wholeUtf8(stderrBytes) : stderrBytes).toString('utf8').trim();
      // Over the cap is the read path's truncation, not a failure: cezar stopped it, the command did not fail.
      const ok = !failure && (truncated || code === 0);
      const detail = [text, errText && `[stderr]\n${errText}`, failure, !ok && !failure ? `[exit ${code ?? 'signal'}]` : ''].filter(Boolean).join('\n');
      done({ ok, text: detail || '(no output)' });
    };
    const onAbort = () => { failure ??= 'session is closed'; finish(); };
    // Armed before the first spawn, and it settles on its own: a 'close' a grandchild blocks never comes.
    const timer = setTimeout(() => { failure ??= `command timed out after ${timeoutMs / 1000}s`; finish(); }, timeoutMs);
    timer.unref?.();
    if (opts.signal.aborted) { onAbort(); return; }
    opts.signal.addEventListener('abort', onAbort, { once: true });
    let stage = 0;
    try {
      for (; stage < pipeline.length; stage++) {
        const [bin, ...args] = resolved[stage]!;
        const child = start(bin!, args, { cwd: opts.cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached: STAGE_GROUPS, windowsHide: true });
        children.push(child);
        liveStages.add(child);
        child.once('close', () => liveStages.delete(child));
        child.once('exit', () => onStageExit(child));
        if (!exitHookInstalled) { exitHookInstalled = true; process.on('exit', killLiveStages); }
        // Listen at once: a child that fails below still emits 'error' a tick later, and unheard it crashes the server.
        child.on('error', (error) => { failure ??= `${pipeline[children.indexOf(child)]![0]}: ${error.message.slice(0, 200)}`; });
        // EMFILE/ENFILE: node returns a child without stdio and reports the error a tick later.
        if (!child.stdin || !child.stdout || !child.stderr) throw new Error('no stdio (out of file descriptors?)');
      }
    } catch (error) {
      failure = `cezar: could not start ${pipeline[stage]?.[0] ?? 'the command'}: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`;
      finish();
      return;
    }
    children.forEach((child, index) => {
      const next = children[index + 1];
      if (next) child.stdout!.pipe(next.stdin!).on('error', () => {});
      else child.stdout!.on('data', (chunk: Buffer) => {
        if (truncated) return;
        const room = SHELL_OUTPUT_CAP - outBytes;
        out.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
        outBytes += Math.min(chunk.length, room);
        if (chunk.length > room) { truncated = true; finish(); }
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        const room = STDERR_CAP - errBytes;
        if (room <= 0) return;
        if (chunk.length > room) errTruncated = true;
        err.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
        errBytes += Math.min(chunk.length, room);
      });
      child.stdin!.on('error', () => {});
      child.on('close', (exit) => {
        if (!next) code = exit;
        // A shell's SIGPIPE: a reader that quit (`| head`) ends the writers before it, or they block on a full pipe.
        for (const upstream of children.slice(0, index)) if (upstream.exitCode === null && upstream.signalCode === null) killOne(upstream, process.platform !== 'win32');
        if (--open === 0) finish();
      });
    });
    const first = children[0]!.stdin!;
    if (stdin !== undefined) first.end(stdin); else first.end();
  });
}

export type CodexReadResult = { success: boolean; contentItems: Array<{ type: 'inputText'; text: string }> };
/** The hard bound on one model-facing result, in UTF-16 code units, truncation notice included (B31). */
export const RESULT_CAP = 64_000;
/** A Read line longer than this is cut, so one minified line cannot fill a result. */
export const READ_LINE_CAP = 2_000;
const TRUNCATED = '\n[cezar: output truncated; narrow the pattern, path or range]';
const RESULT_TRUNCATED = '\n[cezar: output truncated; narrow the pattern, path or range; for a file at a commit use Read with `ref`, `offset` and `limit`]';
/** Never ends in half a surrogate pair. */
const cut = (text: string, length: number): string => {
  const head = text.slice(0, Math.max(0, length));
  return /[\ud800-\udbff]$/.test(head) ? head.slice(0, -1) : head;
};
export const boundResult = (text: string): string => text.length > RESULT_CAP ? cut(text, RESULT_CAP - RESULT_TRUNCATED.length) + RESULT_TRUNCATED : text;
const result = (success: boolean, text: string): CodexReadResult => ({
  success, contentItems: [{ type: 'inputText', text: boundResult(text) }],
});

/**
 * Read's 1-based line window, sliced here so the model never receives the whole file. A window that
 * stops before the end of the file says which lines it showed and the next offset; a full window of
 * the whole file stays byte-identical to what Read always returned.
 */
export function readWindow(text: string, offset = 1, limit = 500): string {
  const all = text.split('\n');
  const total = text.endsWith('\n') ? all.length - 1 : all.length;
  if (offset > Math.max(total, 1)) return `[cezar: offset ${offset} is past the end of the file (${total} lines)]`;
  const window = all.slice(offset - 1, offset - 1 + limit);
  let cutLines = 0;
  const shown: string[] = [];
  let used = 0;
  let last = offset - 1;
  // Leave room for the footer, which is at most ~160 characters.
  const budget = RESULT_CAP - 200;
  for (const [i, raw] of window.entries()) {
    const number = offset + i;
    const line = raw.length > READ_LINE_CAP ? `${cut(raw, READ_LINE_CAP)}… [cezar: line ${number} cut at ${READ_LINE_CAP} of ${raw.length} characters]` : raw;
    if (used + line.length + 1 > budget) break;
    if (line !== raw) cutLines++;
    shown.push(line);
    used += line.length + 1;
    if (number <= total) last = number;
  }
  const reachedCap = shown.length < window.length;
  const body = shown.join('\n');
  if (!reachedCap && last >= total && !cutLines) return body;
  const notes = [`lines ${offset}-${last} of ${total}`];
  if (cutLines) notes.push(`${cutLines} long line${cutLines === 1 ? '' : 's'} cut`);
  if (reachedCap) notes.push(`stopped at the ${RESULT_CAP}-character result cap`);
  if (last < total) notes.push(`next offset ${last + 1}`);
  return `${body}\n[cezar: ${notes.join('; ')}]`;
}

export class CodexReadBroker {
  private readonly allowedRoots: Promise<string[]>;
  private readonly cwd: Promise<string>;
  private readonly aborter = new AbortController();

  constructor(
    private readonly policy: CodexRestrictedPolicy,
    spec: Pick<AgentRunSpec, 'cwd' | 'additionalDirectories'>,
    private readonly env: NodeJS.ProcessEnv,
    private readonly githubReadsAllowed = true,
    /** Tests shorten both; the backstop only fires when the command's own timeout failed to. */
    private readonly limits: { shellTimeoutMs?: number; backstopMs?: number } = {},
    /** The cockpit service's PATH, searched for `gh` only when the sealed tool PATH has none (B31). */
    private readonly servicePath: string | undefined = process.env.PATH,
  ) {
    this.cwd = realpath(spec.cwd);
    void this.cwd.catch(() => {});
    this.allowedRoots = Promise.all([spec.cwd, ...(spec.additionalDirectories ?? [])].map(async p => realpath(p).catch(() => undefined)))
      .then(paths => paths.filter((p): p is string => p !== undefined));
  }

  close(): void { this.aborter.abort(); }

  private async allowedPath(path: string): Promise<string> {
    const absolute = await realpath(resolve(await this.cwd, path));
    const roots = await this.allowedRoots;
    if (!roots.some(root => {
      const rel = relative(root, absolute);
      return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
    })) throw new Error('path is outside this step’s read roots');
    return absolute;
  }

  /**
   * Absolute path of a program. Only an already-granted `gh` falls back to the service's PATH: it is
   * often installed outside the sealed tool PATH, and it still runs with the isolated tool env.
   */
  private program(name: string): string | undefined {
    return resolveProgram(name, this.env)
      ?? (name === 'gh' && this.servicePath ? resolveProgram('gh', { PATH: this.servicePath }) : undefined);
  }

  private async execute(argv: readonly string[], truncate = true, dir?: string, maxBuffer = 256_000): Promise<string> {
    if (this.aborter.signal.aborted) throw new Error('session is closed');
    const cwd = dir ?? await this.cwd;
    const [name, ...rest] = argv;
    // Command-line `-c` beats repository config, so a repo's `protocol.<name>.allow=always` cannot reopen a fetch.
    const args = name === 'git' ? [...GIT_NETWORK_OFF, ...rest] : rest;
    const bin = this.program(name!);
    if (!bin) throw new Error(`\`${name}\` was not found on PATH`);
    return new Promise((done, fail) => {
      // stdin is closed; there is no shell, PTY or reusable interactive process.
      const child = execFile(bin!, args, { cwd, env: this.env, timeout: 15_000, maxBuffer, encoding: 'utf8', signal: this.aborter.signal }, (err, stdout, stderr) => {
        // Over the buffer cap the child is killed; model-facing output keeps what arrived, validation reads fail.
        if (truncate && err && 'code' in err && err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') done(stdout + TRUNCATED);
        else if (err && !((name === 'rg' || name === 'grep') && 'code' in err && err.code === 1)) fail(new Error(stderr.trim().slice(0, 2_000) || `read command failed (${err.message.slice(0, 200)})`));
        else done(stdout);
      });
      child.stdin?.end();
    });
  }

  /**
   * A repository file's content at a commit, through fixed git argv only. The hex id is looked up as
   * an object id (never a ref name), must name exactly one object, and that object must itself be a
   * commit (no tag peeling). Replacement objects are off for every call; the tool env's git config
   * keeps fsmonitor, hooks and lazy fetches off. The path stays under the worktree; Read's 2 MB rule holds.
   */
  private async readAtCommit(ref: string, path: string): Promise<string> {
    const cwd = await this.cwd;
    const rel = relative(cwd, resolve(cwd, path));
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('a Read at a commit needs a file path inside the worktree');
    const git = (...args: string[]) => this.execute(['git', '--no-replace-objects', ...args], false);
    await this.refusePartialClone();
    // `--disambiguate` lists object ids with this prefix and ignores refs, so a branch named like an id cannot redirect it.
    const ids = (await git('rev-parse', `--disambiguate=${ref.toLowerCase()}`)).split('\n').filter(Boolean);
    if (ids.length > 1) throw new Error(`ref ${ref} is ambiguous in this repository; give more of the commit id`);
    const commit = ids[0] ?? '';
    if (!/^[0-9a-f]{40,64}$/.test(commit) || (await git('cat-file', '-t', commit)).trim() !== 'commit') throw new Error(`ref ${ref} is not a commit in this repository`);
    const object = `${commit}:./${rel.split(sep).join('/')}`;
    const type = (await git('cat-file', '-t', object)).trim();
    if (type !== 'blob') throw new Error(`${path} is a ${type || 'missing object'} at ${ref}, not a file`);
    const size = Number((await git('cat-file', '-s', object)).trim());
    if (!Number.isFinite(size) || size > 2_000_000) throw new Error('Read requires a regular file of at most 2 MB');
    return this.execute(['git', '--no-replace-objects', 'cat-file', 'blob', object], false, undefined, 2_100_000);
  }

  /**
   * Plan's `git show <ref>:<path>`, run as fixed `cat-file` argv: the operand must name exactly one
   * blob (a tree or a missing path is refused), replacement objects stay off, and the tool env keeps
   * config, helpers and lazy fetches out. Read's 2 MB rule holds; the result cap bounds the reply.
   */
  private async blobAtRef(object: string): Promise<string> {
    const git = (...args: string[]) => this.execute(['git', '--no-replace-objects', ...args], false);
    await this.refusePartialClone();
    const id = (await git('rev-parse', '--verify', '--quiet', '--end-of-options', object).catch(() => '')).trim();
    if (!/^[0-9a-f]{40,64}$/.test(id)) throw new Error(`${object} names no file in this repository`);
    const type = (await git('cat-file', '-t', id)).trim();
    if (type !== 'blob') throw new Error(`${object} is a ${type}, not a file`);
    const size = Number((await git('cat-file', '-s', id)).trim());
    if (!Number.isFinite(size) || size > 2_000_000) throw new Error('git show at a ref reads a file of at most 2 MB');
    return this.execute(['git', '--no-replace-objects', 'cat-file', 'blob', id], false, undefined, 2_100_000);
  }

  /** Before any object lookup; config git cannot read refuses the read too. */
  private async refusePartialClone(): Promise<void> {
    const list = await this.execute(['git', 'config', '--list', '-z'], false)
      .catch((err: unknown) => {
        // A missing git or a closed session keeps its own message; anything else is config git cannot read.
        if (err instanceof Error && /was not found on PATH|^session is closed$/.test(err.message)) throw err;
        throw new Error('cannot read this repository\'s git config; reads at a commit are refused');
      });
    const refusal = partialCloneRefusal(list);
    if (refusal) throw new Error(refusal);
  }

  private pending = 0;
  async call(params: Record<string, unknown>): Promise<CodexReadResult> {
    if (this.pending >= 4) return result(false, 'cezar: at most four read operations may run at once');
    this.pending++;
    let timer: NodeJS.Timeout | undefined;
    // A manager command has its own timeout; this backstop only fires if that one fails.
    const limit = this.limits.backstopMs ?? (this.policy.shell || this.policy.replayShell
      ? (this.limits.shellTimeoutMs ?? SHELL_TIMEOUT_MS) + 10_000 : 20_000);
    try {
      return await Promise.race([this.perform(params), new Promise<CodexReadResult>(done => {
        timer = setTimeout(() => { this.close(); done(result(false, 'cezar: read timed out; this broker is closed')); }, limit);
        timer.unref?.();
      })]);
    } finally { if (timer) clearTimeout(timer); this.pending--; }
  }

  // A refusal repeats identically; the second try gets that said outright instead of the same error.
  private readonly refused = new Map<string, string>();

  private async perform(params: Record<string, unknown>): Promise<CodexReadResult> {
    let key: string | undefined;
    try {
      if (this.aborter.signal.aborted) throw new Error('session is closed');
      if (params.tool !== CODEX_READ_TOOL.name || (params.namespace !== undefined && params.namespace !== null)) throw new Error('tool is not granted');
      const raw = params.arguments;
      const nullable = new Set(['path', 'offset', 'limit', 'ref', 'pattern', 'glob', 'command']);
      const args: unknown = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? Object.fromEntries(Object.entries(raw).filter(([key, value]) => value !== null || !nullable.has(key))) : raw;
      // Glob's flat schema also shows `glob`; a model that puts the pattern there means `pattern`.
      if (args && typeof args === 'object' && 'tool' in args && args.tool === 'Glob' && !('pattern' in args) && 'glob' in args) {
        const { glob, ...rest } = args as Record<string, unknown>;
        Object.assign(rest, { pattern: glob });
        return this.perform({ ...params, arguments: rest });
      }
      if (!this.policy.replayShell) {
        key = JSON.stringify(args);
        const before = this.refused.get(key);
        if (before) return result(false, `cezar refused this exact call before (${before}); repeating it fails the same way: change the tool, command or arguments`);
      }
      const input = requestSchema.parse(args);
      if (!this.policy.tools.has(input.tool)) throw new Error(`${input.tool} is not granted`);
      switch (input.tool) {
        case 'Read': {
          if (input.ref) return result(true, readWindow(await this.readAtCommit(input.ref, input.path), input.offset, input.limit));
          const file = await open(await this.allowedPath(input.path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.size > 2_000_000) throw new Error('Read requires a regular file of at most 2 MB');
            const buffer = Buffer.alloc(stat.size);
            const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
            return result(true, readWindow(buffer.subarray(0, bytesRead).toString('utf8'), input.offset, input.limit));
          } finally { await file.close(); }
        }
        // Without ripgrep, search through grep and git rather than leave the model only whole-file dumps.
        case 'Grep': {
          const target = await this.allowedPath(input.path ?? '.');
          const argv = resolveProgram('rg', this.env)
            ? ['rg', '--no-config', '--line-number', '--max-count', '200', ...(input.glob ? ['--glob', input.glob] : []), '--', input.pattern, target]
            : ['grep', '-rnIE', '--max-count=200', '--exclude-dir=.git', '--exclude-dir=node_modules', ...(input.glob ? [`--include=${input.glob}`] : []), '--', input.pattern, target];
          return result(true, firstLines(await this.execute(argv), input.limit));
        }
        case 'Glob': {
          const target = await this.allowedPath(input.path ?? '.');
          // A git pathspec is relative to the target, so `..` could list past this step's read roots.
          if (!resolveProgram('rg', this.env) && input.pattern.split(/[\\/]/).includes('..')) throw new Error('a Glob pattern cannot climb out of its path');
          const files = resolveProgram('rg', this.env)
            ? await this.execute(['rg', '--no-config', '--files', '--glob', input.pattern, '--', target])
            : await this.execute(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '--', `:(glob)${input.pattern}`], true, target);
          return result(true, firstLines(files, input.limit));
        }
        case 'Bash': {
          if (this.policy.replayShell) {
            if (CONTROL.test(input.command)) throw new Error('a replay command cannot contain control characters');
            const ran = await this.policy.replayShell(input.command, this.aborter.signal);
            return result(ran.ok, ran.text);
          }
          if (this.policy.shell) {
            if (CONTROL.test(input.command)) throw new Error('cezar manager policy: a control character');
            const plan = this.policy.shell.verify(input.command);
            if (!plan.ok) throw new Error(`cezar manager policy: ${plan.reason}`);
            // Network off: only programs the shell names as offline run — gh and any user-allowed gh pattern do not.
            const offline = new Set(this.policy.shell.offlinePrograms ?? []);
            const online = plan.pipeline.find(([bin]) => !offline.has(bin!));
            if (!this.githubReadsAllowed && online) throw new Error(`network commands are disabled by CEZ_CODEX_NETWORK=0 (\`${online[0]}\` may reach the network)`);
            const ran = await runPipeline(plan.pipeline, plan.stdin, { cwd: await this.cwd, env: this.policy.shell.env, signal: this.aborter.signal, ...(this.limits.shellTimeoutMs ? { timeoutMs: this.limits.shellTimeoutMs } : {}) });
            return result(ran.ok, ran.text);
          }
          const argv = codexBashArgv(input.command, this.policy);
          if (!argv) throw new Error('command is outside this step’s approved read-only Bash grant');
          if (argv[0] === 'gh') {
            if (!this.githubReadsAllowed) throw new Error('GitHub reads are disabled by CEZ_CODEX_NETWORK=0');
            const hosts = new Set(['github.com', (this.env.GH_HOST ?? 'github.com').toLowerCase()]);
            const repository = (value: string): void => {
              if (/^https?:\/\//i.test(value)) {
                const url = new URL(value);
                if (url.protocol === 'https:' && !url.username && !url.password && !url.port && hosts.has(url.hostname.toLowerCase())) return;
              } else {
                const parts = value.split('/');
                if (parts.length === 3 && hosts.has(parts[0]!.toLowerCase())) parts.shift();
                if (parts.length === 2 && parts.every(p => /^[A-Za-z0-9_.-]+$/.test(p))) return;
              }
              throw new Error('GitHub repository host is not granted');
            };
            let explicit = false;
            for (let i = 3; i < argv.length; i++) if (argv[i] === '--repo' || argv[i] === '-R') {
              repository(argv[++i]!); explicit = true;
            }
            const operands = codexGithubOperands(argv);
            if (operands.length > 1) throw new Error('unsupported GitHub operands');
            for (const operand of operands) {
              if (argv[1] === 'repo' || /^https?:\/\//i.test(operand)) { repository(operand); explicit = true; }
              else if (!/^[A-Za-z0-9_.-]+$/.test(operand)) throw new Error('unsupported GitHub operand');
            }
            if (!explicit) {
              // gh can infer an enterprise host from ANY resolved Git remote, including URL rewrites.
              const remotes = await this.execute(['git', 'remote', '-v'], false);
              const urls = remotes.trim().split('\n').filter(Boolean).map(line => line.split(/\s+/)[1]!);
              if (!urls.length) throw new Error('GitHub reads need an explicit --repo or a configured GitHub remote');
              for (const remote of urls) {
                const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(remote);
                if (scp) repository(`${scp[1]}/${scp[2]}`);
                else repository(remote);
              }
            }
          }
          if (this.policy.bashPrefixes.includes(GIT_SHOW_AT_REF) && isGitShowAtRefArgv(argv)) return result(true, await this.blobAtRef(argv[2]!));
          return result(true, await this.execute(argv));
        }
      }
    } catch (err) {
      const reason = err instanceof z.ZodError ? argumentIssue(err) : err instanceof Error ? err.message : String(err);
      if (key !== undefined && reason !== 'session is closed') this.refused.set(key, reason);
      return result(false, `cezar denied or could not complete this read: ${reason}`);
    }
  }
}

function firstLines(text: string, limit: number | undefined): string {
  if (!limit) return text;
  const all = text.replace(/\n$/, '').split('\n');
  return all.length <= limit ? text : `${all.slice(0, limit).join('\n')}\n[cezar: first ${limit} of ${all.length} lines]`;
}

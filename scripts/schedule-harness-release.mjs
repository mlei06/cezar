// Schedule the protected harness-release workflow's check outside the cockpit process tree.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const checkout = dirname(dirname(fileURLToPath(import.meta.url)));
const hostEnv = Object.fromEntries(
  ['PATH', 'HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'].flatMap((key) =>
    process.env[key] === undefined ? [] : [[key, process.env[key]]]),
);
const git = (...args) => execFileSync('git', args, {
  cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...hostEnv, GIT_TERMINAL_PROMPT: '0' }, timeout: 30_000,
}).trim();

function main() {
  if (process.env.CEZ_DRY_RUN === '1') {
    console.log('Dry run checked the release workflow without scheduling the service.');
    return;
  }
  if (!process.env.CEZ_RUN_ID || process.env.CEZ_SUPERVISED !== '1' || process.env.CEZ_REMOTE === '1') {
    throw new Error('This workflow needs a local, supervised harness cockpit.');
  }
  const url = new URL(process.env.CEZ_API_URL ?? '');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('The workflow needs the local cockpit address.');
  }
  const script = join(checkout, 'scripts', 'harness-release.mjs');
  if (!existsSync(script)) throw new Error('The release script is missing from this task worktree.');

  git('fetch', '--quiet', 'origin', 'refs/heads/factory');
  const sha = git('rev-parse', '--verify', 'FETCH_HEAD^{commit}');
  git('diff', '--exit-code', sha, '--', 'scripts/harness-release.mjs', 'scripts/schedule-harness-release.mjs');
  // Resolve the merged commit once so a later fetch cannot change this release request.
  const unit = 'harness-release-' + sha.slice(0, 7);
  const workspace = process.env.CEZ_HOME;
  execFileSync('systemd-run', [
    '--user', '--collect', '--unit=' + unit, '--working-directory=' + checkout,
    '--setenv=PATH=' + (process.env.PATH ?? ''),
    ...(workspace ? ['--setenv=CEZ_HOME=' + workspace] : []),
    process.execPath, script, sha, '--benchmark', '--hold-new-tasks',
    '--health-url', new URL('/api/v1/health', url).href,
  ], { cwd: checkout, stdio: ['ignore', 'pipe', 'pipe'], env: hostEnv, timeout: 15_000 });
  console.log('Scheduled ' + unit + '. Its journal and the release log record the result.');
}

try {
  main();
} catch {
  console.error('Could not schedule the release. Check that the task worktree has the merged factory release scripts and that the local user service is available.');
  process.exitCode = 1;
}

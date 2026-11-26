import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseDocument, stringify } from 'yaml';
import {
  benchmarkNameSchema, benchmarkSuiteSchema, benchmarkTaskSchema,
  type BenchmarkSuite, type BenchmarkTask,
} from '@open-mercato/cezar-contract';
import { assertLifecyclePath, withLifecycleFileLock } from '../worktree-lifecycle/store.ts';
import { prepareText } from '../webhooks/storage.ts';

const BENCHMARK_PATH = '.ai/cezar/benchmarks';

async function definition(path: string) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 200_000) throw new Error('Expected a bounded YAML file.');
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) throw new Error('The definition changed while reading.');
    const document = parseDocument(buffer.subarray(0, bytesRead).toString('utf8'));
    if (document.errors.length) throw new Error('Invalid YAML.');
    return { document, data: document.toJS({ maxAliasCount: 20 }) as unknown };
  } finally {
    await file.close();
  }
}

async function realDir(path: string): Promise<void> {
  if (!(await lstat(path)).isDirectory()) throw new Error('Expected a regular benchmark directory.');
}

export async function loadBenchmarkSuites(root: string, workflows?: ReadonlySet<string>, scorers?: ReadonlySet<string>) {
  const suites: Array<{ name: string; suite: BenchmarkSuite; tasks: Map<string, BenchmarkTask> }> = [];
  const issues: Array<{ path: string; message: string }> = [];
  const base = join(root, BENCHMARK_PATH);
  let entries;
  try {
    await assertLifecyclePath(base, root);
    await realDir(base);
    entries = await readdir(base, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issues.push({ path: BENCHMARK_PATH, message: 'Cannot read the benchmark directory.' });
    return { suites, issues };
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !benchmarkNameSchema.safeParse(entry.name).success) continue;
    const folder = join(base, entry.name);
    const ref = BENCHMARK_PATH + '/' + entry.name;
    try {
      const suite = benchmarkSuiteSchema.parse((await definition(join(folder, 'suite.yaml'))).data);
      if (scorers && suite.scorers.some((name) => !scorers.has(name))) throw new Error('The suite refers to an unknown scorer.');
      await realDir(join(folder, 'tasks'));
      const tasks = new Map<string, BenchmarkTask>();
      for (const name of suite.tasks) {
        const task = benchmarkTaskSchema.parse((await definition(join(folder, 'tasks', name + '.yaml'))).data);
        if (workflows && !workflows.has(task.workflow)) throw new Error('Unknown workflow in task ' + name + '.');
        tasks.set(name, task);
      }
      suites.push({ name: entry.name, suite, tasks });
    } catch (error) {
      issues.push({ path: ref, message: (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'The suite or a task file is missing.' : error instanceof Error ? error.message : 'Cannot read the suite.' });
    }
  }
  return { suites, issues };
}

async function yamlAtomic(path: string, content: string) {
  const write = await prepareText(dirname(path), basename(path), content);
  try { write.publish(); await write.finish(); }
  finally { await write.discard(); }
}

export async function addBenchmarkTask(root: string, suiteName: string, id: string, input: BenchmarkTask) {
  const suite = benchmarkNameSchema.parse(suiteName);
  const name = benchmarkNameSchema.parse(id);
  const task = benchmarkTaskSchema.parse(input);
  const dir = join(root, BENCHMARK_PATH, suite);
  await assertLifecyclePath(dir, root);
  await mkdir(dir, { recursive: true });
  await realDir(join(root, BENCHMARK_PATH));
  await realDir(dir);
  const suitePath = join(dir, 'suite.yaml');
  const lock = join(root, '.ai/cezar/factory', 'benchmark-' + suite + '.lock');
  await assertLifecyclePath(lock, root);
  return withLifecycleFileLock(lock, async () => {
    const taskDir = join(dir, 'tasks');
    await assertLifecyclePath(taskDir, root);
    await mkdir(taskDir, { recursive: true });
    await realDir(taskDir);
    let existing;
    try { existing = await definition(suitePath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const prior = existing ? benchmarkSuiteSchema.parse(existing.data) : undefined;
    const all = [...new Set([...(prior?.tasks ?? []), name])];
    benchmarkSuiteSchema.parse({ ...prior, configurations: prior?.configurations ?? [{ name: 'default' }], tasks: all });
    const taskPath = join(taskDir, name + '.yaml');
    let frozen;
    try { frozen = benchmarkTaskSchema.parse((await definition(taskPath)).data); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (frozen && !isDeepStrictEqual(frozen, task)) throw new Error('A different frozen task already uses this name.');
    if (!frozen) await yamlAtomic(taskPath, stringify(task));
    if (existing && prior) {
      if (!prior.tasks.includes(name)) {
        existing.document.set('tasks', all);
        await yamlAtomic(suitePath, existing.document.toString());
      }
    } else {
      await yamlAtomic(suitePath, stringify({ configurations: [{ name: 'default' }], tasks: all, scorers: ['outcome'], times: 1 }));
    }
    return { task: name, path: BENCHMARK_PATH + '/' + suite + '/tasks/' + name + '.yaml' };
  });
}

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { addBenchmarkTask, loadBenchmarkSuites } from './suites.ts';

it('keeps a task frozen and safely updates the existing suite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-benchmark-suite-'));
  const task = {
    title: 'Inspect an example', workflow: 'operate', prompt: 'Describe the example.',
    successCriteria: 'Name the example.', startCommit: 'a'.repeat(40),
  };
  try {
    const first = await addBenchmarkTask(root, 'smoke', 'inspect', task);
    const suite = join(root, '.ai/cezar/benchmarks/smoke/suite.yaml');
    const original = await readFile(suite, 'utf8');
    await writeFile(suite, '# local configuration\n' + original);
    await Promise.all([
      addBenchmarkTask(root, 'smoke', 'again', task),
      addBenchmarkTask(root, 'smoke', 'last', task),
    ]);
    const loaded = await loadBenchmarkSuites(root, new Set(['operate']), new Set(['outcome']));
    expect(loaded.issues).toEqual([]);
    expect(loaded.suites[0]?.tasks).toEqual(new Map([['inspect', task], ['again', task], ['last', task]]));
    expect(await readFile(suite, 'utf8')).toContain('# local configuration');
    await expect(addBenchmarkTask(root, 'smoke', 'inspect', { ...task, prompt: 'Different' }))
      .rejects.toThrow('A different frozen task');
    expect(await readFile(join(root, first.path), 'utf8')).toContain(task.prompt);
    expect((await loadBenchmarkSuites(root, new Set(['review']))).issues[0]?.message).toContain('Unknown workflow');
    await expect(addBenchmarkTask(root, '../elsewhere', 'inspect', task)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

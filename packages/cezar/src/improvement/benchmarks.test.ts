import { expect, it } from 'vitest';
import { changedModelWorkflow } from './benchmarks.ts';

it('revalidates changed agent selection without treating prompt or comments as routing changes', () => {
  const before = 'name: operate\nsteps:\n- id: task\n  model: routine-old\n  prompt: Check status.\n';
  expect(changedModelWorkflow(before, before.replace('Check status.', 'Find the status.'))).toBeUndefined();
  expect(changedModelWorkflow(before, before.replace('routine-old', 'routine-new'))).toBe('operate');
  expect(changedModelWorkflow(undefined, before)).toBe('operate');
  expect(changedModelWorkflow(before, undefined)).toBe('operate');
  expect(changedModelWorkflow('name: verify\nnodes:\n- {id: only, type: check}', 'name: verify\nnodes:\n- {id: only, type: check, model: example}'))
    .toBeUndefined();
});

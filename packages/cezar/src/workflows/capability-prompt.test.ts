import { describe, expect, it } from 'vitest';
import { capabilityPrompt } from './capability-prompt.ts';

const input = { workflow: 'deploy', runner: 'opencode', model: 'davy/mistral-large-4', skill: 'jenkins-deploy' };

describe('task capability block', () => {
  it('keeps the effective model, budget, attached skill and other workflows', () => {
    expect(capabilityPrompt({
      ...input, budget: { tokens: 600_000, minutes: 60 },
      secrets: [{ name: 'JENKINS_URL', description: 'Jenkins API' }],
      workflows: ['plan', 'deploy', 'operate'],
    })).toBe([
      'Workflow: deploy (opencode, davy/mistral-large-4); budget 600000 tokens, 60 min active',
      'Secrets in your environment (values hidden; never print them):',
      '  JENKINS_URL: Jenkins API',
      'Other workflows in this project: operate, plan',
      'Attached skill: jenkins-deploy (scripts in its folder)',
    ].join('\n'));
  });

  it('trims workflow names before descriptions and counts only the omitted entries', () => {
    const workflows = Array.from({ length: 30 }, (_, i) => `workflow_${String(i).padStart(2, '0')}_${'w'.repeat(70)}`);
    const secrets = Array.from({ length: 10 }, (_, i) => ({ name: `KEY_${i}`, description: 'd'.repeat(200) }));

    const workflowsTrimmed = capabilityPrompt({ ...input, workflows, secrets: secrets.slice(0, 1) });
    expect(workflowsTrimmed.length).toBeLessThanOrEqual(2_000);
    expect(workflowsTrimmed).toContain(secrets[0]!.description);
    expect(workflowsTrimmed).toContain(workflows[0]);
    const keptWorkflows = workflows.filter((name) => workflowsTrimmed.includes(name)).length;
    expect(keptWorkflows).toBeLessThan(workflows.length);
    expect(workflowsTrimmed).toContain(`Omitted: ${workflows.length - keptWorkflows} workflow names, 0 secret descriptions.`);

    const descriptionsTrimmed = capabilityPrompt({ ...input, workflows, secrets });
    expect(descriptionsTrimmed.length).toBeLessThanOrEqual(2_000);
    expect(descriptionsTrimmed).not.toContain('Other workflows');
    expect(descriptionsTrimmed).toContain('  KEY_0: ');
    expect(descriptionsTrimmed).toContain('\n  KEY_9\n');
    const keptDescriptions = descriptionsTrimmed.match(/^  KEY_\d+: /gm)?.length ?? 0;
    expect(keptDescriptions).toBeLessThan(secrets.length);
    expect(descriptionsTrimmed).toContain(`Omitted: 30 workflow names, ${secrets.length - keptDescriptions} secret descriptions.`);
    expect(descriptionsTrimmed.match(/^  KEY_\d+/gm)).toEqual(secrets.map(({ name }) => `  ${name}`));
  });

  it('preserves every name on one line when names alone exceed the cap', () => {
    const names = Array.from({ length: 40 }, (_, i) => `KEY_${String(i).padStart(2, '0')}_${'X'.repeat(60)}`);
    const block = capabilityPrompt({
      ...input, workflows: ['plan'], secrets: names.map((name) => ({ name, description: 'Fixture description' })),
    });
    expect(block.length).toBeGreaterThan(2_000);
    expect(block.split('\n').filter((line) => line.startsWith('  '))).toEqual([`  ${names.join(', ')}`]);
    expect(block).toContain('Omitted: 1 workflow names, 40 secret descriptions.');
    expect(block).not.toContain('Fixture description');
    expect(block).toContain('Attached skill: jenkins-deploy');
  });
});

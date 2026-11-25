import type { WorkflowDef } from './types.ts';

const CAP = 2_000;

export function capabilityPrompt(input: {
  workflow: string;
  runner: string;
  model?: string;
  budget?: WorkflowDef['budget'];
  budgetUsd?: number;
  secrets: ReadonlyArray<{ name: string; description?: string }>;
  workflows: readonly string[];
  skill?: string;
}): string {
  const budget = [
    input.budget?.tokens === undefined ? undefined : `${input.budget.tokens} tokens`,
    input.budget?.minutes === undefined ? undefined : `${input.budget.minutes} min active`,
    input.budgetUsd === undefined ? undefined : `$${input.budgetUsd}`,
  ].filter(Boolean).join(', ');
  const header = `Workflow: ${input.workflow} (${[input.runner, input.model].filter(Boolean).join(', ')})${budget ? `; budget ${budget}` : ''}`;
  const secrets = [...input.secrets].sort((a, b) => a.name.localeCompare(b.name));
  const secretLines = secrets.map(({ name, description }) => `  ${name}${description ? `: ${description}` : ''}`);
  const workflows = [...new Set(input.workflows)].filter((name) => name !== input.workflow).sort();
  const workflowHeading = 'Other workflows in this project: ';
  const skill = input.skill ? `Attached skill: ${input.skill} (scripts in its folder)` : undefined;
  let omittedWorkflows = 0;
  let omittedDescriptions = 0;

  const omissions = () => omittedWorkflows || omittedDescriptions
    ? `Omitted: ${omittedWorkflows} workflow names, ${omittedDescriptions} secret descriptions.`
    : undefined;
  const names = secrets.map(({ name }) => name);
  const noSecrets = 'Secrets in your environment: none.';
  const render = (compact = false) => [
    header,
    secrets.length ? 'Secrets in your environment (values hidden; never print them):' : noSecrets,
    secrets.length ? compact ? `  ${names.join(', ')}` : secretLines.join('\n') : undefined,
    workflows.length ? `${workflowHeading}${workflows.join(', ')}` : undefined,
    skill,
    omissions(),
  ].filter(Boolean).join('\n');

  // Account for the separators and omission line without rebuilding the block for each entry.
  let payloadLength = render().length;
  const overCap = () => {
    const note = omissions();
    return payloadLength + (note ? note.length + 1 : 0) > CAP;
  };
  while (overCap() && workflows.length) {
    const removed = workflows.pop()!;
    payloadLength -= removed.length + (workflows.length ? 2 : workflowHeading.length + 1);
    omittedWorkflows++;
  }
  for (let index = secrets.length - 1; overCap() && index >= 0; index--) {
    const { name, description } = secrets[index]!;
    if (!description) continue;
    const nameLine = `  ${name}`;
    payloadLength -= secretLines[index]!.length - nameLine.length;
    secretLines[index] = nameLine;
    omittedDescriptions++;
  }
  if (!overCap()) return render();
  const compact = render(true);
  if (compact.length <= CAP) return compact;

  const note = omissions();
  if (!names.length) {
    const footer = [noSecrets, note].filter(Boolean).join('\n');
    return `${header.slice(0, CAP - footer.length - 1)}\n${footer}`;
  }

  const namesLine = names.join(', ');
  const minimal = [namesLine, note].filter(Boolean).join('\n');
  if (minimal.length <= CAP) return minimal;
  const tightNames = names.join(',');
  const tight = [tightNames, note].filter(Boolean).join('\n');
  if (tight.length <= CAP) return tight;
  // When the names consume the entire allowance, they take priority over the note.
  return tightNames.length <= CAP ? tightNames : tight;
}

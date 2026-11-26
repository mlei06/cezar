import { loadBenchmarkSuites } from '../benchmarks/suites.ts';
import { discoverSkills } from '../skills.ts';
import { loadWorkflows } from '../workflows/load.ts';
import { ScorerCatalog, type ScorerIssue } from './scorers.ts';

export async function checkFactory(repoRoot: string): Promise<ScorerIssue[]> {
  const [{ workflows, issues }, skills] = await Promise.all([loadWorkflows(repoRoot), discoverSkills(repoRoot)]);
  const names = new Set(workflows.map((workflow) => workflow.name));
  const skillNames = new Set(skills.map((skill) => skill.name));
  const issuesFound = [...issues];
  for (const workflow of workflows) {
    const steps = workflow.graph ? workflow.graph.nodes.filter((node) => node.type === 'agent') : workflow.steps;
    for (const step of steps) {
      if (step.skill && !skillNames.has(step.skill)) {
        issuesFound.push({ path: workflow.name, message: `Step ${step.id} refers to unknown skill ${step.skill}.` });
      }
    }
  }
  const { scorers, issues: scorerIssues } = await new ScorerCatalog().load(repoRoot, names);
  const { issues: benchmarkIssues } = await loadBenchmarkSuites(repoRoot, names, new Set(scorers.map(({ name }) => name)));
  return [...issuesFound, ...scorerIssues, ...benchmarkIssues];
}

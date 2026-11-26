import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { FactoryIcon } from 'lucide-react'
import { z } from 'zod'
import {
  benchmarkHistoryResponseSchema, benchmarkResultsResponseSchema, benchmarkSuitesResponseSchema,
  factorySummaryResponseSchema, type ScoreGroup,
} from '@open-mercato/cezar-api-client'
import { useProjectScope } from '@/api/project-scope-context'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { CenteredState } from '@/components/centered-state'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from '@/components/ui/toaster'

async function fetchFactory<T>(base: string, path: string, schema: z.ZodType<T>, method = 'GET'): Promise<T> {
  const result = await fetch(base + path, {
    method, headers: { accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    ...(method === 'POST' ? { body: '{}' } : {}),
  })
  const value: unknown = await result.json().catch(() => undefined)
  if (result.ok) return schema.parse(value)
  const reason = value && typeof value === 'object' && 'error' in value ? value.error : undefined
  throw new Error(typeof reason === 'string' ? reason : 'Factory request failed (' + result.status + ')')
}

function rate(score: ScoreGroup | undefined) {
  if (!score || score.passed + score.failed === 0) return '—'
  return Math.round(100 * score.passed / (score.passed + score.failed)) + '%'
}

const header = 'px-3 py-2 text-left font-medium text-muted-foreground'
const value = 'border-t px-3 py-2'
const section = 'gap-4 p-4'

export function FactoryRoute() {
  const { apiBase } = useProjectScope()
  const client = useQueryClient()
  const summary = useQuery({
    queryKey: [apiBase, 'factory'], queryFn: () => fetchFactory(apiBase, '/factory', factorySummaryResponseSchema),
  })
  const improve = useMutation({
    mutationFn: () => fetchFactory(apiBase, '/automations/factory-improvement/run', z.unknown(), 'POST'),
    onSuccess: () => {
      toast('Improvement started')
      void client.invalidateQueries({ queryKey: [apiBase, 'factory'] })
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  if (summary.isPending) return <p className="p-5 text-muted-foreground">Loading factory…</p>
  if (summary.isError) return <CenteredState icon={<FactoryIcon />} tone="danger" title="Factory data did not load" subtitle={summary.error.message} heading="h2" />

  const { current, previous, improvements, report, weekly } = summary.data
  const scorers = [...new Set([...current.groups, ...previous].map(({ key }) => key))].sort()
  return <main data-route="factory" className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-4 md:p-6">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-xl font-semibold">Factory</h1>
      <div className="flex gap-2">
        {report && <Button asChild variant="outline"><a href={apiBase + '/factory/reports/' + report}>Weekly report</a></Button>}
        <Button disabled={improve.isPending} onClick={() => improve.mutate()}>Improve now</Button>
      </div>
    </header>

    <div className="grid gap-5 lg:grid-cols-2">
      <Card className={section}>
        <h2 className="font-semibold">Scorer pass rates</h2>
        {scorers.length ? <table className="w-full text-sm">
          <thead><tr><th scope="col" className={header}>Scorer</th><th scope="col" className={header}>Prior 7 days</th><th scope="col" className={header}>Last 7 days</th></tr></thead>
          <tbody>{scorers.map((key) => <tr key={key}>
            <th scope="row" className={value + ' text-left font-medium'}>{key}</th>
            <td className={value}>{rate(previous.find((score) => score.key === key))}</td>
            <td className={value}>{rate(current.groups.find((score) => score.key === key))}</td>
          </tr>)}</tbody>
        </table> : <p className="text-sm text-muted-foreground">No scored tasks in the last 14 days.</p>}
      </Card>
      <Card className={section}>
        <h2 className="font-semibold">Cause queue</h2>
        {!current.queue ? <p className="text-sm text-muted-foreground">The queue is unavailable.</p> : <>
          <p className="text-sm text-muted-foreground">{current.queue.counts.open ?? 0} open · {current.queue.counts.processing ?? 0} in progress</p>
          <ul className="divide-y text-sm">{current.queue.openCauses.map(({ id, scorer, cause }) => <li key={id} className="py-2">
            <p className="font-medium">{scorer} · {cause.category} · {cause.target}</p><p className="text-muted-foreground">{cause.fix}</p>
          </li>)}</ul>
        </>}
      </Card>
    </div>

    <Card className={section}>
      <h2 className="font-semibold">Merged PRs</h2>
      {weekly ? <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
        <div><dt className="text-muted-foreground">Confirmed merges</dt><dd className="font-medium">{weekly.merged}</dd></div>
        <div><dt className="text-muted-foreground">Recorded cost per merged PR</dt>
          <dd className="font-medium">{weekly.meanCostUsd === undefined ? '—' : '$' + weekly.meanCostUsd.toFixed(3)}</dd>
        </div>
        <div><dt className="text-muted-foreground">Recorded human follow-ups per merged PR</dt>
          <dd className="font-medium">{weekly.meanHumanTouchpoints === undefined ? '—' : weekly.meanHumanTouchpoints.toFixed(1)}</dd>
        </div>
      </dl> : <p className="text-sm text-muted-foreground">The weekly report hasn’t recorded merge metrics yet.</p>}
    </Card>

    <Card className={section}>
      <h2 className="font-semibold">Improvements</h2>
      {improvements.length ? <ul className="divide-y text-sm">{improvements.map(({ id, state, startedAt, pr }) => <li key={id} className="flex flex-wrap justify-between gap-2 py-2">
        <span>{pr?.number ? 'PR #' + pr.number : 'Batch'} · {state.replace('-', ' ')}</span>
        <time className="text-muted-foreground" dateTime={startedAt}>{new Date(startedAt).toLocaleDateString()}</time>
      </li>)}</ul> : <p className="text-sm text-muted-foreground">No improvement batches yet.</p>}
    </Card>

    <BenchmarkResults key={apiBase} base={apiBase} />
  </main>
}

function BenchmarkResults({ base }: { base: string }) {
  const [choice, setChoice] = useState('')
  const catalog = useQuery({
    queryKey: [base, 'benchmarks'], queryFn: () => fetchFactory(base, '/benchmarks', benchmarkSuitesResponseSchema),
  })
  const suite = choice || catalog.data?.suites[0]?.name || ''
  const path = '/benchmarks/' + encodeURIComponent(suite) + '/results'
  const history = useQuery({
    queryKey: [base, 'benchmark-history', suite], enabled: Boolean(suite),
    queryFn: () => fetchFactory(base, path, benchmarkHistoryResponseSchema),
  })
  const latest = history.data?.batches[0]?.id
  const result = useQuery({
    queryKey: [base, 'benchmark-result', suite, latest], enabled: Boolean(latest),
    queryFn: () => fetchFactory(base, path + '/' + latest, benchmarkResultsResponseSchema),
    refetchInterval: (query) => query.state.data?.rows.some(({ unsettled, pending }) => unsettled || pending) ? 5000 : false,
  })
  const artifact = result.data?.artifact
  return <Card className={section}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="font-semibold">Benchmarks</h2>
      {catalog.data?.suites.length ? <Select value={suite} onValueChange={setChoice}>
        <SelectTrigger size="sm" aria-label="Benchmark suite"><SelectValue /></SelectTrigger>
        <SelectContent>{catalog.data.suites.map(({ name }) => <SelectItem key={name} value={name}>{name}</SelectItem>)}</SelectContent>
      </Select> : null}
    </div>
    {catalog.isError || history.isError || result.isError ? <p className="text-sm text-danger">Benchmark results could not load.</p>
      : result.data ? <>
        <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead><tr>{['Configuration', 'Pass rate', 'Mean cost', 'Mean time', 'Unavailable'].map((heading) => <th key={heading} scope="col" className={header}>{heading}</th>)}</tr></thead>
          <tbody>{result.data.rows.map((row) => <tr key={row.name}>
            <th scope="row" className={value + ' text-left font-medium'}>{row.name}</th>
            <td className={value}>{row.passed + row.failed ? Math.round(100 * row.passed / (row.passed + row.failed)) + '%' : '—'}</td>
            <td className={value}>{row.meanCostUsd === undefined ? '—' : '$' + row.meanCostUsd.toFixed(3)}</td>
            <td className={value}>{row.meanWallMs === undefined ? '—' : (row.meanWallMs / 1000).toFixed(1) + ' s'}</td>
            <td className={value}>{row.unavailable + row.missing}</td>
          </tr>)}</tbody>
        </table></div>
        {artifact && <a className="text-sm underline" href={base + '/runs/' + artifact.runId + '/artifacts/' + artifact.name}>Benchmark artifact</a>}
      </> : <p className="text-sm text-muted-foreground">{catalog.isPending || history.isFetching ? 'Loading benchmarks…' : 'No results recorded for this suite.'}</p>}
  </Card>
}

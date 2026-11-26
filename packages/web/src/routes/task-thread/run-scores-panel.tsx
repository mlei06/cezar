import { useRunScores } from '@/api/queries'
import { Badge } from '@/components/ui/badge'

const readable = (value: string) => value.replaceAll('-', ' ')

export function RunScoresPanel({ runId }: { runId: string }) {
  const { data } = useRunScores(runId)
  const entries = Object.entries(data?.scores ?? {})
  if (!entries.length) return null
  return (
    <section aria-label="Scores" className="space-y-1 rounded-lg border border-border bg-card p-3">
      <h2 className="text-sm font-semibold">Scores</h2>
      {entries.map(([name, entry]) => (
        <details key={name} className="border-t border-border py-2">
          <summary className="cursor-pointer text-sm">
            <span className="capitalize">{readable(name)}</span>{' '}
            {entry.status === 'scored' ? (
              <Badge variant={entry.score.pass ? 'secondary' : 'destructive'}>
                {entry.score.pass ? 'Pass' : 'Fail'} · {readable(entry.score.label)}
              </Badge>
            ) : (
              <Badge variant="outline">{entry.status === 'pending' ? 'Pending' : 'Error'}</Badge>
            )}
          </summary>
          {entry.status === 'error' ? <p className="mt-2 text-sm text-muted-foreground">{entry.reason}</p> : null}
          {entry.status === 'pending' ? <p className="mt-2 text-sm text-muted-foreground">
            {entry.outages ? `Retry at ${new Date(entry.retryAt).toLocaleString()}` : 'Waiting for the judge'}
          </p> : null}
          {entry.status === 'scored' ? (
            <div className="mt-2 space-y-2 text-sm">
              <p className="whitespace-pre-wrap">{entry.score.reasoning}</p>
              {entry.score.evidence.map((quote, index) => (
                <blockquote key={index} className="whitespace-pre-wrap border-l-2 border-border pl-2 text-muted-foreground">{quote}</blockquote>
              ))}
              {entry.score.causes.length > 0 ? (
                <ul className="space-y-2">
                  {entry.score.causes.map(({ category, target, evidence, fix }, index) => (
                    <li key={index}>
                      <p className="capitalize font-medium">{readable(category)} · {readable(target)}</p>
                      <p className="whitespace-pre-wrap">{fix}</p>
                      <blockquote className="whitespace-pre-wrap border-l-2 border-border pl-2 text-muted-foreground">{evidence}</blockquote>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </details>
      ))}
    </section>
  )
}

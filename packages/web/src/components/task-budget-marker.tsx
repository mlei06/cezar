import type { ApiRun } from '@open-mercato/cezar-api-client'
import { TriangleAlertIcon } from 'lucide-react'

export function TaskBudgetMarker({ run }: { run: Pick<ApiRun, 'startedByManager' | 'budgetExceeded'> }) {
  if (run.startedByManager || !run.budgetExceeded?.length) return null
  return (
    <span role="img" aria-label="Task budget reached" title="Task budget reached" className="inline-flex shrink-0 align-middle text-pending-strong">
      <TriangleAlertIcon className="size-3.5" aria-hidden="true" />
    </span>
  )
}

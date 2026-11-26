import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import type { FactorySummaryResponse } from '@open-mercato/cezar-api-client'
import { afterEach, expect, it, vi } from 'vitest'
import { FactoryRoute } from './factory'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('shows pending and failed score counts for the current window', async () => {
  const group = { key: 'outcome', passed: 2, failed: 0, pending: 4, errors: 2 }
  const summary: FactorySummaryResponse = {
    current: { groups: [group], queue: null },
    previous: [{ ...group, pending: 8, errors: 5 }],
    improvements: [],
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    Response.json(url.endsWith('/factory') ? summary : { suites: [] })))
  const client = new QueryClient()

  render(<QueryClientProvider client={client}><FactoryRoute /></QueryClientProvider>)

  const progress = await screen.findByRole('status', { name: 'Scoring progress' })
  expect(progress.textContent).toBe('4 pending · 2 errors')
})

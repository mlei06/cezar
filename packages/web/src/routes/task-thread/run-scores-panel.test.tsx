// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { it, expect, vi } from 'vitest'
import { RunScoresPanel } from './run-scores-panel'

vi.mock('@/api/queries', () => ({
  useRunScores: () => ({
    data: { scores: {
      outcome: {
        status: 'scored', score: {
          pass: false, label: 'missed', reasoning: 'The report was missing.',
          evidence: ['Only the fixture ran.'],
          causes: [{ category: 'repository', target: 'docs', evidence: 'No document was generated.', fix: 'Add the report.' }],
        },
      },
      efficiency: { status: 'pending', outages: 0 },
    } },
  }),
}))

it('shows scorer state and lets the reader open evidence and causes', () => {
  render(<RunScoresPanel runId="fixture" />)
  expect(screen.getByRole('heading', { name: 'Scores' })).toBeTruthy()
  expect(screen.getByText('Fail · missed')).toBeTruthy()
  expect(screen.getByText('Pending')).toBeTruthy()
  fireEvent.click(screen.getByText('outcome'))
  expect(screen.getByText('Only the fixture ran.')).toBeTruthy()
  expect(screen.getByText('Add the report.')).toBeTruthy()
  expect(screen.getByText('No document was generated.')).toBeTruthy()
})

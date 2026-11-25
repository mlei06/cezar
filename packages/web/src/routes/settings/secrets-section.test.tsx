import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setApiScope } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { ProjectSecretsSection, WorkspaceSecretsSection } from './secrets-section'

afterEach(() => { cleanup(); setApiScope(null); vi.unstubAllGlobals() })

type Stored = { name: string; audiences: ('checks' | 'cezar')[]; updatedAt: string; description?: string }
const DEFAULT: Stored[] = [
  { name: 'OPENAI_API_KEY', audiences: ['checks'], updatedAt: '2026-10-10T00:00:00Z' },
  { name: 'STAGING_TOKEN', audiences: ['checks', 'cezar'], description: 'Staging deploy token', updatedAt: '2026-10-10T00:00:00Z' },
]

function setup(options: { secrets?: Stored[]; putStatus?: number; keyBackend?: 'keychain' | 'file'; scope?: 'project' | 'workspace'; skipped?: string } = {}) {
  const { secrets = DEFAULT, putStatus = 204, keyBackend = 'keychain', scope = 'project', skipped } = options
  let stored = secrets
  const calls: { method: string; url: string; body?: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, url: String(input), body: typeof init?.body === 'string' ? init.body : undefined })
    if (method === 'GET') return new Response(JSON.stringify({ secrets: stored, keyBackend, ...(skipped ? { skipped } : {}) }), { status: 200 })
    if (method === 'PUT' && putStatus !== 204) return new Response(JSON.stringify({ error: 'storage failed' }), { status: putStatus })
    if (method === 'PATCH') {
      const name = String(input).split('/').at(-1)
      const { description } = JSON.parse(String(init?.body)) as { description: string }
      stored = stored.map((entry) => entry.name === name ? { ...entry, description: description || undefined } : entry)
    }
    return new Response(null, { status: 204 })
  }))
  const Section = scope === 'project' ? ProjectSecretsSection : WorkspaceSecretsSection
  render(<QueryClientProvider client={createQueryClient()}><Section /></QueryClientProvider>)
  return calls
}

describe('Secrets settings', () => {
  it('lists stored names with their audiences, the key backend, and renders no value', async () => {
    setup()
    await screen.findByText('OPENAI_API_KEY')
    expect(screen.getByText('STAGING_TOKEN')).toBeTruthy()
    expect(screen.getByText('Staging deploy token')).toBeTruthy()
    expect(screen.getByText('Check steps · cezar itself')).toBeTruthy()
    expect(screen.getByText(/kept in your OS keychain/)).toBeTruthy()
    // No value is rendered anywhere: the only inputs with content are the audience checkboxes.
    expect(screen.queryAllByDisplayValue(/.+/).every((el) => (el as HTMLInputElement).type === 'checkbox')).toBe(true)
    expect((screen.getByLabelText('Value') as HTMLInputElement).value).toBe('')
    expect(screen.getByLabelText('Value').getAttribute('type')).toBe('password')
  })

  it('says why listed secrets cannot be read', async () => {
    setup({ skipped: 'the data key is gone' })
    await screen.findByText('OPENAI_API_KEY')
    expect(screen.getByRole('alert').textContent).toContain('the data key is gone')
  })

  it('says plainly when the data key is a file, not a keychain item', async () => {
    setup({ keyBackend: 'file' })
    await screen.findByText('OPENAI_API_KEY')
    expect(screen.getByText(/private file, not a vault/)).toBeTruthy()
  })

  it('adds a secret with PUT, audiences included, and clears the inputs', async () => {
    const calls = setup()
    await screen.findByText('OPENAI_API_KEY')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'NEW_KEY' } })
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 's3cret' } })
    const description = screen.getByLabelText('Description (optional)') as HTMLInputElement
    expect(description.maxLength).toBe(200)
    fireEvent.change(description, { target: { value: 'Deployment key' } })
    fireEvent.click(screen.getByLabelText(/cezar itself/))
    fireEvent.click(screen.getByRole('button', { name: /save secret/i }))
    await waitFor(() => expect((screen.getByLabelText('Value') as HTMLInputElement).value).toBe(''))
    const put = calls.find((c) => c.method === 'PUT')!
    expect(put.url).toMatch(/\/secrets\/NEW_KEY$/)
    expect(put.url).not.toContain('/workspace/')
    expect(JSON.parse(put.body!)).toEqual({ value: 's3cret', audiences: ['checks', 'agents', 'cezar'], description: 'Deployment key' })
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('')
    expect(description.value).toBe('')
    expect(screen.queryByText('s3cret')).toBeNull()
  })

  it('addresses the workspace routes from the global section', async () => {
    const calls = setup({ scope: 'workspace' })
    await screen.findByText('OPENAI_API_KEY')
    expect(calls[0]!.url).toMatch(/\/api\/v1\/workspace\/secrets$/)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'LLM_KEY' } })
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'sk-x' } })
    fireEvent.click(screen.getByRole('button', { name: /save secret/i }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    expect(calls.find((c) => c.method === 'PUT')!.url).toMatch(/\/api\/v1\/workspace\/secrets\/LLM_KEY$/)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete STAGING_TOKEN' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/workspace/secrets/STAGING_TOKEN'))).toBe(true))
  })

  it.each(['project', 'workspace'] as const)('clears a %s description and refreshes without sending a value', async (scope) => {
    setApiScope('demo-project')
    const listPath = scope === 'project' ? '/api/v1/p/demo-project/secrets' : '/api/v1/workspace/secrets'
    const calls = setup({ scope })
    expect(await screen.findByText('Staging deploy token')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Edit description for STAGING_TOKEN' }))
    const description = screen.getByLabelText('Description for STAGING_TOKEN') as HTMLInputElement
    expect(description.value).toBe('Staging deploy token')
    expect(description.maxLength).toBe(200)
    fireEvent.change(description, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save description' }))
    await waitFor(() => {
      expect(screen.queryByLabelText('Description for STAGING_TOKEN')).toBeNull()
      expect(screen.queryByText('Staging deploy token')).toBeNull()
    })
    expect(screen.getByText('STAGING_TOKEN')).toBeTruthy()
    expect(calls.map(({ method, url }) => [method, url])).toEqual([
      ['GET', listPath],
      ['PATCH', `${listPath}/STAGING_TOKEN`],
      ['GET', listPath],
    ])
    const patch = calls.find((c) => c.method === 'PATCH')!
    expect(JSON.parse(patch.body!)).toEqual({ description: '' })
    expect(calls.some((call) => call.method === 'PUT')).toBe(false)
  })

  it('shows the reason for a refused name without calling PUT', async () => {
    const calls = setup()
    await screen.findByText('OPENAI_API_KEY')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'PATH' } })
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'x' } })
    expect(await screen.findByText(/PATH changes how the check's shell runs/)).toBeTruthy()
    fireEvent.submit(screen.getByLabelText('Name').closest('form')!)
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('keeps Save disabled with no audience picked', async () => {
    const calls = setup()
    await screen.findByText('OPENAI_API_KEY')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'OK_NAME' } })
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'x' } })
    fireEvent.click(screen.getByLabelText(/Check steps/))
    fireEvent.click(screen.getByLabelText(/^Agents/))
    expect((screen.getByRole('button', { name: /save secret/i }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.submit(screen.getByLabelText('Name').closest('form')!)
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('shows the server error when saving fails, and keeps what was typed', async () => {
    setup({ secrets: [{ name: 'A', audiences: ['checks'], updatedAt: '' }], putStatus: 409 })
    await screen.findByText('A')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'OK_NAME' } })
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'a-long-pasted-key' } })
    fireEvent.click(screen.getByRole('button', { name: /save secret/i }))
    expect(await screen.findByText('storage failed')).toBeTruthy()
    // Retrying a transient failure must not cost a re-paste of the key.
    expect((screen.getByLabelText('Value') as HTMLInputElement).value).toBe('a-long-pasted-key')
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('OK_NAME')
  })

  it('deletes a secret with DELETE', async () => {
    const calls = setup()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete STAGING_TOKEN' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/secrets/STAGING_TOKEN'))).toBe(true))
  })

  it('renders the form with the shared Input inside a FormRow and a danger-ghost Delete per row', async () => {
    setup()
    await screen.findByText('OPENAI_API_KEY')
    expect(screen.getByLabelText('Name').getAttribute('data-slot')).toBe('input')
    expect(screen.getByLabelText('Value').getAttribute('data-slot')).toBe('input')
    expect(screen.getByLabelText('Name').closest('[data-slot="form-row"]')).not.toBeNull()
    expect(document.querySelector('select')).toBeNull()
    expect(screen.getByRole('button', { name: 'Delete OPENAI_API_KEY' }).getAttribute('data-variant')).toBe('danger-ghost')
  })
})

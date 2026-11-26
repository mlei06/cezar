import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId } from 'react'
import type { FactoryImprovementPatch, ImprovementScope, FactoryImprovementSettings } from '@open-mercato/cezar-api-client'

import { putWorkspaceConfig } from '@/api/client'
import { useWorkspaceConfig, workspaceQueryKeys } from '@/api/queries'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { IntegerStepper } from '@/components/integer-stepper'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from '@/components/ui/toaster'
import { FormRow, SettingsCard } from './form-row'
import { useConfigSave, useSavedKeys } from './use-config-save'

const counts = [
  { key: 'threshold', label: 'Causes before starting', min: 1, max: 100 },
  { key: 'minForAge', label: 'Causes needed for the age trigger', min: 1, max: 100 },
  { key: 'cooldownRuns', label: 'Cooldown (scored runs)', min: 0, max: 1000 },
] as const

const dayFields = [
  { key: 'ageDays', label: 'Age of oldest cause (days)' },
  { key: 'cooldownDays', label: 'Cooldown (days)' },
] as const

const scopes = [
  ['docs', 'Documentation'],
  ['agents-md', 'AGENTS.md'],
  ['skills', 'Skills'],
  ['workflows', 'Workflows'],
  ['code', 'Product code'],
] as const satisfies ReadonlyArray<readonly [ImprovementScope, string]>

type SavePolicy = (patch: FactoryImprovementPatch) => void

function PolicyChoice({ label, value, disabled, choices, onChange }: {
  label: string
  value: string
  disabled: boolean
  choices: [string, string][]
  onChange: (value: string) => void
}) {
  return (
    <Select value={value} disabled={disabled} onValueChange={onChange}>
      <SelectTrigger size="sm" aria-label={label} className="w-52"><SelectValue /></SelectTrigger>
      <SelectContent>{choices.map(([id, text]) => <SelectItem key={id} value={id}>{text}</SelectItem>)}</SelectContent>
    </Select>
  )
}

function ImprovementForm({ stored, workspaceScope, isWorkspace, pending, savedFor, save }: {
  stored: FactoryImprovementSettings
  workspaceScope?: ImprovementScope[]
  isWorkspace?: boolean
  pending: boolean
  savedFor: (key: string) => boolean
  save: SavePolicy
}) {
  const id = useId()
  const inherit = isWorkspace ? 'Built-in default' : 'Use workspace default'
  const enabled = stored.enabled === undefined ? 'inherit' : stored.enabled ? 'on' : 'off'

  return (
    <SettingsCard title="Self-improvement">
      <FormRow label="Self-improvement runs" saved={savedFor('enabled')}>
        <PolicyChoice label="Self-improvement runs" value={enabled} disabled={pending}
          choices={[['inherit', inherit], ['on', 'Enabled'], ['off', 'Disabled']]}
          onChange={(value) => save({ enabled: value === 'inherit' ? null : value === 'on' })} />
      </FormRow>
      {counts.map(({ key, label, min, max }) => (
        <FormRow key={key} label={label} saved={savedFor(key)}>
          <IntegerStepper value={stored[key] ?? null} min={min} max={max} allowEmpty aria-label={label}
            placeholder={inherit} disabled={pending} onCommit={(value) => save({ [key]: value })} />
        </FormRow>
      ))}
      {dayFields.map(({ key, label }) => (
        <FormRow key={key} label={label} htmlFor={id + key} saved={savedFor(key)}>
          <Input key={stored[key] ?? 'inherit'} id={id + key} defaultValue={stored[key]} placeholder={inherit}
            inputMode="decimal" disabled={pending} className="w-44"
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
            onBlur={(event) => {
              const input = event.currentTarget
              const text = input.value.trim()
              const value = text === '' ? null : Number(text)
              if (value !== null && (!Number.isFinite(value) || value < 0 || value > 365)) {
                input.value = stored[key]?.toString() ?? ''
                toast('Enter a number of days from 0 to 365.', { tone: 'danger' })
              } else if (value !== (stored[key] ?? null)) save({ [key]: value })
            }} />
        </FormRow>
      ))}
      <FormRow label="Approval after review" saved={savedFor('approval')}>
        <PolicyChoice label="Approval after review" value={stored.approval ?? 'inherit'} disabled={pending}
          choices={[['inherit', inherit], ['manager', 'Project manager'], ['owner', 'Owner'], ['none', 'Automatic after review']]}
          onChange={(approval) => {
            if (approval === 'manager' || approval === 'owner' || approval === 'none') save({ approval })
            else save({ approval: null })
          }} />
      </FormRow>
      <FormRow label="Files improvements can change" saved={savedFor('scope')}>
        <div className="flex flex-col gap-2 text-ui">
          <label className="flex items-center gap-2">
            <Switch checked={!stored.scope} disabled={pending}
              onCheckedChange={(checked) => save({ scope: checked ? null : workspaceScope ?? scopes.map(([scope]) => scope) })} />
            {inherit}
          </label>
          {stored.scope && scopes.map(([scope, label]) => (
            <label key={scope} className="flex items-center gap-2">
              <Switch checked={stored.scope?.includes(scope)} disabled={pending} onCheckedChange={(checked) => {
                const selected = stored.scope ?? []
                save({ scope: checked ? [...selected, scope] : selected.filter((entry) => entry !== scope) })
              }} />
              {label}
            </label>
          ))}
        </div>
      </FormRow>
    </SettingsCard>
  )
}

export function ProjectImprovementCard({ stored = {} }: { stored?: FactoryImprovementSettings }) {
  const workspaceScope = useWorkspaceConfig().data?.factory?.improvement.scope
  const update = useConfigSave()
  const { savedFor, markSaved } = useSavedKeys()
  return <ImprovementForm stored={stored} workspaceScope={workspaceScope} pending={update.isPending} savedFor={savedFor}
    save={(improvement) => update.mutate({ factory: { improvement } }, {
      onSuccess: () => markSaved(Object.keys(improvement)[0] ?? null),
    })} />
}

export function WorkspaceImprovementCard() {
  const config = useWorkspaceConfig()
  const queryClient = useQueryClient()
  const { savedFor, markSaved } = useSavedKeys()
  const save = useMutation({
    mutationFn: (improvement: FactoryImprovementPatch) => putWorkspaceConfig({ factory: { improvement } }),
    onSuccess: (result, patch) => {
      queryClient.setQueryData(workspaceQueryKeys.config, result)
      markSaved(Object.keys(patch)[0] ?? null)
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  if (!config.data) return null
  return <ImprovementForm stored={config.data.factory?.improvement ?? {}} isWorkspace pending={save.isPending}
    savedFor={savedFor} save={save.mutate} />
}

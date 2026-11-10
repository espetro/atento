import { writable } from 'svelte/store'

export type SettingsSection = 'agent' | 'browsers' | 'sources' | 'schedule' | 'pairing' | 'server'

/** Groups render as eyebrow-labelled blocks in the settings sidebar. */
export const SETTINGS_GROUPS: { label: string; items: [SettingsSection, string][] }[] = [
  { label: 'Personal', items: [['agent', 'Agent']] },
  {
    label: 'Pipeline',
    items: [
      ['browsers', 'Browsers'],
      ['sources', 'Sources'],
      ['schedule', 'Schedule'],
    ],
  },
  {
    label: 'Connections',
    items: [
      ['pairing', 'Pairing'],
      ['server', 'Server'],
    ],
  },
]

/** Shared between the sidebar nav (AppSidebar) and the content (Settings). */
export const settingsSection = writable<SettingsSection>('agent')

import type { ReminderPreset } from '@/domain/reminders'
import type { ItemOutcome } from '@/google/apply'
import type { PlanItem, PlanStatus } from '@/google/plan'
import type { ThemeChoice } from '@/ui/useTheme'

export const COPY = {
  appName: 'Day Marker',
  tagline: 'Put your milestones on the calendar.',
  navLabel: 'Sections',
  navNew: 'New',
  navRegistrations: 'Registrations',
  themeLabel: (choice: ThemeChoice) =>
    choice === 'system'
      ? 'Theme: following your system'
      : choice === 'light'
        ? 'Theme: light'
        : 'Theme: dark',
  themeAction: (next: ThemeChoice) =>
    next === 'system' ? 'Switch to system theme' : `Switch to ${next} theme`,
  registrationsTitle: 'Registrations',
  registrationsConnectPrompt:
    'Connect your Google account to see what Day Marker has registered.',

  notConnected: 'Not connected',
  connected: 'Connected',
  connect: 'Connect Google account',

  startDate: 'Start date',
  labelField: 'Label — optional',
  labelPlaceholder: 'Anna & Ben',
  range: 'Range',
  reminder: 'Reminder',
  yearsOption: (n: number) => (n === 1 ? '1 year' : `${n} years`),
  // Every string the user reads lives here, including these — `domain/reminders.ts`
  // owns the minute arithmetic, not the wording.
  reminderLabels: {
    none: 'No reminder',
    day1: '1 day before, 9:00 AM',
    day3: '3 days before, 9:00 AM',
    week1: '1 week before, 9:00 AM',
  } satisfies Record<ReminderPreset, string>,

  pickADate: 'Pick a start date to see your milestones.',
  milestoneCount: (n: number) => (n === 1 ? '1 milestone' : `${n} milestones`),
  selectedCount: (n: number) => `${n} selected`,
  probing: 'Checking your calendar…',

  statusNew: 'New',
  statusExists: 'Already added',
  statusDeleted: 'Deleted',
  statusPast: 'Past',
  statusUnknown: '—',

  nothingToDo: 'Nothing to add',
  alreadyUpToDate: 'Everything is already up to date',
  applying: 'Working…',
  progress: (done: number, total: number) => `${done} of ${total}`,
  queued: 'Queued',

  // Decorative, but it lives here so the "no literals in components" rule stays
  // absolute rather than requiring a judgement call about what counts as copy.
  celebration: '🎉',
  doneHeadline: (n: number) => (n === 1 ? '1 milestone' : `${n} milestones`),
  doneSubhead: 'added to your calendar',
  // Used when every result is 'skipped': nothing was written, because every
  // milestone was already correct. Reporting those as "added" would be a claim
  // about the user's calendar that the app knows to be false.
  unchangedSubhead: 'already on your calendar',
  andMore: (n: number) => `and ${n} more…`,
  viewInCalendar: 'View in Calendar ↗',
  startOver: 'Start over',

  partialHeadline: (ok: number, failed: number) => `${ok} added · ${failed} failed`,
  retryFailed: (n: number) => `Reconnect and finish the remaining ${n}`,

  scriptBlocked:
    'Google sign-in could not load. Check your network or any blocker, then reload.',
  popupBlocked: 'Your browser blocked the Google window. Allow popups for this site and try again.',
  missingClientId:
    'VITE_GOOGLE_CLIENT_ID is not set. Copy .env.local.example to .env.local and add your client ID.',
} as const

export interface PlanCounts {
  add: number
  update: number
  restore: number
  selected: number
}

export function countPlan(items: PlanItem[]): PlanCounts {
  const counts: PlanCounts = { add: 0, update: 0, restore: 0, selected: 0 }
  for (const item of items) {
    if (!item.selected) continue
    counts.selected += 1
    if (item.status === 'new') counts.add += 1
    else if (item.status === 'deleted') counts.restore += 1
    else if (item.needsUpdate) counts.update += 1
  }
  return counts
}

export function actionLabel(counts: PlanCounts): string {
  const parts: string[] = []
  if (counts.add > 0) parts.push(`Add ${counts.add}`)
  if (counts.update > 0) parts.push(`Update ${counts.update}`)
  if (counts.restore > 0) parts.push(`Restore ${counts.restore}`)
  if (parts.length > 0) return parts.join(' · ')
  return counts.selected > 0 ? COPY.alreadyUpToDate : COPY.nothingToDo
}

const OUTCOME_LABELS: Record<ItemOutcome, string> = {
  added: 'Added',
  updated: 'Updated',
  restored: 'Restored',
  skipped: 'Unchanged',
  failed: 'Failed',
}

export function outcomeLabel(outcome: ItemOutcome): string {
  return OUTCOME_LABELS[outcome]
}

const STATUS_LABELS: Record<PlanStatus, string> = {
  new: COPY.statusNew,
  exists: COPY.statusExists,
  deleted: COPY.statusDeleted,
}

export function statusLabel(item: PlanItem): string {
  return item.past ? COPY.statusPast : STATUS_LABELS[item.status]
}

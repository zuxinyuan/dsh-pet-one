/**
 * Goals — long-term goals for the pet panel.
 *
 * This is the panel-local counterpart of Muse's Goals tab, and it
 * is deliberately separate from the pet's daily quests in
 * progress.js: quests are today's pet tasks, goals are user-owned
 * outcomes with a progress percentage and an optional target date.
 * Goals are plain data in the pet store (never in botharness.db).
 * @module dsh-pet-one/host/goals
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
export const GOAL_STATUSES = ['active', 'done', 'paused']

function clean(value, max) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, max)
}

/** One clearly-labelled example, so the tab is never empty and never pretends to be a real user goal. */
export function seedGoals() {
  return [
    {
      id: 'goal-example',
      title: '示例目标：每天读一点',
      detail: '这是一个示例，删掉它并换成你自己的目标。',
      targetDate: null,
      progress: 0,
      status: 'active',
      createdAt: Date.parse('2026-10-24T00:00:00Z'),
    },
  ]
}

/** Normalize one raw goal. Returns null when title is missing. */
export function normalizeGoal(input) {
  if (input === null || typeof input !== 'object') return null
  const title = clean(input.title, 200)
  if (title === '') return null
  const targetDate = clean(input.targetDate, 10)
  const progress = Number(input.progress)
  return {
    id: clean(input.id, 128) || `goal-${Number(input.createdAt) || Date.now()}`,
    title,
    detail: clean(input.detail, 2000),
    targetDate: DATE_RE.test(targetDate) ? targetDate : null,
    progress: Number.isFinite(progress) ? Math.min(100, Math.max(0, Math.floor(progress))) : 0,
    status: GOAL_STATUSES.includes(input.status) ? input.status : 'active',
    createdAt: Number(input.createdAt) || Date.now(),
  }
}

/** Sort newest first, cap at 100 goals (panel list, not an archive). */
export function normalizeGoals(input) {
  if (!Array.isArray(input)) return []
  return input
    .map(normalizeGoal)
    .filter((goal) => goal !== null)
    .sort((a, b) => (b.createdAt - a.createdAt) || String(b.id).localeCompare(String(a.id)))
    .slice(0, 100)
}

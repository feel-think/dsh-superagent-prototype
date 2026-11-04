/**
 * A small five-field cron parser and next-run calculator.
 *
 * Fields are `minute hour day-of-month month day-of-week`, numbers only, with
 * `*`, `a`, `a-b`, `a,b`, and an optional `/step`. Day-of-week accepts 0-7,
 * where both 0 and 7 are Sunday. When both day-of-month and day-of-week are
 * restricted they are ORed, as Vixie cron does. Times use the process's local
 * timezone; the deployment runs in Asia/Shanghai.
 */

export interface CronSpec {
  minutes: Set<number>
  hours: Set<number>
  days: Set<number>
  months: Set<number>
  weekdays: Set<number>
  daysRestricted: boolean
  weekdaysRestricted: boolean
}

interface FieldOptions {
  min: number
  max: number
  /** Normalize a parsed value, e.g. Sunday 7 to 0. */
  normalize?: (value: number) => number
}

function parseNumber(text: string, options: FieldOptions, field: string): number {
  if (!/^\d+$/.test(text)) throw new Error(`${field} must contain numbers, got "${text}"`)
  const value = Number(text)
  if (value < options.min || value > options.max) {
    throw new Error(`${field} must be between ${options.min} and ${options.max}`)
  }
  return value
}

function parseField(text: string, options: FieldOptions, field: string): { values: Set<number>; restricted: boolean } {
  const values = new Set<number>()
  let restricted = false
  const add = (value: number): void => { values.add(options.normalize ? options.normalize(value) : value) }
  for (const part of text.split(',')) {
    if (part === '') throw new Error(`${field} has an empty item`)
    if (part === '*' || part === '?') {
      for (let value = options.min; value <= options.max; value++) add(value)
      continue
    }
    restricted = true
    const pieces = part.split('/')
    if (pieces.length > 2) throw new Error(`${field} has an invalid step in "${part}"`)
    const range = pieces[0] as string
    const stepText = pieces[1]
    const step = stepText === undefined ? 1 : parseNumber(stepText, { min: 1, max: options.max }, `${field} step`)
    if (range === '*') {
      for (let value = options.min; value <= options.max; value += step) add(value)
      continue
    }
    if (range.includes('-')) {
      const [fromText, toText, rest] = range.split('-')
      if (rest !== undefined || fromText === undefined || toText === undefined) {
        throw new Error(`${field} has an invalid range "${part}"`)
      }
      const from = parseNumber(fromText, options, field)
      const to = parseNumber(toText, options, field)
      if (from > to) throw new Error(`${field} has a reversed range "${part}"`)
      for (let value = from; value <= to; value += step) add(value)
      continue
    }
    const value = parseNumber(range, options, field)
    if (stepText === undefined) add(value)
    else for (let next = value; next <= options.max; next += step) add(next)
  }
  return { values, restricted }
}

/** Parse a five-field cron expression; throws an Error with a human-readable reason. */
export function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error('cron must have five fields: minute hour day-of-month month day-of-week')
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string]
  const minutes = parseField(minute, { min: 0, max: 59 }, 'minute')
  const hours = parseField(hour, { min: 0, max: 23 }, 'hour')
  const days = parseField(day, { min: 1, max: 31 }, 'day-of-month')
  const months = parseField(month, { min: 1, max: 12 }, 'month')
  const weekdays = parseField(weekday, { min: 0, max: 7, normalize: value => value === 7 ? 0 : value }, 'day-of-week')
  return {
    minutes: minutes.values, hours: hours.values, days: days.values, months: months.values, weekdays: weekdays.values,
    daysRestricted: days.restricted, weekdaysRestricted: weekdays.restricted,
  }
}

/** Return a human-readable error, or null when the expression is valid. */
export function cronProblem(expression: string): string | null {
  try { parseCron(expression); return null } catch (error) { return error instanceof Error ? error.message : String(error) }
}

function dayMatches(spec: CronSpec, date: Date): boolean {
  const day = spec.days.has(date.getDate())
  const weekday = spec.weekdays.has(date.getDay())
  if (spec.daysRestricted && spec.weekdaysRestricted) return day || weekday
  if (spec.daysRestricted) return day
  if (spec.weekdaysRestricted) return weekday
  return true
}

/** Whether `date` falls on a scheduled minute (seconds are ignored). */
export function cronMatches(spec: CronSpec, date: Date): boolean {
  return spec.months.has(date.getMonth() + 1) && dayMatches(spec, date)
    && spec.hours.has(date.getHours()) && spec.minutes.has(date.getMinutes())
}

/**
 * The first scheduled minute strictly after `after`, or null when none occurs
 * within six years. Month, day, hour and minute jumps keep the search small.
 */
export function nextRun(spec: CronSpec, after: Date): Date | null {
  const date = new Date(after.getTime())
  date.setSeconds(0, 0)
  date.setMinutes(date.getMinutes() + 1)
  // 6 years of minute jumps is well above the longest normal cron gap (Feb 29).
  for (let guard = 0; guard < 6 * 366 * 24 * 60; guard++) {
    if (!spec.months.has(date.getMonth() + 1)) {
      date.setMonth(date.getMonth() + 1, 1)
      date.setHours(0, 0, 0, 0)
      continue
    }
    if (!dayMatches(spec, date)) {
      date.setDate(date.getDate() + 1)
      date.setHours(0, 0, 0, 0)
      continue
    }
    if (!spec.hours.has(date.getHours())) {
      date.setHours(date.getHours() + 1, 0, 0, 0)
      continue
    }
    if (!spec.minutes.has(date.getMinutes())) {
      date.setMinutes(date.getMinutes() + 1)
      continue
    }
    return date
  }
  return null
}

/** `nextRun` from an expression, returning epoch milliseconds or null. */
export function nextRunAt(expression: string, after: Date): number | null {
  const next = nextRun(parseCron(expression), after)
  return next ? next.getTime() : null
}

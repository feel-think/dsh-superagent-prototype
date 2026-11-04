import { describe, expect, it } from 'vitest'
import { cronMatches, cronProblem, nextRun, nextRunAt, parseCron } from '../src/cron.ts'

const at = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0): Date =>
  new Date(year, month - 1, day, hour, minute, second)

describe('cron parsing', () => {
  it('parses the common five-field examples', () => {
    expect(() => parseCron('0 9 * * *')).not.toThrow()
    expect(() => parseCron('0 */2 * * *')).not.toThrow()
    expect(() => parseCron('0 20 * * 0')).not.toThrow()
    expect(() => parseCron('5,10-20/2 1-5 * 1,6,12 1-5')).not.toThrow()
  })

  it('rejects malformed expressions', () => {
    for (const bad of ['', '0 9 * *', '60 9 * * *', '0 24 * * *', 'a 9 * * *', '0 9 0 * *', '10-5 9 * * *', '*/0 9 * * *', '0 9 * * 8']) {
      expect(cronProblem(bad), bad).not.toBeNull()
    }
  })

  it('treats Sunday as both 0 and 7', () => {
    const sunday = at(2026, 11, 8, 9, 0)
    expect(cronMatches(parseCron('0 9 * * 0'), sunday)).toBe(true)
    expect(cronMatches(parseCron('0 9 * * 7'), sunday)).toBe(true)
  })

  it('ORs a restricted day-of-month with a restricted day-of-week', () => {
    const spec = parseCron('0 0 13 * 5')
    // 2026-11-06 is a Friday but not the 13th; 2026-11-13 is a Friday and the 13th.
    expect(cronMatches(spec, at(2026, 11, 6))).toBe(true)
    expect(cronMatches(spec, at(2026, 11, 10))).toBe(false)
    expect(nextRun(spec, at(2026, 11, 4))).toEqual(at(2026, 11, 6))
  })
})

describe('next run', () => {
  it('finds the next daily minute', () => {
    expect(nextRunAt('0 9 * * *', at(2026, 11, 4, 8, 0))).toBe(at(2026, 11, 4, 9, 0).getTime())
    expect(nextRunAt('0 9 * * *', at(2026, 11, 4, 9, 0))).toBe(at(2026, 11, 5, 9, 0).getTime())
    expect(nextRunAt('0 9 * * *', at(2026, 11, 4, 9, 0, 30))).toBe(at(2026, 11, 5, 9, 0).getTime())
  })

  it('finds a step minute inside the hour', () => {
    expect(nextRunAt('*/15 * * * *', at(2026, 11, 4, 9, 7))).toBe(at(2026, 11, 4, 9, 15).getTime())
  })

  it('handles a weekday', () => {
    // 2026-11-04 is a Wednesday; the next Sunday 20:00 is 2026-11-08.
    expect(nextRunAt('0 20 * * 0', at(2026, 11, 4, 9, 0))).toBe(at(2026, 11, 8, 20, 0).getTime())
  })

  it('handles a leap day', () => {
    expect(nextRunAt('0 0 29 2 *', at(2026, 11, 4, 9, 0))).toBe(at(2028, 2, 29).getTime())
  })
})

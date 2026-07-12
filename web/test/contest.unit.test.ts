import { describe, expect, it } from 'vitest'

import {
  CONTEST_END_MS,
  CONTEST_START_MS,
  NOMINATION_END_MS,
  competitionFeatured,
} from '../src/lib/contest'

/**
 * Pins the date-driven auto-drop of the "Competition" nav link + banner.
 * competitionFeatured() must be true while either contest is live/upcoming
 * and false once both are over.
 */
describe('competitionFeatured', () => {
  it('is featured while the nomination contest is live', () => {
    expect(competitionFeatured(NOMINATION_END_MS - 1)).toBe(true)
  })

  it('is featured while the referral contest is live', () => {
    expect(competitionFeatured(CONTEST_START_MS + 1)).toBe(true)
    expect(competitionFeatured(CONTEST_END_MS - 1)).toBe(true)
  })

  it('auto-drops once the referral contest has ended', () => {
    expect(competitionFeatured(CONTEST_END_MS)).toBe(false)
    expect(competitionFeatured(CONTEST_END_MS + 1)).toBe(false)
  })
})

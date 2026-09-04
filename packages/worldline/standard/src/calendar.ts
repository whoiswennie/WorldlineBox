import type { JsonObject, JsonValue } from './model.ts'

/** One deterministic projection of the world's authored calendar at a logical instant. */
export interface AuthoredCalendarProjection {
  readonly secondsPerDay: number
  readonly daysPerSeason: number
  readonly seasons: readonly string[]
  readonly startDayIndex: number
  readonly startClockMinute: number
  readonly startYear: number
  readonly startSeason: string
  readonly startDayOfSeason: number
  readonly elapsedDays: number
  readonly absoluteDay: number
  readonly year: number
  readonly season: string
  readonly dayOfSeason: number
  readonly timeOfDaySeconds: number
  readonly hour: number
  readonly minute: number
}

function object(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function finiteNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function positiveInteger(value: JsonValue | undefined): number | undefined {
  const number = finiteNumber(value)
  return number === undefined || !Number.isInteger(number) || number < 1 ? undefined : number
}

function nonEmptyText(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor
}

/**
 * Project an authored calendar without inventing a Gregorian/default start.
 *
 * `startDayIndex` remains the deterministic absolute runtime anchor. Authors may also
 * name the visible starting year/season/day either explicitly in `calendar.start*`
 * or through the initial `world.year/season/day` fields. The latter are promoted to
 * stable calendar anchors on the first runtime advance.
 */
export function projectAuthoredCalendar(
  state: JsonObject,
  logicalTime: number,
): AuthoredCalendarProjection | undefined {
  const world = object(state['world'])
  const calendar = object(world?.['calendar'])
  if (calendar === undefined) return undefined

  const secondsPerDay = finiteNumber(calendar['secondsPerDay'])
  const daysPerSeason = positiveInteger(calendar['daysPerSeason'])
  const startDayIndex = positiveInteger(calendar['startDayIndex'])
  const startClockMinute = finiteNumber(calendar['startClockMinute'])
  const seasons = Array.isArray(calendar['seasons'])
    ? calendar['seasons'].filter((item): item is string => (
      typeof item === 'string' && item.trim() !== ''
    )).map(item => item.trim())
    : []
  if (secondsPerDay === undefined || secondsPerDay <= 0
    || daysPerSeason === undefined || startDayIndex === undefined
    || startClockMinute === undefined || startClockMinute < 0 || startClockMinute >= 1_440
    || seasons.length === 0) return undefined

  const yearLength = daysPerSeason * seasons.length
  const derivedStartAbsoluteDay = startDayIndex - 1
  const derivedStartYear = Math.floor(derivedStartAbsoluteDay / yearLength) + 1
  const derivedStartWithinYear = modulo(derivedStartAbsoluteDay, yearLength)
  const derivedStartSeasonIndex = Math.floor(derivedStartWithinYear / daysPerSeason)
  const derivedStartDayOfSeason = derivedStartWithinYear % daysPerSeason + 1

  const requestedStartSeason = nonEmptyText(calendar['startSeason'])
    ?? nonEmptyText(world?.['season'])
  const requestedStartSeasonIndex = requestedStartSeason === undefined
    ? -1 : seasons.indexOf(requestedStartSeason)
  const requestedStartDay = positiveInteger(calendar['startDayOfSeason'])
    ?? positiveInteger(world?.['day'])
  const hasNamedStart = requestedStartSeasonIndex >= 0
    && requestedStartDay !== undefined && requestedStartDay <= daysPerSeason
  const startSeasonIndex = hasNamedStart ? requestedStartSeasonIndex : derivedStartSeasonIndex
  const startDayOfSeason = hasNamedStart ? requestedStartDay : derivedStartDayOfSeason
  const startWithinYear = startSeasonIndex * daysPerSeason + startDayOfSeason - 1
  const startYear = positiveInteger(calendar['startYear'])
    ?? positiveInteger(world?.['year'])
    ?? derivedStartYear

  const elapsed = startClockMinute / 1_440 * secondsPerDay + logicalTime
  const elapsedDays = Math.floor(elapsed / secondsPerDay)
  const progressedWithinYear = startWithinYear + elapsedDays
  const projectedWithinYear = modulo(progressedWithinYear, yearLength)
  const year = startYear + Math.floor(progressedWithinYear / yearLength)
  const seasonIndex = Math.floor(projectedWithinYear / daysPerSeason)
  const dayOfSeason = projectedWithinYear % daysPerSeason + 1
  const timeOfDaySeconds = modulo(elapsed, secondsPerDay)
  const scaledSeconds = timeOfDaySeconds / secondsPerDay * 86_400

  return {
    secondsPerDay,
    daysPerSeason,
    seasons,
    startDayIndex,
    startClockMinute,
    startYear,
    startSeason: seasons[startSeasonIndex] ?? seasons[0] ?? '',
    startDayOfSeason,
    elapsedDays,
    absoluteDay: derivedStartAbsoluteDay + elapsedDays,
    year,
    season: seasons[seasonIndex] ?? seasons[0] ?? '',
    dayOfSeason,
    timeOfDaySeconds,
    hour: Math.floor(scaledSeconds / 3_600) % 24,
    minute: Math.floor(scaledSeconds % 3_600 / 60),
  }
}

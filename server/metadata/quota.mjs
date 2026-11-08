import { ScreenScraperError } from './screenscraper.mjs'
import { screenScraperLimits } from './screenscraper-policy.mjs'

export function screenScraperQuota(user) {
  const integer = value => (typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value)) && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null
  if (!user || typeof user !== 'object') throw new ScreenScraperError('quota_unknown')
  const fields = ['maxthreads', 'requeststoday', 'requestskotoday', 'maxrequestsperday', 'maxrequestskoperday']
  const values = Object.fromEntries(fields.map(key => [key, integer(user[key])]))
  const minute = ['maxrequestspermin', 'maxrequestsperdmin'].filter(key => Object.hasOwn(user, key)).map(key => integer(user[key]))
  if (Object.values(values).includes(null) || !minute.length || minute.includes(null) || values.requestskotoday > values.requeststoday) throw new ScreenScraperError('quota_unknown')
  const perMinute = Math.min(...minute)
  if (!values.maxthreads || !perMinute || values.requeststoday >= values.maxrequestsperday || values.requestskotoday >= values.maxrequestskoperday) throw new ScreenScraperError('quota_exhausted')
  return { remaining: values.maxrequestsperday - values.requeststoday, negativeRemaining: values.maxrequestskoperday - values.requestskotoday,
    intervalMs: Math.max(screenScraperLimits.minRequestIntervalMs, Math.ceil(60000 / perMinute)), checkedAt: Date.now() }
}

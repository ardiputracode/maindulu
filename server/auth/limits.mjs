export class AuthError extends Error {
  constructor(statusCode, message, retryAfter) {
    super(message)
    this.statusCode = statusCode
    this.retryAfter = retryAfter
  }
}

export function createLimiter(now = Date.now) {
  const buckets = new Map()
  let swept = 0
  return (key, limit, windowMs) => {
    const time = now()
    if (time - swept >= 60000) {
      for (const [key, bucket] of buckets) if (bucket.until <= time) buckets.delete(key)
      swept = time
    }
    let bucket = buckets.get(key)
    if (!bucket || bucket.until <= time) {
      if (buckets.size >= 5000 && !bucket) throw new AuthError(429, 'Server sedang sibuk. Coba lagi nanti.', 60)
      bucket = { count: 0, until: time + windowMs }
      buckets.set(key, bucket)
    }
    if (bucket.count >= limit) throw new AuthError(429, 'Terlalu banyak percobaan. Tunggu sebentar lalu coba lagi.', Math.max(1, Math.ceil((bucket.until - time) / 1000)))
    bucket.count++
  }
}

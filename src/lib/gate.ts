export type GateSession = { authenticated: boolean; expiresAt?: number }

export async function gateRequest(action: 'session' | 'login' | 'logout', body?: { username: string; password: string }, signal?: AbortSignal): Promise<GateSession> {
  let response: Response
  try {
    response = await fetch(`/api/gate/${action}`, {
      method: action === 'session' ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal,
      ...(action !== 'session' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) } : {}),
    })
  } catch { throw new Error('Pintu masuk belum bisa dibuka. Periksa koneksi, lalu coba lagi.') }
  if (!response.ok) {
    if (response.status === 401) throw new Error('Username atau password belum cocok. Coba lagi, ya.')
    if (response.status === 429) throw new Error('Terlalu banyak percobaan. Tunggu sebentar lalu coba lagi, ya.')
    throw new Error('Pintu masuk belum bisa dibuka. Periksa koneksi, lalu coba lagi.')
  }
  let value: unknown
  try { value = await response.json() }
  catch { throw new Error('Pintu masuk belum bisa diperiksa.') }
  if (!value || typeof value !== 'object' || !('authenticated' in value) || typeof value.authenticated !== 'boolean') throw new Error('Pintu masuk belum bisa diperiksa.')
  const expiresAt = 'expiresAt' in value ? value.expiresAt : undefined
  if (value.authenticated && (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= 0)) throw new Error('Pintu masuk belum bisa diperiksa.')
  return { authenticated: value.authenticated, ...(typeof expiresAt === 'number' ? { expiresAt } : {}) }
}

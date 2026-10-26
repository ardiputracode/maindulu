export type AccountUser = { id: string; username: string; role: 'user' | 'admin' }
export type AccountSession = { user: AccountUser | null; csrfToken: string | null; registrationOpen: boolean }

export function readRecoveryResult(value: unknown): { code: string; username: string } | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const username = v.username ?? (v.user && typeof v.user === 'object' ? (v.user as Record<string, unknown>).username : null)
  return typeof username === 'string' && /^[a-z0-9_]{3,24}$/.test(username) && typeof v.recoveryCode === 'string' && /^(?:[A-F0-9]{8}-){7}[A-F0-9]{8}$/.test(v.recoveryCode) ? { code: v.recoveryCode, username } : null
}

export function readAccountSession(value: unknown): AccountSession | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.registrationOpen !== 'boolean' || !(v.csrfToken === null || typeof v.csrfToken === 'string' && /^[a-f0-9]{64}$/.test(v.csrfToken))) return null
  if (v.user === null) return { user: null, csrfToken: v.csrfToken, registrationOpen: v.registrationOpen }
  if (!v.user || typeof v.user !== 'object' || !v.csrfToken) return null
  const user = v.user as Record<string, unknown>
  if (typeof user.id !== 'string' || !/^[a-f0-9-]{36}$/.test(user.id) || typeof user.username !== 'string' || !/^[a-z0-9_]{3,24}$/.test(user.username)) return null
  if (user.role !== 'user' && user.role !== 'admin') return null
  return { user: { id: user.id, username: user.username, role: user.role }, csrfToken: v.csrfToken, registrationOpen: v.registrationOpen }
}

export class AccountError extends Error {
  status: number
  constructor(message: string, status = 0) { super(message); this.status = status }
}

export type AccountState = {
  status: 'disabled' | 'checking' | 'anonymous' | 'authenticated' | 'unavailable';
  user: AccountUser | null; registrationOpen: boolean;
  error?: string;
}

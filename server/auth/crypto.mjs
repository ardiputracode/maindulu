import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const derive = promisify(scrypt)
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }
// Unknown usernames still perform the same KDF work as an existing account.
export const dummyHash = `scrypt$32768$8$3$${'00'.repeat(16)}$${'00'.repeat(64)}`

export function normalizeUsername(value) {
  if (typeof value !== 'string' || value.length > 64) return null
  const name = value.trim()
  return /^[a-zA-Z0-9_]{3,24}$/.test(name) ? name.toLowerCase() : null
}

export function validPassword(value) {
  return typeof value === 'string' && [...value].length >= 6 && [...value].length <= 128 && Buffer.byteLength(value) <= 512
}

export async function hashPassword(password) {
  const salt = randomBytes(16)
  const key = await derive(password, salt, 64, options)
  return `scrypt$32768$8$3$${salt.toString('hex')}$${key.toString('hex')}`
}

export async function verifyPassword(password, encoded) {
  const parts = encoded.split('$')
  if (parts.length !== 6 || parts.slice(0, 4).join('$') !== 'scrypt$32768$8$3' || !/^[0-9a-f]{32}$/.test(parts[4]) || !/^[0-9a-f]{128}$/.test(parts[5])) return false
  const key = await derive(password, Buffer.from(parts[4], 'hex'), 64, options)
  return timingSafeEqual(key, Buffer.from(parts[5], 'hex'))
}

export const randomToken = () => randomBytes(32).toString('hex')
export const hashToken = value => createHash('sha256').update(value).digest('hex')
export const csrfToken = sessionToken => createHmac('sha256', sessionToken).update('maindulu:csrf:v1').digest('hex')
export const recoveryCode = () => randomBytes(32).toString('hex').toUpperCase().match(/.{8}/g).join('-')
export const hashRecoveryCode = code => hashToken(code.replaceAll('-', '').toUpperCase())

export function normalizeRecoveryCode(value) {
  if (typeof value !== 'string' || value.length > 80) return null
  const code = value.trim()
  return /^(?:[a-f0-9]{64}|[a-f0-9]{8}(?:-[a-f0-9]{8}){7})$/i.test(code) ? code.replaceAll('-', '').toUpperCase() : null
}

export function equalToken(a, b) {
  return typeof a === 'string' && /^[a-f0-9]{64}$/.test(a) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

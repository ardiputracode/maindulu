import { transaction } from './auth/mutations.mjs'
import { AuthError, createLimiter } from './auth/limits.mjs'
import { protectRequest } from './auth/security.mjs'

const validGameId = /^[a-zA-Z0-9_-]{1,160}$/
const validConsoleId = /^[a-z0-9_-]{1,40}$/
const maxList = 100

function parseGame(value) {
  if (!value || typeof value !== 'object') throw new AuthError(400, 'Data game tidak valid.')
  const g = value
  if (typeof g.id !== 'string' || !validGameId.test(g.id)) throw new AuthError(400, 'ID game tidak valid.')
  if (g.source !== 'server') throw new AuthError(400, 'Hanya game server yang dapat disimpan ke akun.')
  if (typeof g.title !== 'string' || g.title.length < 1 || g.title.length > 200) throw new AuthError(400, 'Judul game tidak valid.')
  if (typeof g.consoleId !== 'string' || !validConsoleId.test(g.consoleId)) throw new AuthError(400, 'Console tidak valid.')
  return g
}

function toGame(row) {
  const data = JSON.parse(row.data)
  return {
    ...data,
    id: row.game_id,
    title: row.title,
    consoleId: row.console_id,
    source: row.source,
    ...(row.last_played !== undefined ? { lastPlayed: row.last_played } : {}),
  }
}

export function registerFavorites(app, config, security) {
  const db = app.database
  const consume = createLimiter()

  function owner(request) {
    const session = security.current(request)
    if (!session.user_id) throw new AuthError(401, 'Silakan masuk terlebih dahulu.')
    return session.user_id
  }

  app.register(async api => {
    api.addHook('onRequest', async request => {
      const types = request.method === 'DELETE' ? ['application/json', undefined] : ['application/json']
      protectRequest(request, config, security.current, types)
      const user = owner(request)
      consume('list:' + user, 120, 60000)
    })

    // --- Favorites ---
    api.get('/favorites', async (_request) => {
      const user = owner(_request)
      const rows = db.prepare('SELECT * FROM user_favorites WHERE user_id = ? ORDER BY created_at DESC, game_id LIMIT ?').all(user, maxList)
      return { favorites: rows.map(toGame) }
    })

    api.post('/favorites', async (request, reply) => {
      const user = owner(request)
      const game = parseGame(request.body?.game)
      return transaction(db, () => {
        owner(request)
        const existing = db.prepare('SELECT * FROM user_favorites WHERE user_id = ? AND game_id = ?').get(user, game.id)
        if (existing) {
          db.prepare('DELETE FROM user_favorites WHERE user_id = ? AND game_id = ?').run(user, game.id)
          return reply.code(200).send({ ok: true, added: false })
        }
        const count = db.prepare('SELECT COUNT(*) AS count FROM user_favorites WHERE user_id = ?').get(user).count
        if (count >= maxList) {
          throw new AuthError(409, 'Batas favorit akun tercapai. Hapus favorit lama sebelum menambahkan baru.')
        }
        db.prepare('INSERT INTO user_favorites (user_id, game_id, title, console_id, source, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(user, game.id, game.title, game.consoleId, game.source, JSON.stringify(game), Date.now())
        return reply.code(201).send({ ok: true, added: true })
      })
    })

    api.delete('/favorites/:gameId', async (request) => {
      const user = owner(request)
      const gameId = request.params.gameId
      if (!validGameId.test(gameId)) throw new AuthError(400, 'ID game tidak valid.')
      db.prepare('DELETE FROM user_favorites WHERE user_id = ? AND game_id = ?').run(user, gameId)
      return { ok: true }
    })

    // --- History ---
    api.get('/history', async (_request) => {
      const user = owner(_request)
      const rows = db.prepare('SELECT * FROM user_history WHERE user_id = ? ORDER BY last_played DESC, created_at DESC LIMIT ?').all(user, maxList)
      return { history: rows.map(toGame) }
    })

    api.post('/history', async (request, reply) => {
      const user = owner(request)
      const game = parseGame(request.body?.game)
      const now = Date.now()
      return transaction(db, () => {
        owner(request)
        const existing = db.prepare('SELECT * FROM user_history WHERE user_id = ? AND game_id = ?').get(user, game.id)
        if (existing) {
          db.prepare('UPDATE user_history SET title = ?, data = ?, last_played = ?, updated_at = ? WHERE user_id = ? AND game_id = ?')
            .run(game.title, JSON.stringify(game), now, now, user, game.id)
          return reply.code(200).send({ ok: true, added: false })
        }
        db.prepare('INSERT INTO user_history (user_id, game_id, title, console_id, source, data, last_played, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(user, game.id, game.title, game.consoleId, game.source, JSON.stringify(game), now, now, now)
        return reply.code(201).send({ ok: true, added: true })
      })
    })

    api.delete('/history/:gameId', async (request) => {
      const user = owner(request)
      const gameId = request.params.gameId
      if (!validGameId.test(gameId)) throw new AuthError(400, 'ID game tidak valid.')
      db.prepare('DELETE FROM user_history WHERE user_id = ? AND game_id = ?').run(user, gameId)
      return { ok: true }
    })

    api.delete('/history', async (request) => {
      const user = owner(request)
      db.prepare('DELETE FROM user_history WHERE user_id = ?').run(user)
      return { ok: true }
    })
  }, { prefix: '/api/me' })
}

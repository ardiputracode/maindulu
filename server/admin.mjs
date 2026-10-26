export function registerAdmin(app, security) {
  app.register(async admin => {
    admin.addHook('onRequest', async request => { security.protectAdmin(request) })
    // Access probe for this foundation milestone, not a catalog/upload API.
    admin.get('/status', async () => ({ ok: true }))
  }, { prefix: '/api/admin' })
}

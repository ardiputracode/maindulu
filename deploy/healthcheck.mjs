// Fixed internal port, independent of the public Host/Origin used by accounts.
// Exercise SQLite via health API, not only static HTML reachability.
try {
  const response = await fetch('http://127.0.0.1:7777/api/health', { signal: AbortSignal.timeout(4000), redirect: 'error' })
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error()
  const body = await response.json()
  if (body.service !== 'maindulu' || body.apiVersion !== 1 || body.status !== 'ok' || body.capabilities?.accounts !== true || body.capabilities?.serverSaves !== true || body.capabilities?.gameSaves !== true) throw new Error()
} catch {
  // No database paths, environment values or private response bodies in logs.
  process.stderr.write('Backend maindulu belum sehat.\n')
  process.exitCode = 1
}

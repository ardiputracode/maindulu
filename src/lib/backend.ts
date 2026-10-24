export type BackendHealth = {
  service: 'maindulu'; apiVersion: 1; status: 'ok';
  capabilities: { accounts: boolean; serverSaves: boolean };
}

export type BackendState =
  | { status: 'disabled' | 'checking' | 'unavailable' }
  | { status: 'online'; health: BackendHealth }

export function readBackendHealth(value: unknown): BackendHealth | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const capabilities = v.capabilities as Record<string, unknown> | null
  if (v.service !== 'maindulu' || v.apiVersion !== 1 || v.status !== 'ok' || !capabilities || typeof capabilities.accounts !== 'boolean' || typeof capabilities.serverSaves !== 'boolean') return null
  return { service: 'maindulu', apiVersion: 1, status: 'ok', capabilities: { accounts: capabilities.accounts, serverSaves: capabilities.serverSaves } }
}

export function backendConfigured(marker: string | null, buildEnabled: string | undefined) {
  return marker === 'enabled' || buildEnabled === 'true'
}

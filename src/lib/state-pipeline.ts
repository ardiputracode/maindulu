import { hashRom } from './identity.ts'
import { SaveError } from './saves.ts'
import type { SaveClient, SaveList, ServerSave, StateMetadata } from './saves.ts'

export type StateTarget = { gameId: string; consoleId: string; core: string; title: string }
export type StateSnapshot = { bytes: Uint8Array; checksum: string; slot: number; revision: number; metadata: StateMetadata }

export function findSlotSave(list: SaveList | null, target: StateTarget, slot: number): ServerSave | undefined {
  return list?.saves.find(save => save.gameId === target.gameId && save.consoleId === target.consoleId && save.core === target.core && save.slot === slot)
}

export async function makeStateSnapshot(bytes: Uint8Array, metadata: StateMetadata, slot: number, revision: number): Promise<StateSnapshot> {
  const checksum = await hashRom(new Blob([new Uint8Array(bytes)]))
  return { bytes, checksum, slot, revision, metadata }
}

// The API response is the commit proof. Callers must not turn a later list
// refresh failure into a "not saved" result and upload again.
export async function putStateSnapshot(client: SaveClient, maxStateBytes: number, target: StateTarget, snapshot: StateSnapshot): Promise<ServerSave> {
  if (snapshot.bytes.length > maxStateBytes) throw new SaveError(`State melebihi batas ${Math.floor(maxStateBytes / 1024 / 1024)} MiB. Unduh cadangan atau hubungi pengelola.`)
  return client.put(snapshot.bytes, {
    gameId: target.gameId,
    title: target.title,
    consoleId: target.consoleId,
    core: target.core,
    slot: snapshot.slot,
    expectedRevision: snapshot.revision,
    checksum: snapshot.checksum,
    metadata: snapshot.metadata
  })
}

// A timeout/conflict can leave the commit outcome unknown. Reading the list
// resolves it without bumping expectedRevision or overwriting a newer version.
export async function findCommittedSnapshot(client: SaveClient, target: StateTarget, snapshot: StateSnapshot): Promise<ServerSave | null> {
  try {
    const list = await client.list()
    const save = findSlotSave(list, target, snapshot.slot)
    return save && !save.deleted && save.checksum === snapshot.checksum && save.size === snapshot.bytes.length ? save : null
  } catch {
    return null
  }
}

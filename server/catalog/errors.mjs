import { AuthError } from '../auth/limits.mjs'

export class CatalogHttpError extends AuthError {
  constructor(status, code, message) { super(status, message); this.code = code }
}
export const invalidCatalog = (message = 'Metadata atau berkas katalog tidak valid.') => new CatalogHttpError(400, 'INVALID_CATALOG', message)

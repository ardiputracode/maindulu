// Build-time emergency brake, independent of the per-profile IDB preference.
// Do not rewrite settings or delete data: a normal build must restore the user's
// choice. Undefined in direct Node/test bundles means the feature is available.
export const ASSET_CACHE_DISABLED = typeof __ASSET_CACHE_DISABLED__ !== 'undefined' && __ASSET_CACHE_DISABLED__
export const ASSET_CACHE_DISABLED_NOTICE = 'Cache ROM/BIOS dinonaktifkan oleh build aplikasi ini. Aset dimuat melalui jalur biasa; data cache dan save/progres tidak dihapus.'

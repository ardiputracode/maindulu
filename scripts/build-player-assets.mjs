import { build } from 'esbuild'

// Application helper only: never vendor/patch the engine or its fingerprint.
await build({ entryPoints: ['src/lib/player-bridge-assets.ts'], bundle: true,
  outfile: 'public/player/asset-helpers.js', format: 'iife', globalName: 'MainduluAssets',
  target: 'es2022', platform: 'browser', legalComments: 'none', charset: 'utf8' })

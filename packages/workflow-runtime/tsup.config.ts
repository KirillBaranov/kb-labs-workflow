import { defineConfig } from 'tsup'
import nodePreset from '@kb-labs/devkit/tsup/node.js'

export default defineConfig({
  ...nodePreset,
  dts: false, // Temporarily disable DTS due to type incompatibility with execute/executePlugin
  tsconfig: "tsconfig.build.json", // Use build-specific tsconfig without paths
  entry: {
    index: 'src/index.ts',
  },
  external: [
    ...(nodePreset.external || []),
    'fast-glob',
  ],
})

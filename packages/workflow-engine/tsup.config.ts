import { defineConfig } from 'tsup'
import nodePreset from '@kb-labs/devkit/tsup/node.js'

export default defineConfig({
  ...nodePreset,
  tsconfig: "tsconfig.build.json", // Use build-specific tsconfig without paths
  dts: true, // Re-enabled after fixing JobRunnerPresenter UIFacade implementation and removing wrong IEventBus usage
  entry: {
    index: 'src/index.ts',
  },
})
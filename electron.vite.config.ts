
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: {
          'orb-preload': resolve(__dirname, 'src/preload/orb-preload.ts'),
          'recorder-preload': resolve(__dirname, 'src/preload/recorder-preload.ts'),
          'settings-preload': resolve(__dirname, 'src/preload/settings-preload.ts')
        }
      }
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    }
  },
  renderer: {
    root: 'src/renderer',
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: {
        input: {
          orb: resolve(__dirname, 'src/renderer/orb/index.html'),
          recorder: resolve(__dirname, 'src/renderer/recorder/index.html'),
          settings: resolve(__dirname, 'src/renderer/settings/index.html')
        }
      }
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    }
  }
})


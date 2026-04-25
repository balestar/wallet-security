import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
  server: {
    proxy: {
      // Proxy /api/goplus → GoPlus API so the browser avoids CORS/rate-limit issues.
      '/api/goplus': {
        target: 'https://api.gopluslabs.io',
        changeOrigin: true,
        rewrite: path => {
          // /api/goplus?address=0xABC&chainId=1 → /api/v1/address_security/0xABC?chain_id=1
          const url = new URL(path, 'http://x')
          const address = url.searchParams.get('address') ?? ''
          const chainId = url.searchParams.get('chainId') ?? ''
          return `/api/v1/address_security/${address}?chain_id=${chainId}`
        },
      },
    },
  },
  preview: {
    proxy: {
      '/api/goplus': {
        target: 'https://api.gopluslabs.io',
        changeOrigin: true,
        rewrite: path => {
          const url = new URL(path, 'http://x')
          const address = url.searchParams.get('address') ?? ''
          const chainId = url.searchParams.get('chainId') ?? ''
          return `/api/v1/address_security/${address}?chain_id=${chainId}`
        },
      },
    },
  },
})

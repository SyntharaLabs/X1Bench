const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Connection, PublicKey } = require('@solana/web3.js');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname));

// ── X1 RPCs ──
const RPCS = {
  mainnet: process.env.X1_RPC || 'https://rpc.mainnet.x1.xyz',
  testnet: process.env.X1_TESTNET_RPC || 'https://xolana.xen.network',
};
const EXPLORER_BASES = {
  mainnet: 'https://explorer.mainnet.x1.xyz',
  testnet: 'https://explorer.mainnet.x1.xyz', // append ?cluster=testnet if supported
};

function getConn(network) {
  const rpc = RPCS[network] || RPCS.mainnet;
  return new Connection(rpc, 'confirmed');
}
// Default for backwards compat
let conn = getConn('mainnet');
let X1_RPC = RPCS.mainnet;

// ── Fast account existence probe (raw fetch, 8s timeout) ──
async function probeAccountExists(rpcUrl, addressStr) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
        params: [addressStr, { encoding: 'base64' }],
      }),
      signal: controller.signal,
    });
    const json = await resp.json();
    return json?.result?.value != null; // null value = account doesn't exist
  } catch { return false; }
  finally { clearTimeout(timer); }
}

// ── Constants ──
const BPF_LOADER_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const BPF_LOADER_2 = 'BPFLoader2111111111111111111111111111111111';
const NATIVE_LOADER = new PublicKey('NativeLoader1111111111111111111111111111111');
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const VOTE_PROGRAM = 'Vote111111111111111111111111111111111111111';

// ── Validator Cache ──
let validatorCache = { data: null, fetched: 0 };
const VALIDATOR_CACHE_TTL = 5 * 60 * 1000; // 5 min

async function getValidators() {
  if (validatorCache.data && Date.now() - validatorCache.fetched < VALIDATOR_CACHE_TTL) return validatorCache.data;
  try {
    const res = await conn.getVoteAccounts();
    const all = [...(res.current || []), ...(res.delinquent || [])];
    const map = {};
    for (const v of all) {
      const isActive = res.current?.includes(v);
      const entry = {
        votePubkey: v.votePubkey,
        nodePubkey: v.nodePubkey,
        activatedStake: v.activatedStake / 1e9,
        commission: v.commission,
        lastVote: v.lastVote,
        rootSlot: v.rootSlot,
        epochCredits: v.epochCredits,
        status: isActive ? 'active' : 'delinquent',
      };
      map[v.votePubkey] = entry;
      map[v.nodePubkey] = entry;
    }
    validatorCache = { data: { map, totalActive: res.current?.length || 0, totalDelinquent: res.delinquent?.length || 0 }, fetched: Date.now() };
    return validatorCache.data;
  } catch { return null; }
}

// ── Helpers ──

function readU32(buf, offset) {
  return buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24);
}

async function getProgramDataAddress(programPk) {
  try {
    const info = await conn.getAccountInfo(programPk);
    if (!info) return null;
    if (info.owner.equals(BPF_LOADER_UPGRADEABLE) && info.data.length >= 36) {
      const tag = readU32(info.data, 0);
      if (tag === 2) return new PublicKey(info.data.slice(4, 36));
    }
    return null;
  } catch { return null; }
}

async function getUpgradeAuthority(programDataPk) {
  try {
    const info = await conn.getAccountInfo(programDataPk);
    if (!info || info.data.length < 45) return { authority: null, frozen: false };
    const tag = readU32(info.data, 0);
    if (tag !== 3) return { authority: null, frozen: false };
    const hasAuthority = info.data[12];
    if (hasAuthority === 1) {
      return { authority: new PublicKey(info.data.slice(13, 45)).toBase58(), frozen: false };
    }
    return { authority: null, frozen: true };
  } catch { return { authority: null, frozen: false }; }
}

async function fetchIdl(programPk) {
  try {
    const [idlPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('anchor:idl'), programPk.toBuffer()],
      programPk
    );
    const acct = await conn.getAccountInfo(idlPda);
    if (!acct) return { found: false };
    const data = Buffer.from(acct.data);
    if (data.length < 12) return { found: false };
    const jsonLen = data.readUInt32LE(8);
    const idl = JSON.parse(data.slice(12, 12 + jsonLen).toString());
    return { found: true, idl };
  } catch { return { found: false }; }
}

// Fetch Metaplex token metadata
async function fetchTokenMetadata(mintPk) {
  try {
    const [metaPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('metadata'), METADATA_PROGRAM.toBuffer(), mintPk.toBuffer()],
      METADATA_PROGRAM
    );
    const acct = await conn.getAccountInfo(metaPda);
    if (!acct) return null;

    const data = acct.data;
    // Metaplex metadata v1 layout: key(1) + updateAuthority(32) + mint(32) + name(4+str) + symbol(4+str) + uri(4+str)
    let offset = 1 + 32 + 32; // skip key + updateAuth + mint
    
    const nameLen = data.readUInt32LE(offset); offset += 4;
    const name = data.slice(offset, offset + nameLen).toString('utf8').replace(/\0/g, '').trim();
    offset += nameLen;

    const symbolLen = data.readUInt32LE(offset); offset += 4;
    const symbol = data.slice(offset, offset + symbolLen).toString('utf8').replace(/\0/g, '').trim();
    offset += symbolLen;

    const uriLen = data.readUInt32LE(offset); offset += 4;
    const uri = data.slice(offset, offset + uriLen).toString('utf8').replace(/\0/g, '').trim();

    const updateAuthority = new PublicKey(data.slice(1, 33)).toBase58();

    return { name, symbol, uri, updateAuthority };
  } catch { return null; }
}

// Get largest token holders
async function getTokenHolders(mintStr) {
  try {
    const result = await conn.getTokenLargestAccounts(new PublicKey(mintStr));
    return result.value || [];
  } catch { return []; }
}

// Get token supply (already parsed from getAccountInfo but this is more precise)
async function getTokenSupply(mintStr) {
  try {
    const result = await conn.getTokenSupply(new PublicKey(mintStr));
    return result.value;
  } catch { return null; }
}

// ── Transaction decode ──

// Known programs on X1
const KNOWN_PROGRAMS = {
  '11111111111111111111111111111111': { name: 'System Program', desc: 'Core X1 system program — handles account creation, transfers, and basic operations.', category: 'system' },
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA': { name: 'Token Program', desc: 'Standard SPL Token program — manages all fungible and non-fungible tokens on X1.', category: 'system' },
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb': { name: 'Token-2022', desc: 'Next-generation token program with extensions like transfer fees, interest, and metadata.', category: 'system' },
  'ComputeBudget111111111111111111111111111111': { name: 'Compute Budget', desc: 'Sets priority fees and compute limits for transactions.', category: 'system' },
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL': { name: 'Associated Token Account', desc: 'Creates deterministic token accounts so wallets can receive tokens automatically.', category: 'system' },
  'Vote111111111111111111111111111111111111111': { name: 'Vote Program', desc: 'Manages validator voting and consensus participation.', category: 'system' },
  'Stake11111111111111111111111111111111111111': { name: 'Stake Program', desc: 'Handles staking XNT to validators for network security and rewards.', category: 'system' },
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr': { name: 'Memo Program', desc: 'Attaches text memos to transactions — like a note on a bank transfer.', category: 'utility' },
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s': { name: 'Metaplex Token Metadata', desc: 'Stores names, symbols, and images for tokens and NFTs.', category: 'nft' },
  'namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX': { name: 'Name Service', desc: 'Maps human-readable names to on-chain addresses.', category: 'utility' },
  'BPFLoaderUpgradeab1e11111111111111111111111': { name: 'BPF Upgradeable Loader', desc: 'Deploys and upgrades programs on X1.', category: 'system' },
  'BPFLoader2111111111111111111111111111111111': { name: 'BPF Loader v2', desc: 'Legacy program loader — programs deployed here are permanently immutable.', category: 'system' },
  'NativeLoader1111111111111111111111111111111': { name: 'Native Loader', desc: 'Loads programs built directly into the X1 runtime.', category: 'system' },
};

// Helper to get program name (from known list, IDL, or shortened address)
function getProgramName(addr) {
  const known = KNOWN_PROGRAMS[addr];
  if (known) return known.name;
  return null;
}
function getProgramDesc(addr) {
  const known = KNOWN_PROGRAMS[addr];
  if (known) return known.desc;
  return null;
}
function progNameOrShort(addr) {
  return getProgramName(addr) || `${addr.slice(0,8)}…${addr.slice(-4)}`;
}

// Known instruction type descriptions
const IX_TYPE_DESC = {
  transfer: 'sent XNT',
  transferChecked: 'sent tokens',
  createAccount: 'created a new account',
  createAccountWithSeed: 'created a new account',
  closeAccount: 'closed a token account',
  initializeAccount: 'set up a token account',
  initializeAccount2: 'set up a token account',
  initializeAccount3: 'set up a token account',
  initializeMint: 'created a new token',
  initializeMint2: 'created a new token',
  mintTo: 'minted new tokens',
  mintToChecked: 'minted new tokens',
  burn: 'burned tokens',
  burnChecked: 'burned tokens',
  approve: 'approved a token allowance',
  revoke: 'revoked a token allowance',
  setAuthority: 'changed an authority',
  syncNative: 'synced wrapped XNT',
  freezeAccount: 'froze a token account',
  thawAccount: 'unfroze a token account',
  allocate: 'allocated space for an account',
  assign: 'assigned account ownership',
  createIdempotent: 'created a token account (if needed)',
};

// Well-known token mints
const KNOWN_MINTS = {
  'So11111111111111111111111111111111111111112': 'Wrapped XNT',
};

function shortAddr(addr) { return addr ? `${addr.slice(0,6)}…${addr.slice(-4)}` : '?'; }

function resolveUri(uri) {
  if (!uri) return null;
  if (uri.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + uri.slice(7);
  if (uri.startsWith('ar://')) return 'https://arweave.net/' + uri.slice(5);
  return uri;
}

async function scanTransaction(sig, network) {
  const EXPLORER = EXPLORER_BASES[network || 'mainnet'];
  const report = {
    type: 'transaction', signature: sig, network: 'X1 Mainnet', rpc: X1_RPC,
    timestamp: new Date().toISOString(), explorerUrl: `${EXPLORER}/tx/${sig}`,
    exists: false, tx: null, findings: [], risks: [], score: 0, story: null,
  };

  try {
    const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 });
    if (!tx) {
      report.findings.push({ title: 'Transaction not found', desc: 'This signature was not found on X1.', severity: 'fail' });
      return report;
    }

    report.exists = true;
    const meta = tx.meta, msg = tx.transaction.message;
    const blockTime = tx.blockTime ? new Date(tx.blockTime * 1000) : null;
    const fee = (meta?.fee || 0) / 1e9;
    const success = meta?.err === null;
    const signers = msg.accountKeys?.filter(a => a.signer).map(a => a.pubkey.toBase58()) || [];
    const programs = msg.instructions?.map(ix => ix.programId?.toBase58()).filter(Boolean) || [];
    const uniquePrograms = [...new Set(programs)].filter(p => p !== 'ComputeBudget111111111111111111111111111111');

    const allInstructions = [
      ...(msg.instructions || []),
      ...(meta?.innerInstructions?.flatMap(ii => ii.instructions) || []),
    ];
    const logs = meta?.logMessages || [];

    // Extract instruction names from logs
    const instructionNames = [];
    for (const log of logs) {
      const match = log.match(/Instruction: (\w+)/);
      if (match) instructionNames.push(match[1]);
    }

    // Parse transfers
    const transfers = [];
    const actions = []; // plain-English action descriptions

    for (const ix of allInstructions) {
      const parsed = ix.parsed;
      if (!parsed) continue;
      if (parsed.type === 'transfer' && parsed.info?.lamports) {
        const amt = parsed.info.lamports / 1e9;
        transfers.push({ type: 'XNT', from: parsed.info.source, to: parsed.info.destination, amount: amt, display: `${amt.toFixed(4)} XNT` });
      } else if ((parsed.type === 'transferChecked' || parsed.type === 'transfer') && parsed.info?.tokenAmount) {
        transfers.push({ type: 'token', mint: parsed.info.mint || 'unknown', from: parsed.info.source, to: parsed.info.destination, amount: parseFloat(parsed.info.tokenAmount.uiAmountString || '0'), display: `${parsed.info.tokenAmount.uiAmountString} tokens`, decimals: parsed.info.tokenAmount.decimals });
      }
      // Collect all parsed actions
      if (parsed.type && IX_TYPE_DESC[parsed.type]) {
        actions.push({ type: parsed.type, desc: IX_TYPE_DESC[parsed.type], info: parsed.info });
      }
    }

    const isSwap = logs.some(l => l.includes('Swap'));
    const isBurn = actions.some(a => a.type === 'burn' || a.type === 'burnChecked');
    const isMint = actions.some(a => a.type === 'mintTo' || a.type === 'mintToChecked');
    const isCreateAccount = actions.some(a => a.type === 'createAccount' || a.type === 'createAccountWithSeed');
    const isCloseAccount = actions.some(a => a.type === 'closeAccount');

    // Resolve token names for transfers
    const mintNames = {};
    for (const t of transfers.filter(t => t.type === 'token')) {
      if (t.mint && !mintNames[t.mint]) {
        if (KNOWN_MINTS[t.mint]) { mintNames[t.mint] = KNOWN_MINTS[t.mint]; continue; }
        try {
          const tokenMeta = await fetchTokenMetadata(new PublicKey(t.mint));
          if (tokenMeta) mintNames[t.mint] = tokenMeta.symbol || tokenMeta.name || null;
        } catch {}
      }
    }

    // Build plain-English story
    const signerShort = shortAddr(signers[0]);
    const timeStr = blockTime ? blockTime.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Unknown time';
    const storyParts = [];

    if (!success) {
      storyParts.push(`This transaction failed. The wallet ${signerShort} tried to do something but it didn't go through. No tokens or XNT were actually moved. The fee of ${fee.toFixed(4)} XNT was still charged.`);
    } else if (isSwap) {
      const tokenTx = transfers.filter(t => t.type === 'token');
      const xntTx = transfers.filter(t => t.type === 'XNT');
      if (tokenTx.length >= 2) {
        const from = mintNames[tokenTx[0].mint] || shortAddr(tokenTx[0].mint);
        const to = mintNames[tokenTx[1].mint] || shortAddr(tokenTx[1].mint);
        storyParts.push(`${signerShort} swapped ${tokenTx[0].display.replace('tokens', from)} for ${tokenTx[1].display.replace('tokens', to)}.`);
      } else if (xntTx.length > 0 && tokenTx.length > 0) {
        const tokenName = mintNames[tokenTx[0].mint] || shortAddr(tokenTx[0].mint);
        storyParts.push(`${signerShort} swapped ${xntTx[0].display} for ${tokenTx[0].display.replace('tokens', tokenName)}.`);
      } else {
        storyParts.push(`${signerShort} performed a token swap.`);
      }
      storyParts.push(`This is a trade — tokens were exchanged at the current market rate.`);
    } else if (transfers.length > 0 && !isSwap) {
      for (const t of transfers) {
        if (t.type === 'XNT') {
          const isSigner = t.from === signers[0];
          if (isSigner) storyParts.push(`${signerShort} sent ${t.display} to ${shortAddr(t.to)}.`);
          else storyParts.push(`${shortAddr(t.from)} sent ${t.display} to ${signerShort}.`);
        } else {
          const tokenName = mintNames[t.mint] || shortAddr(t.mint);
          const isSigner = t.from === signers[0] || actions.some(a => a.info?.authority === signers[0]);
          if (isSigner) storyParts.push(`${signerShort} sent ${t.amount} ${tokenName} to ${shortAddr(t.to)}.`);
          else storyParts.push(`${shortAddr(t.from)} sent ${t.amount} ${tokenName} to ${signerShort}.`);
        }
      }
    } else if (isBurn) {
      const burnAction = actions.find(a => a.type === 'burn' || a.type === 'burnChecked');
      const amt = burnAction?.info?.tokenAmount?.uiAmountString || burnAction?.info?.amount || '?';
      storyParts.push(`${signerShort} burned ${amt} tokens — permanently removing them from circulation.`);
    } else if (isMint) {
      const mintAction = actions.find(a => a.type === 'mintTo' || a.type === 'mintToChecked');
      const amt = mintAction?.info?.tokenAmount?.uiAmountString || mintAction?.info?.amount || '?';
      storyParts.push(`${signerShort} minted ${amt} new tokens into existence.`);
    } else if (instructionNames.length > 0) {
      // Program interaction — no transfers
      const ixName = instructionNames.filter(n => n !== 'ComputeBudgetInstruction')[0] || instructionNames[0];
      const progNames = uniquePrograms.map(p => KNOWN_PROGRAMS[p] || shortAddr(p));
      storyParts.push(`${signerShort} called "${ixName}" on ${progNames.join(' and ')}.`);
      storyParts.push(`This is a program interaction — no tokens or XNT were transferred. The wallet interacted with a smart contract on X1.`);
    } else if (isCreateAccount) {
      storyParts.push(`${signerShort} created a new account on X1.`);
    } else if (isCloseAccount) {
      storyParts.push(`${signerShort} closed a token account and reclaimed the rent deposit.`);
    } else {
      storyParts.push(`${signerShort} submitted a transaction on X1.`);
    }

    // Add time and cost context
    storyParts.push(`Happened on ${timeStr}. Cost: ${fee.toFixed(4)} XNT in fees.`);

    // Build a clean swap summary for the frontend (avoids first/last transfer ambiguity)
    if (isSwap) {
      const tokenTx = transfers.filter(t => t.type === 'token');
      const xntTx   = transfers.filter(t => t.type === 'XNT');
      const uniqueMints = [...new Set(tokenTx.map(t => t.mint).filter(m => m && m !== 'unknown'))];

      if (uniqueMints.length >= 2) {
        // Multi-token route: pick first two unique mints, use their max transfer amount
        const m1 = uniqueMints[0], m2 = uniqueMints[1];
        const amt1 = tokenTx.filter(t => t.mint === m1).reduce((mx, t) => Math.max(mx, t.amount), 0);
        const amt2 = tokenTx.filter(t => t.mint === m2).reduce((mx, t) => Math.max(mx, t.amount), 0);
        report.swapSummary = {
          from: { mint: m1, amount: amt1, name: mintNames[m1] || null },
          to:   { mint: m2, amount: amt2, name: mintNames[m2] || null },
        };
      } else if (xntTx.length > 0 && tokenTx.length > 0) {
        report.swapSummary = {
          from: { mint: 'XNT', amount: xntTx[0].amount, name: 'XNT' },
          to:   { mint: tokenTx[0].mint, amount: tokenTx[0].amount, name: mintNames[tokenTx[0].mint] || null },
        };
      } else if (uniqueMints.length === 1 && tokenTx.length >= 2) {
        // Same token in/out (arbitrage / rebate)
        const tFirst = tokenTx[0], tLast = tokenTx[tokenTx.length - 1];
        report.swapSummary = {
          from: { mint: tFirst.mint, amount: tFirst.amount, name: mintNames[tFirst.mint] || null },
          to:   { mint: tLast.mint,  amount: tLast.amount,  name: mintNames[tLast.mint]  || null },
          sameToken: true,
        };
      }
    }

    // ── Extract rich operation details for mint / burn / account ops ──
    if (isMint) {
      const a = actions.find(a => a.type === 'mintTo' || a.type === 'mintToChecked');
      if (a?.info) {
        const mintAddr = a.info.mint;
        let tName = mintNames[mintAddr] || null;
        if (!tName && mintAddr && mintAddr !== 'unknown') {
          try {
            const meta = await fetchTokenMetadata(new PublicKey(mintAddr));
            if (meta) { tName = meta.symbol || meta.name || null; mintNames[mintAddr] = tName; }
          } catch {}
        }
        report.mintDetails = {
          mint: mintAddr,
          tokenName: tName,
          recipient: a.info.account,
          authority: a.info.mintAuthority,
          amount: a.info.tokenAmount?.uiAmountString || a.info.amount,
          decimals: a.info.tokenAmount?.decimals ?? null,
        };
      }
    }
    if (isBurn) {
      const a = actions.find(a => a.type === 'burn' || a.type === 'burnChecked');
      if (a?.info) {
        const burnMint = a.info.mint;
        let tName = mintNames[burnMint] || null;
        if (!tName && burnMint && burnMint !== 'unknown') {
          try {
            const meta = await fetchTokenMetadata(new PublicKey(burnMint));
            if (meta) { tName = meta.symbol || meta.name || null; mintNames[burnMint] = tName; }
          } catch {}
        }
        report.burnDetails = {
          mint: burnMint,
          tokenName: tName,
          from: a.info.account,
          authority: a.info.authority,
          amount: a.info.tokenAmount?.uiAmountString || a.info.amount,
          decimals: a.info.tokenAmount?.decimals ?? null,
        };
      }
    }
    // Generic: extract ALL parsed instruction details for the on-chain breakdown
    const parsedOps = [];
    for (const ix of allInstructions) {
      const p = ix.parsed;
      if (!p?.type || p.type === 'transfer' || p.type === 'transferChecked') continue;
      if (IX_TYPE_DESC[p.type]) {
        parsedOps.push({ type: p.type, desc: IX_TYPE_DESC[p.type], info: p.info || {} });
      }
    }
    if (parsedOps.length) report.parsedOps = parsedOps;

    report.story = storyParts.join(' ');

    report.tx = {
      blockTime: blockTime?.toISOString() || null, slot: tx.slot, fee, success,
      signers, programs: uniquePrograms, transfers, isSwap,
      computeUnits: meta?.computeUnitsConsumed || 0,
      instructionNames,
      mintNames,
    };

    // ── Findings (now story-first) ──
    report.findings.push({
      title: success ? '✅ Transaction succeeded' : '❌ Transaction failed',
      desc: `${timeStr} · Slot ${tx.slot?.toLocaleString()}`,
      severity: success ? 'pass' : 'fail',
    });

    // What happened (the headline)
    if (isSwap) {
      const tokenTx = transfers.filter(t => t.type === 'token');
      const xntTx = transfers.filter(t => t.type === 'XNT');
      let swapTitle = '🔄 Token Swap';
      if (tokenTx.length >= 2) {
        const from = mintNames[tokenTx[0].mint] || 'tokens';
        const to = mintNames[tokenTx[1].mint] || 'tokens';
        swapTitle = `🔄 Swapped ${from} → ${to}`;
      } else if (xntTx.length > 0 && tokenTx.length > 0) {
        swapTitle = `🔄 Swapped XNT → ${mintNames[tokenTx[0].mint] || 'tokens'}`;
      }
      report.findings.push({ title: swapTitle, desc: 'Tokens were exchanged at the current market rate.', severity: 'pass' });
    } else if (transfers.length > 0) {
      for (const t of transfers) {
        const tokenName = t.type === 'XNT' ? 'XNT' : (mintNames[t.mint] || shortAddr(t.mint));
        const isSend = t.from === signers[0];
        report.findings.push({
          title: isSend ? `💸 Sent ${t.amount} ${tokenName}` : `📥 Received ${t.amount} ${tokenName}`,
          desc: isSend ? `To ${shortAddr(t.to)}` : `From ${shortAddr(t.from)}`,
          severity: 'info',
        });
      }
    } else if (isBurn) {
      report.findings.push({ title: '🔥 Tokens burned', desc: 'Permanently removed from supply.', severity: 'warn' });
    } else if (isMint) {
      report.findings.push({ title: '🪙 Tokens minted', desc: 'New tokens created.', severity: 'info' });
    } else if (instructionNames.length > 0) {
      const ixName = instructionNames.filter(n => n !== 'ComputeBudgetInstruction')[0] || instructionNames[0];
      report.findings.push({ title: `⚡ Program call: ${ixName}`, desc: 'Interacted with a smart contract. No tokens moved.', severity: 'info' });
    }

    // Fee
    report.findings.push({
      title: `Fee: ${fee.toFixed(4)} XNT`,
      desc: `${(meta?.computeUnitsConsumed || 0).toLocaleString()} compute units used.`,
      severity: fee > 0.01 ? 'warn' : 'info',
    });

    // Programs (human readable)
    const progDescriptions = uniquePrograms.map(p => KNOWN_PROGRAMS[p] || shortAddr(p));
    if (progDescriptions.length > 0) {
      report.findings.push({
        title: `Programs used: ${progDescriptions.join(', ')}`,
        desc: uniquePrograms.map(p => KNOWN_PROGRAMS[p] ? '' : `${shortAddr(p)} is a custom program`).filter(Boolean).join('. ') || 'All standard programs.',
        severity: 'info',
      });
    }

    // Who signed
    report.findings.push({
      title: `Initiated by ${signerShort}`,
      desc: signers.length > 1 ? `${signers.length} wallets signed this (multi-signature).` : 'Single wallet authorized this.',
      severity: 'info',
    });

    report.score = success ? 85 : 30;
  } catch (err) {
    report.findings.push({ title: 'Decode error', desc: err.message, severity: 'fail' });
  }
  return report;
}

// ── Main scan endpoint ──

app.post('/scan', async (req, res) => {
  const { program: address, network: reqNetwork } = req.body;
  if (!address) return res.status(400).json({ error: 'Address required' });

  // Switch network
  const network = (reqNetwork === 'testnet') ? 'testnet' : 'mainnet';
  conn = getConn(network);
  X1_RPC = RPCS[network];
  const EXPLORER = EXPLORER_BASES[network];

  // Detect if it's a transaction signature (base58, typically 87-88 chars)
  const trimmed = address.trim();
  if (trimmed.length > 60 && trimmed.length < 100) {
    try {
      const bs58mod = require('bs58');
      const bs58api = bs58mod.default || bs58mod;
      const decoded = bs58api.decode(trimmed);
      if (decoded.length === 64) {
        const report = await scanTransaction(trimmed, network);
        return res.json(report);
      }
    } catch {}
  }

  let pubkey;
  try { pubkey = new PublicKey(address); }
  catch { return res.status(400).json({ error: 'Invalid address format' }); }

  const report = {
    address,
    network: network === 'testnet' ? 'X1 Testnet' : 'X1 Mainnet',
    networkId: network,
    rpc: X1_RPC,
    timestamp: new Date().toISOString(),
    type: 'unknown',
    explorerUrl: `${EXPLORER}/address/${address}`,
    exists: false,
    executable: false,
    owner: null,
    lamports: 0,
    dataSize: 0,
    // Program-specific
    programType: null,
    upgradeAuthority: null,
    frozen: false,
    programDataAddress: null,
    idl: { found: false },
    // Token-specific
    token: null,
    // Common
    signatures: { recent: 0, oldest: null, newest: null },
    risks: [],
    findings: [],
    score: 0,
  };

  try {
    // 1. Fetch account
    const info = await conn.getAccountInfo(pubkey, { encoding: 'base64' });
    
    // Also try jsonParsed for token data
    let parsedInfo = null;
    try {
      const parsed = await conn.getParsedAccountInfo(pubkey);
      parsedInfo = parsed?.value?.data?.parsed || null;
    } catch {}

    if (!info) {
      report.type = 'not_found';
      // Probe the other network to give a better "testnet only" message
      const altNetwork = network === 'mainnet' ? 'testnet' : 'mainnet';
      const altRpc = RPCS[altNetwork];
      const foundOnAlt = await probeAccountExists(altRpc, address);
      if (foundOnAlt) {
        report.foundOnTestnet = altNetwork === 'testnet';
        report.foundOnMainnet = altNetwork === 'mainnet';
        const altExplorer = EXPLORER_BASES[altNetwork];
        report.altExplorerUrl = `${altExplorer}/address/${address}`;
        const altLabel = altNetwork === 'testnet' ? 'X1 Testnet' : 'X1 Mainnet';
        report.findings.push({
          title: `Found on ${altLabel}`,
          desc: `This address exists on ${altLabel} but has not been initialized on ${network === 'mainnet' ? 'X1 Mainnet' : 'X1 Testnet'} yet. It may be a testnet-only address, or it may not have transacted on mainnet.`,
          severity: 'warn',
        });
      } else {
        report.findings.push({
          title: 'Address not found',
          desc: 'This address does not exist on X1 Mainnet or Testnet. Double-check the address.',
          severity: 'fail',
        });
      }
      return res.json(report);
    }

    report.exists = true;
    report.executable = info.executable;
    report.owner = info.owner.toBase58();
    report.lamports = info.lamports;
    report.dataSize = info.data.length;

    // ── Detect type ──
    const ownerStr = info.owner.toBase58();
    const isTokenMint = parsedInfo?.type === 'mint' && (ownerStr === TOKEN_PROGRAM || ownerStr === TOKEN_2022);
    const isTokenAccount = parsedInfo?.type === 'account' && (ownerStr === TOKEN_PROGRAM || ownerStr === TOKEN_2022);

    if (isTokenMint) {
      report.type = 'token';
      await scanToken(report, pubkey, parsedInfo, address);
    } else if (isTokenAccount) {
      report.type = 'token_account';
      scanTokenAccount(report, parsedInfo);
    } else if (info.executable) {
      report.type = 'program';
      await scanProgram(report, pubkey, info);
    } else if (ownerStr === '11111111111111111111111111111111') {
      report.type = 'wallet';
      await scanWallet(report, pubkey, info);
    } else if (ownerStr === VOTE_PROGRAM) {
      report.type = 'validator';
      await scanVoteAccount(report, pubkey, address);
    } else {
      report.type = 'account';
      report.findings.push({
        title: 'Data account',
        desc: `This is a data account owned by program ${ownerStr.slice(0,8)}…${ownerStr.slice(-4)}.`,
        severity: 'info',
      });
    }

    // ── Activity (all types) ──
    try {
      const sigs = await conn.getSignaturesForAddress(pubkey, { limit: 50 });
      report.signatures.recent = sigs.length;
      if (sigs.length > 0) {
        report.signatures.newest = sigs[0].blockTime ? new Date(sigs[0].blockTime * 1000).toISOString() : null;
        report.signatures.oldest = sigs[sigs.length - 1].blockTime ? new Date(sigs[sigs.length - 1].blockTime * 1000).toISOString() : null;
        const errors = sigs.filter(s => s.err !== null).length;
        const errorRate = Math.round((errors / sigs.length) * 100);

        if (sigs.length >= 50) {
          report.findings.push({
            title: 'High activity',
            desc: `50+ recent transactions found.${errorRate > 0 ? ` ${errorRate}% had errors.` : ' All succeeded.'}`,
            severity: errorRate > 30 ? 'warn' : 'pass',
          });
        } else if (sigs.length >= 5) {
          report.findings.push({
            title: 'Moderate activity',
            desc: `${sigs.length} recent transactions.${errorRate > 0 ? ` ${errorRate}% had errors.` : ' All succeeded.'}`,
            severity: 'pass',
          });
        } else {
          report.findings.push({
            title: 'Low activity',
            desc: `Only ${sigs.length} transaction${sigs.length !== 1 ? 's' : ''} found. May be new or rarely used.`,
            severity: 'warn',
          });
        }
      } else {
        report.findings.push({
          title: 'No recent activity',
          desc: 'No transactions found. This may be dormant or newly created.',
          severity: 'warn',
        });
      }
    } catch {
      report.findings.push({ title: 'Activity check unavailable', desc: 'Could not fetch transaction history.', severity: 'info' });
    }

    // Balance
    const bal = info.lamports / 1e9;
    report.findings.push({
      title: `Balance: ${bal.toFixed(4)} XNT`,
      desc: info.lamports > 890880 ? 'Rent-exempt — this account won\'t be removed.' : 'May not be rent-exempt.',
      severity: info.lamports > 890880 ? 'pass' : 'warn',
    });

    // Build risks + score
    report.risks = buildRisks(report);
    report.score = calculateScore(report);

  } catch (err) {
    report.findings.push({ title: 'Scan error', desc: err.message, severity: 'fail' });
  }

  res.json(report);
});

// ── Token scan ──

async function scanToken(report, mintPk, parsedInfo, mintStr) {
  const info = parsedInfo.info;
  
  const decimals = info.decimals || 0;
  const rawSupply = BigInt(info.supply || '0');
  const supply = Number(rawSupply) / Math.pow(10, decimals);

  report.token = {
    decimals,
    supply: supply,
    supplyRaw: info.supply,
    mintAuthority: info.mintAuthority || null,
    freezeAuthority: info.freezeAuthority || null,
    isInitialized: info.isInitialized,
    metadata: null,
    topHolders: [],
  };

  // Metadata
  const meta = await fetchTokenMetadata(mintPk);
  if (meta) {
    // Fetch off-chain image from metadata URI
    if (meta.uri) {
      try {
        const httpUri = resolveUri(meta.uri);
        if (httpUri) {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 3500);
          const resp = await fetch(httpUri, { signal: controller.signal });
          clearTimeout(timeoutId);
          if (resp.ok) {
            const json = await resp.json();
            if (json.image) meta.image = resolveUri(json.image);
            if (json.description) meta.description = json.description;
          }
        }
      } catch {}
    }
    report.token.metadata = meta;
    report.findings.push({
      title: meta.name ? `${meta.name} (${meta.symbol})` : 'Token metadata found',
      desc: `This token has on-chain metadata.${meta.uri ? '' : ' No off-chain URI set.'}`,
      severity: 'pass',
    });
  } else {
    report.findings.push({
      title: 'No metadata',
      desc: 'This token has no Metaplex metadata. It may display without a name or logo in wallets.',
      severity: 'info',
    });
  }

  // Supply
  const supplyFormatted = supply >= 1e9 ? `${(supply / 1e9).toFixed(2)}B` :
    supply >= 1e6 ? `${(supply / 1e6).toFixed(2)}M` :
    supply >= 1e3 ? `${(supply / 1e3).toFixed(2)}K` :
    supply.toFixed(decimals);

  report.findings.push({
    title: `Total supply: ${supplyFormatted}`,
    desc: `${decimals} decimal places. Raw supply: ${info.supply}`,
    severity: 'pass',
  });

  // Mint authority
  if (!info.mintAuthority) {
    report.findings.push({
      title: 'Mint authority revoked',
      desc: 'No one can create new tokens. The supply is permanently fixed — this is the safest configuration.',
      severity: 'pass',
    });
  } else {
    report.findings.push({
      title: 'Mint authority active',
      desc: `${info.mintAuthority.slice(0,8)}…${info.mintAuthority.slice(-4)} can mint unlimited new tokens at any time. This dilutes existing holders.`,
      severity: 'warn',
    });
  }

  // Freeze authority
  if (!info.freezeAuthority) {
    report.findings.push({
      title: 'No freeze authority',
      desc: 'No one can freeze token accounts. Your tokens can\'t be locked by the issuer.',
      severity: 'pass',
    });
  } else {
    report.findings.push({
      title: 'Freeze authority active',
      desc: `${info.freezeAuthority.slice(0,8)}…${info.freezeAuthority.slice(-4)} can freeze any token account, preventing transfers.`,
      severity: 'warn',
    });
  }

  // Top holders
  try {
    const holders = await getTokenHolders(mintStr);
    report.token.topHolders = holders.slice(0, 10).map(h => ({
      address: h.address.toBase58(),
      amount: h.uiAmountString,
      pct: supply > 0 ? ((Number(h.uiAmount) / supply) * 100).toFixed(2) : '0',
    }));

    if (holders.length > 0) {
      const top1Pct = supply > 0 ? ((Number(holders[0].uiAmount) / supply) * 100) : 0;
      if (top1Pct > 50) {
        report.findings.push({
          title: `Top holder owns ${top1Pct.toFixed(1)}% of supply`,
          desc: 'Extremely concentrated ownership. One wallet controls the majority of tokens.',
          severity: 'warn',
        });
      } else if (top1Pct > 20) {
        report.findings.push({
          title: `Top holder owns ${top1Pct.toFixed(1)}% of supply`,
          desc: 'Significant concentration in one wallet. Watch for large sells.',
          severity: 'warn',
        });
      } else {
        report.findings.push({
          title: 'Supply well distributed',
          desc: `Top holder has ${top1Pct.toFixed(1)}% — no single wallet dominates.`,
          severity: 'pass',
        });
      }
    }
  } catch {}
}

// ── Token account scan ──

function scanTokenAccount(report, parsedInfo) {
  const info = parsedInfo.info;
  report.token = {
    isTokenAccount: true,
    mint: info.mint,
    owner: info.owner,
    balance: info.tokenAmount?.uiAmountString || '0',
    state: info.state,
  };
  report.findings.push({
    title: 'Token account',
    desc: `Holds ${info.tokenAmount?.uiAmountString || '0'} tokens of mint ${info.mint?.slice(0,8)}…${info.mint?.slice(-4)}. Owned by ${info.owner?.slice(0,8)}…${info.owner?.slice(-4)}.`,
    severity: 'info',
  });
}

// ── Vote Account / Validator scan ──

async function scanVoteAccount(report, votePk, address) {
  const validators = await getValidators();
  const v = validators?.map?.[address];

  if (v) {
    const stakeFormatted = v.activatedStake >= 1e6 ? `${(v.activatedStake / 1e6).toFixed(2)}M` :
      v.activatedStake >= 1e3 ? `${(v.activatedStake / 1e3).toFixed(2)}K` : v.activatedStake.toFixed(2);
    const isActive = v.status === 'active';
    const totalValidators = (validators.totalActive || 0) + (validators.totalDelinquent || 0);

    // Epoch performance from recent credits
    let recentCreditsPerEpoch = 0;
    if (v.epochCredits?.length >= 2) {
      const last = v.epochCredits[v.epochCredits.length - 1];
      const prev = v.epochCredits[v.epochCredits.length - 2];
      recentCreditsPerEpoch = (last[1] - prev[1]) || 0;
    }

    report.validator = {
      votePubkey: v.votePubkey,
      nodePubkey: v.nodePubkey,
      activatedStake: v.activatedStake,
      commission: v.commission,
      lastVote: v.lastVote,
      rootSlot: v.rootSlot,
      status: v.status,
      recentCreditsPerEpoch,
      totalValidators,
    };

    report.findings.push({
      title: `🏛️ Validator — ${isActive ? 'Active' : '⚠️ Delinquent'}`,
      desc: `This is a vote account for an X1 validator node.`,
      severity: isActive ? 'pass' : 'warn',
    });
    report.findings.push({
      title: `Stake: ${stakeFormatted} XNT`,
      desc: `${v.commission}% commission. ${isActive ? `1 of ${validators.totalActive} active validators.` : `Currently delinquent (${validators.totalDelinquent} total).`}`,
      severity: 'info',
    });
    report.findings.push({
      title: `Identity: ${v.nodePubkey.slice(0, 8)}…${v.nodePubkey.slice(-4)}`,
      desc: `Validator node identity key.`,
      severity: 'info',
    });
    if (v.lastVote) {
      report.findings.push({
        title: `Last vote: slot ${v.lastVote.toLocaleString()}`,
        desc: v.rootSlot ? `Root slot: ${v.rootSlot.toLocaleString()}` : 'Root slot unknown.',
        severity: isActive ? 'pass' : 'warn',
      });
    }
    if (recentCreditsPerEpoch > 0) {
      report.findings.push({
        title: `Epoch credits: ${recentCreditsPerEpoch.toLocaleString()}`,
        desc: 'Vote credits earned in the most recent epoch. Higher = better uptime.',
        severity: recentCreditsPerEpoch > 3000 ? 'pass' : recentCreditsPerEpoch > 1000 ? 'info' : 'warn',
      });
    }

    // Score: active validators with stake and good credits score high
    let score = 50;
    if (isActive) score += 25;
    if (v.activatedStake > 1000) score += 10;
    if (v.commission <= 10) score += 5;
    if (recentCreditsPerEpoch > 3000) score += 10;
    report.score = Math.min(100, score);
  } else {
    report.findings.push({
      title: '🏛️ Vote Account',
      desc: 'This appears to be a vote account but is not in the current validator set.',
      severity: 'warn',
    });
    report.score = 30;
  }
}

// ── Wallet scan ──

async function scanWallet(report, walletPk, info) {
  const bal = info.lamports / 1e9;
  const walletStr = walletPk.toBase58();

  report.wallet = {
    balanceXNT: bal,
    tokenAccounts: [],
    flowIn: 0,
    flowOut: 0,
    flowHistory: [],
  };
  report.botAnalysis = { isBot: false, confidence: 0, signals: [] };
  report.wallet.createdAt = null;
  report.wallet.firstFunder = null;
  report.wallet.totalTxCount = 0;
  report.wallet.walletProfile = 'unknown'; // holder, trader, bot, deployer

  report.findings.push({
    title: `Wallet — ${bal.toFixed(4)} XNT`,
    desc: 'Standard wallet on X1.',
    severity: 'pass',
  });

  // ── Validator identity check ──
  try {
    const validators = await getValidators();
    const v = validators?.map?.[walletStr];
    if (v && v.nodePubkey === walletStr) {
      const stakeFormatted = v.activatedStake >= 1e6 ? `${(v.activatedStake / 1e6).toFixed(2)}M` :
        v.activatedStake >= 1e3 ? `${(v.activatedStake / 1e3).toFixed(2)}K` : v.activatedStake.toFixed(2);
      report.validator = {
        votePubkey: v.votePubkey,
        nodePubkey: v.nodePubkey,
        activatedStake: v.activatedStake,
        commission: v.commission,
        lastVote: v.lastVote,
        status: v.status,
        totalValidators: (validators.totalActive || 0) + (validators.totalDelinquent || 0),
      };
      report.wallet.walletProfile = 'validator';
      const isActive = v.status === 'active';
      report.findings.push({
        title: `🏛️ Validator Node${isActive ? '' : ' (Delinquent)'}`,
        desc: `This wallet operates a validator. Stake: ${stakeFormatted} XNT · ${v.commission}% commission. Vote account: ${v.votePubkey.slice(0,8)}…${v.votePubkey.slice(-4)}.`,
        severity: isActive ? 'pass' : 'warn',
      });
    }
  } catch {}

  // ── Wallet age + origin: find oldest transaction ──
  try {
    let oldestSig = null;
    let cursor = undefined;
    let totalCount = 0;
    // Paginate backwards to find the very first tx (cap at 5 pages to avoid timeout)
    let pages = 0;
    while (pages < 5) {
      const opts = { limit: 1000 };
      if (cursor) opts.before = cursor;
      const batch = await conn.getSignaturesForAddress(walletPk, opts);
      totalCount += batch.length;
      if (batch.length === 0) break;
      oldestSig = batch[batch.length - 1];
      if (batch.length < 1000) break;
      cursor = oldestSig.signature;
      pages++;
    }
    report.wallet.totalTxCount = totalCount;

    if (oldestSig?.blockTime) {
      const createdDate = new Date(oldestSig.blockTime * 1000);
      report.wallet.createdAt = createdDate.toISOString();

      // Calculate wallet age
      const ageMs = Date.now() - createdDate.getTime();
      const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
      const ageLabel = ageDays > 365 ? `${Math.floor(ageDays / 365)}y ${ageDays % 365}d` :
        ageDays > 30 ? `${Math.floor(ageDays / 30)}mo ${ageDays % 30}d` : `${ageDays}d`;

      report.findings.push({
        title: `Created ${ageLabel} ago · ${totalCount.toLocaleString()} total txns`,
        desc: `First seen ${createdDate.toLocaleDateString()}. ${totalCount > 500 ? 'Very active wallet.' : totalCount > 50 ? 'Moderately active.' : 'Low activity overall.'}`,
        severity: 'info',
      });

      // Try to decode the first tx to find funder
      try {
        const firstTx = await conn.getParsedTransaction(oldestSig.signature, { maxSupportedTransactionVersion: 0 });
        if (firstTx) {
          const accountKeys = firstTx.transaction.message.accountKeys?.map(k => ({
            pubkey: k.pubkey?.toBase58?.() || k.pubkey || k,
            signer: k.signer,
          })) || [];

          // Check if wallet was the signer (self-funded/created by keygen)
          const walletIsSigner = accountKeys.some(k => k.pubkey === walletStr && k.signer);

          // Look for who sent funds to this wallet in the first tx
          const preBalances = firstTx.meta?.preBalances || [];
          const postBalances = firstTx.meta?.postBalances || [];
          let funder = null;

          for (let i = 0; i < accountKeys.length; i++) {
            const diff = ((postBalances[i] || 0) - (preBalances[i] || 0)) / 1e9;
            if (diff < -0.001 && accountKeys[i].pubkey !== walletStr) {
              funder = accountKeys[i].pubkey;
              break;
            }
          }

          // Check what the first tx did
          const firstIxTypes = firstTx.transaction.message.instructions
            ?.map(ix => ix.parsed?.type || ix.programId?.toBase58?.() || 'unknown') || [];
          const isDeployTx = firstIxTypes.some(t => t === 'write' || t === 'deployWithMaxDataLen');
          const isTransferTx = firstIxTypes.some(t => t === 'transfer' || t === 'createAccount');

          if (funder) {
            report.wallet.firstFunder = funder;
            report.findings.push({
              title: `Origin: ${funder.slice(0, 8)}…${funder.slice(-4)}`,
              desc: isDeployTx ? 'First transaction was a program deployment — likely an agent or developer wallet.'
                : isTransferTx ? 'Funded via transfer.'
                : 'First funder identified from initial transaction.',
              severity: 'info',
            });
          } else if (walletIsSigner && isDeployTx) {
            report.findings.push({
              title: 'Origin: Self-signed deployment',
              desc: 'This wallet\'s first action was deploying a program. Likely an agent or automated deployer.',
              severity: 'info',
            });
          }

          // Agent detection signals from first tx
          if (isDeployTx) {
            report.botAnalysis.signals.push('First tx was a program deployment');
            report.botAnalysis.confidence = Math.min(100, (report.botAnalysis.confidence || 0) + 10);
          }
        }
      } catch {}
    }
  } catch {}

  // ── Fetch token balances with metadata (names!) ──
  try {
    const tokenAccounts = await conn.getParsedTokenAccountsByOwner(walletPk, {
      programId: new PublicKey(TOKEN_PROGRAM),
    });

    const tokens = tokenAccounts.value
      .map(ta => {
        const parsed = ta.account.data.parsed?.info;
        if (!parsed) return null;
        return {
          mint: parsed.mint,
          balance: parsed.tokenAmount?.uiAmountString || '0',
          balanceRaw: parsed.tokenAmount?.amount || '0',
          decimals: parsed.tokenAmount?.decimals || 0,
          name: null,
          symbol: null,
        };
      })
      .filter(t => t != null)
      .sort((a, b) => parseFloat(b.balance) - parseFloat(a.balance));

    // Mark zero-balance tokens as hidden
    tokens.forEach(t => { t.hidden = t.balanceRaw === '0'; });

    // Resolve token names + tx counts via Metaplex metadata
    for (const token of tokens.slice(0, 20)) {
      try {
        const meta = await fetchTokenMetadata(new PublicKey(token.mint));
        if (meta) {
          token.name = meta.name;
          token.symbol = meta.symbol;
        }
      } catch {}
      token.txCount = 0; // will be populated from tx analysis below
    }

    report.wallet.tokenAccounts = tokens;

    if (tokens.length > 0) {
      const tokenList = tokens.slice(0, 5).map(t => {
        const label = t.symbol || t.mint.slice(0, 6) + '…';
        return `${label}: ${formatBalance(t.balance)}`;
      }).join(' · ');
      report.findings.push({
        title: `Holds ${tokens.length} token${tokens.length !== 1 ? 's' : ''}`,
        desc: tokenList,
        severity: 'pass',
      });
    } else {
      report.findings.push({
        title: 'No token holdings',
        desc: 'This wallet has no SPL token balances (may only hold XNT).',
        severity: 'info',
      });
    }
  } catch {}

  // ── Analyze transactions: bubble map + flow tracking + bot detection ──
  try {
    const sigs = await conn.getSignaturesForAddress(walletPk, { limit: 50 });
    const bubbleMap = new Map();
    const flowHistory = [];
    let totalIn = 0, totalOut = 0;

    // Bot detection signals
    let txTimestamps = [];
    let swapCount = 0;
    let uniqueTokensMoved = new Set();
    let failedTxCount = 0;
    let computeBudgetCount = 0;
    const mintTxCounts = new Map(); // mint → count of txs involving this mint

    for (const sigInfo of sigs) {
      if (sigInfo.blockTime) txTimestamps.push(sigInfo.blockTime);
      if (sigInfo.err) failedTxCount++;
    }

    for (const sigInfo of sigs.slice(0, 30)) {
      try {
        const tx = await conn.getParsedTransaction(sigInfo.signature, { maxSupportedTransactionVersion: 0 });
        if (!tx?.meta) continue;

        const blockTime = tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null;
        const allIx = [
          ...(tx.transaction.message.instructions || []),
          ...(tx.meta.innerInstructions?.flatMap(ii => ii.instructions) || []),
        ];
        const logs = tx.meta.logMessages || [];
        const isSwap = logs.some(l => l.includes('Swap'));
        if (isSwap) swapCount++;

        // Check for compute budget (bot signal)
        const hasComputeBudget = tx.transaction.message.instructions?.some(
          ix => (ix.programId?.toBase58?.() || ix.programId) === 'ComputeBudget111111111111111111111111111111'
        );
        if (hasComputeBudget) computeBudgetCount++;

        // Track programs
        const topProgs = tx.transaction.message.instructions
          ?.map(ix => ix.programId?.toBase58?.() || ix.programId)
          .filter(p => p && p !== 'ComputeBudget111111111111111111111111111111'
            && p !== '11111111111111111111111111111111') || [];

        for (const prog of topProgs) {
          const e = bubbleMap.get(prog);
          if (e) { e.count++; if (blockTime && (!e.firstSeen || blockTime < e.firstSeen)) e.firstSeen = blockTime; if (blockTime) e.lastSeen = blockTime; }
          else bubbleMap.set(prog, { category: isSwap ? 'swap' : 'program', totalAmount: 0, count: 1, firstSeen: blockTime, lastSeen: blockTime, direction: 'neutral' });
        }

        // Track transfers with timestamps
        for (const ix of allIx) {
          const p = ix.parsed;
          if (!p || !['transfer', 'transferChecked', 'transferCheckedWithFee'].includes(p.type) || !p.info) continue;

          const amount = p.info.tokenAmount
            ? parseFloat(p.info.tokenAmount.uiAmountString || '0')
            : (p.info.lamports ? p.info.lamports / 1e9 : 0);
          const mint = p.info.mint || (p.info.lamports ? 'XNT' : 'unknown');

          if (mint !== 'XNT' && mint !== 'unknown') {
            uniqueTokensMoved.add(mint);
            mintTxCounts.set(mint, (mintTxCounts.get(mint) || 0) + 1);
          }

          const src = p.info.source || p.info.authority;
          const dst = p.info.destination;
          const isSend = src === walletStr || p.info.authority === walletStr;
          const peer = isSend ? dst : src;
          if (!peer || peer === walletStr) continue;

          const category = isSwap ? 'swap' : (isSend ? 'sent' : 'received');
          if (isSend) totalOut += amount; else totalIn += amount;

          // Flow history entry
          flowHistory.push({
            timestamp: blockTime,
            signature: sigInfo.signature,
            direction: isSend ? 'out' : 'in',
            peer: peer,
            amount,
            mint,
            category,
          });

          const e = bubbleMap.get(peer);
          if (e) {
            e.totalAmount += amount;
            e.count++;
            if (category === 'swap') e.category = 'swap';
            if (blockTime && (!e.firstSeen || blockTime < e.firstSeen)) e.firstSeen = blockTime;
            if (blockTime) e.lastSeen = blockTime;
            e.direction = isSend ? (e.direction === 'in' ? 'both' : 'out') : (e.direction === 'out' ? 'both' : 'in');
          } else {
            bubbleMap.set(peer, {
              category, totalAmount: amount, count: 1,
              firstSeen: blockTime, lastSeen: blockTime,
              direction: isSend ? 'out' : 'in',
            });
          }
        }
      } catch {}
    }

    // Populate token tx counts from analysis
    for (const token of report.wallet.tokenAccounts) {
      token.txCount = mintTxCounts.get(token.mint) || 0;
    }

    // ── Wallet profile ──
    const totalTx = report.wallet.totalTxCount || sigs.length;
    const swapRatio = sigs.length > 0 ? swapCount / sigs.length : 0;
    const tokenCount = report.wallet.tokenAccounts.length;
    const holdTime = report.wallet.createdAt ? (Date.now() - new Date(report.wallet.createdAt).getTime()) / (1000*60*60*24) : 0;
    const txPerDay = holdTime > 0 ? totalTx / holdTime : totalTx;

    // Check if first tx was a deployment (agent signal)
    const firstTxWasDeployment = report.botAnalysis.signals.some(s => s.includes('deployment'));

    let profile = 'unknown';
    if (swapRatio > 0.7 && txPerDay > 30) profile = 'hft-bot';
    else if (swapRatio > 0.6 && txPerDay > 15) profile = 'trader';
    else if (swapRatio > 0.5) profile = 'swapper';
    else if (txPerDay > 50 && swapRatio < 0.3) profile = firstTxWasDeployment ? 'agent' : 'bot';
    else if (txPerDay > 20) profile = firstTxWasDeployment ? 'agent' : 'power-user';
    else if (tokenCount > 0 && txPerDay < 5 && holdTime > 7) profile = 'holder';
    else if (totalTx < 20 && holdTime > 14) profile = 'dormant';
    else if (holdTime < 2 && totalTx > 10) profile = 'new-active';
    else profile = 'casual';

    // Don't override validator/agent profile if already set
    if (report.wallet.walletProfile !== 'validator') report.wallet.walletProfile = profile;

    const profileLabels = {
      validator: '🏛️ Validator — Runs a validator node on X1',
      'hft-bot': '⚡ HFT Bot — High-frequency trading bot',
      trader: '📈 Trader — Frequent swapper, high activity',
      swapper: '🔄 Swapper — Primarily does token swaps',
      agent: '🤖 Agent — Automated agent wallet (program deployer)',
      bot: '🤖 Bot — Very high automated transaction frequency',
      'power-user': '⚡ Power User — Very active but not primarily trading',
      holder: '💎 Holder — Holds tokens, low trade activity',
      dormant: '💤 Dormant — Low activity, long hold time',
      'new-active': '🆕 New & Active — Recently created, high activity',
      casual: '👤 Casual User — Normal usage patterns',
    };

    report.findings.push({
      title: `Profile: ${profileLabels[profile]?.split(' — ')[0] || profile}`,
      desc: profileLabels[profile]?.split(' — ')[1] || 'Standard usage pattern.',
      severity: 'info',
    });

    // ── Bot detection heuristics ──
    const botSignals = [];
    let botScore = 0;

    // 1. Transaction frequency: check avg time between txs
    if (txTimestamps.length >= 10) {
      txTimestamps.sort((a, b) => a - b);
      const gaps = [];
      for (let i = 1; i < txTimestamps.length; i++) {
        gaps.push(txTimestamps[i] - txTimestamps[i - 1]);
      }
      const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const minGap = Math.min(...gaps);

      if (avgGap < 30) { // avg less than 30 seconds between txs
        botSignals.push('High-frequency trading — avg ' + Math.round(avgGap) + 's between transactions');
        botScore += 35;
      } else if (avgGap < 120) {
        botSignals.push('Rapid trading — avg ' + Math.round(avgGap) + 's between transactions');
        botScore += 20;
      }

      if (minGap <= 2) {
        botSignals.push('Sub-2-second transaction gaps detected');
        botScore += 15;
      }

      // Check for regular intervals (bot-like precision)
      const stdDev = Math.sqrt(gaps.reduce((sum, g) => sum + Math.pow(g - avgGap, 2), 0) / gaps.length);
      if (stdDev < avgGap * 0.3 && avgGap < 300) {
        botSignals.push('Suspiciously regular timing pattern (low variance)');
        botScore += 15;
      }
    }

    // 2. Swap ratio
    if (sigs.length >= 5 && swapCount / sigs.length > 0.7) {
      botSignals.push(`${Math.round(swapCount / sigs.length * 100)}% of transactions are swaps`);
      botScore += 20;
    }

    // 3. Compute budget usage (bots set priority fees)
    if (sigs.length >= 5 && computeBudgetCount / Math.min(sigs.length, 30) > 0.8) {
      botSignals.push('Consistent compute budget instructions (priority fee setting)');
      botScore += 15;
    }

    // 4. High token diversity in short time
    if (uniqueTokensMoved.size > 8 && sigs.length >= 10) {
      botSignals.push(`${uniqueTokensMoved.size} different tokens moved — high diversity`);
      botScore += 10;
    }

    // 5. High failure rate (MEV bots often have failed txs)
    if (sigs.length >= 10 && failedTxCount / sigs.length > 0.3) {
      botSignals.push(`${Math.round(failedTxCount / sigs.length * 100)}% failed transactions — possible MEV activity`);
      botScore += 15;
    }

    botScore = Math.min(100, botScore);

    // Check if wallet holds an AgentID NFT — if so, classify as "Agent" not bot/human
    const hasAgentID = report.wallet.tokenAccounts.some(t =>
      (t.name && t.name.toLowerCase().includes('agentid')) ||
      (t.symbol && t.symbol.toLowerCase().includes('agentid'))
    );
    const isAgentProfile = profile === 'agent' || firstTxWasDeployment || hasAgentID;

    if (isAgentProfile) {
      report.wallet.walletProfile = 'agent';
      report.botAnalysis = {
        isBot: false,
        isAgent: true,
        confidence: hasAgentID ? 95 : 70,
        signals: hasAgentID ? ['Holds AgentID NFT', ...botSignals] : botSignals,
        label: 'AI Agent',
      };
      report.findings.push({
        title: `🤖 AI Agent${hasAgentID ? ' (Verified AgentID)' : ''}`,
        desc: hasAgentID ? 'This wallet holds an AgentID NFT — a verified autonomous AI agent.' : 'Automated agent wallet identified by deployment patterns.',
        severity: 'pass',
      });
    } else {
      report.botAnalysis = {
        isBot: botScore >= 50,
        isAgent: false,
        confidence: botScore,
        signals: botSignals,
        label: botScore >= 70 ? 'Likely Bot' : botScore >= 50 ? 'Possible Bot' : botScore >= 25 ? 'Some Bot Signals' : 'Likely Human',
      };

      if (botScore >= 50) {
        report.findings.push({
          title: `🤖 ${report.botAnalysis.label} (${botScore}% confidence)`,
          desc: botSignals.slice(0, 3).join('. ') + '.',
          severity: 'warn',
        });
      } else if (botScore >= 25) {
        report.findings.push({
          title: `👤 ${report.botAnalysis.label}`,
          desc: botSignals.length > 0 ? botSignals[0] : 'Some automated patterns detected.',
          severity: 'info',
        });
      } else {
        report.findings.push({
          title: '👤 Likely Human',
          desc: 'Transaction patterns appear manual/organic.',
          severity: 'pass',
        });
      }
    }

    // Flow summary
    report.wallet.flowIn = totalIn;
    report.wallet.flowOut = totalOut;
    report.wallet.flowHistory = flowHistory.slice(0, 50);

    if (totalIn > 0 || totalOut > 0) {
      report.findings.push({
        title: `Flow: ${formatBalance(String(totalIn))} in · ${formatBalance(String(totalOut))} out`,
        desc: `${flowHistory.length} tracked transfers.`,
        severity: 'info',
      });
    }

    // Convert bubble map
    const bubbleData = [];
    const maxCount = Math.max(...[...bubbleMap.values()].map(v => v.count), 1);

    for (const [addr, data] of bubbleMap) {
      bubbleData.push({
        address: addr,
        label: addr.slice(0, 4) + '…',
        category: data.category,
        count: data.count,
        amount: data.totalAmount,
        size: 10 + (data.count / maxCount) * 32,
        firstSeen: data.firstSeen,
        lastSeen: data.lastSeen,
        direction: data.direction || 'neutral',
      });
    }
    bubbleData.sort((a, b) => b.count - a.count);
    // Enrich with known program names
    for (const b of bubbleData) {
      b.name = getProgramName(b.address) || null;
    }
    report.bubbleData = bubbleData.slice(0, 40);

  } catch {
    report.bubbleData = [];
  }
}

function formatBalance(s) {
  const n = parseFloat(s);
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return n.toFixed(2);
}

// ── Program scan ──

async function scanProgram(report, programPk, info) {
  const ownerStr = info.owner.toBase58();
  report.programName = getProgramName(programPk.toBase58()) || null;

  report.findings.push({
    title: 'Executable program',
    desc: 'This is a deployed program on X1 that can process transactions.',
    severity: 'pass',
  });

  if (info.owner.equals(NATIVE_LOADER)) {
    report.programType = 'native';
    report.frozen = true;
    report.findings.push({
      title: 'Native system program',
      desc: 'Built into the X1 runtime. Cannot be modified.',
      severity: 'pass',
    });
  } else if (ownerStr === BPF_LOADER_2) {
    report.programType = 'immutable';
    report.frozen = true;
    report.findings.push({
      title: 'Immutable program',
      desc: 'Deployed with the non-upgradeable loader. Can never be changed.',
      severity: 'pass',
    });
  } else if (info.owner.equals(BPF_LOADER_UPGRADEABLE)) {
    report.programType = 'upgradeable';
    const pdAddr = await getProgramDataAddress(programPk);
    if (pdAddr) {
      report.programDataAddress = pdAddr.toBase58();
      const { authority, frozen } = await getUpgradeAuthority(pdAddr);
      report.upgradeAuthority = authority;
      report.frozen = frozen;

      if (frozen) {
        report.findings.push({
          title: 'Upgrade authority revoked',
          desc: 'This program is permanently locked. No one can change it.',
          severity: 'pass',
        });
      } else if (authority) {
        report.findings.push({
          title: 'Program is upgradeable',
          desc: `${authority.slice(0,8)}…${authority.slice(-4)} can modify this program at any time.`,
          severity: 'warn',
        });
      }
    }
  }

  // IDL
  const idlResult = await fetchIdl(programPk);
  report.idl = idlResult;
  if (idlResult.found) {
    const ic = idlResult.idl?.instructions?.length || 0;
    report.findings.push({
      title: 'Interface published',
      desc: `On-chain IDL with ${ic} instruction${ic !== 1 ? 's' : ''}. Transparent and verifiable.`,
      severity: 'pass',
    });
  } else {
    report.findings.push({
      title: 'No public interface',
      desc: 'No IDL published. Common, but limits transparency.',
      severity: 'info',
    });
  }
}

// ── Risk assessment ──

function buildRisks(report) {
  const risks = [];

  if (report.type === 'token') {
    // Token risks
    const t = report.token;

    // Mint authority
    if (!t.mintAuthority) {
      risks.push({ category: 'supply', level: 'low', description: 'Fixed supply — no one can mint more tokens.' });
    } else {
      risks.push({ category: 'supply', level: 'high', description: 'Mint authority is active. Unlimited new tokens can be created.' });
    }

    // Freeze
    if (!t.freezeAuthority) {
      risks.push({ category: 'freedom', level: 'low', description: 'No freeze authority. Your tokens can\'t be locked.' });
    } else {
      risks.push({ category: 'freedom', level: 'high', description: 'Freeze authority active. Token accounts can be frozen.' });
    }

    // Concentration
    if (t.topHolders?.length > 0) {
      const topPct = parseFloat(t.topHolders[0].pct);
      if (topPct > 50) {
        risks.push({ category: 'concentration', level: 'high', description: `One wallet holds ${topPct.toFixed(1)}% of all tokens.` });
      } else if (topPct > 20) {
        risks.push({ category: 'concentration', level: 'medium', description: `Top holder has ${topPct.toFixed(1)}% of supply.` });
      } else {
        risks.push({ category: 'concentration', level: 'low', description: 'No single wallet dominates the supply.' });
      }
    }

    // Activity
    addActivityRisk(risks, report);

  } else if (report.type === 'wallet') {
    const bal = report.wallet?.balanceXNT || 0;
    const tokens = report.wallet?.tokenAccounts?.length || 0;

    if (bal > 0 || tokens > 0) {
      risks.push({ category: 'status', level: 'low', description: 'Active wallet with assets.' });
    } else {
      risks.push({ category: 'status', level: 'medium', description: 'Wallet exists but has no assets.' });
    }

    addActivityRisk(risks, report);

  } else if (report.type === 'program') {
    // Program risks
    if (report.frozen) {
      risks.push({ category: 'ownership', level: 'low', description: 'Immutable — no one can change this program.' });
    } else if (report.upgradeAuthority) {
      risks.push({ category: 'ownership', level: 'high', description: `One wallet can upgrade this program.` });
    } else {
      risks.push({ category: 'ownership', level: 'medium', description: 'Could not determine upgrade authority.' });
    }

    if (report.idl?.found) {
      risks.push({ category: 'transparency', level: 'low', description: 'Publishes its interface on-chain.' });
    } else if (report.executable) {
      risks.push({ category: 'transparency', level: 'medium', description: 'No public interface definition.' });
    }

    addActivityRisk(risks, report);
  } else if (report.type === 'validator') {
    const v = report.validator;
    if (v) {
      risks.push(v.status === 'active'
        ? { category: 'status', level: 'low', description: 'Active validator with voting rights.' }
        : { category: 'status', level: 'high', description: 'Delinquent — not currently voting.' });
      risks.push(v.commission <= 10
        ? { category: 'fees', level: 'low', description: `${v.commission}% commission — competitive rate.` }
        : { category: 'fees', level: 'medium', description: `${v.commission}% commission.` });
      risks.push(v.activatedStake > 10000
        ? { category: 'stake', level: 'low', description: `${(v.activatedStake / 1e3).toFixed(1)}K XNT staked.` }
        : { category: 'stake', level: 'medium', description: `${v.activatedStake.toFixed(0)} XNT staked — relatively low.` });
    }
    addActivityRisk(risks, report);
  }

  return risks;
}

function addActivityRisk(risks, report) {
  const count = report.signatures?.recent || 0;
  if (count >= 50) {
    risks.push({ category: 'activity', level: 'low', description: 'High transaction volume — actively used.' });
  } else if (count >= 5) {
    risks.push({ category: 'activity', level: 'medium', description: 'Moderate activity.' });
  } else {
    risks.push({ category: 'activity', level: 'high', description: 'Very low or no activity.' });
  }
}

function calculateScore(report) {
  if (!report.exists) return 0;

  if (report.type === 'wallet') {
    let score = 60;
    const bal = report.wallet?.balanceXNT || 0;
    const tokens = report.wallet?.tokenAccounts?.length || 0;
    if (bal > 0) score += 10;
    if (tokens > 0) score += 10;
    if (report.signatures.recent >= 50) score += 15;
    else if (report.signatures.recent >= 5) score += 8;
    return Math.min(100, score);
  }

  if (report.type === 'token') {
    let score = 40; // Base for existing token
    const t = report.token;
    if (!t.mintAuthority) score += 20;
    if (!t.freezeAuthority) score += 10;
    if (t.metadata) score += 5;
    if (t.topHolders?.length > 0) {
      const topPct = parseFloat(t.topHolders[0].pct);
      if (topPct < 20) score += 10;
      else if (topPct < 50) score += 5;
    }
    if (report.signatures.recent >= 50) score += 15;
    else if (report.signatures.recent >= 5) score += 8;
    return Math.min(100, score);
  }

  if (report.type === 'program') {
    let score = 50;
    if (report.frozen) score += 25;
    else if (report.upgradeAuthority) score += 5;
    if (report.idl?.found) score += 10;
    if (report.signatures.recent >= 50) score += 15;
    else if (report.signatures.recent >= 5) score += 8;
    return Math.min(100, score);
  }

  // Validator score already set in scanVoteAccount
  if (report.type === 'validator') return report.score || 50;

  return 30; // generic account
}

const port = process.env.PORT || 4174;
app.listen(port, () => {
  console.log(`X1Bench listening on http://localhost:${port} — RPC: ${X1_RPC}`);
});

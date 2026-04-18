import "./style.css";
import {
  WalletConnectWallet,
  WalletConnectChainID,
} from "@tronweb3/walletconnect-tron";

// ─── Config (from .env) ───────────────────────────────────────────────────────
const PROJECT_ID = import.meta.env.VITE_WC_PROJECT_ID;
const APP_NAME   = import.meta.env.VITE_APP_NAME        || "TRON Wallet";
const APP_DESC   = import.meta.env.VITE_APP_DESCRIPTION || "TRON dApp";
const APP_ICON   = import.meta.env.VITE_APP_ICON        || `${location.origin}/logo.png`;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const bootOverlay    = document.getElementById("bootOverlay");
const viewConnecting = document.getElementById("viewConnecting");
const viewConnected  = document.getElementById("viewConnected");
const viewError      = document.getElementById("viewError");
const connectingMsg  = document.getElementById("connectingMsg");
const connectingSub  = document.getElementById("connectingSub");
const walletAddr     = document.getElementById("walletAddr");
const errorMsg       = document.getElementById("errorMsg");
const btnRetry       = document.getElementById("btnRetry");
const btnDisconnect  = document.getElementById("btnDisconnect");

// ─── Device detection ─────────────────────────────────────────────────────────
const UA = navigator.userAgent || "";

/**
 * True when the page is loaded inside Trust Wallet's built-in DApp browser.
 * Trust Wallet injects `window.trustwallet` and also sets a UA substring.
 */
const IN_TRUST_BROWSER =
  /TrustWallet/i.test(UA) ||
  typeof window.trustwallet !== "undefined" ||
  (typeof window.ethereum !== "undefined" && !!window.ethereum?.isTrust);

/** True on any mobile device (Android / iOS). */
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(UA);

console.log("[dapp] device →", {
  IN_TRUST_BROWSER,
  IS_MOBILE,
  ua: UA.slice(0, 100),
});

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

  // Fire when the user switches account inside Trust Wallet
  wallet.on("accountsChanged", (accounts) => {
    if (accounts && accounts[0]) {
      showConnected(accounts[0]);
    } else {
      // Wallet removed the account → treat as disconnect
      showError("Account removed from wallet.");
    }
  });

  // Fire when the WalletConnect session is terminated by the wallet side
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
  [viewConnecting, viewConnected, viewError].forEach((v) => {
    if (v) v.hidden = v.id !== id;
  });
}

function showConnecting(title = "Connecting…", sub = "Opening Trust Wallet") {
  connectingMsg.textContent = title;
  connectingSub.textContent = sub;
  showView("viewConnecting");
}

function showConnected(address) {
  // Nicely shorten: TJx...4kLm
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

// ─── Deep link builder ────────────────────────────────────────────────────────
/**
 * Returns the Trust Wallet universal link that auto-opens the app and
 * loads the WalletConnect pairing request.
 *
 * https://link.trustwallet.com/wc?uri=<encoded-wc-uri>
 * is preferred over trust:// because it gracefully redirects to the
 * App Store / Play Store if Trust Wallet is not installed.
 */
function trustWalletLink(wcUri) {
  return `https://link.trustwallet.com/wc?uri=${encodeURIComponent(wcUri)}`;
}

// ─── Connection flow ──────────────────────────────────────────────────────────
/**
 * This is the core of the TronScan-like flow.
 *
 * TronScan flow (reproduced exactly):
 *  1. User hits the site / clicks "WalletConnect"
 *  2. dApp calls wcWallet.connect({ onUri })
 *  3. WC relay generates a pairing URI and fires onUri immediately
 *  4. dApp redirects mobile users to trust wallet via the universal link
 *  5. Inside Trust Wallet browser → AppKit modal surfaces TW natively
 *  6. User taps "Connect" once → wallet.connect() resolves with { address }
 */
async function connect() {
  if (!PROJECT_ID) {
    showError("WalletConnect Project ID missing. Check your .env file.");
    return;
  }

  // Decide status message based on context
  if (IN_TRUST_BROWSER) {
    showConnecting("Connecting…", "Approve in Trust Wallet");
  } else if (IS_MOBILE) {
    showConnecting("Launching Trust Wallet…", "Opening the app for you");
  } else {
    showConnecting("Scan with Trust Wallet", "Use Trust Wallet → WalletConnect → Scan QR");
  }

  try {
    const { address } = await wallet.connect({
      /**
       * onUri fires the moment WalletConnect generates the pairing URI.
       * This is where we deep-link mobile users into Trust Wallet —
       * the same thing TronScan does when you tap "WalletConnect" on mobile.
       *
       * NOTE: We set window.location.href SYNCHRONOUSLY inside this callback
       * (onUri is NOT async/awaited by the library) so iOS Safari never
       * blocks it as a "popup".
       */
      onUri(uri) {
        console.log("[dapp] WC pairing URI ready, length:", uri?.length);

        if (!uri) return;

        // Mobile external browser: redirect straight into Trust Wallet app.
        // After the user approves, the OS returns to the browser and
        // wallet.connect() resolves with the connected address.
        if (IS_MOBILE && !IN_TRUST_BROWSER) {
          const link = trustWalletLink(uri);
          console.log("[dapp] deep-linking →", link.slice(0, 80) + "…");
          window.location.href = link;
        }

        // If IN_TRUST_BROWSER  → AppKit modal shows Trust Wallet natively; nothing extra needed.
        // If desktop           → AppKit QR modal is already rendering; nothing extra needed.
      },
    });

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
  try {
    await wallet?.disconnect();
  } catch { /* silent */ }
  showError("Disconnected. Tap to reconnect.");
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function init() {
  buildWallet();
  hideBoot();

  // ── 1. Try to restore an existing WalletConnect session ──────────────────
  // If the user already connected before and the session is still alive,
  // we show them as connected immediately — no QR / deep link needed.
  try {
    const { address } = await wallet.checkConnectStatus();
    if (address) {
      console.log("[dapp] ✓ session restored:", address);
      showConnected(address);
      return; // done — skip new connect flow
    }
  } catch {
    // No saved session → continue to fresh connect
    console.log("[dapp] no prior session, starting fresh");
  }

  // ── 2. Auto-start WalletConnect the moment the page loads ────────────────
  await connect();
}

// ─── Button events ────────────────────────────────────────────────────────────
btnRetry.addEventListener("click", () => {
  // Rebuild wallet instance so any stale pairing state is cleared
  buildWallet();
  connect();
});

btnDisconnect.addEventListener("click", disconnect);

// ─── Go ───────────────────────────────────────────────────────────────────────
init().catch((err) => {
  console.error("[dapp] fatal init error:", err);
  showError("App failed to start. Please refresh.");
});

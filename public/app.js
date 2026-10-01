/* ============================================================
   ClipShare – app.js
   Full frontend logic:
     • Network status detection (Online / Offline)
     • Online Mode: debounced POST + SSE listener
     • Offline Mode: QR code generation (with size guard)
     • Scanner Mode: html5-qrcode camera scanning
     • Toast notifications
     • Copy / Clear utilities
   ============================================================ */

'use strict';

// ── Constants ───────────────────────────────────────────────
const API_SHARE   = '/api/share';
const API_STREAM  = '/api/stream';
const API_CURRENT = '/api/current';
const API_CLEAR   = '/api/clear';

const DEBOUNCE_MS     = 900;   // ms to wait after last keystroke before pushing
const QR_WARN_CHARS   = 1000;  // show warning above this length
const QR_SIZE_PX      = 256;   // pixel size of generated QR
const QR_MAX_DIRECT_BYTES = 800; // above this, QR holds a download link instead of the raw text
const API_UPLOAD  = '/api/upload';
const POLL_INTERVAL_MS= 3500;  // fallback polling interval when SSE fails

// ── Session ID (unique per browser tab) ─────────────────────
const SESSION_ID = (() => {
  let id = sessionStorage.getItem('clipshare_session');
  if (!id) {
    id = 'cs-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    sessionStorage.setItem('clipshare_session', id);
  }
  return id;
})();

// ── DOM references ───────────────────────────────────────────
const textarea         = document.getElementById('mainTextarea');
const charCount        = document.getElementById('charCount');
const clearBtn         = document.getElementById('clearBtn');
const copyBtn          = document.getElementById('copyBtn');
const qrBtn            = document.getElementById('qrBtn');
const scanBtn          = document.getElementById('scanBtn');

const statusPill       = document.getElementById('statusPill');
const statusDot        = document.getElementById('statusDot');
const statusLabel      = document.getElementById('statusLabel');
const serverPill       = document.getElementById('serverPill');
const serverDot        = document.getElementById('serverDot');
const serverLabel      = document.getElementById('serverLabel');

const modeBanner       = document.getElementById('modeBanner');
const modeBannerIcon   = document.getElementById('modeBannerIcon');
const modeBannerText   = document.getElementById('modeBannerText');

const syncIndicator    = document.getElementById('syncIndicator');
const syncMsg          = document.getElementById('syncMsg');
const syncMeta         = document.getElementById('syncMeta');
const syncMetaText     = document.getElementById('syncMetaText');

const qrPanel          = document.getElementById('qrPanel');
const qrContainer      = document.getElementById('qrContainer');
const qrCloseBtn       = document.getElementById('qrCloseBtn');
const qrSizeWarning    = document.getElementById('qrSizeWarning');
const qrDownloadBtn    = document.getElementById('qrDownloadBtn');

const scannerModal     = document.getElementById('scannerModal');
const scannerCloseBtn  = document.getElementById('scannerCloseBtn');
const scannerResult    = document.getElementById('scannerResult');
const scannerResultPreview = document.getElementById('scannerResultPreview');
const scannerUseBtn    = document.getElementById('scannerUseBtn');
const qrReaderContainer= document.getElementById('qrReaderContainer');
const cameraSelectRow  = document.getElementById('cameraSelectRow');
const cameraSelect     = document.getElementById('cameraSelect');
const switchCameraBtn  = document.getElementById('switchCameraBtn');
const toastContainer   = document.getElementById('toastContainer');

// ── State ────────────────────────────────────────────────────
let isOnline          = navigator.onLine;
let sseSource         = null;         // EventSource instance
let debounceTimer     = null;
let currentVersion    = 0;            // last seen server version
let pollTimer         = null;         // fallback poller
let qrCodeInstance    = null;         // QRCode.js instance
let html5QrScanner    = null;         // Html5QrcodeScanner instance
let lastScannedText   = '';           // holds last scan result
let availableCameras  = [];
let activeCameraId    = null;
let suppressPush      = false;        // flag: skip push when we're updating from remote

// ════════════════════════════════════════════════════════════
//   UTILITIES
// ════════════════════════════════════════════════════════════

/** Debounce helper */
function debounce(fn, delay) {
  return function (...args) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => fn.apply(this, args), delay);
  };
}

/** Format ISO timestamp to local readable string */
function formatTime(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Show/hide the sync indicator */
function showSync(state, message) {
  syncIndicator.className = 'sync-indicator visible ' + (state || '');
  syncMsg.textContent = message;
}
function hideSync() {
  syncIndicator.className = 'sync-indicator';
}

/** Update character counter */
function updateCharCount() {
  const len = textarea.value.length;
  charCount.textContent = `${len.toLocaleString()} char${len !== 1 ? 's' : ''}`;
}

// ════════════════════════════════════════════════════════════
//   TOAST NOTIFICATIONS
// ════════════════════════════════════════════════════════════

const TOAST_ICONS = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };

function showToast(message, type = 'info', duration = 3000) {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${TOAST_ICONS[type] || 'ℹ️'}</span><span>${message}</span>`;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'toastOut 0.3s ease forwards';
    toast.addEventListener('animationend', () => toast.remove());
  }, duration);
}

// ════════════════════════════════════════════════════════════
//   NETWORK STATUS UI
// ════════════════════════════════════════════════════════════

function applyNetworkStatus(online) {
  isOnline = online;

  // Status pill
  statusPill.className = 'status-pill ' + (online ? 'online' : 'offline');
  statusLabel.textContent = online ? 'Online' : 'Offline';

  // Mode banner
  modeBanner.className = 'mode-banner ' + (online ? 'online' : 'offline');
  modeBannerIcon.textContent = online ? '🌐' : '📡';
  modeBannerText.textContent = online
    ? 'Online Mode – changes sync automatically to other devices'
    : 'Offline Mode – use QR Code to share text without internet';

  // Server pill only relevant when online
  serverPill.style.display = online ? 'flex' : 'none';

  if (online) {
    startSSE();
    stopPolling();
  } else {
    stopSSE();
    stopPolling();
    setServerStatus(false);
  }
}

// ════════════════════════════════════════════════════════════
//   SERVER STATUS UI
// ════════════════════════════════════════════════════════════

function setServerStatus(connected) {
  serverPill.className = 'server-pill ' + (connected ? 'connected' : 'disconnected');
  serverDot.className  = 'server-dot';
  serverLabel.textContent = connected ? 'Server' : 'No Server';
}

// ════════════════════════════════════════════════════════════
//   SSE – SERVER-SENT EVENTS (Online Mode)
// ════════════════════════════════════════════════════════════

function startSSE() {
  if (sseSource && sseSource.readyState !== EventSource.CLOSED) return; // already connected

  const url = `${API_STREAM}?session=${encodeURIComponent(SESSION_ID)}&since=${currentVersion}`;
  sseSource = new EventSource(url);

  sseSource.onopen = () => {
    setServerStatus(true);
    stopPolling(); // SSE working, no need for polling
    console.log('[SSE] Connected');
  };

  sseSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (typeof data.version === 'number' && data.version > currentVersion) {
        currentVersion = data.version;
        receiveRemoteText(data.text, data.updatedAt);
      }
    } catch (e) {
      console.warn('[SSE] Parse error', e);
    }
  };

  // 'connected' event – server confirmation
  sseSource.addEventListener('connected', (event) => {
    const d = JSON.parse(event.data);
    console.log('[SSE] Acknowledged. ClientId:', d.clientId, '| Peers:', d.clientCount - 1);
  });

  sseSource.onerror = () => {
    setServerStatus(false);
    console.warn('[SSE] Connection lost. Switching to polling fallback…');
    sseSource.close();
    sseSource = null;
    // Fallback: poll
    if (isOnline) startPolling();
    // Retry SSE after 8 s
    setTimeout(() => { if (isOnline) startSSE(); }, 8000);
  };
}

function stopSSE() {
  if (sseSource) {
    sseSource.close();
    sseSource = null;
  }
  setServerStatus(false);
}

// ════════════════════════════════════════════════════════════
//   POLLING FALLBACK (when SSE is unavailable)
// ════════════════════════════════════════════════════════════

function startPolling() {
  if (pollTimer) return;
  console.log('[POLL] Starting fallback polling…');
  pollTimer = setInterval(async () => {
    try {
      const res  = await fetch(`${API_CURRENT}?since=${currentVersion}`);
      const data = await res.json();
      if (data.changed && data.version > currentVersion) {
        currentVersion = data.version;
        receiveRemoteText(data.text, data.updatedAt);
        setServerStatus(true);
      }
    } catch (_) {
      setServerStatus(false);
    }
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ════════════════════════════════════════════════════════════
//   RECEIVE REMOTE TEXT UPDATE
// ════════════════════════════════════════════════════════════

function receiveRemoteText(text, updatedAt) {
  suppressPush = true;         // don't re-push what we just received
  textarea.value = text;
  updateCharCount();
  suppressPush = false;

  showSync('success', '✓ Updated from another device');
  setTimeout(hideSync, 2500);

  if (updatedAt) {
    syncMeta.hidden = false;
    syncMetaText.textContent = `Last sync: ${formatTime(updatedAt)}`;
  }

  showToast('Text updated from another device', 'success', 2500);
}

// ════════════════════════════════════════════════════════════
//   PUSH TEXT TO SERVER (Online Mode)
// ════════════════════════════════════════════════════════════

async function pushText(text) {
  if (!isOnline) return;
  showSync('', 'Syncing…');
  try {
    const res = await fetch(API_SHARE, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ text, session: SESSION_ID }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    currentVersion = data.version;
    setServerStatus(true);
    showSync('success', `✓ Synced  (v${data.version} · ${data.clientCount > 1 ? data.clientCount - 1 + ' peer(s) notified' : 'no other peers'})`);
    setTimeout(hideSync, 3000);
  } catch (err) {
    setServerStatus(false);
    showSync('error', '✗ Sync failed – ' + err.message);
    setTimeout(hideSync, 4000);
    showToast('Sync failed: ' + err.message, 'error');
  }
}

const debouncedPush = debounce(pushText, DEBOUNCE_MS);

// ════════════════════════════════════════════════════════════
//   TEXTAREA EVENTS
// ════════════════════════════════════════════════════════════

textarea.addEventListener('input', () => {
  updateCharCount();
  if (!suppressPush && isOnline) {
    debouncedPush(textarea.value);
  }
});

// ════════════════════════════════════════════════════════════
//   COPY TEXT
// ════════════════════════════════════════════════════════════

copyBtn.addEventListener('click', async () => {
  const text = textarea.value;
  if (!text.trim()) { showToast('Nothing to copy!', 'warning'); return; }
  try {
    await navigator.clipboard.writeText(text);
    copyBtn.innerHTML = '<span class="btn-icon">✅</span> Copied!';
    showToast('Text copied to clipboard', 'success');
    setTimeout(() => { copyBtn.innerHTML = '<span class="btn-icon">📋</span> Copy Text'; }, 2000);
  } catch (_) {
    // Fallback for browsers without Clipboard API
    textarea.select();
    document.execCommand('copy');
    showToast('Text copied (legacy method)', 'info');
  }
});

// ════════════════════════════════════════════════════════════
//   CLEAR TEXT
// ════════════════════════════════════════════════════════════

clearBtn.addEventListener('click', async () => {
  if (!textarea.value) return;
  textarea.value = '';
  updateCharCount();
  hideSync();
  qrPanel.hidden = true;
  syncMeta.hidden = true;

  if (isOnline) {
    try {
      await fetch(API_CLEAR, {
        method : 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify({ session: SESSION_ID }),
      });
      currentVersion++;
      showToast('Cleared and synced', 'info');
    } catch (_) {
      showToast('Cleared locally (server unreachable)', 'warning');
    }
  } else {
    showToast('Cleared', 'info');
  }
});

// ════════════════════════════════════════════════════════════
//   QR CODE GENERATION (Offline Mode)
// ════════════════════════════════════════════════════════════

qrBtn.addEventListener('click', generateQR);

async function generateQR() {
  const text = textarea.value.trim();

  if (!text) {
    showToast('Enter some text first before generating a QR code.', 'warning');
    return;
  }

  // The browser QR library must be loaded (window.QRCode from QRCode.js)
  if (typeof QRCode === 'undefined' || !QRCode.CorrectLevel) {
    showToast('QR library did not load. Press Ctrl+F5 to reload the page.', 'error');
    return;
  }

  // Clear previous QR
  qrContainer.innerHTML = '';
  if (qrCodeInstance) {
    try { qrCodeInstance.clear(); } catch (_) {}
    qrCodeInstance = null;
  }

  // Small text goes straight into the QR. Long text/code is too big for a
  // QR code, so it is stored on the server and the QR holds a download link.
  let qrText  = text;
  let viaLink = false;
  if (new TextEncoder().encode(text).length > QR_MAX_DIRECT_BYTES) {
    qrBtn.disabled = true;
    try {
      const res  = await fetch(API_UPLOAD, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify({ text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.downloadUrl) throw new Error(data.error || `server error ${res.status}`);
      qrText  = data.downloadUrl;
      viaLink = true;
    } catch (err) {
      showToast('Text is too long for a QR code and the download link failed: ' + err.message, 'error');
      return;
    } finally {
      qrBtn.disabled = false;
    }
  }

  qrSizeWarning.textContent = viaLink
    ? 'Your text is too long to fit in a QR code, so this QR opens a download link instead. Scan it with a phone on the same Wi-Fi. The link expires in 1 hour.'
    : '';
  qrSizeWarning.hidden = !viaLink;

  try {
    qrCodeInstance = new QRCode(qrContainer, {
      text         : qrText,
      width        : QR_SIZE_PX,
      height       : QR_SIZE_PX,
      colorDark    : '#000000',
      colorLight   : '#ffffff',
      correctLevel : QRCode.CorrectLevel.M,
    });
  } catch (err) {
    showToast('Failed to generate QR: ' + err.message, 'error');
    return;
  }

  qrPanel.hidden = false;
  qrPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  showToast(viaLink ? 'QR code generated (download link)' : 'QR code generated!', 'success', 2000);
}

qrCloseBtn.addEventListener('click', () => {
  qrPanel.hidden = true;
});

// ── Download QR as PNG ──────────────────────────────────────
qrDownloadBtn.addEventListener('click', () => {
  const canvas = qrContainer.querySelector('canvas');
  if (!canvas) { showToast('Generate a QR code first.', 'warning'); return; }

  const link = document.createElement('a');
  link.download = `clipshare-qr-${Date.now()}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
  showToast('QR image downloaded', 'success', 2000);
});

// ════════════════════════════════════════════════════════════
//   QR SCANNER (html5-qrcode)
// ════════════════════════════════════════════════════════════

scanBtn.addEventListener('click', openScanner);
scannerCloseBtn.addEventListener('click', closeScanner);

function openScanner() {
  scannerModal.hidden = false;
  scannerResult.hidden = true;
  lastScannedText = '';

  // Prevent body scroll while modal is open
  document.body.style.overflow = 'hidden';

  startHtml5QrScanner();
}

async function startHtml5QrScanner(cameraId) {
  // Clean up any previous instance
  if (html5QrScanner) {
    try { await html5QrScanner.stop(); } catch (_) {}
    html5QrScanner = null;
    qrReaderContainer.innerHTML = '';
  }

  // Get available cameras first
  try {
    const devices = await Html5Qrcode.getCameras();
    availableCameras = devices;

    if (devices.length === 0) {
      showToast('No cameras found on this device.', 'error');
      closeScanner();
      return;
    }

    // Populate camera select on desktop (multiple cameras)
    if (devices.length > 1) {
      cameraSelect.innerHTML = '';
      devices.forEach(device => {
        const opt = document.createElement('option');
        opt.value = device.id;
        opt.textContent = device.label || `Camera ${device.id}`;
        cameraSelect.appendChild(opt);
      });
      cameraSelectRow.hidden = false;
      if (cameraId) cameraSelect.value = cameraId;
    } else {
      cameraSelectRow.hidden = true;
    }

    // Choose camera: prefer back-facing on mobile
    if (!cameraId) {
      const backCamera = devices.find(d =>
        /back|rear|environment/i.test(d.label)
      );
      activeCameraId = backCamera ? backCamera.id : devices[0].id;
    } else {
      activeCameraId = cameraId;
    }
  } catch (err) {
    showToast('Camera access error: ' + err, 'error');
    closeScanner();
    return;
  }

  // Create scanner
  html5QrScanner = new Html5Qrcode('qrReaderContainer');

  const config = {
    fps       : 12,
    qrbox     : { width: 240, height: 240 },
    aspectRatio: 1.0,
    showTorchButtonIfSupported: true,
  };

  try {
    await html5QrScanner.start(
      activeCameraId,
      config,
      onScanSuccess,
      /* onError */ null  // suppress per-frame errors from appearing in console spam
    );
  } catch (err) {
    showToast('Could not start camera: ' + err, 'error');
    closeScanner();
  }
}

function onScanSuccess(decodedText) {
  if (decodedText === lastScannedText) return; // debounce repeated reads
  lastScannedText = decodedText;

  // Pause scanner (visual confirmation before closing)
  if (html5QrScanner) {
    html5QrScanner.pause(true);
  }

  // Show result preview
  scannerResultPreview.textContent =
    decodedText.length > 200 ? decodedText.slice(0, 200) + '…' : decodedText;
  scannerResult.hidden = false;

  showToast('QR code scanned!', 'success', 2000);
}

// "Use This Text" button
scannerUseBtn.addEventListener('click', () => {
  if (!lastScannedText) return;
  textarea.value = lastScannedText;
  updateCharCount();

  // If online, push to server
  if (isOnline) debouncedPush(lastScannedText);

  closeScanner();
  showToast('Text pasted from QR scan!', 'success');
});

async function closeScanner() {
  document.body.style.overflow = '';
  scannerModal.hidden = true;
  scannerResult.hidden = true;
  cameraSelectRow.hidden = true;

  if (html5QrScanner) {
    try {
      await html5QrScanner.stop();
    } catch (_) {}
    try {
      html5QrScanner.clear();
    } catch (_) {}
    html5QrScanner = null;
    qrReaderContainer.innerHTML = '';
  }
}

// Switch camera button
switchCameraBtn.addEventListener('click', async () => {
  const selectedId = cameraSelect.value;
  if (selectedId && selectedId !== activeCameraId) {
    await startHtml5QrScanner(selectedId);
  }
});

// Close modal on backdrop click
scannerModal.addEventListener('click', (e) => {
  if (e.target === scannerModal) closeScanner();
});

// ════════════════════════════════════════════════════════════
//   KEYBOARD SHORTCUTS
// ════════════════════════════════════════════════════════════

document.addEventListener('keydown', (e) => {
  const isMac = navigator.platform.includes('Mac');
  const mod   = isMac ? e.metaKey : e.ctrlKey;

  // Ctrl/Cmd + Shift + G → Generate QR
  if (mod && e.shiftKey && e.key === 'G') {
    e.preventDefault();
    generateQR();
  }
  // Escape → close scanner modal / QR panel
  if (e.key === 'Escape') {
    if (!scannerModal.hidden) closeScanner();
    if (!qrPanel.hidden) qrPanel.hidden = true;
  }
});

// ════════════════════════════════════════════════════════════
//   NETWORK ONLINE / OFFLINE EVENTS
// ════════════════════════════════════════════════════════════

window.addEventListener('online', () => {
  showToast('Back online! Reconnecting to server…', 'success');
  applyNetworkStatus(true);
});

window.addEventListener('offline', () => {
  showToast('Network lost. Switching to offline mode.', 'warning');
  applyNetworkStatus(false);
});

// ════════════════════════════════════════════════════════════
//   PAGE VISIBILITY – reconnect SSE when tab regains focus
// ════════════════════════════════════════════════════════════

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && isOnline) {
    if (!sseSource || sseSource.readyState === EventSource.CLOSED) {
      startSSE();
    }
  }
});

// ════════════════════════════════════════════════════════════
//   INITIALISE
// ════════════════════════════════════════════════════════════

function init() {
  updateCharCount();
  applyNetworkStatus(navigator.onLine);

  console.log(`[ClipShare] Initialized | Session: ${SESSION_ID} | Online: ${navigator.onLine}`);
}

init();

/* ClipShare offline multi-QR file transfer.
 * This module never uploads file contents. Each QR contains one numbered
 * chunk plus transfer metadata; the receiver reassembles chunks in memory.
 */
(function () {
  'use strict';

  const PREFIX = 'CLIPSHARE1:';
  const CHUNK_BYTES = 500;
  const MAX_FILE_BYTES = 50 * 1024;

  let outgoing = null;
  const incoming = new Map();

  function bytesToBase64(bytes) {
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode(...bytes.subarray(i, i + step));
    }
    return btoa(binary);
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function sha256(bytes) {
    if (!crypto.subtle) throw new Error('Secure browser context required for file verification.');
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  }

  function safeFilename(name) {
    const cleaned = String(name || 'clipshare-file.txt').replace(/[\\/<>:"|?*\x00-\x1f]/g, '_').trim();
    return cleaned.slice(0, 120) || 'clipshare-file.txt';
  }

  async function createTransfer(file) {
    if (!file) throw new Error('Choose a file first.');
    if (file.size === 0) throw new Error('Empty files are not supported yet.');
    if (file.size > MAX_FILE_BYTES) {
      throw new Error('This first version supports files up to 50 KB. Larger files would require too many QR scans.');
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const transferId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
    const checksum = await sha256(bytes);
    const total = Math.ceil(bytes.length / CHUNK_BYTES);
    const chunks = [];
    for (let index = 0; index < total; index++) {
      const part = bytes.slice(index * CHUNK_BYTES, Math.min((index + 1) * CHUNK_BYTES, bytes.length));
      const payload = {
        v: 1, id: transferId, name: safeFilename(file.name), type: file.type || 'application/octet-stream',
        size: bytes.length, total, index, checksum, data: bytesToBase64(part)
      };
      chunks.push(PREFIX + JSON.stringify(payload));
    }
    outgoing = { name: safeFilename(file.name), size: bytes.length, chunks, index: 0 };
    return getOutgoing();
  }

  function getOutgoing() {
    if (!outgoing) return null;
    return { name: outgoing.name, size: outgoing.size, total: outgoing.chunks.length, index: outgoing.index, payload: outgoing.chunks[outgoing.index] };
  }

  function moveOutgoing(delta) {
    if (!outgoing) return null;
    outgoing.index = Math.max(0, Math.min(outgoing.chunks.length - 1, outgoing.index + delta));
    return getOutgoing();
  }

  function isChunk(payload) {
    return typeof payload === 'string' && payload.startsWith(PREFIX);
  }

  async function receiveChunk(payload) {
    if (!isChunk(payload)) return { kind: 'not-chunk' };
    let chunk;
    try { chunk = JSON.parse(payload.slice(PREFIX.length)); }
    catch (_) { throw new Error('This ClipShare QR is damaged or invalid.'); }

    if (chunk.v !== 1 || typeof chunk.id !== 'string' || !Number.isInteger(chunk.index) ||
        !Number.isInteger(chunk.total) || chunk.total < 1 || chunk.total > 1000 ||
        chunk.index < 0 || chunk.index >= chunk.total || typeof chunk.data !== 'string' ||
        !Number.isInteger(chunk.size) || chunk.size < 1 || chunk.size > MAX_FILE_BYTES ||
        typeof chunk.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(chunk.checksum)) {
      throw new Error('Invalid ClipShare file chunk.');
    }

    let transfer = incoming.get(chunk.id);
    if (!transfer) {
      transfer = { id: chunk.id, name: safeFilename(chunk.name), type: chunk.type || 'application/octet-stream',
        size: chunk.size, total: chunk.total, checksum: chunk.checksum, chunks: new Map() };
      incoming.set(chunk.id, transfer);
    }
    if (transfer.total !== chunk.total || transfer.size !== chunk.size || transfer.checksum !== chunk.checksum) {
      throw new Error('Chunk metadata does not match the existing transfer.');
    }

    const bytes = base64ToBytes(chunk.data);
    if (bytes.length > CHUNK_BYTES || (chunk.index < chunk.total - 1 && bytes.length !== CHUNK_BYTES)) {
      throw new Error('Invalid chunk length.');
    }
    const duplicate = transfer.chunks.has(chunk.index);
    if (!duplicate) transfer.chunks.set(chunk.index, bytes);

    const received = transfer.chunks.size;
    const missing = [];
    for (let i = 0; i < transfer.total; i++) if (!transfer.chunks.has(i)) missing.push(i + 1);

    if (received !== transfer.total) {
      return { kind: 'chunk', id: chunk.id, name: transfer.name, received, total: transfer.total, duplicate, missing };
    }

    const all = new Uint8Array(transfer.size);
    let offset = 0;
    for (let i = 0; i < transfer.total; i++) {
      const part = transfer.chunks.get(i);
      all.set(part, offset);
      offset += part.length;
    }
    if (offset !== transfer.size) {
      incoming.delete(chunk.id);
      throw new Error('The chunks do not match the original file size. Please scan again.');
    }
    const actual = await sha256(all);
    if (actual !== transfer.checksum) {
      incoming.delete(chunk.id);
      throw new Error('File verification failed. Please scan all QR codes again.');
    }

    const blob = new Blob([all], { type: transfer.type });
    const url = URL.createObjectURL(blob);
    incoming.delete(chunk.id);
    return { kind: 'complete', id: chunk.id, name: transfer.name, size: all.length, url, checksum: actual };
  }

  function saveFile(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = safeFilename(filename);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  window.ClipShareOffline = {
    createTransfer, getOutgoing, moveOutgoing, isChunk, receiveChunk, saveFile,
    limits: { maxFileBytes: MAX_FILE_BYTES, chunkBytes: CHUNK_BYTES }
  };
})();

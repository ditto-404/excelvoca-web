// Private GitHub repo holding progress.json/session.json (never the public code
// repo — those files are personal study data).
const REPO_OWNER = 'ditto-404';
const REPO_NAME = 'excelvoca-data';
const DATA_PATH = 'data'; // folder inside that repo holding progress.json etc.
const BRANCH = 'main';

const TOKEN_BLOB_KEY = 'excelvoca_gh_token_enc';
const SETTINGS_KEY = 'excelvoca_settings';
const PENDING_KEY = 'excelvoca_pending_sync';

// Sync pacing. Saving straight through to the Contents API meant one commit per
// PUT, and persistAll() fires a progress + session write after every answer — so
// one question cost two commits and the data repo collected 1,546 auto-sync
// commits in two weeks. Writes now land in localStorage instantly and are pushed
// as a SINGLE commit once the user stops answering, so a whole study run is one
// commit instead of hundreds.
const FLUSH_IDLE_MS = 30000; // push once answering pauses for 30s
const FLUSH_MAX_MS = 300000; // ...but never sit on changes longer than 5 min

/**
 * Drop-in replacement for src/main/preload.js's `window.excelvoca` bridge,
 * backed by the GitHub API (a private repo) instead of Electron IPC/fs — so
 * every module under src/ (wordRepository, progressStore, sessionStore,
 * settingsStore, dailyLogStore, and everything in src/game/) works unmodified.
 * See CLAUDE.md's "Web version" section for why GitHub instead of OneDrive.
 *
 * The real GitHub token is entered once (setupToken) and stored PIN-encrypted
 * (AES-GCM via Web Crypto) in localStorage — never in plaintext, and never in
 * the source code, since this repo is public. Every later visit just needs the
 * short PIN (unlock) instead of retyping the long token. This is a convenience
 * gate, not real security: a 4-digit PIN is only 10,000 combinations, so it
 * only protects against a casual glance at the page, not a determined attacker
 * with access to the encrypted blob.
 */

let cachedToken = '';

function getToken() {
  return cachedToken;
}

export function isSignedIn() {
  return Boolean(cachedToken);
}

export function hasStoredToken() {
  return Boolean(localStorage.getItem(TOKEN_BLOB_KEY));
}

async function deriveKey(pin, salt) {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, [
    'deriveKey'
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** First-time setup: encrypts `token` with `pin` and stores the blob (not the token) in localStorage. */
export async function setupToken(token, pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pin, salt);
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(token.trim()));
  const blob = { salt: Array.from(salt), iv: Array.from(iv), cipher: Array.from(new Uint8Array(cipherBuf)) };
  localStorage.setItem(TOKEN_BLOB_KEY, JSON.stringify(blob));
  cachedToken = token.trim();
}

/** Decrypts the stored blob with `pin`; returns false (without throwing) if the PIN is wrong. */
export async function unlock(pin) {
  const raw = localStorage.getItem(TOKEN_BLOB_KEY);
  if (!raw) return false;
  try {
    const blob = JSON.parse(raw);
    const key = await deriveKey(pin, new Uint8Array(blob.salt));
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(blob.iv) },
      key,
      new Uint8Array(blob.cipher).buffer
    );
    cachedToken = new TextDecoder().decode(plainBuf);
    // A previous visit may have closed before its last flush landed.
    flush();
    return true;
  } catch {
    return false;
  }
}

export function signOut() {
  localStorage.removeItem(TOKEN_BLOB_KEY);
  cachedToken = '';
}

const REPO_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;
const CONTENTS_API = `${REPO_API}/contents/${DATA_PATH}`;

async function ghFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: 'application/vnd.github+json',
      ...(options.headers || {})
    }
  });
  if (res.status === 401) {
    signOut();
    throw new Error('GitHub 토큰이 잘못됐거나 만료됐습니다. 다시 연결해주세요.');
  }
  return res;
}

function ghApi(path, body, method = 'POST') {
  return ghFetch(`${REPO_API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function b64EncodeUtf8(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function b64DecodeUtf8(str) {
  return decodeURIComponent(escape(atob(str.replace(/\n/g, ''))));
}

async function ghGetFile(path) {
  const res = await ghFetch(`${CONTENTS_API}/${path}`);
  if (res.status === 404) return { text: null };
  if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status}`);
  const json = await res.json();
  return { text: b64DecodeUtf8(json.content) };
}

/**
 * Writes every changed file as ONE commit via the Git Data API (blob -> tree ->
 * commit -> ref), instead of one Contents-API PUT (= one commit) per file.
 * A `null` value deletes that file. No-ops when the resulting tree is unchanged,
 * so a flush with nothing new never leaves an empty commit behind.
 */
async function commitFiles(files, message) {
  const refRes = await ghFetch(`${REPO_API}/git/ref/heads/${BRANCH}`);
  if (!refRes.ok) throw new Error(`GitHub ref 조회 실패: ${refRes.status}`);
  const baseSha = (await refRes.json()).object.sha;

  const baseCommitRes = await ghFetch(`${REPO_API}/git/commits/${baseSha}`);
  if (!baseCommitRes.ok) throw new Error(`GitHub commit 조회 실패: ${baseCommitRes.status}`);
  const baseTreeSha = (await baseCommitRes.json()).tree.sha;

  const tree = [];
  for (const [fileName, value] of Object.entries(files)) {
    const path = `${DATA_PATH}/${fileName}`;
    if (value === null) {
      tree.push({ path, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    const blobRes = await ghApi('/git/blobs', {
      content: b64EncodeUtf8(JSON.stringify(value, null, 2)),
      encoding: 'base64'
    });
    if (!blobRes.ok) throw new Error(`GitHub blob 생성 실패: ${blobRes.status}`);
    tree.push({ path, mode: '100644', type: 'blob', sha: (await blobRes.json()).sha });
  }

  const treeRes = await ghApi('/git/trees', { base_tree: baseTreeSha, tree });
  if (!treeRes.ok) throw new Error(`GitHub tree 생성 실패: ${treeRes.status}`);
  const newTreeSha = (await treeRes.json()).sha;
  if (newTreeSha === baseTreeSha) return true; // nothing actually changed

  const commitRes = await ghApi('/git/commits', { message, tree: newTreeSha, parents: [baseSha] });
  if (!commitRes.ok) throw new Error(`GitHub commit 생성 실패: ${commitRes.status}`);
  const newCommitSha = (await commitRes.json()).sha;

  const refUpdate = await ghApi(`/git/refs/heads/${BRANCH}`, { sha: newCommitSha }, 'PATCH');
  if (!refUpdate.ok) throw new Error(`GitHub ref 갱신 실패: ${refUpdate.status}`);
  return true;
}

// --- pending write buffer -------------------------------------------------
// Every save is durable the moment it happens (mirrored to localStorage
// synchronously), so a crash or a closed tab before the next flush loses
// nothing — the buffer is replayed on the next unlock(). The in-memory copy is
// the source of truth; localStorage is only its backup across page loads.

let pendingFiles = {}; // fileName -> value (null = delete the file)
let pendingWrites = 0;

try {
  const raw = localStorage.getItem(PENDING_KEY);
  const saved = raw ? JSON.parse(raw) : null;
  if (saved && saved.files) {
    pendingFiles = saved.files;
    pendingWrites = saved.writes || 0;
  }
} catch {
  /* unreadable buffer: start clean rather than block startup */
}

function persistPending() {
  try {
    if (!Object.keys(pendingFiles).length) localStorage.removeItem(PENDING_KEY);
    else localStorage.setItem(PENDING_KEY, JSON.stringify({ files: pendingFiles, writes: pendingWrites }));
  } catch {
    /* quota/private-mode: the in-memory buffer still carries the data */
  }
}

let idleTimer = null;
let maxTimer = null;
let flushing = false;
let reflushQueued = false;

function clearTimers() {
  clearTimeout(idleTimer);
  clearTimeout(maxTimer);
  idleTimer = null;
  maxTimer = null;
}

function scheduleFlush() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => flush(), FLUSH_IDLE_MS);
  if (!maxTimer) maxTimer = setTimeout(() => flush(), FLUSH_MAX_MS);
}

function queueWrite(fileName, value) {
  pendingFiles[fileName] = value;
  pendingWrites += 1;
  persistPending();
  scheduleFlush();
  return Promise.resolve(true);
}

/** Pushes everything buffered so far as one commit. Safe to call at any time. */
export async function flush() {
  if (flushing) {
    reflushQueued = true;
    return true;
  }
  if (!Object.keys(pendingFiles).length) {
    clearTimers();
    return true;
  }
  // Not signed in yet: keep the buffer and retry after the next unlock().
  if (!isSignedIn()) return false;

  clearTimers();
  flushing = true;
  const sending = { ...pendingFiles };
  const sendingWrites = pendingWrites;
  try {
    await commitFiles(sending, `sync: 학습 진행 상황 (${sendingWrites}건 반영)`);
    // Drop only what this flush carried — a save that landed mid-flush stays
    // queued, which the identity check below distinguishes.
    for (const [fileName, value] of Object.entries(sending)) {
      if (pendingFiles[fileName] === value) delete pendingFiles[fileName];
    }
    pendingWrites = Object.keys(pendingFiles).length ? Math.max(pendingWrites - sendingWrites, 1) : 0;
    persistPending();
    return true;
  } catch (err) {
    // Buffer is untouched, so the next flush retries it.
    console.warn('[excelvoca] GitHub 동기화 실패, 다음 시도에 재전송합니다:', err);
    scheduleFlush();
    return false;
  } finally {
    flushing = false;
    if (reflushQueued) {
      reflushQueued = false;
      scheduleFlush();
    }
  }
}

// Leaving the page is the one moment worth pushing immediately; if it does not
// finish, the localStorage buffer replays on the next visit.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flush();
});
window.addEventListener('pagehide', () => flush());

async function loadJson(fileName) {
  // An unflushed buffer is newer than whatever is on GitHub.
  if (fileName in pendingFiles) return pendingFiles[fileName];

  const { text } = await ghGetFile(fileName);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

window.excelvoca = {
  // Word list is static app content, not personal data — served straight off
  // the public GitHub Pages site instead of the private data repo/API.
  loadWords: async () => {
    const res = await fetch('../data/teps_words.csv');
    if (!res.ok) throw new Error('teps_words.csv를 불러올 수 없습니다.');
    return res.text();
  },
  loadProgress: () => loadJson('progress.json'),
  saveProgress: (data) => queueWrite('progress.json', data),
  loadSession: () => loadJson('session.json'),
  saveSession: (data) => queueWrite('session.json', data),
  clearSession: () => queueWrite('session.json', null),
  /** Push buffered study data now (end of a run, or before signing out). */
  flush,
  // Settings (autoResume, shortcuts) are per-device, not something that needs
  // to follow you between devices, so they just live in this browser's storage.
  loadSettings: async () => {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : null;
  },
  saveSettings: (data) => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
    return Promise.resolve(true);
  },
  // study_log.csv is a desktop-only, human-facing export (see CLAUDE.md) — not
  // worth round-tripping through the GitHub API from here.
  upsertDailyLog: () => Promise.resolve(true)
};

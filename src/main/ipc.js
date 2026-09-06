const { app, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(app.getAppPath(), 'data');
const WORDS_CSV_PATH = path.join(DATA_DIR, 'teps_words.csv');
const GITHUB_CONFIG_PATH = path.join(DATA_DIR, 'github-sync.json');

// Progress/session/settings live in the project's own data/ folder (next to
// teps_words.csv) rather than the OS per-user profile, so it's all in one
// visible place instead of scattered into %APPDATA%.
function dataFile(name) {
  return path.join(DATA_DIR, name);
}

function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

// Write to a temp file then rename, so a crash mid-write can't corrupt the real file.
function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

// --- GitHub sync (progress.json / session.json only) -----------------------
// Lets the web version (web/githubStorage.js, on a phone or a browser with no
// OneDrive access) share the exact same progress/session as this desktop app,
// via a private GitHub repo instead of a second database. Configured by
// hand-editing data/github-sync.json (never committed anywhere) with a
// personal access token + the private repo's owner/name. If that file is
// missing/unfilled, everything falls back to local-file-only behavior exactly
// as before this existed.
function loadGithubConfig() {
  const cfg = readJsonSafe(GITHUB_CONFIG_PATH);
  if (!cfg || !cfg.token || cfg.token.startsWith('YOUR_')) return null;
  return cfg;
}

function githubApiBase(cfg) {
  return `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/data`;
}

async function ghRequest(cfg, filePath, options = {}) {
  return fetch(`${githubApiBase(cfg)}/${filePath}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      ...(options.headers || {})
    }
  });
}

async function ghGetFile(cfg, filePath) {
  const res = await ghRequest(cfg, filePath);
  if (res.status === 404) return { text: null, sha: null };
  if (!res.ok) throw new Error(`GitHub GET ${filePath} failed: ${res.status}`);
  const json = await res.json();
  return { text: Buffer.from(json.content, 'base64').toString('utf-8'), sha: json.sha };
}

// Writing through the Contents API costs one commit per PUT, and persistAll()
// saves progress.json + session.json after every single answer — which is how
// the data repo collected 1,546 auto-sync commits in two weeks. So saves no
// longer push immediately: the local file (written atomically above) is the
// durable copy, and GitHub receives one commit per quiet spell covering every
// file that changed.
const SYNC_BRANCH = 'main';
const SYNC_IDLE_MS = 30000; // push once saving pauses for 30s
const SYNC_MAX_MS = 300000; // ...but never sit on changes longer than 5 min

function pendingFile() {
  return dataFile('.github-pending.json');
}

function readPending() {
  const pending = readJsonSafe(pendingFile());
  if (!pending || !pending.files) return { files: {}, writes: 0, nextSeq: 1 };
  return { writes: 0, nextSeq: 1, ...pending };
}

// Each entry carries a sequence number so a save that lands *during* a flush is
// recognisably newer than the one just pushed, and survives the cleanup below.
function markPending(fileName, action) {
  const pending = readPending();
  pending.files[fileName] = { action, seq: pending.nextSeq };
  pending.nextSeq += 1;
  pending.writes += 1;
  writeJsonAtomic(pendingFile(), pending);
  scheduleGithubSync();
}

function isPending(fileName) {
  return Boolean(readPending().files[fileName]);
}

async function ghCommitFiles(cfg, files, message) {
  const repoBase = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}`;
  const req = (route, options = {}) =>
    fetch(`${repoBase}${route}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: 'application/vnd.github+json',
        ...(options.headers || {})
      }
    });
  const send = (route, body, method = 'POST') =>
    req(route, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const fail = (what, status) => {
    const err = new Error(`GitHub ${what} failed: ${status}`);
    err.status = status;
    return err;
  };

  const refRes = await req(`/git/ref/heads/${SYNC_BRANCH}`);
  if (!refRes.ok) throw fail('ref read', refRes.status);
  const baseSha = (await refRes.json()).object.sha;

  const baseCommitRes = await req(`/git/commits/${baseSha}`);
  if (!baseCommitRes.ok) throw fail('commit read', baseCommitRes.status);
  const baseTreeSha = (await baseCommitRes.json()).tree.sha;

  const tree = [];
  for (const [fileName, value] of Object.entries(files)) {
    const treePath = `data/${fileName}`;
    if (value === null) {
      tree.push({ path: treePath, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    const blobRes = await send('/git/blobs', {
      content: Buffer.from(JSON.stringify(value, null, 2), 'utf-8').toString('base64'),
      encoding: 'base64'
    });
    if (!blobRes.ok) throw fail('blob create', blobRes.status);
    tree.push({ path: treePath, mode: '100644', type: 'blob', sha: (await blobRes.json()).sha });
  }

  const treeRes = await send('/git/trees', { base_tree: baseTreeSha, tree });
  if (!treeRes.ok) throw fail('tree create', treeRes.status);
  const newTreeSha = (await treeRes.json()).sha;
  if (newTreeSha === baseTreeSha) return; // nothing actually changed

  const commitRes = await send('/git/commits', { message, tree: newTreeSha, parents: [baseSha] });
  if (!commitRes.ok) throw fail('commit create', commitRes.status);
  const newCommitSha = (await commitRes.json()).sha;

  const refUpdate = await send(`/git/refs/heads/${SYNC_BRANCH}`, { sha: newCommitSha }, 'PATCH');
  if (!refUpdate.ok) {
    // 422 here means another writer (e.g. the web app) moved the branch first;
    // surface it as 409 so withRetryOn409 rebuilds the commit on the new head.
    throw fail('ref update', refUpdate.status === 422 ? 409 : refUpdate.status);
  }
}

// Serialize every GitHub call from this process through one queue, and retry
// once on 409 in case another *process* (e.g. the web app) wins a race.
let githubQueue = Promise.resolve();

function enqueueGithub(task) {
  const run = githubQueue.then(task, task);
  githubQueue = run.then(
    () => {},
    () => {}
  );
  return run;
}

async function withRetryOn409(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.status !== 409) throw err;
    return fn();
  }
}

let idleTimer = null;
let maxTimer = null;

function clearSyncTimers() {
  clearTimeout(idleTimer);
  clearTimeout(maxTimer);
  idleTimer = null;
  maxTimer = null;
}

function scheduleGithubSync() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    flushGithub();
  }, SYNC_IDLE_MS);
  if (!maxTimer) {
    maxTimer = setTimeout(() => {
      flushGithub();
    }, SYNC_MAX_MS);
  }
}

/**
 * Pushes every buffered change as ONE commit. Called on a timer and on quit;
 * safe to call at any time. On failure the pending marker is left alone so the
 * next flush retries, and the local files are already durable either way.
 */
async function flushGithub() {
  clearSyncTimers();
  const cfg = loadGithubConfig();
  if (!cfg) return true;

  const pending = readPending();
  const names = Object.keys(pending.files);
  if (!names.length) return true;

  const files = {};
  for (const name of names) {
    if (pending.files[name].action === 'delete') {
      files[name] = null;
    } else {
      const local = readJsonSafe(dataFile(name));
      if (local !== null) files[name] = local; // a write whose file vanished has nothing to push
    }
  }

  try {
    if (Object.keys(files).length) {
      await enqueueGithub(() =>
        withRetryOn409(() => ghCommitFiles(cfg, files, `sync: 학습 진행 상황 (${pending.writes}건 반영)`))
      );
    }
    const after = readPending();
    for (const name of names) {
      if (after.files[name] && after.files[name].seq === pending.files[name].seq) delete after.files[name];
    }
    after.writes = Object.keys(after.files).length ? after.writes : 0;
    writeJsonAtomic(pendingFile(), after);
    return true;
  } catch (err) {
    console.error('GitHub 동기화 실패, 다음 시도에 재전송합니다 (로컬 파일은 이미 저장됨):', err);
    scheduleGithubSync();
    return false;
  }
}

const DAILY_LOG_HEADER = ['날짜', '학습단어수', '정답수', '정확도(%)', '최고콤보', '마스터단어수', '복습필요단어수', '직급'];
const DAILY_LOG_KEYS = ['date', 'studied', 'correct', 'accuracy', 'longestCombo', 'mastered', 'needsReview', 'rank'];

function csvEscape(value) {
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/** Upserts today's row in data/study_log.csv — a plain, Excel-openable daily summary log. */
function upsertDailyLog(row) {
  const filePath = dataFile('study_log.csv');
  let lines = [];
  if (fs.existsSync(filePath)) {
    let raw = fs.readFileSync(filePath, 'utf-8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
  }
  if (lines.length === 0) {
    lines = [DAILY_LOG_HEADER.join(',')];
  }

  const newLine = DAILY_LOG_KEYS.map((key) => csvEscape(row[key])).join(',');
  const rowIndex = lines.findIndex((line) => line.startsWith(`${row.date},`));
  if (rowIndex >= 0) {
    lines[rowIndex] = newLine;
  } else {
    lines.push(newLine);
  }

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `﻿${lines.join('\n')}\n`, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function registerIpcHandlers() {
  ipcMain.handle('words:load', () => {
    return fs.readFileSync(WORDS_CSV_PATH, 'utf-8');
  });

  ipcMain.handle('progress:load', async () => {
    const cfg = loadGithubConfig();
    // An unflushed local change is newer than whatever GitHub still holds.
    if (cfg && !isPending('progress.json')) {
      try {
        const { text } = await ghGetFile(cfg, 'progress.json');
        if (text) {
          const data = JSON.parse(text);
          writeJsonAtomic(dataFile('progress.json'), data); // keep a local cache too
          return data;
        }
      } catch (err) {
        console.error('GitHub progress:load failed, falling back to local file:', err);
      }
    }
    return readJsonSafe(dataFile('progress.json'));
  });

  ipcMain.handle('progress:save', async (event, data) => {
    writeJsonAtomic(dataFile('progress.json'), data);
    if (loadGithubConfig()) markPending('progress.json', 'write');
    return true;
  });

  ipcMain.handle('session:load', async () => {
    const cfg = loadGithubConfig();
    // An unflushed local change is newer than whatever GitHub still holds.
    if (cfg && !isPending('session.json')) {
      try {
        const { text } = await ghGetFile(cfg, 'session.json');
        if (text) {
          const data = JSON.parse(text);
          writeJsonAtomic(dataFile('session.json'), data);
          return data;
        }
      } catch (err) {
        console.error('GitHub session:load failed, falling back to local file:', err);
      }
    }
    return readJsonSafe(dataFile('session.json'));
  });

  ipcMain.handle('session:save', async (event, data) => {
    writeJsonAtomic(dataFile('session.json'), data);
    if (loadGithubConfig()) markPending('session.json', 'write');
    return true;
  });

  ipcMain.handle('session:clear', async () => {
    const filePath = dataFile('session.json');
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    if (loadGithubConfig()) markPending('session.json', 'delete');
    return true;
  });

  ipcMain.handle('settings:load', () => {
    return readJsonSafe(dataFile('settings.json'));
  });

  ipcMain.handle('settings:save', (event, data) => {
    writeJsonAtomic(dataFile('settings.json'), data);
    return true;
  });

  ipcMain.handle('stats:upsertDailyLog', (event, row) => {
    upsertDailyLog(row);
    return true;
  });
}

module.exports = { registerIpcHandlers, flushGithub };

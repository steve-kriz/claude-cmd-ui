const { app, BrowserWindow, dialog, ipcMain, globalShortcut, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { execFile } = require('child_process');
const { spawnShell } = require('./lib/pty');
const envStore = require('./lib/env-store');
const aws = require('./lib/aws');
const cloudLogs = require('./lib/cloud-logs');
const slack = require('./lib/slack');

const ptys = new Map();
let mainWindow = null;
let sessionFilePath = null;

async function readSession() {
  if (!sessionFilePath) return { folders: [] };
  try {
    const buf = await fsp.readFile(sessionFilePath, 'utf8');
    const data = JSON.parse(buf);
    const folders = Array.isArray(data.folders) ? data.folders.filter((s) => typeof s === 'string' && s.length > 0) : [];
    return { folders };
  } catch (_) {
    return { folders: [] };
  }
}

async function writeSession(data) {
  if (!sessionFilePath) return;
  const tmp = sessionFilePath + '.tmp';
  const payload = JSON.stringify({ folders: Array.isArray(data.folders) ? data.folders : [] }, null, 2);
  await fsp.writeFile(tmp, payload, 'utf8');
  await fsp.rename(tmp, sessionFilePath);
}

function execGit(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error((stderr || err.message || '').trim()));
      resolve(stdout);
    });
  });
}

function execCapture(cmd, args, cwd, onLine) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const out = (stdout || '').toString();
      const errOut = (stderr || '').toString();
      if (onLine) {
        for (const line of out.split(/\r?\n/)) if (line) onLine(line);
        for (const line of errOut.split(/\r?\n/)) if (line) onLine(line);
      }
      resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
        stdout: out,
        stderr: errOut,
        error: err ? (err.message || '').trim() : null
      });
    });
  });
}

async function runStep(label, cmd, args, cwd, onLine) {
  if (onLine) onLine(`▶ ${label}: ${cmd} ${args.map((a) => /\s/.test(a) ? `"${a}"` : a).join(' ')}`);
  const res = await execCapture(cmd, args, cwd, onLine);
  if (!res.ok) {
    const msg = (res.stderr || res.error || `${cmd} failed`).trim();
    const e = new Error(`${label}: ${msg}`);
    e.step = label;
    e.code = res.code;
    throw e;
  }
  return res;
}

function globalShortcut_register(win) {
  try {
    globalShortcut.register('Control+Shift+I', () => {
      if (win && !win.isDestroyed()) win.webContents.toggleDevTools();
    });
    globalShortcut.register('F12', () => {
      if (win && !win.isDestroyed()) win.webContents.toggleDevTools();
    });
  } catch (_) {}
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 860,
    backgroundColor: '#1e1e1e',
    title: 'Claude CMD UI',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  const wc = mainWindow.webContents;
  wc.on('render-process-gone', (_e, details) => {
    console.error('[renderer crashed]', details);
  });
  wc.on('preload-error', (_e, preloadPath, error) => {
    console.error('[preload error]', preloadPath, error);
  });
  wc.on('console-message', (_e, level, message, line, sourceId) => {
    const tag = ['VERBOSE', 'INFO', 'WARNING', 'ERROR'][level] || `L${level}`;
    console.log(`[renderer:${tag}] ${sourceId}:${line} ${message}`);
  });
  if (process.env.OPEN_DEVTOOLS !== '0') {
    wc.openDevTools({ mode: 'detach' });
  }
  globalShortcut_register(mainWindow);

  mainWindow.on('closed', () => {
    for (const proc of ptys.values()) {
      try { proc.kill(); } catch (_) {}
    }
    ptys.clear();
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Load secrets from the project .env before anything that reads them.
  envStore.setEnvPath(path.join(app.getAppPath(), '.env'));
  envStore.loadIntoProcessEnv();
  const userData = app.getPath('userData');
  aws.setUserDataDir(userData);
  sessionFilePath = path.join(userData, 'session.json');
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('dialog:pickFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select project folder'
  });
  if (result.canceled || !result.filePaths.length) return null;
  return { path: result.filePaths[0] };
});

ipcMain.handle('pty:spawn', (_evt, { id, shell, cwd, cols, rows, worker, cliCommand }) => {
  if (ptys.has(id)) {
    try { ptys.get(id).kill(); } catch (_) {}
    ptys.delete(id);
  }
  const proc = spawnShell({ shell, cwd, cols, rows, worker, cliCommand });
  ptys.set(id, proc);
  proc.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:data', { id, data });
    }
  });
  proc.onExit(({ exitCode }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:exit', { id, exitCode });
    }
    ptys.delete(id);
  });
  return { ok: true };
});

ipcMain.handle('pty:write', (_evt, { id, data }) => {
  const proc = ptys.get(id);
  if (proc) proc.write(data);
});

ipcMain.handle('pty:resize', (_evt, { id, cols, rows }) => {
  const proc = ptys.get(id);
  if (!proc) return;
  try { proc.resize(cols, rows); } catch (_) {}
});

ipcMain.handle('pty:kill', (_evt, { id }) => {
  const proc = ptys.get(id);
  if (proc) {
    try { proc.kill(); } catch (_) {}
    ptys.delete(id);
  }
});

// Sign in to the SSO portal and return every account the user can reach.
ipcMain.handle('aws:listEnvironments', async () => {
  try {
    const onLine = (line) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('aws:log', { line });
      }
    };
    const accounts = await aws.listEnvironments(onLine);
    return { ok: true, accounts };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// List the roles available in a specific account.
ipcMain.handle('aws:listRoles', async (_evt, { accountId }) => {
  try {
    const onLine = (line) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('aws:log', { line });
      }
    };
    const result = await aws.listRolesForAccount(accountId, onLine);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Apply a role for a discovered account and write the token to the chosen profile.
ipcMain.handle('aws:applyRole', async (_evt, { accountId, accountName, role, profile }) => {
  try {
    const onLine = (line) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('aws:log', { line });
      }
    };
    const status = await aws.applyAccountRole({ accountId, accountName, role, targetProfile: profile }, onLine);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('aws:status', status);
    }
    return { ok: true, status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('aws:status', async () => aws.readStatus());

ipcMain.handle('env:get', async (_evt, { key }) => {
  try { return { ok: true, value: envStore.get(key) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('env:set', async (_evt, { key, value }) => {
  try { await envStore.set(key, value); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('aws:listProfiles', async () => {
  try {
    return { ok: true, profiles: await aws.listCredentialProfiles() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('session:load', async () => {
  return await readSession();
});

ipcMain.handle('session:save', async (_evt, { folders }) => {
  try {
    await writeSession({ folders });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('window:setTitle', (_evt, { title }) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle(title || 'Claude CMD UI');
  }
});

ipcMain.handle('fs:findByExt', async (_evt, { root, ext, excludeDirs }) => {
  try {
    if (!root) throw new Error('root required');
    const lowerExt = ('' + (ext || '')).toLowerCase();
    if (!lowerExt) throw new Error('ext required');
    const defaultSkip = ['node_modules', '.git'];
    const skip = new Set((Array.isArray(excludeDirs) ? excludeDirs : defaultSkip).map((d) => d.toLowerCase()));
    const files = [];
    const dirs = new Set();
    async function walk(dir) {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (_) {
        return false;
      }
      let hasMatch = false;
      for (const e of entries) {
        if (e.isDirectory()) {
          if (skip.has(e.name.toLowerCase())) continue;
          const sub = path.join(dir, e.name);
          if (await walk(sub)) hasMatch = true;
        } else if (e.isFile()) {
          if (e.name.toLowerCase().endsWith(lowerExt)) {
            files.push(path.join(dir, e.name));
            hasMatch = true;
          }
        }
      }
      if (hasMatch) dirs.add(dir.toLowerCase());
      return hasMatch;
    }
    await walk(root);
    return { ok: true, files, dirs: Array.from(dirs) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

const GREP_SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', '.next',
  '.nuxt', '.turbo', '.cache', '.parcel-cache', 'coverage', '.venv', 'venv',
  '__pycache__', 'target', '.gradle', '.idea', '.vscode'
]);
const GREP_MAX_FILE_BYTES = 1.5 * 1024 * 1024;
const GREP_MAX_RESULTS = 500;
const GREP_MAX_HITS_PER_FILE = 5;

ipcMain.handle('fs:grep', async (_evt, { root, query }) => {
  try {
    if (!root) throw new Error('root required');
    const q = ('' + (query || '')).trim();
    if (!q) return { ok: true, results: [], truncated: false };
    const qLower = q.toLowerCase();
    const results = [];
    let truncated = false;
    async function walk(dir) {
      if (truncated) return;
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
      catch (_) { return; }
      for (const e of entries) {
        if (truncated) return;
        const sub = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (GREP_SKIP_DIRS.has(e.name.toLowerCase())) continue;
          if (e.name.startsWith('.') && GREP_SKIP_DIRS.has(e.name.toLowerCase())) continue;
          await walk(sub);
          continue;
        }
        if (!e.isFile()) continue;
        const nameMatches = e.name.toLowerCase().includes(qLower);
        const ext = path.extname(e.name).toLowerCase();
        const skipContent = BINARY_EXT.has(ext);
        const hits = [];
        if (!skipContent) {
          let stat;
          try { stat = await fsp.stat(sub); } catch (_) { stat = null; }
          if (stat && stat.size > 0 && stat.size <= GREP_MAX_FILE_BYTES) {
            let buf;
            try { buf = await fsp.readFile(sub); } catch (_) { buf = null; }
            if (buf) {
              // Quick binary sniff: NUL byte in first 8KB.
              const probe = buf.subarray(0, Math.min(8192, buf.length));
              let isBin = false;
              for (let i = 0; i < probe.length; i++) {
                if (probe[i] === 0) { isBin = true; break; }
              }
              if (!isBin) {
                const text = buf.toString('utf8');
                const lower = text.toLowerCase();
                let idx = 0;
                let lineStart = 0;
                let lineNo = 1;
                let cursor = 0;
                while (hits.length < GREP_MAX_HITS_PER_FILE) {
                  const hitIdx = lower.indexOf(qLower, idx);
                  if (hitIdx < 0) break;
                  // Advance lineNo to the line containing hitIdx.
                  while (cursor < hitIdx) {
                    if (text.charCodeAt(cursor) === 10) {
                      lineNo++;
                      lineStart = cursor + 1;
                    }
                    cursor++;
                  }
                  let lineEnd = text.indexOf('\n', hitIdx);
                  if (lineEnd < 0) lineEnd = text.length;
                  const lineText = text.slice(lineStart, lineEnd).replace(/\r$/, '');
                  hits.push({
                    line: lineNo,
                    col: hitIdx - lineStart,
                    text: lineText.length > 240 ? lineText.slice(0, 240) + '…' : lineText
                  });
                  idx = hitIdx + Math.max(1, qLower.length);
                }
              }
            }
          }
        }
        if (nameMatches || hits.length) {
          results.push({ path: sub, name: e.name, nameMatches, hits });
          if (results.length >= GREP_MAX_RESULTS) { truncated = true; return; }
        }
      }
    }
    await walk(root);
    return { ok: true, results, truncated };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:readDir', async (_evt, { path: dir }) => {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return {
      ok: true,
      entries: entries
        .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
        .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

const FILE_READ_LIMIT = 5 * 1024 * 1024;
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tif', '.tiff',
  '.pdf', '.zip', '.gz', '.7z', '.rar', '.tar', '.exe', '.dll', '.so', '.dylib',
  '.class', '.jar', '.wasm', '.node', '.bin', '.pyc', '.pyo', '.o', '.a', '.lib',
  '.mp3', '.mp4', '.wav', '.ogg', '.mov', '.avi', '.mkv', '.webm', '.flac',
  '.woff', '.woff2', '.ttf', '.otf', '.eot'
]);

ipcMain.handle('fs:readFile', async (_evt, { path: filePath }) => {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return { ok: false, error: 'Not a file' };
    const ext = path.extname(filePath).toLowerCase();
    if (BINARY_EXT.has(ext)) {
      return { ok: true, content: `(binary file: ${path.basename(filePath)}, ${stat.size} bytes)`, binary: true, size: stat.size };
    }
    if (stat.size > FILE_READ_LIMIT) {
      return { ok: true, content: `(file too large to display: ${stat.size} bytes; limit ${FILE_READ_LIMIT})`, truncated: true, size: stat.size };
    }
    const buf = await fsp.readFile(filePath);
    // Heuristic: treat as binary if NUL byte in first 8KB
    const probe = buf.subarray(0, Math.min(8192, buf.length));
    for (let i = 0; i < probe.length; i++) {
      if (probe[i] === 0) {
        return { ok: true, content: `(binary file: ${path.basename(filePath)}, ${stat.size} bytes)`, binary: true, size: stat.size };
      }
    }
    return { ok: true, content: buf.toString('utf8'), size: stat.size };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:writeFile', async (_evt, { path: filePath, content }) => {
  try {
    if (typeof filePath !== 'string' || !filePath) throw new Error('path required');
    if (typeof content !== 'string') throw new Error('content must be a string');
    await fsp.writeFile(filePath, content, 'utf8');
    const stat = await fsp.stat(filePath);
    return { ok: true, size: stat.size };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:rename', async (_evt, { oldPath, newPath }) => {
  try {
    if (!oldPath || !newPath) throw new Error('oldPath and newPath required');
    try {
      await fsp.access(newPath);
      return { ok: false, error: 'Target already exists' };
    } catch (_) { /* good — does not exist */ }
    await fsp.rename(oldPath, newPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

function promptHistoryDir(cwd) {
  return path.join(cwd, '.claude-logs', 'logs');
}
function promptHistoryFile(cwd) {
  return path.join(promptHistoryDir(cwd), 'prompt_history.json');
}

async function readPromptHistory(cwd) {
  try {
    const buf = await fsp.readFile(promptHistoryFile(cwd), 'utf8');
    const data = JSON.parse(buf);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function writePromptHistory(cwd, entries) {
  await fsp.mkdir(promptHistoryDir(cwd), { recursive: true });
  const f = promptHistoryFile(cwd);
  const tmp = f + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(entries, null, 2), 'utf8');
  await fsp.rename(tmp, f);
}

ipcMain.handle('prompts:read', async (_evt, { cwd }) => {
  try {
    if (!cwd) return { ok: true, entries: [] };
    const entries = await readPromptHistory(cwd);
    return { ok: true, entries };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('prompts:append', async (_evt, { cwd, entry }) => {
  try {
    if (!cwd) throw new Error('cwd required');
    if (!entry || typeof entry.prompt !== 'string') throw new Error('entry.prompt required');
    const normalized = {
      ts: entry.ts || new Date().toISOString(),
      source: entry.source || 'user',
      prompt: entry.prompt
    };
    const entries = await readPromptHistory(cwd);
    entries.push(normalized);
    await writePromptHistory(cwd, entries);
    return { ok: true, count: entries.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('prompts:syncFromCloud', async (_evt, { cwd }) => {
  try {
    if (!cwd) throw new Error('cwd required');
    if (!cloudLogs.isEnabled()) return { ok: false, error: 'cloud logs disabled' };
    const res = await cloudLogs.fetchLogs(cwd);
    if (!res.ok) return res;
    await writePromptHistory(cwd, res.entries);
    return { ok: true, count: res.entries.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('prompts:write', async (_evt, { cwd, entries }) => {
  try {
    if (!cwd) throw new Error('cwd required');
    if (!Array.isArray(entries)) throw new Error('entries must be an array');
    await writePromptHistory(cwd, entries);
    return { ok: true, count: entries.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('prompts:clear', async (_evt, { cwd }) => {
  try {
    if (!cwd) throw new Error('cwd required');
    await writePromptHistory(cwd, []);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('git:status', async (_evt, { cwd }) => {
  try {
    const [branchOut, statusOut] = await Promise.all([
      execGit(cwd, ['branch', '--show-current']).catch(() => ''),
      execGit(cwd, ['status', '--branch', '--porcelain=v1'])
    ]);
    const branch = (branchOut || '').trim() || '(detached)';
    const lines = statusOut.split(/\r?\n/).filter((l) => l.length > 0);
    let header = '';
    const entries = [];
    for (const line of lines) {
      if (line.startsWith('##')) {
        header = line.slice(3);
        continue;
      }
      const x = line[0];
      const y = line[1];
      let p = line.slice(3);
      if (p.includes(' -> ')) p = p.split(' -> ')[1];
      // Strip surrounding quotes git uses for paths with special chars
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      entries.push({ x, y, path: p });
    }
    return { ok: true, branch, header, entries, raw: statusOut };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('git:listBranches', async (_evt, { cwd }) => {
  try {
    const isRepo = await execGit(cwd, ['rev-parse', '--is-inside-work-tree']).then((s) => s.trim() === 'true').catch(() => false);
    if (!isRepo) return { ok: true, branches: [], current: null };
    const current = (await execGit(cwd, ['branch', '--show-current']).catch(() => '')).trim() || null;
    const localOut = await execGit(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).catch(() => '');
    const remoteOut = await execGit(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']).catch(() => '');
    const seen = new Set();
    const branches = [];
    for (const line of (localOut + '\n' + remoteOut).split(/\r?\n/)) {
      const name = line.trim();
      if (!name) continue;
      // Strip remote prefix (origin/foo → foo) and skip the symbolic HEAD ref.
      let bare = name;
      if (bare.startsWith('origin/')) bare = bare.slice('origin/'.length);
      else if (bare.includes('/HEAD')) continue;
      else if (bare.includes('/')) bare = bare.split('/').slice(1).join('/');
      if (!bare || bare === 'HEAD') continue;
      if (seen.has(bare)) continue;
      seen.add(bare);
      branches.push(bare);
    }
    branches.sort((a, b) => a.localeCompare(b));
    return { ok: true, branches, current };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('git:repoInfo', async (_evt, { cwd }) => {
  try {
    const isRepo = await execGit(cwd, ['rev-parse', '--is-inside-work-tree']).then((s) => s.trim() === 'true').catch(() => false);
    let branch = null;
    let originUrl = null;
    let hasCommits = false;
    if (isRepo) {
      branch = (await execGit(cwd, ['branch', '--show-current']).catch(() => '')).trim() || null;
      originUrl = (await execGit(cwd, ['remote', 'get-url', 'origin']).catch(() => '')).trim() || null;
      hasCommits = await execGit(cwd, ['rev-parse', '--verify', 'HEAD']).then(() => true).catch(() => false);
    }
    return { ok: true, isRepo, branch, originUrl, hasCommits };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

async function refExists(cwd, ref) {
  return execGit(cwd, ['rev-parse', '--verify', '--quiet', ref]).then(() => true).catch(() => false);
}

async function resolveTrunkRef(cwd) {
  // Prefer origin/HEAD if set; fall back to common trunk names on the remote, then locally.
  const headOut = (await execGit(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')).trim();
  if (headOut) {
    const name = headOut.startsWith('origin/') ? headOut.slice('origin/'.length) : headOut;
    if (await refExists(cwd, headOut)) return { ref: headOut, name, remote: true };
  }
  for (const name of ['main', 'master', 'trunk', 'develop']) {
    if (await refExists(cwd, `origin/${name}`)) return { ref: `origin/${name}`, name, remote: true };
  }
  for (const name of ['main', 'master', 'trunk', 'develop']) {
    if (await refExists(cwd, name)) return { ref: name, name, remote: false };
  }
  return null;
}

ipcMain.handle('git:aheadBehind', async (_evt, { cwd }) => {
  try {
    const isRepo = await execGit(cwd, ['rev-parse', '--is-inside-work-tree']).then((s) => s.trim() === 'true').catch(() => false);
    if (!isRepo) return { ok: true, isRepo: false };
    const hasCommits = await execGit(cwd, ['rev-parse', '--verify', 'HEAD']).then(() => true).catch(() => false);
    if (!hasCommits) return { ok: true, isRepo: true, hasCommits: false };
    const branch = (await execGit(cwd, ['branch', '--show-current']).catch(() => '')).trim() || null;
    const trunk = await resolveTrunkRef(cwd);
    if (!trunk) return { ok: true, isRepo: true, hasCommits: true, branch, trunk: null };
    const onTrunk = branch && (branch === trunk.name);
    const out = (await execGit(cwd, ['rev-list', '--left-right', '--count', `HEAD...${trunk.ref}`]).catch(() => '')).trim();
    const m = out.match(/^(\d+)\s+(\d+)/);
    const ahead = m ? Number(m[1]) : 0;
    const behind = m ? Number(m[2]) : 0;
    return { ok: true, isRepo: true, hasCommits: true, branch, trunk: trunk.ref, trunkName: trunk.name, trunkRemote: trunk.remote, ahead, behind, onTrunk };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('cli:checkClaude', async () => {
  const ver = await execCapture('claude', ['--version'], process.cwd());
  if (ver.ok) {
    return { ok: true, installed: true, version: (ver.stdout || '').trim() };
  }
  // Try `where` (Windows) / `which` (POSIX) as a fallback so we can still report a hint.
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const found = await execCapture(finder, ['claude'], process.cwd());
  if (found.ok && (found.stdout || '').trim()) {
    return { ok: true, installed: true, version: null, path: (found.stdout || '').trim().split(/\r?\n/)[0] };
  }
  return { ok: true, installed: false, error: (ver.stderr || ver.error || '').trim() };
});

ipcMain.handle('github:checkGh', async () => {
  const ver = await execCapture('gh', ['--version'], process.cwd());
  if (!ver.ok) return { ok: true, installed: false, authed: false };
  const auth = await execCapture('gh', ['auth', 'status'], process.cwd());
  const authed = auth.ok;
  let user = null;
  if (authed) {
    const who = await execCapture('gh', ['api', 'user', '--jq', '.login'], process.cwd());
    if (who.ok) user = who.stdout.trim() || null;
  }
  return { ok: true, installed: true, authed, user, statusText: (auth.stdout + auth.stderr).trim() };
});

function makeLogger(id) {
  return (line) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gitops:log', { id, line });
    }
  };
}

const PROTECTED_BRANCHES = ['main', 'master'];
const isProtectedBranch = (name) => PROTECTED_BRANCHES.includes(String(name || '').trim().toLowerCase());

ipcMain.handle('git:commitPush', async (_evt, { id, cwd, branch, newBranch, commitMessage, stageAll, push, setUpstream }) => {
  const log = makeLogger(id);
  try {
    if (!cwd) throw new Error('No folder open');
    if (!commitMessage || !commitMessage.trim()) throw new Error('Commit message is required');

    if (isProtectedBranch(branch) && !newBranch) {
      throw new Error(`Direct commits to "${branch}" are not allowed. Tick "New branch" and provide a new branch name.`);
    }
    if (newBranch && isProtectedBranch(branch)) {
      throw new Error(`"${branch}" is a protected branch name. Pick a different name for the new branch.`);
    }

    const isRepo = await execGit(cwd, ['rev-parse', '--is-inside-work-tree']).then((s) => s.trim() === 'true').catch(() => false);
    if (!isRepo) {
      await runStep('git init', 'git', ['init'], cwd, log);
    }

    if (!newBranch) {
      const current = (await execGit(cwd, ['branch', '--show-current']).catch(() => '')).trim();
      if (isProtectedBranch(current)) {
        throw new Error(`You are on "${current}". Direct commits to "${current}" are not allowed — create a new branch first.`);
      }
    }

    if (newBranch && branch) {
      const exists = await execGit(cwd, ['rev-parse', '--verify', `refs/heads/${branch}`]).then(() => true).catch(() => false);
      if (exists) {
        await runStep(`checkout ${branch}`, 'git', ['checkout', branch], cwd, log);
      } else {
        await runStep(`checkout -b ${branch}`, 'git', ['checkout', '-b', branch], cwd, log);
      }
    } else if (branch) {
      const current = (await execGit(cwd, ['branch', '--show-current']).catch(() => '')).trim();
      if (current !== branch) {
        await runStep(`checkout ${branch}`, 'git', ['checkout', branch], cwd, log);
      }
    }

    if (stageAll) {
      await runStep('git add -A', 'git', ['add', '-A'], cwd, log);
    }

    const staged = await execCapture('git', ['diff', '--cached', '--name-only'], cwd);
    if (!staged.stdout.trim()) {
      log('⚠ Nothing staged to commit. Skipping commit step.');
    } else {
      await runStep('git commit', 'git', ['commit', '-m', commitMessage], cwd, log);
    }

    if (push) {
      const curBranch = (await execGit(cwd, ['branch', '--show-current']).catch(() => '')).trim() || branch;
      const hasOrigin = await execGit(cwd, ['remote', 'get-url', 'origin']).then(() => true).catch(() => false);
      if (!hasOrigin) {
        log('⚠ No "origin" remote configured. Skipping push.');
      } else {
        const args = setUpstream
          ? ['push', '-u', 'origin', curBranch]
          : ['push', 'origin', curBranch];
        await runStep(`git ${args.join(' ')}`, 'git', args, cwd, log);
      }
    }

    log('✓ Done.');
    return { ok: true };
  } catch (err) {
    log(`✗ ${err.message}`);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('github:listOwners', async () => {
  try {
    const gh = await execCapture('gh', ['--version'], process.cwd());
    if (!gh.ok) return { ok: false, error: 'gh CLI not installed' };
    const who = await execCapture('gh', ['api', 'user', '--jq', '.login'], process.cwd());
    if (!who.ok) return { ok: false, error: (who.stderr || who.error || 'gh api user failed').trim() };
    const user = (who.stdout || '').trim();
    const orgsRes = await execCapture('gh', ['api', 'user/orgs', '--paginate', '--jq', '.[].login'], process.cwd());
    const orgs = orgsRes.ok
      ? (orgsRes.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      : [];
    return { ok: true, user, orgs };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('github:publish', async (_evt, { id, cwd, repoName, visibility, description, commitMessage }) => {
  const log = makeLogger(id);
  try {
    if (!cwd) throw new Error('No folder open');
    if (!repoName || !repoName.trim()) throw new Error('Repository name is required');
    const vis = visibility === 'public' ? '--public' : (visibility === 'internal' ? '--internal' : '--private');

    const gh = await execCapture('gh', ['--version'], cwd);
    if (!gh.ok) throw new Error('gh CLI is not installed or not on PATH. Install from https://cli.github.com/');
    const auth = await execCapture('gh', ['auth', 'status'], cwd);
    if (!auth.ok) throw new Error('gh is not authenticated. Run: gh auth login');

    const isRepo = await execGit(cwd, ['rev-parse', '--is-inside-work-tree']).then((s) => s.trim() === 'true').catch(() => false);
    if (!isRepo) {
      await runStep('git init', 'git', ['init'], cwd, log);
    }

    const hasOrigin = await execGit(cwd, ['remote', 'get-url', 'origin']).then(() => true).catch(() => false);
    if (hasOrigin) {
      throw new Error('This folder already has an "origin" remote. Use Commit & Push instead, or remove the remote first.');
    }

    const hasCommits = await execGit(cwd, ['rev-parse', '--verify', 'HEAD']).then(() => true).catch(() => false);
    if (!hasCommits) {
      const msg = (commitMessage && commitMessage.trim()) || 'Initial commit';
      await runStep('git add -A', 'git', ['add', '-A'], cwd, log);
      const staged = await execCapture('git', ['diff', '--cached', '--name-only'], cwd);
      if (!staged.stdout.trim()) {
        log('⚠ No files to commit. Creating an empty initial commit.');
        await runStep('git commit (empty)', 'git', ['commit', '--allow-empty', '-m', msg], cwd, log);
      } else {
        await runStep('git commit', 'git', ['commit', '-m', msg], cwd, log);
      }
    }

    const args = ['repo', 'create', repoName, vis, '--source', '.', '--remote', 'origin', '--push'];
    if (description && description.trim()) {
      args.push('--description', description.trim());
    }
    await runStep('gh repo create', 'gh', args, cwd, log);

    const url = await execCapture('gh', ['repo', 'view', '--json', 'url', '--jq', '.url'], cwd);
    const repoUrl = url.ok ? url.stdout.trim() : null;
    if (repoUrl) log(`✓ Repo URL: ${repoUrl}`);
    log('✓ Done.');
    return { ok: true, repoUrl };
  } catch (err) {
    log(`✗ ${err.message}`);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('github:listWorkflows', async (_evt, { cwd }) => {
  try {
    if (!cwd) throw new Error('No folder open');
    const gh = await execCapture('gh', ['--version'], cwd);
    if (!gh.ok) return { ok: false, error: 'gh CLI not installed' };
    const res = await execCapture('gh', ['workflow', 'list', '--all', '--json', 'id,name,path,state'], cwd);
    if (!res.ok) {
      return { ok: false, error: (res.stderr || res.error || 'gh workflow list failed').trim() };
    }
    let workflows = [];
    try { workflows = JSON.parse(res.stdout || '[]'); } catch (_) { workflows = []; }
    return { ok: true, workflows };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

function parseWorkflowDispatchInputs(yamlText) {
  if (typeof yamlText !== 'string' || !yamlText) return [];
  const lines = yamlText.split(/\r?\n/);
  const unquote = (s) => {
    if (s == null) return '';
    let v = String(s).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return v;
  };

  let onLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^on\s*:/.test(lines[i])) { onLine = i; break; }
  }
  if (onLine < 0) return [];

  let wdIndent = -1;
  let wdLine = -1;
  for (let i = onLine + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const m = raw.match(/^(\s*)(\S[^:]*)\s*:/);
    if (!m) continue;
    const indent = m[1].length;
    if (indent === 0) break;
    if (m[2].trim() === 'workflow_dispatch') {
      wdLine = i;
      wdIndent = indent;
      break;
    }
  }
  if (wdLine < 0) return [];

  let inputsLine = -1;
  let inputsIndent = -1;
  for (let i = wdLine + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const m = raw.match(/^(\s*)(\S[^:]*)\s*:/);
    if (!m) continue;
    const indent = m[1].length;
    if (indent <= wdIndent) break;
    if (m[2].trim() === 'inputs') {
      inputsLine = i;
      inputsIndent = indent;
      break;
    }
  }
  if (inputsLine < 0) return [];

  const inputs = [];
  let cur = null;
  let nameIndent = -1;
  let expectingOptionsList = false;
  for (let i = inputsLine + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || /^\s*#/.test(raw)) continue;

    const listM = raw.match(/^(\s*)-\s+(.*)$/);
    if (listM && cur && expectingOptionsList) {
      const indent = listM[1].length;
      if (indent > nameIndent) {
        cur.options = cur.options || [];
        cur.options.push(unquote(listM[2]));
        continue;
      }
    }

    const m = raw.match(/^(\s*)([^:\s][^:]*?)\s*:\s*(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    const key = m[2].trim();
    const val = m[3].trim();

    if (indent <= inputsIndent) break;

    if (nameIndent < 0 || indent === nameIndent) {
      nameIndent = indent;
      expectingOptionsList = false;
      cur = { name: key };
      inputs.push(cur);
      continue;
    }
    if (indent > nameIndent && cur) {
      if (key === 'options' && !val) {
        expectingOptionsList = true;
        cur.options = [];
      } else if (key === 'description') {
        cur.description = unquote(val);
      } else if (key === 'required') {
        cur.required = /^true$/i.test(unquote(val));
      } else if (key === 'type') {
        cur.type = unquote(val);
      } else if (key === 'default') {
        cur.default = unquote(val);
      }
    }
  }
  return inputs;
}

ipcMain.handle('github:workflowInputs', async (_evt, { cwd, workflowPath }) => {
  try {
    if (!cwd) return { ok: true, inputs: [] };
    if (!workflowPath) return { ok: true, inputs: [] };
    const full = path.join(cwd, workflowPath);
    let text;
    try {
      text = await fsp.readFile(full, 'utf8');
    } catch (_) {
      return { ok: true, inputs: [], note: 'workflow file not found locally' };
    }
    return { ok: true, inputs: parseWorkflowDispatchInputs(text) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

function parseWorkflowEnvironments(yamlText) {
  if (typeof yamlText !== 'string' || !yamlText) return [];
  const lines = yamlText.split(/\r?\n/);
  const unquote = (s) => {
    if (s == null) return '';
    let v = String(s).trim();
    if (!(v.startsWith('"') || v.startsWith("'"))) {
      const hashIdx = v.indexOf('#');
      if (hashIdx >= 0) v = v.slice(0, hashIdx).trim();
    }
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return v;
  };
  const parseVal = (raw) => {
    const cleaned = unquote(raw);
    if (!cleaned) return null;
    const inp = cleaned.match(/\$\{\{\s*inputs\.([\w-]+)\s*\}\}/);
    if (inp) return { fromInput: inp[1] };
    if (/\$\{\{/.test(cleaned)) return null; // unresolvable (matrix, env, etc.)
    return { literal: cleaned };
  };

  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)environment\s*:\s*(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    if (indent === 0) continue;
    const val = m[2].trim();
    if (val) {
      const v = parseVal(val);
      if (v) out.push(v);
    } else {
      for (let j = i + 1; j < lines.length; j++) {
        const r2 = lines[j];
        if (!r2.trim() || /^\s*#/.test(r2)) continue;
        const m2 = r2.match(/^(\s*)([^:\s][^:]*?)\s*:\s*(.*)$/);
        if (!m2) continue;
        if (m2[1].length <= indent) break;
        if (m2[2].trim() === 'name') {
          const v = parseVal(m2[3].trim());
          if (v) out.push(v);
          break;
        }
      }
    }
  }
  return out;
}

ipcMain.handle('github:recentEnvDeployments', async (_evt, { cwd, workflowPath, inputs }) => {
  try {
    if (!cwd) return { ok: true, deployments: [], environments: [] };
    if (!workflowPath) return { ok: true, deployments: [], environments: [] };
    const full = path.join(cwd, workflowPath);
    let yaml;
    try { yaml = await fsp.readFile(full, 'utf8'); }
    catch (_) { return { ok: true, deployments: [], environments: [] }; }

    const envRefs = parseWorkflowEnvironments(yaml);
    const inputMap = {};
    if (Array.isArray(inputs)) {
      for (const f of inputs) {
        if (f && f.key) inputMap[f.key] = f.value;
      }
    }
    const envNames = [];
    const seen = new Set();
    for (const r of envRefs) {
      let name = null;
      if (r.literal) name = r.literal;
      else if (r.fromInput && inputMap[r.fromInput] != null && String(inputMap[r.fromInput]).trim()) {
        name = String(inputMap[r.fromInput]).trim();
      }
      if (name && !seen.has(name)) { seen.add(name); envNames.push(name); }
    }
    if (!envNames.length) return { ok: true, deployments: [], environments: [] };

    const since = Date.now() - 24 * 60 * 60 * 1000;
    const all = [];
    for (const env of envNames) {
      const encEnv = encodeURIComponent(env);
      const res = await execCapture('gh', ['api', `/repos/{owner}/{repo}/deployments?environment=${encEnv}&per_page=20`], cwd);
      if (!res.ok) continue;
      let arr;
      try { arr = JSON.parse(res.stdout || '[]'); }
      catch (_) { continue; }
      if (!Array.isArray(arr)) continue;
      for (const d of arr) {
        const createdMs = d && d.created_at ? Date.parse(d.created_at) : 0;
        if (!createdMs || createdMs < since) continue;
        const actor = (d.creator && d.creator.login) || 'unknown';
        all.push({
          environment: env,
          actor,
          created_at: d.created_at,
          ref: d.ref || '',
          sha: (d.sha || '').slice(0, 7)
        });
      }
    }
    all.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    return { ok: true, deployments: all, environments: envNames };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('github:runWorkflow', async (_evt, { id, cwd, workflow, ref, inputs }) => {
  const log = makeLogger(id);
  try {
    if (!cwd) throw new Error('No folder open');
    if (!workflow) throw new Error('Workflow is required');

    const gh = await execCapture('gh', ['--version'], cwd);
    if (!gh.ok) throw new Error('gh CLI is not installed or not on PATH. Install from https://cli.github.com/');
    const auth = await execCapture('gh', ['auth', 'status'], cwd);
    if (!auth.ok) throw new Error('gh is not authenticated. Run: gh auth login');

    const args = ['workflow', 'run', String(workflow)];
    if (ref && ref.trim()) {
      args.push('--ref', ref.trim());
    }
    const fields = Array.isArray(inputs) ? inputs : [];
    for (const f of fields) {
      if (!f || !f.key) continue;
      args.push('-f', `${f.key}=${f.value == null ? '' : f.value}`);
    }
    await runStep(`gh ${args.join(' ')}`, 'gh', args, cwd, log);

    // Best-effort: fetch the most recent run URL for this workflow
    const runRes = await execCapture('gh', ['run', 'list', '--workflow', String(workflow), '--limit', '1', '--json', 'databaseId,url,status,displayTitle,headBranch,createdAt'], cwd);
    let run = null;
    if (runRes.ok) {
      try {
        const arr = JSON.parse(runRes.stdout || '[]');
        if (Array.isArray(arr) && arr.length) run = arr[0];
      } catch (_) {}
    }
    if (run && run.url) log(`✓ Run dispatched: ${run.url}`);
    log('✓ Done.');
    return { ok: true, run };
  } catch (err) {
    log(`✗ ${err.message}`);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('shell:openExternal', async (_evt, { url }) => {
  try {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      throw new Error('Only http/https URLs are allowed');
    }
    await shell.openExternal(url);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('github:createPR', async (_evt, { id, cwd, title, body, base, draft }) => {
  const log = makeLogger(id);
  try {
    if (!cwd) throw new Error('No folder open');
    if (!title || !title.trim()) throw new Error('PR title is required');

    const gh = await execCapture('gh', ['--version'], cwd);
    if (!gh.ok) throw new Error('gh CLI is not installed or not on PATH. Install from https://cli.github.com/');
    const auth = await execCapture('gh', ['auth', 'status'], cwd);
    if (!auth.ok) throw new Error('gh is not authenticated. Run: gh auth login');

    const hasOrigin = await execGit(cwd, ['remote', 'get-url', 'origin']).then(() => true).catch(() => false);
    if (!hasOrigin) throw new Error('No "origin" remote configured. Publish the repo first.');

    const args = ['pr', 'create', '--title', title.trim(), '--body', (body || '').trim()];
    if (base && base.trim()) args.push('--base', base.trim());
    if (draft) args.push('--draft');
    await runStep('gh pr create', 'gh', args, cwd, log);

    const info = await execCapture('gh', ['pr', 'view', '--json', 'number,url,state,title,reviewDecision'], cwd);
    let pr = null;
    if (info.ok) {
      try { pr = JSON.parse(info.stdout); } catch (_) {}
    }
    if (pr && pr.url) log(`✓ PR URL: ${pr.url}`);
    log('✓ Done.');
    return { ok: true, pr };
  } catch (err) {
    log(`✗ ${err.message}`);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('github:listPRs', async (_evt, { cwd, state }) => {
  try {
    if (!cwd) throw new Error('No folder open');
    const gh = await execCapture('gh', ['--version'], cwd);
    if (!gh.ok) return { ok: false, error: 'gh CLI not installed' };
    const auth = await execCapture('gh', ['auth', 'status'], cwd);
    if (!auth.ok) return { ok: false, error: 'gh not authenticated' };

    const which = (state && String(state).trim()) || 'open';
    const fields = 'number,title,url,headRefName,baseRefName,author,isDraft,state,updatedAt';
    const res = await execCapture(
      'gh',
      ['pr', 'list', '--state', which, '--limit', '50', '--json', fields],
      cwd
    );
    if (!res.ok) {
      return { ok: false, error: (res.stderr || res.error || 'gh pr list failed').trim() };
    }
    let prs = [];
    try {
      const raw = JSON.parse(res.stdout);
      if (Array.isArray(raw)) prs = raw;
    } catch (_) {}
    return { ok: true, prs };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('github:prInfo', async (_evt, { cwd, branch }) => {
  try {
    if (!cwd) throw new Error('No folder open');
    const gh = await execCapture('gh', ['--version'], cwd);
    if (!gh.ok) return { ok: false, error: 'gh CLI not installed' };
    const auth = await execCapture('gh', ['auth', 'status'], cwd);
    if (!auth.ok) return { ok: false, error: 'gh not authenticated' };

    const fields = 'number,url,state,title,baseRefName,headRefName,isDraft,reviewDecision,reviews,comments,author,body';
    const args = ['pr', 'view', '--json', fields];
    if (branch && branch.trim()) args.push(branch.trim());
    const res = await execCapture('gh', args, cwd);
    if (!res.ok) {
      const msg = ((res.stderr || res.error || '') + '').toLowerCase();
      if (msg.includes('no pull requests') || msg.includes('no pull request') || msg.includes('not found')) {
        return { ok: true, pr: null };
      }
      return { ok: false, error: (res.stderr || res.error || 'gh pr view failed').trim() };
    }
    let pr = null;
    try { pr = JSON.parse(res.stdout); } catch (_) {}
    if (pr && pr.number) {
      const slug = parseRepoSlugFromUrl(pr.url);
      if (slug) {
        const inline = await execCapture('gh', ['api', `repos/${slug}/pulls/${pr.number}/comments`, '--paginate'], cwd);
        if (inline.ok) {
          try {
            const raw = JSON.parse(inline.stdout);
            if (Array.isArray(raw)) {
              pr.inlineComments = raw.map((c) => ({
                id: c.id,
                author: { login: (c.user && c.user.login) || 'unknown' },
                body: c.body || '',
                path: c.path || '',
                line: c.line != null ? c.line : (c.original_line != null ? c.original_line : null),
                side: c.side || c.original_side || null,
                diffHunk: c.diff_hunk || '',
                createdAt: c.created_at || null,
                url: c.html_url || ''
              }));
            }
          } catch (_) { pr.inlineComments = []; }
        }
      }
    }
    return { ok: true, pr };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

function parseRepoSlugFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/i);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

ipcMain.handle('git:diff', async (_evt, { cwd, file, untracked }) => {
  try {
    if (untracked) {
      const full = path.join(cwd, file);
      let content;
      try {
        content = await fsp.readFile(full, 'utf8');
      } catch (_) {
        return { ok: true, diff: `(binary or unreadable: ${file})` };
      }
      const header = `diff --git a/${file} b/${file}\nnew file (untracked)\n--- /dev/null\n+++ b/${file}\n`;
      const body = content.split('\n').map((l) => '+' + l).join('\n');
      return { ok: true, diff: header + body };
    }
    const [staged, unstaged] = await Promise.all([
      execGit(cwd, ['diff', '--cached', '--', file]).catch(() => ''),
      execGit(cwd, ['diff', '--', file]).catch(() => '')
    ]);
    let diff = '';
    if (staged.trim()) diff += '### Staged\n' + staged;
    if (unstaged.trim()) diff += (diff ? '\n' : '') + '### Unstaged\n' + unstaged;
    if (!diff) diff = '(no diff)';
    return { ok: true, diff };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('git:recentCommits', async (_evt, { cwd, limit }) => {
  try {
    if (!cwd) throw new Error('No folder open');
    const isRepo = await execGit(cwd, ['rev-parse', '--is-inside-work-tree']).then((s) => s.trim() === 'true').catch(() => false);
    if (!isRepo) return { ok: true, isRepo: false, commits: [] };
    const hasCommits = await execGit(cwd, ['rev-parse', '--verify', 'HEAD']).then(() => true).catch(() => false);
    if (!hasCommits) return { ok: true, isRepo: true, hasCommits: false, commits: [] };
    const n = Math.max(1, Math.min(200, Number(limit) || 30));
    // Use NUL byte separators to safely parse commit fields containing newlines.
    const fmt = ['%H', '%h', '%an', '%ae', '%aI', '%s', '%b'].join('%x1f') + '%x1e';
    const out = await execGit(cwd, ['log', `-n${n}`, `--pretty=format:${fmt}`]);
    const commits = [];
    for (const raw of out.split('\x1e')) {
      const rec = raw.replace(/^\s+/, '');
      if (!rec) continue;
      const parts = rec.split('\x1f');
      if (parts.length < 6) continue;
      const [hash, shortHash, author, email, date, subject, body = ''] = parts;
      commits.push({
        hash,
        shortHash,
        author,
        email,
        date,
        subject,
        body: body.trim()
      });
    }
    return { ok: true, isRepo: true, hasCommits: true, commits };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('git:commitShow', async (_evt, { cwd, hash }) => {
  try {
    if (!cwd) throw new Error('No folder open');
    if (!hash || !/^[0-9a-f]{4,40}$/i.test(hash)) throw new Error('Invalid commit hash');
    const filesOut = await execGit(cwd, ['show', '--name-status', '--pretty=format:', hash]).catch(() => '');
    const files = [];
    for (const line of filesOut.split(/\r?\n/)) {
      const l = line.trim();
      if (!l) continue;
      const m = l.match(/^([ACDMRTUXB])(\d*)\s+(.+)$/);
      if (!m) continue;
      const status = m[1];
      let p = m[3];
      // Renames look like "old\tnew" — use the new path.
      if (p.includes('\t')) p = p.split('\t').pop();
      files.push({ status, path: p });
    }
    const diff = await execGit(cwd, ['show', '--patch', '--pretty=format:', hash]).catch(() => '');
    return { ok: true, files, diff: diff.replace(/^\s+/, '') };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('git:add', async (_evt, { cwd, file }) => {
  try {
    if (!file) throw new Error('file required');
    await execGit(cwd, ['add', '--', file]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Appends a pattern to the repo's .gitignore. `mode` controls what is derived
// from the changed file's path:
//   'file'   → ignore just that file              (/src/utils/log.js)
//   'folder' → ignore its immediate parent folder (/src/utils/)
//   'root'   → ignore its top-level folder        (/src/)
ipcMain.handle('git:ignore', async (_evt, { cwd, file, mode }) => {
  try {
    if (!file) throw new Error('file required');
    const rel = String(file).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const parts = rel.split('/').filter(Boolean);
    if (!parts.length) throw new Error('invalid path');

    let pattern;
    if (mode === 'folder') {
      if (parts.length < 2) throw new Error('This file is at the repository root — it has no containing folder to ignore.');
      pattern = '/' + parts.slice(0, -1).join('/') + '/';
    } else if (mode === 'root') {
      if (parts.length < 2) throw new Error('This file is at the repository root — it has no top-level folder to ignore.');
      pattern = '/' + parts[0] + '/';
    } else {
      pattern = '/' + parts.join('/');
    }

    const giPath = path.join(cwd, '.gitignore');
    let existing = '';
    try { existing = await fsp.readFile(giPath, 'utf8'); } catch (_) {}
    const present = existing.split(/\r?\n/).some((l) => l.trim() === pattern);
    if (present) return { ok: true, pattern, alreadyPresent: true };

    let toWrite = existing;
    if (toWrite.length && !/\n$/.test(toWrite)) toWrite += '\n';
    toWrite += pattern + '\n';
    await fsp.writeFile(giPath, toWrite, 'utf8');
    return { ok: true, pattern };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('git:checkoutSide', async (_evt, { cwd, file, side }) => {
  try {
    if (!file) throw new Error('file required');
    if (side !== 'ours' && side !== 'theirs') throw new Error('side must be "ours" or "theirs"');
    await execGit(cwd, ['checkout', `--${side}`, '--', file]);
    await execGit(cwd, ['add', '--', file]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ───────────────────────────────────────────────────────── slack

// Read the Slack bot token from the SLACK_TOKEN .env variable.
ipcMain.handle('slack:getToken', async () => {
  try {
    return { ok: true, ...(await aws.getSlackToken()) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('slack:connect', async (_evt, { token, channel }) => {
  try {
    return await slack.connect(token, channel);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('slack:fetch', async (_evt, { token, channel, oldest, limit }) => {
  try {
    if (!token || !channel) throw new Error('token and channel required');
    return await slack.fetchHistory(token, channel, oldest, limit);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('slack:post', async (_evt, { token, channel, text, threadTs }) => {
  try {
    if (!token || !channel) throw new Error('token and channel required');
    return await slack.postMessage(token, channel, text, threadTs);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Open a Socket Mode WebSocket URL for the renderer to connect to. The renderer
// owns the WebSocket itself (Chromium has a native WebSocket); the main process
// only performs the authenticated apps.connections.open round-trip.
ipcMain.handle('slack:openSocket', async (_evt, { appToken }) => {
  try {
    return await slack.openSocketUrl(appToken);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Aborts whichever operation produced the current conflicted state.
ipcMain.handle('git:abortMerge', async (_evt, { cwd }) => {
  const tryRun = async (args) => {
    try { await execGit(cwd, args); return true; } catch (_) { return false; }
  };
  if (await tryRun(['merge', '--abort'])) return { ok: true, kind: 'merge' };
  if (await tryRun(['rebase', '--abort'])) return { ok: true, kind: 'rebase' };
  if (await tryRun(['cherry-pick', '--abort'])) return { ok: true, kind: 'cherry-pick' };
  return { ok: false, error: 'No merge/rebase/cherry-pick in progress.' };
});

const { contextBridge, ipcRenderer, clipboard } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // OS platform id (mirrors process.platform) so the renderer can pick
  // platform-appropriate install commands, download links, and pane copy.
  platform: process.platform,

  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  setTitle: (title) => ipcRenderer.invoke('window:setTitle', { title }),

  clipboard: {
    readText: () => clipboard.readText(),
    writeText: (text) => clipboard.writeText(text == null ? '' : String(text))
  },

  pty: {
    spawn: (opts) => ipcRenderer.invoke('pty:spawn', opts),
    write: (id, data) => ipcRenderer.invoke('pty:write', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.invoke('pty:resize', { id, cols, rows }),
    kill: (id) => ipcRenderer.invoke('pty:kill', { id }),
    onData: (cb) => {
      const listener = (_e, payload) => cb(payload);
      ipcRenderer.on('pty:data', listener);
      return () => ipcRenderer.removeListener('pty:data', listener);
    },
    onExit: (cb) => {
      const listener = (_e, payload) => cb(payload);
      ipcRenderer.on('pty:exit', listener);
      return () => ipcRenderer.removeListener('pty:exit', listener);
    }
  },

  aws: {
    listEnvironments: () => ipcRenderer.invoke('aws:listEnvironments'),
    listRoles: (accountId) => ipcRenderer.invoke('aws:listRoles', { accountId }),
    applyRole: (accountId, accountName, role, profile) =>
      ipcRenderer.invoke('aws:applyRole', { accountId, accountName, role, profile }),
    status: () => ipcRenderer.invoke('aws:status'),
    listProfiles: () => ipcRenderer.invoke('aws:listProfiles'),
    onLog: (cb) => {
      const listener = (_e, payload) => cb(payload);
      ipcRenderer.on('aws:log', listener);
      return () => ipcRenderer.removeListener('aws:log', listener);
    },
    onStatus: (cb) => {
      const listener = (_e, payload) => cb(payload);
      ipcRenderer.on('aws:status', listener);
      return () => ipcRenderer.removeListener('aws:status', listener);
    }
  },

  fs: {
    readDir: (dirPath) => ipcRenderer.invoke('fs:readDir', { path: dirPath }),
    readFile: (filePath) => ipcRenderer.invoke('fs:readFile', { path: filePath }),
    // `opts.exclusive` (TASK-127) is optional and defaults off: absent → the
    // original default-overwrite write, so all existing callers are unchanged.
    // When true the main handler uses flag:'wx' (atomic no-overwrite create).
    writeFile: (filePath, content, opts) =>
      ipcRenderer.invoke('fs:writeFile', { path: filePath, content, exclusive: !!(opts && opts.exclusive) }),
    mkdir: (dirPath) => ipcRenderer.invoke('fs:mkdir', { path: dirPath }),
    rename: (oldPath, newPath) => ipcRenderer.invoke('fs:rename', { oldPath, newPath }),
    findByExt: (root, ext, excludeDirs) => ipcRenderer.invoke('fs:findByExt', { root, ext, excludeDirs }),
    grep: (root, query) => ipcRenderer.invoke('fs:grep', { root, query }),
    exists: (p) => ipcRenderer.invoke('fs:exists', { path: p })
  },

  tasks: {
    installSkill: (projectPath) => ipcRenderer.invoke('tasks:installSkill', { projectPath }),
    // Fire-and-forget: report the app-wide count of actively-worked tickets so the
    // main process can hold/release the OS keep-awake wake-lock (TASK-036).
    reportActivity: (activeCount) => ipcRenderer.send('tasks:activity', activeCount)
  },

  attention: {
    // Fire-and-forget: report the app-wide count of live "needs attention"
    // conditions (waiting/finished tabs + board tickets awaiting an answer) so the
    // main process can request/clear the OS taskbar flash while the window is
    // unfocused (TASK-078). Mirror of tasks.reportActivity.
    report: (attentionCount) => ipcRenderer.send('window:attention', attentionCount)
  },

  prompts: {
    read: (cwd) => ipcRenderer.invoke('prompts:read', { cwd }),
    append: (cwd, entry) => ipcRenderer.invoke('prompts:append', { cwd, entry }),
    write: (cwd, entries) => ipcRenderer.invoke('prompts:write', { cwd, entries }),
    clear: (cwd) => ipcRenderer.invoke('prompts:clear', { cwd }),
    syncFromCloud: (cwd) => ipcRenderer.invoke('prompts:syncFromCloud', { cwd })
  },

  git: {
    checkGit: () => ipcRenderer.invoke('git:checkGit'),
    status: (cwd) => ipcRenderer.invoke('git:status', { cwd }),
    diff: (cwd, file, untracked) => ipcRenderer.invoke('git:diff', { cwd, file, untracked: !!untracked }),
    repoInfo: (cwd) => ipcRenderer.invoke('git:repoInfo', { cwd }),
    aheadBehind: (cwd) => ipcRenderer.invoke('git:aheadBehind', { cwd }),
    listBranches: (cwd) => ipcRenderer.invoke('git:listBranches', { cwd }),
    commitPush: (opts) => ipcRenderer.invoke('git:commitPush', opts),
    recentCommits: (cwd, limit) => ipcRenderer.invoke('git:recentCommits', { cwd, limit }),
    commitShow: (cwd, hash) => ipcRenderer.invoke('git:commitShow', { cwd, hash }),
    add: (cwd, file) => ipcRenderer.invoke('git:add', { cwd, file }),
    ignore: (cwd, file, mode) => ipcRenderer.invoke('git:ignore', { cwd, file, mode }),
    checkoutSide: (cwd, file, side) => ipcRenderer.invoke('git:checkoutSide', { cwd, file, side }),
    abortMerge: (cwd) => ipcRenderer.invoke('git:abortMerge', { cwd })
  },

  cli: {
    checkClaude: () => ipcRenderer.invoke('cli:checkClaude'),
    checkOpencode: () => ipcRenderer.invoke('cli:checkOpencode')
  },

  github: {
    checkGh: () => ipcRenderer.invoke('github:checkGh'),
    listOwners: () => ipcRenderer.invoke('github:listOwners'),
    publish: (opts) => ipcRenderer.invoke('github:publish', opts),
    listWorkflows: (cwd) => ipcRenderer.invoke('github:listWorkflows', { cwd }),
    workflowInputs: (cwd, workflowPath) => ipcRenderer.invoke('github:workflowInputs', { cwd, workflowPath }),
    runWorkflow: (opts) => ipcRenderer.invoke('github:runWorkflow', opts),
    recentEnvDeployments: (cwd, workflowPath, inputs) => ipcRenderer.invoke('github:recentEnvDeployments', { cwd, workflowPath, inputs }),
    createPR: (opts) => ipcRenderer.invoke('github:createPR', opts),
    prInfo: (cwd, branch) => ipcRenderer.invoke('github:prInfo', { cwd, branch }),
    listPRs: (cwd, state) => ipcRenderer.invoke('github:listPRs', { cwd, state })
  },

  slack: {
    getToken: () => ipcRenderer.invoke('slack:getToken'),
    connect: (token, channel) => ipcRenderer.invoke('slack:connect', { token, channel }),
    fetch: (token, channel, oldest, limit) => ipcRenderer.invoke('slack:fetch', { token, channel, oldest, limit }),
    fetchReplies: (token, channel, ts, oldest, limit) => ipcRenderer.invoke('slack:fetchReplies', { token, channel, ts, oldest, limit }),
    post: (token, channel, text, threadTs) => ipcRenderer.invoke('slack:post', { token, channel, text, threadTs }),
    // TASK-073: request an LLM summary of already-cleaned+redacted auto-post
    // text. `enabled` reflects the per-folder summarization toggle; main reads
    // the ANTHROPIC_API_KEY and falls back to the input text when unavailable.
    summarize: (text, enabled) => ipcRenderer.invoke('slack:summarize', { text, enabled }),
    openSocket: (appToken) => ipcRenderer.invoke('slack:openSocket', { appToken }),
    startOAuth: () => ipcRenderer.invoke('slack:startOAuth'),
    onOAuthStarted: (cb) => {
      const listener = (_e, payload) => cb(payload);
      ipcRenderer.on('slack:oauthStarted', listener);
      return () => ipcRenderer.removeListener('slack:oauthStarted', listener);
    }
  },

  env: {
    get: (key) => ipcRenderer.invoke('env:get', { key }),
    set: (key, value) => ipcRenderer.invoke('env:set', { key, value })
  },

  agents: {
    // TASK-130: ask the main process to regenerate an agent-definition file from
    // its current text plus a natural-language instruction. Main reads
    // ANTHROPIC_API_KEY (never returned) and clamps the inputs; the returned
    // { ok, content, reason } is parsed + validated by the renderer before any
    // write, and only persisted when the user clicks Save.
    regenerate: (content, instruction) => ipcRenderer.invoke('agents:regenerate', { content, instruction })
  },

  skill: {
    // TASK-184: ask the main process to regenerate ONE phase-section's prose
    // body of the orchestrate SKILL.md from its current text plus a
    // natural-language instruction. Main reads ANTHROPIC_API_KEY (never
    // returned) and clamps the inputs; the returned { ok, content, reason } is
    // validated by the renderer (TASK-185) and only spliced back into
    // SKILL.md + written (scoped to that one phase's section, via
    // writeWithMirror) when the user clicks Save.
    regeneratePhase: (content, instruction) => ipcRenderer.invoke('skill:regeneratePhase', { content, instruction })
  },

  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', { url }),

  gitops: {
    onLog: (cb) => {
      const listener = (_e, payload) => cb(payload);
      ipcRenderer.on('gitops:log', listener);
      return () => ipcRenderer.removeListener('gitops:log', listener);
    }
  },

  session: {
    load: () => ipcRenderer.invoke('session:load'),
    save: (folders) => ipcRenderer.invoke('session:save', { folders })
  },

  telemetry: {
    // Read the receiver's current state ({ enabled, running, endpoint, forwardUrl,
    // forwardEnabled, hasToken, warnings }) and the accumulated usage snapshot.
    getState: () => ipcRenderer.invoke('telemetry:getState'),
    // Omit `project` for the existing app-wide/active-project default; pass a
    // project name to read that project's own bucket (TASK-156).
    getUsage: (project) => ipcRenderer.invoke('telemetry:getUsage', project),
    // Overlay a partial config ({ enabled?, forwardUrl?, forwardEnabled?,
    // forwardToken? }); omit forwardToken to leave it unchanged. Returns new state.
    setConfig: (partial) => ipcRenderer.invoke('telemetry:setConfig', partial),
    // Push one project's persisted "store online" toggle (cfg = { storeOnline })
    // to the receiver's per-project forward gate (TASK-156).
    setProjectConfig: (project, cfg) => ipcRenderer.invoke('telemetry:setProjectConfig', {
      project,
      storeOnline: cfg && cfg.storeOnline
    }),
    clear: () => ipcRenderer.invoke('telemetry:clear'),
    // Per-ticket cost correlation (TASK-142): { startedAt, finishedAt, model? } ->
    // { ok: true, usage: <totals>|null }. usage is null when telemetry is off/no
    // receiver; never throws.
    usageForWindow: (w) => ipcRenderer.invoke('telemetry:usageForWindow', w),
    // Per-prompt cost correlation (TASK-195): like usageForWindow above, but
    // scoped to ONE project's own telemetry bucket, so a different,
    // concurrently-running project's calls are never folded into a prompt's
    // total even if their timestamps fall inside the same window. `w` is
    // { startedAt, finishedAt, model? }; leave `model` empty/omitted to sum a
    // sequence that spans multiple models. -> { ok: true, usage: <totals>|null }.
    usageForWindowInProject: (project, w) => ipcRenderer.invoke('telemetry:usageForWindowInProject', { project, window: w }),
    // Tag forwarded summaries with the folder the user is currently focused on;
    // the renderer calls this as tabs are switched. Fire-and-forget.
    setActiveProject: (name) => ipcRenderer.invoke('telemetry:setActiveProject', name),
    // Live push after every ingest: cb({ usage, metricTotals, running, project,
    // projectUsage, projectRecent }). `projectRecent` is that project's
    // per-call rows, which feed the Stats tab's prompt log.
    onUpdate: (cb) => {
      const listener = (_e, payload) => cb(payload);
      ipcRenderer.on('telemetry:update', listener);
      return () => ipcRenderer.removeListener('telemetry:update', listener);
    }
  },

  usage: {
    // Weekly rate-limit usage for the cmd pane's usage bar, scraped from Claude
    // Code's `/usage` panel in an off-screen throwaway `claude` (lib/claude-usage-
    // probe.js). Resolves { ok: true, view, cached } where `view` carries
    // { ok, percent, pacePercent, state, label, title, … }; a failed scrape is a
    // view with ok:false + a reason, never a rejection.
    //
    // `cwd` must be a folder Claude Code already trusts (pass the tab's own
    // project folder) — the probe deliberately will not answer a trust prompt on
    // the user's behalf. `force` bypasses main's 5-minute cache.
    get: (arg) => ipcRenderer.invoke('usage:get', {
      cwd: arg && arg.cwd,
      force: !!(arg && arg.force)
    })
  }
});

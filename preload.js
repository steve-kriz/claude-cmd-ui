const { contextBridge, ipcRenderer, clipboard } = require('electron');

contextBridge.exposeInMainWorld('api', {
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
    writeFile: (filePath, content) => ipcRenderer.invoke('fs:writeFile', { path: filePath, content }),
    rename: (oldPath, newPath) => ipcRenderer.invoke('fs:rename', { oldPath, newPath }),
    findByExt: (root, ext, excludeDirs) => ipcRenderer.invoke('fs:findByExt', { root, ext, excludeDirs }),
    grep: (root, query) => ipcRenderer.invoke('fs:grep', { root, query })
  },

  prompts: {
    read: (cwd) => ipcRenderer.invoke('prompts:read', { cwd }),
    append: (cwd, entry) => ipcRenderer.invoke('prompts:append', { cwd, entry }),
    write: (cwd, entries) => ipcRenderer.invoke('prompts:write', { cwd, entries }),
    clear: (cwd) => ipcRenderer.invoke('prompts:clear', { cwd }),
    syncFromCloud: (cwd) => ipcRenderer.invoke('prompts:syncFromCloud', { cwd })
  },

  git: {
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
    checkClaude: () => ipcRenderer.invoke('cli:checkClaude')
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
    post: (token, channel, text, threadTs) => ipcRenderer.invoke('slack:post', { token, channel, text, threadTs }),
    openSocket: (appToken) => ipcRenderer.invoke('slack:openSocket', { appToken })
  },

  env: {
    get: (key) => ipcRenderer.invoke('env:get', { key }),
    set: (key, value) => ipcRenderer.invoke('env:set', { key, value })
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
  }
});

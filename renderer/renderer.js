'use strict';

window.addEventListener('error', (e) => {
  console.error('[renderer error]', e.message, e.error);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandled rejection]', e.reason);
});

if (!window.api) {
  console.error('[fatal] window.api is undefined — preload did not run');
}

const IDLE_MS = 2500;
const QUEUE_SEND_DELAY_MS = 300;
const QUEUE_ENTER_DELAY_MS = 180;

const TABS = new Map();
let activeTabId = null;
const ptyToTab = new Map();
let latestAwsStatus = null;
let restoringSession = false;

// Discovered AWS accounts (one button per account). Shared across all tabs and
// cached in localStorage so the buttons survive a restart without re-listing.
let awsEnvironments = [];
try {
  const rawEnvs = localStorage.getItem('aws.environments');
  if (rawEnvs) awsEnvironments = JSON.parse(rawEnvs) || [];
} catch (_) { awsEnvironments = []; }

function persistSession() {
  if (restoringSession) return;
  if (!window.api || !window.api.session) return;
  const folders = [];
  for (const btn of dom.workspaceTabs.children) {
    for (const [, t] of TABS) {
      if (t.els.tabBtn === btn && t.folder) {
        folders.push({ path: t.folder, agent: t.agent === 'opencode' ? 'opencode' : 'claude' });
        break;
      }
    }
  }
  window.api.session.save(folders).catch((e) => console.error('[session.save]', e));
}

const dom = {
  workspaceTabs: document.getElementById('workspaceTabs'),
  newTabBtn: document.getElementById('newTabBtn'),
  emptyState: document.getElementById('empty-state'),
  workspaces: document.getElementById('workspaces'),
  browseBtn2: document.getElementById('browseBtn2'),
  workspaceTpl: document.getElementById('workspaceTpl'),
  workspaceTabTpl: document.getElementById('workspaceTabTpl')
};

const TERM_THEME = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510',
  blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
  brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b',
  brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6',
  brightCyan: '#29b8db', brightWhite: '#ffffff'
};

function getTerminalCtor() {
  if (!window.Terminal) throw new Error('xterm.js did not load (window.Terminal undefined)');
  return window.Terminal;
}
function getFitAddonCtor() {
  const ns = window.FitAddon;
  if (!ns) throw new Error('xterm addon-fit did not load (window.FitAddon undefined)');
  return typeof ns === 'function' ? ns : ns.FitAddon;
}

function makeTerminal(container) {
  const Terminal = getTerminalCtor();
  const FitAddon = getFitAddonCtor();
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: 'Consolas, "Courier New", monospace',
    fontSize: 13,
    theme: TERM_THEME,
    scrollback: 5000,
    allowProposedApi: true,
    rightClickSelectsWord: false,
    windowsPty: { backend: 'conpty' }
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  attachClipboard(term, container);
  try { fit.fit(); } catch (_) {}
  requestAnimationFrame(() => { try { fit.fit(); } catch (_) {} });
  return { term, fit };
}

function clipboardRead() {
  try {
    if (window.api && window.api.clipboard) return window.api.clipboard.readText() || '';
  } catch (_) {}
  return '';
}

function clipboardWrite(text) {
  try {
    if (window.api && window.api.clipboard) window.api.clipboard.writeText(text);
  } catch (_) {}
}

function pasteIntoTerm(term) {
  const text = clipboardRead();
  if (text) term.paste(text);
}

function copyTermSelection(term) {
  const sel = term.getSelection();
  if (!sel) return false;
  clipboardWrite(sel);
  term.clearSelection();
  return true;
}

function attachClipboard(term, container) {
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const ctrl = e.ctrlKey;
    const shift = e.shiftKey;
    const k = (e.key || '').toLowerCase();

    // Paste: Ctrl+V, Ctrl+Shift+V, Shift+Insert
    // preventDefault is required so the browser does not also dispatch a
    // native paste event to xterm.js's helper textarea (which would cause a
    // double paste on top of our explicit term.paste() call).
    if ((ctrl && !e.altKey && k === 'v') || (shift && e.key === 'Insert')) {
      e.preventDefault();
      e.stopPropagation();
      pasteIntoTerm(term);
      return false;
    }

    // Explicit copy: Ctrl+Shift+C, Ctrl+Insert (always copy when selection)
    if ((ctrl && shift && k === 'c') || (ctrl && !shift && e.key === 'Insert')) {
      e.preventDefault();
      e.stopPropagation();
      copyTermSelection(term);
      return false;
    }

    // Ctrl+C: copy when there's a selection; otherwise let SIGINT through to the shell
    if (ctrl && !shift && k === 'c') {
      if (copyTermSelection(term)) return false;
      return true;
    }

    return true;
  });

  container.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!copyTermSelection(term)) pasteIntoTerm(term);
  });
}

function fmtExpiry(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  } catch (_) { return '—'; }
}

// ───────────────────────────────────────────────────────── tabs

function createTab() {
  const id = 'tab-' + crypto.randomUUID().slice(0, 8);
  const ws = dom.workspaceTpl.content.firstElementChild.cloneNode(true);
  const tabBtn = dom.workspaceTabTpl.content.firstElementChild.cloneNode(true);
  dom.workspaces.appendChild(ws);
  dom.workspaceTabs.appendChild(tabBtn);

  const tab = {
    id,
    folder: null,
    agent: 'claude',
    cmd: { id: null, term: null, fit: null },
    bash: { id: null, term: null, fit: null },
    activeSubTab: 'bash',
    filesLoaded: false,
    filterReadme: false,
    filterChanges: false,
    changedFileSet: new Set(),
    changedDirSet: new Set(),
    mdFileSet: new Set(),
    mdDirSet: new Set(),
    status: 'idle',
    idleTimer: null,
    hasOutput: false,
    chosenRoles: {},
    promptQueue: [],
    queueFiring: false,
    currentFilePath: null,
    fileOriginal: '',
    fileIsBinary: false,
    fileDirty: false,
    findScope: 'tree',
    findEditorMatches: [],
    findEditorIndex: -1,
    promptLog: [],
    cmdInputBuffer: '',
    inBracketedPaste: false,
    responseBuffer: '',
    pendingPromptIndex: -1,
    slack: {
      connected: false,
      token: '',
      appToken: '',
      channelId: '',
      channelName: '',
      botUserId: null,
      postReplies: true,
      intervalMs: 5000,
      pollTimer: null,
      polling: false,
      fetching: false,
      // 'socket' (persistent WebSocket / Socket Mode) or 'poll' (HTTP polling).
      transport: null,
      socket: null,
      socketClosing: false,
      socketReconnectTimer: null,
      socketReconnectDelay: 1000,
      lastTs: '0',
      // Separate baseline for thread-reply polling (conversations.replies). The
      // channel history and the anchor thread advance independently, so replies
      // use their own oldest cursor to avoid missing any. See pollSlackOnce.
      lastReplyTs: '0',
      seenTs: new Set(),
      messages: [],
      inbox: [],
      awaitingResponse: false,
      captureBuffer: '',
      replyThreadTs: null,
      // The single anchor thread for this connect session. All outbound posts
      // and inbound-reply gating use this thread_ts; null means the proxy is
      // inactive (no-op in both directions). See lib/slack-proxy.js.
      threadTs: null
    },
    tasks: {
      pollTimer: null,
      fetching: false,
      reconciling: false,
      tickets: new Map(),
      skillInstalled: null,
      lastSig: '',
      autoBuild: false,
      lanesBound: false
    },
    els: {
      ws,
      tabBtn,
      tabLabel: tabBtn.querySelector('.ws-tab-label'),
      tabQueueBadge: tabBtn.querySelector('.ws-tab-queue'),
      tabClose: tabBtn.querySelector('.ws-tab-close'),
      cmdPane: ws.querySelector('.cmdPane'),
      bashPane: ws.querySelector('.bashPane'),
      splitter: ws.querySelector('.splitter'),
      cmdTerm: ws.querySelector('.cmdTerm'),
      bashTerm: ws.querySelector('.bashTerm'),
      agentSelect: ws.querySelector('.agentSelect'),
      claudeStatus: ws.querySelector('.claudeStatus'),
      claudeBanner: ws.querySelector('.claudeInstallBanner'),
      claudeInstallNpmBtn: ws.querySelector('.claudeInstallNpmBtn'),
      claudeInstallPwshBtn: ws.querySelector('.claudeInstallPwshBtn'),
      claudeOpenDocsBtn: ws.querySelector('.claudeOpenDocsBtn'),
      claudeRecheckBtn: ws.querySelector('.claudeRecheckBtn'),
      claudeLaunchBtn: ws.querySelector('.claudeLaunchBtn'),
      opencodeBanner: ws.querySelector('.opencodeInstallBanner'),
      opencodeInstallBtn: ws.querySelector('.opencodeInstallBtn'),
      opencodeOpenDocsBtn: ws.querySelector('.opencodeOpenDocsBtn'),
      opencodeRecheckBtn: ws.querySelector('.opencodeRecheckBtn'),
      opencodeLaunchBtn: ws.querySelector('.opencodeLaunchBtn'),
      queueToggleBtn: ws.querySelector('.queueToggleBtn'),
      queueCount: ws.querySelector('.queueCount'),
      addPromptBtn: ws.querySelector('.addPromptBtn'),
      queuePanel: ws.querySelector('.queuePanel'),
      queueList: ws.querySelector('.queueList'),
      queueClearBtn: ws.querySelector('.queueClearBtn'),
      queueEditor: ws.querySelector('.queue-editor'),
      queueInput: ws.querySelector('.queueInput'),
      queueSaveBtn: ws.querySelector('.queueSaveBtn'),
      queueCancelBtn: ws.querySelector('.queueCancelBtn'),
      awsEnvMenu: ws.querySelector('.awsEnvMenu'),
      awsEnvBtn: ws.querySelector('.awsEnvBtn'),
      awsEnvPopup: ws.querySelector('.awsEnvPopup'),
      envLoadBtn: ws.querySelector('.envLoadBtn'),
      envBtns: ws.querySelector('.envBtns'),
      profileSelect: ws.querySelector('.profileSelect'),
      profileReloadBtn: ws.querySelector('.profileReloadBtn'),
      statusChip: ws.querySelector('.statusChip'),
      rolePicker: ws.querySelector('.rolePicker'),
      rolePickerEnv: ws.querySelector('.rolePickerEnv'),
      rolePickerList: ws.querySelector('.rolePickerList'),
      rolePickerCancel: ws.querySelector('.rolePickerCancel'),
      subTabBtns: ws.querySelectorAll('.tab-btn'),
      subTabViews: ws.querySelectorAll('.tab-view'),
      filesTree: ws.querySelector('.filesTree'),
      filesRefresh: ws.querySelector('.filesRefresh'),
      filterReadme: ws.querySelector('.filterReadme'),
      filterChanges: ws.querySelector('.filterChanges'),
      fileEditor: ws.querySelector('.fileEditor'),
      fileFindOverlay: ws.querySelector('.fileFindOverlay'),
      fileFindOverlayInner: ws.querySelector('.fileFindOverlayInner'),
      fileBinaryMsg: ws.querySelector('.fileBinaryMsg'),
      fileViewerPath: ws.querySelector('.fileViewerPath'),
      fileDirtyChip: ws.querySelector('.fileDirtyChip'),
      fileSaveBtn: ws.querySelector('.fileSaveBtn'),
      fileRenameBtn: ws.querySelector('.fileRenameBtn'),
      fileReloadBtn: ws.querySelector('.fileReloadBtn'),
      filePreviewBtn: ws.querySelector('.filePreviewBtn'),
      filePreview: ws.querySelector('.filePreview'),
      fileRenameRow: ws.querySelector('.fileRenameRow'),
      fileRenameInput: ws.querySelector('.fileRenameInput'),
      fileRenameConfirm: ws.querySelector('.fileRenameConfirm'),
      fileRenameCancel: ws.querySelector('.fileRenameCancel'),
      fileRenameError: ws.querySelector('.fileRenameError'),
      filesView: ws.querySelector('.tab-view[data-view="files"]'),
      filesFindBar: ws.querySelector('.filesFindBar'),
      filesFindInput: ws.querySelector('.filesFindInput'),
      filesFindCount: ws.querySelector('.filesFindCount'),
      filesFindPrev: ws.querySelector('.filesFindPrev'),
      filesFindNext: ws.querySelector('.filesFindNext'),
      filesFindClose: ws.querySelector('.filesFindClose'),
      filesFindScopeBtns: ws.querySelectorAll('.filesFindScopeBtn'),
      logsToggleBtn: ws.querySelector('.logsToggleBtn'),
      logsCount: ws.querySelector('.logsCount'),
      logsPanel: ws.querySelector('.logsPanel'),
      logsList: ws.querySelector('.logsList'),
      logsRefreshBtn: ws.querySelector('.logsRefreshBtn'),
      logsClearBtn: ws.querySelector('.logsClearBtn'),
      gitNotInstalledGate: ws.querySelector('.gitNotInstalledGate'),
      gitInstallStatus: ws.querySelector('.gitInstallStatus'),
      gitInstallWingetBtn: ws.querySelector('.gitInstallWingetBtn'),
      gitInstallDownloadBtn: ws.querySelector('.gitInstallDownloadBtn'),
      gitInstallRecheckBtn: ws.querySelector('.gitInstallRecheckBtn'),
      gitAuthGate: ws.querySelector('.gitAuthGate'),
      gitAuthStatus: ws.querySelector('.gitAuthStatus'),
      gitAuthLoginBtn: ws.querySelector('.gitAuthLoginBtn'),
      gitAuthRecheckBtn: ws.querySelector('.gitAuthRecheckBtn'),
      gitAuthedContent: ws.querySelector('.gitAuthed'),
      gitLogoutBtn: ws.querySelector('.gitLogoutBtn'),
      gitBranch: ws.querySelector('.gitBranch'),
      gitHeader: ws.querySelector('.gitHeader'),
      gitAheadBehind: ws.querySelector('.gitAheadBehind'),
      gitStatus: ws.querySelector('.gitStatus'),
      gitRefresh: ws.querySelector('.gitRefresh'),
      commitPushBtn: ws.querySelector('.commitPushBtn'),
      publishBtn: ws.querySelector('.publishBtn'),
      commitPanel: ws.querySelector('.commitPanel'),
      commitAheadBehind: ws.querySelector('.commitAheadBehind'),
      commitBranchInput: ws.querySelector('.commitBranchInput'),
      commitNewBranch: ws.querySelector('.commitNewBranch'),
      commitMessageInput: ws.querySelector('.commitMessageInput'),
      commitStageAll: ws.querySelector('.commitStageAll'),
      commitPushToggle: ws.querySelector('.commitPushToggle'),
      commitSetUpstream: ws.querySelector('.commitSetUpstream'),
      commitCancelBtn: ws.querySelector('.commitCancelBtn'),
      commitRunBtn: ws.querySelector('.commitRunBtn'),
      commitLog: ws.querySelector('.commitLog'),
      commitCheckinsList: ws.querySelector('.commitCheckinsList'),
      commitCheckinsCount: ws.querySelector('.commitCheckinsCount'),
      commitCheckinsRefreshBtn: ws.querySelector('.commitCheckinsRefreshBtn'),
      publishPanel: ws.querySelector('.publishPanel'),
      publishOwnerSelect: ws.querySelector('.publishOwnerSelect'),
      publishOwnerReloadBtn: ws.querySelector('.publishOwnerReloadBtn'),
      publishRepoInput: ws.querySelector('.publishRepoInput'),
      publishVisInputs: ws.querySelectorAll('.publishVis'),
      publishDescInput: ws.querySelector('.publishDescInput'),
      publishCommitInput: ws.querySelector('.publishCommitInput'),
      publishCancelBtn: ws.querySelector('.publishCancelBtn'),
      publishRunBtn: ws.querySelector('.publishRunBtn'),
      publishLog: ws.querySelector('.publishLog'),
      ghStatus: ws.querySelector('.ghStatus'),
      prBtn: ws.querySelector('.prBtn'),
      prPanel: ws.querySelector('.prPanel'),
      prGhStatus: ws.querySelector('.prGhStatus'),
      prCurrent: ws.querySelector('.prCurrent'),
      prTitleInput: ws.querySelector('.prTitleInput'),
      prBaseInput: ws.querySelector('.prBaseInput'),
      prBodyInput: ws.querySelector('.prBodyInput'),
      prDraftToggle: ws.querySelector('.prDraftToggle'),
      prCancelBtn: ws.querySelector('.prCancelBtn'),
      prRefreshBtn: ws.querySelector('.prRefreshBtn'),
      prCreateBtn: ws.querySelector('.prCreateBtn'),
      prLog: ws.querySelector('.prLog'),
      prReviewsList: ws.querySelector('.prReviewsList'),
      prReviewsFor: ws.querySelector('.prReviewsFor'),
      prOpenList: ws.querySelector('.prOpenList'),
      prOpenCount: ws.querySelector('.prOpenCount'),
      prOpenRefreshBtn: ws.querySelector('.prOpenRefreshBtn'),
      prSendToClaudeBtn: ws.querySelector('.prSendToClaudeBtn'),
      runActionBtn: ws.querySelector('.runActionBtn'),
      actionPanel: ws.querySelector('.actionPanel'),
      actionGhStatus: ws.querySelector('.actionGhStatus'),
      actionWorkflowSelect: ws.querySelector('.actionWorkflowSelect'),
      actionReloadWorkflowsBtn: ws.querySelector('.actionReloadWorkflowsBtn'),
      actionRefSelect: ws.querySelector('.actionRefSelect'),
      actionRefReloadBtn: ws.querySelector('.actionRefReloadBtn'),
      actionRefHint: ws.querySelector('.actionRefHint'),
      actionInputsInput: ws.querySelector('.actionInputsInput'),
      actionInputsFields: ws.querySelector('.actionInputsFields'),
      actionInputsFallback: ws.querySelector('.actionInputsFallback'),
      actionInputsHint: ws.querySelector('.actionInputsHint'),
      actionCancelBtn: ws.querySelector('.actionCancelBtn'),
      actionRunBtn: ws.querySelector('.actionRunBtn'),
      actionOpenRunBtn: ws.querySelector('.actionOpenRunBtn'),
      actionLog: ws.querySelector('.actionLog'),
      changeCount: ws.querySelector('.changeCount'),
      diffFileList: ws.querySelector('.diffFileList'),
      diffContent: ws.querySelector('.diffContent'),
      diffRefresh: ws.querySelector('.diffRefresh'),
      testsView: ws.querySelector('.tab-view[data-view="tests"]'),
      testsRefresh: ws.querySelector('.testsRefresh'),
      testsCount: ws.querySelector('.testsCount'),
      unitTestsGroup: ws.querySelector('.unitTestsGroup'),
      unitTestsBody: ws.querySelector('.unitTestsBody'),
      unitTestsCount: ws.querySelector('.unitTestsCount'),
      unitTestsRunAllBtn: ws.querySelector('.unitTestsRunAllBtn'),
      unitTestsUpdateBtn: ws.querySelector('.unitTestsUpdateBtn'),
      uiTestsGroup: ws.querySelector('.uiTestsGroup'),
      uiTestsBody: ws.querySelector('.uiTestsBody'),
      uiTestsCount: ws.querySelector('.uiTestsCount'),
      uiTestsRunAllBtn: ws.querySelector('.uiTestsRunAllBtn'),
      uiTestsWatch: ws.querySelector('.uiTestsWatch'),
      uiTestsHeaded: ws.querySelector('.uiTestsHeaded'),
      uiTestsOutput: ws.querySelector('.uiTestsOutput'),
      slackTabDot: ws.querySelector('.slackTabDot'),
      slackStatus: ws.querySelector('.slackStatus'),
      slackPollToggle: ws.querySelector('.slackPollToggle'),
      slackConnectBtn: ws.querySelector('.slackConnectBtn'),
      slackDisconnectBtn: ws.querySelector('.slackDisconnectBtn'),
      slackConnectPanel: ws.querySelector('.slackConnectPanel'),
      slackSignInBtn: ws.querySelector('.slackSignInBtn'),
      slackLoadTokenBtn: ws.querySelector('.slackLoadTokenBtn'),
      slackTokenStatus: ws.querySelector('.slackTokenStatus'),
      slackChannelInput: ws.querySelector('.slackChannelInput'),
      slackIntervalSelect: ws.querySelector('.slackIntervalSelect'),
      slackPostReplies: ws.querySelector('.slackPostReplies'),
      slackTestConnectBtn: ws.querySelector('.slackTestConnectBtn'),
      slackConnectError: ws.querySelector('.slackConnectError'),
      slackChat: ws.querySelector('.slackChat'),
      slackMessages: ws.querySelector('.slackMessages'),
      slackComposerInput: ws.querySelector('.slackComposerInput'),
      slackSendBtn: ws.querySelector('.slackSendBtn'),
      tasksStatus: ws.querySelector('.tasksStatus'),
      tasksConcurrency: ws.querySelector('.tasksConcurrency'),
      tasksNewBtn: ws.querySelector('.tasksNewBtn'),
      tasksBuildBtn: ws.querySelector('.tasksBuildBtn'),
      tasksRefresh: ws.querySelector('.tasksRefresh'),
      tasksSkillBanner: ws.querySelector('.tasksSkillBanner'),
      tasksInstallSkillBtn: ws.querySelector('.tasksInstallSkillBtn'),
      tasksEmpty: ws.querySelector('.tasksEmpty'),
      tasksBoard: ws.querySelector('.tasksBoard'),
      tasksLanes: ws.querySelectorAll('.tasks-lane')
    },
    uiTestWatch: { active: false }
  };

  tab.els.tabLabel.textContent = '(empty)';
  TABS.set(id, tab);

  for (const btn of tab.els.subTabBtns) {
    btn.addEventListener('click', () => switchSubTab(tab, btn.dataset.tab));
  }
  tab.els.filesRefresh.addEventListener('click', async () => {
    tab.filesLoaded = false;
    if (!tab.folder) return;
    tab.filesLoaded = true;
    if (tab.filterChanges) await loadChangedPaths(tab);
    if (tab.filterReadme) await loadMdPaths(tab);
    renderFiles(tab);
  });
  tab.els.tasksRefresh.addEventListener('click', () => pollTasksOnce(tab, true));
  tab.els.tasksInstallSkillBtn.addEventListener('click', () => installOrchestrateSkill(tab));
  tab.els.tasksNewBtn.addEventListener('click', () => openNewTaskModal(tab));
  tab.els.tasksBuildBtn.addEventListener('click', () => toggleAutoBuild(tab));
  if (tab.els.tasksConcurrency) {
    tab.els.tasksConcurrency.addEventListener('change', () => onTasksConcurrencyChange(tab));
    initTasksConcurrency(tab); // build options up front so the select is never empty
  }
  bindTaskLaneDrop(tab);
  tab.els.filterReadme.addEventListener('change', async () => {
    tab.filterReadme = tab.els.filterReadme.checked;
    if (!tab.folder) return;
    if (tab.filterReadme) await loadMdPaths(tab);
    tab.filesLoaded = true;
    renderFiles(tab);
  });
  tab.els.filterChanges.addEventListener('change', async () => {
    tab.filterChanges = tab.els.filterChanges.checked;
    if (!tab.folder) return;
    if (tab.filterChanges) await loadChangedPaths(tab);
    tab.filesLoaded = true;
    renderFiles(tab);
  });
  tab.els.fileEditor.addEventListener('input', () => onFileEditorInput(tab));
  tab.els.fileEditor.addEventListener('scroll', () => syncFileFindOverlayScroll(tab));
  tab.els.fileSaveBtn.addEventListener('click', () => saveCurrentFile(tab));
  tab.els.fileReloadBtn.addEventListener('click', () => reloadCurrentFile(tab));
  tab.els.filePreviewBtn.addEventListener('click', () => toggleFilePreview(tab));
  tab.els.fileRenameBtn.addEventListener('click', () => openRenameRow(tab));
  tab.els.fileRenameCancel.addEventListener('click', () => closeRenameRow(tab));
  tab.els.fileRenameConfirm.addEventListener('click', () => confirmRename(tab));
  tab.els.fileRenameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirmRename(tab); }
    else if (e.key === 'Escape') { e.preventDefault(); closeRenameRow(tab); }
  });
  tab.els.fileEditor.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      saveCurrentFile(tab);
    }
  });

  // Per-view Ctrl+F (fires when focus is already inside the Files tab — editor,
  // toolbar button, or the now-focusable tree). The window-level handler below
  // covers the case where nothing inside the Files tab has focus.
  tab.els.filesView.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      openFilesFind(tab, 'editor');
    }
  });
  tab.els.filesFindInput.addEventListener('input', () => onFilesFindInput(tab));
  tab.els.filesFindInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeFilesFind(tab); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) findPrev(tab); else findNext(tab);
    }
  });
  tab.els.filesFindClose.addEventListener('click', () => closeFilesFind(tab));
  tab.els.filesFindPrev.addEventListener('click', () => findPrev(tab));
  tab.els.filesFindNext.addEventListener('click', () => findNext(tab));
  for (const btn of tab.els.filesFindScopeBtns) {
    btn.addEventListener('click', () => setFilesFindScope(tab, btn.dataset.scope));
  }

  tab.els.logsToggleBtn.addEventListener('click', () => toggleLogsPanel(tab));
  tab.els.logsRefreshBtn.addEventListener('click', () => loadPromptLog(tab, true));
  tab.els.logsClearBtn.addEventListener('click', () => clearPromptLog(tab));

  tab.els.gitRefresh.addEventListener('click', () => refreshGitStatus(tab));
  tab.els.gitAuthLoginBtn.addEventListener('click', () => startGhLogin(tab));
  tab.els.gitAuthRecheckBtn.addEventListener('click', () => checkGitAuthAndGate(tab, true));
  if (tab.els.gitInstallWingetBtn) {
    tab.els.gitInstallWingetBtn.addEventListener('click', () => startGitInstall(tab));
  }
  if (tab.els.gitInstallDownloadBtn) {
    tab.els.gitInstallDownloadBtn.addEventListener('click', () => {
      if (window.api.openExternal) window.api.openExternal('https://git-scm.com/download/win');
    });
  }
  if (tab.els.gitInstallRecheckBtn) {
    tab.els.gitInstallRecheckBtn.addEventListener('click', () => checkGitAuthAndGate(tab, true));
  }
  tab.els.gitLogoutBtn.addEventListener('click', () => startGhLogout(tab));
  tab.els.commitPushBtn.addEventListener('click', () => openCommitPanel(tab));
  tab.els.publishBtn.addEventListener('click', () => openPublishPanel(tab));
  tab.els.commitCancelBtn.addEventListener('click', () => tab.els.commitPanel.classList.add('hidden'));
  tab.els.publishCancelBtn.addEventListener('click', () => tab.els.publishPanel.classList.add('hidden'));
  tab.els.commitNewBranch.addEventListener('change', () => promptNewBranchName(tab));
  tab.els.commitRunBtn.addEventListener('click', () => runCommitPush(tab));
  if (tab.els.commitCheckinsRefreshBtn) {
    tab.els.commitCheckinsRefreshBtn.addEventListener('click', () => loadRecentCheckins(tab));
  }
  tab.els.publishRunBtn.addEventListener('click', () => runPublish(tab));
  tab.els.publishOwnerReloadBtn.addEventListener('click', () => loadPublishOwners(tab, true));
  tab.els.prBtn.addEventListener('click', () => openPRPanel(tab));
  tab.els.prCancelBtn.addEventListener('click', () => tab.els.prPanel.classList.add('hidden'));
  if (tab.els.gitAuthedContent) {
    tab.els.gitAuthedContent.addEventListener('click', (ev) => {
      const header = ev.target.closest('.git-section-header');
      if (!header || !tab.els.gitAuthedContent.contains(header)) return;
      if (ev.target.closest('button, input, select, textarea, a')) return;
      const section = header.parentElement;
      if (section && section.classList.contains('git-section')) {
        section.classList.toggle('collapsed');
      }
    });
  }
  tab.els.prCreateBtn.addEventListener('click', () => createPullRequest(tab));
  tab.els.prRefreshBtn.addEventListener('click', () => refreshPRReviews(tab));
  tab.els.prOpenRefreshBtn.addEventListener('click', () => loadOpenPRs(tab));
  tab.els.prSendToClaudeBtn.addEventListener('click', () => sendPrCommentsToClaude(tab));
  tab.els.runActionBtn.addEventListener('click', () => openActionPanel(tab));
  tab.els.actionCancelBtn.addEventListener('click', () => tab.els.actionPanel.classList.add('hidden'));
  tab.els.actionRunBtn.addEventListener('click', () => runActionWorkflow(tab));
  tab.els.actionOpenRunBtn.addEventListener('click', () => {
    const url = tab.els.actionOpenRunBtn.dataset.url;
    if (url && window.api.openExternal) window.api.openExternal(url);
  });
  tab.els.actionReloadWorkflowsBtn.addEventListener('click', () => loadActionWorkflows(tab));
  tab.els.actionRefReloadBtn.addEventListener('click', () => loadActionBranches(tab));
  tab.els.actionWorkflowSelect.addEventListener('change', () => loadSelectedWorkflowInputs(tab));
  tab.els.diffRefresh.addEventListener('click', () => refreshDiff(tab));
  tab.els.testsRefresh.addEventListener('click', () => refreshTests(tab));
  tab.els.unitTestsRunAllBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    runAllTestsCommand(tab, 'unit');
  });
  tab.els.uiTestsRunAllBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    runAllTestsCommand(tab, 'ui');
  });
  // The watch toggle lives inside the <summary>; without stopPropagation a
  // click on the label/checkbox bubbles up and toggles the <details> open/closed.
  tab.els.uiTestsWatch.addEventListener('click', (e) => e.stopPropagation());
  tab.els.uiTestsWatch.addEventListener('change', () => {
    if (!tab.els.uiTestsWatch.checked) {
      tab.uiTestWatch.active = false;
      tab.els.uiTestsOutput.classList.add('hidden');
    }
  });
  tab.els.uiTestsHeaded.addEventListener('click', (e) => e.stopPropagation());
  tab.els.unitTestsUpdateBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    injectUpdateUnitTestsPrompt(tab);
  });
  tab.els.awsEnvBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAwsEnvPopup(tab);
  });
  // Keep clicks inside the popup from bubbling to the document-level close handler.
  tab.els.awsEnvPopup.addEventListener('click', (e) => e.stopPropagation());
  tab.els.envLoadBtn.addEventListener('click', () => loadEnvironments(tab));
  tab.els.profileReloadBtn.addEventListener('click', () => loadProfilesOnTab(tab));
  tab.els.rolePickerCancel.addEventListener('click', () => hideRolePicker(tab));
  loadProfilesOnTab(tab);

  tab.els.queueToggleBtn.addEventListener('click', () => toggleQueuePanel(tab));
  tab.els.addPromptBtn.addEventListener('click', () => openQueueEditor(tab));
  tab.els.queueCancelBtn.addEventListener('click', () => closeQueueEditor(tab));
  tab.els.queueSaveBtn.addEventListener('click', () => saveQueuePrompt(tab));
  tab.els.queueInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      saveQueuePrompt(tab);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeQueueEditor(tab);
    }
  });
  tab.els.queueClearBtn.addEventListener('click', () => {
    tab.promptQueue = [];
    renderQueue(tab);
  });

  tab.els.slackConnectBtn.addEventListener('click', () => showSlackConnectForm(tab));
  tab.els.slackDisconnectBtn.addEventListener('click', () => disconnectSlack(tab));
  tab.els.slackSignInBtn.addEventListener('click', () => signInWithSlack(tab));
  tab.els.slackLoadTokenBtn.addEventListener('click', () => ensureSlackToken(tab, true));
  tab.els.slackTestConnectBtn.addEventListener('click', () => connectSlack(tab));
  tab.els.slackPollToggle.addEventListener('change', () => {
    if (!tab.slack.connected) { tab.els.slackPollToggle.checked = false; return; }
    if (tab.els.slackPollToggle.checked) startSlackListening(tab);
    else stopSlackListening(tab);
  });
  tab.els.slackSendBtn.addEventListener('click', () => sendSlackComposer(tab));
  tab.els.slackComposerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendSlackComposer(tab);
    }
  });

  tab.els.claudeInstallNpmBtn.addEventListener('click', () => {
    runInCmdPty(tab, 'npm install -g @anthropic-ai/claude-code');
  });
  tab.els.claudeInstallPwshBtn.addEventListener('click', () => {
    // Recommended native Windows installer from claude.ai.
    runInCmdPty(tab, 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"');
  });
  tab.els.claudeOpenDocsBtn.addEventListener('click', () => {
    if (window.api.openExternal) window.api.openExternal('https://docs.claude.com/en/docs/claude-code/setup');
  });
  tab.els.claudeRecheckBtn.addEventListener('click', () => recheckClaude(tab));
  tab.els.claudeLaunchBtn.addEventListener('click', () => {
    runInCmdPty(tab, 'claude');
    tab.els.claudeBanner.classList.add('hidden');
  });

  tab.els.agentSelect.addEventListener('change', () => {
    const agent = tab.els.agentSelect.value === 'opencode' ? 'opencode' : 'claude';
    if (agent === tab.agent) return;
    tab.agent = agent;
    persistSession();
    if (!tab.folder) return;
    launchCmdAgent(tab).catch((e) => console.error('[agentSelect]', e));
  });

  tab.els.opencodeInstallBtn.addEventListener('click', () => {
    // opencode's official installer; runs in the Git Bash that now backs the cmd pane.
    runInCmdPty(tab, 'curl -fsSL https://opencode.ai/install | bash');
  });
  tab.els.opencodeOpenDocsBtn.addEventListener('click', () => {
    if (window.api.openExternal) window.api.openExternal('https://opencode.ai/docs/');
  });
  tab.els.opencodeRecheckBtn.addEventListener('click', () => recheckOpencode(tab));
  tab.els.opencodeLaunchBtn.addEventListener('click', () => {
    runInCmdPty(tab, 'opencode');
    tab.els.opencodeBanner.classList.add('hidden');
  });

  tab.els.tabBtn.addEventListener('click', (e) => {
    if (e.target === tab.els.tabClose) return;
    activateTab(id);
  });
  tab.els.tabClose.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(id);
  });
  attachTabDragHandlers(tab);

  setupSplitter(tab);
  renderEnvButtons(tab);
  setTabStatus(tab, 'idle');
  renderQueue(tab);

  return tab;
}

function activateTab(id) {
  if (!TABS.has(id)) return;
  activeTabId = id;
  for (const [tid, t] of TABS) {
    const isActive = tid === id;
    t.els.ws.classList.toggle('active', isActive);
    t.els.tabBtn.classList.toggle('active', isActive);
  }
  const t = TABS.get(id);
  // Green is an unread-style indicator: once the user looks at the tab,
  // the "needs attention" cue is satisfied. Drop it back to idle so the
  // next finish is what re-lights the dot.
  if (t && t.status === 'finished') setTabStatus(t, 'idle');
  if (t) {
    if (window.api && window.api.setTitle) {
      const segments = (t.folder || '').split(/[\\/]+/).filter(Boolean);
      const leaf = segments[segments.length - 1] || 'Claude CMD UI';
      window.api.setTitle(leaf);
      document.title = leaf;
    }
    requestAnimationFrame(() => fitTab(t));
  }
}

function closeTab(id) {
  const tab = TABS.get(id);
  if (!tab) return;
  if (tab.cmd.id) { window.api.pty.kill(tab.cmd.id); ptyToTab.delete(tab.cmd.id); }
  if (tab.bash.id) { window.api.pty.kill(tab.bash.id); ptyToTab.delete(tab.bash.id); }
  if (tab.idleTimer) { clearTimeout(tab.idleTimer); tab.idleTimer = null; }
  if (tab.slack) stopSlackListening(tab);
  if (tab.tasks && tab.tasks.pollTimer) { clearInterval(tab.tasks.pollTimer); tab.tasks.pollTimer = null; }
  try { tab.cmd.term && tab.cmd.term.dispose(); } catch (_) {}
  try { tab.bash.term && tab.bash.term.dispose(); } catch (_) {}
  tab.els.ws.remove();
  tab.els.tabBtn.remove();
  TABS.delete(id);

  if (activeTabId === id) {
    activeTabId = null;
    const remaining = Array.from(TABS.keys());
    if (remaining.length) {
      activateTab(remaining[remaining.length - 1]);
    } else {
      dom.emptyState.classList.remove('hidden');
      document.title = 'Claude CMD UI';
      if (window.api && window.api.setTitle) window.api.setTitle('Claude CMD UI');
    }
  }
  persistSession();
}

let draggingTabId = null;

function attachTabDragHandlers(tab) {
  const btn = tab.els.tabBtn;
  btn.addEventListener('dragstart', (e) => {
    draggingTabId = tab.id;
    btn.classList.add('ws-tab-dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      // Firefox requires data to be set for the drag to start.
      try { e.dataTransfer.setData('text/plain', tab.id); } catch (_) {}
    }
  });
  btn.addEventListener('dragend', () => {
    btn.classList.remove('ws-tab-dragging');
    draggingTabId = null;
    clearTabDropMarkers();
    persistSession();
  });
  btn.addEventListener('dragover', (e) => {
    if (!draggingTabId || draggingTabId === tab.id) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const rect = btn.getBoundingClientRect();
    const before = (e.clientX - rect.left) < rect.width / 2;
    clearTabDropMarkers();
    btn.classList.add(before ? 'ws-tab-drop-before' : 'ws-tab-drop-after');
  });
  btn.addEventListener('dragleave', () => {
    btn.classList.remove('ws-tab-drop-before', 'ws-tab-drop-after');
  });
  btn.addEventListener('drop', (e) => {
    if (!draggingTabId || draggingTabId === tab.id) return;
    e.preventDefault();
    const src = TABS.get(draggingTabId);
    if (!src) return;
    const rect = btn.getBoundingClientRect();
    const before = (e.clientX - rect.left) < rect.width / 2;
    if (before) dom.workspaceTabs.insertBefore(src.els.tabBtn, btn);
    else dom.workspaceTabs.insertBefore(src.els.tabBtn, btn.nextSibling);
    clearTabDropMarkers();
  });
}

function clearTabDropMarkers() {
  for (const el of dom.workspaceTabs.querySelectorAll('.ws-tab-drop-before, .ws-tab-drop-after')) {
    el.classList.remove('ws-tab-drop-before', 'ws-tab-drop-after');
  }
}

async function pickFolderForNewTab() {
  try {
    if (!window.api || !window.api.pickFolder) {
      alert('preload bridge missing — see DevTools console');
      return;
    }
    const res = await window.api.pickFolder();
    if (!res) return;
    dom.emptyState.classList.add('hidden');
    const tab = createTab();
    activateTab(tab.id);
    await openFolderInTab(tab, res.path);
  } catch (err) {
    console.error('[pickFolderForNewTab failed]', err);
    alert('Browse failed: ' + (err && err.message ? err.message : err));
  }
}

async function openFolderInTab(tab, folder) {
  if (tab.cmd.id) { await window.api.pty.kill(tab.cmd.id); ptyToTab.delete(tab.cmd.id); tab.cmd.id = null; }
  if (tab.bash.id) { await window.api.pty.kill(tab.bash.id); ptyToTab.delete(tab.bash.id); tab.bash.id = null; }

  tab.folder = folder;
  tab.filesLoaded = false;
  tab.hasOutput = false;
  if (tab.idleTimer) { clearTimeout(tab.idleTimer); tab.idleTimer = null; }

  const segments = folder.split(/[\\/]+/).filter(Boolean);
  const leaf = segments[segments.length - 1] || folder;
  tab.els.tabLabel.textContent = leaf;
  tab.els.tabBtn.title = folder;

  if (activeTabId === tab.id) {
    document.title = leaf;
    if (window.api && window.api.setTitle) window.api.setTitle(leaf);
  }

  tab.els.filesTree.innerHTML = '';
  tab.filterReadme = false;
  tab.filterChanges = false;
  tab.changedFileSet = new Set();
  tab.changedDirSet = new Set();
  tab.mdFileSet = new Set();
  tab.mdDirSet = new Set();
  tab.els.filterReadme.checked = false;
  tab.els.filterChanges.checked = false;
  closeFilesFind(tab);
  tab.els.gitStatus.textContent = '(switch to Git tab to load)';
  tab.els.gitBranch.textContent = '—';
  tab.els.gitHeader.textContent = '';
  if (tab.els.gitAheadBehind) {
    tab.els.gitAheadBehind.textContent = '';
    tab.els.gitAheadBehind.classList.remove('ahead-behind-clean', 'ahead-behind-warn', 'ahead-behind-error');
  }
  tab.els.diffFileList.innerHTML = '';
  tab.els.diffContent.classList.remove('conflict-resolver');
  tab.els.diffContent.textContent = '(select a file)';
  setChangeCount(tab, 0);
  updateChangeCount(tab).catch((e) => console.error('[changeCount]', e));
  resetFileEditor(tab);
  tab.promptLog = [];
  renderLogsList(tab);
  tab.els.logsPanel.classList.add('hidden');
  loadPromptLog(tab, false).catch((e) => console.error('[promptLog]', e));

  resetSlackForFolder(tab);
  resetTasksForFolder(tab);

  if (!tab.cmd.term) {
    const t1 = makeTerminal(tab.els.cmdTerm);
    tab.cmd.term = t1.term; tab.cmd.fit = t1.fit;
  } else {
    tab.cmd.term.clear();
  }
  if (!tab.bash.term) {
    const t2 = makeTerminal(tab.els.bashTerm);
    tab.bash.term = t2.term; tab.bash.fit = t2.fit;
  } else {
    tab.bash.term.clear();
  }

  requestAnimationFrame(() => fitTab(tab));

  setTabStatus(tab, 'busy');
  tab.els.agentSelect.value = tab.agent || 'claude';
  await launchCmdAgent(tab);
  await spawnTerm(tab, 'bash', 'bash');
  persistSession();
}

// (Re)launch the chosen agent in the cmd pane. Claude runs in cmd.exe; openCode
// runs in Git Bash. Switching agents kills the current cmd PTY and respawns it.
async function launchCmdAgent(tab) {
  const agent = tab.agent === 'opencode' ? 'opencode' : 'claude';
  if (tab.cmd.id) {
    await window.api.pty.kill(tab.cmd.id);
    ptyToTab.delete(tab.cmd.id);
    tab.cmd.id = null;
  }
  if (tab.cmd.term) tab.cmd.term.clear();

  if (agent === 'opencode') {
    tab.els.claudeBanner.classList.add('hidden');
    const res = await detectOpencode(tab);
    if (res.installed) {
      await spawnTerm(tab, 'cmd', 'bash', { cliCommand: 'opencode' });
    } else {
      // Spawn a plain Git Bash so the install banner's commands have a shell to run in.
      await spawnTerm(tab, 'cmd', 'bash');
    }
  } else {
    tab.els.opencodeBanner.classList.add('hidden');
    await detectClaude(tab);
    await spawnTerm(tab, 'cmd', 'cmd', { cliCommand: 'claude' });
  }
  requestAnimationFrame(() => fitTab(tab));
}

async function detectClaude(tab) {
  try {
    tab.els.claudeStatus.textContent = '(checking…)';
    tab.els.claudeStatus.className = 'claudeStatus pane-subtitle';
    const res = await window.api.cli.checkClaude();
    if (res && res.installed) {
      const label = res.version ? `(claude ${res.version})` : '(claude found)';
      tab.els.claudeStatus.textContent = label;
      tab.els.claudeStatus.classList.add('ok');
      tab.els.claudeBanner.classList.add('hidden');
      tab.claudeInstalled = true;
      return { installed: true };
    }
    tab.claudeInstalled = false;
    tab.els.claudeStatus.textContent = '(not installed)';
    tab.els.claudeStatus.classList.add('bad');
    tab.els.claudeBanner.classList.remove('hidden');
    tab.els.claudeLaunchBtn.disabled = true;
    return { installed: false };
  } catch (err) {
    console.error('[detectClaude]', err);
    tab.claudeInstalled = false;
    tab.els.claudeStatus.textContent = '(check failed)';
    tab.els.claudeStatus.classList.add('bad');
    tab.els.claudeBanner.classList.remove('hidden');
    return { installed: false };
  }
}

async function recheckClaude(tab) {
  const res = await detectClaude(tab);
  // If claude just became available and the cmd PTY is alive and we never
  // autolaunched, enable the manual launch button so the user can fire it.
  if (res.installed && tab.cmd.id) {
    tab.els.claudeLaunchBtn.disabled = false;
  }
}

async function detectOpencode(tab) {
  try {
    tab.els.claudeStatus.textContent = '(checking…)';
    tab.els.claudeStatus.className = 'claudeStatus pane-subtitle';
    const res = await window.api.cli.checkOpencode();
    if (res && res.installed) {
      const label = res.version ? `(opencode ${res.version})` : '(opencode found)';
      tab.els.claudeStatus.textContent = label;
      tab.els.claudeStatus.classList.add('ok');
      tab.els.opencodeBanner.classList.add('hidden');
      tab.opencodeInstalled = true;
      return { installed: true };
    }
    tab.opencodeInstalled = false;
    tab.els.claudeStatus.textContent = '(not installed)';
    tab.els.claudeStatus.classList.add('bad');
    tab.els.opencodeBanner.classList.remove('hidden');
    tab.els.opencodeLaunchBtn.disabled = true;
    return { installed: false };
  } catch (err) {
    console.error('[detectOpencode]', err);
    tab.opencodeInstalled = false;
    tab.els.claudeStatus.textContent = '(check failed)';
    tab.els.claudeStatus.classList.add('bad');
    tab.els.opencodeBanner.classList.remove('hidden');
    return { installed: false };
  }
}

async function recheckOpencode(tab) {
  const res = await detectOpencode(tab);
  // If opencode just became available, enable the manual launch button.
  if (res.installed && tab.cmd.id) {
    tab.els.opencodeLaunchBtn.disabled = false;
  }
}

function runInCmdPty(tab, command) {
  if (!tab.cmd.id) {
    alert('cmd terminal is not running yet.');
    return;
  }
  try {
    window.api.pty.write(tab.cmd.id, command + '\r');
  } catch (err) {
    console.error('[runInCmdPty]', err);
  }
}

async function spawnTerm(tab, slot, shell, extra) {
  const id = crypto.randomUUID();
  tab[slot].id = id;
  ptyToTab.set(id, { tab, slot });
  try { tab[slot].fit && tab[slot].fit.fit(); } catch (_) {}
  // Dispose listeners from any previous spawn into this terminal (agent switch)
  // so input isn't written to the PTY more than once.
  try { tab[slot].resizeListener && tab[slot].resizeListener.dispose(); } catch (_) {}
  try { tab[slot].dataListener && tab[slot].dataListener.dispose(); } catch (_) {}
  tab[slot].resizeListener = tab[slot].term.onResize(({ cols, rows }) => window.api.pty.resize(id, cols, rows));
  const { cols, rows } = tab[slot].term;
  const spawnOpts = { id, shell, cwd: tab.folder, cols, rows };
  if (extra && extra.cliCommand) spawnOpts.cliCommand = extra.cliCommand;
  await window.api.pty.spawn(spawnOpts);
  tab[slot].dataListener = tab[slot].term.onData((data) => {
    window.api.pty.write(id, data);
    if (slot === 'cmd') {
      onCmdUserInput(tab);
      captureCmdInput(tab, data);
    }
  });
  try { window.api.pty.resize(id, tab[slot].term.cols, tab[slot].term.rows); } catch (_) {}
}

function fitTab(tab) {
  try { tab.cmd.fit && tab.cmd.fit.fit(); } catch (_) {}
  try { tab.bash.fit && tab.bash.fit.fit(); } catch (_) {}
}

function setupSplitter(tab) {
  const splitter = tab.els.splitter;
  let dragging = false;
  splitter.addEventListener('mousedown', (e) => {
    dragging = true;
    splitter.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    if (activeTabId !== tab.id) return;
    const total = tab.els.ws.clientWidth;
    const left = Math.max(200, Math.min(total - 204, e.clientX));
    const leftPct = (left / total) * 100;
    const rightPct = 100 - leftPct - (4 / total) * 100;
    tab.els.cmdPane.style.flex = `0 0 ${leftPct}%`;
    tab.els.bashPane.style.flex = `0 0 ${rightPct}%`;
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove('dragging');
    document.body.style.cursor = '';
    fitTab(tab);
  });
}

// ───────────────────────────────────────────────────────── claude status

function setTabStatus(tab, status) {
  const prev = tab.status;
  tab.status = status;
  tab.els.tabBtn.classList.remove('status-idle', 'status-busy', 'status-waiting', 'status-finished');
  tab.els.tabBtn.classList.add('status-' + status);
  if (status === 'finished' && prev !== 'finished') {
    finalizePendingPromptEntry(tab);
    slackOnFinished(tab);
    tryDispatchNextPrompt(tab);
    maybeContinueBuild(tab);
  }
}

function bumpIdleTimer(tab) {
  if (tab.idleTimer) clearTimeout(tab.idleTimer);
  tab.idleTimer = setTimeout(() => {
    tab.idleTimer = null;
    if (!tab.hasOutput) return;
    // Don't claim "finished" while Claude is paused on a confirmation/menu —
    // the run isn't actually done, the user just needs to answer first.
    if (isAwaitingTuiSelection(tab)) {
      if (tab.status !== 'waiting') setTabStatus(tab, 'waiting');
      return;
    }
    setTabStatus(tab, 'finished');
  }, IDLE_MS);
}

// xterm parses input synchronously into its buffer, but the buffer mutation
// can lag a tick. Defer the menu probe so isAwaitingTuiSelection sees the
// final state instead of mid-frame text.
function scheduleWaitingCheck(tab) {
  if (tab.waitingCheckTimer) clearTimeout(tab.waitingCheckTimer);
  tab.waitingCheckTimer = setTimeout(() => {
    tab.waitingCheckTimer = null;
    if (tab.status === 'finished') return;
    const waiting = isAwaitingTuiSelection(tab);
    const target = waiting ? 'waiting' : 'busy';
    if (tab.status !== target) setTabStatus(tab, target);
  }, 80);
}

function onCmdData(tab, data) {
  tab.hasOutput = true;
  if (tab.status !== 'busy' && tab.status !== 'waiting') setTabStatus(tab, 'busy');
  // Whenever the Slack proxy is active (connected + anchor thread), accumulate
  // Claude's terminal output so we can post it into the anchor thread once the
  // run goes idle — regardless of whether the output was triggered by a Slack
  // reply or by the user typing directly. Batching is done by slackOnFinished
  // so we don't spam per keystroke. No-op when not connected (threadTs null).
  if (tab.slack && slackProxyEnabled(tab.slack)) {
    tab.slack.captureBuffer += String(data);
    if (tab.slack.captureBuffer.length > 200000) {
      tab.slack.captureBuffer = tab.slack.captureBuffer.slice(-200000);
    }
  }
  bumpIdleTimer(tab);
  scheduleWaitingCheck(tab);
}

function onCmdUserInput(tab) {
  setTabStatus(tab, 'busy');
  // wait for next output to restart the idle countdown
  if (tab.idleTimer) { clearTimeout(tab.idleTimer); tab.idleTimer = null; }
}

// ───────────────────────────────────────────────────────── sub-tabs

function switchSubTab(tab, name) {
  tab.activeSubTab = name;
  for (const btn of tab.els.subTabBtns) {
    btn.classList.toggle('active', btn.dataset.tab === name);
  }
  for (const view of tab.els.subTabViews) {
    view.classList.toggle('active', view.dataset.view === name);
  }
  if (name !== 'tasks') stopTasksPolling(tab);
  if (name === 'bash') {
    requestAnimationFrame(() => { try { tab.bash.fit && tab.bash.fit.fit(); } catch (_) {} });
  } else if (name === 'files') {
    if (tab.folder && !tab.filesLoaded) {
      tab.filesLoaded = true;
      renderFiles(tab);
    }
  } else if (name === 'slack') {
    initSlackTab(tab);
  } else if (name === 'git') {
    checkGitAuthAndGate(tab);
  } else if (name === 'diff') {
    refreshDiff(tab);
  } else if (name === 'tests') {
    refreshTests(tab);
  } else if (name === 'tasks') {
    initTasksTab(tab);
  }
}

// ───────────────────────────────────────────────────────── file tree

function shouldShowEntry(tab, fullPath, entry) {
  const lower = fullPath.toLowerCase();
  if (tab.filterChanges) {
    if (entry.isDir) {
      if (!tab.changedDirSet.has(lower)) return false;
    } else {
      if (!tab.changedFileSet.has(lower)) return false;
    }
  }
  if (tab.filterReadme) {
    if (entry.isDir) {
      if (!tab.mdDirSet.has(lower)) return false;
    } else {
      if (!entry.name.toLowerCase().endsWith('.md')) return false;
    }
  }
  return true;
}

function makeTreeNode(tab, fullPath, displayName, isDir, isRoot) {
  const node = document.createElement('div');
  node.className = 'tree-node' + (isDir ? ' is-dir' : ' is-file');
  node.dataset.path = fullPath;
  const row = document.createElement('div');
  row.className = 'tree-row';
  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.textContent = isDir ? '▶' : '·';
  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = displayName;
  row.appendChild(icon);
  row.appendChild(label);
  node.appendChild(row);

  if (!isDir) {
    row.addEventListener('click', () => loadFile(tab, fullPath, row));
    return node;
  }

  const children = document.createElement('div');
  children.className = 'tree-children';
  children.style.display = 'none';
  node.appendChild(children);

  let expanded = false;
  let loadPromise = null;

  // Shared in-flight load promise so concurrent expand() calls (e.g. the
  // auto-expand triggered at construction plus a programmatic reveal) all wait
  // on the same readDir.
  const ensureLoaded = () => {
    if (!loadPromise) {
      loadPromise = (async () => {
        const res = await window.api.fs.readDir(fullPath);
        if (res.ok) {
          for (const entry of res.entries) {
            const sep = fullPath.endsWith('\\') || fullPath.endsWith('/') ? '' : '\\';
            const childPath = fullPath + sep + entry.name;
            if (!shouldShowEntry(tab, childPath, entry)) continue;
            const child = makeTreeNode(tab, childPath, entry.name, entry.isDir, false);
            children.appendChild(child);
          }
          if (tab.findScope === 'tree'
              && tab.els.filesFindBar
              && !tab.els.filesFindBar.classList.contains('hidden')
              && tab.els.filesFindInput.value.trim()) {
            applyTreeFilter(tab, tab.els.filesFindInput.value);
          }
        } else {
          const err = document.createElement('div');
          err.className = 'tree-error';
          err.textContent = res.error;
          children.appendChild(err);
        }
      })();
    }
    return loadPromise;
  };

  const expand = async () => {
    await ensureLoaded();
    expanded = true;
    icon.textContent = '▼';
    children.style.display = 'block';
  };
  const collapse = () => {
    expanded = false;
    icon.textContent = '▶';
    children.style.display = 'none';
  };

  row.addEventListener('click', () => { expanded ? collapse() : expand(); });
  node._expand = expand;
  const autoExpand = isRoot
    || (tab.filterChanges && tab.changedDirSet.has(fullPath.toLowerCase()))
    || (tab.filterReadme && tab.mdDirSet.has(fullPath.toLowerCase()));
  if (autoExpand) expand();
  return node;
}

async function loadMdPaths(tab) {
  tab.mdFileSet = new Set();
  tab.mdDirSet = new Set();
  if (!tab.folder) return;
  const res = await window.api.fs.findByExt(tab.folder, '.md');
  if (!res || !res.ok) return;
  for (const f of (res.files || [])) tab.mdFileSet.add(f.toLowerCase());
  for (const d of (res.dirs || [])) tab.mdDirSet.add(d.toLowerCase());
  // Make sure the root itself is shown even if it has only nested .md files
  tab.mdDirSet.add(tab.folder.toLowerCase());
}

async function loadChangedPaths(tab) {
  tab.changedFileSet = new Set();
  tab.changedDirSet = new Set();
  if (!tab.folder) return;
  const res = await window.api.git.status(tab.folder);
  if (!res.ok || !res.entries) return;
  const rootLower = tab.folder.toLowerCase();
  tab.changedDirSet.add(rootLower);
  for (const e of res.entries) {
    const parts = e.path.replace(/\\/g, '/').split('/').filter(Boolean);
    if (!parts.length) continue;
    let cur = tab.folder;
    for (let i = 0; i < parts.length - 1; i++) {
      const sep = cur.endsWith('\\') || cur.endsWith('/') ? '' : '\\';
      cur = cur + sep + parts[i];
      tab.changedDirSet.add(cur.toLowerCase());
    }
    const fileSep = cur.endsWith('\\') || cur.endsWith('/') ? '' : '\\';
    const fileAbs = cur + fileSep + parts[parts.length - 1];
    tab.changedFileSet.add(fileAbs.toLowerCase());
  }
}

async function renderFiles(tab) {
  if (!tab.folder) return;
  tab.els.filesTree.innerHTML = '';
  resetFileEditor(tab);
  const segments = tab.folder.split(/[\\/]+/).filter(Boolean);
  const leaf = segments[segments.length - 1] || tab.folder;
  const rootNode = makeTreeNode(tab, tab.folder, leaf, true, true);
  tab.els.filesTree.appendChild(rootNode);
}

function resetFileEditor(tab) {
  tab.currentFilePath = null;
  tab.fileOriginal = '';
  tab.fileIsBinary = false;
  tab.fileDirty = false;
  setFilePreviewMode(tab, false);
  tab.els.fileEditor.value = '';
  tab.els.fileEditor.placeholder = '(click a file to view)';
  tab.els.fileEditor.classList.remove('hidden');
  tab.els.fileEditor.disabled = true;
  tab.els.fileBinaryMsg.classList.add('hidden');
  tab.els.fileBinaryMsg.textContent = '';
  updateFilePreviewButton(tab);
  tab.els.fileViewerPath.textContent = '';
  tab.els.fileDirtyChip.classList.add('hidden');
  tab.els.fileSaveBtn.disabled = true;
  tab.els.fileRenameBtn.disabled = true;
  tab.els.fileReloadBtn.disabled = true;
  closeRenameRow(tab);
}

async function loadFile(tab, fullPath, row) {
  if (tab.fileDirty) {
    if (!confirm('Discard unsaved changes?')) return;
  }
  for (const r of tab.els.filesTree.querySelectorAll('.tree-row.active')) r.classList.remove('active');
  if (row) row.classList.add('active');
  tab.currentFilePath = fullPath;
  tab._currentFileRow = row || null;
  setFilePreviewMode(tab, false);
  tab.els.fileViewerPath.textContent = fullPath;
  tab.els.fileEditor.value = '';
  tab.els.fileEditor.placeholder = 'loading…';
  tab.els.fileEditor.disabled = true;
  tab.els.fileBinaryMsg.classList.add('hidden');
  tab.els.fileSaveBtn.disabled = true;
  tab.els.fileRenameBtn.disabled = true;
  tab.els.fileReloadBtn.disabled = true;
  closeRenameRow(tab);

  const res = await window.api.fs.readFile(fullPath);
  if (!res.ok) {
    tab.els.fileEditor.placeholder = res.error || 'error';
    tab.els.fileEditor.disabled = true;
    updateFilePreviewButton(tab);
    return;
  }
  if (res.binary || res.truncated) {
    tab.fileIsBinary = true;
    tab.fileOriginal = '';
    tab.els.fileEditor.classList.add('hidden');
    tab.els.fileBinaryMsg.classList.remove('hidden');
    tab.els.fileBinaryMsg.textContent = res.content;
    tab.els.fileRenameBtn.disabled = false;
    tab.els.fileReloadBtn.disabled = false;
    setFileDirty(tab, false);
    updateFilePreviewButton(tab);
    return;
  }
  tab.fileIsBinary = false;
  tab.fileOriginal = res.content;
  tab.els.fileEditor.classList.remove('hidden');
  tab.els.fileBinaryMsg.classList.add('hidden');
  tab.els.fileEditor.value = res.content;
  tab.els.fileEditor.disabled = false;
  tab.els.fileEditor.placeholder = '';
  tab.els.fileRenameBtn.disabled = false;
  tab.els.fileReloadBtn.disabled = false;
  setFileDirty(tab, false);
  updateFilePreviewButton(tab);
  const findOpen = tab.els.filesFindBar && !tab.els.filesFindBar.classList.contains('hidden');
  if (findOpen && tab.findScope === 'editor' && tab.els.filesFindInput.value) {
    applyEditorFind(tab, tab.els.filesFindInput.value);
  } else {
    renderFileFindOverlay(tab);
  }
}

// ─────────────────────────────────────────────── Markdown preview (TASK-015)

// True when the path ends in `.md` (case-insensitive) — the only files that
// get the "Show preview" toggle.
function isMarkdownPath(p) {
  return typeof p === 'string' && /\.md$/i.test(p);
}

// Reflect whether the preview toggle should be offered: only for an open,
// non-binary `.md` file. When it should not be shown, force the viewer back to
// source mode so a newly opened non-`.md` file never shows a stale preview.
function updateFilePreviewButton(tab) {
  const btn = tab.els.filePreviewBtn;
  if (!btn) return;
  const eligible = !!tab.currentFilePath && !tab.fileIsBinary && isMarkdownPath(tab.currentFilePath);
  if (!eligible) {
    setFilePreviewMode(tab, false);
    btn.classList.add('hidden');
    btn.disabled = true;
    return;
  }
  btn.classList.remove('hidden');
  btn.disabled = false;
}

// Switch the file viewer between raw source (editable textarea) and a rendered,
// read-only markdown preview. The preview HTML comes from renderMarkdown(),
// which HTML-escapes the source first, so no active script from the markdown
// source can execute.
function setFilePreviewMode(tab, on) {
  const btn = tab.els.filePreviewBtn;
  const preview = tab.els.filePreview;
  if (!preview) return;
  tab.previewMode = !!on;
  if (on) {
    preview.innerHTML = renderMarkdown(tab.els.fileEditor.value);
    preview.classList.remove('hidden');
    tab.els.fileEditor.classList.add('hidden');
    if (tab.els.fileFindOverlay) tab.els.fileFindOverlay.classList.add('hidden');
    if (btn) {
      btn.textContent = 'Show source';
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
    }
  } else {
    preview.classList.add('hidden');
    preview.innerHTML = '';
    if (!tab.fileIsBinary) tab.els.fileEditor.classList.remove('hidden');
    if (tab.els.fileFindOverlay) tab.els.fileFindOverlay.classList.remove('hidden');
    if (btn) {
      btn.textContent = 'Show preview';
      btn.classList.remove('active');
      btn.setAttribute('aria-pressed', 'false');
    }
  }
}

function toggleFilePreview(tab) {
  if (!isMarkdownPath(tab.currentFilePath) || tab.fileIsBinary) return;
  setFilePreviewMode(tab, !tab.previewMode);
}

function setFileDirty(tab, dirty) {
  tab.fileDirty = !!dirty;
  tab.els.fileDirtyChip.classList.toggle('hidden', !tab.fileDirty);
  tab.els.fileSaveBtn.disabled = !tab.fileDirty;
}

function onFileEditorInput(tab) {
  if (!tab.currentFilePath || tab.fileIsBinary) return;
  const cur = tab.els.fileEditor.value;
  setFileDirty(tab, cur !== tab.fileOriginal);
  renderFileFindOverlay(tab);
}

async function saveCurrentFile(tab) {
  if (!tab.currentFilePath || tab.fileIsBinary) return;
  const content = tab.els.fileEditor.value;
  tab.els.fileSaveBtn.disabled = true;
  const res = await window.api.fs.writeFile(tab.currentFilePath, content);
  if (!res.ok) {
    alert('Save failed: ' + (res.error || 'unknown error'));
    tab.els.fileSaveBtn.disabled = !tab.fileDirty;
    return;
  }
  tab.fileOriginal = content;
  setFileDirty(tab, false);
}

async function reloadCurrentFile(tab) {
  if (!tab.currentFilePath) return;
  if (tab.fileDirty && !confirm('Discard unsaved changes and reload?')) return;
  await loadFile(tab, tab.currentFilePath, tab._currentFileRow);
}

// ───────────────────────────────────────────────────────── Files tab find (Ctrl+F)

function openFilesFind(tab, scope) {
  tab.els.filesFindBar.classList.remove('hidden');
  setFilesFindScope(tab, scope || tab.findScope || 'editor');
  tab.els.filesFindInput.focus();
  tab.els.filesFindInput.select();
}

// Next/Prev dispatch: in editor scope, navigate file matches; when forward
// motion runs off the end (or there are no matches at all), expand the
// search to all files in the folder.
function findNext(tab) {
  if (tab.findScope === 'editor') {
    const matches = tab.findEditorMatches.length;
    const atEnd = matches === 0 || tab.findEditorIndex >= matches - 1;
    if (atEnd) {
      const q = tab.els.filesFindInput.value.trim();
      if (!q) return;
      setFilesFindScope(tab, 'content');
      return;
    }
    gotoEditorMatch(tab, 1);
  }
}

function findPrev(tab) {
  if (tab.findScope === 'editor') gotoEditorMatch(tab, -1);
}

function closeFilesFind(tab) {
  const wasContent = tab.findScope === 'content';
  tab.els.filesFindBar.classList.add('hidden');
  tab.els.filesFindInput.value = '';
  clearTreeFilter(tab);
  clearEditorFind(tab);
  if (wasContent) exitContentSearch(tab);
  tab.els.filesFindCount.textContent = '';
  renderFileFindOverlay(tab);
}

function setFilesFindScope(tab, scope) {
  const valid = (scope === 'editor' || scope === 'content') ? scope : 'tree';
  const prev = tab.findScope;
  tab.findScope = valid;
  for (const btn of tab.els.filesFindScopeBtns) {
    btn.classList.toggle('active', btn.dataset.scope === tab.findScope);
  }
  const isEditor = tab.findScope === 'editor';
  tab.els.filesFindPrev.style.display = isEditor ? '' : 'none';
  tab.els.filesFindNext.style.display = isEditor ? '' : 'none';
  // When leaving Content for File search, preserve the file the user opened
  // from a hit — exitContentSearch tears the editor down, so we re-reveal it
  // after the tree is restored.
  const keepFile = (prev === 'content' && valid === 'editor') ? tab.currentFilePath : null;
  // Clear effects from previous scope.
  if (prev === 'tree' && valid !== 'tree') clearTreeFilter(tab);
  if (prev === 'editor' && valid !== 'editor') clearEditorFind(tab);
  if (prev === 'content' && valid !== 'content') exitContentSearch(tab);
  if (keepFile) revealAndReloadFile(tab, keepFile);
  onFilesFindInput(tab);
}

function onFilesFindInput(tab) {
  const q = tab.els.filesFindInput.value;
  if (tab.findScope === 'editor') applyEditorFind(tab, q);
  else if (tab.findScope === 'content') {
    scheduleContentSearch(tab, q);
    renderFileFindOverlay(tab);
  }
  else applyTreeFilter(tab, q);
}

function scheduleContentSearch(tab, query) {
  if (tab._contentSearchTimer) clearTimeout(tab._contentSearchTimer);
  const q = (query || '').trim();
  if (!q) {
    tab.els.filesFindCount.textContent = '';
    renderContentResults(tab, [], false, '');
    return;
  }
  tab.els.filesFindCount.textContent = 'searching…';
  tab._contentSearchTimer = setTimeout(() => runContentSearch(tab, q), 300);
}

async function runContentSearch(tab, q) {
  if (!tab.folder) {
    tab.els.filesFindCount.textContent = '(no folder)';
    return;
  }
  const token = (tab._contentSearchToken || 0) + 1;
  tab._contentSearchToken = token;
  const res = await window.api.fs.grep(tab.folder, q);
  if (token !== tab._contentSearchToken) return; // superseded
  if (!res || !res.ok) {
    tab.els.filesFindCount.textContent = res && res.error ? res.error : 'search failed';
    return;
  }
  const totalHits = res.results.reduce((n, r) => n + (r.hits ? r.hits.length : 0), 0);
  const fileCount = res.results.length;
  let label;
  if (!fileCount) label = 'no matches';
  else label = `${fileCount} file${fileCount === 1 ? '' : 's'} · ${totalHits} hit${totalHits === 1 ? '' : 's'}`;
  if (res.truncated) label += ' (truncated)';
  tab.els.filesFindCount.textContent = label;
  renderContentResults(tab, res.results, res.truncated, q);
}

function renderContentResults(tab, results, truncated, query) {
  const container = tab.els.filesTree;
  container.innerHTML = '';
  const list = document.createElement('div');
  list.className = 'content-results';
  if (!results.length && query) {
    const empty = document.createElement('div');
    empty.className = 'content-results-empty';
    empty.textContent = 'No matches.';
    list.appendChild(empty);
  }
  for (const r of results) {
    const item = document.createElement('div');
    item.className = 'content-result';
    const header = document.createElement('div');
    header.className = 'content-result-header';
    if (r.nameMatches) {
      const tag = document.createElement('span');
      tag.className = 'content-result-tag';
      tag.textContent = 'name';
      header.appendChild(tag);
    }
    const name = document.createElement('span');
    name.className = 'content-result-name';
    name.textContent = r.name;
    header.appendChild(name);
    const rel = relativePath(tab.folder, r.path);
    if (rel && rel !== r.name) {
      const dir = document.createElement('span');
      dir.className = 'content-result-dir';
      dir.textContent = ' — ' + rel;
      header.appendChild(dir);
    }
    header.addEventListener('click', () => openContentResult(tab, r.path, null, query));
    item.appendChild(header);
    for (const h of (r.hits || [])) {
      const hitRow = document.createElement('div');
      hitRow.className = 'content-result-hit';
      const ln = document.createElement('span');
      ln.className = 'content-result-line';
      ln.textContent = h.line + ':';
      hitRow.appendChild(ln);
      const snip = document.createElement('span');
      snip.className = 'content-result-snippet';
      appendHighlighted(snip, h.text, query);
      hitRow.appendChild(snip);
      hitRow.addEventListener('click', () => openContentResult(tab, r.path, h.line, query));
      item.appendChild(hitRow);
    }
    list.appendChild(item);
  }
  if (truncated) {
    const note = document.createElement('div');
    note.className = 'content-results-note';
    note.textContent = `Showing first ${results.length} matches. Refine your query for more.`;
    list.appendChild(note);
  }
  container.appendChild(list);
}

function appendHighlighted(parent, text, query) {
  const q = (query || '').toLowerCase();
  if (!q) { parent.textContent = text; return; }
  const lower = text.toLowerCase();
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(q, i);
    if (idx < 0) { parent.appendChild(document.createTextNode(text.slice(i))); break; }
    if (idx > i) parent.appendChild(document.createTextNode(text.slice(i, idx)));
    const mark = document.createElement('mark');
    mark.className = 'find-hit';
    mark.textContent = text.slice(idx, idx + q.length);
    parent.appendChild(mark);
    i = idx + Math.max(1, q.length);
  }
}

function relativePath(root, full) {
  if (!root) return full;
  const r = root.replace(/[\\/]+$/, '');
  if (full.startsWith(r)) {
    return full.slice(r.length).replace(/^[\\/]+/, '');
  }
  return full;
}

async function openContentResult(tab, fullPath, line, query) {
  await loadFile(tab, fullPath, null);
  if (tab.fileIsBinary) return;
  const ed = tab.els.fileEditor;
  let targetIdx = -1;
  let targetLen = 0;
  if (query) {
    const q = query.toLowerCase();
    const text = ed.value.toLowerCase();
    if (line && line > 0) {
      // Locate start of the requested line, then find the query within that line.
      let pos = 0;
      let cur = 1;
      while (cur < line && pos !== -1) {
        const nl = text.indexOf('\n', pos);
        if (nl < 0) { pos = -1; break; }
        pos = nl + 1;
        cur++;
      }
      if (pos >= 0) {
        const lineEnd = text.indexOf('\n', pos);
        const end = lineEnd < 0 ? text.length : lineEnd;
        const hit = text.indexOf(q, pos);
        if (hit >= 0 && hit < end) { targetIdx = hit; targetLen = query.length; }
      }
    }
    if (targetIdx < 0) {
      const hit = text.indexOf(q);
      if (hit >= 0) { targetIdx = hit; targetLen = query.length; }
    }
  }
  if (targetIdx >= 0) {
    ed.focus();
    ed.setSelectionRange(targetIdx, targetIdx + targetLen);
    const lineHeight = parseFloat(getComputedStyle(ed).lineHeight) || 16;
    const lineNo = ed.value.substring(0, targetIdx).split('\n').length - 1;
    ed.scrollTop = Math.max(0, lineNo * lineHeight - ed.clientHeight / 2);
    tab.els.filesFindInput.focus();
  }
  renderFileFindOverlay(tab, targetIdx >= 0 ? targetIdx : undefined);
}

function exitContentSearch(tab) {
  if (tab._contentSearchTimer) { clearTimeout(tab._contentSearchTimer); tab._contentSearchTimer = null; }
  tab._contentSearchToken = (tab._contentSearchToken || 0) + 1; // invalidate in-flight
  renderFiles(tab);
  renderFileFindOverlay(tab);
}

// Paint every occurrence of the current find query behind the file editor
// so users can see, at a glance, where matches live in the open file. The
// overlay sits beneath a transparent textarea; the textarea's own selection
// still shows on top of the marks to indicate the "active" match.
function renderFileFindOverlay(tab, activeStart) {
  const inner = tab.els && tab.els.fileFindOverlayInner;
  if (!inner) return;
  const ed = tab.els.fileEditor;
  const bar = tab.els.filesFindBar;
  const findOpen = bar && !bar.classList.contains('hidden');
  const q = findOpen ? (tab.els.filesFindInput.value || '') : '';
  const text = ed.value || '';
  const editorVisible = ed && !ed.classList.contains('hidden') && !ed.disabled;
  const scope = tab.findScope;

  if (!q || !editorVisible || tab.fileIsBinary || scope === 'tree') {
    inner.replaceChildren();
    syncFileFindOverlayScroll(tab);
    return;
  }

  const qLower = q.toLowerCase();
  const tLower = text.toLowerCase();
  // If no explicit active match passed, infer from the editor scope's tracked
  // index (content scope leaves activeStart undefined unless we just opened a hit).
  let resolvedActive = activeStart;
  if (resolvedActive === undefined && scope === 'editor') {
    const m = tab.findEditorMatches[tab.findEditorIndex];
    if (m) resolvedActive = m.start;
  }

  const frag = document.createDocumentFragment();
  let i = 0;
  while (i <= tLower.length) {
    const idx = tLower.indexOf(qLower, i);
    if (idx < 0) {
      if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)));
      break;
    }
    if (idx > i) frag.appendChild(document.createTextNode(text.slice(i, idx)));
    const mark = document.createElement('mark');
    if (resolvedActive !== undefined && idx === resolvedActive) mark.className = 'active';
    mark.textContent = text.slice(idx, idx + q.length);
    frag.appendChild(mark);
    i = idx + Math.max(1, q.length);
  }
  inner.replaceChildren(frag);
  syncFileFindOverlayScroll(tab);
}

function syncFileFindOverlayScroll(tab) {
  const inner = tab.els && tab.els.fileFindOverlayInner;
  const ed = tab.els && tab.els.fileEditor;
  if (!inner || !ed) return;
  inner.style.transform = `translate(${-ed.scrollLeft}px, ${-ed.scrollTop}px)`;
}

// Walk the freshly-rendered tree, expanding each ancestor directory until the
// target file's row exists, then load the file and mark its row active. Used
// to preserve the user's file when leaving content search.
async function revealAndReloadFile(tab, fullPath) {
  if (!fullPath || !tab.folder) return;
  const tree = tab.els.filesTree;
  const rootNode = tree.querySelector(':scope > .tree-node');
  if (!rootNode || !rootNode.dataset.path) return;
  const rootPath = rootNode.dataset.path;
  const lowerRoot = rootPath.replace(/[\\/]+$/, '').toLowerCase();
  if (!fullPath.toLowerCase().startsWith(lowerRoot)) return;
  const rest = fullPath.slice(lowerRoot.length).replace(/^[\\/]+/, '');
  if (!rest) return;
  const parts = rest.split(/[\\/]+/).filter(Boolean);

  if (rootNode._expand) await rootNode._expand();

  let parentNode = rootNode;
  let currentPath = rootPath;
  for (let i = 0; i < parts.length; i++) {
    const sep = currentPath.endsWith('\\') || currentPath.endsWith('/') ? '' : '\\';
    currentPath = currentPath + sep + parts[i];
    const childrenContainer = parentNode.querySelector(':scope > .tree-children');
    if (!childrenContainer) return;
    let childNode = null;
    for (const c of childrenContainer.children) {
      if (c.classList && c.classList.contains('tree-node') && c.dataset.path === currentPath) {
        childNode = c;
        break;
      }
    }
    if (!childNode) return;
    if (i < parts.length - 1) {
      if (childNode._expand) await childNode._expand();
      parentNode = childNode;
    } else {
      const row = childNode.querySelector(':scope > .tree-row');
      if (row) {
        await loadFile(tab, fullPath, row);
        row.scrollIntoView({ block: 'nearest' });
      }
    }
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clearTreeFilter(tab) {
  for (const node of tab.els.filesTree.querySelectorAll('.tree-node.find-hidden')) {
    node.classList.remove('find-hidden');
  }
  for (const label of tab.els.filesTree.querySelectorAll('.tree-label')) {
    if (label.querySelector('mark.find-hit')) {
      label.textContent = label.textContent;
    }
  }
}

function applyTreeFilter(tab, query) {
  clearTreeFilter(tab);
  const q = (query || '').trim();
  if (!q) { tab.els.filesFindCount.textContent = ''; return; }
  const qLower = q.toLowerCase();
  const nodes = tab.els.filesTree.querySelectorAll('.tree-node');
  const matchSet = new Set();
  let hitCount = 0;
  for (const node of nodes) {
    const label = node.querySelector(':scope > .tree-row > .tree-label');
    if (!label) continue;
    const text = label.textContent;
    if (text.toLowerCase().includes(qLower)) {
      matchSet.add(node);
      hitCount++;
      // highlight match inside label
      const re = new RegExp(escapeRegex(q), 'ig');
      label.innerHTML = '';
      let last = 0;
      text.replace(re, (m, idx) => {
        if (idx > last) label.appendChild(document.createTextNode(text.slice(last, idx)));
        const mark = document.createElement('mark');
        mark.className = 'find-hit';
        mark.textContent = m;
        label.appendChild(mark);
        last = idx + m.length;
        return m;
      });
      if (last < text.length) label.appendChild(document.createTextNode(text.slice(last)));
    }
  }
  // Promote: a directory is visible if it itself matches OR any descendant does.
  const visible = new Set(matchSet);
  for (const m of matchSet) {
    let p = m.parentElement;
    while (p && p !== tab.els.filesTree) {
      if (p.classList && p.classList.contains('tree-node')) visible.add(p);
      p = p.parentElement;
    }
  }
  for (const node of nodes) {
    if (!visible.has(node)) node.classList.add('find-hidden');
  }
  tab.els.filesFindCount.textContent = hitCount ? `${hitCount} match${hitCount === 1 ? '' : 'es'}` : 'no matches';
}

function clearEditorFind(tab) {
  tab.findEditorMatches = [];
  tab.findEditorIndex = -1;
  renderFileFindOverlay(tab);
}

function applyEditorFind(tab, query) {
  clearEditorFind(tab);
  const q = query || '';
  if (!q) { tab.els.filesFindCount.textContent = ''; return; }
  if (tab.els.fileEditor.classList.contains('hidden') || tab.els.fileEditor.disabled) {
    tab.els.filesFindCount.textContent = 'no file open — press → to search folder';
    return;
  }
  const text = tab.els.fileEditor.value;
  const qLower = q.toLowerCase();
  const tLower = text.toLowerCase();
  let i = 0;
  while (i <= tLower.length - qLower.length) {
    const idx = tLower.indexOf(qLower, i);
    if (idx < 0) break;
    tab.findEditorMatches.push({ start: idx, end: idx + q.length });
    i = idx + Math.max(1, q.length);
  }
  if (!tab.findEditorMatches.length) {
    tab.els.filesFindCount.textContent = 'no matches in file — press → to search folder';
    return;
  }
  tab.findEditorIndex = 0;
  highlightEditorMatch(tab);
}

function gotoEditorMatch(tab, dir) {
  if (!tab.findEditorMatches.length) return;
  const n = tab.findEditorMatches.length;
  tab.findEditorIndex = (tab.findEditorIndex + dir + n) % n;
  highlightEditorMatch(tab);
}

function highlightEditorMatch(tab) {
  const m = tab.findEditorMatches[tab.findEditorIndex];
  if (!m) return;
  const ed = tab.els.fileEditor;
  ed.focus();
  ed.setSelectionRange(m.start, m.end);
  renderFileFindOverlay(tab, m.start);
  // Scroll the selection into view (textarea has no native API).
  const lineHeight = parseFloat(getComputedStyle(ed).lineHeight) || 16;
  const lineNo = ed.value.substring(0, m.start).split('\n').length - 1;
  const target = lineNo * lineHeight - ed.clientHeight / 2;
  ed.scrollTop = Math.max(0, target);
  // Put focus back in the find input so Enter / Esc still work.
  tab.els.filesFindInput.focus();
  const n = tab.findEditorMatches.length;
  const atLast = tab.findEditorIndex >= n - 1;
  const base = `${tab.findEditorIndex + 1} / ${n} in file`;
  tab.els.filesFindCount.textContent = atLast ? `${base} — press → to search folder` : base;
}

function pathParts(fullPath) {
  const norm = fullPath.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  if (idx < 0) return { dir: '', name: norm, sep: '\\' };
  const sep = fullPath.includes('\\') ? '\\' : '/';
  return { dir: fullPath.slice(0, idx), name: fullPath.slice(idx + 1), sep };
}

function openRenameRow(tab) {
  if (!tab.currentFilePath) return;
  const { name } = pathParts(tab.currentFilePath);
  tab.els.fileRenameInput.value = name;
  tab.els.fileRenameError.textContent = '';
  tab.els.fileRenameRow.classList.remove('hidden');
  tab.els.fileRenameInput.focus();
  tab.els.fileRenameInput.select();
}

function closeRenameRow(tab) {
  tab.els.fileRenameRow.classList.add('hidden');
  tab.els.fileRenameInput.value = '';
  tab.els.fileRenameError.textContent = '';
}

async function confirmRename(tab) {
  if (!tab.currentFilePath) return;
  const newName = tab.els.fileRenameInput.value.trim();
  if (!newName) {
    tab.els.fileRenameError.textContent = 'name required';
    return;
  }
  if (/[\\/:*?"<>|]/.test(newName)) {
    tab.els.fileRenameError.textContent = 'invalid name';
    return;
  }
  const { dir, sep, name: oldName } = pathParts(tab.currentFilePath);
  if (newName === oldName) {
    closeRenameRow(tab);
    return;
  }
  const newPath = dir ? (dir + sep + newName) : newName;
  const res = await window.api.fs.rename(tab.currentFilePath, newPath);
  if (!res.ok) {
    tab.els.fileRenameError.textContent = res.error || 'rename failed';
    return;
  }
  tab.currentFilePath = newPath;
  tab.els.fileViewerPath.textContent = newPath;
  if (tab._currentFileRow) {
    const label = tab._currentFileRow.querySelector('.tree-label');
    if (label) label.textContent = newName;
  }
  closeRenameRow(tab);
}

// ───────────────────────────────────────────────────────── git / diff

function applyGitAuthState(tab, { authed, label, klass }) {
  tab.gitAuthed = !!authed;
  if (tab.els.gitAuthStatus) {
    tab.els.gitAuthStatus.textContent = label || '';
    tab.els.gitAuthStatus.className = 'gitAuthStatus git-auth-status' + (klass ? ' ' + klass : '');
  }
  if (authed) {
    tab.els.gitAuthGate.classList.add('hidden');
    tab.els.gitAuthedContent.classList.remove('hidden');
  } else {
    tab.els.gitAuthGate.classList.remove('hidden');
    tab.els.gitAuthedContent.classList.add('hidden');
    // Close any open action panels so they don't reappear after logout.
    tab.els.commitPanel.classList.add('hidden');
    tab.els.publishPanel.classList.add('hidden');
    if (tab.els.prPanel) tab.els.prPanel.classList.add('hidden');
    if (tab.els.actionPanel) tab.els.actionPanel.classList.add('hidden');
  }
}

function showGitNotInstalled(tab) {
  tab.gitAuthed = false;
  if (tab.els.gitNotInstalledGate) tab.els.gitNotInstalledGate.classList.remove('hidden');
  tab.els.gitAuthGate.classList.add('hidden');
  tab.els.gitAuthedContent.classList.add('hidden');
  if (tab.els.gitInstallStatus) {
    tab.els.gitInstallStatus.textContent = 'git not found on PATH';
    tab.els.gitInstallStatus.className = 'gitInstallStatus git-auth-status bad';
  }
}

function startGitInstall(tab) {
  // The cmd terminal is occupied by the interactive `claude` CLI, so install
  // in the Git Bash terminal (a real shell) and switch to it — same as gh login.
  if (runInBashPty(tab, 'winget install --id Git.Git -e --source winget')) {
    switchSubTab(tab, 'bash');
  }
}

async function checkGitAuthAndGate(tab, force) {
  if (!tab.els.gitAuthGate) return;
  // First gate: git itself must be installed — without it nothing in this tab works.
  if (tab.els.gitNotInstalledGate) {
    let gitRes;
    try {
      gitRes = await window.api.git.checkGit();
    } catch (_) {
      gitRes = null;
    }
    if (!gitRes || !gitRes.installed) {
      showGitNotInstalled(tab);
      return;
    }
    tab.els.gitNotInstalledGate.classList.add('hidden');
  }
  applyGitAuthState(tab, { authed: false, label: 'checking…', klass: '' });
  let res;
  try {
    res = await window.api.github.checkGh();
  } catch (err) {
    applyGitAuthState(tab, { authed: false, label: 'gh check failed', klass: 'bad' });
    return;
  }
  if (!res || !res.installed) {
    applyGitAuthState(tab, { authed: false, label: 'gh CLI not installed', klass: 'bad' });
    return;
  }
  if (!res.authed) {
    applyGitAuthState(tab, { authed: false, label: 'not signed in to gh', klass: 'bad' });
    return;
  }
  applyGitAuthState(tab, {
    authed: true,
    label: res.user ? `signed in as ${res.user}` : 'signed in',
    klass: 'good'
  });
  if (tab.folder) refreshGitStatus(tab);
}

function runInBashPty(tab, command) {
  if (!tab.bash || !tab.bash.id) {
    alert('Git Bash terminal is not running yet — open a folder first.');
    return false;
  }
  try {
    window.api.pty.write(tab.bash.id, command + '\n');
    return true;
  } catch (err) {
    console.error('[runInBashPty]', err);
    return false;
  }
}

function startGhLogin(tab) {
  if (runInBashPty(tab, 'gh auth login')) {
    switchSubTab(tab, 'bash');
  }
}

function startGhLogout(tab) {
  if (!tab.folder) return;
  if (!window.confirm('Sign out of gh on this machine? You will need to log in again before using the Git tab.')) return;
  if (runInBashPty(tab, 'gh auth logout')) {
    switchSubTab(tab, 'bash');
    applyGitAuthState(tab, { authed: false, label: 'logging out…', klass: 'bad' });
  }
}

function applyPublishAvailability(tab, info) {
  const btn = tab.els.publishBtn;
  if (!btn) return;
  if (info && info.originUrl) {
    btn.disabled = true;
    btn.title = `Already a GitHub repo (origin: ${info.originUrl})`;
    tab.els.publishPanel.classList.add('hidden');
  } else {
    btn.disabled = false;
    btn.title = '';
  }
}

async function refreshGitStatus(tab) {
  if (!tab.folder) return;
  tab.els.gitBranch.textContent = '…';
  tab.els.gitHeader.textContent = '';
  tab.els.gitStatus.textContent = 'loading…';
  renderAheadBehind(tab.els.gitAheadBehind, { loading: true });
  applyPublishAvailability(tab, null);
  const res = await window.api.git.status(tab.folder);
  if (!res.ok) {
    tab.els.gitBranch.textContent = '(no repo)';
    tab.els.gitStatus.textContent = res.error || '';
    applyPublishAvailability(tab, { isRepo: false, originUrl: null });
    renderAheadBehind(tab.els.gitAheadBehind, { isRepo: false });
    setChangeCount(tab, 0);
    return;
  }
  tab.els.gitBranch.textContent = res.branch;
  tab.els.gitHeader.textContent = res.header || '';
  window.api.git.repoInfo(tab.folder)
    .then((info) => applyPublishAvailability(tab, info))
    .catch(() => applyPublishAvailability(tab, null));
  window.api.git.aheadBehind(tab.folder)
    .then((info) => renderAheadBehind(tab.els.gitAheadBehind, info || {}))
    .catch(() => renderAheadBehind(tab.els.gitAheadBehind, { ok: false }));
  setChangeCount(tab, res.entries.length);
  if (!res.entries.length) {
    tab.els.gitStatus.textContent = 'Working tree clean.';
    return;
  }
  const lines = res.entries.map((e) => {
    const code = `${e.x === ' ' ? '·' : e.x}${e.y === ' ' ? '·' : e.y}`;
    return `${code}  ${e.path}`;
  });
  tab.els.gitStatus.textContent = lines.join('\n');
}

function setChangeCount(tab, count) {
  const el = tab.els && tab.els.changeCount;
  if (!el) return;
  const n = Math.max(0, count | 0);
  el.textContent = String(n);
  el.classList.toggle('hidden', n === 0);
  el.title = n === 1 ? '1 pending change' : `${n} pending changes`;
}

// Quietly probe `git status` to update the badge without disturbing the
// Git/Diff tab UIs — used on folder load so the count appears before the
// user navigates to either tab.
async function updateChangeCount(tab) {
  if (!tab.folder) { setChangeCount(tab, 0); return; }
  try {
    const res = await window.api.git.status(tab.folder);
    setChangeCount(tab, res && res.ok && Array.isArray(res.entries) ? res.entries.length : 0);
  } catch {
    setChangeCount(tab, 0);
  }
}

function renderDiffText(tab, text) {
  tab.els.diffContent.innerHTML = '';
  const lines = (text || '').split('\n');
  const frag = document.createDocumentFragment();
  for (const ln of lines) {
    const div = document.createElement('div');
    div.className = 'diff-line';
    if (ln.startsWith('+++') || ln.startsWith('---')) div.classList.add('diff-meta');
    else if (ln.startsWith('+')) div.classList.add('diff-add');
    else if (ln.startsWith('-')) div.classList.add('diff-del');
    else if (ln.startsWith('@@')) div.classList.add('diff-hunk');
    else if (ln.startsWith('diff ') || ln.startsWith('index ') || ln.startsWith('### ') || ln.startsWith('new file')) div.classList.add('diff-meta');
    div.textContent = ln === '' ? ' ' : ln;
    frag.appendChild(div);
  }
  tab.els.diffContent.appendChild(frag);
}

function isConflictEntry(e) {
  if (!e) return false;
  if (e.x === 'U' || e.y === 'U') return true;
  if (e.x === e.y && (e.x === 'A' || e.x === 'D')) return true;
  return false;
}

function joinTabPath(tab, rel) {
  const base = tab.folder || '';
  if (!base) return rel;
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/';
  const trimmed = base.replace(/[\\/]+$/, '');
  return trimmed + sep + String(rel || '').replace(/[\\/]+/g, sep);
}

async function refreshDiff(tab) {
  if (!tab.folder) return;
  tab.els.diffFileList.innerHTML = '';
  tab.els.diffContent.classList.remove('conflict-resolver');
  tab.els.diffContent.textContent = 'loading…';
  const res = await window.api.git.status(tab.folder);
  if (!res.ok) {
    tab.els.diffContent.textContent = res.error || 'not a git repo';
    setChangeCount(tab, 0);
    return;
  }
  setChangeCount(tab, res.entries.length);
  if (!res.entries.length) {
    tab.els.diffContent.textContent = 'No changes.';
    return;
  }
  const conflicts = res.entries.filter(isConflictEntry);
  renderDiffSummary(tab, res.entries.length, conflicts.length);
  for (const e of res.entries) {
    const conflict = isConflictEntry(e);
    const li = document.createElement('li');
    li.className = 'diff-file' + (conflict ? ' has-conflict' : '');
    const code = `${e.x === ' ' ? '·' : e.x}${e.y === ' ' ? '·' : e.y}`;
    const statusSpan = document.createElement('span');
    statusSpan.className = 'diff-status' + (conflict ? ' diff-status-conflict' : '');
    statusSpan.textContent = code;
    const pathSpan = document.createElement('span');
    pathSpan.className = 'diff-path';
    pathSpan.textContent = e.path;
    li.appendChild(statusSpan);
    li.appendChild(pathSpan);
    if (conflict) {
      const tag = document.createElement('span');
      tag.className = 'diff-conflict-tag';
      tag.textContent = 'CONFLICT';
      li.appendChild(tag);
    }
    li.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      showDiffIgnoreMenu(tab, ev, e.path);
    });
    li.addEventListener('click', async () => {
      for (const x of tab.els.diffFileList.children) x.classList.remove('active');
      li.classList.add('active');
      if (conflict) {
        await showConflictResolver(tab, e.path);
        return;
      }
      tab.els.diffContent.classList.remove('conflict-resolver');
      tab.els.diffContent.textContent = 'loading…';
      const untracked = e.x === '?' && e.y === '?';
      const dres = await window.api.git.diff(tab.folder, e.path, untracked);
      if (dres.ok) renderDiffText(tab, dres.diff);
      else tab.els.diffContent.textContent = dres.error || 'error';
    });
    tab.els.diffFileList.appendChild(li);
  }
}

function renderDiffSummary(tab, total, conflicts) {
  tab.els.diffContent.classList.remove('conflict-resolver');
  tab.els.diffContent.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'diff-summary';
  const msg = document.createElement('div');
  msg.className = 'diff-summary-line';
  msg.textContent = conflicts > 0
    ? `${conflicts} conflict${conflicts === 1 ? '' : 's'} of ${total} change${total === 1 ? '' : 's'} — pick a file to resolve.`
    : '(select a file)';
  wrap.appendChild(msg);
  if (conflicts > 0) {
    const actions = document.createElement('div');
    actions.className = 'diff-summary-actions';
    const abort = document.createElement('button');
    abort.className = 'small-btn';
    abort.textContent = 'Abort merge / rebase';
    abort.addEventListener('click', async () => {
      if (!confirm('Abort the in-progress merge/rebase? This discards conflict state.')) return;
      const r = await window.api.git.abortMerge(tab.folder);
      if (!r.ok) { alert('Abort failed: ' + (r.error || '')); return; }
      await refreshDiff(tab);
    });
    actions.appendChild(abort);
    wrap.appendChild(actions);
  }
  tab.els.diffContent.appendChild(wrap);
}

// ─── ignore (.gitignore) context menu on changed-file rows ────────

let activeDiffIgnoreMenu = null;

function closeDiffIgnoreMenu() {
  if (activeDiffIgnoreMenu) {
    activeDiffIgnoreMenu.remove();
    activeDiffIgnoreMenu = null;
    document.removeEventListener('click', closeDiffIgnoreMenu, true);
    document.removeEventListener('contextmenu', closeDiffIgnoreMenu, true);
    window.removeEventListener('blur', closeDiffIgnoreMenu);
  }
}

function showDiffIgnoreMenu(tab, ev, relPath) {
  closeDiffIgnoreMenu();
  // A file directly at the repo root (no '/' or '\') has no containing or
  // top-level folder, so those two options don't apply.
  const norm = String(relPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const segments = norm.split('/').filter(Boolean);
  const hasFolder = segments.length >= 2;
  const parentFolder = hasFolder ? segments.slice(0, -1).join('/') + '/' : '';
  const rootFolder = hasFolder ? segments[0] + '/' : '';

  const items = [
    { label: 'Ignore file', hint: '/' + norm, mode: 'file', enabled: true },
    { label: 'Ignore folder', hint: hasFolder ? '/' + parentFolder : '(file is at repo root)', mode: 'folder', enabled: hasFolder },
    { label: 'Ignore root folder', hint: hasFolder ? '/' + rootFolder : '(file is at repo root)', mode: 'root', enabled: hasFolder }
  ];

  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'ctx-menu-item' + (it.enabled ? '' : ' disabled');
    const lbl = document.createElement('span');
    lbl.className = 'ctx-menu-label';
    lbl.textContent = it.label;
    const hint = document.createElement('span');
    hint.className = 'ctx-menu-hint';
    hint.textContent = it.hint;
    row.appendChild(lbl);
    row.appendChild(hint);
    if (it.enabled) {
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        closeDiffIgnoreMenu();
        ignoreDiffPath(tab, relPath, it.mode);
      });
    }
    menu.appendChild(row);
  }

  // Position within viewport, flipping if it would overflow the edges.
  menu.style.visibility = 'hidden';
  document.body.appendChild(menu);
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let x = ev.clientX;
  let y = ev.clientY;
  if (x + mw > window.innerWidth) x = Math.max(0, window.innerWidth - mw - 4);
  if (y + mh > window.innerHeight) y = Math.max(0, window.innerHeight - mh - 4);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.style.visibility = '';

  activeDiffIgnoreMenu = menu;
  // Defer so the right-click that opened the menu doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener('click', closeDiffIgnoreMenu, true);
    document.addEventListener('contextmenu', closeDiffIgnoreMenu, true);
    window.addEventListener('blur', closeDiffIgnoreMenu);
  }, 0);
}

async function ignoreDiffPath(tab, file, mode) {
  if (!tab.folder) return;
  try {
    const res = await window.api.git.ignore(tab.folder, file, mode);
    if (!res || !res.ok) {
      alert('Could not update .gitignore: ' + ((res && res.error) || 'unknown error'));
      return;
    }
    // Refresh both the change list and the badge — newly-ignored tracked files
    // may still show until removed from the index, but untracked ones drop off.
    await refreshDiff(tab);
    updateChangeCount(tab).catch((e) => console.error('[changeCount]', e));
  } catch (err) {
    console.error('[ignoreDiffPath]', err);
    alert('Could not update .gitignore: ' + (err && err.message ? err.message : err));
  }
}

// ─── conflict parsing / re-assembly ───────────────────────────────

function parseConflicts(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const segments = [];
  let buf = [];
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (/^<{7}( |\t|$)/.test(ln)) {
      if (buf.length) { segments.push({ type: 'plain', lines: buf }); buf = []; }
      const oursLabel = ln.replace(/^<{7}\s*/, '').trim() || 'HEAD';
      const ours = [];
      const base = [];
      const theirs = [];
      let theirsLabel = '';
      let phase = 'ours';
      i++;
      while (i < lines.length && !/^>{7}( |\t|$)/.test(lines[i])) {
        if (/^\|{7}( |\t|$)/.test(lines[i])) { phase = 'base'; i++; continue; }
        if (/^={7}\s*$/.test(lines[i])) { phase = 'theirs'; i++; continue; }
        if (phase === 'ours') ours.push(lines[i]);
        else if (phase === 'base') base.push(lines[i]);
        else theirs.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        theirsLabel = lines[i].replace(/^>{7}\s*/, '').trim() || 'incoming';
        i++;
      }
      segments.push({ type: 'conflict', ours, theirs, base, oursLabel, theirsLabel, choice: null });
    } else {
      buf.push(ln);
      i++;
    }
  }
  if (buf.length) segments.push({ type: 'plain', lines: buf });
  return segments;
}

function reassembleConflicts(segments) {
  const out = [];
  for (const seg of segments) {
    if (seg.type === 'plain') { out.push(...seg.lines); continue; }
    if (seg.choice === 'ours') out.push(...seg.ours);
    else if (seg.choice === 'theirs') out.push(...seg.theirs);
    else if (seg.choice === 'both') { out.push(...seg.ours); out.push(...seg.theirs); }
    else if (seg.choice === 'none') { /* drop */ }
    else {
      out.push(`<<<<<<< ${seg.oursLabel || 'HEAD'}`);
      out.push(...seg.ours);
      if (seg.base && seg.base.length) {
        out.push(`||||||| base`);
        out.push(...seg.base);
      }
      out.push('=======');
      out.push(...seg.theirs);
      out.push(`>>>>>>> ${seg.theirsLabel || 'incoming'}`);
    }
  }
  return out.join('\n');
}

async function showConflictResolver(tab, file) {
  const root = tab.els.diffContent;
  root.classList.add('conflict-resolver');
  root.innerHTML = '';
  const absPath = joinTabPath(tab, file);

  const toolbar = document.createElement('div');
  toolbar.className = 'conflict-toolbar';
  toolbar.innerHTML = `
    <span class="conflict-title">CONFLICT</span>
    <span class="conflict-path"></span>
    <span class="conflict-summary"></span>
    <button class="small-btn conflictOursAll" title="Pick ours for every conflict in this file">All: ours</button>
    <button class="small-btn conflictTheirsAll" title="Pick theirs for every conflict in this file">All: theirs</button>
    <button class="small-btn conflictBothAll" title="Keep both sides for every conflict in this file">All: both</button>
    <button class="small-btn conflictReload" title="Re-read the file from disk (discards resolver choices)">Reload</button>
    <button class="small-btn conflictSave" title="Write current choices to the file (keeps markers for unresolved blocks)">Save</button>
    <button class="small-btn primary-btn conflictSaveResolve" disabled title="Save and run git add to mark this file as resolved">Save &amp; mark resolved</button>
  `;
  root.appendChild(toolbar);
  toolbar.querySelector('.conflict-path').textContent = file;

  const body = document.createElement('div');
  body.className = 'conflict-body';
  root.appendChild(body);

  const status = document.createElement('div');
  status.className = 'conflict-status';
  root.appendChild(status);

  const state = { segments: [], file, absPath, readOnly: false };

  function setStatus(msg, level) {
    status.textContent = msg || '';
    status.classList.remove('ok', 'bad');
    if (level === 'ok') status.classList.add('ok');
    if (level === 'bad') status.classList.add('bad');
  }

  async function load() {
    body.textContent = 'loading…';
    setStatus('');
    const res = await window.api.fs.readFile(absPath);
    if (!res.ok) { body.textContent = res.error || 'failed to read'; return; }
    if (res.binary) {
      state.readOnly = true;
      body.innerHTML = '';
      const n = document.createElement('div');
      n.className = 'conflict-binary';
      n.textContent = 'Binary file in conflict — resolve via Git Bash, then click "Mark resolved" here.';
      body.appendChild(n);
      const mark = document.createElement('div');
      mark.className = 'conflict-binary-actions';
      const ours = document.createElement('button'); ours.className = 'small-btn'; ours.textContent = 'Take ours (checkout --ours)';
      const theirs = document.createElement('button'); theirs.className = 'small-btn'; theirs.textContent = 'Take theirs (checkout --theirs)';
      const add = document.createElement('button'); add.className = 'small-btn primary-btn'; add.textContent = 'Mark resolved (git add)';
      ours.addEventListener('click', () => takeSide('ours'));
      theirs.addEventListener('click', () => takeSide('theirs'));
      add.addEventListener('click', () => markResolvedOnly());
      mark.appendChild(ours); mark.appendChild(theirs); mark.appendChild(add);
      body.appendChild(mark);
      return;
    }
    state.readOnly = false;
    state.segments = parseConflicts(res.content);
    if (!state.segments.some((s) => s.type === 'conflict')) {
      setStatus('No conflict markers found — the file may already be resolved.', 'ok');
    }
    render();
  }

  function setChoiceAll(choice) {
    for (const s of state.segments) if (s.type === 'conflict') s.choice = choice;
    render();
  }

  function buildSide(label, lines, sideClass) {
    const col = document.createElement('div');
    col.className = 'conflict-col ' + sideClass;
    const h = document.createElement('div');
    h.className = 'conflict-col-head';
    h.textContent = label;
    col.appendChild(h);
    const pre = document.createElement('pre');
    pre.className = 'conflict-col-body';
    pre.textContent = lines.length ? lines.join('\n') : '(empty)';
    col.appendChild(pre);
    return col;
  }

  function render() {
    body.innerHTML = '';
    let conflicts = 0;
    let unresolved = 0;
    let blockIdx = 0;
    for (const seg of state.segments) {
      if (seg.type === 'plain') {
        const block = document.createElement('pre');
        block.className = 'conflict-plain';
        block.textContent = seg.lines.join('\n');
        body.appendChild(block);
        continue;
      }
      conflicts++;
      blockIdx++;
      if (!seg.choice) unresolved++;
      const block = document.createElement('div');
      block.className = 'conflict-block' + (seg.choice ? ' resolved choice-' + seg.choice : ' unresolved');
      const head = document.createElement('div');
      head.className = 'conflict-block-head';
      const statusEl = document.createElement('span');
      statusEl.className = 'conflict-block-status';
      statusEl.textContent = seg.choice
        ? `#${blockIdx} · resolved (${seg.choice})`
        : `#${blockIdx} · unresolved`;
      head.appendChild(statusEl);
      const mkBtn = (label, value, title) => {
        const b = document.createElement('button');
        b.className = 'small-btn cb-' + value + (seg.choice === value ? ' active' : '');
        b.textContent = label;
        if (title) b.title = title;
        b.addEventListener('click', () => { seg.choice = seg.choice === value ? null : value; render(); });
        return b;
      };
      head.appendChild(mkBtn('Keep ours', 'ours', 'Use the HEAD side only'));
      head.appendChild(mkBtn('Keep theirs', 'theirs', 'Use the incoming side only'));
      head.appendChild(mkBtn('Keep both', 'both', 'Concatenate ours then theirs'));
      head.appendChild(mkBtn('Drop both', 'none', 'Remove this conflict region entirely'));
      block.appendChild(head);

      const cols = document.createElement('div');
      cols.className = 'conflict-cols';
      cols.appendChild(buildSide(`Ours · ${seg.oursLabel || 'HEAD'}`, seg.ours, 'conflict-ours'));
      cols.appendChild(buildSide(`Theirs · ${seg.theirsLabel || 'incoming'}`, seg.theirs, 'conflict-theirs'));
      block.appendChild(cols);
      body.appendChild(block);
    }
    toolbar.querySelector('.conflict-summary').textContent = conflicts === 0
      ? 'no conflicts in file'
      : `${conflicts - unresolved}/${conflicts} resolved`;
    toolbar.querySelector('.conflictSaveResolve').disabled = unresolved > 0 || conflicts === 0;
  }

  async function save(markResolved) {
    setStatus('saving…');
    const content = reassembleConflicts(state.segments);
    const wres = await window.api.fs.writeFile(absPath, content);
    if (!wres.ok) { setStatus('Save failed: ' + (wres.error || ''), 'bad'); return; }
    if (markResolved) {
      const ares = await window.api.git.add(tab.folder, file);
      if (!ares.ok) { setStatus('git add failed: ' + (ares.error || ''), 'bad'); return; }
      setStatus('Saved and marked resolved.', 'ok');
      await refreshDiff(tab);
      return;
    }
    setStatus('Saved.', 'ok');
    await load();
  }

  async function takeSide(side) {
    setStatus('taking ' + side + '…');
    const r = await window.api.git.checkoutSide(tab.folder, file, side);
    if (!r.ok) { setStatus('checkout --' + side + ' failed: ' + (r.error || ''), 'bad'); return; }
    setStatus('Took ' + side + ' and staged.', 'ok');
    await refreshDiff(tab);
  }

  async function markResolvedOnly() {
    setStatus('staging…');
    const r = await window.api.git.add(tab.folder, file);
    if (!r.ok) { setStatus('git add failed: ' + (r.error || ''), 'bad'); return; }
    setStatus('Marked resolved.', 'ok');
    await refreshDiff(tab);
  }

  toolbar.querySelector('.conflictOursAll').addEventListener('click', () => setChoiceAll('ours'));
  toolbar.querySelector('.conflictTheirsAll').addEventListener('click', () => setChoiceAll('theirs'));
  toolbar.querySelector('.conflictBothAll').addEventListener('click', () => setChoiceAll('both'));
  toolbar.querySelector('.conflictReload').addEventListener('click', load);
  toolbar.querySelector('.conflictSave').addEventListener('click', () => save(false));
  toolbar.querySelector('.conflictSaveResolve').addEventListener('click', () => save(true));

  await load();
}

// ───────────────────────────────────────────────────────── tests

const UNIT_TEST_EXTS = [
  '.test.js', '.test.ts', '.test.jsx', '.test.tsx', '.test.mjs', '.test.cjs',
  '.spec.js', '.spec.ts', '.spec.jsx', '.spec.tsx', '.spec.mjs', '.spec.cjs'
];
const UI_TEST_EXTS = [
  '.cy.js', '.cy.ts', '.cy.jsx', '.cy.tsx',
  '.e2e.js', '.e2e.ts', '.e2e.jsx', '.e2e.tsx',
  '.feature'
];
const UI_PATH_HINTS = [
  '/e2e/', '/cypress/', '/playwright/', '/tests/e2e/', '/test/e2e/', '/features/',
  '\\e2e\\', '\\cypress\\', '\\playwright\\', '\\tests\\e2e\\', '\\test\\e2e\\', '\\features\\'
];

function relTestPath(tab, full) {
  if (!tab.folder) return full;
  const root = tab.folder.endsWith('\\') || tab.folder.endsWith('/')
    ? tab.folder
    : tab.folder + (full.indexOf('\\') >= 0 ? '\\' : '/');
  if (full.toLowerCase().startsWith(root.toLowerCase())) return full.slice(root.length);
  return full;
}

function categorizeTest(fullPath) {
  const lower = fullPath.toLowerCase();
  for (const ext of UI_TEST_EXTS) {
    if (lower.endsWith(ext)) return 'ui';
  }
  for (const hint of UI_PATH_HINTS) {
    if (lower.indexOf(hint) >= 0) return 'ui';
  }
  return 'unit';
}

async function refreshTests(tab) {
  if (!tab.folder) {
    tab.els.testsCount.textContent = '—';
    tab.els.unitTestsCount.textContent = '0';
    tab.els.uiTestsCount.textContent = '0';
    tab.els.unitTestsBody.textContent = '(open a folder)';
    tab.els.uiTestsBody.textContent = '(open a folder)';
    tab.els.unitTestsRunAllBtn.classList.add('hidden');
    tab.els.uiTestsRunAllBtn.classList.add('hidden');
    tab.els.unitTestsUpdateBtn.disabled = true;
    return;
  }
  tab.els.unitTestsUpdateBtn.disabled = false;
  tab.els.testsCount.textContent = 'scanning…';
  tab.els.unitTestsBody.textContent = 'loading…';
  tab.els.uiTestsBody.textContent = 'loading…';
  tab.els.unitTestsRunAllBtn.classList.add('hidden');
  tab.els.uiTestsRunAllBtn.classList.add('hidden');

  const allExts = [...UNIT_TEST_EXTS, ...UI_TEST_EXTS];
  const results = await Promise.all(allExts.map((ext) =>
    window.api.fs.findByExt(tab.folder, ext).catch((err) => ({ ok: false, error: err && err.message }))
  ));

  const seen = new Set();
  const unit = [];
  const ui = [];
  for (const r of results) {
    if (!r || !r.ok || !Array.isArray(r.files)) continue;
    for (const f of r.files) {
      const key = f.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (categorizeTest(f) === 'ui') ui.push(f);
      else unit.push(f);
    }
  }
  unit.sort((a, b) => a.localeCompare(b));
  ui.sort((a, b) => a.localeCompare(b));

  tab.els.testsCount.textContent = `${unit.length + ui.length} test file${unit.length + ui.length === 1 ? '' : 's'}`;
  tab.els.unitTestsCount.textContent = String(unit.length);
  tab.els.uiTestsCount.textContent = String(ui.length);

  renderTestList(tab, 'unit', unit);
  renderTestList(tab, 'ui', ui);
}

function renderTestList(tab, kind, files) {
  const body = kind === 'unit' ? tab.els.unitTestsBody : tab.els.uiTestsBody;
  const runAllBtn = kind === 'unit' ? tab.els.unitTestsRunAllBtn : tab.els.uiTestsRunAllBtn;
  body.innerHTML = '';

  if (!files.length) {
    runAllBtn.classList.add('hidden');
    const wrap = document.createElement('div');
    wrap.className = 'tests-empty';
    const msg = document.createElement('span');
    msg.textContent = kind === 'unit'
      ? 'No unit tests found in this project.'
      : 'No UI / end-to-end tests found in this project.';
    const btn = document.createElement('button');
    btn.className = 'small-btn primary-btn';
    btn.textContent = kind === 'unit' ? 'Create unit test' : 'Create UI test';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      injectCreatePrompt(tab, kind);
    });
    wrap.appendChild(msg);
    wrap.appendChild(btn);
    body.appendChild(wrap);
    return;
  }

  runAllBtn.classList.remove('hidden');
  const ul = document.createElement('ul');
  ul.className = 'tests-list';
  for (const full of files) {
    const li = document.createElement('li');
    li.className = 'tests-row';
    const pathSpan = document.createElement('span');
    pathSpan.className = 'tests-path';
    pathSpan.textContent = relTestPath(tab, full);
    pathSpan.title = full;
    const runBtn = document.createElement('button');
    runBtn.className = 'small-btn';
    runBtn.textContent = 'Run';
    runBtn.addEventListener('click', (e) => {
      e.preventDefault();
      injectRunPrompt(tab, kind, relTestPath(tab, full));
    });
    li.appendChild(pathSpan);
    li.appendChild(runBtn);
    ul.appendChild(li);
  }
  body.appendChild(ul);
}

function injectRunPrompt(tab, kind, relPath) {
  const headed = kind === 'ui' && tab.els.uiTestsHeaded && tab.els.uiTestsHeaded.checked;
  openQueueEditor(tab, buildRunPrompt(kind, relPath, { headed }));
}
function injectCreatePrompt(tab, kind) {
  openQueueEditor(tab, buildCreatePrompt(kind));
}
function injectUpdateUnitTestsPrompt(tab) {
  openQueueEditor(tab, buildUpdateUnitTestsPrompt());
}

// Send a plain shell command to the Git Bash pane (the cmd pane hosts the AI
// CLI, so writing there would treat the command as a prompt). Falls back to a
// friendly alert when we can't infer a runner from package.json.
async function runAllTestsCommand(tab, kind) {
  if (!tab.folder) return;
  let command = await resolveRunAllCommand(tab, kind);
  if (command && kind === 'ui' && tab.els.uiTestsHeaded && tab.els.uiTestsHeaded.checked) {
    // npm scripts need `--` to forward flags to the underlying runner.
    command = /\s--\s/.test(command) ? `${command} --headed` : `${command} -- --headed`;
  }
  if (!command) {
    const label = kind === 'ui' ? 'UI / end-to-end' : 'unit';
    alert(
      `Could not find a ${label} test script in package.json.\n\n`
      + `Add a "${kind === 'ui' ? 'test:e2e' : 'test'}" script (or install a runner like `
      + `${kind === 'ui' ? 'Playwright/Cypress' : 'Vitest/Jest'}) and try again, or use `
      + `"Update unit tests" to have Claude scaffold it.`
    );
    return;
  }
  const watch = kind === 'ui' && tab.els.uiTestsWatch && tab.els.uiTestsWatch.checked;
  if (watch) {
    tab.uiTestWatch.active = true;
    tab.els.uiTestsOutput.textContent = `$ ${command}\n`;
    tab.els.uiTestsOutput.classList.remove('hidden');
    runInBashPty(tab, command);
    return;
  }
  if (runInBashPty(tab, command)) {
    switchSubTab(tab, 'bash');
  }
}

// Strip ANSI escape codes (CSI / OSC / single-char escapes) so streamed runner
// output stays readable in the plain <pre> watch panel.
const ANSI_RE = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
function appendToUiTestWatch(tab, data) {
  const out = tab.els.uiTestsOutput;
  if (!out) return;
  const clean = String(data).replace(ANSI_RE, '').replace(/\r(?!\n)/g, '');
  out.textContent += clean;
  out.scrollTop = out.scrollHeight;
}

// Inspect package.json for a known test command; for UI tests prefer scripts
// whose name implies e2e/ui/playwright/cypress. Returns null if nothing fits.
async function resolveRunAllCommand(tab, kind) {
  if (!tab || !tab.folder) return null;
  const sep = tab.folder.endsWith('\\') || tab.folder.endsWith('/') ? '' : '\\';
  const pkgPath = tab.folder + sep + 'package.json';
  let pkg = null;
  try {
    const res = await window.api.fs.readFile(pkgPath);
    if (res && res.ok && typeof res.content === 'string') {
      pkg = JSON.parse(res.content);
    }
  } catch (_) { /* fall through */ }

  const scripts = (pkg && pkg.scripts && typeof pkg.scripts === 'object') ? pkg.scripts : {};
  const names = Object.keys(scripts);

  if (kind === 'ui') {
    const uiPatterns = [/^test:e2e$/i, /^e2e$/i, /^test:ui$/i, /^test:playwright$/i, /^test:cypress$/i, /^test:bdd$/i, /^test:cucumber$/i, /e2e/i, /playwright/i, /cypress/i, /cucumber/i, /\bbdd\b/i];
    for (const pat of uiPatterns) {
      const hit = names.find((n) => pat.test(n));
      if (hit) return `npm run ${hit}`;
    }
    return null;
  }

  if (Object.prototype.hasOwnProperty.call(scripts, 'test')) return 'npm test';
  const unitPatterns = [/^test:unit$/i, /^unit$/i, /^test:vitest$/i, /^test:jest$/i, /vitest/i, /jest/i];
  for (const pat of unitPatterns) {
    const hit = names.find((n) => pat.test(n));
    if (hit) return `npm run ${hit}`;
  }
  return null;
}

function buildRunPrompt(kind, relPath, opts) {
  const label = kind === 'ui' ? 'UI / end-to-end' : 'unit';
  const headed = !!(opts && opts.headed);
  const headedNote = headed
    ? ` Run the browser in headed mode so I can see it (Playwright: append \`--headed\`; Cypress: use \`cypress open --e2e\` or \`cypress run --headed --no-exit\`).`
    : '';
  return [
    `Run the ${label} test at \`${relPath}\`.${headedNote}`,
    ``,
    `1. Detect the test framework from package.json (or pyproject.toml / go.mod / Cargo.toml) and invoke the matching runner directly — for example:`,
    `   - \`npx vitest run ${relPath}\``,
    `   - \`npx jest ${relPath}\``,
    `   - \`npx playwright test ${relPath}${headed ? ' --headed' : ''}\``,
    `   - \`npx cypress run --spec ${relPath}${headed ? ' --headed --no-exit' : ''}\``,
    `   - \`pytest ${relPath}\``,
    `   - \`go test ./...\` scoped to the matching package`,
    `2. Show me the full runner output (pass/fail summary plus any failure details).`,
    `3. If the test fails, diagnose the root cause before changing code — decide whether it's a test bug or a real regression in the code under test. Fix the underlying issue, then re-run until green.`,
    `4. Do not weaken assertions, skip cases, or add \`.only\`/\`.skip\` to make the suite pass.`
  ].join('\n');
}

function buildCreatePrompt(kind) {
  if (kind === 'ui') {
    return [
      `No UI / end-to-end tests were found in this project. Create a complete UI test suite driven by Cucumber \`.feature\` files (Gherkin BDD). The runner must execute the tests directly from the \`.feature\` files — not from hand-written spec files.`,
      ``,
      `Step 1 — detect & install:`,
      `- Read package.json. If a BDD stack is already installed (\`@cucumber/cucumber\`, \`playwright-bdd\`, \`cypress-cucumber-preprocessor\`), use it.`,
      `- If nothing is installed: pick **playwright-bdd** (it generates Playwright tests from \`.feature\` files and runs them through the Playwright runner — best cross-platform support on Windows). Install \`@playwright/test\`, \`playwright-bdd\`, and \`@cucumber/cucumber\` as dev-dependencies and run \`npx playwright install\`.`,
      `- Add a \`test:e2e\` script to package.json that (a) generates specs from \`.feature\` files with \`bddgen\` and (b) runs them with \`playwright test\`. Example: \`"test:e2e": "bddgen && playwright test"\`.`,
      `- Configure \`playwright.config.ts\` via \`defineBddConfig\` so the \`features/\` and \`features/steps/\` directories are picked up automatically.`,
      `- Detect the app's entry point — the \`start\`/\`dev\` script and the port it listens on — and wire it into Playwright's \`webServer\` config so tests launch the app and wait for it to be ready.`,
      ``,
      `Step 2 — enumerate every scenario:`,
      `- Walk the app's routes/pages (read the router config or main app file) and every interactive component.`,
      `- Produce an exhaustive scenario inventory. For EVERY user-facing flow list: the happy path, every validation error, every authorisation/permission branch, every loading state, every empty state, every network/error-recovery path, and every flow that touches money, data deletion, or auth.`,
      `- Show me the full inventory before writing anything so I can confirm nothing is missing. You are responsible for covering 100% of the scenarios you list — do not silently drop any.`,
      ``,
      `Step 3 — write the \`.feature\` files:`,
      `- Place feature files under \`features/\`, one \`.feature\` per user-facing flow or page (e.g. \`features/login.feature\`, \`features/checkout.feature\`).`,
      `- Use proper Gherkin: \`Feature:\`, \`Background:\` where shared setup applies, \`Scenario:\` for each concrete case, \`Scenario Outline:\` + \`Examples:\` for data-driven variants. Every scenario from the Step 2 inventory must appear as either a \`Scenario\` or a row in a \`Scenario Outline\`.`,
      `- Write steps in business language (\`Given the user is on the login page\`, \`When they submit invalid credentials\`, \`Then they see "Invalid email or password"\`) — not in implementation terms like CSS selectors.`,
      `- Tag scenarios meaningfully (\`@smoke\`, \`@auth\`, \`@checkout\`, \`@negative\`) so subsets can be run with \`--tags\`.`,
      ``,
      `Step 4 — write the step definitions:`,
      `- Place step definitions under \`features/steps/\` (\`.ts\` or \`.js\`), grouped by domain — not one giant file.`,
      `- Use semantic Playwright locators: \`getByRole\`, \`getByLabel\`, \`getByText\`, \`getByTestId\`. Do NOT use brittle CSS or xpath unless there is no semantic option, and in that case add a \`data-testid\` to the element in the app source.`,
      `- Drive the UI from the user's perspective — click real buttons, fill real inputs, wait for visible UI changes (\`expect(locator).toBeVisible()\`), never \`waitForTimeout\`.`,
      `- Use fixtures / API setup (\`Before\` hooks) to seed test data. Scenarios must be independent and must not rely on execution order — each scenario sets up and tears down its own state.`,
      `- Re-use steps across features. Every Gherkin step in every \`.feature\` file must resolve to a defined step — there must be ZERO undefined or pending steps when \`bddgen\` runs.`,
      ``,
      `Step 5 — run from the feature files and verify:`,
      `- Run the suite via \`npm run test:e2e\` — confirm specs are generated from the \`.feature\` files and executed by the runner. The \`.feature\` files are the source of truth; no hand-written \`*.spec.ts\` files outside the generated output.`,
      `- Every scenario must pass. Run once headed (\`npx playwright test --headed\`) and confirm the flows look correct visually.`,
      `- Verify the scenario count matches the Step 2 inventory exactly. If any scenario is missing, add it before reporting done.`,
      `- List anything you intentionally did NOT cover and why.`,
      ``,
      `Do not weaken assertions, skip scenarios, mark them \`@wip\`/\`@skip\`, or assert only on URLs or element existence — assert on the rendered text/state the user would actually read on screen.`
    ].join('\n');
  }
  return [
    `No unit tests were found in this project. Create a complete unit-test suite.`,
    ``,
    `Step 1 — detect:`,
    `- Read package.json (or pyproject.toml / go.mod / Cargo.toml).`,
    `- Identify the runtime, the existing test framework if any, and the source layout.`,
    `- If no framework is configured: pick the idiomatic one — Vitest for Vite / ESM JS/TS projects, Jest for CRA / Node projects, pytest for Python, \`go test\` for Go, \`cargo test\` for Rust. Install it as a dev-dependency and add a \`test\` script to package.json.`,
    ``,
    `Step 2 — plan coverage:`,
    `- List every public function / class / module under the project's source directory (skip node_modules, build output, generated files, vendored code).`,
    `- For each, identify: the happy path, the documented edge cases, the error paths, and the boundary inputs (empty / null / zero / max).`,
    `- Show me the coverage plan before writing tests so I can confirm priorities.`,
    ``,
    `Step 3 — write the tests:`,
    `- Place each test next to its source as \`<name>.test.<ext>\` — unless the project already has a \`tests/\` directory mirroring the source tree, in which case follow that convention.`,
    `- One \`describe\` per unit, one \`it\` per behaviour. Test names describe behaviour, not implementation.`,
    `- Use real dependencies where they are cheap and deterministic; mock only at process boundaries (network, filesystem, time, randomness).`,
    `- For each unit cover: happy path, every error path, every branch in conditionals, empty / null / boundary inputs.`,
    `- Add shared fixtures only when the same data is reused at least three times.`,
    ``,
    `Step 4 — verify:`,
    `- Run the full suite. Every test must pass. Report coverage numbers if the framework supports it.`,
    `- List anything you intentionally did NOT cover and why.`,
    ``,
    `Do not stub assertions and do not write tests that only check a function was called — assert on observable behaviour and return values.`
  ].join('\n');
}

function buildUpdateUnitTestsPrompt() {
  return [
    `Audit the project's unit-test coverage and add tests for every public function, class, or module that is currently missing one. Do not touch tests that already exist unless they're broken.`,
    ``,
    `Step 1 — inventory:`,
    `- Read package.json (or pyproject.toml / go.mod / Cargo.toml) to confirm the runtime and test framework. If no framework is configured, pick the idiomatic one (Vitest for ESM JS/TS, Jest for CRA / Node, pytest for Python, \`go test\` for Go, \`cargo test\` for Rust), install it as a dev-dependency, and add a \`test\` script to package.json.`,
    `- List every public function / class / module under the project's source directory (skip node_modules, build output, generated files, vendored code).`,
    `- For each, locate the matching \`*.test.*\` / \`*_test.*\` file. Anything without a corresponding test is a gap.`,
    ``,
    `Step 2 — plan the gaps:`,
    `- Show me the list of units missing tests, grouped by file.`,
    `- For each gap, note: happy path, documented edge cases, error paths, and boundary inputs (empty / null / zero / max).`,
    `- Wait for me to confirm priorities before writing tests.`,
    ``,
    `Step 3 — write the missing tests:`,
    `- Place each new test next to its source as \`<name>.test.<ext>\` — unless the project already has a \`tests/\` directory mirroring the source tree, in which case follow that convention.`,
    `- One \`describe\` per unit, one \`it\` per behaviour. Test names describe behaviour, not implementation.`,
    `- Use real dependencies where they are cheap and deterministic; mock only at process boundaries (network, filesystem, time, randomness).`,
    `- For each new unit cover: happy path, every error path, every branch in conditionals, empty / null / boundary inputs.`,
    `- Add shared fixtures only when the same data is reused at least three times.`,
    ``,
    `Step 4 — verify:`,
    `- Run the full suite (existing + new). Every test must pass. Report coverage numbers if the framework supports it.`,
    `- List anything you intentionally did NOT cover and why.`,
    ``,
    `Do not stub assertions and do not write tests that only check a function was called — assert on observable behaviour and return values. Do not modify pre-existing passing tests.`
  ].join('\n');
}

// ───────────────────────────────────────────────────────── prompt logs

// Multi-line pastes need to be logged as a single entry rather than one per
// line. xterm.js delivers a paste as either (a) a chunk wrapped in bracketed-
// paste markers \x1b[200~ ... \x1b[201~ when the running program enables
// bracketed paste, or (b) a single large chunk with embedded newlines when it
// doesn't. We handle both: bracketed pastes via an explicit state flag, and
// raw pastes via a length+newline heuristic.
function captureCmdInput(tab, data) {
  if (!data) return;
  let remaining = data;
  while (remaining.length > 0) {
    if (tab.inBracketedPaste) {
      const end = remaining.indexOf('\x1b[201~');
      if (end < 0) {
        tab.cmdInputBuffer += normalizePasteText(remaining);
        return;
      }
      tab.cmdInputBuffer += normalizePasteText(remaining.slice(0, end));
      remaining = remaining.slice(end + 6);
      tab.inBracketedPaste = false;
      // The pasted block IS the prompt — flush as a single log entry. The
      // terminal will still echo each embedded newline as Enter to the
      // underlying program, but that's the program's problem to interpret.
      submitCmdInputBuffer(tab);
      continue;
    }
    const start = remaining.indexOf('\x1b[200~');
    if (start >= 0) {
      processKeystrokes(tab, remaining.slice(0, start));
      remaining = remaining.slice(start + 6);
      tab.inBracketedPaste = true;
      continue;
    }
    if (looksLikeRawPaste(remaining)) {
      tab.cmdInputBuffer += normalizePasteText(remaining);
      submitCmdInputBuffer(tab);
    } else {
      processKeystrokes(tab, remaining);
    }
    return;
  }
}

function processKeystrokes(tab, data) {
  if (!data) return;
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    const code = data.charCodeAt(i);
    if (code === 0x1b) {
      // Escape sequence (arrow keys, function keys, etc.) — skip past it,
      // but DON'T drop the buffer: the user is usually navigating inside the
      // current line (Left/Right/Home/End) and we want to keep what they've typed.
      if (data[i + 1] === '[' || data[i + 1] === 'O') {
        i++;
        while (i + 1 < data.length && !/[A-Za-z~]/.test(data[i + 1])) i++;
        i++;
      }
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      submitCmdInputBuffer(tab);
      continue;
    }
    if (code === 0x7f || ch === '\b') {
      tab.cmdInputBuffer = tab.cmdInputBuffer.slice(0, -1);
      continue;
    }
    if (code === 0x03 || code === 0x15) {
      // Ctrl+C, Ctrl+U — abandon line
      tab.cmdInputBuffer = '';
      continue;
    }
    if (code >= 0x20 && code !== 0x7f) {
      tab.cmdInputBuffer += ch;
    }
  }
}

function looksLikeRawPaste(data) {
  if (!data || data.length < 3) return false;
  let printable = 0;
  let newlines = 0;
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    if (c === 0x1b) {
      // Skip an escape sequence so it doesn't inflate the printable count.
      i++;
      while (i < data.length && !/[A-Za-z~]/.test(data[i])) i++;
      continue;
    }
    if (c === 0x0a || c === 0x0d) newlines++;
    else if (c >= 0x20 && c !== 0x7f) printable++;
  }
  // A "paste" looks like several printable chars with at least one embedded
  // newline. A bare Enter keypress has 0 printable + 1 newline; arrow keys
  // produce 0 printable + 0 newline; this filter excludes both.
  return newlines >= 1 && printable >= 2;
}

function normalizePasteText(s) {
  if (!s) return '';
  // Strip lingering escape sequences and control bytes other than newlines,
  // collapse CRLF/CR to LF so logged entries are clean multi-line strings.
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x1b) {
      i++;
      while (i < s.length && !/[A-Za-z~]/.test(s[i])) i++;
      continue;
    }
    if (c === 0x0d) {
      out += '\n';
      if (s.charCodeAt(i + 1) === 0x0a) i++;
      continue;
    }
    if (c === 0x0a) { out += '\n'; continue; }
    if (c === 0x09) { out += '\t'; continue; }
    if (c >= 0x20 && c !== 0x7f) out += s[i];
  }
  return out;
}

function submitCmdInputBuffer(tab) {
  const raw = tab.cmdInputBuffer;
  tab.cmdInputBuffer = '';
  if (!raw) return;
  // Preserve internal newlines; trim only the outer whitespace.
  const trimmed = raw.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  if (trimmed) logPromptEntry(tab, 'user', trimmed);
}

function logPromptEntry(tab, source, text) {
  if (!tab.folder || !text) return;
  // If a previous prompt is still waiting on Claude's response, finalize it
  // with whatever is in the response buffer before starting a new one.
  if (tab.pendingPromptIndex >= 0) {
    finalizePendingPromptEntry(tab);
  }
  const inputTokens = estimateTokens(text);
  const entry = {
    ts: new Date().toISOString(),
    source,
    prompt: text,
    response: '',
    inputTokens,
    outputTokens: 0,
    costUsd: estimateCostUsd(inputTokens, 0),
    modelAssumed: COST_MODEL_LABEL
  };
  tab.promptLog.push(entry);
  tab.pendingPromptIndex = tab.promptLog.length - 1;
  tab.responseBuffer = '';
  renderLogsList(tab);
  window.api.prompts.append(tab.folder, entry).catch((err) => {
    console.error('[prompts.append]', err);
  });
}

function finalizePendingPromptEntry(tab) {
  tab.pendingPromptIndex = -1;
  tab.responseBuffer = '';
  renderLogsList(tab);
}

// Cost-estimate constants. The `claude` CLI defaults to Sonnet; rates are
// approximate and only intended as a rough running tally.
const COST_PER_M_INPUT = 3.00;
const COST_PER_M_OUTPUT = 15.00;
const COST_MODEL_LABEL = 'sonnet (est.)';

function estimateTokens(s) {
  if (!s) return 0;
  return Math.max(1, Math.ceil(String(s).length / 4));
}

function estimateCostUsd(inputTok, outputTok) {
  return ((inputTok || 0) * COST_PER_M_INPUT + (outputTok || 0) * COST_PER_M_OUTPUT) / 1_000_000;
}

function fmtCostUsd(usd) {
  if (!usd || usd <= 0) return '$0.0000';
  if (usd < 0.0001) return '<$0.0001';
  if (usd < 1) return '$' + usd.toFixed(4);
  return '$' + usd.toFixed(2);
}

function fmtTokens(n) {
  const v = Math.max(0, Math.round(n || 0));
  return v.toLocaleString();
}

async function loadPromptLog(tab, showOnLoad) {
  if (!tab.folder) return;
  try {
    // Project-load sync: replace the local log file with the cloud copy
    // before reading. Failures (cloud disabled, network down, etc.) are
    // soft — we fall back to whatever is on disk.
    if (window.api.prompts.syncFromCloud) {
      try {
        await window.api.prompts.syncFromCloud(tab.folder);
      } catch (e) {
        console.warn('[prompts.syncFromCloud]', e);
      }
    }
    const res = await window.api.prompts.read(tab.folder);
    if (res && res.ok) {
      const raw = Array.isArray(res.entries) ? res.entries : [];
      tab.promptLog = raw.map((e) => {
        const prompt = e && typeof e.prompt === 'string' ? e.prompt : '';
        const response = e && typeof e.response === 'string' ? e.response : '';
        const inputTokens = Number.isFinite(e && e.inputTokens) ? e.inputTokens : estimateTokens(prompt);
        const outputTokens = Number.isFinite(e && e.outputTokens) ? e.outputTokens : estimateTokens(response);
        const costUsd = Number.isFinite(e && e.costUsd) ? e.costUsd : estimateCostUsd(inputTokens, outputTokens);
        return {
          ts: (e && e.ts) || null,
          source: (e && e.source) || 'user',
          prompt,
          response,
          inputTokens,
          outputTokens,
          costUsd,
          modelAssumed: (e && e.modelAssumed) || COST_MODEL_LABEL
        };
      });
      tab.pendingPromptIndex = -1;
      tab.responseBuffer = '';
    }
  } catch (err) {
    console.error('[prompts.read]', err);
  }
  renderLogsList(tab);
  if (showOnLoad) toggleLogsPanel(tab, true);
}

function renderLogsList(tab) {
  const list = tab.els.logsList;
  list.innerHTML = '';
  const count = tab.promptLog.length;
  tab.els.logsCount.textContent = String(count);
  tab.els.logsToggleBtn.classList.toggle('has-items', count > 0);
  if (!count) {
    const empty = document.createElement('li');
    empty.className = 'queue-empty';
    empty.textContent = 'No prompts logged yet.';
    list.appendChild(empty);
    return;
  }
  const items = tab.promptLog.slice().reverse();
  const totalIn = tab.promptLog.reduce((acc, e) => acc + (Number(e.inputTokens) || 0), 0);
  const totalOut = tab.promptLog.reduce((acc, e) => acc + (Number(e.outputTokens) || 0), 0);
  const totalQueryCost = estimateCostUsd(totalIn, 0);
  const totalResultCost = estimateCostUsd(0, totalOut);
  const totalCost = totalQueryCost + totalResultCost;

  const totalsLi = document.createElement('li');
  totalsLi.className = 'logs-totals';
  totalsLi.textContent =
    `Σ query ${fmtCostUsd(totalQueryCost)} + results ${fmtCostUsd(totalResultCost)} = ${fmtCostUsd(totalCost)} · `
    + `${fmtTokens(totalIn)}↑ / ${fmtTokens(totalOut)}↓ tok · ${COST_MODEL_LABEL}`;
  list.appendChild(totalsLi);

  items.forEach((entry, idx) => {
    const isPending = tab.pendingPromptIndex >= 0
      && (tab.promptLog.length - 1 - idx) === tab.pendingPromptIndex;

    const li = document.createElement('li');
    li.className = 'logs-item' + (isPending ? ' logs-item-pending' : '');

    const meta = document.createElement('div');
    meta.className = 'logs-item-meta';
    const idxSpan = document.createElement('span');
    idxSpan.className = 'logs-item-index';
    idxSpan.textContent = '#' + (count - idx);
    const ts = document.createElement('span');
    ts.className = 'logs-item-ts';
    ts.textContent = fmtLogTs(entry.ts);
    const src = document.createElement('span');
    src.className = 'logs-item-source logs-source-' + (entry.source || 'user');
    src.textContent = entry.source || 'user';

    const cost = document.createElement('span');
    cost.className = 'logs-item-cost';
    const inTok = Number(entry.inputTokens) || 0;
    const outTok = Number(entry.outputTokens) || 0;
    const queryCost = estimateCostUsd(inTok, 0);
    const resultCost = estimateCostUsd(0, outTok);
    const totalLine = queryCost + resultCost;
    if (isPending) {
      cost.textContent = `query ${fmtCostUsd(queryCost)} · results pending · ${fmtTokens(inTok)}↑ tok`;
    } else {
      cost.textContent =
        `query ${fmtCostUsd(queryCost)} + results ${fmtCostUsd(resultCost)} = ${fmtCostUsd(totalLine)} · `
        + `${fmtTokens(inTok)}↑ / ${fmtTokens(outTok)}↓ tok`;
    }
    cost.title =
      `Estimated cost — ${COST_MODEL_LABEL}\n`
      + `query cost (input ${fmtTokens(inTok)} tok × $${COST_PER_M_INPUT}/M): ${fmtCostUsd(queryCost)}\n`
      + `results cost (output ${fmtTokens(outTok)} tok × $${COST_PER_M_OUTPUT}/M): ${fmtCostUsd(resultCost)}`;

    meta.appendChild(idxSpan);
    meta.appendChild(ts);
    meta.appendChild(src);
    meta.appendChild(cost);
    if (isPending) {
      const pending = document.createElement('span');
      pending.className = 'logs-item-pending-tag';
      pending.textContent = 'awaiting response…';
      meta.appendChild(pending);
    }

    const body = document.createElement('pre');
    body.className = 'logs-item-text';
    body.textContent = entry.prompt || '';

    li.appendChild(meta);
    li.appendChild(body);

    const responseText = (entry.response || '').trim();
    if (responseText) {
      const respLabel = document.createElement('div');
      respLabel.className = 'logs-item-resp-label';
      respLabel.textContent = `Claude (~${fmtTokens(outTok)} output tok)`;
      const resp = document.createElement('pre');
      resp.className = 'logs-item-response';
      resp.textContent = responseText;
      li.appendChild(respLabel);
      li.appendChild(resp);
    } else if (isPending) {
      const respLabel = document.createElement('div');
      respLabel.className = 'logs-item-resp-label';
      respLabel.textContent = 'Claude (in progress…)';
      li.appendChild(respLabel);
    }

    list.appendChild(li);
  });
}

function fmtLogTs(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
  } catch (_) {
    return iso;
  }
}

function toggleLogsPanel(tab, force) {
  const panel = tab.els.logsPanel;
  const show = typeof force === 'boolean' ? force : panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !show);
  if (show) {
    tab.els.queuePanel.classList.add('hidden');
    renderLogsList(tab);
  }
  requestAnimationFrame(() => fitTab(tab));
}

async function clearPromptLog(tab) {
  if (!tab.folder) return;
  if (!confirm('Clear all logged prompts for this folder?')) return;
  const res = await window.api.prompts.clear(tab.folder);
  if (res && res.ok) {
    tab.promptLog = [];
    tab.pendingPromptIndex = -1;
    tab.responseBuffer = '';
    renderLogsList(tab);
  } else {
    alert('Failed to clear: ' + ((res && res.error) || 'unknown'));
  }
}

// ───────────────────────────────────────────────────────── github publish + commit/push

const gitOpLogs = new Map();

function appendGitOpLog(tab, opId, line) {
  const entry = gitOpLogs.get(opId);
  if (!entry) return;
  const target = entry.target;
  if (!target) return;
  target.textContent += (target.textContent ? '\n' : '') + line;
  target.scrollTop = target.scrollHeight;
}

async function openCommitPanel(tab) {
  if (!tab.folder) return;
  tab.els.publishPanel.classList.add('hidden');
  if (tab.els.actionPanel) tab.els.actionPanel.classList.add('hidden');
  if (tab.els.prPanel) tab.els.prPanel.classList.add('hidden');
  tab.els.commitPanel.classList.remove('hidden');
  tab.els.commitLog.textContent = '';
  const info = await window.api.git.repoInfo(tab.folder).catch(() => null);
  const current = info && info.branch ? info.branch : 'main';
  tab.els.commitBranchInput.value = current;
  tab._commitCurrentBranch = current;
  tab.els.commitNewBranch.checked = false;
  tab.els.commitMessageInput.value = '';
  renderAheadBehind(tab.els.commitAheadBehind, { loading: true });
  window.api.git.aheadBehind(tab.folder)
    .then((res) => renderAheadBehind(tab.els.commitAheadBehind, res || {}))
    .catch(() => renderAheadBehind(tab.els.commitAheadBehind, { ok: false }));
  loadRecentCheckins(tab);
  tab.els.commitMessageInput.focus();
}

async function loadRecentCheckins(tab) {
  const list = tab.els.commitCheckinsList;
  const countEl = tab.els.commitCheckinsCount;
  if (!list || !tab.folder) return;
  list.innerHTML = '<li class="checkins-empty">loading…</li>';
  if (countEl) countEl.textContent = '…';
  let res;
  try {
    res = await window.api.git.recentCommits(tab.folder, 30);
  } catch (err) {
    list.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'checkins-empty';
    li.textContent = `error: ${err.message || err}`;
    list.appendChild(li);
    if (countEl) countEl.textContent = '!';
    return;
  }
  list.innerHTML = '';
  if (!res || !res.ok) {
    const li = document.createElement('li');
    li.className = 'checkins-empty';
    li.textContent = (res && res.error) || 'failed to load commits';
    list.appendChild(li);
    if (countEl) countEl.textContent = '!';
    return;
  }
  if (res.hasCommits === false) {
    const li = document.createElement('li');
    li.className = 'checkins-empty';
    li.textContent = 'no commits yet';
    list.appendChild(li);
    if (countEl) countEl.textContent = '0';
    return;
  }
  const commits = res.commits || [];
  if (countEl) countEl.textContent = String(commits.length);
  if (!commits.length) {
    const li = document.createElement('li');
    li.className = 'checkins-empty';
    li.textContent = '(no commits)';
    list.appendChild(li);
    return;
  }
  for (const c of commits) {
    list.appendChild(renderCheckinItem(tab, c));
  }
}

function renderCheckinItem(tab, commit) {
  const li = document.createElement('li');
  li.className = 'checkin-item';
  li.dataset.hash = commit.hash;

  const head = document.createElement('div');
  head.className = 'checkin-head';

  const chevron = document.createElement('span');
  chevron.className = 'checkin-chevron';
  chevron.textContent = '▸';

  const hash = document.createElement('span');
  hash.className = 'checkin-hash';
  hash.textContent = commit.shortHash || (commit.hash || '').slice(0, 7);

  const subject = document.createElement('span');
  subject.className = 'checkin-subject';
  subject.textContent = commit.subject || '(no message)';
  subject.title = commit.subject || '';

  const meta = document.createElement('span');
  meta.className = 'checkin-meta';
  meta.textContent = `${commit.author || ''} · ${formatCheckinDate(commit.date)}`;

  head.appendChild(chevron);
  head.appendChild(hash);
  head.appendChild(subject);
  head.appendChild(meta);
  li.appendChild(head);

  const body = document.createElement('div');
  body.className = 'checkin-body hidden';
  li.appendChild(body);

  head.addEventListener('click', () => toggleCheckin(tab, li, commit));
  return li;
}

function formatCheckinDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const opts = sameYear
    ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: 'short', day: 'numeric' };
  return d.toLocaleString(undefined, opts);
}

async function toggleCheckin(tab, li, commit) {
  const body = li.querySelector('.checkin-body');
  const chevron = li.querySelector('.checkin-chevron');
  if (!body) return;
  if (!body.classList.contains('hidden')) {
    body.classList.add('hidden');
    li.classList.remove('expanded');
    if (chevron) chevron.textContent = '▸';
    return;
  }
  li.classList.add('expanded');
  body.classList.remove('hidden');
  if (chevron) chevron.textContent = '▾';
  if (body.dataset.loaded === '1') return;
  body.textContent = 'loading…';
  let res;
  try {
    res = await window.api.git.commitShow(tab.folder, commit.hash);
  } catch (err) {
    body.textContent = `error: ${err.message || err}`;
    return;
  }
  if (!res || !res.ok) {
    body.textContent = (res && res.error) || 'failed to load changes';
    return;
  }
  renderCheckinBody(body, commit, res);
  body.dataset.loaded = '1';
}

function renderCheckinBody(body, commit, res) {
  body.innerHTML = '';
  if (commit.body) {
    const msg = document.createElement('pre');
    msg.className = 'checkin-message';
    msg.textContent = commit.body;
    body.appendChild(msg);
  }
  const files = res.files || [];
  if (files.length) {
    const filesEl = document.createElement('ul');
    filesEl.className = 'checkin-files';
    for (const f of files) {
      const fi = document.createElement('li');
      fi.className = 'checkin-file';
      const st = document.createElement('span');
      st.className = `checkin-file-status status-${(f.status || '').toLowerCase()}`;
      st.textContent = f.status || '?';
      const pa = document.createElement('span');
      pa.className = 'checkin-file-path';
      pa.textContent = f.path;
      fi.appendChild(st);
      fi.appendChild(pa);
      filesEl.appendChild(fi);
    }
    body.appendChild(filesEl);
  }
  const diffWrap = document.createElement('div');
  diffWrap.className = 'checkin-diff';
  const diffText = (res.diff || '').trim();
  if (!diffText) {
    diffWrap.textContent = '(no diff — empty or merge commit)';
  } else {
    const lines = diffText.split('\n');
    const frag = document.createDocumentFragment();
    for (const ln of lines) {
      const div = document.createElement('div');
      div.className = 'diff-line';
      if (ln.startsWith('+++') || ln.startsWith('---')) div.classList.add('diff-meta');
      else if (ln.startsWith('+')) div.classList.add('diff-add');
      else if (ln.startsWith('-')) div.classList.add('diff-del');
      else if (ln.startsWith('@@')) div.classList.add('diff-hunk');
      else if (ln.startsWith('diff ') || ln.startsWith('index ') || ln.startsWith('new file') || ln.startsWith('deleted file') || ln.startsWith('rename ') || ln.startsWith('similarity ')) div.classList.add('diff-meta');
      div.textContent = ln === '' ? ' ' : ln;
      frag.appendChild(div);
    }
    diffWrap.appendChild(frag);
  }
  body.appendChild(diffWrap);
}

function renderAheadBehind(el, res) {
  if (!el) return;
  el.classList.remove('ahead-behind-clean', 'ahead-behind-warn', 'ahead-behind-error');
  if (res && res.loading) {
    el.textContent = 'checking trunk…';
    return;
  }
  if (!res || res.ok === false) {
    el.textContent = '';
    return;
  }
  if (res.isRepo === false) { el.textContent = ''; return; }
  if (res.hasCommits === false) { el.textContent = 'no commits yet'; return; }
  if (!res.trunk) { el.textContent = 'trunk not found'; el.classList.add('ahead-behind-warn'); return; }
  const trunkLabel = res.trunkName || res.trunk;
  if (res.onTrunk) {
    el.textContent = `on ${trunkLabel}`;
    el.classList.add('ahead-behind-clean');
    return;
  }
  const ahead = res.ahead || 0;
  const behind = res.behind || 0;
  el.textContent = `${ahead} ahead · ${behind} behind ${trunkLabel}`;
  if (ahead === 0 && behind === 0) el.classList.add('ahead-behind-clean');
  else if (behind > 0) el.classList.add('ahead-behind-warn');
}

function promptNewBranchName(tab) {
  if (!tab.els.commitNewBranch.checked) {
    if (tab._commitCurrentBranch) {
      tab.els.commitBranchInput.value = tab._commitCurrentBranch;
    }
    return;
  }
  const name = (window.prompt('New branch name:', '') || '').trim();
  if (!name) {
    tab.els.commitNewBranch.checked = false;
    if (tab._commitCurrentBranch) {
      tab.els.commitBranchInput.value = tab._commitCurrentBranch;
    }
    return;
  }
  tab.els.commitBranchInput.value = name;
  tab.els.commitMessageInput.focus();
}

async function openPublishPanel(tab) {
  if (!tab.folder) return;
  tab.els.commitPanel.classList.add('hidden');
  if (tab.els.actionPanel) tab.els.actionPanel.classList.add('hidden');
  if (tab.els.prPanel) tab.els.prPanel.classList.add('hidden');
  tab.els.publishPanel.classList.remove('hidden');
  tab.els.publishLog.textContent = '';
  const segments = tab.folder.split(/[\\/]+/).filter(Boolean);
  const leaf = (segments[segments.length - 1] || '').replace(/\s+/g, '-');
  tab.els.publishRepoInput.value = leaf;
  tab.els.publishDescInput.value = '';
  tab.els.publishCommitInput.value = 'Initial commit';
  tab.els.ghStatus.textContent = 'checking gh…';
  tab.els.ghStatus.className = 'ghStatus gh-status';
  let ghReady = false;
  try {
    const res = await window.api.github.checkGh();
    if (!res.installed) {
      tab.els.ghStatus.textContent = 'gh CLI not found';
      tab.els.ghStatus.classList.add('bad');
    } else if (!res.authed) {
      tab.els.ghStatus.textContent = 'gh not authenticated — run: gh auth login';
      tab.els.ghStatus.classList.add('bad');
    } else {
      tab.els.ghStatus.textContent = res.user ? `gh ✓ (${res.user})` : 'gh ✓';
      tab.els.ghStatus.classList.add('good');
      ghReady = true;
    }
  } catch (err) {
    tab.els.ghStatus.textContent = 'gh check failed';
    tab.els.ghStatus.classList.add('bad');
  }
  const info = await window.api.git.repoInfo(tab.folder).catch(() => null);
  if (info && info.originUrl) {
    tab.els.ghStatus.textContent += ` · origin already set: ${info.originUrl}`;
    tab.els.ghStatus.classList.add('bad');
  }
  if (ghReady) {
    await loadPublishOwners(tab, false);
  } else {
    tab.els.publishOwnerSelect.innerHTML = '<option value="">(gh unavailable)</option>';
  }
  tab.els.publishRepoInput.focus();
  tab.els.publishRepoInput.select();
}

async function loadPublishOwners(tab, force) {
  const select = tab.els.publishOwnerSelect;
  if (!select) return;
  select.innerHTML = '<option value="">(loading…)</option>';
  const res = await window.api.github.listOwners().catch((err) => ({ ok: false, error: err.message }));
  select.innerHTML = '';
  if (!res || !res.ok) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = `(error: ${(res && res.error) || 'unknown'})`;
    select.appendChild(opt);
    return;
  }
  const owners = [];
  if (res.user) owners.push({ value: res.user, label: `${res.user} (your account)` });
  for (const org of res.orgs || []) {
    if (org && org !== res.user) owners.push({ value: org, label: org });
  }
  if (!owners.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(no owners found)';
    select.appendChild(opt);
    return;
  }
  for (const o of owners) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    select.appendChild(opt);
  }
  select.value = owners[0].value;
}

async function runCommitPush(tab) {
  if (!tab.folder) return;
  const branch = tab.els.commitBranchInput.value.trim();
  const newBranch = tab.els.commitNewBranch.checked;
  const commitMessage = tab.els.commitMessageInput.value.trim();
  const stageAll = tab.els.commitStageAll.checked;
  const push = tab.els.commitPushToggle.checked;
  const setUpstream = tab.els.commitSetUpstream.checked;
  if (!commitMessage) {
    tab.els.commitLog.textContent = '✗ Commit message is required.';
    tab.els.commitMessageInput.focus();
    return;
  }
  const opId = 'op-' + crypto.randomUUID().slice(0, 8);
  gitOpLogs.set(opId, { target: tab.els.commitLog });
  tab.els.commitLog.textContent = '';
  tab.els.commitRunBtn.disabled = true;
  tab.els.commitCancelBtn.disabled = true;
  try {
    const res = await window.api.git.commitPush({
      id: opId,
      cwd: tab.folder,
      branch,
      newBranch,
      commitMessage,
      stageAll,
      push,
      setUpstream
    });
    if (res && res.ok) {
      await refreshGitStatus(tab);
      loadRecentCheckins(tab);
    }
  } catch (err) {
    appendGitOpLog(tab, opId, `✗ ${err.message || err}`);
  } finally {
    gitOpLogs.delete(opId);
    tab.els.commitRunBtn.disabled = false;
    tab.els.commitCancelBtn.disabled = false;
  }
}

async function runPublish(tab) {
  if (!tab.folder) return;
  const rawRepo = tab.els.publishRepoInput.value.trim();
  const owner = (tab.els.publishOwnerSelect && tab.els.publishOwnerSelect.value || '').trim();
  let visibility = 'private';
  for (const r of tab.els.publishVisInputs) {
    if (r.checked) { visibility = r.value; break; }
  }
  const description = tab.els.publishDescInput.value.trim();
  const commitMessage = tab.els.publishCommitInput.value.trim() || 'Initial commit';
  if (!rawRepo) {
    tab.els.publishLog.textContent = '✗ Repo name is required.';
    tab.els.publishRepoInput.focus();
    return;
  }
  const repoName = rawRepo.includes('/') || !owner ? rawRepo : `${owner}/${rawRepo}`;
  const opId = 'op-' + crypto.randomUUID().slice(0, 8);
  gitOpLogs.set(opId, { target: tab.els.publishLog });
  tab.els.publishLog.textContent = '';
  tab.els.publishRunBtn.disabled = true;
  tab.els.publishCancelBtn.disabled = true;
  try {
    const res = await window.api.github.publish({
      id: opId,
      cwd: tab.folder,
      repoName,
      visibility,
      description,
      commitMessage
    });
    if (res && res.ok) {
      await refreshGitStatus(tab);
    }
  } catch (err) {
    appendGitOpLog(tab, opId, `✗ ${err.message || err}`);
  } finally {
    gitOpLogs.delete(opId);
    tab.els.publishRunBtn.disabled = false;
    tab.els.publishCancelBtn.disabled = false;
  }
}

async function openPRPanel(tab) {
  if (!tab.folder) return;
  tab.els.commitPanel.classList.add('hidden');
  tab.els.publishPanel.classList.add('hidden');
  if (tab.els.actionPanel) tab.els.actionPanel.classList.add('hidden');
  tab.els.prPanel.classList.remove('hidden');
  tab.els.prLog.textContent = '';
  tab.els.prCurrent.textContent = '';
  if (!tab.els.prBaseInput.value.trim()) tab.els.prBaseInput.value = 'main';

  tab.els.prGhStatus.textContent = 'checking gh…';
  tab.els.prGhStatus.className = 'prGhStatus gh-status';
  try {
    const res = await window.api.github.checkGh();
    if (!res.installed) {
      tab.els.prGhStatus.textContent = 'gh CLI not found';
      tab.els.prGhStatus.classList.add('bad');
    } else if (!res.authed) {
      tab.els.prGhStatus.textContent = 'gh not authenticated — run: gh auth login';
      tab.els.prGhStatus.classList.add('bad');
    } else {
      tab.els.prGhStatus.textContent = res.user ? `gh ✓ (${res.user})` : 'gh ✓';
      tab.els.prGhStatus.classList.add('good');
    }
  } catch (_) {
    tab.els.prGhStatus.textContent = 'gh check failed';
    tab.els.prGhStatus.classList.add('bad');
  }

  const info = await window.api.git.repoInfo(tab.folder).catch(() => null);
  if (info && info.branch && !tab.els.prTitleInput.value.trim()) {
    tab.els.prTitleInput.value = info.branch.replace(/[-_/]+/g, ' ').trim();
  }
  tab.currentBranchName = (info && info.branch) || null;
  tab.prSelectedRef = null;
  await loadOpenPRs(tab);
  await refreshPRReviews(tab);
}

async function loadOpenPRs(tab) {
  if (!tab.folder) return;
  const list = tab.els.prOpenList;
  const count = tab.els.prOpenCount;
  tab.els.prOpenRefreshBtn.disabled = true;
  list.innerHTML = '';
  const loading = document.createElement('li');
  loading.className = 'pr-open-empty';
  loading.textContent = 'Loading…';
  list.appendChild(loading);
  count.textContent = '—';
  try {
    const res = await window.api.github.listPRs(tab.folder, 'open');
    list.innerHTML = '';
    if (!res || !res.ok) {
      const li = document.createElement('li');
      li.className = 'pr-open-empty';
      li.textContent = `(error: ${(res && res.error) || 'unknown'})`;
      list.appendChild(li);
      count.textContent = '—';
      tab.openPRs = [];
      return;
    }
    const prs = Array.isArray(res.prs) ? res.prs : [];
    tab.openPRs = prs;
    count.textContent = `${prs.length}`;
    if (!prs.length) {
      const li = document.createElement('li');
      li.className = 'pr-open-empty';
      li.textContent = 'No open pull requests.';
      list.appendChild(li);
      return;
    }
    prs.sort((a, b) => {
      const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      return tb - ta;
    });
    for (const pr of prs) {
      list.appendChild(buildOpenPRItem(tab, pr));
    }
    highlightSelectedOpenPR(tab);
  } catch (err) {
    list.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'pr-open-empty';
    li.textContent = `(error: ${err.message || err})`;
    list.appendChild(li);
  } finally {
    tab.els.prOpenRefreshBtn.disabled = false;
  }
}

function buildOpenPRItem(tab, pr) {
  const li = document.createElement('li');
  li.className = 'pr-open-item';
  li.dataset.prNumber = String(pr.number);

  const num = document.createElement('span');
  num.className = 'pr-open-num';
  num.textContent = `#${pr.number}`;
  li.appendChild(num);

  const title = document.createElement('span');
  title.className = 'pr-open-title-text';
  title.textContent = pr.title || '(no title)';
  title.title = pr.title || '';
  li.appendChild(title);

  if (pr.isDraft) {
    const draft = document.createElement('span');
    draft.className = 'pr-open-draft';
    draft.textContent = 'draft';
    li.appendChild(draft);
  }

  if (pr.headRefName) {
    const branch = document.createElement('span');
    branch.className = 'pr-open-branch';
    branch.textContent = pr.headRefName;
    li.appendChild(branch);
  }

  const authorLogin = (pr.author && pr.author.login) || '';
  if (authorLogin) {
    const author = document.createElement('span');
    author.className = 'pr-open-author';
    author.textContent = `@${authorLogin}`;
    li.appendChild(author);
  }

  li.addEventListener('click', () => selectOpenPR(tab, pr));
  return li;
}

function selectOpenPR(tab, pr) {
  if (!pr || pr.number == null) return;
  tab.prSelectedRef = String(pr.number);
  highlightSelectedOpenPR(tab);
  refreshPRReviews(tab);
}

function highlightSelectedOpenPR(tab) {
  const list = tab.els.prOpenList;
  if (!list) return;
  const items = list.querySelectorAll('.pr-open-item');
  for (const item of items) {
    item.classList.toggle('selected', item.dataset.prNumber === tab.prSelectedRef);
  }
}

async function createPullRequest(tab) {
  if (!tab.folder) return;
  const title = tab.els.prTitleInput.value.trim();
  const body = tab.els.prBodyInput.value;
  const base = tab.els.prBaseInput.value.trim();
  const draft = tab.els.prDraftToggle.checked;
  if (!title) {
    tab.els.prLog.textContent = '✗ PR title is required.';
    tab.els.prTitleInput.focus();
    return;
  }
  const opId = 'op-' + crypto.randomUUID().slice(0, 8);
  gitOpLogs.set(opId, { target: tab.els.prLog });
  tab.els.prLog.textContent = '';
  tab.els.prCreateBtn.disabled = true;
  tab.els.prRefreshBtn.disabled = true;
  try {
    const res = await window.api.github.createPR({
      id: opId,
      cwd: tab.folder,
      title,
      body,
      base,
      draft
    });
    if (res && res.ok) {
      await refreshPRReviews(tab);
    }
  } catch (err) {
    appendGitOpLog(tab, opId, `✗ ${err.message || err}`);
  } finally {
    gitOpLogs.delete(opId);
    tab.els.prCreateBtn.disabled = false;
    tab.els.prRefreshBtn.disabled = false;
  }
}

async function refreshPRReviews(tab) {
  if (!tab.folder) return;
  tab.els.prRefreshBtn.disabled = true;
  tab.els.prReviewsList.textContent = 'Loading…';
  const ref = tab.prSelectedRef || undefined;
  if (tab.els.prReviewsFor) {
    tab.els.prReviewsFor.textContent = ref ? `for #${ref}` : '(current branch)';
  }
  try {
    const res = await window.api.github.prInfo(tab.folder, ref);
    if (!res || !res.ok) {
      tab.els.prReviewsList.textContent = `(error: ${(res && res.error) || 'unknown'})`;
      tab.els.prCurrent.textContent = '';
      return;
    }
    renderPRReviews(tab, res.pr);
    if (res.pr && res.pr.number != null) {
      tab.prSelectedRef = String(res.pr.number);
      if (tab.els.prReviewsFor) tab.els.prReviewsFor.textContent = `for #${res.pr.number}`;
      highlightSelectedOpenPR(tab);
    }
  } catch (err) {
    tab.els.prReviewsList.textContent = `(error: ${err.message || err})`;
  } finally {
    tab.els.prRefreshBtn.disabled = false;
  }
}

function renderPRReviews(tab, pr) {
  tab.currentPR = pr || null;
  const list = tab.els.prReviewsList;
  list.innerHTML = '';
  if (tab.els.prSendToClaudeBtn) tab.els.prSendToClaudeBtn.disabled = true;
  if (!pr) {
    list.textContent = 'No PR found for the current branch. Fill out the form and click Create PR.';
    tab.els.prCurrent.textContent = '';
    return;
  }

  tab.els.prCurrent.innerHTML = '';
  const link = document.createElement('a');
  link.href = '#';
  link.textContent = `#${pr.number || '?'} ${pr.title || ''}`.trim();
  link.title = pr.url || '';
  link.addEventListener('click', (e) => {
    e.preventDefault();
    if (pr.url && window.api.openExternal) window.api.openExternal(pr.url);
  });
  tab.els.prCurrent.appendChild(link);
  const meta = document.createElement('span');
  const decision = pr.reviewDecision || 'PENDING';
  const state = pr.state || '';
  const draftTag = pr.isDraft ? ' [draft]' : '';
  meta.textContent = ` — ${state}${draftTag} · ${decision}`;
  tab.els.prCurrent.appendChild(meta);

  const reviews = Array.isArray(pr.reviews) ? pr.reviews : [];
  const comments = Array.isArray(pr.comments) ? pr.comments : [];
  const inline = Array.isArray(pr.inlineComments) ? pr.inlineComments : [];

  const items = [
    ...reviews.map((r) => ({
      kind: 'review',
      state: (r.state || '').toUpperCase(),
      author: (r.author && r.author.login) || 'unknown',
      ts: r.submittedAt || null,
      body: r.body || '',
      url: r.url || ''
    })),
    ...comments.map((c) => ({
      kind: 'comment',
      state: 'COMMENT',
      author: (c.author && c.author.login) || 'unknown',
      ts: c.createdAt || null,
      body: c.body || '',
      url: c.url || ''
    })),
    ...inline.map((c) => ({
      kind: 'inline',
      state: 'INLINE',
      author: (c.author && c.author.login) || 'unknown',
      ts: c.createdAt || null,
      body: c.body || '',
      url: c.url || '',
      path: c.path || '',
      line: c.line != null ? c.line : null,
      side: c.side || null
    }))
  ];

  if (!items.length) {
    list.textContent = 'No reviews or comments yet.';
    return;
  }

  if (tab.els.prSendToClaudeBtn) {
    const hasBody = items.some((it) => it.body && it.body.trim());
    tab.els.prSendToClaudeBtn.disabled = !hasBody;
  }

  // newest first
  items.sort((a, b) => {
    const ta = a.ts ? Date.parse(a.ts) : 0;
    const tb = b.ts ? Date.parse(b.ts) : 0;
    return tb - ta;
  });

  for (const r of items) {
    const item = document.createElement('div');
    item.className = 'pr-review pr-review-' + r.kind;

    const head = document.createElement('div');
    head.className = 'pr-review-head';
    const stateEl = document.createElement('span');
    stateEl.className = 'pr-review-state ' + r.state.toLowerCase().replace(/[^a-z]/g, '_');
    stateEl.textContent = r.state || (r.kind === 'comment' ? 'COMMENT' : 'REVIEW');
    head.appendChild(stateEl);

    const author = document.createElement('span');
    author.className = 'pr-review-author';
    author.textContent = r.author;
    head.appendChild(author);

    if (r.kind === 'inline' && r.path) {
      const loc = document.createElement('span');
      loc.className = 'pr-review-loc';
      loc.textContent = r.line != null ? `${r.path}:${r.line}` : r.path;
      head.appendChild(loc);
    }

    if (r.ts) {
      const ts = document.createElement('span');
      ts.className = 'pr-review-ts';
      ts.textContent = formatPRTime(r.ts);
      head.appendChild(ts);
    }

    const hasBody = !!(r.body && r.body.trim());
    if (hasBody) {
      const link = document.createElement('a');
      link.href = '#';
      link.className = 'pr-review-link';
      link.textContent = 'add';
      link.title = 'Add this feedback to the Claude prompt queue so it fixes the issue';
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const text = buildSingleReviewPrompt(tab.currentPR, r);
        if (text) openQueueEditor(tab, text);
      });
      head.appendChild(link);
    }

    item.appendChild(head);

    if (r.body && r.body.trim()) {
      const body = document.createElement('div');
      body.className = 'pr-review-body';
      body.textContent = r.body;
      item.appendChild(body);
    }
    list.appendChild(item);
  }
}

function formatPRTime(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch (_) {
    return iso;
  }
}

async function openActionPanel(tab) {
  if (!tab.folder) return;
  tab.els.commitPanel.classList.add('hidden');
  tab.els.publishPanel.classList.add('hidden');
  if (tab.els.prPanel) tab.els.prPanel.classList.add('hidden');
  tab.els.actionPanel.classList.remove('hidden');
  tab.els.actionLog.textContent = '';
  tab.els.actionInputsInput.value = '';
  tab.els.actionInputsFields.innerHTML = '';
  tab.els.actionInputsFallback.classList.add('hidden');
  tab.els.actionInputsHint.textContent = '';

  await loadActionBranches(tab);

  tab.els.actionGhStatus.textContent = 'checking gh…';
  tab.els.actionGhStatus.className = 'actionGhStatus gh-status';
  try {
    const res = await window.api.github.checkGh();
    if (!res.installed) {
      tab.els.actionGhStatus.textContent = 'gh CLI not found';
      tab.els.actionGhStatus.classList.add('bad');
    } else if (!res.authed) {
      tab.els.actionGhStatus.textContent = 'gh not authenticated — run: gh auth login';
      tab.els.actionGhStatus.classList.add('bad');
    } else {
      tab.els.actionGhStatus.textContent = res.user ? `gh ✓ (${res.user})` : 'gh ✓';
      tab.els.actionGhStatus.classList.add('good');
    }
  } catch (_) {
    tab.els.actionGhStatus.textContent = 'gh check failed';
    tab.els.actionGhStatus.classList.add('bad');
  }

  await loadActionWorkflows(tab);
}

async function loadActionWorkflows(tab) {
  const select = tab.els.actionWorkflowSelect;
  select.innerHTML = '<option value="">(loading…)</option>';
  tab.actionWorkflows = [];
  tab.els.actionInputsFields.innerHTML = '';
  tab.els.actionInputsFallback.classList.add('hidden');
  tab.els.actionInputsHint.textContent = '';
  const res = await window.api.github.listWorkflows(tab.folder);
  select.innerHTML = '';
  if (!res || !res.ok) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = `(error: ${(res && res.error) || 'unknown'})`;
    select.appendChild(opt);
    return;
  }
  const workflows = Array.isArray(res.workflows) ? res.workflows : [];
  tab.actionWorkflows = workflows;
  if (!workflows.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(no workflows found)';
    select.appendChild(opt);
    return;
  }
  for (const wf of workflows) {
    const opt = document.createElement('option');
    opt.value = String(wf.id);
    const statePart = wf.state && wf.state !== 'active' ? ` [${wf.state}]` : '';
    opt.textContent = `${wf.name}${statePart}  —  ${wf.path || ''}`.trim();
    select.appendChild(opt);
  }
  await loadSelectedWorkflowInputs(tab);
}

async function loadActionBranches(tab) {
  const select = tab.els.actionRefSelect;
  if (!select) return;
  select.innerHTML = '<option value="">(loading…)</option>';
  if (tab.els.actionRefHint) tab.els.actionRefHint.textContent = '';
  const res = await window.api.git.listBranches(tab.folder).catch(() => null);
  select.innerHTML = '';
  const branches = (res && res.ok && Array.isArray(res.branches)) ? res.branches.slice() : [];
  const current = (res && res.ok && res.current) ? res.current : '';
  if (!branches.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(no branches)';
    select.appendChild(opt);
    if (tab.els.actionRefHint) tab.els.actionRefHint.textContent = '';
    return;
  }
  for (const name of branches) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name === current ? `${name} (current)` : name;
    select.appendChild(opt);
  }
  if (current && branches.includes(current)) select.value = current;
  await resolveActionRefFromPR(tab, current);
}

async function resolveActionRefFromPR(tab, currentBranchHint) {
  const select = tab.els.actionRefSelect;
  if (!select) return;
  let currentBranch = currentBranchHint || '';
  if (!currentBranch) {
    const info = await window.api.git.repoInfo(tab.folder).catch(() => null);
    currentBranch = (info && info.branch) ? info.branch : '';
  }
  if (currentBranch && Array.from(select.options).some((o) => o.value === currentBranch)) {
    select.value = currentBranch;
  }
  let hint = currentBranch ? `current · ${currentBranch}` : 'no branch';
  try {
    const pr = await window.api.github.prInfo(tab.folder, currentBranch || undefined);
    if (pr && pr.ok && pr.pr && pr.pr.headRefName) {
      const prBranch = pr.pr.headRefName;
      if (!Array.from(select.options).some((o) => o.value === prBranch)) {
        const opt = document.createElement('option');
        opt.value = prBranch;
        opt.textContent = `${prBranch} (PR head)`;
        select.appendChild(opt);
      }
      select.value = prBranch;
      hint = `PR #${pr.pr.number} · ${prBranch}`;
    } else if (currentBranch) {
      hint = `current · ${currentBranch} (no PR found)`;
    }
  } catch (_) {
    // fall through to current branch
  }
  if (tab.els.actionRefHint) tab.els.actionRefHint.textContent = hint;
}

async function loadSelectedWorkflowInputs(tab) {
  const id = tab.els.actionWorkflowSelect.value;
  const fields = tab.els.actionInputsFields;
  const fallback = tab.els.actionInputsFallback;
  const hint = tab.els.actionInputsHint;
  fields.innerHTML = '';
  fallback.classList.add('hidden');
  tab.els.actionInputsInput.value = '';
  if (!id) { hint.textContent = ''; return; }
  const wf = (tab.actionWorkflows || []).find((w) => String(w.id) === String(id));
  if (!wf || !wf.path) {
    hint.textContent = '(workflow path unknown)';
    fallback.classList.remove('hidden');
    return;
  }
  hint.textContent = 'loading…';
  const res = await window.api.github.workflowInputs(tab.folder, wf.path).catch((e) => ({ ok: false, error: e.message }));
  if (!res || !res.ok) {
    hint.textContent = `(failed to read inputs: ${(res && res.error) || 'unknown'})`;
    fallback.classList.remove('hidden');
    return;
  }
  const inputs = Array.isArray(res.inputs) ? res.inputs : [];
  if (!inputs.length) {
    hint.textContent = res.note || 'no workflow_dispatch inputs declared';
    fallback.classList.remove('hidden');
    return;
  }
  hint.textContent = `${inputs.length} input${inputs.length === 1 ? '' : 's'}`;
  for (const input of inputs) renderActionInputField(fields, input);
}

function renderActionInputField(container, input) {
  const row = document.createElement('div');
  row.className = 'git-form-row action-input-row';
  row.dataset.key = input.name;

  const label = document.createElement('label');
  label.className = 'git-form-label action-input-label';
  label.textContent = input.name + (input.required ? ' *' : '');
  if (input.description) label.title = input.description;
  row.appendChild(label);

  const type = (input.type || 'string').toLowerCase();
  let control;
  if (type === 'boolean') {
    control = document.createElement('select');
    control.className = 'git-input action-input-control';
    for (const v of ['false', 'true']) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      control.appendChild(opt);
    }
    control.value = String(input.default).toLowerCase() === 'true' ? 'true' : 'false';
  } else if (type === 'choice' && Array.isArray(input.options) && input.options.length) {
    control = document.createElement('select');
    control.className = 'git-input action-input-control';
    for (const o of input.options) {
      const opt = document.createElement('option');
      opt.value = o;
      opt.textContent = o;
      control.appendChild(opt);
    }
    if (input.default != null && input.options.includes(String(input.default))) {
      control.value = String(input.default);
    }
  } else {
    control = document.createElement('input');
    control.type = 'text';
    control.className = 'git-input action-input-control';
    if (input.default != null) control.value = String(input.default);
    if (input.description) control.placeholder = input.description;
  }
  control.dataset.key = input.name;
  row.appendChild(control);

  if (input.description) {
    const desc = document.createElement('span');
    desc.className = 'action-input-desc pane-subtitle';
    desc.textContent = input.description;
    row.appendChild(desc);
  }
  container.appendChild(row);
}

function collectActionInputs(tab) {
  const out = [];
  const rows = tab.els.actionInputsFields.querySelectorAll('.action-input-row');
  if (rows.length) {
    for (const row of rows) {
      const control = row.querySelector('.action-input-control');
      if (!control) continue;
      const key = control.dataset.key;
      if (!key) continue;
      out.push({ key, value: control.value });
    }
    return out;
  }
  return parseFallbackInputs(tab.els.actionInputsInput.value);
}

function parseFallbackInputs(text) {
  const out = [];
  for (const raw of (text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!key) continue;
    out.push({ key, value });
  }
  return out;
}

async function runActionWorkflow(tab) {
  if (!tab.folder) return;
  const workflow = tab.els.actionWorkflowSelect.value;
  const ref = (tab.els.actionRefSelect && tab.els.actionRefSelect.value || '').trim();
  if (!workflow) {
    tab.els.actionLog.textContent = '✗ Pick a workflow first.';
    return;
  }
  if (!ref) {
    tab.els.actionLog.textContent = '✗ Pick a branch first.';
    return;
  }
  const inputs = collectActionInputs(tab);
  const opId = 'op-' + crypto.randomUUID().slice(0, 8);
  gitOpLogs.set(opId, { target: tab.els.actionLog });
  tab.els.actionLog.textContent = '';
  tab.els.actionRunBtn.disabled = true;
  tab.els.actionCancelBtn.disabled = true;
  tab.els.actionOpenRunBtn.classList.add('hidden');
  tab.els.actionOpenRunBtn.dataset.url = '';
  try {
    const res = await window.api.github.runWorkflow({
      id: opId,
      cwd: tab.folder,
      workflow,
      ref,
      inputs
    });
    const url = res && res.ok && res.run && res.run.url;
    if (url) {
      tab.els.actionOpenRunBtn.dataset.url = url;
      tab.els.actionOpenRunBtn.classList.remove('hidden');
    }
  } catch (err) {
    appendGitOpLog(tab, opId, `✗ ${err.message || err}`);
  } finally {
    gitOpLogs.delete(opId);
    tab.els.actionRunBtn.disabled = false;
    tab.els.actionCancelBtn.disabled = false;
  }
}

// ───────────────────────────────────────────────────────── secrets (.env)

// Modal prompt for a single secret value. Resolves to the entered string, or
// null if cancelled.
function promptSecret(opts) {
  opts = opts || {};
  const modal = document.getElementById('secretModal');
  if (!modal) return Promise.resolve(null);
  const titleEl = modal.querySelector('.secret-modal-title');
  const descEl = modal.querySelector('.secret-modal-desc');
  const input = modal.querySelector('.secret-modal-input');
  const errEl = modal.querySelector('.secret-modal-error');
  const cancelBtn = modal.querySelector('.secret-modal-cancel');
  const saveBtn = modal.querySelector('.secret-modal-save');

  titleEl.textContent = opts.title || 'Enter value';
  descEl.textContent = opts.description || '';
  descEl.classList.toggle('hidden', !opts.description);
  input.type = opts.password ? 'password' : 'text';
  input.placeholder = opts.placeholder || '';
  input.value = opts.defaultValue || '';
  errEl.textContent = '';
  modal.classList.remove('hidden');
  input.focus();
  input.select();

  return new Promise((resolve) => {
    let done = false;
    const cleanup = () => {
      modal.classList.add('hidden');
      saveBtn.removeEventListener('click', onSave);
      cancelBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
    };
    const finish = (val) => { if (done) return; done = true; cleanup(); resolve(val); };
    const onSave = () => {
      const v = input.value.trim();
      if (!v) { errEl.textContent = 'A value is required.'; return; }
      finish(v);
    };
    const onCancel = () => finish(null);
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); onSave(); }
      else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };
    saveBtn.addEventListener('click', onSave);
    cancelBtn.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
  });
}

// Return the value of an env key, prompting for it (and saving to .env) when it
// is not set yet. Resolves to null if the user cancels.
async function ensureSecret(opts) {
  try {
    const cur = await window.api.env.get(opts.key);
    if (cur && cur.ok && cur.value && cur.value.trim()) return cur.value.trim();
  } catch (e) {
    console.error('[env.get]', e);
  }
  const val = await promptSecret(opts);
  if (val == null) return null;
  const trimmed = val.trim();
  if (!trimmed) return null;
  const res = await window.api.env.set(opts.key, trimmed);
  if (!res || !res.ok) {
    alert('Failed to save to .env: ' + ((res && res.error) || 'unknown error'));
    return null;
  }
  return trimmed;
}

// ───────────────────────────────────────────────────────── aws

// Render one button per discovered AWS account into the tab's toolbar. Clicking
// a button signs into that account and writes the token to the chosen profile.
// Tracks which tab currently has its AWS-environment popup open so the
// document-level click handler can close it when clicking elsewhere.
let openAwsEnvTab = null;

function closeAwsEnvPopup() {
  if (!openAwsEnvTab) return;
  const tab = openAwsEnvTab;
  openAwsEnvTab = null;
  if (tab.els.awsEnvPopup) tab.els.awsEnvPopup.classList.add('hidden');
  if (tab.els.awsEnvBtn) tab.els.awsEnvBtn.classList.remove('open');
  document.removeEventListener('click', closeAwsEnvPopup, true);
  window.removeEventListener('blur', closeAwsEnvPopup);
}

function toggleAwsEnvPopup(tab) {
  const wasOpenHere = openAwsEnvTab === tab;
  closeAwsEnvPopup();
  if (wasOpenHere) return;
  openAwsEnvTab = tab;
  tab.els.awsEnvPopup.classList.remove('hidden');
  tab.els.awsEnvBtn.classList.add('open');
  // Defer so the click that opened the popup doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener('click', closeAwsEnvPopup, true);
    window.addEventListener('blur', closeAwsEnvPopup);
  }, 0);
}

function renderEnvButtons(tab) {
  const host = tab.els.envBtns;
  if (!host) return;
  host.innerHTML = '';
  if (!awsEnvironments.length) {
    const hint = document.createElement('span');
    hint.className = 'env-empty-hint';
    hint.textContent = 'Click “AWS environments” to list your accounts';
    host.appendChild(hint);
  } else {
    for (const acc of awsEnvironments) {
      const btn = document.createElement('button');
      btn.className = 'env-btn';
      btn.dataset.accountId = acc.accountId;
      btn.textContent = acc.accountName || acc.accountId;
      const emailPart = acc.emailAddress ? ` · ${acc.emailAddress}` : '';
      btn.title = `${acc.accountName || acc.accountId} (${acc.accountId})${emailPart}`;
      btn.addEventListener('click', () => {
        closeAwsEnvPopup();
        doLogin(tab, acc);
      });
      host.appendChild(btn);
    }
  }
  renderStatusOnTab(tab, latestAwsStatus);
}

function renderEnvButtonsForAllTabs() {
  for (const t of TABS.values()) renderEnvButtons(t);
}

function renderStatusOnTab(tab, status) {
  if (tab.els.envBtns) {
    for (const b of tab.els.envBtns.querySelectorAll('.env-btn')) b.classList.remove('active');
  }
  tab.els.statusChip.classList.remove('active');
  if (!status || !status.active) {
    tab.els.statusChip.textContent = 'No AWS environment';
    return;
  }
  const rolePart = status.role ? ` (${status.role})` : '';
  const profilePart = status.profile ? ` → ${status.profile}` : '';
  if (status.accountId && tab.els.envBtns) {
    const btn = tab.els.envBtns.querySelector(`.env-btn[data-account-id="${status.accountId}"]`);
    if (btn) btn.classList.add('active');
  }
  tab.els.statusChip.classList.add('active');
  tab.els.statusChip.textContent = `${status.active}${rolePart}${profilePart} · exp ${fmtExpiry(status.expiration)}`;
}

function renderStatusForAllTabs(status) {
  latestAwsStatus = status;
  for (const t of TABS.values()) renderStatusOnTab(t, status);
}

// Populate the profile dropdown from ~/.aws/credentials, preserving the current
// selection where possible.
async function loadProfilesOnTab(tab) {
  const sel = tab.els.profileSelect;
  if (!sel) return;
  const previous = sel.value || 'default';
  let profiles = ['default'];
  try {
    const res = await window.api.aws.listProfiles();
    if (res && res.ok && Array.isArray(res.profiles) && res.profiles.length) {
      profiles = res.profiles;
    }
  } catch (e) {
    console.error('[aws.listProfiles]', e);
  }
  sel.innerHTML = '';
  for (const name of profiles) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  }
  sel.value = profiles.includes(previous) ? previous : 'default';
}

function hideRolePicker(tab) {
  tab.els.rolePicker.classList.add('hidden');
  tab.els.rolePickerList.innerHTML = '';
  tab.els.rolePickerEnv.textContent = '';
  tab._pendingRolePick = null;
}

function showRolePicker(tab, env, roles) {
  tab.els.rolePickerEnv.textContent = env;
  tab.els.rolePickerList.innerHTML = '';
  if (!roles.length) {
    const msg = document.createElement('div');
    msg.className = 'role-picker-empty';
    msg.textContent = `No roles available for ${env}. Check your SSO permissions.`;
    tab.els.rolePickerList.appendChild(msg);
  } else {
    for (const role of roles) {
      const btn = document.createElement('button');
      btn.className = 'role-btn';
      btn.textContent = role;
      btn.addEventListener('click', () => {
        if (tab._pendingRolePick) tab._pendingRolePick(role);
      });
      tab.els.rolePickerList.appendChild(btn);
    }
  }
  tab.els.rolePicker.classList.remove('hidden');
}

function pickRole(tab, env, roles) {
  return new Promise((resolve) => {
    tab._pendingRolePick = (role) => {
      tab._pendingRolePick = null;
      hideRolePicker(tab);
      resolve(role);
    };
    const onCancel = () => {
      if (tab._pendingRolePick) {
        tab._pendingRolePick = null;
        hideRolePicker(tab);
        resolve(null);
      }
      tab.els.rolePickerCancel.removeEventListener('click', onCancel);
    };
    tab.els.rolePickerCancel.addEventListener('click', onCancel);
    showRolePicker(tab, env, roles);
  });
}

// Prompt once for (and persist) the AWS SSO start URL so logins can proceed.
function ensureSsoUrl() {
  return ensureSecret({
    key: 'AWS_SSO_START_URL',
    title: 'AWS SSO start URL',
    description: 'Your AWS access portal / SSO login URL. Saved to .env and reused next time.',
    placeholder: 'https://d-xxxxxxxxxx.awsapps.com/start'
  });
}

// Sign in to AWS SSO and discover every account the user can reach, then render
// a button for each. Cached in localStorage so they reappear on next launch.
async function loadEnvironments(tab) {
  const btn = tab.els.envLoadBtn;
  const prevLabel = btn ? btn.textContent : '';
  const target = tab.bash.term;
  const writeLog = (line) => { if (target) target.write(`\x1b[36m${line}\x1b[0m\r\n`); };
  const offLog = window.api.aws.onLog(({ line }) => writeLog(line));
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
  try {
    const ssoUrl = await ensureSsoUrl();
    if (!ssoUrl) {
      writeLog('[claude-cmd-ui] AWS SSO start URL not provided — aborting.');
      return;
    }
    const res = await window.api.aws.listEnvironments();
    if (!res || !res.ok) {
      writeLog(`[claude-cmd-ui] ERROR: ${(res && res.error) || 'failed to list environments'}`);
      return;
    }
    awsEnvironments = Array.isArray(res.accounts) ? res.accounts : [];
    try { localStorage.setItem('aws.environments', JSON.stringify(awsEnvironments)); } catch (_) {}
    renderEnvButtonsForAllTabs();
    if (!awsEnvironments.length) {
      writeLog('[claude-cmd-ui] no accounts returned — check your SSO permissions.');
    }
  } finally {
    offLog();
    if (btn) { btn.disabled = false; btn.textContent = prevLabel || 'List accounts ↻'; }
  }
}

async function doLogin(tab, acc) {
  const buttons = tab.els.envBtns ? Array.from(tab.els.envBtns.querySelectorAll('.env-btn')) : [];
  buttons.forEach((b) => { b.disabled = true; });
  if (tab.els.envLoadBtn) tab.els.envLoadBtn.disabled = true;
  const oldChip = tab.els.statusChip.textContent;
  const label = acc.accountName || acc.accountId;
  const target = tab.bash.term;
  const writeLog = (line) => { if (target) target.write(`\x1b[36m${line}\x1b[0m\r\n`); };
  const offLog = window.api.aws.onLog(({ line }) => writeLog(line));
  try {
    const ssoUrl = await ensureSsoUrl();
    if (!ssoUrl) {
      writeLog('[claude-cmd-ui] AWS SSO start URL not provided — aborting.');
      tab.els.statusChip.textContent = oldChip;
      return;
    }
    let role = tab.chosenRoles[acc.accountId];
    if (!role) {
      tab.els.statusChip.textContent = `${label} · logging in…`;
      const listing = await window.api.aws.listRoles(acc.accountId);
      if (!listing.ok) {
        writeLog(`[claude-cmd-ui] ERROR: ${listing.error}`);
        tab.els.statusChip.textContent = oldChip;
        return;
      }
      tab.els.statusChip.textContent = `${label} · pick role…`;
      role = await pickRole(tab, label, listing.roles || []);
      if (!role) {
        writeLog('[claude-cmd-ui] role selection cancelled');
        tab.els.statusChip.textContent = oldChip;
        return;
      }
      tab.chosenRoles[acc.accountId] = role;
    }
    const targetProfile = (tab.els.profileSelect && tab.els.profileSelect.value) || 'default';
    tab.els.statusChip.textContent = `${label} · applying ${role} → ${targetProfile}…`;
    const applied = await window.api.aws.applyRole(acc.accountId, acc.accountName, role, targetProfile);
    if (!applied.ok) {
      writeLog(`[claude-cmd-ui] ERROR: ${applied.error}`);
      tab.els.statusChip.textContent = oldChip;
      tab.chosenRoles[acc.accountId] = null;
    } else {
      renderStatusForAllTabs(applied.status);
      loadProfilesOnTab(tab);
    }
  } finally {
    offLog();
    buttons.forEach((b) => { b.disabled = false; });
    if (tab.els.envLoadBtn) tab.els.envLoadBtn.disabled = false;
  }
}

// ───────────────────────────────────────────────────────── prompt queue

function renderQueue(tab) {
  const list = tab.els.queueList;
  list.innerHTML = '';
  const n = tab.promptQueue.length;
  tab.els.queueCount.textContent = String(n);
  tab.els.queueToggleBtn.classList.toggle('has-items', n > 0);
  if (tab.els.tabQueueBadge) {
    tab.els.tabQueueBadge.textContent = String(n);
    tab.els.tabQueueBadge.classList.toggle('hidden', n === 0);
  }
  if (!tab.promptQueue.length) {
    const empty = document.createElement('li');
    empty.className = 'queue-empty';
    empty.textContent = 'No prompts queued. Click "+ Queue Prompt" to add one.';
    list.appendChild(empty);
    return;
  }
  tab.promptQueue.forEach((text, i) => {
    const li = document.createElement('li');
    li.className = 'queue-item' + (i === 0 ? ' next' : '');

    const idx = document.createElement('span');
    idx.className = 'queue-item-index';
    idx.textContent = '#' + (i + 1);

    const body = document.createElement('span');
    body.className = 'queue-item-text';
    body.textContent = text;

    const actions = document.createElement('span');
    actions.className = 'queue-item-actions';

    const up = document.createElement('button');
    up.className = 'small-btn';
    up.textContent = '↑';
    up.title = 'Move up';
    up.disabled = i === 0;
    up.addEventListener('click', () => {
      if (i === 0) return;
      const [it] = tab.promptQueue.splice(i, 1);
      tab.promptQueue.splice(i - 1, 0, it);
      renderQueue(tab);
    });

    const down = document.createElement('button');
    down.className = 'small-btn';
    down.textContent = '↓';
    down.title = 'Move down';
    down.disabled = i === tab.promptQueue.length - 1;
    down.addEventListener('click', () => {
      if (i === tab.promptQueue.length - 1) return;
      const [it] = tab.promptQueue.splice(i, 1);
      tab.promptQueue.splice(i + 1, 0, it);
      renderQueue(tab);
    });

    const del = document.createElement('button');
    del.className = 'small-btn';
    del.textContent = '×';
    del.title = 'Remove';
    del.addEventListener('click', () => {
      tab.promptQueue.splice(i, 1);
      renderQueue(tab);
    });

    actions.appendChild(up);
    actions.appendChild(down);
    actions.appendChild(del);
    li.appendChild(idx);
    li.appendChild(body);
    li.appendChild(actions);
    list.appendChild(li);
  });
}

function toggleQueuePanel(tab, force) {
  const panel = tab.els.queuePanel;
  const show = typeof force === 'boolean' ? force : panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !show);
  if (show) {
    tab.els.logsPanel.classList.add('hidden');
    renderQueue(tab);
    requestAnimationFrame(() => fitTab(tab));
  } else {
    requestAnimationFrame(() => fitTab(tab));
  }
}

function openQueueEditor(tab, prefill) {
  toggleQueuePanel(tab, true);
  tab.els.queueEditor.classList.remove('hidden');
  tab.els.queueInput.value = prefill || '';
  tab.els.queueInput.focus();
  if (prefill) {
    tab.els.queueInput.setSelectionRange(prefill.length, prefill.length);
    tab.els.queueInput.scrollTop = 0;
  }
}

function buildPrCommentsPrompt(pr) {
  if (!pr) return '';
  const lines = [];
  const prTag = `PR #${pr.number || '?'}`;
  const title = pr.title ? ` ${pr.title}` : '';
  const branch = pr.headRefName ? ` (branch: ${pr.headRefName})` : '';
  lines.push(`Please address the review feedback on ${prTag}${title}${branch}.`);
  if (pr.url) lines.push(`PR URL: ${pr.url}`);
  lines.push('');

  const reviews = Array.isArray(pr.reviews) ? pr.reviews : [];
  const issueComments = Array.isArray(pr.comments) ? pr.comments : [];
  const inline = Array.isArray(pr.inlineComments) ? pr.inlineComments : [];

  const blocks = [];
  for (const r of reviews) {
    const body = (r.body || '').trim();
    if (!body && !(r.state && r.state !== 'COMMENTED')) continue;
    const author = (r.author && r.author.login) || 'unknown';
    const state = (r.state || 'REVIEW').toUpperCase();
    const ts = r.submittedAt ? ` · ${r.submittedAt}` : '';
    blocks.push(`### [REVIEW ${state}] @${author}${ts}\n${body || '(no body)'}`);
  }
  for (const c of issueComments) {
    const body = (c.body || '').trim();
    if (!body) continue;
    const author = (c.author && c.author.login) || 'unknown';
    const ts = c.createdAt ? ` · ${c.createdAt}` : '';
    blocks.push(`### [COMMENT] @${author}${ts}\n${body}`);
  }
  for (const c of inline) {
    const body = (c.body || '').trim();
    if (!body) continue;
    const author = (c.author && c.author.login) || 'unknown';
    const loc = c.path ? `${c.path}${c.line != null ? `:${c.line}` : ''}` : '(no path)';
    const ts = c.createdAt ? ` · ${c.createdAt}` : '';
    blocks.push(`### [INLINE] @${author} on ${loc}${ts}\n${body}`);
  }
  if (!blocks.length) return '';
  lines.push(...blocks);
  return lines.join('\n\n');
}

function buildSingleReviewPrompt(pr, item) {
  if (!item) return '';
  const body = (item.body || '').trim();
  if (!body) return '';
  const lines = [];
  const prTag = pr && pr.number ? `PR #${pr.number}` : 'this PR';
  const title = pr && pr.title ? ` ${pr.title}` : '';
  const branch = pr && pr.headRefName ? ` (branch: ${pr.headRefName})` : '';
  lines.push(`Please address the following review feedback on ${prTag}${title}${branch} and fix the issue.`);
  if (pr && pr.url) lines.push(`PR URL: ${pr.url}`);
  lines.push('');

  const author = item.author || 'unknown';
  const ts = item.ts ? ` · ${item.ts}` : '';
  if (item.kind === 'inline') {
    const loc = item.path ? `${item.path}${item.line != null ? `:${item.line}` : ''}` : '(no path)';
    lines.push(`### [INLINE] @${author} on ${loc}${ts}`);
  } else if (item.kind === 'comment') {
    lines.push(`### [COMMENT] @${author}${ts}`);
  } else {
    const state = (item.state || 'REVIEW').toUpperCase();
    lines.push(`### [REVIEW ${state}] @${author}${ts}`);
  }
  lines.push(body);
  return lines.join('\n');
}

function sendPrCommentsToClaude(tab) {
  const pr = tab.currentPR;
  if (!pr) {
    alert('No PR loaded — click Refresh reviews first.');
    return;
  }
  const text = buildPrCommentsPrompt(pr);
  if (!text) {
    alert('This PR has no review or comment bodies to send.');
    return;
  }
  openQueueEditor(tab, text);
}

function closeQueueEditor(tab) {
  tab.els.queueEditor.classList.add('hidden');
  tab.els.queueInput.value = '';
}

function saveQueuePrompt(tab) {
  const text = tab.els.queueInput.value.trim();
  if (!text) {
    closeQueueEditor(tab);
    return;
  }
  tab.promptQueue.push(text);
  closeQueueEditor(tab);
  renderQueue(tab);
  if (tab.status === 'finished') tryDispatchNextPrompt(tab);
}

// Read the visible cmd-terminal viewport and decide whether Claude is currently
// paused on a TUI selection/confirmation menu (e.g. "Do you want to proceed?
// ❯ 1. Yes / 2. No"). The idle timer fires whether Claude is waiting for the
// next prompt OR waiting for a Y/N answer, and we must not auto-fire the queue
// in the latter case — submitting text+Enter while a menu is highlighted would
// accept the highlighted option.
function isAwaitingTuiSelection(tab) {
  try {
    const term = tab.cmd && tab.cmd.term;
    if (!term || !term.buffer || !term.buffer.active) return false;
    const buf = term.buffer.active;
    // The active TUI element (input box, confirmation menu, etc.) always sits
    // at the bottom of the viewport. Limit the scan to the last ~18 visible
    // lines so a numbered list scrolled into view above the input doesn't read
    // as a menu.
    const rows = term.rows;
    const span = Math.min(rows, 18);
    const startY = buf.viewportY + Math.max(0, rows - span);
    const lines = [];
    for (let i = 0; i < span; i++) {
      const line = buf.getLine(startY + i);
      if (!line) continue;
      lines.push(line.translateToString(true));
    }
    const tail = lines.join('\n');
    // A selection cursor pointing at a numbered option is the unambiguous
    // Claude Code confirmation pattern (also covers /model, /theme, etc.).
    if (/[❯›]\s*\d+\.\s+\S/.test(tail)) return true;
    // Confirmation prompts always end with the question + a "Yes" option
    // within the same screen region — phrase-matching avoids depending on the
    // exact glyph used for the selection cursor.
    if (/Do you want\b[\s\S]{0,300}\bYes\b/i.test(tail)) return true;
    return false;
  } catch (_) {
    return false;
  }
}

function tryDispatchNextPrompt(tab) {
  if (tab.queueFiring) return;
  if (!tab.promptQueue.length) return;
  if (!tab.cmd.id) return;
  tab.queueFiring = true;
  tab.els.queueToggleBtn.classList.add('firing');
  setTimeout(() => {
    if (tab.status !== 'finished') {
      tab.queueFiring = false;
      tab.els.queueToggleBtn.classList.remove('firing');
      return;
    }
    if (isAwaitingTuiSelection(tab)) {
      // Hold the queue: Claude is paused on a confirmation/selection menu.
      // The user must resolve it manually; once Claude resumes and goes idle
      // again, setTabStatus('finished') will call back into this dispatcher.
      tab.queueFiring = false;
      tab.els.queueToggleBtn.classList.remove('firing');
      return;
    }
    const next = tab.promptQueue.shift();
    if (!next) {
      tab.queueFiring = false;
      tab.els.queueToggleBtn.classList.remove('firing');
      return;
    }
    setTabStatus(tab, 'busy');
    if (tab.idleTimer) { clearTimeout(tab.idleTimer); tab.idleTimer = null; }
    try {
      // Type the prompt, then submit it with Enter as a separate write so the
      // REPL sees a real submit (some interactive TUIs treat a combined
      // "text\r" payload as a paste and keep the buffer open).
      window.api.pty.write(tab.cmd.id, next);
      logPromptEntry(tab, 'queue', next);
      setTimeout(() => {
        if (tab.cmd && tab.cmd.id) {
          try { window.api.pty.write(tab.cmd.id, '\r'); } catch (_) {}
        }
      }, QUEUE_ENTER_DELAY_MS);
    } catch (err) {
      console.error('[queue dispatch]', err);
    }
    renderQueue(tab);
    tab.queueFiring = false;
    tab.els.queueToggleBtn.classList.remove('firing');
  }, QUEUE_SEND_DELAY_MS);
}

// ───────────────────────────────────────────────────────── tasks board

// Canonical six-value status enum, in board left-to-right order (TASK-006).
// Mirrors LANE_STATUSES in lib/ticket-lanes.js for the browser side, which
// cannot require Node modules. `todo` is where new tickets are created;
// `defining` is the BA phase (acceptance criteria + Gherkin) before coding.
const TASKS_LANE_STATUSES = ['todo', 'defining', 'in-progress', 'testing', 'failed-testing', 'done'];
// Statuses that mean an agent is actively working the ticket right now (BA while
// defining, coder while in-progress, tester while testing). Cards in one of
// these states show the per-card blue "being worked on" dot; idle states
// (todo / done / failed-testing) show no active dot. Mirrors ACTIVE_STATUSES in
// lib/ticket-lanes.js.
const TASKS_ACTIVE_STATUSES = ['defining', 'in-progress', 'testing'];
// Status whose tests failed — its card shows a red "failed" marker. Mirrors
// FAILED_STATUS in lib/ticket-lanes.js.
const TASKS_FAILED_STATUS = 'failed-testing';
// Dedicated lane for out-of-enum tickets so an unknown status is rendered
// gracefully instead of being silently dumped into `todo`. Mirrors
// UNKNOWN_STATUS in lib/ticket-lanes.js.
const TASKS_UNKNOWN_STATUS = 'unknown';
const TASKS_POLL_MS = 2500;

// Which task card is currently being dragged, and the status it started in
// (TASK-007). Used to scope intra-lane reordering to `todo`-to-`todo` drags so a
// cross-lane drag still falls through to the lane drop handler (status change).
let draggingTaskFile = null;
let draggingTaskStatus = null;

// Join path parts using the folder's own separator convention (matches the rest
// of the renderer, which assumes Windows backslash paths from the main process).
function tasksJoin(...parts) {
  return parts.reduce((acc, p) => {
    if (!acc) return p;
    const sep = acc.endsWith('\\') || acc.endsWith('/') ? '' : '\\';
    return acc + sep + p;
  });
}

// Parse a ticket file into { fm, body }. Flat "key: value" frontmatter only (no
// nested YAML). Returns null when the file lacks a well-formed --- ... --- block
// so callers can skip/keep-last-good rather than render garbage.
function parseTicketFrontmatter(content) {
  if (typeof content !== 'string') return null;
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0].trim() !== '---') return null;
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { closeIdx = i; break; }
  }
  if (closeIdx === -1) return null;
  const fm = {};
  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (key) fm[key] = line.slice(idx + 1).trim();
  }
  const body = lines.slice(closeIdx + 1).join('\n');
  return { fm, body };
}

// "Waiting for an answer" predicate (TASK-005). Mirrors
// lib/ticket-questions.js's isWaitingForAnswer for the browser side, which cannot
// require Node modules. A ticket is waiting exactly when it carries a non-empty
// `question` frontmatter field and no non-empty `answer` yet. Kept pure and
// derived only from persisted frontmatter so the yellow dot updates within one
// board poll once the answer lands on disk.
function ticketFieldNonEmpty(v) {
  return v != null && String(v).trim() !== '';
}
function isTicketWaitingForAnswer(fm) {
  return !!fm && ticketFieldNonEmpty(fm.question) && !ticketFieldNonEmpty(fm.answer);
}

// Persisted user-defined `todo` ordering (TASK-007). Mirrors
// lib/ticket-queue.js's ticketOrderValue/compareTicketOrder for the browser side,
// which cannot require Node modules (matching how TASK-003/004/005/006 duplicated
// the tiny pure helpers). The chosen order is stored per ticket as a numeric
// `order` frontmatter field, which serializeTicket preserves as an unknown key so
// it survives whole-file writes, board polls, and app restarts.
function ticketOrderValue(fm) {
  if (!fm) return null;
  const raw = fm.order != null ? fm.order : fm.priority;
  if (raw == null || String(raw).trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// Stable, deterministic comparator: prefer the persisted `order`, then fall back
// to numeric `id` so tickets without an explicit order never jump between polls.
function compareTicketOrder(a, b) {
  const oa = ticketOrderValue(a);
  const ob = ticketOrderValue(b);
  if (oa !== null && ob !== null) {
    if (oa !== ob) return oa - ob;
  } else if (oa !== null) {
    return -1;
  } else if (ob !== null) {
    return 1;
  }
  return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
}

// Folder-per-status layout (TASK-008). Mirrors lib/ticket-folders.js for the
// browser side, which cannot require Node modules. Each canonical status owns a
// subfolder under tasks/ named exactly for the status; unknown (out-of-enum)
// statuses own no folder and are left in place.

// Subfolder name (relative to tasks/) a ticket with this status belongs in, or
// null for out-of-enum statuses (left in place, never filed into a status folder).
function ticketFolderForStatus(status) {
  return TASKS_LANE_STATUSES.includes(status) ? status : null;
}

// True when the folder a file currently sits in (relative to tasks/, '' = top
// level) already matches the folder its frontmatter status calls for.
function ticketFolderMatchesStatus(folder, status) {
  const target = ticketFolderForStatus(status);
  return target != null && (folder || '') === target;
}

// Basename of an absolute path, tolerating either path separator (main-process
// paths are Windows backslash by convention).
function tasksBasename(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i === -1 ? s : s.slice(i + 1);
}

// The immediate subfolder (relative to tasksDir) a file sits in, '' when the file
// is at the top level of tasks/. Status folders are exactly one level deep, so
// only the first path segment matters.
function tasksSubfolder(tasksDir, filePath) {
  const base = String(tasksDir || '');
  let rel = String(filePath || '');
  if (rel.toLowerCase().startsWith(base.toLowerCase())) rel = rel.slice(base.length);
  rel = rel.replace(/^[\\/]+/, '');
  const parts = rel.split(/[\\/]+/);
  return parts.length > 1 ? parts[0] : '';
}

// Dedupe discovered tickets by frontmatter id, preferring the copy whose folder
// matches its frontmatter status (mirrors lib/ticket-folders.js dedupeByFolder).
// Keeps the first seen otherwise so a ticket that briefly exists in two folders
// (legacy migration, a collided move) appears exactly once on the board.
function dedupeTicketsByFolder(entries) {
  const byId = new Map();
  for (const e of entries) {
    const id = e.fm.id;
    if (id == null) continue;
    if (!byId.has(id)) { byId.set(id, e); continue; }
    const cur = byId.get(id);
    if (ticketFolderMatchesStatus(e.folder, e.fm.status) &&
        !ticketFolderMatchesStatus(cur.folder, cur.fm.status)) {
      byId.set(id, e);
    }
  }
  return Array.from(byId.values());
}

// Serialize back to disk, preserving the body verbatim and writing frontmatter
// keys in a fixed order (unknown keys kept, appended after the known ones).
function serializeTicket(fm, body) {
  const order = ['id', 'title', 'status', 'created', 'updated'];
  const keys = order.filter((k) => fm[k] != null);
  for (const k of Object.keys(fm)) if (!keys.includes(k)) keys.push(k);
  const fmLines = keys.map((k) => `${k}: ${fm[k]}`);
  return ['---', ...fmLines, '---', body || ''].join('\n');
}

// ── Build accounting (TASK-003) display helpers ────────────────────────────
// Read-only formatters for the per-ticket build time / cost stamped onto the
// frontmatter (startedAt / finishedAt / costUsd / tokens) by the orchestrator.
// These mirror lib/ticket-accounting.js's formatDuration for the browser side,
// which cannot require Node modules. Each returns '' when the value is absent or
// malformed so the UI shows nothing rather than fabricating a figure.

// Compact wall-clock gap between two ISO-8601 stamps, or elapsed to now when
// finishedAt is missing (a still-running build). '' if start is missing/invalid
// or the end precedes the start.
function formatBuildDuration(startedAt, finishedAt) {
  if (!startedAt) return '';
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return '';
  let end;
  if (finishedAt) {
    end = new Date(finishedAt).getTime();
    if (Number.isNaN(end)) return '';
  } else {
    end = Date.now();
  }
  const ms = end - start;
  if (ms < 0) return '';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function formatCostUsd(v) {
  if (v == null || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n === 0) return '$0';
  if (n < 1) return '$' + n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return '$' + n.toFixed(2);
}

function formatTokens(v) {
  if (v == null || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k tok';
  return Math.round(n) + ' tok';
}

// ── Per-run history (TASK-012) display helpers ─────────────────────────────
// Read-only mirror of lib/ticket-runs.js for the browser side, which cannot
// require Node modules (matching how TASK-003/005/007/008 duplicated the tiny
// pure helpers). Each time a ticket is processed the orchestrator appends one run
// entry — { startedAt, finishedAt, minutes, costUsd, at } — to a JSON array kept
// on a single flat `runs` frontmatter field, so a re-run accumulates multiple
// entries. These helpers parse and format that log for display only.

// Parse the `runs` JSON array off a frontmatter object into an array of entries.
// Tolerant: absent / non-string / invalid-JSON / non-array all yield [] so a
// hand-edited or corrupt ticket never throws while rendering.
function parseTicketRuns(fm) {
  const raw = fm ? fm.runs : null;
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.filter((e) => e && typeof e === 'object');
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((e) => e && typeof e === 'object') : [];
  } catch (_) {
    return [];
  }
}

// Compact minutes label for a run, e.g. "12.5 min". '' when absent/malformed.
function formatRunMinutes(v) {
  if (v == null || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return '';
  const shown = Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return `${shown} min`;
}

// Short local date/time label for a run's timestamp. '' when missing/invalid.
function formatRunAt(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

// One display line per run: "<date/time> · <minutes> · <cost>", dropping any
// fragment that is absent. Empty array in => empty array out.
function ticketRunLines(fm) {
  return parseTicketRuns(fm).map((r) => {
    const bits = [];
    const at = formatRunAt(r.at || r.finishedAt || r.startedAt);
    if (at) bits.push(at);
    const mins = formatRunMinutes(r.minutes);
    if (mins) bits.push(mins);
    const cost = formatCostUsd(r.costUsd);
    if (cost) bits.push(cost);
    return bits.join('   ·   ');
  }).filter((line) => line !== '');
}

// Ordered list of accounting fragments present on this ticket's frontmatter.
// Empty when the ticket carries no start/cost/token data yet.
function ticketAccountingParts(fm) {
  const parts = [];
  const dur = formatBuildDuration(fm.startedAt, fm.finishedAt);
  if (dur) parts.push(fm.startedAt && !fm.finishedAt ? dur + '…' : dur);
  const cost = formatCostUsd(fm.costUsd);
  if (cost) parts.push(cost);
  const tok = formatTokens(fm.tokens);
  if (tok) parts.push(tok);
  return parts;
}

// Wipe board state when the tab switches to a different folder, then re-init if
// the Tasks tab is the one currently showing.
function resetTasksForFolder(tab) {
  stopTasksPolling(tab);
  tab.tasks.tickets = new Map();
  tab.tasks.lastSig = '';
  tab.tasks.skillInstalled = null;
  tab.tasks.autoBuild = false;
  for (const laneEl of tab.els.tasksLanes) {
    const cards = laneEl.querySelector('.tasks-lane-cards');
    if (cards) cards.innerHTML = '';
    const countEl = laneEl.querySelector('.tasks-lane-count');
    if (countEl) countEl.textContent = '0';
  }
  tab.els.tasksStatus.textContent = '';
  tab.els.tasksEmpty.classList.add('hidden');
  tab.els.tasksSkillBanner.classList.add('hidden');
  tab.els.tasksNewBtn.disabled = true;
  updateBuildBtn(tab);
  // Populate + restore the parallel-build dropdown from this folder's stored
  // value (or the default). Runs on every folder (re)open so each folder shows
  // its own persisted concurrency; a corrupt/missing entry falls back to 3.
  initTasksConcurrency(tab);
  if (tab.activeSubTab === 'tasks') initTasksTab(tab);
}

function initTasksTab(tab) {
  if (!tab.folder) {
    tab.els.tasksStatus.textContent = '(open a folder)';
    tab.els.tasksEmpty.classList.add('hidden');
    tab.els.tasksSkillBanner.classList.add('hidden');
    tab.els.tasksNewBtn.disabled = true;
    updateBuildBtn(tab);
    return;
  }
  tab.els.tasksNewBtn.disabled = false;
  checkOrchestrateSkill(tab);
  startTasksPolling(tab);
}

async function checkOrchestrateSkill(tab) {
  if (!tab.folder) return false;
  const skillPath = tasksJoin(tab.folder, '.claude', 'skills', 'orchestrate', 'SKILL.md');
  let installed = false;
  try {
    const res = await window.api.fs.exists(skillPath);
    installed = !!(res && res.ok && res.exists);
  } catch (err) {
    console.error('[tasks skill check]', err);
  }
  tab.tasks.skillInstalled = installed;
  tab.els.tasksSkillBanner.classList.toggle('hidden', installed);
  updateBuildBtn(tab);
  return installed;
}

function startTasksPolling(tab) {
  const t = tab.tasks;
  if (t.pollTimer) return;
  pollTasksOnce(tab, true);
  t.pollTimer = setInterval(() => pollTasksOnce(tab), TASKS_POLL_MS);
}

function stopTasksPolling(tab) {
  const t = tab.tasks;
  if (t && t.pollTimer) { clearInterval(t.pollTimer); t.pollTimer = null; }
}

async function pollTasksOnce(tab, force) {
  const t = tab.tasks;
  if (!tab.folder || t.fetching) return;
  // Skip quiet ticks when the board isn't the thing being looked at; a manual
  // refresh or an internal call passes force to bypass this.
  if (!force) {
    if (tab.activeSubTab !== 'tasks') return;
    if (!tab.els.ws.classList.contains('active')) return;
    if (document.hidden) return;
  }
  t.fetching = true;
  let toReconcile = null;
  try {
    const tasksDir = tasksJoin(tab.folder, 'tasks');
    // Discover tickets recursively across tasks/ and its per-status subfolders
    // (TASK-008) via the existing recursive fs:findByExt IPC, so a ticket filed
    // into tasks/<status>/ still appears on the board.
    const res = await window.api.fs.findByExt(tasksDir, '.md');
    if (!res || !res.ok) {
      t.tickets = new Map();
      if (force || t.lastSig !== '') { t.lastSig = ''; renderTasksBoard(tab); }
      return;
    }
    // Reuse the last good parse for a given path so a ticket the agent is mid-
    // rewrite doesn't flicker out and back.
    const prevByPath = new Map();
    for (const tk of t.tickets.values()) prevByPath.set(tk.path, tk);
    const candidates = [];
    for (const filePath of res.files) {
      const name = tasksBasename(filePath);
      const folder = tasksSubfolder(tasksDir, filePath);
      const fr = await window.api.fs.readFile(filePath);
      let entry = null;
      if (fr && fr.ok && !fr.binary) {
        const parsed = parseTicketFrontmatter(fr.content);
        if (parsed && parsed.fm.id) {
          entry = { file: name, path: filePath, folder, fm: parsed.fm, body: parsed.body, raw: fr.content };
        }
      }
      if (!entry) {
        const prev = prevByPath.get(filePath);
        if (prev) entry = prev;
      }
      if (entry) candidates.push(entry);
    }
    // Dedupe by ticket id, preferring the copy whose folder matches frontmatter
    // status, so a ticket that momentarily lives in two folders shows once.
    const deduped = dedupeTicketsByFolder(candidates);
    const next = new Map();
    for (const tk of deduped) next.set(tk.file, tk);
    t.tickets = next;
    const sig = Array.from(next.values())
      .map((tk) => `${tk.fm.id}|${tk.fm.status}|${tk.fm.updated}`)
      .sort()
      .join('~');
    if (force || sig !== t.lastSig) {
      t.lastSig = sig;
      renderTasksBoard(tab);
    }
    toReconcile = deduped;
  } catch (err) {
    console.error('[tasks poll]', err);
  } finally {
    t.fetching = false;
  }
  // Frontmatter is authoritative: after the scan reconciles any file whose folder
  // disagrees with its status by moving it to the matching folder. Runs after
  // fetching is cleared so its follow-up poll isn't skipped by the in-flight guard.
  if (toReconcile) reconcileTicketFolders(tab, toReconcile);
}

// Move a ticket .md file into the subfolder matching `status`, creating the
// destination folder on demand. A single atomic fs:rename per the board contract,
// so a concurrent poll never sees the file in two folders or missing. Unknown
// (out-of-enum) statuses own no folder and are left in place. Returns
// { ok, moved, path } — path is the file's location afterwards. On a
// destination-name collision (fs:rename refuses when the target exists) nothing is
// overwritten and the source is left untouched; the poll dedupe then shows the
// copy already in the correct folder, so no data is lost.
async function relocateTicketFile(tab, srcPath, fileName, status) {
  const targetFolder = ticketFolderForStatus(status);
  if (targetFolder == null) return { ok: true, moved: false, path: srcPath };
  const tasksDir = tasksJoin(tab.folder, 'tasks');
  const destDir = tasksJoin(tasksDir, targetFolder);
  const destPath = tasksJoin(destDir, fileName);
  if (destPath === srcPath) return { ok: true, moved: false, path: srcPath };
  await window.api.fs.mkdir(destDir);
  const rn = await window.api.fs.rename(srcPath, destPath);
  if (rn && rn.ok) return { ok: true, moved: true, path: destPath };
  console.warn('[tasks relocate]', fileName, '->', targetFolder, (rn && rn.error) || 'failed');
  return { ok: false, moved: false, path: srcPath, error: rn && rn.error };
}

// Reconcile on-disk folders to frontmatter status: for each ticket whose folder
// disagrees with its status, move the file into the matching folder. Guarded so
// overlapping polls don't stack moves, and re-polls once after any successful move
// so the board reflects the new locations.
async function reconcileTicketFolders(tab, entries) {
  const t = tab.tasks;
  if (t.reconciling) return;
  const stale = entries.filter((e) => {
    const target = ticketFolderForStatus(e.fm.status);
    return target != null && (e.folder || '') !== target;
  });
  if (!stale.length) return;
  t.reconciling = true;
  let moved = false;
  try {
    for (const e of stale) {
      const r = await relocateTicketFile(tab, e.path, e.file, e.fm.status);
      if (r && r.moved) moved = true;
    }
  } finally {
    t.reconciling = false;
  }
  if (moved) pollTasksOnce(tab, true);
}

function renderTasksBoard(tab) {
  const t = tab.tasks;
  const lanes = {};
  for (const laneEl of tab.els.tasksLanes) {
    const cards = laneEl.querySelector('.tasks-lane-cards');
    cards.innerHTML = '';
    lanes[laneEl.dataset.status] = { el: laneEl, cards, count: 0 };
  }
  // Sort by numeric `id` across the board, but honour the user-defined order
  // within the `todo` lane (TASK-007): two todo tickets are compared by their
  // persisted `order` (falling back to id), while every other pairing stays in id
  // order. Because routing to lanes preserves this relative order, the todo lane
  // renders in the chosen order and other lanes stay id-sorted.
  const tickets = Array.from(t.tickets.values()).sort((a, b) => {
    if (a.fm.status === 'todo' && b.fm.status === 'todo') {
      return compareTicketOrder(a.fm, b.fm);
    }
    return String(a.fm.id).localeCompare(String(b.fm.id), undefined, { numeric: true });
  });
  for (const tk of tickets) {
    // Route to a lane. Known statuses go to their own lane; anything outside the
    // six-value enum is treated as unknown and routed to the dedicated `unknown`
    // lane (a clearly-marked card) rather than being silently dumped into `todo`.
    // If the unknown lane is somehow absent from the DOM, fall back to `todo` so
    // the board never crashes on bad data.
    const unknown = !TASKS_LANE_STATUSES.includes(tk.fm.status);
    let laneKey = unknown ? TASKS_UNKNOWN_STATUS : tk.fm.status;
    if (!lanes[laneKey]) laneKey = 'todo';
    const lane = lanes[laneKey];
    const card = document.createElement('div');
    card.className = 'task-card' + (unknown ? ' unknown-status' : '');
    card.title = unknown ? `Unknown status: ${tk.fm.status}` : (tk.fm.title || '');
    card.draggable = true;
    card.dataset.file = tk.file;
    card.dataset.status = tk.fm.status;
    card.addEventListener('dragstart', (e) => {
      card.classList.add('dragging');
      draggingTaskFile = tk.file;
      draggingTaskStatus = tk.fm.status;
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', tk.file);
      }
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      draggingTaskFile = null;
      draggingTaskStatus = null;
      clearTaskDropMarkers(tab);
    });
    // Intra-`todo` reordering (TASK-007): while dragging one todo card over
    // another todo card, mark an above/below insertion point and, on drop,
    // persist the new order. Cross-lane drags fall through to the lane drop
    // handler, which still changes status as before.
    if (tk.fm.status === 'todo') {
      card.addEventListener('dragover', (e) => {
        if (draggingTaskStatus !== 'todo' || draggingTaskFile === tk.file) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        const rect = card.getBoundingClientRect();
        const before = (e.clientY - rect.top) < rect.height / 2;
        clearTaskDropMarkers(tab);
        card.classList.add(before ? 'task-card-drop-before' : 'task-card-drop-after');
      });
      card.addEventListener('dragleave', () => {
        card.classList.remove('task-card-drop-before', 'task-card-drop-after');
      });
      card.addEventListener('drop', (e) => {
        if (draggingTaskStatus !== 'todo' || draggingTaskFile === tk.file) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = card.getBoundingClientRect();
        const before = (e.clientY - rect.top) < rect.height / 2;
        const dragged = draggingTaskFile;
        clearTaskDropMarkers(tab);
        if (dragged) reorderTodoTicket(tab, dragged, tk.file, before);
      });
    }
    const idEl = document.createElement('div');
    idEl.className = 'task-card-id';
    idEl.textContent = tk.fm.id;
    const titleEl = document.createElement('div');
    titleEl.className = 'task-card-title';
    titleEl.textContent = tk.fm.title || '(untitled)';
    card.appendChild(idEl);
    card.appendChild(titleEl);
    // "Being worked on" indicator: shown while an agent is actively working the
    // ticket, or while the ticket is waiting for the user's answer. Derived
    // purely from persisted frontmatter (status + question/answer), so it appears,
    // turns yellow, and clears on the normal poll cycle as the file changes on
    // disk. Waiting (question with no answer) paints the dot yellow, mirroring the
    // status-waiting tab convention, distinct from the blue actively-worked dot.
    // Dot precedence: waiting-for-answer (yellow, TASK-005) wins so the user's
    // attention isn't lost; then failed tests (red, TASK-006); then actively
    // worked (blue). Idle non-failed states show no dot.
    const waitingForAnswer = isTicketWaitingForAnswer(tk.fm);
    const failed = tk.fm.status === TASKS_FAILED_STATUS;
    const active = TASKS_ACTIVE_STATUSES.includes(tk.fm.status);
    if (waitingForAnswer || failed || active) {
      const dot = document.createElement('span');
      dot.className = 'task-card-dot' + (waitingForAnswer ? ' waiting' : (failed ? ' failed' : ''));
      dot.title = waitingForAnswer ? 'Waiting for your answer' : (failed ? 'Tests failed' : 'Being worked on');
      card.appendChild(dot);
    }
    // Build accounting (TASK-003): unobtrusive time/cost line, shown only when
    // the orchestrator has stamped start/cost/token data. Absent otherwise so
    // nothing is fabricated. Independent of the working-indicator dot above.
    const acctParts = ticketAccountingParts(tk.fm);
    if (acctParts.length) {
      const metaEl = document.createElement('div');
      metaEl.className = 'task-card-meta';
      metaEl.textContent = acctParts.join(' · ');
      card.appendChild(metaEl);
    }
    card.addEventListener('click', () => openTaskModal(tab, tk));
    lane.cards.appendChild(card);
    lane.count++;
  }
  for (const status of Object.keys(lanes)) {
    const countEl = lanes[status].el.querySelector('.tasks-lane-count');
    if (countEl) countEl.textContent = String(lanes[status].count);
  }
  // The unknown lane only appears when it actually holds an out-of-enum ticket,
  // so the board isn't cluttered with an always-empty lane in the normal case.
  const unknownLane = lanes[TASKS_UNKNOWN_STATUS];
  if (unknownLane) unknownLane.el.classList.toggle('hidden', unknownLane.count === 0);
  const total = tickets.length;
  const showEmpty = total === 0 && t.skillInstalled !== false;
  tab.els.tasksEmpty.classList.toggle('hidden', !showEmpty);
  const polling = t.pollTimer ? ' · polling' : '';
  tab.els.tasksStatus.textContent = total ? `${total} ticket${total === 1 ? '' : 's'}${polling}` : '';
  updateBuildBtn(tab);
  maybeContinueBuild(tab);
}

// Ticket detail/edit modal. Loads the freshest copy from disk, lets the user
// edit title/status/body, and guards against clobbering a concurrent agent write.
function openTaskModal(tab, ticket) {
  const modal = document.getElementById('taskModal');
  if (!modal) return;
  const idEl = modal.querySelector('.task-modal-id');
  const titleInput = modal.querySelector('.task-modal-title');
  const statusSel = modal.querySelector('.task-modal-status');
  const pathEl = modal.querySelector('.task-modal-path');
  const acctEl = modal.querySelector('.task-modal-accounting');
  const runsEl = modal.querySelector('.task-modal-runs');
  const questionEl = modal.querySelector('.task-modal-question');
  const questionTextEl = modal.querySelector('.task-modal-question-text');
  const answerInput = modal.querySelector('.task-modal-answer-input');
  const bodyArea = modal.querySelector('.task-modal-body');
  const errEl = modal.querySelector('.task-modal-error');
  const cancelBtn = modal.querySelector('.task-modal-cancel');
  const saveBtn = modal.querySelector('.task-modal-save');

  const ticketPath = ticket.path;
  let fm = Object.assign({}, ticket.fm);
  let openRaw = ticket.raw;

  const fill = (fmObj, body) => {
    idEl.textContent = fmObj.id || '';
    titleInput.value = fmObj.title || '';
    statusSel.value = TASKS_LANE_STATUSES.includes(fmObj.status) ? fmObj.status : 'todo';
    bodyArea.value = body || '';
    // Build accounting (TASK-003): read-only build time / cost summary, hidden
    // when the ticket carries no accounting data.
    if (acctEl) {
      const bits = [];
      const dur = formatBuildDuration(fmObj.startedAt, fmObj.finishedAt);
      if (dur) bits.push(`Build time: ${fmObj.startedAt && !fmObj.finishedAt ? dur + ' (running)' : dur}`);
      const cost = formatCostUsd(fmObj.costUsd);
      if (cost) bits.push(`Cost: ${cost}`);
      const tok = formatTokens(fmObj.tokens);
      if (tok) bits.push(`Tokens: ${tok.replace(/ tok$/, '')}`);
      acctEl.textContent = bits.join('   ·   ');
      acctEl.classList.toggle('hidden', bits.length === 0);
    }
    // Per-run history (TASK-012): a read-only log of every time the ticket was
    // processed. Each run shows its date/time, minutes processed and cost; a
    // re-run appends a new line so the whole run history is visible. Hidden when
    // the ticket carries no run entries.
    if (runsEl) {
      const lines = ticketRunLines(fmObj);
      runsEl.textContent = '';
      if (lines.length) {
        const head = document.createElement('div');
        head.className = 'task-modal-runs-label';
        head.textContent = `Runs (${lines.length})`;
        runsEl.appendChild(head);
        for (const line of lines) {
          const row = document.createElement('div');
          row.className = 'task-modal-runs-row';
          row.textContent = line;
          runsEl.appendChild(row);
        }
      }
      runsEl.classList.toggle('hidden', lines.length === 0);
    }
    // Question/answer (TASK-005): show the agent's question and let the user type
    // an answer inline. Shown only when the ticket carries a question in its
    // frontmatter. The input is prefilled with any stored answer so a later
    // reader/editor sees what was decided and can amend it. Storing the answer
    // clears the waiting state (question present + answer present => not waiting).
    if (questionEl) {
      const q = fmObj.question != null ? String(fmObj.question) : '';
      if (q.trim()) {
        questionTextEl.textContent = q;
        if (answerInput) answerInput.value = fmObj.answer != null ? String(fmObj.answer) : '';
        questionEl.classList.remove('hidden');
      } else {
        questionTextEl.textContent = '';
        if (answerInput) answerInput.value = '';
        questionEl.classList.add('hidden');
      }
    }
  };
  fill(fm, ticket.body);
  pathEl.textContent = ticketPath;
  errEl.textContent = '';
  errEl.dataset.mode = '';
  modal.classList.remove('hidden');
  titleInput.focus();

  // Refresh from disk so edits start from the latest version.
  (async () => {
    const fr = await window.api.fs.readFile(ticketPath);
    if (fr && fr.ok && !fr.binary) {
      const parsed = parseTicketFrontmatter(fr.content);
      if (parsed) { fm = parsed.fm; openRaw = fr.content; fill(fm, parsed.body); }
    }
  })();

  const cleanup = () => {
    modal.classList.add('hidden');
    saveBtn.removeEventListener('click', onSave);
    cancelBtn.removeEventListener('click', onCancel);
  };
  const onCancel = () => cleanup();
  const doWrite = async () => {
    const newFm = Object.assign({}, fm);
    newFm.title = titleInput.value.trim();
    newFm.status = statusSel.value;
    newFm.updated = new Date().toISOString();
    if (!newFm.created) newFm.created = newFm.updated;
    // Question/answer (TASK-005): fold the typed answer into the frontmatter when
    // the ticket has a question. A non-empty answer clears the waiting state and
    // is stored alongside the question so a later reader sees both. Collapsed to a
    // single line because flat "key: value" frontmatter cannot hold newlines. An
    // empty answer leaves the ticket waiting (no `answer` key written). The
    // body textarea (with the user-owned `## Additional Context`) is written whole
    // and untouched.
    if (questionEl && !questionEl.classList.contains('hidden') && answerInput) {
      const ans = answerInput.value.replace(/\s*[\r\n]+\s*/g, ' ').trim();
      if (ans) newFm.answer = ans;
      else delete newFm.answer;
    }
    const wr = await window.api.fs.writeFile(ticketPath, serializeTicket(newFm, bodyArea.value));
    if (!wr || !wr.ok) {
      errEl.textContent = 'Save failed: ' + ((wr && wr.error) || 'unknown');
      return;
    }
    cleanup();
    pollTasksOnce(tab, true);
  };
  const onSave = async () => {
    if (errEl.dataset.mode === 'overwrite') { await doWrite(); return; }
    // Changed-on-disk check: the orchestrator may have rewritten this ticket
    // (e.g. a status transition) while the user had the modal open.
    let diskRaw = openRaw;
    try {
      const fr = await window.api.fs.readFile(ticketPath);
      if (fr && fr.ok) diskRaw = fr.content;
    } catch (_) {}
    if (diskRaw !== openRaw) {
      errEl.textContent = 'This ticket changed on disk (an agent may have updated it). Click Save again to overwrite.';
      errEl.dataset.mode = 'overwrite';
      openRaw = diskRaw;
      return;
    }
    await doWrite();
  };
  saveBtn.addEventListener('click', onSave);
  cancelBtn.addEventListener('click', onCancel);
}

async function installOrchestrateSkill(tab) {
  if (!tab.folder) return;
  const btn = tab.els.tasksInstallSkillBtn;
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Installing…';
  try {
    const res = await window.api.tasks.installSkill(tab.folder);
    if (!res || !res.ok) {
      const textEl = tab.els.tasksSkillBanner.querySelector('.install-banner-text');
      if (textEl) textEl.innerHTML = '<strong>Install failed.</strong> ' + ((res && res.error) || 'unknown error');
      btn.disabled = false;
      btn.textContent = prev;
      return;
    }
    tab.tasks.skillInstalled = true;
    tab.els.tasksSkillBanner.classList.add('hidden');
    tab.els.tasksBuildBtn.disabled = false;
    btn.textContent = prev;
    pollTasksOnce(tab, true);
  } catch (err) {
    console.error('[tasks installSkill]', err);
    btn.disabled = false;
    btn.textContent = prev;
  }
}

const BUILD_COMMAND = '/orchestrate build';

// ── Parallel-build concurrency (TASK-019) ───────────────────────────────────
// The Tasks toolbar's `.tasksConcurrency` <select> lets the user pick how many
// build agents the orchestrator may run at once. The choice is persisted per
// folder in localStorage under `tasks:concurrency:<folder>` and carried into the
// build as `/orchestrate build --concurrency <N>`.
//
// This renderer is a browser script (not requireable), so the clamp/default
// logic below is INLINED to mirror lib/tasks-settings.js + lib/ticket-queue.js's
// resolveConcurrency. Keep the two in lockstep (matching the
// ACTIVE_STATUSES/TASKS_ACTIVE_STATUSES convention): [1, TASKS_MAX_CONCURRENCY],
// floored, defaulting to TASKS_DEFAULT_CONCURRENCY for missing/blank/junk input.
const TASKS_MAX_CONCURRENCY = 8;
const TASKS_DEFAULT_CONCURRENCY = 3;

// Inline mirror of lib/ticket-queue.js resolveConcurrency.
function resolveTasksConcurrency(input) {
  if (input == null || input === '') return TASKS_DEFAULT_CONCURRENCY;
  const n = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(n)) return TASKS_DEFAULT_CONCURRENCY;
  const floored = Math.floor(n);
  if (floored < 1) return 1;
  if (floored > TASKS_MAX_CONCURRENCY) return TASKS_MAX_CONCURRENCY;
  return floored;
}

// Inline mirror of lib/tasks-settings.js readStoredConcurrency: parse a raw
// localStorage value (JSON-encoded number, bare string, blank, or corrupt) into
// a resolved concurrency, never throwing.
function readStoredTasksConcurrency(raw) {
  if (raw == null) return resolveTasksConcurrency(raw);
  let value = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return resolveTasksConcurrency('');
    try { value = JSON.parse(trimmed); } catch (_) { value = trimmed; }
  }
  return resolveTasksConcurrency(value);
}

// Per-folder storage key, mirroring slackStorageKey (null when no folder open).
function tasksConcurrencyStorageKey(tab) {
  return tab.folder ? 'tasks:concurrency:' + tab.folder : null;
}

// The current resolved concurrency for this folder, read fresh from localStorage
// so the queued build command never diverges from a stale in-memory value.
function currentTasksConcurrency(tab) {
  const key = tasksConcurrencyStorageKey(tab);
  if (!key) return TASKS_DEFAULT_CONCURRENCY;
  try {
    return readStoredTasksConcurrency(localStorage.getItem(key));
  } catch (_) {
    return TASKS_DEFAULT_CONCURRENCY;
  }
}

// The build command carrying the folder's chosen concurrency, built at queue
// time from the current resolved value.
function buildCommandFor(tab) {
  return BUILD_COMMAND + ' --concurrency ' + currentTasksConcurrency(tab);
}

// True for any queued prompt that is a build command (bare or argumented), so
// stop/continuation logic recognises the `--concurrency <N>` form too.
function isBuildCommand(p) {
  return typeof p === 'string' && (p === BUILD_COMMAND || p.startsWith(BUILD_COMMAND + ' '));
}

// Fill the <select> with one <option> per value in [1, TASKS_MAX_CONCURRENCY],
// derived from the ceiling so it never drifts. Defensive: no-op if absent.
function populateTasksConcurrencyOptions(tab) {
  const sel = tab.els.tasksConcurrency;
  if (!sel) return;
  if (sel.options.length === TASKS_MAX_CONCURRENCY) return; // already built
  sel.innerHTML = '';
  for (let i = 1; i <= TASKS_MAX_CONCURRENCY; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = String(i);
    sel.appendChild(opt);
  }
}

// Initialise the select for the current folder: build options, then select the
// stored (clamped/defaulted) value. Never throws on a corrupt entry.
function initTasksConcurrency(tab) {
  const sel = tab.els.tasksConcurrency;
  if (!sel) return;
  populateTasksConcurrencyOptions(tab);
  sel.value = String(currentTasksConcurrency(tab));
}

// Persist the chosen value per folder, mirroring saveSlackConfig's try/catch.
function onTasksConcurrencyChange(tab) {
  const sel = tab.els.tasksConcurrency;
  if (!sel) return;
  const value = resolveTasksConcurrency(sel.value);
  sel.value = String(value); // reflect the clamped value back to the UI
  const key = tasksConcurrencyStorageKey(tab);
  if (!key) return; // no folder open -> skip persistence
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (_) {}
}

// Counts of tickets per status, from the last poll snapshot.
function taskStatusCounts(tab) {
  const counts = { todo: 0, defining: 0, 'in-progress': 0, testing: 0, 'failed-testing': 0, done: 0, other: 0 };
  for (const tk of tab.tasks.tickets.values()) {
    const s = tk.fm.status;
    if (counts[s] === undefined) counts.other++; else counts[s]++;
  }
  return counts;
}

// Reflect Build/Stop state on the toolbar button. When auto-build is running the
// button becomes a Stop control; otherwise it's enabled only once the skill is
// installed and there is something to build.
function updateBuildBtn(tab) {
  const btn = tab.els.tasksBuildBtn;
  if (!btn) return;
  const t = tab.tasks;
  if (t.autoBuild) {
    btn.textContent = 'Stop';
    btn.classList.add('building');
    btn.disabled = false;
    btn.title = 'Stop auto-building (Claude finishes the current ticket)';
    return;
  }
  btn.textContent = 'Build';
  btn.classList.remove('building');
  const counts = taskStatusCounts(tab);
  const pending = counts.todo + counts['failed-testing'];
  btn.disabled = !t.skillInstalled || pending === 0;
  btn.title = t.skillInstalled
    ? 'Build queued tickets until the board is clear'
    : 'Install the orchestration skill first';
}

// Start/stop the continuous build. Starting queues the first "/orchestrate build";
// maybeContinueBuild re-queues it whenever Claude goes idle with work remaining.
function toggleAutoBuild(tab) {
  if (!tab.folder) return;
  const t = tab.tasks;
  if (t.autoBuild) {
    t.autoBuild = false;
    // Drop any not-yet-sent build command so the loop truly stops (matches the
    // argumented `--concurrency <N>` form as well as the bare command).
    tab.promptQueue = tab.promptQueue.filter((p) => !isBuildCommand(p));
    renderQueue(tab);
    updateBuildBtn(tab);
    return;
  }
  if (!t.skillInstalled) return;
  const counts = taskStatusCounts(tab);
  // Nothing to do — don't start a loop that would immediately stop itself.
  if (counts.todo + counts['failed-testing'] === 0) return;
  t.autoBuild = true;
  updateBuildBtn(tab);
  // Kick the first build directly. Unlike the auto-continuation, this initial
  // run also picks up `failed-testing` tickets, so the button doubles as a
  // manual "retry failed" trigger.
  queueBuild(tab);
}

// Re-queue "/orchestrate build" while auto-build is on and there is still work in
// `todo` (fresh work). Tickets stuck in `failed-testing` are NOT retried here —
// the skill already caps its own fix loop and hands those back to the user, so
// re-triggering on them would spin forever. When nothing is left to do, stop and
// let the button fall back to its idle state (the board shows the final result).
function maybeContinueBuild(tab) {
  const t = tab.tasks;
  if (!t.autoBuild || !tab.folder) return;
  if (tab.status !== 'finished') return;      // Claude is busy / not ready
  if (tab.queueFiring) return;                // mid-dispatch, don't stack
  if (tab.promptQueue.some(isBuildCommand)) return;
  if (t.continueChecking) return;             // a decision poll is already in flight
  // Decide from FRESH data — the snapshot can be stale when the Tasks tab isn't
  // visible (polling is skipped), which would otherwise spawn no-op builds in a
  // loop. Force a read, then re-validate everything before queuing.
  t.continueChecking = true;
  Promise.resolve(pollTasksOnce(tab, true)).finally(() => {
    t.continueChecking = false;
    if (!t.autoBuild || !tab.folder) { updateBuildBtn(tab); return; }
    if (tab.status !== 'finished' || tab.queueFiring) return;
    if (tab.promptQueue.some(isBuildCommand)) return;
    if (taskStatusCounts(tab).todo > 0) {
      queueBuild(tab);
    } else {
      // No todo left. Done driving; anything still red needs the user.
      t.autoBuild = false;
      updateBuildBtn(tab);
    }
  });
}

// Queue "/orchestrate build" through the existing prompt queue so it inherits the
// idle-gating and two-write submit that the claude REPL needs.
function queueBuild(tab) {
  tab.promptQueue.push(buildCommandFor(tab));
  renderQueue(tab);
  if (tab.status === 'finished') tryDispatchNextPrompt(tab);
}

// Attach drop targets to each lane once. Dropping a card rewrites that ticket's
// `status` frontmatter to the lane it lands in.
function bindTaskLaneDrop(tab) {
  if (tab.tasks.lanesBound) return;
  tab.tasks.lanesBound = true;
  for (const laneEl of tab.els.tasksLanes) {
    const status = laneEl.dataset.status;
    // The `unknown` lane is a read-only holding area for out-of-enum tickets;
    // it isn't a real status, so don't let a drop write `status: unknown`.
    if (status === TASKS_UNKNOWN_STATUS) continue;
    laneEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      laneEl.classList.add('drag-over');
    });
    laneEl.addEventListener('dragleave', () => laneEl.classList.remove('drag-over'));
    laneEl.addEventListener('drop', (e) => {
      e.preventDefault();
      laneEl.classList.remove('drag-over');
      const file = e.dataTransfer && e.dataTransfer.getData('text/plain');
      if (file) moveTicketToStatus(tab, file, status);
    });
  }
}

// Rewrite a ticket's status on disk (whole-file write, per the skill contract).
// Reads the freshest copy first so a concurrent agent write isn't clobbered
// wholesale — only the status/updated fields change.
async function moveTicketToStatus(tab, file, newStatus) {
  const ticket = tab.tasks.tickets.get(file);
  if (!ticket) return;
  if (ticket.fm.status === newStatus) return;
  const filePath = ticket.path;
  let fm = ticket.fm;
  let body = ticket.body;
  try {
    const fr = await window.api.fs.readFile(filePath);
    if (fr && fr.ok && !fr.binary) {
      const parsed = parseTicketFrontmatter(fr.content);
      if (parsed) { fm = parsed.fm; body = parsed.body; }
    }
  } catch (_) {}
  const newFm = Object.assign({}, fm);
  newFm.status = newStatus;
  newFm.updated = new Date().toISOString();
  if (!newFm.created) newFm.created = newFm.updated;
  const wr = await window.api.fs.writeFile(filePath, serializeTicket(newFm, body));
  if (!wr || !wr.ok) {
    console.error('[tasks move]', wr && wr.error);
    return;
  }
  // Folder-per-status layout (TASK-008): after the whole-file write, relocate the
  // file into tasks/<new status>/ as a single atomic move. Write-then-rename keeps
  // the file present exactly once, so a concurrent poll never sees it duplicated or
  // missing.
  await relocateTicketFile(tab, filePath, file, newStatus);
  pollTasksOnce(tab, true);
}

// Clear any above/below reorder insertion markers left on task cards.
function clearTaskDropMarkers(tab) {
  for (const laneEl of tab.els.tasksLanes) {
    for (const el of laneEl.querySelectorAll('.task-card-drop-before, .task-card-drop-after')) {
      el.classList.remove('task-card-drop-before', 'task-card-drop-after');
    }
  }
}

// Persist a single ticket's `order` value (TASK-007). Whole-file write per the
// skill contract: read the freshest copy first so a concurrent agent write isn't
// clobbered, change only `order`/`updated`, preserve `created` and every other
// section (including the user-owned `## Additional Context`). Skips the write when
// the on-disk order already matches. Returns true when a write happened.
async function persistTicketOrder(tab, file, order) {
  const ticket = tab.tasks.tickets.get(file);
  if (!ticket) return false;
  const filePath = ticket.path;
  let fm = ticket.fm;
  let body = ticket.body;
  try {
    const fr = await window.api.fs.readFile(filePath);
    if (fr && fr.ok && !fr.binary) {
      const parsed = parseTicketFrontmatter(fr.content);
      if (parsed) { fm = parsed.fm; body = parsed.body; }
    }
  } catch (_) {}
  if (String(fm.order == null ? '' : fm.order) === String(order)) return false;
  const newFm = Object.assign({}, fm);
  newFm.order = String(order);
  newFm.updated = new Date().toISOString();
  if (!newFm.created) newFm.created = newFm.updated;
  const wr = await window.api.fs.writeFile(filePath, serializeTicket(newFm, body));
  if (!wr || !wr.ok) {
    console.error('[tasks reorder]', wr && wr.error);
    return false;
  }
  return true;
}

// Reorder a ticket within the `todo` lane (TASK-007). Computes the new position
// of `draggedFile` relative to `targetFile` (dropped above or below it), then
// reindexes every todo ticket's `order` to 1..N in the new sequence so the chosen
// order is a total order that survives board polls and restarts. Only touches the
// `todo` lane — a card dragged out of todo goes through moveTicketToStatus
// instead. Each ticket is a whole-file write; only files whose order changed are
// rewritten.
async function reorderTodoTicket(tab, draggedFile, targetFile, before) {
  const dragged = tab.tasks.tickets.get(draggedFile);
  const target = tab.tasks.tickets.get(targetFile);
  if (!dragged || !target) return;
  if (dragged.fm.status !== 'todo' || target.fm.status !== 'todo') return;
  if (draggedFile === targetFile) return;

  const todo = Array.from(tab.tasks.tickets.values())
    .filter((tk) => tk.fm.status === 'todo')
    .sort((a, b) => compareTicketOrder(a.fm, b.fm));
  const list = todo.filter((tk) => tk.file !== draggedFile);
  const targetIdx = list.findIndex((tk) => tk.file === targetFile);
  if (targetIdx === -1) return;
  list.splice(before ? targetIdx : targetIdx + 1, 0, dragged);

  let wrote = false;
  for (let i = 0; i < list.length; i++) {
    if (await persistTicketOrder(tab, list[i].file, i + 1)) wrote = true;
  }
  if (wrote) pollTasksOnce(tab, true);
}

// Turn a title into a short filename slug.
function taskSlug(title) {
  const s = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return s || 'ticket';
}

// Next TASK-<nnn> id, continuing the highest existing number.
function nextTaskId(tab) {
  let max = 0;
  for (const tk of tab.tasks.tickets.values()) {
    const m = /TASK-0*(\d+)/i.exec(tk.fm.id || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return 'TASK-' + String(max + 1).padStart(3, '0');
}

// New-ticket modal. Writes a fresh `todo` ticket following the skill's file
// contract so the orchestrator (and the build loop) can pick it up.
function openNewTaskModal(tab) {
  if (!tab.folder) return;
  const modal = document.getElementById('newTaskModal');
  if (!modal) return;
  const idEl = modal.querySelector('.newtask-id');
  const titleInput = modal.querySelector('.newtask-title');
  const bodyArea = modal.querySelector('.newtask-body');
  const errEl = modal.querySelector('.newtask-error');
  const cancelBtn = modal.querySelector('.newtask-cancel');
  const createBtn = modal.querySelector('.newtask-create');

  const id = nextTaskId(tab);
  idEl.textContent = id;
  titleInput.value = '';
  bodyArea.value = '';
  errEl.textContent = '';
  modal.classList.remove('hidden');
  titleInput.focus();

  const cleanup = () => {
    modal.classList.add('hidden');
    createBtn.removeEventListener('click', onCreate);
    cancelBtn.removeEventListener('click', onCancel);
  };
  const onCancel = () => cleanup();
  const onCreate = async () => {
    const title = titleInput.value.trim();
    if (!title) { errEl.textContent = 'Title is required.'; titleInput.focus(); return; }
    createBtn.disabled = true;
    try {
      const now = new Date().toISOString();
      const fm = { id, title, status: 'todo', created: now, updated: now };
      const description = bodyArea.value.trim() || 'What needs doing and why.';
      const body = [
        '',
        '## Description',
        description,
        '',
        '## Acceptance Criteria',
        '- [ ] First testable criterion',
        '',
        '## Additional Context',
        '(User-owned. Read it before building. Never overwrite it.)',
        ''
      ].join('\n');
      // Folder-per-status layout (TASK-008): new tickets are `todo`, so write them
      // straight into tasks/todo/ rather than the top level, avoiding an immediate
      // reconciliation move on the next poll.
      const tasksDir = tasksJoin(tab.folder, 'tasks');
      const subfolder = ticketFolderForStatus('todo');
      const destDir = subfolder ? tasksJoin(tasksDir, subfolder) : tasksDir;
      await window.api.fs.mkdir(destDir);
      const filePath = tasksJoin(destDir, `${id}-${taskSlug(title)}.md`);
      const wr = await window.api.fs.writeFile(filePath, serializeTicket(fm, body));
      if (!wr || !wr.ok) {
        errEl.textContent = 'Create failed: ' + ((wr && wr.error) || 'unknown');
        createBtn.disabled = false;
        return;
      }
      createBtn.disabled = false;
      cleanup();
      pollTasksOnce(tab, true);
    } catch (err) {
      errEl.textContent = 'Create failed: ' + (err.message || err);
      createBtn.disabled = false;
    }
  };
  createBtn.addEventListener('click', onCreate);
  cancelBtn.addEventListener('click', onCancel);
}

// ───────────────────────────────────────────────────────── slack channel

// Slack config is stored per-folder in localStorage. The bot token is loaded
// from the SLACK_TOKEN .env variable on demand and cached here so folder
// switches don't require a re-fetch. The session.json schema is left untouched.
function slackStorageKey(tab) {
  return tab.folder ? 'slack:' + tab.folder : null;
}

function saveSlackConfig(tab) {
  const key = slackStorageKey(tab);
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify({
      token: tab.slack.token,
      appToken: tab.slack.appToken,
      channelInput: tab.els.slackChannelInput.value.trim(),
      channelId: tab.slack.channelId,
      channelName: tab.slack.channelName,
      intervalMs: tab.slack.intervalMs,
      postReplies: tab.slack.postReplies
    }));
  } catch (_) {}
}

function loadSlackConfig(tab) {
  const key = slackStorageKey(tab);
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

// Called whenever a folder is (re)opened in a tab: tear down any live polling
// and reset to a clean, disconnected state, then prefill from saved config.
function resetSlackForFolder(tab) {
  stopSlackListening(tab);
  const s = tab.slack;
  s.connected = false;
  s.token = '';
  s.appToken = '';
  s.channelId = '';
  s.channelName = '';
  s.botUserId = null;
  s.polling = false;
  s.fetching = false;
  s.transport = null;
  s.lastTs = '0';
  s.lastReplyTs = '0';
  s.seenTs = new Set();
  s.messages = [];
  s.inbox = [];
  s.awaitingResponse = false;
  s.captureBuffer = '';
  s.replyThreadTs = null;
  // Drop any prior session anchor so reconnecting in this tab makes a fresh one.
  s.threadTs = null;

  const cfg = loadSlackConfig(tab);
  // The token comes from the SLACK_TOKEN .env variable; keep any previously
  // loaded one cached so the user doesn't have to reload it on every folder switch.
  s.token = (cfg && cfg.token) || '';
  s.appToken = (cfg && cfg.appToken) || '';
  tab.els.slackChannelInput.value = (cfg && (cfg.channelInput || cfg.channelName || cfg.channelId)) || '';
  if (cfg && cfg.intervalMs) {
    tab.els.slackIntervalSelect.value = String(cfg.intervalMs);
    s.intervalMs = Number(cfg.intervalMs) || 5000;
  }
  if (cfg && typeof cfg.postReplies === 'boolean') {
    tab.els.slackPostReplies.checked = cfg.postReplies;
    s.postReplies = cfg.postReplies;
  }
  tab.els.slackConnectError.textContent = '';
  tab.els.slackTokenStatus.textContent = '';
  tab.els.slackTokenStatus.className = 'slackTokenStatus slack-signin-status';
  tab.els.slackComposerInput.value = '';
  updateSlackTokenUI(tab);
  updateSlackUI(tab);
  renderSlackMessages(tab);
}

function initSlackTab(tab) {
  if (!tab.folder) return;
  updateSlackUI(tab);
}

function updateSlackUI(tab) {
  const s = tab.slack;
  const connected = s.connected;
  tab.els.slackConnectPanel.classList.toggle('hidden', connected);
  tab.els.slackChat.classList.toggle('hidden', !connected);
  tab.els.slackConnectBtn.classList.toggle('hidden', connected);
  tab.els.slackDisconnectBtn.classList.toggle('hidden', !connected);
  tab.els.slackPollToggle.disabled = !connected;
  tab.els.slackPollToggle.checked = s.polling;
  tab.els.slackTabDot.classList.toggle('hidden', !s.polling);
  if (!connected) {
    tab.els.slackStatus.textContent = 'not connected';
    tab.els.slackStatus.className = 'slackStatus slack-status';
  } else {
    const chan = s.channelName ? '#' + s.channelName : s.channelId;
    if (s.polling) {
      const via = s.transport === 'socket' ? ' (socket)' : s.transport === 'poll' ? ' (poll)' : '';
      tab.els.slackStatus.textContent = `live${via} · ${chan}`;
    } else {
      tab.els.slackStatus.textContent = `connected · ${chan}`;
    }
    tab.els.slackStatus.className = 'slackStatus slack-status ' + (s.polling ? 'live' : 'ok');
  }
}

function showSlackConnectForm(tab) {
  tab.slack.connected = false;
  updateSlackUI(tab);
  updateSlackTokenUI(tab);
  tab.els.slackChannelInput.focus();
}

// Reflect whether we currently hold a cached bot token.
function updateSlackTokenUI(tab) {
  const hasToken = !!tab.slack.token;
  tab.els.slackLoadTokenBtn.textContent = hasToken ? 'Reload token from .env' : 'Load token from .env';
  if (hasToken && !tab.els.slackTokenStatus.textContent) {
    tab.els.slackTokenStatus.textContent = '✓ Token loaded (cached). Choose a channel and Connect.';
    tab.els.slackTokenStatus.className = 'slackTokenStatus slack-signin-status ok';
  }
}

// Instructions shown when no token is available or the connection fails.
const SLACK_SETUP_INSTRUCTIONS =
  'To use the Slack bridge, set SLACK_TOKEN in your .env file to the bot token (xoxb-…) ' +
  'from your Slack app (OAuth & Permissions → Bot User OAuth Token). Optionally set ' +
  'SLACK_APP_TOKEN (xapp-… with the connections:write scope) to enable Socket Mode. ' +
  'Save .env, then reload the token and Connect. The bot must also be invited into the channel.';

// Fetch the Slack bot token from the SLACK_TOKEN .env variable via the main
// process. Returns true once tab.slack.token holds a usable token.
async function ensureSlackToken(tab, force) {
  if (tab.slack.token && !force) return true;
  const setStatus = (text, cls) => {
    tab.els.slackTokenStatus.textContent = text;
    tab.els.slackTokenStatus.className = 'slackTokenStatus slack-signin-status' + (cls ? ' ' + cls : '');
  };
  tab.els.slackLoadTokenBtn.disabled = true;
  const prevLabel = tab.els.slackLoadTokenBtn.textContent;
  tab.els.slackLoadTokenBtn.textContent = 'Loading…';
  setStatus('Loading token from .env…', '');
  try {
    // getToken reads SLACK_TOKEN from .env only.
    const res = await window.api.slack.getToken();
    if (res && res.ok && res.token) {
      tab.slack.token = res.token;
      // Optional app-level token (xapp-…) — enables Socket Mode when present.
      tab.slack.appToken = res.appToken || '';
      saveSlackConfig(tab);
      setStatus('✓ Token loaded from .env. Choose a channel and Connect.', 'ok');
      updateSlackTokenUI(tab);
      return true;
    }
    // No SLACK_TOKEN in .env — surface the setup instructions.
    setStatus((res && res.error) || 'No Slack token found in .env.', 'error');
    showSlackInstructions(tab, (res && res.error) || 'No Slack token found in .env.');
    return false;
  } catch (err) {
    setStatus(err.message || String(err), 'error');
    showSlackInstructions(tab, err.message || String(err));
    return false;
  } finally {
    tab.els.slackLoadTokenBtn.disabled = false;
    tab.els.slackLoadTokenBtn.textContent = tab.slack.token ? 'Reload token from .env' : prevLabel;
  }
}

// Prompt for (and persist) the Slack app's OAuth client credentials. Both are
// required before we can start the OAuth flow; returns null if the user cancels
// either prompt.
async function ensureSlackClientCredentials() {
  const id = await ensureSecret({
    key: 'SLACK_CLIENT_ID',
    title: 'Slack app Client ID',
    description: 'From your Slack app → Basic Information → App Credentials. Saved to .env and reused next time.',
    placeholder: '1234567890.1234567890'
  });
  if (!id) return null;
  const secret = await ensureSecret({
    key: 'SLACK_CLIENT_SECRET',
    title: 'Slack app Client Secret',
    description: 'From your Slack app → Basic Information → App Credentials. Saved to .env and reused next time.',
    placeholder: '••••••••••••••••',
    password: true
  });
  if (!secret) return null;
  return { id, secret };
}

// "Sign in with Slack": ensure client credentials, then run the OAuth flow in
// the main process (opens the system browser, catches the loopback redirect,
// exchanges the code, saves SLACK_TOKEN). On success the obtained user token is
// cached on the tab exactly like a freshly loaded .env token. Any failure leaves
// any previously working token untouched — we only overwrite tab.slack.token on
// a confirmed success.
async function signInWithSlack(tab) {
  const setStatus = (text, cls) => {
    tab.els.slackTokenStatus.textContent = text;
    tab.els.slackTokenStatus.className = 'slackTokenStatus slack-signin-status' + (cls ? ' ' + cls : '');
  };
  tab.els.slackConnectError.textContent = '';

  // Client id/secret must be set BEFORE starting OAuth (criterion 6).
  const creds = await ensureSlackClientCredentials();
  if (!creds) {
    setStatus('Slack sign-in needs both SLACK_CLIENT_ID and SLACK_CLIENT_SECRET.', 'error');
    return;
  }

  const btn = tab.els.slackSignInBtn;
  const prevLabel = btn.textContent;
  btn.disabled = true;
  tab.els.slackLoadTokenBtn.disabled = true;
  btn.textContent = 'Signing in…';
  setStatus('Opening your browser to sign in with Slack…', '');

  // While the browser tab is open, surface the exact redirect URL so the user
  // can register it on their Slack app if Slack rejects it.
  const off = window.api.slack.onOAuthStarted(({ redirectUri }) => {
    if (redirectUri) {
      setStatus('Waiting for Slack in your browser… If it errors, register this redirect URL on your Slack app (OAuth & Permissions → Redirect URLs): ' + redirectUri, '');
    }
  });

  try {
    const res = await window.api.slack.startOAuth();
    if (!res || !res.ok || !res.token) {
      const msg = (res && res.error) || 'Slack sign-in failed.';
      setStatus(msg, 'error');
      showSlackInstructions(tab, msg);
      return;
    }
    // Success — treat identically to a freshly loaded token.
    tab.slack.token = res.token;
    saveSlackConfig(tab);
    setStatus('✓ Signed in with Slack' + (res.team ? ' (' + res.team + ')' : '') + '. Choose a channel and Connect.', 'ok');
    updateSlackTokenUI(tab);
  } catch (err) {
    setStatus(err.message || String(err), 'error');
    showSlackInstructions(tab, err.message || String(err));
  } finally {
    if (off) off();
    btn.disabled = false;
    tab.els.slackLoadTokenBtn.disabled = false;
    btn.textContent = prevLabel;
  }
}

// Render setup instructions into the connect-error slot so the user knows how
// to fix a missing/invalid token or a failed connection.
function showSlackInstructions(tab, detail) {
  const el = tab.els.slackConnectError;
  el.textContent = '';
  if (detail) {
    const d = document.createElement('div');
    d.className = 'slack-instructions-detail';
    d.textContent = detail;
    el.appendChild(d);
  }
  const tip = document.createElement('div');
  tip.className = 'slack-instructions-help';
  tip.textContent = SLACK_SETUP_INSTRUCTIONS;
  el.appendChild(tip);
}

async function connectSlack(tab) {
  const channel = tab.els.slackChannelInput.value.trim();
  tab.els.slackConnectError.textContent = '';
  if (!channel) { tab.els.slackConnectError.textContent = 'Enter a channel.'; return; }

  tab.els.slackTestConnectBtn.disabled = true;
  tab.els.slackTestConnectBtn.textContent = 'Connecting…';
  try {
    // Load the token from .env if we don't have one cached yet.
    if (!tab.slack.token) {
      const ok = await ensureSlackToken(tab, false);
      if (!ok) { return; } // ensureSlackToken already surfaced the instructions.
    }
    const token = tab.slack.token;
    const res = await window.api.slack.connect(token, channel);
    if (!res || !res.ok) {
      showSlackInstructions(tab, (res && res.error) || 'Connection failed.');
      return;
    }
    const s = tab.slack;
    s.token = token;
    s.channelId = res.channelId;
    s.channelName = res.channelName || '';
    s.botUserId = res.botUserId || null;
    s.intervalMs = Number(tab.els.slackIntervalSelect.value) || 5000;
    s.postReplies = !!tab.els.slackPostReplies.checked;
    // Baseline at "now" so we only react to messages sent from here on, not the
    // channel's entire backlog.
    s.lastTs = (Date.now() / 1000).toFixed(6);
    s.seenTs = new Set();
    s.messages = [];
    s.inbox = [];
    s.awaitingResponse = false;
    s.captureBuffer = '';
    s.replyThreadTs = null;
    s.threadTs = null;

    // Create the ONE anchor message for this session and reuse its thread_ts as
    // the two-way proxy thread. On failure we do NOT mark connected / set
    // threadTs, so no stale/duplicate thread is left behind (criterion 1).
    const headerText = `:robot_face: Claude session started${tab.folder ? ' · ' + tab.folder : ''}. Reply in this thread to talk to Claude; Claude's output will be posted here.`;
    let anchor;
    try {
      anchor = await window.api.slack.post(token, s.channelId, headerText, null);
    } catch (err) {
      anchor = { ok: false, error: err.message || String(err) };
    }
    if (!anchor || !anchor.ok || !anchor.ts) {
      showSlackInstructions(tab, 'Connected to the channel, but could not create the Slack session thread: '
        + ((anchor && anchor.error) || 'post failed') + '. Not connected.');
      return; // leave s.connected false and s.threadTs null
    }
    s.threadTs = anchor.ts;
    // Baseline reply polling at the anchor so we pick up every reply typed into
    // the thread from here on (conversations.replies, not history).
    s.lastReplyTs = anchor.ts;
    // The anchor is the bot's own post — never feed it back into Claude.
    s.seenTs.add(anchor.ts);
    s.connected = true;

    saveSlackConfig(tab);
    appendSlackMessage(tab, { who: 'system', text: `Connected to ${s.channelName ? '#' + s.channelName : s.channelId} as ${res.botUser || 'bot'}. Replies in the session thread will be sent to Claude.` });
    updateSlackUI(tab);
    startSlackListening(tab);
  } catch (err) {
    showSlackInstructions(tab, err.message || String(err));
  } finally {
    tab.els.slackTestConnectBtn.disabled = false;
    tab.els.slackTestConnectBtn.textContent = 'Connect';
  }
}

function disconnectSlack(tab) {
  stopSlackListening(tab);
  const s = tab.slack;
  s.connected = false;
  // Clear the session anchor + in-flight state so a later reconnect creates a
  // fresh single anchor rather than reusing a stale thread (criterion 7).
  s.threadTs = null;
  s.awaitingResponse = false;
  s.captureBuffer = '';
  s.replyThreadTs = null;
  s.inbox = [];
  appendSlackMessage(tab, { who: 'system', text: 'Disconnected.' });
  updateSlackUI(tab);
}

// Begin "live" listening on the channel. Prefers Socket Mode — a persistent
// WebSocket that Slack keeps alive with protocol-level ping/pong and pushes
// messages in real time — whenever an app-level token (xapp-…) is available.
// Without one (or if the socket can't be opened) it falls back to HTTP polling.
// Either way `s.polling` is the single "is live" flag the rest of the UI reads.
async function startSlackListening(tab) {
  const s = tab.slack;
  if (!s.connected) return;
  s.polling = true;
  updateSlackUI(tab);
  if (s.appToken) {
    const ok = await startSlackSocket(tab);
    if (ok) return;
    appendSlackMessage(tab, { who: 'system', text: 'Socket Mode unavailable — using polling instead.' });
  }
  s.transport = 'poll';
  startSlackPolling(tab);
}

// Stop listening regardless of transport (used by disconnect, the Live toggle,
// folder switches and tab close).
function stopSlackListening(tab) {
  stopSlackSocket(tab);
  stopSlackPolling(tab);
  tab.slack.transport = null;
}

// Open a Socket Mode WebSocket. Returns true once the socket has been created
// (a fresh single-use URL was obtained and the WebSocket constructed). Drops and
// reconnects are handled by the socket's own close handler.
async function startSlackSocket(tab) {
  const s = tab.slack;
  try {
    const res = await window.api.slack.openSocket(s.appToken);
    if (!res || !res.ok || !res.url) {
      if (res && res.error) console.warn('[slack socket] open failed:', res.error);
      return false;
    }
    openSlackWebSocket(tab, res.url);
    s.transport = 'socket';
    updateSlackUI(tab);
    return true;
  } catch (err) {
    console.warn('[slack socket]', err);
    return false;
  }
}

function openSlackWebSocket(tab, url) {
  const s = tab.slack;
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    console.warn('[slack socket] ctor failed:', err);
    scheduleSlackSocketReconnect(tab);
    return;
  }
  ws._intentionalClose = false;
  s.socket = ws;

  ws.onmessage = (ev) => {
    let env;
    try { env = JSON.parse(ev.data); } catch (_) { return; }
    if (env.type === 'hello') {
      // Connected — reset the reconnect backoff.
      s.socketReconnectDelay = 1000;
      return;
    }
    if (env.type === 'disconnect') {
      // Slack periodically asks clients to reconnect (server refresh, etc.).
      // Closing here lets onclose obtain a fresh URL and reconnect.
      try { ws.close(); } catch (_) {}
      return;
    }
    if (env.type === 'events_api') {
      // Slack redelivers (and eventually disconnects) if not acked within 3s.
      if (env.envelope_id && s.socket && s.socket.readyState === WebSocket.OPEN) {
        try { s.socket.send(JSON.stringify({ envelope_id: env.envelope_id })); } catch (_) {}
      }
      const event = env.payload && env.payload.event;
      if (event) handleSlackSocketEvent(tab, event);
    }
    // slash_commands / interactive envelopes are not used here.
  };

  ws.onerror = () => { /* the close handler drives reconnection */ };

  ws.onclose = () => {
    if (s.socket === ws) s.socket = null;
    if (ws._intentionalClose) return;
    // Unexpected drop while still meant to be live — reconnect with backoff.
    if (s.connected && s.polling) scheduleSlackSocketReconnect(tab);
  };
}

function stopSlackSocket(tab) {
  const s = tab.slack;
  if (s.socketReconnectTimer) { clearTimeout(s.socketReconnectTimer); s.socketReconnectTimer = null; }
  s.socketReconnectDelay = 1000;
  if (s.socket) {
    s.socket._intentionalClose = true;
    try { s.socket.close(); } catch (_) {}
    s.socket = null;
  }
}

function scheduleSlackSocketReconnect(tab) {
  const s = tab.slack;
  if (s.socketReconnectTimer) return;       // already scheduled
  if (!s.connected || !s.polling) return;   // no longer meant to be live
  const delay = Math.min(s.socketReconnectDelay || 1000, 30000);
  s.socketReconnectDelay = Math.min(delay * 2, 30000);
  s.socketReconnectTimer = setTimeout(async () => {
    s.socketReconnectTimer = null;
    if (!s.connected || !s.polling) return;
    const ok = await startSlackSocket(tab);
    if (!ok) {
      // Couldn't get a fresh socket URL — keep the channel live via polling.
      s.transport = 'poll';
      appendSlackMessage(tab, { who: 'system', text: 'Socket Mode reconnect failed — falling back to polling.' });
      startSlackPolling(tab);
    }
  }, delay);
}

// A Socket Mode message event. Field names match conversations.history, so the
// shared handler applies the same bot-self / subtype filtering. Dedupe by ts so
// a later polling fallback never re-emits the same message.
function handleSlackSocketEvent(tab, event) {
  const s = tab.slack;
  if (!event || event.type !== 'message') return;
  if (event.channel && s.channelId && event.channel !== s.channelId) return;
  ingestSlackMessage(tab, event);
}

function startSlackPolling(tab) {
  const s = tab.slack;
  if (!s.connected) return;
  if (s.pollTimer) clearInterval(s.pollTimer);
  s.polling = true;
  updateSlackUI(tab);
  // Fire one immediately, then on the interval.
  pollSlackOnce(tab);
  s.pollTimer = setInterval(() => pollSlackOnce(tab), s.intervalMs);
}

function stopSlackPolling(tab) {
  const s = tab.slack;
  if (s.pollTimer) { clearInterval(s.pollTimer); s.pollTimer = null; }
  s.polling = false;
  updateSlackUI(tab);
}

async function pollSlackOnce(tab) {
  const s = tab.slack;
  if (!s.connected || s.fetching) return;
  s.fetching = true;
  try {
    const res = await window.api.slack.fetch(s.token, s.channelId, s.lastTs, 50);
    if (!res || !res.ok) {
      if (res && res.error) {
        tab.els.slackStatus.textContent = 'error: ' + res.error;
        tab.els.slackStatus.className = 'slackStatus slack-status error';
      }
      return;
    }
    for (const msg of res.messages) {
      ingestSlackMessage(tab, msg);
    }

    // conversations.history (above) only returns top-level channel messages, not
    // replies posted inside a thread. Since users talk to Claude by replying in
    // the session anchor thread, we MUST poll conversations.replies as well or
    // their replies never make it back into the app / Claude window.
    if (s.threadTs) {
      const rep = await window.api.slack.fetchReplies(s.token, s.channelId, s.threadTs, s.lastReplyTs, 200);
      if (rep && rep.ok) {
        for (const msg of rep.messages) {
          if (!msg || msg.ts == null) continue;
          if (msg.ts === s.threadTs) continue; // the anchor/parent, not a reply
          if (Number(msg.ts) > Number(s.lastReplyTs)) s.lastReplyTs = msg.ts;
          ingestSlackMessage(tab, msg);
        }
      } else if (rep && rep.error) {
        tab.els.slackStatus.textContent = 'error: ' + rep.error;
        tab.els.slackStatus.className = 'slackStatus slack-status error';
      }
    }
  } catch (err) {
    console.error('[slack poll]', err);
  } finally {
    s.fetching = false;
  }
}

// ── Markdown renderer (mirrors lib/markdown.js) ────────────────────────────
// The renderer is a browser script (nodeIntegration:false) so it cannot
// require() the lib module; this is a verbatim mirror kept in sync with
// lib/markdown.js. See that file for the full rationale + safety notes: the
// source is HTML-escaped BEFORE any transform, so raw HTML/<script> in the
// markdown never becomes live markup, and link/image URLs are scheme-checked.

function mdEscapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mdSanitizeUrl(url) {
  const raw = String(url).trim();
  const cleaned = raw.replace(/[\u0000-\u0020]/g, '');
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    const ok = scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel';
    if (ok) return cleaned;
    if (scheme === 'data' && /^data:image\//i.test(cleaned)) return cleaned;
    return '#';
  }
  return cleaned;
}

function mdRenderInline(escaped) {
  const codeSpans = [];
  let text = escaped.replace(/`([^`]+)`/g, (_m, code) => {
    codeSpans.push('<code>' + code + '</code>');
    return ' CODE' + (codeSpans.length - 1) + ' ';
  });
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (_m, alt, url) => '<img src="' + mdSanitizeUrl(url) + '" alt="' + alt + '">');
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (_m, label, url) => '<a href="' + mdSanitizeUrl(url) + '">' + label + '</a>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  text = text.replace(/(^|[^a-zA-Z0-9_])_([^_]+)_(?=$|[^a-zA-Z0-9_])/g, '$1<em>$2</em>');
  text = text.replace(/ CODE(\d+) /g, (_m, idx) => codeSpans[Number(idx)]);
  return text;
}

function renderMarkdown(src) {
  const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const listItemHtml = (text) => '<li>' + mdRenderInline(mdEscapeHtml(text)) + '</li>';
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const marker = fence[2][0];
      const body = [];
      i++;
      while (i < lines.length && !new RegExp('^\\s*' + marker + '{3,}\\s*$').test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      out.push('<pre><code>' + mdEscapeHtml(body.join('\n')) + '</code></pre>');
      continue;
    }
    if (/^\s*$/.test(line)) { i++; continue; }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push('<h' + level + '>' + mdRenderInline(mdEscapeHtml(heading[2])) + '</h' + level + '>');
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push('<blockquote>' + renderMarkdown(quoted.join('\n')) + '</blockquote>');
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(listItemHtml(lines[i].replace(/^\s*[-*+]\s+/, '')));
        i++;
      }
      out.push('<ul>' + items.join('') + '</ul>');
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(listItemHtml(lines[i].replace(/^\s*\d+[.)]\s+/, '')));
        i++;
      }
      out.push('<ol>' + items.join('') + '</ol>');
      continue;
    }
    const para = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^(\s*)(`{3,}|~{3,})/.test(lines[i]) &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    const joined = para.map((l) => mdRenderInline(mdEscapeHtml(l))).join('<br>');
    out.push('<p>' + joined + '</p>');
  }
  return out.join('\n');
}

// ── Slack proxy decision logic (mirrors lib/slack-proxy.js) ────────────────
// The renderer is a browser script (nodeIntegration:false) so it cannot
// require() the lib module; this is a verbatim mirror kept in sync with
// lib/slack-proxy.js. See that file for the full rationale.

// The two-way proxy is active only once connected AND a single anchor thread
// exists. When false BOTH directions are a no-op. Mirrors isProxyEnabled in
// lib/slack-proxy.js.
function slackProxyEnabled(s) {
  return !!(s && s.connected && s.threadTs);
}

// Should this inbound Slack message be dispatched to the Claude window? Filters
// the bot's own posts (bot_id / botUserId / seenTs) so Claude's output never
// loops back, non-user subtypes, and anything outside the session anchor
// thread. Mirrors shouldDispatchIncoming in lib/slack-proxy.js.
function slackShouldDispatchIncoming(msg, s) {
  if (!msg || msg.ts == null) return false;
  if (!slackProxyEnabled(s)) return false;
  if (msg.bot_id) return false;
  if (s.botUserId && msg.user === s.botUserId) return false;
  if (s.seenTs && typeof s.seenTs.has === 'function' && s.seenTs.has(msg.ts)) return false;
  if (msg.subtype && msg.subtype !== 'thread_broadcast' && msg.subtype !== 'file_share') return false;
  const thread = msg.thread_ts || msg.ts;
  if (thread !== s.threadTs) return false;
  return true;
}

// Common ingest funnel for both transports (Socket Mode + polling). Advances
// the ts baseline, applies the pure dispatch decision (which includes seenTs
// dedup + bot-self filtering + anchor-thread gating), then marks the ts seen so
// it is never reprocessed by a later poll.
function ingestSlackMessage(tab, msg) {
  const s = tab.slack;
  if (!msg || msg.ts == null) return;
  if (Number(msg.ts) > Number(s.lastTs)) s.lastTs = msg.ts;
  const accept = slackShouldDispatchIncoming(msg, s);
  s.seenTs.add(msg.ts);
  if (!accept) return;
  handleIncomingSlackMessage(tab, msg);
}

function handleIncomingSlackMessage(tab, msg) {
  const s = tab.slack;
  const text = decodeSlackText(msg.text || '');
  if (!text.trim()) return;

  appendSlackMessage(tab, { who: 'slack', author: msg.user || 'user', text, ts: msg.ts });
  s.inbox.push({ text, ts: msg.ts, user: msg.user });
  slackTryDispatch(tab);
}

// Slack wraps links/mentions like <http://x|x>, <@U123>, &amp; etc. Normalise
// to plain text before handing the prompt to Claude.
function decodeSlackText(t) {
  return String(t)
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/<@([^>]+)>/g, '@$1')
    .replace(/<#[^|>]+\|([^>]+)>/g, '#$1')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

// Send the next queued Slack message to the Claude (cmd) pane, but only when
// Claude is idle and not paused on a confirmation menu — same guard the prompt
// queue uses.
function slackTryDispatch(tab) {
  const s = tab.slack;
  if (!slackProxyEnabled(s)) return; // no-op when not connected / no anchor thread
  if (s.awaitingResponse) return;
  if (!s.inbox.length) return;
  if (!tab.cmd.id) return;
  if (tab.status !== 'finished' && tab.status !== 'idle') return;
  if (isAwaitingTuiSelection(tab)) return;

  const item = s.inbox.shift();
  s.awaitingResponse = true;
  // Fresh capture window for this reply. Outbound always uses the single
  // session anchor thread (s.threadTs), never a per-message thread.
  s.captureBuffer = '';
  setTabStatus(tab, 'busy');
  if (tab.idleTimer) { clearTimeout(tab.idleTimer); tab.idleTimer = null; }
  try {
    window.api.pty.write(tab.cmd.id, item.text);
    logPromptEntry(tab, 'slack', item.text);
    setTimeout(() => {
      if (tab.cmd && tab.cmd.id) {
        try { window.api.pty.write(tab.cmd.id, '\r'); } catch (_) {}
      }
    }, QUEUE_ENTER_DELAY_MS);
  } catch (err) {
    console.error('[slack dispatch]', err);
    s.awaitingResponse = false;
  }
}

// Called when the cmd pane goes idle ("finished"). If a Slack prompt was in
// flight, post Claude's captured reply back to the channel, then dispatch the
// next queued Slack message (if any).
function slackOnFinished(tab) {
  const s = tab.slack;
  // No-op unless the proxy is active. Always clear the in-flight flag so a run
  // that finished can never leave dispatch permanently stuck.
  if (!s || !slackProxyEnabled(s)) { if (s) s.awaitingResponse = false; return; }

  // Flush whatever Claude output accumulated into the single anchor thread,
  // regardless of what triggered the run (Slack reply or direct typing).
  const reply = cleanTerminalOutput(s.captureBuffer);
  s.captureBuffer = '';
  s.awaitingResponse = false;
  s.replyThreadTs = null;
  if (reply) {
    appendSlackMessage(tab, { who: 'claude', text: reply });
    if (s.postReplies) {
      postToSlack(tab, reply, s.threadTs);
    }
  }
  // Give the TUI a beat to settle, then dispatch the next queued Slack message
  // (covers messages that arrived while Claude was still busy).
  if (s.inbox.length) {
    setTimeout(() => slackTryDispatch(tab), QUEUE_SEND_DELAY_MS);
  }
}

async function postToSlack(tab, text, threadTs) {
  const s = tab.slack;
  // No-op when the proxy is inactive (not connected / no anchor thread).
  if (!slackProxyEnabled(s) || !text) return { ok: false };
  // Always post into the single session anchor thread.
  const thread = threadTs || s.threadTs;
  // Slack hard-limits ~4000 chars per message; chunk longer replies.
  const chunks = chunkText(text, 3800);
  let ok = true;
  let lastError = null;
  for (const chunk of chunks) {
    try {
      const res = await window.api.slack.post(s.token, s.channelId, chunk, thread);
      if (res && res.ok && res.ts) s.seenTs.add(res.ts);
      if (!res || !res.ok) { ok = false; lastError = (res && res.error) || 'post failed'; }
    } catch (err) {
      ok = false;
      lastError = err.message || String(err);
    }
  }
  if (!ok) {
    // Surface the failure without crashing the app or the Claude window.
    console.warn('[slack post]', lastError);
    tab.els.slackStatus.textContent = 'send failed: ' + lastError;
    tab.els.slackStatus.className = 'slackStatus slack-status error';
    appendSlackMessage(tab, { who: 'system', text: 'Slack send failed: ' + lastError });
  }
  return { ok, error: lastError };
}

function chunkText(text, size) {
  const out = [];
  let rest = String(text);
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest);
  return out.length ? out : [''];
}

// Best-effort scrub of raw terminal capture into something readable. Claude's
// TUI redraws heavily, so this strips ANSI, the input box chrome and prompt
// markers, collapses blank runs, and trims to a sane length.
function cleanTerminalOutput(raw) {
  if (!raw) return '';
  let text = String(raw).replace(ANSI_RE, '');
  // Carriage-return redraws: keep only the final state of each line.
  text = text.split('\n').map((line) => {
    const parts = line.split('\r');
    return parts[parts.length - 1];
  }).join('\n');

  const lines = [];
  for (const rawLine of text.split('\n')) {
    let line = rawLine.replace(/[ \t]+$/g, '');
    // Drop box-drawing chrome (input box, banners).
    if (/^[\s│┃┆┇┊┋╎╏╭╮╯╰─━┄┅┈┉┌┐└┘├┤┬┴┼>·•⠀-⣿]*$/.test(line)) continue;
    // Drop the "> " prompt input line and common hint/footer lines.
    if (/^\s*>\s*$/.test(line)) continue;
    if (/^\s*\?\s*for shortcuts\s*$/i.test(line)) continue;
    lines.push(line);
  }
  let out = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (out.length > 12000) out = out.slice(-12000);
  return out;
}

function sendSlackComposer(tab) {
  const s = tab.slack;
  if (!slackProxyEnabled(s)) return;
  const text = tab.els.slackComposerInput.value.trim();
  if (!text) return;
  tab.els.slackComposerInput.value = '';
  // Posting from here surfaces in the anchor thread; the poller will skip it
  // (bot user id / seenTs), so it won't be re-dispatched as a prompt — show it
  // locally. Routed into the single session thread like every other outbound.
  appendSlackMessage(tab, { who: 'me', text });
  postToSlack(tab, text, s.threadTs);
}

function appendSlackMessage(tab, msg) {
  tab.slack.messages.push(msg);
  if (tab.slack.messages.length > 500) {
    tab.slack.messages = tab.slack.messages.slice(-500);
  }
  renderSlackMessages(tab);
}

function renderSlackMessages(tab) {
  const box = tab.els.slackMessages;
  if (!box) return;
  box.innerHTML = '';
  if (!tab.slack.messages.length) {
    const empty = document.createElement('div');
    empty.className = 'slack-empty';
    empty.textContent = tab.slack.connected
      ? 'No messages yet. Say something in the channel.'
      : 'Connect a channel to start.';
    box.appendChild(empty);
    return;
  }
  for (const m of tab.slack.messages) {
    const row = document.createElement('div');
    row.className = 'slack-msg slack-msg-' + (m.who || 'slack');
    if (m.who !== 'system') {
      const head = document.createElement('div');
      head.className = 'slack-msg-head';
      const who =
        m.who === 'claude' ? 'Claude' :
        m.who === 'me' ? 'You (sent)' :
        ('@' + (m.author || 'user'));
      head.textContent = who;
      row.appendChild(head);
    }
    const body = document.createElement('div');
    body.className = 'slack-msg-body';
    body.textContent = m.text || '';
    row.appendChild(body);
    box.appendChild(row);
  }
  box.scrollTop = box.scrollHeight;
}

// ───────────────────────────────────────────────────────── session restore

async function restoreSession() {
  if (!window.api || !window.api.session) return false;
  try {
    const data = await window.api.session.load();
    const folders = (data && Array.isArray(data.folders)) ? data.folders : [];
    if (!folders.length) return false;
    restoringSession = true;
    dom.emptyState.classList.add('hidden');
    let firstTabId = null;
    for (const entry of folders) {
      // Entries are normalized to { path, agent } by the main process, but
      // tolerate a bare string in case of an older session file.
      const folder = typeof entry === 'string' ? entry : (entry && entry.path);
      if (!folder) continue;
      const agent = (entry && entry.agent === 'opencode') ? 'opencode' : 'claude';
      const tab = createTab();
      tab.agent = agent;
      if (!firstTabId) firstTabId = tab.id;
      activateTab(tab.id);
      try {
        await openFolderInTab(tab, folder);
      } catch (err) {
        console.error('[restoreSession] failed to open', folder, err);
      }
    }
    if (firstTabId) activateTab(firstTabId);
    return true;
  } catch (err) {
    console.error('[restoreSession]', err);
    return false;
  } finally {
    restoringSession = false;
    persistSession();
  }
}

// ───────────────────────────────────────────────────────── wiring

dom.browseBtn2.addEventListener('click', pickFolderForNewTab);
dom.newTabBtn.addEventListener('click', pickFolderForNewTab);

if (window.api && window.api.pty) {
  window.api.pty.onData(({ id, data }) => {
    const info = ptyToTab.get(id);
    if (!info) return;
    const t = info.tab[info.slot].term;
    if (t) t.write(data);
    if (info.slot === 'cmd') onCmdData(info.tab, data);
    if (info.slot === 'bash' && info.tab.uiTestWatch && info.tab.uiTestWatch.active) {
      appendToUiTestWatch(info.tab, data);
    }
  });
  window.api.pty.onExit(({ id }) => {
    const info = ptyToTab.get(id);
    if (!info) return;
    const t = info.tab[info.slot].term;
    if (t) t.write(`\r\n[process exited]\r\n`);
    info.tab[info.slot].id = null;
    ptyToTab.delete(id);
  });
}

if (window.api && window.api.aws) {
  window.api.aws.onStatus(renderStatusForAllTabs);
  window.api.aws.status().then(renderStatusForAllTabs).catch((e) => console.error('[aws.status]', e));
}

if (window.api && window.api.gitops) {
  window.api.gitops.onLog(({ id, line }) => {
    const entry = gitOpLogs.get(id);
    if (!entry || !entry.target) return;
    entry.target.textContent += (entry.target.textContent ? '\n' : '') + line;
    entry.target.scrollTop = entry.target.scrollHeight;
  });
}

const ro = new ResizeObserver(() => {
  const t = TABS.get(activeTabId);
  if (t) fitTab(t);
});
ro.observe(dom.workspaces);

// Window-level Ctrl+F: open the Files-tab find bar whenever the active
// workspace is on the Files sub-tab, regardless of where focus currently is.
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
  if (e.key !== 'f' && e.key !== 'F') return;
  const tab = TABS.get(activeTabId);
  if (!tab || tab.activeSubTab !== 'files') return;
  // If the user is typing in the find input itself, let the browser handle it.
  if (document.activeElement === tab.els.filesFindInput) return;
  e.preventDefault();
  const scope = (document.activeElement === tab.els.fileEditor) ? 'editor' : 'tree';
  openFilesFind(tab, scope);
});

console.log('[renderer] init complete', {
  api: !!window.api,
  Terminal: !!window.Terminal,
  FitAddon: !!window.FitAddon
});

restoreSession().catch((e) => console.error('[restoreSession]', e));

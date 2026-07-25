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

// OS platform for platform-dependent UI (install commands, download links,
// pane copy). Falls back to 'win32' — the app's original behaviour — if a stale
// preload during dev reload has not exposed api.platform, so checks never throw.
function getPlatform() {
  return (window.api && window.api.platform) || 'win32';
}
function isWin() {
  return getPlatform() === 'win32';
}

// Infer a path's separator so joins work on both Windows (backslash paths from
// the main process) and POSIX. Rule: backslash ONLY when the string contains a
// backslash and no forward slash; forward slash otherwise. This keeps Windows
// output byte-identical to the old '\\' default while POSIX paths join with '/'.
function inferSep(base) {
  return (base.indexOf('\\') >= 0 && base.indexOf('/') < 0) ? '\\' : '/';
}
// Append `part` to `base`, inserting the inferred separator only when `base`
// does not already end in one. Shared by every renderer path join.
function appendPath(base, part) {
  if (!base) return part;
  const sep = /[\\/]$/.test(base) ? '' : inferSep(base);
  return base + sep + part;
}

const IDLE_MS = 2500;
const QUEUE_SEND_DELAY_MS = 300;
const QUEUE_ENTER_DELAY_MS = 180;
// While a run is busy, flush accumulated Claude output to the Slack anchor
// thread on this fixed interval so long runs don't leave the thread silent
// (TASK-061). slackOnFinished still posts the final remainder at idle.
const SLACK_FLUSH_INTERVAL_MS = 30000;

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
      // LLM summarization of auto-posted output (TASK-073). OFF by default:
      // it is opt-in because it requires an ANTHROPIC_API_KEY and sends output
      // to an external service. When off the auto-post paths behave exactly as
      // TASK-071 (mechanical cleanup + redaction only).
      summarize: false,
      intervalMs: 5000,
      pollTimer: null,
      polling: false,
      fetching: false,
      // 'socket' (persistent WebSocket / Socket Mode) or 'poll' (HTTP polling).
      transport: null,
      // Periodic flush of captureBuffer into the anchor thread during long busy
      // runs (TASK-061). Started by startSlackListening, cleared everywhere the
      // pollTimer is (stopSlackListening / disconnectSlack / resetSlackForFolder).
      flushTimer: null,
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
      threadTs: null,
      // A pending multi-step command prompt (TASK-072), e.g. { name: 'create-ticket' }.
      // While set, the next accepted anchor-thread reply is consumed by that
      // prompt instead of being matched/forwarded. Cleared on disconnect / folder
      // switch alongside the rest of the session state.
      pendingCommand: null
    },
    tasks: {
      pollTimer: null,
      fetching: false,
      reconciling: false,
      tickets: new Map(),
      skillInstalled: null,
      lastSig: '',
      autoBuild: false,
      // Last-good team config (TASK-101): the raw parsed tasks/team-config.json
      // object, or null when it has never been read / does not exist (→ the board
      // renders the six default lanes). Kept with keep-last-good semantics so a
      // corrupt/failed read mid-poll never clobbers a previously good config.
      config: null,
      // Agent names confirmed present in .claude/agents/ (basenames), used only to
      // flag a lane's configured agent as missing (warning badge). A Set (possibly
      // empty) means the directory was confirmed present and enumerated, so a
      // configured agent absent from it is genuinely missing → warn. Null means the
      // list is UNKNOWN — not yet loaded, or the directory is absent/unreadable, or
      // a transient listing error — in which case badges must NOT warn (F2, TASK-119).
      // Kept last-good on a transient listing failure of a confirmed-present dir.
      agentNames: null,
      archiveExpanded: false,
      // Live board search filter (TASK-132): a session-only, case-insensitive
      // literal substring query matched against each ticket's id + title + body.
      // Kept on tab.tasks (not in the DOM) so it survives the wholesale board
      // rebuild on every poll re-render; renderTasksBoard reads it live. Empty /
      // whitespace-only → full board. Reset on folder switch (resetTasksForFolder)
      // and cleared automatically when a ticket is created or Plan is run. NOT part
      // of tab.tasks.lastSig — typing triggers its own direct synchronous render.
      searchQuery: ''
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
      slackSummarize: ws.querySelector('.slackSummarize'),
      slackTestConnectBtn: ws.querySelector('.slackTestConnectBtn'),
      slackConnectError: ws.querySelector('.slackConnectError'),
      slackChat: ws.querySelector('.slackChat'),
      slackMessages: ws.querySelector('.slackMessages'),
      slackComposerInput: ws.querySelector('.slackComposerInput'),
      slackSendBtn: ws.querySelector('.slackSendBtn'),
      tasksStatus: ws.querySelector('.tasksStatus'),
      tasksSearch: ws.querySelector('.tasksSearch'),
      tasksSearchClear: ws.querySelector('.tasksSearchClear'),
      tasksConcurrency: ws.querySelector('.tasksConcurrency'),
      tasksPlanBtn: ws.querySelector('.tasksPlanBtn'),
      tasksNewBtn: ws.querySelector('.tasksNewBtn'),
      tasksBuildBtn: ws.querySelector('.tasksBuildBtn'),
      tasksRefresh: ws.querySelector('.tasksRefresh'),
      tasksSkillBanner: ws.querySelector('.tasksSkillBanner'),
      tasksInstallSkillBtn: ws.querySelector('.tasksInstallSkillBtn'),
      tasksEmpty: ws.querySelector('.tasksEmpty'),
      tasksNoMatch: ws.querySelector('.tasksNoMatch'),
      tasksNotice: ws.querySelector('.tasksNotice'),
      tasksBoard: ws.querySelector('.tasksBoard'),
      teamView: ws.querySelector('.tab-view[data-view="team"]'),
      teamStatus: ws.querySelector('.teamStatus'),
      teamBody: ws.querySelector('.teamBody'),
      teamAgentsSection: ws.querySelector('.teamAgentsSection'),
      teamAgentsAddBtn: ws.querySelector('.teamAgentsAddBtn'),
      teamAgentsRefresh: ws.querySelector('.teamAgentsRefresh'),
      teamAgentsBody: ws.querySelector('.teamAgentsBody'),
      teamWorkflowSection: ws.querySelector('.teamWorkflowSection'),
      teamWorkflowBody: ws.querySelector('.teamWorkflowBody'),
      teamWorkflowRefresh: ws.querySelector('.teamWorkflowRefresh'),
      teamBoardSection: ws.querySelector('.teamBoardSection'),
      teamBoardSaveBtn: ws.querySelector('.teamBoardSaveBtn'),
      teamBoardRefresh: ws.querySelector('.teamBoardRefresh'),
      teamBoardBody: ws.querySelector('.teamBoardBody')
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
  if (tab.els.tasksSearch) {
    // Board search (TASK-132): live, synchronous, per-tab filter. On every input
    // we snapshot the raw value into tab.tasks.searchQuery and re-render the board
    // directly — no debounce, no await (the render is a wholesale in-memory rebuild
    // and the input lives outside .tasksBoard, so focus/caret are preserved).
    tab.els.tasksSearch.addEventListener('input', () => onTasksSearchInput(tab));
    tab.els.tasksSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        clearTasksSearch(tab);
      }
    });
  }
  if (tab.els.tasksSearchClear) {
    tab.els.tasksSearchClear.addEventListener('click', () => {
      clearTasksSearch(tab);
      if (tab.els.tasksSearch) tab.els.tasksSearch.focus();
    });
  }
  if (tab.els.teamAgentsRefresh) {
    tab.els.teamAgentsRefresh.addEventListener('click', () => refreshTeamAgents(tab));
  }
  if (tab.els.teamAgentsAddBtn) {
    tab.els.teamAgentsAddBtn.addEventListener('click', () => openAddAgentModal(tab));
  }
  if (tab.els.teamWorkflowRefresh) {
    tab.els.teamWorkflowRefresh.addEventListener('click', () => refreshTeamWorkflow(tab));
  }
  if (tab.els.teamBoardRefresh) {
    tab.els.teamBoardRefresh.addEventListener('click', () => refreshTeamBoard(tab));
  }
  if (tab.els.teamBoardSaveBtn) {
    tab.els.teamBoardSaveBtn.addEventListener('click', () => saveTeamBoardConfig(tab));
  }
  tab.els.tasksInstallSkillBtn.addEventListener('click', () => installOrchestrateSkill(tab));
  tab.els.tasksPlanBtn.addEventListener('click', () => openPlanModal(tab));
  tab.els.tasksNewBtn.addEventListener('click', () => openNewTaskModal(tab));
  tab.els.tasksBuildBtn.addEventListener('click', () => toggleAutoBuild(tab));
  if (tab.els.tasksConcurrency) {
    tab.els.tasksConcurrency.addEventListener('change', () => onTasksConcurrencyChange(tab));
    initTasksConcurrency(tab); // build options up front so the select is never empty
  }
  // Lane drop targets are wired per-lane during renderTasksBoard now (TASK-101):
  // lanes are generated from team-config and rebuilt wholesale each render, so
  // there is no static lane set to bind once up front.
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
    // winget is Windows-only; elsewhere the button is hidden (use the download
    // page / package manager instead).
    if (isWin()) {
      tab.els.gitInstallWingetBtn.addEventListener('click', () => startGitInstall(tab));
    } else {
      tab.els.gitInstallWingetBtn.classList.add('hidden');
    }
  }
  if (tab.els.gitInstallDownloadBtn) {
    tab.els.gitInstallDownloadBtn.addEventListener('click', () => {
      const plat = getPlatform();
      const page = plat === 'darwin' ? 'mac' : plat === 'win32' ? 'win' : 'linux';
      if (window.api.openExternal) window.api.openExternal('https://git-scm.com/download/' + page);
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
  // AI-summarization toggle (TASK-073): update live so it can be flipped
  // during a session (no reconnect needed) and persist per folder.
  tab.els.slackSummarize.addEventListener('change', () => {
    tab.slack.summarize = !!tab.els.slackSummarize.checked;
    saveSlackConfig(tab);
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
  // On Windows this is the recommended native PowerShell installer; on POSIX
  // the PowerShell option is replaced with the claude.ai shell installer.
  if (isWin()) {
    tab.els.claudeInstallPwshBtn.addEventListener('click', () => {
      runInCmdPty(tab, 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"');
    });
  } else {
    tab.els.claudeInstallPwshBtn.textContent = 'Install via script';
    tab.els.claudeInstallPwshBtn.addEventListener('click', () => {
      runInCmdPty(tab, 'curl -fsSL https://claude.ai/install.sh | bash');
    });
  }

  // Platform-truthful pane copy (TASK-133). On win32 every label below is left
  // byte-identical to the static HTML; off win32 both panes are the user's login
  // shell, so the Windows-worded copy ("Git Bash", winget) is rewritten via
  // textContent. Mirrors the claudeInstallPwshBtn relabel above and the
  // winget-button hide. A stale preload → isWin() true → Windows copy shown.
  if (!isWin()) {
    const bashTabBtn = tab.els.ws.querySelector('.tab-btn[data-tab="bash"]');
    if (bashTabBtn) bashTabBtn.textContent = 'Terminal';

    const opencodeOption = tab.els.agentSelect &&
      tab.els.agentSelect.querySelector('option[value="opencode"]');
    if (opencodeOption) opencodeOption.textContent = 'shell · openCode';

    const claudeOption = tab.els.agentSelect &&
      tab.els.agentSelect.querySelector('option[value="claude"]');
    if (claudeOption) claudeOption.textContent = 'shell · claude';

    if (tab.els.opencodeBanner) {
      const bannerText = tab.els.opencodeBanner.querySelector('.install-banner-text');
      if (bannerText) {
        for (const node of bannerText.childNodes) {
          if (node.nodeType === 3 && /Git Bash/.test(node.nodeValue)) {
            node.nodeValue = node.nodeValue.replace(
              'run openCode in Git Bash', 'run openCode in your shell');
          }
        }
      }
    }
    if (tab.els.opencodeInstallBtn) tab.els.opencodeInstallBtn.textContent = 'Install openCode';

    const ghLoginHint = tab.els.ws.querySelector('.gitAuthHint');
    if (ghLoginHint) {
      ghLoginHint.textContent = 'Login runs in the terminal. Follow the prompts (device code / browser) to complete sign-in, then come back and click re-check.';
    }

    // Hide the winget hint alongside the already-hidden winget button, without
    // hiding the surrounding git-install section (the download-page button stays).
    if (tab.els.gitNotInstalledGate) {
      const wingetHint = tab.els.gitNotInstalledGate.querySelector('.git-auth-hint');
      if (wingetHint) wingetHint.classList.add('hidden');
    }
  }

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
  // A closed tab's tickets no longer count toward the keep-awake wake-lock
  // (TASK-036) — re-report the app-wide active count without it.
  reportTasksActivity();
  // A closed waiting/finished tab (or its tickets) no longer counts toward the
  // OS attention flash (TASK-078) — re-report so it clears if it was the last one.
  reportWindowAttention();

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
  // Re-read the Team tab's Agents panel when a new folder opens while it's active
  // (TASK-094); otherwise it refreshes lazily on next activation via initTeamTab.
  if (tab.activeSubTab === 'team') initTeamTab(tab);

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

// (Re)launch the chosen agent in the cmd pane. On Windows Claude runs in
// cmd.exe and openCode in Git Bash; on macOS/Linux both run in the user's login
// shell (the platform split lives in lib/pty.js). Switching agents kills the
// current cmd PTY and respawns it.
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
  // Single status choke point — any tab entering/leaving waiting/finished changes
  // the app-wide attention state (TASK-078). Only report on an actual transition
  // so repeated same-status calls (e.g. per pty tick) don't spam IPC.
  if (status !== prev) reportWindowAttention();
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
  } else if (name === 'team') {
    initTeamTab(tab);
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
            const childPath = appendPath(fullPath, entry.name);
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
      cur = appendPath(cur, parts[i]);
      tab.changedDirSet.add(cur.toLowerCase());
    }
    const fileAbs = appendPath(cur, parts[parts.length - 1]);
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
    currentPath = appendPath(currentPath, parts[i]);
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
  const sep = inferSep(fullPath);
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
  const sep = inferSep(base);
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
  const pkgPath = appendPath(tab.folder, 'package.json');
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

// Canonical LANE status enum, in board left-to-right order (TASK-006/028).
// Mirrors LANE_STATUSES in lib/ticket-lanes.js for the browser side, which
// cannot require Node modules — KEEP IN LOCKSTEP. `todo` is where new tickets
// are created; `defining` is the BA phase (acceptance criteria + Gherkin) before
// coding; `post-processing` holds post-processing tickets (kind: post-processing)
// run against normal tasks after tests pass, and is excluded from the build swarm.
// `failed-testing` is deliberately absent — it is a valid status without its own
// lane (its cards fold into Testing; see TASKS_VALID_STATUSES).
const TASKS_LANE_STATUSES = ['todo', 'defining', 'in-progress', 'testing', 'post-processing', 'done'];
// The full set of valid, persistable statuses: every lane status PLUS
// `failed-testing`, which stays a real, claimable status (owns its own
// tasks/failed-testing/ folder) even though it has no dedicated board lane.
// Mirrors VALID_STATUSES in lib/ticket-lanes.js.
const TASKS_VALID_STATUSES = [...TASKS_LANE_STATUSES, 'failed-testing'];
// Statuses that mean an agent is actively working the ticket right now (BA while
// defining, coder while in-progress, tester while testing). Cards in one of
// these states show the per-card blue "being worked on" dot; idle states
// (todo / done / failed-testing / post-processing) show no active dot. Mirrors
// ACTIVE_STATUSES in lib/ticket-lanes.js.
const TASKS_ACTIVE_STATUSES = ['defining', 'in-progress', 'testing'];
// Status whose tests failed — its card shows a red "failed" marker, now folded
// into the Testing lane. Mirrors FAILED_STATUS in lib/ticket-lanes.js.
const TASKS_FAILED_STATUS = 'failed-testing';
// Post-processing status/lane and the matching ticket `kind` (TASK-028). Mirrors
// POST_PROCESSING_STATUS / POST_PROCESSING_KIND in lib/ticket-lanes.js.
const TASKS_POST_PROCESSING_STATUS = 'post-processing';
const TASKS_POST_PROCESSING_KIND = 'post-processing';
// Dedicated lane for out-of-enum tickets so an unknown status is rendered
// gracefully instead of being silently dumped into `todo`. Mirrors
// UNKNOWN_STATUS in lib/ticket-lanes.js.
const TASKS_UNKNOWN_STATUS = 'unknown';
// True when `fm` is a post-processing ticket. Mirrors isPostProcessingTicket in
// lib/ticket-lanes.js.
function isTasksPostProcessingTicket(fm) {
  return !!fm && fm.kind === TASKS_POST_PROCESSING_KIND;
}

// ── Team-config lane mirror (TASK-101) ──────────────────────────────────────
// Renderer duplicate of the tiny slice of lib/team-config.js + lib/ticket-lanes.js
// the board needs to render config-driven lanes. The renderer is a browser script
// that cannot require Node modules, so — exactly as TASKS_LANE_STATUSES mirrors
// LANE_STATUSES above — it inlines the column-ordering / slug / label rules and
// MUST be kept in lockstep with those two modules (they stay authoritative).
//
// Today's system-column labels, keyed by slug. Mirror of SYSTEM_LABELS in
// lib/team-config.js; the labels are exactly the board's fixed headers, so the
// no-config board is identical to the historic hardcoded lanes.
const TASKS_SYSTEM_LABELS = {
  todo: 'To Do',
  defining: 'Defining',
  'in-progress': 'In Progress',
  testing: 'Testing',
  'post-processing': 'Post-processing',
  done: 'Done',
};
// Slugs a user column may never take (mirror of RESERVED_SLUGS in
// lib/team-config.js): every valid status, the `unknown` routing lane, and the
// wont-do archive marker.
const TASKS_RESERVED_SLUGS = new Set([...TASKS_VALID_STATUSES, TASKS_UNKNOWN_STATUS, '__wont-do__']);
const TASKS_MAX_SLUG_LENGTH = 30;
const TASKS_SLUG_RE = /^[a-z0-9-]+$/;

// Keys that must never be copied by plain assignment during an unknown-field
// round-trip. `tasks/team-config.json` is read off disk via JSON.parse, which
// defines `"__proto__"` as an OWN key; assigning `out.__proto__ = value` would
// fire the Object.prototype.__proto__ setter and reassign the target's prototype
// (object value) or silently swallow the key (primitive). `constructor`/`prototype`
// are skipped as defense-in-depth. These are DROPPED (not round-tripped) — instance
// only, so the global Object.prototype is never touched. Faithful mirror of
// UNSAFE_KEYS / isUnsafeKey in lib/team-config.js (TASK-116). KEEP IN LOCKSTEP —
// the renderer applies the same skip in tasksSerializeTeamConfig, refreshTeamBoard,
// and buildWorkingConfigFromRaw's unknown-top-level-key loops.
const TASKS_UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function tasksIsUnsafeKey(k) {
  return TASKS_UNSAFE_KEYS.has(k);
}

// Readable fallback label from a slug ("ux-review" → "Ux Review"). Mirror of
// prettifyLabel in lib/team-config.js.
function tasksPrettifyLabel(slug) {
  return String(slug).split('-').filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Build a normalised board column { status, label, description, agent, system }
// from a raw config column. Collapsed mirror of defaultSystemColumn /
// repairSystemColumn / buildUserColumn in lib/team-config.js — just the fields the
// board renders. A system column defaults to its canonical label; a user column
// falls back to a prettified slug. `agent` is display-only metadata (a nonexistent
// agent is preserved here and warned about at render time).
function tasksBuildColumn(slug, rawCol, system) {
  const src = rawCol && typeof rawCol === 'object' ? rawCol : {};
  const label = typeof src.label === 'string' && src.label.trim() !== ''
    ? src.label
    : (system ? (TASKS_SYSTEM_LABELS[slug] || tasksPrettifyLabel(slug)) : tasksPrettifyLabel(slug));
  const description = typeof src.description === 'string' ? src.description : '';
  const agent = typeof src.agent === 'string' && src.agent.trim() !== '' ? src.agent.trim() : null;
  return { status: slug, label: String(label), description, agent, system: !!system };
}

// Normalise ANY parsed config into the ordered board columns: the six system
// columns in canonical LANE order with each valid user column inserted at the
// position it holds in the config (anchored to the last system column before it),
// mirroring lib/team-config.js normalizeConfig + lib/ticket-lanes.js
// laneStatusesFor. Tolerates null/junk (→ the six system defaults) and NEVER
// throws. `failed-testing`/reserved/invalid/duplicate user slugs are dropped.
function normalizeTasksColumns(raw) {
  const rawCols = raw && Array.isArray(raw.columns) ? raw.columns : [];
  const seenSystem = new Set();
  const seenUser = new Set();
  const systemRaw = Object.create(null);
  const userCols = []; // { anchor, col }
  let lastSystem = null;
  for (const rc of rawCols) {
    if (!rc || typeof rc !== 'object' || Array.isArray(rc)) continue;
    const status = typeof rc.status === 'string' ? rc.status.trim() : '';
    if (TASKS_LANE_STATUSES.includes(status)) {
      if (seenSystem.has(status)) continue;
      seenSystem.add(status);
      systemRaw[status] = rc;
      lastSystem = status;
      continue;
    }
    if (status === '' || TASKS_RESERVED_SLUGS.has(status)) continue;
    if (status.length > TASKS_MAX_SLUG_LENGTH || !TASKS_SLUG_RE.test(status)) continue;
    if (seenUser.has(status)) continue;
    seenUser.add(status);
    userCols.push({ anchor: lastSystem, col: rc });
  }
  const out = [];
  const appendAnchored = (anchor) => {
    for (const u of userCols) {
      if (u.anchor === anchor) out.push(tasksBuildColumn(u.col.status.trim(), u.col, false));
    }
  };
  appendAnchored(null);
  for (const slug of TASKS_LANE_STATUSES) {
    out.push(tasksBuildColumn(slug, seenSystem.has(slug) ? systemRaw[slug] : null, true));
    appendAnchored(slug);
  }
  return out;
}

// The set of user (non-system) column statuses in `columns`. Mirror of
// userStatusSetFor in lib/ticket-lanes.js (used for config-aware routing).
function tasksUserStatusSet(columns) {
  const set = new Set();
  for (const col of columns) {
    if (col.system === true) continue;
    if (col.status) set.add(col.status);
  }
  return set;
}

// The set of VALID user (non-system) column slugs in `columns`, applying the same
// filtering lib/ticket-lanes.js userStatusSetFor does (non-empty, filesystem-safe
// slug that is not a reserved system/valid status, `unknown`, or `__wont-do__`).
// Faithful mirror of userStatusSetFor — unlike tasksUserStatusSet above, which
// trusts an ALREADY-normalised `columns` and so skips the slug filtering. This one
// tolerates a raw/partial/junk `columns` array so lane derivation below agrees
// with the lib for ANY input (TASK-122). KEEP IN LOCKSTEP with userStatusSetFor.
function tasksUserSlugSetFor(columns) {
  const set = new Set();
  const cols = Array.isArray(columns) ? columns : [];
  for (const col of cols) {
    if (!col || typeof col !== 'object' || Array.isArray(col)) continue;
    if (col.system === true) continue;
    const slug = typeof col.status === 'string' ? col.status.trim() : '';
    if (slug === '') continue;
    // isFsSafeSlug: 1..30 chars matching /^[a-z0-9-]+$/.
    if (slug.length > TASKS_MAX_SLUG_LENGTH || !TASKS_SLUG_RE.test(slug)) continue;
    // Reserved slugs (system/valid status, `unknown`, `__wont-do__`) never win.
    if (TASKS_RESERVED_SLUGS.has(slug)) continue;
    set.add(slug);
  }
  return set;
}

// The ordered board lane slugs for `columns`: the six fixed system lanes in
// canonical TASKS_LANE_STATUSES order, with each VALID user column inserted at the
// position it holds in `columns` (anchored to the last system column before it; a
// user column before any system column sorts ahead of `todo`). Faithful mirror of
// laneStatusesFor in lib/ticket-lanes.js — it RE-INJECTS the system lanes so a raw
// or PARTIAL `columns` array yields the same order the lib produces, closing the
// renderer/lib skew TASK-122 guards against. null/junk/[] → TASKS_LANE_STATUSES,
// so the no-config summary is byte-identical to the historic fixed lanes. For
// already-normalised columns this equals `columns.map(c => c.status)` verbatim, so
// today's output is unchanged. KEEP IN LOCKSTEP with laneStatusesFor.
function tasksLaneStatusesFor(columns) {
  const cols = Array.isArray(columns)
    ? columns.filter((c) => c && typeof c === 'object' && !Array.isArray(c))
    : [];
  const userSlugs = tasksUserSlugSetFor(cols);
  // Anchor each user slug to the last system slug seen before it (null = before
  // the first system column). First occurrence of a slug wins.
  const anchored = [];
  const taken = new Set();
  let lastSystem = null;
  for (const col of cols) {
    const slug = typeof col.status === 'string' ? col.status.trim() : '';
    if (TASKS_LANE_STATUSES.includes(slug)) { lastSystem = slug; continue; }
    if (userSlugs.has(slug) && !taken.has(slug)) {
      taken.add(slug);
      anchored.push({ anchor: lastSystem, slug });
    }
  }
  const out = [];
  const appendAnchored = (anchor) => {
    for (const a of anchored) if (a.anchor === anchor) out.push(a.slug);
  };
  appendAnchored(null);
  for (const slug of TASKS_LANE_STATUSES) {
    out.push(slug);
    appendAnchored(slug);
  }
  return out;
}

// The board lane for `status` given `columns`. `failed-testing` folds into
// `testing`; a system lane status maps to itself; a valid user column status maps
// to itself; anything else routes to `unknown` (never silently to `todo`).
// Faithful mirror of laneForStatusFor in lib/ticket-lanes.js — pairs with
// tasksLaneStatusesFor so counts route exactly as the lib does for ANY `columns`
// input (TASK-122). KEEP IN LOCKSTEP with laneForStatusFor.
function tasksLaneForStatusFor(status, columns) {
  if (status === TASKS_FAILED_STATUS) return 'testing';
  if (TASKS_LANE_STATUSES.includes(status)) return status;
  if (tasksUserSlugSetFor(columns).has(status)) return status;
  return TASKS_UNKNOWN_STATUS;
}

// Derive a user slug from a free-text label ("UX Review" → "ux-review"), clamped
// to TASKS_MAX_SLUG_LENGTH with no leading/trailing dashes. Returns '' when the
// label yields nothing slug-worthy. Mirror of slugForLabel in lib/team-config.js
// (TASK-097) — the column manager's derived-slug preview. KEEP IN SYNC.
function tasksSlugForLabel(label) {
  return String(label == null ? '' : label)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, TASKS_MAX_SLUG_LENGTH)
    .replace(/-+$/, '');
}

// Validate a proposed NEW user column against the current in-memory columns.
// `slug` is derived from `label` when blank. Returns { ok, slug, error } and never
// throws. Mirror of validateNewColumn in lib/team-config.js (TASK-097): rejects a
// blank label, a blank/over-long/ill-formed slug, a reserved slug, or a slug that
// collides with an existing column. `existingSlugs` is a Set of the statuses
// already present (system + user). KEEP IN SYNC with the lib validator — an
// invalid column must NEVER reach the persisted config.
function tasksValidateNewColumn(label, existingSlugs) {
  const labelStr = typeof label === 'string' ? label.trim() : '';
  if (labelStr === '') {
    return { ok: false, slug: '', error: 'Label is required.' };
  }
  const finalSlug = tasksSlugForLabel(labelStr);
  if (finalSlug === '') {
    return { ok: false, slug: '', error: 'Slug is required.' };
  }
  if (finalSlug.length > TASKS_MAX_SLUG_LENGTH) {
    return { ok: false, slug: finalSlug, error: `Slug must be ${TASKS_MAX_SLUG_LENGTH} characters or fewer.` };
  }
  if (!TASKS_SLUG_RE.test(finalSlug)) {
    return { ok: false, slug: finalSlug, error: 'Slug may only contain lowercase letters, numbers, and dashes.' };
  }
  if (TASKS_RESERVED_SLUGS.has(finalSlug)) {
    return { ok: false, slug: finalSlug, error: `Slug "${finalSlug}" is reserved.` };
  }
  const set = existingSlugs instanceof Set ? existingSlugs : new Set(existingSlugs || []);
  if (set.has(finalSlug)) {
    return { ok: false, slug: finalSlug, error: `A column with slug "${finalSlug}" already exists.` };
  }
  return { ok: true, slug: finalSlug, error: null };
}

// Serialise the column manager's working config to the persistable JSON string
// written to tasks/team-config.json (TASK-103). The `columns` array is passed
// through normalizeTasksColumns FIRST so the on-disk file can only ever hold valid,
// canonically-ordered columns (system columns re-injected/repaired, invalid/
// reserved/duplicate user slugs dropped) — this is the SECURITY gate: an invalid or
// tampered slug can never be persisted. `version`/`skill` and any unknown
// top-level fields round-trip from the loaded config, but skill.concurrencyDefault
// is clamped through the resolveConcurrency mirror to [1, TASKS_MAX_CONCURRENCY] so
// a Save can never persist an out-of-range build concurrency (matching lib
// serializeConfig/normalizeConfig). Ends with a trailing newline.
// Collapsed mirror of serializeConfig in lib/team-config.js. KEEP IN SYNC.
function tasksSerializeTeamConfig(working) {
  const w = working && typeof working === 'object' ? working : {};
  const columns = normalizeTasksColumns({ columns: Array.isArray(w.columns) ? w.columns : [] })
    .map((c) => ({
      status: c.status,
      label: c.label,
      description: c.description,
      agent: c.agent,
      system: c.system,
    }));
  let version = 1;
  if (w.version != null) {
    const v = Number(w.version);
    if (Number.isFinite(v) && v >= 1) version = Math.floor(v);
  }
  const rawSkill = (w.skill && typeof w.skill === 'object' && !Array.isArray(w.skill)) ? w.skill : {};
  // Clamp skill.concurrencyDefault (when set) through the resolveConcurrency mirror
  // to [1, TASKS_MAX_CONCURRENCY], as lib serializeConfig/normalizeConfig do — a
  // Save must never persist an out-of-range concurrency. An absent default is left
  // absent so a valid config still round-trips unchanged.
  const skill = { ...rawSkill };
  if (rawSkill.concurrencyDefault != null && rawSkill.concurrencyDefault !== '') {
    skill.concurrencyDefault = resolveTasksConcurrency(rawSkill.concurrencyDefault);
  }
  const out = { version, columns, skill };
  if (w.extra && typeof w.extra === 'object') {
    for (const k of Object.keys(w.extra)) {
      if (k === 'version' || k === 'columns' || k === 'skill' || k === 'warnings') continue;
      // Skip prototype-poisoning keys before the plain assignment, mirroring
      // lib/team-config.js serializeConfig/normalizeConfig (TASK-116). KEEP IN SYNC.
      if (tasksIsUnsafeKey(k)) continue;
      out[k] = w.extra[k];
    }
  }
  return JSON.stringify(out, null, 2) + '\n';
}

// ── Team tab · Board panel — column manager (TASK-103) ──────────────────────
// Authoring UI for the dynamic-status engine over tasks/team-config.json. Reads
// the file, edits an in-memory working model (add / edit label-description-agent /
// reorder / remove), and persists the WHOLE file in a single fs.writeFile of the
// NORMALIZED config (tasksSerializeTeamConfig). System columns (the six board
// lanes) are marked and cannot be removed or re-slugged; user columns move freely
// but never past another system column (system relative order stays fixed). All
// labels/descriptions/slugs render via textContent — never innerHTML — and the
// slug is validated (tasksValidateNewColumn) before it can enter the model, so an
// XSS/tampered slug can never reach disk. The board (Tasks tab) picks up a saved
// change on its next poll (it reads the same file — TASK-101), no restart needed.

// The `.claude/agents/` name set for the agent select. Sorted basenames (minus
// .md). Tolerant of a missing directory / unreadable files (→ empty list).
async function readTeamAgentNames(tab) {
  const names = [];
  if (!tab || !tab.folder) return names;
  const agentsDir = tasksJoin(tab.folder, '.claude', 'agents');
  try {
    const res = await window.api.fs.findByExt(agentsDir, '.md');
    if (res && res.ok && Array.isArray(res.files)) {
      for (const fp of res.files) {
        const base = tasksBasename(fp).replace(/\.md$/i, '');
        if (base) names.push(base);
      }
    }
  } catch (err) {
    console.error('[team board agents]', err);
  }
  names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return names;
}

// Count tickets on the live board scan (tab.tasks.tickets) currently holding
// `status`. Drives the non-empty-removal confirmation (TASK-103).
function countTeamTicketsForStatus(tab, status) {
  let n = 0;
  const map = tab && tab.tasks && tab.tasks.tickets;
  if (map && typeof map.values === 'function') {
    for (const tk of map.values()) {
      if (tk && tk.fm && tk.fm.status === status) n += 1;
    }
  }
  return n;
}

// Re-read tasks/team-config.json + the agents list and rebuild the working model,
// then render. A corrupt/unparseable file loads the six system defaults with a
// non-blocking notice (the user can then Save a repaired file). Bound to the Board
// Refresh control and called on Team-tab activation. Last write wins: Refresh
// re-reads disk, discarding unsaved in-memory edits.
async function refreshTeamBoard(tab) {
  const body = tab.els.teamBoardBody;
  if (!body) return;
  if (!tab.folder) {
    tab.teamBoard = null;
    body.textContent = '(open a folder)';
    return;
  }
  body.textContent = 'Loading…';
  const agentNames = await readTeamAgentNames(tab);
  // Stale-guard: the folder/tab may have changed while awaiting.
  if (tab.els.teamBoardBody !== body) return;

  let raw = null;
  let notice = null;
  try {
    const cfgPath = tasksJoin(tab.folder, 'tasks', 'team-config.json');
    const res = await window.api.fs.readFile(cfgPath);
    if (tab.els.teamBoardBody !== body) return;
    if (res && res.ok && !res.binary && typeof res.content === 'string') {
      const text = res.content.trim();
      if (text !== '') {
        let parsed = false;
        try {
          raw = JSON.parse(res.content);
          parsed = true;
        } catch (_) {
          notice = 'tasks/team-config.json is not valid JSON — loaded the default columns. Saving will overwrite the file with a repaired config.';
          raw = null;
        }
        // Valid JSON that is not a usable board config still silently fell back to
        // the six defaults, so a subsequent Save would overwrite the file with
        // defaults WITH NO warning. Mirror lib normalizeConfig's "not an object" /
        // "columns was not an array" cases (a bare number/string/array/null, or an
        // object whose `columns` is present but not an array) with the same
        // non-blocking notice, so the user is told before Save replaces their file.
        // (An absent `columns`, or a valid `columns` array, is the ordinary
        // defaults fallback and stays notice-free.)
        if (parsed) {
          const isConfigObject = raw !== null && typeof raw === 'object' && !Array.isArray(raw);
          if (!isConfigObject || (raw.columns != null && !Array.isArray(raw.columns))) {
            notice = 'tasks/team-config.json is not a valid board config — loaded the default columns. Saving will overwrite the file with a repaired config.';
          }
        }
      }
    }
    // Missing / unreadable / empty file → defaults (no notice; a first-run file).
  } catch (_) {
    raw = null;
  }

  const version = (raw && typeof raw === 'object' && raw.version != null) ? raw.version : 1;
  const skill = (raw && typeof raw === 'object' && raw.skill && typeof raw.skill === 'object' && !Array.isArray(raw.skill))
    ? raw.skill : {};
  const extra = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const k of Object.keys(raw)) {
      if (k === 'version' || k === 'columns' || k === 'skill' || k === 'warnings') continue;
      // `raw` is the on-disk config straight from JSON.parse, so skip prototype-
      // poisoning keys before the plain assignment, mirroring lib/team-config.js
      // normalizeConfig's unknown-top-level-key loop (TASK-116). KEEP IN SYNC.
      if (tasksIsUnsafeKey(k)) continue;
      extra[k] = raw[k];
    }
  }
  // normalizeTasksColumns tolerates any junk (→ the six system defaults) and only
  // ever yields valid, canonically-ordered columns, so the model starts clean.
  const columns = normalizeTasksColumns(raw && typeof raw === 'object' ? raw : null)
    .map((c) => ({ status: c.status, label: c.label, description: c.description, agent: c.agent, system: c.system }));

  tab.teamBoard = { version, skill, extra, columns, agentNames, notice, dirty: false };
  renderTeamBoard(tab);
}

// Rebuild the Board panel DOM from the working model (no disk read). Called after
// every structural edit (add / remove / reorder). Field edits (label / description
// / agent) mutate the model in place WITHOUT a full re-render so input focus is
// preserved; they only flip the dirty flag.
function renderTeamBoard(tab) {
  const body = tab.els.teamBoardBody;
  const state = tab.teamBoard;
  if (!body) return;
  if (!state) { body.textContent = '(open a folder)'; return; }
  body.textContent = '';

  if (state.notice) {
    const notice = document.createElement('div');
    notice.className = 'team-board-notice';
    notice.textContent = state.notice;
    body.appendChild(notice);
  }

  const help = document.createElement('div');
  help.className = 'team-board-help';
  help.textContent = 'Columns are the board lanes. The display agent is metadata only (it does not change orchestration). System columns cannot be removed or re-slugged.';
  body.appendChild(help);

  const list = document.createElement('div');
  list.className = 'team-columns';
  state.columns.forEach((col, idx) => {
    list.appendChild(buildTeamColumnRow(tab, col, idx));
  });
  body.appendChild(list);

  body.appendChild(buildTeamAddColumnForm(tab));

  // Footer: dirty note. The Save control lives in the section header.
  const footer = document.createElement('div');
  footer.className = 'team-board-footer';
  if (state.dirty) {
    const dot = document.createElement('span');
    dot.className = 'team-board-dirty';
    dot.textContent = 'Unsaved changes — click Save to write tasks/team-config.json.';
    footer.appendChild(dot);
  }
  body.appendChild(footer);
}

// True when swapping the columns at `i` and `j` is allowed: both in range and NOT
// both system (two system columns may never change their relative order — the
// fixed todo → … → done sequence).
function canSwapTeamColumns(state, i, j) {
  const n = state.columns.length;
  if (i < 0 || j < 0 || i >= n || j >= n || i === j) return false;
  if (state.columns[i].system && state.columns[j].system) return false;
  return true;
}

// One column row: reorder controls, slug, system marker, label / description /
// agent editors, and (user columns only) a Remove control.
function buildTeamColumnRow(tab, col, idx) {
  const state = tab.teamBoard;
  const row = document.createElement('div');
  row.className = 'team-column' + (col.system ? ' team-column-system' : '');

  // ── Header: reorder + slug + system marker + remove ──
  const head = document.createElement('div');
  head.className = 'team-column-head';

  const moves = document.createElement('div');
  moves.className = 'team-column-moves';
  const upBtn = document.createElement('button');
  upBtn.className = 'team-column-move small-btn';
  upBtn.textContent = '↑';
  upBtn.title = 'Move up';
  upBtn.disabled = !canSwapTeamColumns(state, idx, idx - 1);
  upBtn.addEventListener('click', () => {
    if (!canSwapTeamColumns(state, idx, idx - 1)) return;
    const c = state.columns;
    [c[idx - 1], c[idx]] = [c[idx], c[idx - 1]];
    state.dirty = true;
    renderTeamBoard(tab);
  });
  const downBtn = document.createElement('button');
  downBtn.className = 'team-column-move small-btn';
  downBtn.textContent = '↓';
  downBtn.title = 'Move down';
  downBtn.disabled = !canSwapTeamColumns(state, idx, idx + 1);
  downBtn.addEventListener('click', () => {
    if (!canSwapTeamColumns(state, idx, idx + 1)) return;
    const c = state.columns;
    [c[idx + 1], c[idx]] = [c[idx], c[idx + 1]];
    state.dirty = true;
    renderTeamBoard(tab);
  });
  moves.appendChild(upBtn);
  moves.appendChild(downBtn);
  head.appendChild(moves);

  const slug = document.createElement('span');
  slug.className = 'team-column-slug';
  slug.textContent = col.status;
  head.appendChild(slug);

  if (col.system) {
    const badge = document.createElement('span');
    badge.className = 'team-column-badge';
    badge.textContent = 'system';
    badge.title = 'Built-in board lane — cannot be removed or re-slugged.';
    head.appendChild(badge);
  }

  if (!col.system) {
    const removeBtn = document.createElement('button');
    removeBtn.className = 'team-column-remove small-btn';
    removeBtn.textContent = 'Remove';
    removeBtn.title = 'Remove this column from the config';
    removeBtn.addEventListener('click', () => removeTeamColumn(tab, col.status));
    head.appendChild(removeBtn);
  }

  row.appendChild(head);

  // ── Fields: label / description / agent ──
  const fields = document.createElement('div');
  fields.className = 'team-column-fields';

  const labelField = document.createElement('label');
  labelField.className = 'team-column-field';
  const labelCap = document.createElement('span');
  labelCap.className = 'team-column-field-label';
  labelCap.textContent = 'Label';
  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.className = 'team-column-label-input';
  labelInput.value = col.label != null ? String(col.label) : '';
  labelInput.addEventListener('input', () => {
    col.label = labelInput.value;
    markTeamBoardDirty(tab);
  });
  labelField.appendChild(labelCap);
  labelField.appendChild(labelInput);
  fields.appendChild(labelField);

  const descField = document.createElement('label');
  descField.className = 'team-column-field';
  const descCap = document.createElement('span');
  descCap.className = 'team-column-field-label';
  descCap.textContent = 'Description';
  const descInput = document.createElement('input');
  descInput.type = 'text';
  descInput.className = 'team-column-desc-input';
  descInput.value = col.description != null ? String(col.description) : '';
  descInput.addEventListener('input', () => {
    col.description = descInput.value;
    markTeamBoardDirty(tab);
  });
  descField.appendChild(descCap);
  descField.appendChild(descInput);
  fields.appendChild(descField);

  const agentField = document.createElement('label');
  agentField.className = 'team-column-field';
  const agentCap = document.createElement('span');
  agentCap.className = 'team-column-field-label';
  agentCap.textContent = 'Display agent';
  const agentSel = document.createElement('select');
  agentSel.className = 'team-column-agent-select';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '(none)';
  agentSel.appendChild(none);
  const current = col.agent != null && String(col.agent).trim() !== '' ? String(col.agent).trim() : '';
  const names = state.agentNames || [];
  for (const nm of names) {
    const opt = document.createElement('option');
    opt.value = nm;
    opt.textContent = nm;
    agentSel.appendChild(opt);
  }
  // A saved agent no longer present in .claude/agents/ is kept as a selected
  // "(missing)" option so the value is never silently lost.
  let missing = false;
  if (current !== '' && !names.includes(current)) {
    missing = true;
    const opt = document.createElement('option');
    opt.value = current;
    opt.textContent = current + ' (missing)';
    agentSel.appendChild(opt);
  }
  agentSel.value = current;
  agentSel.addEventListener('change', () => {
    col.agent = agentSel.value === '' ? null : agentSel.value;
    markTeamBoardDirty(tab);
    renderTeamBoard(tab); // refresh the missing-warning state
  });
  agentField.appendChild(agentCap);
  agentField.appendChild(agentSel);
  if (missing) {
    const warn = document.createElement('span');
    warn.className = 'team-column-agent-warning';
    warn.textContent = 'This agent no longer exists in .claude/agents/.';
    agentField.appendChild(warn);
  }
  fields.appendChild(agentField);

  row.appendChild(fields);
  return row;
}

// Mark the working model dirty and reflect it without a full re-render (so a field
// edit never steals focus). Adds/updates the footer note lazily on next render.
function markTeamBoardDirty(tab) {
  const state = tab.teamBoard;
  if (!state || state.dirty) return;
  state.dirty = true;
  // Cheap live hint without disturbing focus: toggle a class on the body.
  if (tab.els.teamBoardBody) tab.els.teamBoardBody.classList.add('team-board-has-changes');
}

// The "Add column" form: label input, live derived-slug preview (read-only),
// position select, Add button and an inline error line. On Add the slug is
// validated against the current columns; on failure the error shows and NOTHING is
// added; on success the user column is inserted at the chosen position.
function buildTeamAddColumnForm(tab) {
  const state = tab.teamBoard;
  const form = document.createElement('div');
  form.className = 'team-add-column';

  const title = document.createElement('div');
  title.className = 'team-add-column-title';
  title.textContent = 'Add column';
  form.appendChild(title);

  const grid = document.createElement('div');
  grid.className = 'team-add-column-grid';

  const labelField = document.createElement('label');
  labelField.className = 'team-column-field';
  const labelCap = document.createElement('span');
  labelCap.className = 'team-column-field-label';
  labelCap.textContent = 'Label';
  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.className = 'team-add-column-label';
  labelInput.placeholder = 'e.g. UX Review';
  labelField.appendChild(labelCap);
  labelField.appendChild(labelInput);
  grid.appendChild(labelField);

  const slugField = document.createElement('label');
  slugField.className = 'team-column-field';
  const slugCap = document.createElement('span');
  slugCap.className = 'team-column-field-label';
  slugCap.textContent = 'Slug (derived)';
  const slugPreview = document.createElement('input');
  slugPreview.type = 'text';
  slugPreview.className = 'team-add-column-slug';
  slugPreview.readOnly = true;
  slugPreview.tabIndex = -1;
  slugPreview.placeholder = '(from label)';
  slugField.appendChild(slugCap);
  slugField.appendChild(slugPreview);
  grid.appendChild(slugField);

  const posField = document.createElement('label');
  posField.className = 'team-column-field';
  const posCap = document.createElement('span');
  posCap.className = 'team-column-field-label';
  posCap.textContent = 'Position';
  const posSel = document.createElement('select');
  posSel.className = 'team-add-column-position';
  const startOpt = document.createElement('option');
  startOpt.value = '0';
  startOpt.textContent = 'At start';
  posSel.appendChild(startOpt);
  state.columns.forEach((c, i) => {
    const opt = document.createElement('option');
    opt.value = String(i + 1);
    opt.textContent = 'After ' + (c.label && String(c.label).trim() !== '' ? c.label : c.status);
    posSel.appendChild(opt);
  });
  posSel.value = String(state.columns.length); // default: at the end
  posField.appendChild(posCap);
  posField.appendChild(posSel);
  grid.appendChild(posField);

  const addBtn = document.createElement('button');
  addBtn.className = 'team-add-column-btn small-btn primary-btn';
  addBtn.textContent = 'Add';
  grid.appendChild(addBtn);

  form.appendChild(grid);

  const err = document.createElement('div');
  err.className = 'team-add-column-error hidden';
  form.appendChild(err);

  const showErr = (msg) => { err.textContent = msg; err.classList.remove('hidden'); };
  const clearErr = () => { err.textContent = ''; err.classList.add('hidden'); };

  labelInput.addEventListener('input', () => {
    slugPreview.value = tasksSlugForLabel(labelInput.value);
    clearErr();
  });

  const submit = () => {
    const existing = new Set(state.columns.map((c) => c.status));
    const result = tasksValidateNewColumn(labelInput.value, existing);
    if (!result.ok) {
      showErr(result.error);
      return;
    }
    const pos = Math.max(0, Math.min(state.columns.length, parseInt(posSel.value, 10) || 0));
    state.columns.splice(pos, 0, {
      status: result.slug,
      label: labelInput.value.trim(),
      description: '',
      agent: null,
      system: false,
    });
    state.dirty = true;
    renderTeamBoard(tab);
  };

  addBtn.addEventListener('click', submit);
  labelInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });

  return form;
}

// Remove a USER column by slug. Confirms first, stating (when non-zero) the count
// of tickets currently holding that status and that they will fall to Unknown on
// the board. Config-only: it edits the in-memory model, NEVER a ticket file; the
// change is persisted on the next Save.
function removeTeamColumn(tab, status) {
  const state = tab.teamBoard;
  if (!state) return;
  const idx = state.columns.findIndex((c) => c.status === status);
  if (idx === -1) return;
  const col = state.columns[idx];
  if (col.system) return; // never remove a system column
  const count = countTeamTicketsForStatus(tab, status);
  const label = col.label && String(col.label).trim() !== '' ? col.label : status;
  let msg = 'Remove the "' + label + '" column?';
  if (count > 0) {
    msg = 'Remove the "' + label + '" column?\n\n'
      + count + ' ticket' + (count === 1 ? '' : 's') + ' currently hold' + (count === 1 ? 's' : '')
      + ' status "' + status + '". Those tickets are NOT changed — they will show under "Unknown" on the board until you re-add this column. Only the config is edited.';
  }
  if (!window.confirm(msg)) return;
  state.columns.splice(idx, 1);
  state.dirty = true;
  renderTeamBoard(tab);
}

// Persist the working model as ONE whole-file write of the NORMALIZED config to
// tasks/team-config.json (creating tasks/ if needed). The board reflects it on its
// next poll (it reads the same file). On success the panel re-reads disk so it
// mirrors exactly what was persisted (last write wins).
async function saveTeamBoardConfig(tab) {
  const state = tab.teamBoard;
  if (!state || !tab.folder) return;
  const btn = tab.els.teamBoardSaveBtn;
  const content = tasksSerializeTeamConfig(state);
  const tasksDir = tasksJoin(tab.folder, 'tasks');
  const cfgPath = tasksJoin(tasksDir, 'team-config.json');
  if (btn) btn.disabled = true;
  try {
    // The tasks/ parent may not exist yet (or was deleted mid-edit) — mkdir -p it.
    try { await window.api.fs.mkdir(tasksDir); } catch (_) {}
    const res = await window.api.fs.writeFile(cfgPath, content);
    if (!res || !res.ok) {
      state.notice = 'Save failed: ' + ((res && res.error) || 'unknown error') + '. Your edits were kept — try again.';
      renderTeamBoard(tab);
      return;
    }
  } catch (e) {
    state.notice = 'Save failed: ' + ((e && e.message) || String(e)) + '. Your edits were kept — try again.';
    renderTeamBoard(tab);
    return;
  } finally {
    if (btn) btn.disabled = false;
  }
  // Re-read so the panel shows exactly the persisted (normalized) config.
  refreshTeamBoard(tab);
}

// Render-signature fragment for the team config + agent set (TASK-101): a config
// edit (new / renamed / re-ordered column, agent or description change) or an
// agent file added/removed changes this string, so the board re-renders within a
// poll tick even when no ticket file changed.
function tasksConfigSig(config, agentNames) {
  const cols = normalizeTasksColumns(config)
    .map((c) => `${c.status}:${c.label}:${c.description}:${c.agent || ''}:${c.system ? 1 : 0}`)
    .join('|');
  const agents = agentNames ? Array.from(agentNames).sort().join(',') : '';
  return cols + '#' + agents;
}

const TASKS_POLL_MS = 2500;

// Which task card is currently being dragged, and the status it started in
// (TASK-007). Used to scope intra-lane reordering to `todo`-to-`todo` drags so a
// cross-lane drag still falls through to the lane drop handler (status change).
let draggingTaskFile = null;
let draggingTaskStatus = null;

// Join path parts using the base path's own separator convention (inferred via
// appendPath): backslash for Windows paths from the main process, forward slash
// for POSIX. Windows output is byte-identical to the previous '\\' default.
function tasksJoin(...parts) {
  return parts.reduce((acc, p) => appendPath(acc, p));
}

// The two mirrored `.claude/`↔`assets/` subtrees. Renderer duplicate of
// lib/assets-mirror.js MIRRORED_SUBTREES: the renderer is a browser script that
// cannot require Node modules, so it mirrors the tiny mapping (the same
// duplication convention lib/ticket-lanes.js documents). KEEP IN SYNC with the
// lib module.
const ASSETS_MIRRORED_SUBTREES = [
  { from: '.claude/agents/', to: 'assets/agents/' },
  { from: '.claude/skills/orchestrate/', to: 'assets/skills/orchestrate/' },
];

// Renderer duplicate of lib/assets-mirror.js mirrorRelPath: map a project-root-
// relative path to its `assets/…` mirror path, or null when it is not one of the
// two mirrored subtrees. Handles `/` and `\`, never throws. KEEP IN SYNC.
function mirrorRelPath(relPath) {
  if (typeof relPath !== 'string') return null;
  const norm = relPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  for (const { from, to } of ASSETS_MIRRORED_SUBTREES) {
    if (norm.startsWith(from) && norm.length > from.length) return to + norm.slice(from.length);
  }
  return null;
}

// The `tab.folder`-relative path of an absolute path (Windows-style, case-
// insensitive prefix match), or null when `absPath` is not inside the project
// folder. Returns a `/`-separated remainder so mirrorRelPath can map it.
function relFromFolder(folder, absPath) {
  if (typeof folder !== 'string' || typeof absPath !== 'string') return null;
  const nf = folder.replace(/\\/g, '/').replace(/\/+$/, '');
  const na = absPath.replace(/\\/g, '/');
  if (nf === '') return null;
  if (na.toLowerCase().startsWith(nf.toLowerCase() + '/')) return na.slice(nf.length + 1);
  return null;
}

// Write `content` to `absPath` and, when that file belongs to a mirrored
// `.claude/`↔`assets/` subtree AND the mirror file already exists, write the
// identical bytes to the mirror too (TASK-093, Q6 assets drift-guard).
//
// Signature:  writeWithMirror(tab, absPath, content) -> Promise<result>
// Contract:
//   - Primary write fails      -> returns the primary result ({ ok:false, error })
//                                 and NO mirror write is attempted.
//   - No mirror mapping, or the mirror file does not already exist
//                              -> returns the primary result ({ ok:true, size, mirrored:false }).
//                                 Never CREATES a mirror that did not exist.
//   - Mirror exists, write ok  -> returns { ok:true, size, mirrored:true, mirrorPath }.
//   - Mirror exists, write fails -> returns { ok:false, mirrorError, primaryOk:true, mirrorPath }
//                                 while the primary write stands; the caller should show a
//                                 drift warning.
async function writeWithMirror(tab, absPath, content, opts) {
  // TASK-127: `opts` (e.g. { exclusive: true }) applies to the PRIMARY write
  // ONLY. The `assets/` mirror below is a generated copy that legitimately
  // overwrites an existing mirror, so it never opts into exclusive-create —
  // otherwise syncing an existing mirror would fail with EEXIST and regress an
  // otherwise-successful save into a partial failure.
  const primary = await window.api.fs.writeFile(absPath, content, opts);
  if (!primary || !primary.ok) return primary;

  const rel = relFromFolder(tab && tab.folder, absPath);
  const mirrorRel = mirrorRelPath(rel);
  if (!mirrorRel) return { ...primary, mirrored: false };

  // --- F2 (TASK-114): lexically canonicalize + contain the mirror path. -----
  // `mirrorRel` is a `/`-separated, folder-relative path beginning with
  // `assets/`, but `relFromFolder` returns the RAW remainder, so a crafted
  // primary like `<folder>/.claude/agents/../../../evil.md` maps to
  // `assets/agents/../../../evil.md` (escaping the folder) and
  // `.claude/agents/../../tasks/x.md` maps to `assets/agents/../../tasks/x.md`
  // (inside the folder but outside `assets/`). Resolve `.`/`..` lexically
  // (separators are already normalised to `/` upstream by relFromFolder /
  // mirrorRelPath) and skip the mirror step ENTIRELY — no exists, no write —
  // unless the resolved path stays strictly inside `tab.folder` AND under its
  // `assets/` subtree, matching relFromFolder's case-insensitive, separator-
  // tolerant, trailing-slash-normalised containment. The single canonical path
  // below is used for BOTH fs.exists and fs.writeFile.
  //
  // RESIDUAL LIMITATIONS (cannot be closed from the renderer):
  //  1. TOCTOU — the mirror is exists-checked and then written as two separate
  //     IPC calls; another process could create/delete it in between. The mirror
  //     is a generated copy that must OVERWRITE an existing mirror, so it does
  //     NOT use the exclusive-create (flag:'wx') primitive TASK-127 added to
  //     fs:writeFile (that guard is for create-new PRIMARY writes only). The
  //     containment-checked canonical path is a mitigation here, not a race-free
  //     guarantee.
  //  2. Symlinks — this check is purely LEXICAL. A symlinked `assets/` (or any
  //     path component) could still redirect the write outside the folder;
  //     there is no realpath IPC to resolve it. Documented, not fixed.
  const segs = mirrorRel.replace(/\\/g, '/').split('/');
  const stack = [];
  let escaped = false;
  for (const seg of segs) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (stack.length === 0) { escaped = true; break; } // climbs above the folder root
      stack.pop();
      continue;
    }
    stack.push(seg);
  }
  if (escaped || stack.length === 0) return { ...primary, mirrored: false };

  // The single canonical mirror path (no `.`/`..`), built with tab.folder's own
  // separator convention — byte-identical to the pre-canonicalization path for
  // the benign case.
  const mirrorPath = tasksJoin(tab.folder, ...stack);

  // Strictly inside tab.folder (relFromFolder: case-insensitive, separator- and
  // trailing-slash-tolerant) AND under its `assets/` subtree.
  const canonRel = relFromFolder(tab.folder, mirrorPath);
  if (!canonRel) return { ...primary, mirrored: false };
  if (!/^assets\//i.test(canonRel.replace(/\\/g, '/'))) return { ...primary, mirrored: false };

  // Never create a mirror that does not already exist — only sync existing ones.
  const ex = await window.api.fs.exists(mirrorPath);
  if (!ex || !ex.ok || !ex.exists) return { ...primary, mirrored: false };

  const mres = await window.api.fs.writeFile(mirrorPath, content);
  if (!mres || !mres.ok) {
    return { ok: false, primaryOk: true, mirrorPath, mirrorError: (mres && mres.error) || 'mirror write failed' };
  }
  return { ...primary, mirrored: true, mirrorPath };
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

// "Won't do" resolution (TASK-074). The user can decline any ticket via the modal
// status select; the decision is persisted as `status: done` + a `resolution:
// wont-do` frontmatter key (a locked decision — no status-enum change). This
// predicate is the single source of truth for both the modal round-trip (select
// "Won't do" when re-opening) and the struck-through card render. Only exactly
// `wont-do` (trimmed) counts — any other `resolution` value (e.g. `fixed`) is a
// plain done ticket and never triggers the won't-do treatment. Derived purely from
// persisted frontmatter so it appears/clears on the normal poll cycle.
function isWontDoTicket(fm) {
  return !!fm && fm.status === 'done' &&
    ticketFieldNonEmpty(fm.resolution) && String(fm.resolution).trim() === 'wont-do';
}

// Board search matcher (TASK-132). Pure, top-level, and side-effect-free so it can
// be extracted and exercised headlessly under `node --test` (the pattern used by
// test/helpers/task-101-lane-harness.js). A ticket matches when `query`, once
// trimmed and lowercased, is a literal substring of the ticket's id, title, or
// body (also lowercased). An empty or whitespace-only query matches everything, so
// the board renders identically to no-filter. Matching is done with
// String.prototype.includes — never a RegExp built from user input — so regex
// metacharacters ( ( ) [ ] * . \ + ? ) are treated as plain text and can never
// throw or cause ReDoS. Tolerates a null/undefined ticket and missing/empty
// fm.title / body without throwing.
function taskMatchesSearch(tk, query) {
  const q = (query == null ? '' : String(query)).trim().toLowerCase();
  if (q === '') return true;
  if (!tk) return false;
  const fm = tk.fm || {};
  const id = fm.id == null ? '' : String(fm.id);
  const title = fm.title == null ? '' : String(fm.title);
  const body = tk.body == null ? '' : String(tk.body);
  const hay = (id + '\n' + title + '\n' + body).toLowerCase();
  return hay.includes(q);
}

// Ticket "type" markers (TASK-075). A thin colored bar on each board card encodes
// the ticket's type, derived purely from persisted frontmatter (no title text, no
// new state) so it updates within one board poll once the file changes on disk. A
// non-empty `bug-of` marks a bug ticket (red); a non-empty `review-of` marks a PR
// review ticket (yellow, the marker shipped by TASK-074's create-review flow).
// Everything else is a plain ticket (green default). Both are trimmed-non-empty
// checks (ticketFieldNonEmpty), never raw-string truthiness. Precedence: bug wins
// when both markers are present.
function isBugTicket(fm) {
  return !!fm && ticketFieldNonEmpty(fm['bug-of']);
}
function isReviewTicket(fm) {
  return !!fm && ticketFieldNonEmpty(fm['review-of']);
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
// Driven by the valid-statuses set so both post-processing and failed-testing own
// their own subfolders (failed-testing has no lane but still files into
// tasks/failed-testing/). Mirrors folderForStatus in lib/ticket-folders.js.
function ticketFolderForStatus(status) {
  return TASKS_VALID_STATUSES.includes(status) ? status : null;
}

// True when the folder a file currently sits in (relative to tasks/, '' = top
// level) already matches the folder its frontmatter status calls for.
function ticketFolderMatchesStatus(folder, status) {
  const target = ticketFolderForStatus(status);
  return target != null && (folder || '') === target;
}

// SECURITY (TASK-102): a status slug is only ever turned into a `tasks/<slug>/`
// folder path AFTER this gate confirms it is filesystem-safe — lowercase
// [a-z0-9-] only, length-bounded, and free of any `.`/`..`/path separator. This
// is the same shape normalizeTasksColumns already enforces on user column slugs,
// re-checked here as a belt-and-braces guard so an arbitrary/untrusted status
// string (a removed column, a hand-edited frontmatter status, out-of-enum junk)
// can NEVER be used to build a folder path for mkdir/rename. Every system status
// (todo … done, failed-testing, post-processing) also satisfies this.
function isSafeTasksSlug(status) {
  if (typeof status !== 'string') return false;
  if (status.length === 0 || status.length > TASKS_MAX_SLUG_LENGTH) return false;
  if (status === '.' || status === '..') return false;
  if (status.includes('/') || status.includes('\\')) return false;
  return TASKS_SLUG_RE.test(status);
}

// Config-aware folder target (TASK-102). Mirrors folderForStatusWith in
// lib/ticket-folders.js: the subfolder (relative to tasks/) a ticket with
// `status` belongs in given the set of VALIDATED user column slugs `userStatuses`
// (from tasksUserStatusSet(normalizeTasksColumns(config))). A fixed valid system
// status owns tasks/<status>/; a configured user column owns tasks/<slug>/;
// anything else — including a status whose column was REMOVED from the config —
// owns NO folder (null → left in place, routed to `unknown`, never relocated).
// The isSafeTasksSlug gate means only allowlisted, filesystem-safe slugs are ever
// returned as a folder name. With no/empty `userStatuses` this is exactly
// ticketFolderForStatus (system-only).
function ticketFolderForStatusWith(status, userStatuses) {
  if (TASKS_VALID_STATUSES.includes(status)) return status;
  if (userStatuses && userStatuses.has && userStatuses.has(status) && isSafeTasksSlug(status)) {
    return status;
  }
  return null;
}

// True when the folder a file sits in already matches the folder its status
// calls for under `userStatuses` (config-aware mirror of ticketFolderMatchesStatus).
function ticketFolderMatchesStatusWith(folder, status, userStatuses) {
  const target = ticketFolderForStatusWith(status, userStatuses);
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
// Config-aware (TASK-102): when the caller passes the folder's validated user
// status set, a user-column ticket prefers its folder-matching copy exactly like
// a system-status one (matching lib/ticket-folders.js dedupeByFolder). Omitting
// `userStatuses` degrades to the fixed system-only behaviour so existing callers
// are unchanged.
function dedupeTicketsByFolder(entries, userStatuses) {
  const byId = new Map();
  for (const e of entries) {
    const id = e.fm.id;
    if (id == null) continue;
    if (!byId.has(id)) { byId.set(id, e); continue; }
    const cur = byId.get(id);
    if (ticketFolderMatchesStatusWith(e.folder, e.fm.status, userStatuses) &&
        !ticketFolderMatchesStatusWith(cur.folder, cur.fm.status, userStatuses)) {
      byId.set(id, e);
    }
  }
  return Array.from(byId.values());
}

// Newline-neutralize a single-line frontmatter value (TASK-041). Frontmatter is a
// flat, one-key-per-physical-line contract, and parseTicketFrontmatter treats any
// embedded newline as the start of a new line (a forged `key: value`, or a
// premature `---` close). Collapsing CR/LF to a single space keeps each emitted
// value on one physical line so an untrusted `title` (bug/create path) cannot
// inject frontmatter keys or close the block early after a serialize→parse
// round-trip. Values with no CR/LF are byte-identical to before.
function frontmatterValueLine(v) {
  return String(v).replace(/[\r\n]+/g, ' ');
}

// Serialize back to disk, preserving the body verbatim and writing frontmatter
// keys in a fixed order (unknown keys kept, appended after the known ones). Each
// frontmatter value is newline-neutralized (see frontmatterValueLine) so the flat
// one-line-per-key contract holds for every key regardless of caller; the body is
// left free-form.
function serializeTicket(fm, body) {
  const order = ['id', 'title', 'status', 'created', 'updated'];
  const keys = order.filter((k) => fm[k] != null);
  for (const k of Object.keys(fm)) if (!keys.includes(k)) keys.push(k);
  const fmLines = keys.map((k) => `${k}: ${frontmatterValueLine(fm[k])}`);
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

// ── Per-activity cost view (TASK-070) display helpers ──────────────────────
// Read-only mirror of lib/ticket-cost.js for the browser side, which cannot
// require Node modules (matching how TASK-003/005/007/008/012 duplicated the tiny
// pure helpers). The orchestrator appends one activity entry per dispatched phase
// — { activity, model, startedAt, finishedAt, durationMs, tokensIn, tokensOut,
// costUsd } — to a JSON array kept on a single flat `activities` frontmatter
// field, giving a complete cost breakdown by activity (ba/code/test/review/
// post-processing/…). These helpers parse, sum and format that log for display.

// Parse the `activities` JSON array off a frontmatter object into an array of
// entries. Tolerant: absent / non-string / invalid-JSON / non-array / non-object
// members all yield a clean array (bad members filtered) so a hand-edited or
// corrupt ticket never throws while rendering. Mirrors parseActivities in
// lib/ticket-cost.js.
function parseTicketActivities(fm) {
  const raw = fm ? fm.activities : null;
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

// Sum durationMs / tokensIn / tokensOut / costUsd across a parsed activity array,
// counting only valid present values; a total is null when NO entry carried that
// field (never NaN, never a fabricated 0). Mirrors totalActivities in
// lib/ticket-cost.js and the isValidAmount gate.
function totalTicketActivities(activities) {
  const list = Array.isArray(activities) ? activities : [];
  const valid = (v) => {
    if (v == null || v === '') return false;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) && n >= 0;
  };
  const acc = { durationMs: null, tokensIn: null, tokensOut: null, costUsd: null };
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    for (const k of ['durationMs', 'tokensIn', 'tokensOut', 'costUsd']) {
      if (valid(e[k])) acc[k] = (acc[k] == null ? 0 : acc[k]) + Number(e[k]);
    }
  }
  return acc;
}

// Compact wall-clock label for a millisecond duration, e.g. "4m 30s". '' when
// absent/malformed. Reuses the h/m/s shaping of formatBuildDuration.
function formatDurationMs(v) {
  if (v == null || v === '') return '';
  const ms = Number(v);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

// One display line per activity: "<activity> · <model> · <duration> · in/out ·
// <cost>", dropping any fragment that is absent. Empty array in => empty array out.
function ticketActivityLines(fm) {
  return parseTicketActivities(fm).map((a) => {
    const bits = [];
    if (a.activity != null && String(a.activity).trim() !== '') bits.push(String(a.activity).trim());
    if (a.model != null && String(a.model).trim() !== '') bits.push(String(a.model).trim());
    const dur = formatDurationMs(a.durationMs);
    if (dur) bits.push(dur);
    const tin = formatTokens(a.tokensIn);
    const tout = formatTokens(a.tokensOut);
    if (tin || tout) {
      const inLbl = tin ? tin.replace(/ tok$/, '') : '—';
      const outLbl = tout ? tout.replace(/ tok$/, '') : '—';
      bits.push(`${inLbl}↑/${outLbl}↓ tok`);
    }
    const cost = formatCostUsd(a.costUsd);
    if (cost) bits.push(cost);
    return bits.join('   ·   ');
  }).filter((line) => line !== '');
}

// Totals display line summing the activity log, e.g. "Total: 6m 12s · 20k↑/5k↓
// tok · $0.42", dropping absent fragments. '' when the log carries no summable data.
function ticketActivityTotalLine(fm) {
  const totals = totalTicketActivities(parseTicketActivities(fm));
  const bits = [];
  const dur = formatDurationMs(totals.durationMs);
  if (dur) bits.push(dur);
  const tin = totals.tokensIn != null ? formatTokens(totals.tokensIn) : '';
  const tout = totals.tokensOut != null ? formatTokens(totals.tokensOut) : '';
  if (tin || tout) {
    const inLbl = tin ? tin.replace(/ tok$/, '') : '—';
    const outLbl = tout ? tout.replace(/ tok$/, '') : '—';
    bits.push(`${inLbl}↑/${outLbl}↓ tok`);
  }
  const cost = totals.costUsd != null ? formatCostUsd(totals.costUsd) : '';
  if (cost) bits.push(cost);
  return bits.length ? `Total: ${bits.join('   ·   ')}` : '';
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

// Stale-done archiving (TASK-065). Mirrors ARCHIVE_AFTER_MS / isArchived in
// lib/ticket-archive.js for the browser side, which cannot require Node modules;
// keep in sync. Archiving is DERIVED (no new status, no file move): a done
// ticket whose last activity (fm.updated, else fm.created) is strictly more than
// TASKS_ARCHIVE_AFTER_MS old is folded out of the normal Done list into the
// collapsible "Archived (N)" expander. Every failure mode is fail-safe (show,
// don't hide): non-done status, missing/invalid timestamp, missing/invalid
// `now`, exactly-at-or-under the threshold (strict >), or a future timestamp
// (negative age) → not archived. `now` is injected by the caller; Date.now() is
// fine at the CALL SITE (like formatBuildDuration), never inside this predicate.
const TASKS_ARCHIVE_AFTER_DAYS = 5;
const TASKS_ARCHIVE_AFTER_MS = TASKS_ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000;
function ticketArchiveTimestamp(fm) {
  if (!fm) return null;
  const parse = (v) => {
    if (v == null || v === '') return null;
    const n = new Date(String(v).trim()).getTime();
    return Number.isNaN(n) ? null : n;
  };
  const updated = parse(fm.updated);
  if (updated != null) return updated;
  return parse(fm.created);
}
function ticketIsArchived(fm, now) {
  if (!fm || fm.status !== 'done') return false;
  const nowMs = typeof now === 'number' ? (Number.isFinite(now) ? now : null)
    : (now instanceof Date ? (Number.isNaN(now.getTime()) ? null : now.getTime()) : null);
  if (nowMs == null) return false;
  const ts = ticketArchiveTimestamp(fm);
  if (ts == null) return false;
  const age = nowMs - ts;
  if (age < 0) return false;
  return age > TASKS_ARCHIVE_AFTER_MS;
}

// Wipe board state when the tab switches to a different folder, then re-init if
// the Tasks tab is the one currently showing.
// Board search wiring (TASK-132). These three helpers own the search-input side of
// the filter; the actual filtering lives in renderTasksBoard, which reads
// tab.tasks.searchQuery live. Kept tiny and synchronous — the input handler must
// never await (per the ticket) so typing stays responsive on large boards.
function updateTasksSearchClear(tab) {
  const btn = tab.els && tab.els.tasksSearchClear;
  if (!btn) return;
  const hasText = !!(tab.els.tasksSearch && tab.els.tasksSearch.value);
  btn.classList.toggle('hidden', !hasText);
}
function onTasksSearchInput(tab) {
  tab.tasks.searchQuery = tab.els.tasksSearch ? tab.els.tasksSearch.value : '';
  updateTasksSearchClear(tab);
  renderTasksBoard(tab);
}
function clearTasksSearch(tab) {
  const had = (tab.tasks.searchQuery || '').trim() !== '' ||
    !!(tab.els.tasksSearch && tab.els.tasksSearch.value);
  tab.tasks.searchQuery = '';
  if (tab.els.tasksSearch) tab.els.tasksSearch.value = '';
  updateTasksSearchClear(tab);
  if (had) renderTasksBoard(tab);
}

function resetTasksForFolder(tab) {
  stopTasksPolling(tab);
  tab.tasks.tickets = new Map();
  tab.tasks.lastSig = '';
  tab.tasks.skillInstalled = null;
  tab.tasks.autoBuild = false;
  // Team config + agent set belong to the folder (TASK-101): drop them on a
  // folder switch so a previous folder's lanes/badges never leak in before the
  // new folder's first poll (a null config → the six default lanes).
  tab.tasks.config = null;
  tab.tasks.agentNames = null;
  // Archived-done expander (TASK-065) is collapsed by default per folder; its
  // open/closed state is UI-only and must survive board re-renders but reset when
  // the tab switches folders.
  tab.tasks.archiveExpanded = false;
  // Board search (TASK-132) is session-only and folder-scoped: clear both the
  // stored query and the input value so a previous folder's filter never carries
  // over. The clear-button visibility is refreshed to match the now-empty box.
  tab.tasks.searchQuery = '';
  if (tab.els.tasksSearch) tab.els.tasksSearch.value = '';
  updateTasksSearchClear(tab);
  for (const laneEl of tab.els.tasksBoard.querySelectorAll('.tasks-lane')) {
    const cards = laneEl.querySelector('.tasks-lane-cards');
    if (cards) cards.innerHTML = '';
    const countEl = laneEl.querySelector('.tasks-lane-count');
    if (countEl) countEl.textContent = '0';
  }
  tab.els.tasksStatus.textContent = '';
  tab.els.tasksEmpty.classList.add('hidden');
  if (tab.els.tasksNoMatch) tab.els.tasksNoMatch.classList.add('hidden');
  tab.els.tasksSkillBanner.classList.add('hidden');
  tab.els.tasksNewBtn.disabled = true;
  updateBuildBtn(tab);
  updatePlanBtn(tab);
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
    updatePlanBtn(tab);
    return;
  }
  tab.els.tasksNewBtn.disabled = false;
  checkOrchestrateSkill(tab);
  startTasksPolling(tab);
}

// Team sub-tab (TASK-091). Scaffold only: three placeholder sections
// (Agents / Workflow / Board) that later tickets fill. With no folder open we
// show an "(open a folder)" empty state and leave every section body empty;
// once a folder is open the three sections are shown. Safe to call repeatedly
// (no listeners are bound here), mirroring initTasksTab's re-activation guard.
function initTeamTab(tab) {
  if (!tab.folder) {
    // Deliberate per-section empty state: the "(open a folder)" literal is set on
    // the status AND all three section bodies (unlike initTasksTab's single-status
    // pattern). The static HTML ships this literal in every body, but writing it
    // here too clears any stale content left over from a folder→no-folder switch;
    // blanking the bodies instead would leave bare section frames. Keep as-is.
    tab.els.teamStatus.textContent = '(open a folder)';
    tab.els.teamAgentsBody.textContent = '(open a folder)';
    tab.els.teamWorkflowBody.textContent = '(open a folder)';
    tab.els.teamBoardBody.textContent = '(open a folder)';
    return;
  }
  tab.els.teamStatus.textContent = '';
  // Agents panel (TASK-094) reads .claude/agents/ from disk each activation.
  refreshTeamAgents(tab);
  // Workflow panel (TASK-105): read-only pipeline view of the orchestrate skill.
  refreshTeamWorkflow(tab);
  // Board panel (TASK-103): column manager over tasks/team-config.json.
  refreshTeamBoard(tab);
}

// ── Team tab · Workflow panel (TASK-105) ────────────────────────────────────
// Read-only pipeline visualization of the project's orchestrate skill. Reads
// `.claude/skills/orchestrate/SKILL.md` and renders the four ordered phases
// (plan → build → test → review) with each phase's dispatched agent, the
// planning model directive, and the general-purpose fallback rule. This panel
// NEVER writes SKILL.md (clarification Q3) — it is a pure read/render surface.
//
// Renderer-duplication convention: this renderer is a browser script and cannot
// `require` lib/skill-workflow.js (TASK-096) or lib/orchestrate-agents.js, so —
// exactly as those modules document — the tiny parse/agent-resolution slice they
// own is mirrored inline below. lib/skill-workflow.js is the SOURCE OF TRUTH;
// keep this mirror in lockstep — changing one without the other is a bug.

// Mirror of FALLBACK_AGENT / AGENT_TYPES / AGENT_NAMES (lib/orchestrate-agents.js).
const WF_FALLBACK_AGENT = 'general-purpose';
const WF_AGENT_TYPES = {
  ba: 'orchestrate-ba',
  coder: 'orchestrate-coder',
  tester: 'orchestrate-tester',
  techLead: 'orchestrate-tech-lead'
};
const WF_AGENT_NAMES = [
  WF_AGENT_TYPES.ba,
  WF_AGENT_TYPES.coder,
  WF_AGENT_TYPES.tester,
  WF_AGENT_TYPES.techLead
];

// Mirror of PHASE_SPECS / model-directive constants (lib/skill-workflow.js).
const WF_PHASE_SPECS = [
  { key: 'plan', number: 1, label: 'plan', agent: WF_AGENT_TYPES.ba },
  { key: 'build', number: 2, label: 'build', agent: WF_AGENT_TYPES.coder },
  { key: 'test', number: 3, label: 'test', agent: WF_AGENT_TYPES.tester },
  { key: 'review', number: 4, label: 'review', agent: WF_AGENT_TYPES.techLead }
];
const WF_PLAN_MODEL_PRIMARY = 'claude-opus-4-8';
const WF_PLAN_MODEL_FALLBACK = 'claude-sonnet-5';

// Mirror of isFallback (lib/orchestrate-agents.js): true when dispatch would fall
// back to general-purpose for `name`. Faithful to the lib's resolveAgentType +
// isFallback composition: a non-string / empty `name` resolves to the fallback
// (so it IS a fallback), an absent `name` (not in the `available` array) is a
// fallback, and a present `name` is not. `name` === the fallback itself is never
// flagged. (`available` is an array of agent names, as this mirror is only ever
// called with the resolved `name:` set.)
function wfIsFallback(name, available) {
  let resolved;
  if (typeof name !== 'string' || name === '') {
    resolved = WF_FALLBACK_AGENT;
  } else {
    const has = Array.isArray(available) && available.includes(name);
    resolved = has ? name : WF_FALLBACK_AGENT;
  }
  return resolved === WF_FALLBACK_AGENT && name !== WF_FALLBACK_AGENT;
}

// Mirror of headingName (lib/skill-workflow.js): a `## <text>` level-2 heading.
function wfHeadingName(line) {
  const m = /^\s*##\s+(.*?)\s*$/.exec(line);
  return m ? m[1] : null;
}

// Mirror of phaseNumberOf: the `Phase <n>` number a heading declares, or null.
function wfPhaseNumberOf(headingText) {
  const m = /^Phase\s+(\d+)\b/i.exec(headingText);
  return m ? Number(m[1]) : null;
}

// Mirror of agentIn: first known orchestrate-* agent name appearing in `text`.
function wfAgentIn(text) {
  const re = /orchestrate-[a-z-]+/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[0].toLowerCase();
    if (WF_AGENT_NAMES.includes(name)) return name;
  }
  return null;
}

// Mirror of modelDirectiveIn: { primary, fallback } for the Phase-1 model, else null.
function wfModelDirectiveIn(text) {
  if (!/claude-opus-4-8/i.test(text)) return null;
  let fallback = null;
  const re = /claude-[a-z0-9.-]+/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const token = m[0].toLowerCase();
    if (token !== WF_PLAN_MODEL_PRIMARY) { fallback = token; break; }
  }
  return { primary: WF_PLAN_MODEL_PRIMARY, fallback: fallback || WF_PLAN_MODEL_FALLBACK };
}

// Mirror of sectionsOf: fence-aware split into level-2 sections.
function wfSectionsOf(md) {
  const lines = String(md).split(/\r?\n/);
  const sections = [];
  let current = null;
  let inFence = false;
  let fenceMarker = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(`{3,}|~{3,})\s*\S*\s*$/.exec(line);
    if (fence) {
      const marker = fence[1][0];
      if (!inFence) { inFence = true; fenceMarker = marker; }
      else if (marker === fenceMarker) { inFence = false; }
      if (current) current.lines.push(line);
      continue;
    }
    if (!inFence) {
      const h = wfHeadingName(line);
      if (h != null) {
        current = { name: h, startLine: i + 1, lines: [] };
        sections.push(current);
        continue;
      }
    }
    if (current) current.lines.push(line);
  }
  return sections;
}

// Mirror of agentFromDispatch: agent named on the dispatch line mentioning `Phase <n>`.
function wfAgentFromDispatch(dispatchText, number) {
  if (!dispatchText) return null;
  const lines = dispatchText.split(/\r?\n/);
  const re = new RegExp('Phase\\s+' + number + '\\b', 'i');
  for (const line of lines) {
    if (re.test(line)) {
      const agent = wfAgentIn(line);
      if (agent) return agent;
    }
  }
  return null;
}

// Mirror of parseWorkflow: SKILL.md content → { phases, warnings }. Tolerant of
// any non-string/garbage input; never throws; phases in canonical order.
function wfParseWorkflow(skillMd) {
  const warnings = [];
  if (typeof skillMd !== 'string') {
    warnings.push('SKILL.md content is not a string; no workflow parsed.');
    return { phases: [], warnings };
  }
  try {
    const sections = wfSectionsOf(skillMd);

    const phaseSectionByNumber = new Map();
    for (const section of sections) {
      const num = wfPhaseNumberOf(section.name);
      if (num != null && !phaseSectionByNumber.has(num)) {
        phaseSectionByNumber.set(num, section);
      }
    }

    const dispatchSection = sections.find(s => /dispatch/i.test(s.name)
      && /fallback/i.test(s.name));
    const dispatchText = dispatchSection ? dispatchSection.lines.join('\n') : '';

    const phases = [];
    for (const spec of WF_PHASE_SPECS) {
      const section = phaseSectionByNumber.get(spec.number);
      if (!section) {
        warnings.push(
          `Missing Phase ${spec.number} (${spec.label}) heading in SKILL.md.`
        );
        continue;
      }
      const bodyText = section.lines.join('\n');

      const agent = wfAgentFromDispatch(dispatchText, spec.number)
        || wfAgentIn(bodyText)
        || spec.agent;

      const phase = {
        key: spec.key,
        title: section.name,
        agent,
        headingLine: section.startLine
      };

      if (spec.number === 1) {
        const model = wfModelDirectiveIn(dispatchText) || wfModelDirectiveIn(bodyText);
        if (model) phase.model = model;
      }

      phases.push(phase);
    }

    return { phases, warnings };
  } catch (_) {
    return { phases: [], warnings: warnings.concat('Could not parse SKILL.md.') };
  }
}

// Re-read SKILL.md and render the read-only pipeline. Bound to the Workflow
// Refresh control and called on Team-tab activation (initTeamTab). There is NO
// background polling and NO write path here. Skill absent → install banner (the
// same tasks:installSkill flow the Tasks board and Agents panel use). Installed
// but empty/binary/unreadable → a warning (never a blank panel). Stale-guarded
// against the folder/tab changing mid-await.
async function refreshTeamWorkflow(tab) {
  const body = tab.els.teamWorkflowBody;
  if (!body) return;
  if (!tab.folder) { body.textContent = '(open a folder)'; return; }
  body.textContent = 'Loading…';

  // Cross-check dispatch targets against the real .claude/agents/ by each agent's
  // frontmatter `name:` value — NOT its filename — mirroring resolveAgentType/
  // isFallback (lib/orchestrate-agents.js), where a phase agent is "installed" iff
  // some agent file DECLARES that `name:`. The bundled files ship as
  // ba.md/coder.md/tester.md/tech-lead.md but declare `name: orchestrate-*`, so the
  // basename list (readTeamAgentNames, used by the agent select/badges) would flag
  // every phase as a general-purpose fallback. Resolve the `name:` set here instead.
  // As well as the installed `name:` set (for fallback detection), capture each
  // agent's file path + full parsed frontmatter keyed by its `name:` — the
  // per-phase model editor (TASK-106) rewrites that agent's file, and the file is
  // identified by its declared `name:`, NOT its basename (matching the resolution
  // rule above). Unparseable/nameless files are skipped (no editor, no name).
  const agentNames = [];
  const agentFiles = new Map(); // frontmatter name -> { filePath, parsed }
  {
    const agentsDir = tasksJoin(tab.folder, '.claude', 'agents');
    let files = [];
    try {
      const fr = await window.api.fs.findByExt(agentsDir, '.md');
      if (fr && fr.ok && Array.isArray(fr.files)) files = fr.files;
    } catch (err) {
      console.error('[team workflow agents]', err);
    }
    if (tab.els.teamWorkflowBody !== body) return;
    for (const fp of files) {
      let content = null;
      try {
        const rr = await window.api.fs.readFile(fp);
        if (rr && rr.ok && !rr.binary && typeof rr.content === 'string') content = rr.content;
      } catch (err) {
        console.error('[team workflow agent read]', err);
      }
      if (tab.els.teamWorkflowBody !== body) return;
      if (typeof content !== 'string') continue;
      const parsed = parseAgentFileRenderer(content);
      if (!parsed || !parsed.fm) continue; // unparseable frontmatter → skip
      const nm = parsed.fm.name != null ? String(parsed.fm.name).trim() : '';
      if (!nm) continue; // no name → cannot map to a phase
      agentNames.push(nm);
      if (!agentFiles.has(nm)) agentFiles.set(nm, { filePath: fp, parsed });
    }
  }
  if (tab.els.teamWorkflowBody !== body) return;

  // Read tasks/team-config.json for the concurrency-default control (part b). A
  // missing/empty/corrupt file → null (the control shows the resolved default).
  // Never throws; stale-guarded against a mid-await folder switch.
  let rawConfig = null;
  try {
    const cfgPath = tasksJoin(tab.folder, 'tasks', 'team-config.json');
    const cfgRes = await window.api.fs.readFile(cfgPath);
    if (tab.els.teamWorkflowBody !== body) return;
    if (cfgRes && cfgRes.ok && !cfgRes.binary && typeof cfgRes.content === 'string'
      && cfgRes.content.trim() !== '') {
      try { rawConfig = JSON.parse(cfgRes.content); } catch (_) { rawConfig = null; }
    }
  } catch (_) { rawConfig = null; }
  if (tab.els.teamWorkflowBody !== body) return;

  const skillPath = tasksJoin(tab.folder, '.claude', 'skills', 'orchestrate', 'SKILL.md');

  // Install state via existence (mirrors checkOrchestrateSkill): a missing
  // SKILL.md shows the install banner, distinct from an installed-but-unreadable
  // file which shows a warning.
  let installed = false;
  try {
    const e = await window.api.fs.exists(skillPath);
    installed = !!(e && e.ok && e.exists);
  } catch (err) {
    console.error('[team workflow exists]', err);
  }
  if (tab.els.teamWorkflowBody !== body) return;
  if (!installed) {
    body.textContent = '';
    body.appendChild(buildWorkflowInstallHint(tab));
    return;
  }

  // Read-only: content is only ever read and rendered, never written.
  let res = null;
  try {
    res = await window.api.fs.readFile(skillPath);
  } catch (err) {
    console.error('[team workflow read]', err);
  }
  if (tab.els.teamWorkflowBody !== body) return;

  body.textContent = '';
  if (!res || !res.ok || res.binary || typeof res.content !== 'string') {
    // Installed but unreadable/binary — degrade to a warning, never blank.
    body.appendChild(buildWorkflowView(tab, {
      phases: [],
      warnings: ['SKILL.md could not be read (empty, binary, or unreadable).']
    }, agentNames, agentFiles, rawConfig));
    return;
  }

  const model = wfParseWorkflow(res.content);
  body.appendChild(buildWorkflowView(tab, model, agentNames, agentFiles, rawConfig));
}

// Install-skill banner shown when SKILL.md is absent. Mirrors the Tasks board
// banner (tasksSkillBanner) and buildAgentsInstallHint, driving the same
// tasks:installSkill IPC; on success the pipeline is re-read and rendered.
function buildWorkflowInstallHint(tab) {
  const banner = document.createElement('div');
  banner.className = 'teamWorkflowHint install-banner';
  const text = document.createElement('div');
  text.className = 'install-banner-text';
  const strong = document.createElement('strong');
  strong.textContent = 'Orchestration skill not installed.';
  const rest = document.createTextNode(' Install it to see the read-only workflow pipeline for this project.');
  text.appendChild(strong);
  text.appendChild(rest);
  banner.appendChild(text);
  const actions = document.createElement('div');
  actions.className = 'install-banner-actions';
  const btn = document.createElement('button');
  btn.className = 'teamWorkflowInstallBtn small-btn primary-btn';
  btn.textContent = 'Install orchestration skill';
  btn.addEventListener('click', async () => {
    if (!tab.folder) return;
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Installing…';
    try {
      const res = await window.api.tasks.installSkill(tab.folder);
      if (!res || !res.ok) {
        strong.textContent = 'Install failed.';
        rest.textContent = ' ' + ((res && res.error) || 'unknown error');
        btn.disabled = false;
        btn.textContent = prev;
        return;
      }
      // Re-read/render the pipeline first (this replaces the install banner), then
      // place the shared restart notice into the now-populated, persistent body
      // (TASK-131). Awaited so the notice survives the re-render.
      await refreshTeamWorkflow(tab);
      promptSkillRegistration(tab, tab.els.teamWorkflowBody);
    } catch (err) {
      console.error('[team workflow installSkill]', err);
      strong.textContent = 'Install failed.';
      rest.textContent = ' ' + ((err && err.message) || String(err));
      btn.disabled = false;
      btn.textContent = prev;
    }
  });
  actions.appendChild(btn);
  banner.appendChild(actions);
  return banner;
}

// Render the parsed workflow model: parse warnings first (so a partially
// parseable SKILL.md is never a blank panel), then each phase card in order.
function buildWorkflowView(tab, model, agentNames, agentFiles, rawConfig) {
  const wrap = document.createElement('div');
  wrap.className = 'team-workflow';

  const warnings = (model && Array.isArray(model.warnings)) ? model.warnings : [];
  const phases = (model && Array.isArray(model.phases)) ? model.phases : [];

  for (const w of warnings) {
    const el = document.createElement('div');
    el.className = 'team-workflow-warning';
    el.textContent = String(w); // textContent only — SKILL.md is untrusted (no XSS)
    wrap.appendChild(el);
  }

  if (phases.length === 0 && warnings.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'team-workflow-empty';
    empty.textContent = 'No workflow phases found in SKILL.md.';
    wrap.appendChild(empty);
  }

  for (const phase of phases) {
    wrap.appendChild(buildWorkflowPhase(tab, phase, agentNames, agentFiles));
  }

  // Build-concurrency default (TASK-106 part b): writes skill.concurrencyDefault
  // into tasks/team-config.json. Independent of the phase cards, so it renders
  // even when SKILL.md parses to no phases.
  wrap.appendChild(buildWorkflowConcurrencyControl(tab, rawConfig));
  return wrap;
}

// Build a working config object (matching tasksSerializeTeamConfig's shape) from a
// raw parsed tasks/team-config.json, preserving columns / version / unknown
// top-level fields so a concurrency-only save never drops the Board panel's
// columns. Tolerates null/junk (→ defaults). Mirror of the split done in
// refreshTeamBoard.
function buildWorkingConfigFromRaw(raw) {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const version = obj.version != null ? obj.version : 1;
  const skill = (obj.skill && typeof obj.skill === 'object' && !Array.isArray(obj.skill))
    ? { ...obj.skill } : {};
  const extra = {};
  for (const k of Object.keys(obj)) {
    if (k === 'version' || k === 'columns' || k === 'skill' || k === 'warnings') continue;
    // `obj` is the on-disk config straight from JSON.parse, so skip prototype-
    // poisoning keys before the plain assignment, mirroring lib/team-config.js
    // normalizeConfig's unknown-top-level-key loop (TASK-116). KEEP IN SYNC.
    if (tasksIsUnsafeKey(k)) continue;
    extra[k] = obj[k];
  }
  const columns = Array.isArray(obj.columns) ? obj.columns : [];
  return { version, skill, extra, columns };
}

// The build-concurrency default control: a [1..TASKS_MAX_CONCURRENCY] <select>
// seeded from skill.concurrencyDefault (resolved/clamped) and a Save that writes
// the WHOLE normalized tasks/team-config.json. Save re-reads the file first so a
// concurrent Board-panel edit's columns are preserved (last write wins on the
// concurrency field only). Write failure surfaces inline.
function buildWorkflowConcurrencyControl(tab, rawConfig) {
  const section = document.createElement('div');
  section.className = 'team-workflow-concurrency';

  const title = document.createElement('div');
  title.className = 'team-workflow-phase-title';
  title.textContent = 'Build concurrency default';
  section.appendChild(title);

  const help = document.createElement('div');
  help.className = 'team-workflow-rule';
  help.textContent = 'How many build agents /orchestrate build may run at once by '
    + 'default. A per-folder choice on the Tasks toolbar overrides this.';
  section.appendChild(help);

  const row = document.createElement('div');
  row.className = 'team-workflow-phase-meta';
  const select = document.createElement('select');
  select.className = 'team-workflow-concurrency-select';
  for (let i = 1; i <= TASKS_MAX_CONCURRENCY; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = String(i);
    select.appendChild(opt);
  }
  const rawDefault = rawConfig && rawConfig.skill && typeof rawConfig.skill === 'object'
    ? rawConfig.skill.concurrencyDefault : undefined;
  // Clamp an out-of-range stored default (e.g. 99 → TASKS_MAX_CONCURRENCY) so the
  // option always exists and a subsequent Save persists the normalized value.
  select.value = String(resolveTasksConcurrency(rawDefault));

  const saveBtn = document.createElement('button');
  saveBtn.className = 'small-btn primary-btn';
  saveBtn.textContent = 'Save';
  row.appendChild(select);
  row.appendChild(saveBtn);
  section.appendChild(row);

  const err = document.createElement('div');
  err.className = 'team-agent-desc-error hidden';
  section.appendChild(err);
  const showErr = (m) => { err.textContent = m; err.classList.remove('hidden'); };
  const clearErr = () => { err.textContent = ''; err.classList.add('hidden'); };

  saveBtn.addEventListener('click', async () => {
    clearErr();
    // Normalize via the resolveConcurrency mirror before persisting.
    const resolved = resolveTasksConcurrency(select.value);
    select.value = String(resolved);
    saveBtn.disabled = true;
    try {
      const cfgPath = tasksJoin(tab.folder, 'tasks', 'team-config.json');
      // Re-read for the freshest columns/unknown fields (avoid clobbering a
      // Board-panel edit). A genuinely-valid re-read is used; but a
      // missing/unreadable/corrupt config at Save time falls back to the
      // render-time rawConfig (keep-last-good) rather than null, so a momentary
      // read/parse failure can't wipe the user's columns/version/skill fields
      // (incl. skill.planningModel) and unknown top-level fields to defaults.
      let fresh = rawConfig;
      try {
        const r = await window.api.fs.readFile(cfgPath);
        if (r && r.ok && !r.binary && typeof r.content === 'string' && r.content.trim() !== '') {
          try { fresh = JSON.parse(r.content); } catch (_) { fresh = rawConfig; }
        }
      } catch (_) { fresh = rawConfig; }
      const working = buildWorkingConfigFromRaw(fresh);
      working.skill = { ...working.skill, concurrencyDefault: resolved };
      const content = tasksSerializeTeamConfig(working);
      const tasksDir = tasksJoin(tab.folder, 'tasks');
      try { await window.api.fs.mkdir(tasksDir); } catch (_) {}
      const res = await window.api.fs.writeFile(cfgPath, content);
      if (!res || !res.ok) {
        showErr('Save failed: ' + ((res && res.error) || 'unknown error') + '. Try again.');
        saveBtn.disabled = false;
        return;
      }
      // Update the in-memory config to exactly what was just persisted so the
      // Tasks toolbar + buildCommandFor pick up the new concurrencyDefault
      // immediately, instead of lagging until the next poll refreshes
      // tab.tasks.config. Mirror the poll by storing the parsed serialized
      // content (the same shape a fresh read would produce).
      if (tab.tasks) { try { tab.tasks.config = JSON.parse(content); } catch (_) {} }
    } catch (e) {
      showErr('Save failed: ' + ((e && e.message) || String(e)) + '. Try again.');
      saveBtn.disabled = false;
      return;
    }
    saveBtn.disabled = false;
    // tab.tasks.config now carries the new default, so reflect it on the Tasks
    // toolbar (only when no per-folder override) and re-read the panel so it
    // mirrors the persisted config.
    syncTasksConcurrencyOption(tab);
    refreshTeamWorkflow(tab);
  });

  return section;
}

// One read-only phase card: the SKILL.md heading, the dispatched agent, an
// explicit missing-agent fallback warning when the dedicated agent is absent
// from .claude/agents/, the always-shown fallback rule, and (Phase 1 only) the
// planning model directive. All dynamic text uses textContent (no innerHTML).
function buildWorkflowPhase(tab, phase, agentNames, agentFiles) {
  const card = document.createElement('div');
  card.className = 'team-workflow-phase';

  const title = document.createElement('div');
  title.className = 'team-workflow-phase-title';
  title.textContent = String(phase.title != null ? phase.title : phase.key);
  card.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'team-workflow-phase-meta';
  const agentLabel = document.createElement('span');
  agentLabel.className = 'team-workflow-meta-label';
  agentLabel.textContent = 'Agent';
  const agentBadge = document.createElement('span');
  agentBadge.className = 'team-agent-badge team-workflow-agent';
  agentBadge.textContent = String(phase.agent);
  meta.appendChild(agentLabel);
  meta.appendChild(agentBadge);
  card.appendChild(meta);

  // Missing-agent fallback warning (mirror of resolveAgentType/isFallback): the
  // dedicated agent has no definition in .claude/agents/, so dispatch falls back.
  const fellBack = wfIsFallback(phase.agent, agentNames);
  if (fellBack) {
    const warn = document.createElement('div');
    warn.className = 'team-workflow-fallback';
    warn.textContent = phase.agent + ' is not defined in .claude/agents/ — '
      + 'dispatch falls back to ' + WF_FALLBACK_AGENT + '.';
    card.appendChild(warn);
  }

  // The fallback rule, always shown (an acceptance criterion): every phase notes
  // that a missing dedicated agent degrades to the general-purpose agent.
  const rule = document.createElement('div');
  rule.className = 'team-workflow-rule';
  rule.textContent = 'Falls back to ' + WF_FALLBACK_AGENT
    + ' when the agent definition is missing.';
  card.appendChild(rule);

  // Per-phase agent-model editor (TASK-106): rewrites ONLY the `model:` scalar of
  // this phase's agent file. Disabled with a note when that file is missing/
  // unparseable (the fallback warning above already flags a missing dedicated
  // agent). Agent DESCRIPTIONS are edited in the Agents panel — not duplicated here.
  const agentFile = (agentFiles instanceof Map) ? agentFiles.get(phase.agent) : null;
  if (agentFile) {
    card.appendChild(buildWorkflowModelEditor(tab, phase, agentFile));
  } else {
    const noEdit = document.createElement('div');
    noEdit.className = 'team-workflow-rule';
    noEdit.textContent = 'Model editor unavailable — no agent file defines '
      + phase.agent + ' in .claude/agents/.';
    card.appendChild(noEdit);
  }

  // Model directive (Phase 1 / plan only), READ-ONLY: this directive lives in
  // SKILL.md, which this panel NEVER writes. The precedence note makes clear it
  // overrides the agent-file model for planning dispatch.
  if (phase.model && phase.model.primary) {
    const modelRow = document.createElement('div');
    modelRow.className = 'team-workflow-phase-meta';
    const modelLabel = document.createElement('span');
    modelLabel.className = 'team-workflow-meta-label';
    modelLabel.textContent = 'SKILL.md model';
    const modelBadge = document.createElement('span');
    modelBadge.className = 'team-agent-badge team-workflow-model';
    modelBadge.textContent = String(phase.model.primary);
    modelRow.appendChild(modelLabel);
    modelRow.appendChild(modelBadge);
    if (phase.model.fallback) {
      const arrow = document.createElement('span');
      arrow.className = 'team-workflow-model-fallback';
      arrow.textContent = '→ falls back to ' + phase.model.fallback;
      modelRow.appendChild(arrow);
    }
    card.appendChild(modelRow);

    const note = document.createElement('div');
    note.className = 'team-workflow-rule';
    note.textContent = 'This planning-model directive is defined in SKILL.md '
      + '(read-only here) and takes precedence over the agent-file model for '
      + 'planning dispatch.';
    card.appendChild(note);
  }

  return card;
}

// Curated model suggestions seeding the per-phase editor's datalist. Free text is
// still accepted (and sanitized on Save); the current value is injected too so it
// is never lost from the list.
const WF_MODEL_SUGGESTIONS = ['claude-sonnet-5', 'claude-opus-4-8', 'claude-fable-5'];
let wfModelDatalistSeq = 0;

// The per-phase model editor: a read view (current model + Edit) and an edit view
// (free-text input with a curated datalist + Save/Cancel + inline error). Save
// sanitizes the value (SECURITY: model is an UNFOLDED scalar — reject newlines /
// control chars / `---` / non-token chars via sanitizeAgentModelField, the
// TASK-095 approach), rewrites ONLY the `model:` line via serializeAgentModel, and
// writes through writeWithMirror so assets/agents/ stays byte-synced. A primary
// write failure or a mirror-only drift surfaces inline (TASK-093 contract).
function buildWorkflowModelEditor(tab, phase, agentFile) {
  const wrap = document.createElement('div');
  wrap.className = 'team-workflow-model-editor';
  const parsed = agentFile.parsed;
  const filePath = agentFile.filePath;
  const currentModel = parsed.fm.model != null ? String(parsed.fm.model).trim() : '';

  // Read view.
  const view = document.createElement('div');
  view.className = 'team-workflow-phase-meta';
  const lbl = document.createElement('span');
  lbl.className = 'team-workflow-meta-label';
  lbl.textContent = 'Agent model';
  const badge = document.createElement('span');
  badge.className = 'team-agent-badge team-workflow-model';
  badge.textContent = currentModel || '(default)';
  const editBtn = document.createElement('button');
  editBtn.className = 'small-btn';
  editBtn.textContent = 'Edit';
  view.appendChild(lbl);
  view.appendChild(badge);
  view.appendChild(editBtn);
  wrap.appendChild(view);

  // Edit view.
  const editor = document.createElement('div');
  editor.className = 'team-workflow-model-edit hidden';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'team-workflow-model-input';
  input.spellcheck = false;
  const listId = 'wfModelList' + (++wfModelDatalistSeq);
  input.setAttribute('list', listId);
  const datalist = document.createElement('datalist');
  datalist.id = listId;
  const suggestions = WF_MODEL_SUGGESTIONS.slice();
  if (currentModel && !suggestions.includes(currentModel)) suggestions.unshift(currentModel);
  for (const s of suggestions) {
    const opt = document.createElement('option');
    opt.value = s;
    datalist.appendChild(opt);
  }
  const actions = document.createElement('div');
  actions.className = 'team-agent-desc-actions';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'small-btn primary-btn';
  saveBtn.textContent = 'Save';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'small-btn';
  cancelBtn.textContent = 'Cancel';
  const err = document.createElement('div');
  err.className = 'team-agent-desc-error hidden';
  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);
  editor.appendChild(input);
  editor.appendChild(datalist);
  editor.appendChild(actions);
  editor.appendChild(err);
  wrap.appendChild(editor);

  const showErr = (m) => { err.textContent = m; err.classList.remove('hidden'); };
  const clearErr = () => { err.textContent = ''; err.classList.add('hidden'); };

  editBtn.addEventListener('click', () => {
    input.value = currentModel;
    clearErr();
    view.classList.add('hidden');
    editor.classList.remove('hidden');
    input.focus();
  });
  cancelBtn.addEventListener('click', () => {
    clearErr();
    editor.classList.add('hidden');
    view.classList.remove('hidden');
  });
  saveBtn.addEventListener('click', async () => {
    clearErr();
    // SECURITY: sanitize the scalar model value before it can reach disk.
    const chk = sanitizeAgentModelField(input.value);
    if (!chk.ok) { showErr(chk.error); return; }
    if (chk.value === '') { showErr('Model cannot be empty.'); return; }
    const content = serializeAgentModel(parsed, chk.value);
    if (typeof content !== 'string') { showErr('Could not update the agent file.'); return; }
    saveBtn.disabled = true;
    let res;
    try {
      res = await writeWithMirror(tab, filePath, content);
    } catch (e) {
      res = { ok: false, error: (e && e.message) || String(e) };
    }
    saveBtn.disabled = false;
    if (!res || !res.ok) {
      // Mirror-only failure: primary landed, assets copy drifted — name BOTH paths.
      if (res && res.primaryOk && res.mirrorPath) {
        showErr('Saved ' + filePath + ' but its mirror copy ' + res.mirrorPath +
          ' could NOT be updated — the two copies have drifted: ' +
          (res.mirrorError || 'mirror write failed'));
        return;
      }
      showErr('Save failed: ' + ((res && res.error) || 'unknown error') +
        '. Your text was kept — try again.');
      return;
    }
    // Success: re-read so the panel reflects disk (last write wins).
    refreshTeamWorkflow(tab);
  });

  return wrap;
}

// ── Team tab · Agents panel (TASK-094) ──────────────────────────────────────
// Renderer-side duplicate of the tiny slice of lib/agent-files.js (TASK-092)
// this panel needs. The renderer is a browser script that cannot require Node
// modules, so — matching the ASSETS_MIRRORED_SUBTREES / mirrorRelPath and
// ticket-helper duplication convention — we reimplement just enough of
// parseAgentFile / serializeAgentFile to (a) show name/model/tools/description
// and (b) rewrite the WHOLE file changing ONLY the folded `description` block.
// KEEP IN SYNC with lib/agent-files.js.
const AGENT_KEY_RE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(?:[ \t]+(.*))?$/;
const AGENT_BLOCK_RE = /^[|>][+-]?\d*\s*$/;
const AGENT_FENCE_RE = /^---\s*$/;

// Resolve a folded/literal YAML block scalar to its parsed string (mirror of
// resolveBlockScalar in lib/agent-files.js). Used for display and for the
// "did the value actually change?" comparison on save — round-trip fidelity does
// not depend on it (RAW lines are re-emitted for unchanged keys).
function resolveAgentBlockScalar(rawLines, indicator) {
  const literal = indicator[0] === '|';
  const chomp = indicator.includes('-') ? 'strip'
    : indicator.includes('+') ? 'keep' : 'clip';
  const nonEmpty = rawLines.filter((l) => l.trim() !== '');
  if (nonEmpty.length === 0) return '';
  const indent = Math.min(...nonEmpty.map((l) => l.match(/^ */)[0].length));
  const dedented = rawLines.map((l) => l.slice(indent));
  let value;
  if (literal) {
    value = dedented.join('\n');
  } else {
    const parts = [];
    let buf = [];
    for (const line of dedented) {
      if (line.trim() === '') { parts.push(buf.join(' ')); buf = []; }
      else buf.push(line);
    }
    parts.push(buf.join(' '));
    value = parts.join('\n');
  }
  if (chomp === 'strip') return value.replace(/\n+$/, '');
  if (chomp === 'clip') return value.replace(/\n+$/, '') + '\n';
  return value;
}

// Emit a `description: >-` folded block (mirror of formatKey('description', …) in
// lib/agent-files.js). SECURITY: every continuation line is indented 2 spaces, so
// edited description text can NEVER inject a top-level frontmatter key or a
// premature `---` fence — the folded block is the safe home for the field.
function formatAgentDescription(value) {
  const out = ['description: >-'];
  const paragraphs = String(value).split('\n');
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) { out.push(''); continue; }
    let cur = '';
    for (const w of words) {
      if (cur === '') cur = w;
      else if (cur.length + 1 + w.length <= 74) cur += ' ' + w;
      else { out.push('  ' + cur); cur = w; }
    }
    if (cur !== '') out.push('  ' + cur);
  }
  return out;
}

// Parse an agent-definition file for the renderer. Returns
//   { fm: { name, model, tools, description, … }, body, meta }
// or null for any non-string / unfenced / unclosed input (an "unparseable" file,
// which the panel lists read-only and NEVER rewrites). `meta` carries the raw
// per-key lines + EOL + fences so serializeAgentDescription can re-emit every
// OTHER key byte-for-byte and touch only the description. Never throws.
function parseAgentFileRenderer(content) {
  if (typeof content !== 'string') return null;
  try {
    const eol = /\r\n/.test(content) ? '\r\n' : '\n';
    const lines = content.split(eol);
    if (lines.length === 0 || !AGENT_FENCE_RE.test(lines[0])) return null;
    let close = -1;
    for (let i = 1; i < lines.length; i++) {
      if (AGENT_FENCE_RE.test(lines[i])) { close = i; break; }
    }
    if (close === -1) return null; // unclosed frontmatter → unparseable
    const openFence = lines[0];
    const closeFence = lines[close];
    const fmLines = lines.slice(1, close);
    const hasBody = lines.length > close + 1;
    const body = hasBody ? lines.slice(close + 1).join(eol) : '';
    const fm = {};
    const keyOrder = [];
    const rawByKey = {};
    const tokByKey = {};
    const contentByKey = {};
    const preamble = [];
    let curKey = null;
    for (const line of fmLines) {
      const m = AGENT_KEY_RE.exec(line);
      const isTopKey = m && !/^\s/.test(line);
      if (isTopKey) {
        curKey = m[1];
        if (!(curKey in rawByKey)) keyOrder.push(curKey);
        rawByKey[curKey] = [line];
        tokByKey[curKey] = m[2] === undefined ? null : m[2];
        contentByKey[curKey] = [];
      } else if (curKey !== null) {
        rawByKey[curKey].push(line);
        contentByKey[curKey].push(line);
      } else {
        preamble.push(line);
      }
    }
    for (const key of keyOrder) {
      const tok = tokByKey[key];
      if (tok !== null && AGENT_BLOCK_RE.test(tok)) {
        fm[key] = resolveAgentBlockScalar(contentByKey[key], tok.trim());
      } else {
        fm[key] = tok === null ? '' : tok.replace(/\s+$/, '');
      }
    }
    return {
      fm,
      body,
      meta: { eol, openFence, closeFence, keyOrder, rawByKey, preamble, hasBody }
    };
  } catch (_) {
    return null;
  }
}

// Rewrite the WHOLE agent file changing ONLY the folded `description` block.
// Every other key (and the body, fences, preamble, EOL and trailing-newline
// shape) is re-emitted from its RAW lines verbatim, so the on-disk diff is
// exactly the description and nothing else. When the edited text equals the
// parsed value the original description lines are re-emitted verbatim too, giving
// a byte-identical write. If the file had no `description` key one is appended.
function serializeAgentDescription(parsed, newDescription) {
  const meta = parsed.meta;
  const eol = meta.eol;
  const out = [meta.openFence];
  for (const l of meta.preamble) out.push(l);
  let emittedDesc = false;
  for (const key of meta.keyOrder) {
    if (key === 'description') {
      emittedDesc = true;
      if (newDescription === parsed.fm.description) {
        for (const l of meta.rawByKey[key]) out.push(l);
      } else {
        for (const l of formatAgentDescription(newDescription)) out.push(l);
      }
    } else {
      for (const l of meta.rawByKey[key]) out.push(l);
    }
  }
  if (!emittedDesc) {
    for (const l of formatAgentDescription(newDescription)) out.push(l);
  }
  out.push(meta.closeFence);
  if (meta.hasBody === false) return out.join(eol);
  return out.join(eol) + eol + parsed.body;
}

// Rewrite the WHOLE agent file changing ONLY the unfolded `model:` scalar
// (TASK-106 per-phase model editor). Every other key (and the body, fences,
// preamble, EOL and trailing-newline shape) is re-emitted from its RAW lines
// verbatim, so the on-disk diff is exactly the model line and nothing else — the
// TASK-092 round-trip guarantee. When the file has NO `model` key one is inserted
// in canonical position (after the last of name/description/tools present, so the
// bundled name→description→tools→model order is preserved), all other bytes kept.
// When the edited value equals the parsed one the original line is re-emitted for
// a byte-identical write. `newModel` MUST already be sanitized
// (sanitizeAgentModelField) — it is written as a bare single-line scalar, so a
// value with a newline / `---` / control char would corrupt the frontmatter.
function serializeAgentModel(parsed, newModel) {
  if (!parsed || !parsed.meta) return null;
  const meta = parsed.meta;
  const eol = meta.eol;
  const out = [meta.openFence];
  for (const l of meta.preamble) out.push(l);
  const hasModel = meta.keyOrder.includes('model');
  if (hasModel) {
    for (const key of meta.keyOrder) {
      if (key === 'model') {
        if (newModel === parsed.fm.model) {
          for (const l of meta.rawByKey[key]) out.push(l);
        } else {
          out.push('model: ' + newModel);
        }
      } else {
        for (const l of meta.rawByKey[key]) out.push(l);
      }
    }
  } else {
    // Canonical insertion point: right after the last present anchor key.
    let anchorKey = null;
    for (const a of ['tools', 'description', 'name']) {
      if (meta.keyOrder.includes(a)) { anchorKey = a; break; }
    }
    let inserted = false;
    for (const key of meta.keyOrder) {
      for (const l of meta.rawByKey[key]) out.push(l);
      if (key === anchorKey) { out.push('model: ' + newModel); inserted = true; }
    }
    if (!inserted) out.push('model: ' + newModel); // no anchor: end of frontmatter
  }
  out.push(meta.closeFence);
  if (meta.hasBody === false) return out.join(eol);
  return out.join(eol) + eol + parsed.body;
}

// Rewrite the WHOLE agent file applying the structured-editor fields
// (description / tools / model / body) in ONE pass (TASK-130). Same raw
// round-trip machinery as serializeAgentDescription / serializeAgentModel: every
// key whose edited value equals the parsed value re-emits its RAW lines verbatim
// (byte-identical), and every OTHER key, the fences, preamble, EOL and trailing-
// newline shape are preserved. Only the fields the user actually changed produce
// fresh YAML. `edits` is { description, tools, model, body }:
//   - description: emitted via the folded 2-space-indented `description: >-`
//     path (formatAgentDescription) — the injection-safe home for free text.
//   - tools / model: single sanitized `key: value` lines. An empty (trimmed)
//     value OMITS the key (matching the Add-agent form's "empty means omit"); a
//     newly-added tools/model key is inserted in canonical position
//     (name → description → tools → model), matching serializeAgentModel.
//   - body: replaces the markdown body after the closing fence; an unchanged/
//     empty body preserves the file's `hasBody === false` no-trailing-EOL shape.
// tools/model MUST already be sanitized (single-line, no `---`) by the caller;
// this function does not re-validate them. Returns the file text, or null on a
// bad `parsed`.
function serializeAgentEdits(parsed, edits) {
  if (!parsed || !parsed.meta) return null;
  const meta = parsed.meta;
  const eol = meta.eol;
  const fm = parsed.fm || {};
  const scalar = (v) => (v == null ? '' : String(v));

  const e = edits || {};
  const newDesc = typeof e.description === 'string' ? e.description : scalar(fm.description);
  const newTools = typeof e.tools === 'string' ? e.tools.trim() : scalar(fm.tools).trim();
  const newModel = typeof e.model === 'string' ? e.model.trim() : scalar(fm.model).trim();
  const newBody = typeof e.body === 'string' ? e.body : parsed.body;

  // Canonical rank for insertion of a newly-added key; unknown keys sort last.
  const CANON = ['name', 'description', 'tools', 'model'];
  const rank = (k) => { const i = CANON.indexOf(k); return i === -1 ? CANON.length : i; };

  const order = meta.keyOrder.slice();
  const ensure = (k) => {
    if (order.includes(k)) return;
    const r = rank(k);
    let after = -1;
    for (let i = 0; i < order.length; i++) if (rank(order[i]) < r) after = i;
    order.splice(after + 1, 0, k);
  };
  // Description is required, so it is always emitted (inserted if the original
  // somehow lacked one). tools/model are only present when non-empty.
  ensure('description');
  if (newTools !== '') ensure('tools');
  if (newModel !== '') ensure('model');

  const out = [meta.openFence];
  for (const l of meta.preamble) out.push(l);

  for (const key of order) {
    if (key === 'description') {
      if (meta.keyOrder.includes('description') && newDesc === scalar(fm.description)) {
        for (const l of meta.rawByKey.description) out.push(l);
      } else {
        for (const l of formatAgentDescription(newDesc)) out.push(l);
      }
    } else if (key === 'tools') {
      if (newTools === '') continue; // empty → omit the key
      if (meta.keyOrder.includes('tools') && newTools === scalar(fm.tools).trim()
        && newTools === scalar(fm.tools)) {
        for (const l of meta.rawByKey.tools) out.push(l);
      } else {
        out.push('tools: ' + newTools);
      }
    } else if (key === 'model') {
      if (newModel === '') continue; // empty → omit the key
      if (meta.keyOrder.includes('model') && newModel === scalar(fm.model)) {
        for (const l of meta.rawByKey.model) out.push(l);
      } else {
        out.push('model: ' + newModel);
      }
    } else {
      for (const l of meta.rawByKey[key]) out.push(l);
    }
  }

  out.push(meta.closeFence);
  const fmText = out.join(eol);
  const body = typeof newBody === 'string' ? newBody : '';
  // Reproduce the exact trailing-newline shape: a file that had NO body after the
  // closing fence and still has an empty body gets no trailing EOL.
  if (meta.hasBody === false && body === '') return fmText;
  return fmText + eol + body;
}

// Strip ONE surrounding markdown code fence from AI output, if present, so an
// agent file the model wrapped in ``` / ```markdown still parses (TASK-130). A
// real agent file starts with `---`, not a fence, so this only fires when the
// ENTIRE payload is fenced; internal ``` blocks in the body are untouched.
function stripOneCodeFence(text) {
  const raw = typeof text === 'string' ? text : '';
  const trimmed = raw.trim();
  const m = /^```[^\n]*\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
  if (m) return m[1];
  return raw;
}

// Validate an AI-proposed agent file before it is shown as a preview (TASK-130).
// It must parse (after tolerating one surrounding code fence), keep the agent's
// name unchanged (no rename), have a non-empty description, and — when present —
// pass the tools/model injection sanitizers. Returns { ok, fields, error } with
// `fields` = { description, tools, model, body } (sanitized) on success, or a
// human-readable `error` on any failure. NOTHING is written by this function.
function validateRegeneratedAgent(text, expectedName) {
  const parsed = parseAgentFileRenderer(stripOneCodeFence(text));
  if (!parsed || !parsed.fm) {
    return { ok: false, error: 'it does not parse as an agent file.' };
  }
  const fm = parsed.fm;
  const name = fm.name != null ? String(fm.name).trim() : '';
  if (name !== expectedName) {
    return { ok: false, error: 'it renamed the agent (name must stay "' + expectedName + '").' };
  }
  if (!agentDescriptionValid(fm.description)) {
    return { ok: false, error: 'the description is empty.' };
  }
  let toolsVal = '';
  if (fm.tools != null && String(fm.tools).trim() !== '') {
    const chk = sanitizeAgentToolsField(String(fm.tools));
    if (!chk.ok) return { ok: false, error: chk.error };
    toolsVal = chk.value;
  }
  let modelVal = '';
  if (fm.model != null && String(fm.model).trim() !== '') {
    const chk = sanitizeAgentModelField(String(fm.model));
    if (!chk.ok) return { ok: false, error: chk.error };
    modelVal = chk.value;
  }
  return {
    ok: true,
    fields: { description: String(fm.description), tools: toolsVal, model: modelVal, body: parsed.body }
  };
}

// Whitespace-only guard: an empty description breaks Claude Code's agent
// discovery, so it is rejected inline with NO write.
function agentDescriptionValid(v) {
  return typeof v === 'string' && v.trim() !== '';
}

// Re-read <folder>/.claude/agents/ and rebuild the Agents panel. Missing/empty
// folder shows an install-skill hint (not an error); each parseable file gets a
// name/model/tools row + editable description; unparseable/binary files are
// listed by filename with editing disabled. Bound to the Refresh control.
async function refreshTeamAgents(tab) {
  const body = tab.els.teamAgentsBody;
  if (!body) return;
  if (!tab.folder) { body.textContent = '(open a folder)'; return; }
  body.textContent = 'Loading…';
  const agentsDir = tasksJoin(tab.folder, '.claude', 'agents');
  let files = [];
  try {
    const res = await window.api.fs.findByExt(agentsDir, '.md');
    if (res && res.ok && Array.isArray(res.files)) files = res.files.slice();
  } catch (err) {
    console.error('[team agents]', err);
  }
  // Stale-guard: the folder/tab may have changed while awaiting.
  if (tab.els.teamAgentsBody !== body) return;
  files.sort((a, b) => tasksBasename(a).localeCompare(tasksBasename(b), undefined, { numeric: true }));
  body.textContent = '';
  if (files.length === 0) {
    body.appendChild(buildAgentsInstallHint(tab));
    return;
  }
  for (const filePath of files) {
    const name = tasksBasename(filePath);
    let fr = null;
    try { fr = await window.api.fs.readFile(filePath); } catch (_) {}
    let parsed = null;
    if (fr && fr.ok && !fr.binary && typeof fr.content === 'string') {
      parsed = parseAgentFileRenderer(fr.content);
    }
    body.appendChild(buildAgentCard(tab, filePath, name, parsed));
  }
}

// Install-skill hint shown when .claude/agents/ is missing/empty. Reuses the
// install-banner styling and the tasks:installSkill IPC (the same flow the Tasks
// board's skill banner drives); on success the panel re-reads the directory.
function buildAgentsInstallHint(tab) {
  const banner = document.createElement('div');
  banner.className = 'teamAgentsHint install-banner';
  const text = document.createElement('div');
  text.className = 'install-banner-text';
  const strong = document.createElement('strong');
  strong.textContent = 'No agents found.';
  const rest = document.createTextNode(' Install the orchestration skill to add the bundled agent team to this project.');
  text.appendChild(strong);
  text.appendChild(rest);
  banner.appendChild(text);
  const actions = document.createElement('div');
  actions.className = 'install-banner-actions';
  const btn = document.createElement('button');
  btn.className = 'teamAgentsInstallBtn small-btn primary-btn';
  btn.textContent = 'Install orchestration skill';
  btn.addEventListener('click', async () => {
    if (!tab.folder) return;
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Installing…';
    try {
      const res = await window.api.tasks.installSkill(tab.folder);
      if (!res || !res.ok) {
        strong.textContent = 'Install failed.';
        rest.textContent = ' ' + ((res && res.error) || 'unknown error');
        btn.disabled = false;
        btn.textContent = prev;
        return;
      }
      // Re-read the agent roster first (this replaces the install hint), then
      // place the shared restart notice into the now-populated, persistent body
      // (TASK-131). Awaited so the notice survives the re-render.
      await refreshTeamAgents(tab);
      promptSkillRegistration(tab, tab.els.teamAgentsBody);
    } catch (err) {
      console.error('[team agents installSkill]', err);
      strong.textContent = 'Install failed.';
      rest.textContent = ' ' + ((err && err.message) || String(err));
      btn.disabled = false;
      btn.textContent = prev;
    }
  });
  actions.appendChild(btn);
  banner.appendChild(actions);
  return banner;
}

// One agent card. `parsed` is null for unparseable/binary files (listed by
// filename, editing disabled). Otherwise renders name/model/tools + an editable
// description (textarea + Save/Cancel) that saves via writeWithMirror.
function buildAgentCard(tab, filePath, name, parsed) {
  const card = document.createElement('div');
  card.className = 'team-agent';

  const head = document.createElement('div');
  head.className = 'team-agent-head';
  const title = document.createElement('span');
  title.className = 'team-agent-name';
  head.appendChild(title);

  if (!parsed) {
    title.textContent = name;
    const badge = document.createElement('span');
    badge.className = 'team-agent-badge team-agent-unparseable';
    badge.textContent = 'unparseable';
    head.appendChild(badge);
    card.appendChild(head);
    const note = document.createElement('div');
    note.className = 'team-agent-desc-view';
    note.textContent = 'This file is not a valid agent definition and cannot be edited here.';
    card.appendChild(note);
    return card;
  }

  const fm = parsed.fm;
  title.textContent = (fm.name && String(fm.name).trim()) || name;
  if (fm.model != null && String(fm.model).trim() !== '') {
    const badge = document.createElement('span');
    badge.className = 'team-agent-badge team-agent-model';
    badge.textContent = String(fm.model).trim();
    head.appendChild(badge);
  }
  if (fm.tools != null && String(fm.tools).trim() !== '') {
    const tools = document.createElement('span');
    tools.className = 'team-agent-tools';
    tools.textContent = String(fm.tools).trim();
    head.appendChild(tools);
  }
  card.appendChild(head);

  const descWrap = document.createElement('div');
  descWrap.className = 'team-agent-desc';

  // Read view: description text + Edit button.
  const view = document.createElement('div');
  view.className = 'team-agent-desc-view';
  const descText = document.createElement('span');
  descText.className = 'team-agent-desc-text';
  descText.textContent = (fm.description != null && String(fm.description).trim() !== '')
    ? String(fm.description).trim() : '(no description)';
  const editBtn = document.createElement('button');
  editBtn.className = 'team-agent-edit small-btn';
  editBtn.textContent = 'Edit';
  view.appendChild(descText);
  view.appendChild(editBtn);
  descWrap.appendChild(view);

  // Edit view: structured fields (Description / Tools / Model / Body) + an
  // AI-regeneration box + Save/Cancel + inline error. Name is read-only.
  const editor = document.createElement('div');
  editor.className = 'team-agent-desc-editor hidden';

  const agentName = (fm.name != null && String(fm.name).trim() !== '')
    ? String(fm.name).trim() : name;

  // Read-only name row (renaming is out of scope).
  const nameRow = document.createElement('div');
  nameRow.className = 'team-agent-field team-agent-field-name';
  const nameLbl = document.createElement('label');
  nameLbl.className = 'team-agent-field-label';
  nameLbl.textContent = 'Name (read-only)';
  const nameVal = document.createElement('div');
  nameVal.className = 'team-agent-field-readonly';
  nameVal.textContent = agentName;
  nameRow.appendChild(nameLbl);
  nameRow.appendChild(nameVal);

  // Helper to build a labelled field with a control (textarea/input).
  const buildField = (labelText, control) => {
    const row = document.createElement('div');
    row.className = 'team-agent-field';
    const lbl = document.createElement('label');
    lbl.className = 'team-agent-field-label';
    lbl.textContent = labelText;
    row.appendChild(lbl);
    row.appendChild(control);
    return row;
  };

  const descInput = document.createElement('textarea');
  descInput.className = 'team-agent-desc-input';
  descInput.rows = 4;
  const toolsInput = document.createElement('input');
  toolsInput.type = 'text';
  toolsInput.spellcheck = false;
  toolsInput.className = 'team-agent-field-input';
  const modelInput = document.createElement('input');
  modelInput.type = 'text';
  modelInput.spellcheck = false;
  modelInput.className = 'team-agent-field-input';
  const bodyInput = document.createElement('textarea');
  bodyInput.className = 'team-agent-desc-input team-agent-body-input';
  bodyInput.rows = 6;

  editor.appendChild(nameRow);
  editor.appendChild(buildField('Description', descInput));
  editor.appendChild(buildField('Tools', toolsInput));
  editor.appendChild(buildField('Model', modelInput));
  editor.appendChild(buildField('Body', bodyInput));

  // AI regeneration box (edit mode only).
  const ai = document.createElement('div');
  ai.className = 'team-agent-ai';
  const aiLbl = document.createElement('label');
  aiLbl.className = 'team-agent-field-label';
  aiLbl.textContent = 'Regenerate with AI';
  const aiInput = document.createElement('textarea');
  aiInput.className = 'team-agent-ai-input';
  aiInput.rows = 2;
  aiInput.spellcheck = false;
  aiInput.placeholder = 'Describe how this agent should change (e.g. "also allow the Bash tool and mention linting")…';
  const aiActions = document.createElement('div');
  aiActions.className = 'team-agent-ai-actions';
  const regenBtn = document.createElement('button');
  regenBtn.className = 'small-btn';
  regenBtn.textContent = 'Regenerate with AI';
  aiActions.appendChild(regenBtn);
  const aiNote = document.createElement('div');
  aiNote.className = 'team-agent-ai-note hidden';
  aiNote.textContent = 'AI proposal loaded into the fields — review it, then click Save to apply. Nothing has been written yet.';
  const aiMsg = document.createElement('div');
  aiMsg.className = 'team-agent-ai-msg hidden';
  ai.appendChild(aiLbl);
  ai.appendChild(aiInput);
  ai.appendChild(aiActions);
  ai.appendChild(aiNote);
  ai.appendChild(aiMsg);
  editor.appendChild(ai);

  const actions = document.createElement('div');
  actions.className = 'team-agent-desc-actions';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'small-btn primary-btn';
  saveBtn.textContent = 'Save';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'small-btn';
  cancelBtn.textContent = 'Cancel';
  const err = document.createElement('div');
  err.className = 'team-agent-desc-error hidden';
  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);
  editor.appendChild(actions);
  editor.appendChild(err);
  descWrap.appendChild(editor);
  card.appendChild(descWrap);

  const showErr = (msg) => { err.textContent = msg; err.classList.remove('hidden'); };
  const clearErr = () => { err.textContent = ''; err.classList.add('hidden'); };
  const showAiMsg = (msg) => { aiMsg.textContent = msg; aiMsg.classList.remove('hidden'); };
  const clearAiMsg = () => { aiMsg.textContent = ''; aiMsg.classList.add('hidden'); };
  const hideNote = () => { aiNote.classList.add('hidden'); };
  const showNote = () => { aiNote.classList.remove('hidden'); };

  // Reset every field to the on-disk values (used on Edit-open and Cancel).
  const resetFields = () => {
    descInput.value = fm.description != null ? String(fm.description) : '';
    toolsInput.value = fm.tools != null ? String(fm.tools).trim() : '';
    modelInput.value = fm.model != null ? String(fm.model).trim() : '';
    bodyInput.value = typeof parsed.body === 'string' ? parsed.body : '';
    aiInput.value = '';
    clearErr();
    clearAiMsg();
    hideNote();
  };

  editBtn.addEventListener('click', () => {
    resetFields();
    view.classList.add('hidden');
    editor.classList.remove('hidden');
    descInput.focus();
  });
  cancelBtn.addEventListener('click', () => {
    // Discard all edits (including any AI proposal) and restore the read view.
    resetFields();
    editor.classList.add('hidden');
    view.classList.remove('hidden');
  });

  saveBtn.addEventListener('click', async () => {
    clearErr();
    const description = descInput.value;
    // Validate BEFORE writing — any failure is inline with NO write.
    if (!agentDescriptionValid(description)) {
      showErr('Description cannot be empty.');
      return;
    }
    const toolsChk = sanitizeAgentToolsField(toolsInput.value);
    if (!toolsChk.ok) { showErr(toolsChk.error); return; }
    const modelChk = sanitizeAgentModelField(modelInput.value);
    if (!modelChk.ok) { showErr(modelChk.error); return; }

    // Single whole-file write: only the changed fields are re-formatted; every
    // other byte (unknown keys, key order, fences, EOL, trailing newline) is
    // preserved via the raw round-trip machinery.
    const content = serializeAgentEdits(parsed, {
      description,
      tools: toolsChk.value,
      model: modelChk.value,
      body: bodyInput.value
    });
    if (content == null) {
      showErr('Could not serialize the agent file. Your text was kept — try again.');
      return;
    }
    saveBtn.disabled = true;
    regenBtn.disabled = true;
    let res;
    try {
      res = await writeWithMirror(tab, filePath, content);
    } catch (e) {
      res = { ok: false, error: (e && e.message) || String(e) };
    }
    saveBtn.disabled = false;
    regenBtn.disabled = false;
    if (!res || !res.ok) {
      // Mirror-only failure: the primary write landed but the assets copy did
      // not — the two copies have drifted (Q6 auto-sync). Name BOTH paths.
      if (res && res.primaryOk && res.mirrorPath) {
        showErr('Saved ' + filePath + ' but its mirror copy ' + res.mirrorPath +
          ' could NOT be updated — the two copies have drifted: ' +
          (res.mirrorError || 'mirror write failed'));
        return;
      }
      // Primary write failed: keep the editor open with the user's text.
      showErr('Save failed: ' + ((res && res.error) || 'unknown error') +
        '. Your text was kept — try again.');
      return;
    }
    // Success: re-read the directory so the panel reflects disk (last write wins).
    refreshTeamAgents(tab);
  });

  // AI regeneration: send the current editor state + instruction to the main
  // process, validate the response in the renderer, and load a VALID result into
  // the fields as a preview. Nothing is written here — the user must click Save.
  regenBtn.addEventListener('click', async () => {
    clearAiMsg();
    hideNote();
    const instruction = aiInput.value.trim();
    // Empty instruction → inline error, NO API call.
    if (instruction === '') {
      showAiMsg('Enter an instruction describing how this agent should change.');
      return;
    }
    // Build the current file text from the editor fields (falling back to the
    // parsed value for any field that does not currently sanitize) so the AI
    // sees the user's in-progress edits.
    const tChk = sanitizeAgentToolsField(toolsInput.value);
    const mChk = sanitizeAgentModelField(modelInput.value);
    const currentContent = serializeAgentEdits(parsed, {
      description: agentDescriptionValid(descInput.value)
        ? descInput.value : (fm.description != null ? String(fm.description) : ''),
      tools: tChk.ok ? tChk.value : (fm.tools != null ? String(fm.tools).trim() : ''),
      model: mChk.ok ? mChk.value : (fm.model != null ? String(fm.model).trim() : ''),
      body: bodyInput.value
    });

    const bodyAtRequest = tab.els.teamAgentsBody;
    const prevLabel = regenBtn.textContent;
    regenBtn.disabled = true;
    saveBtn.disabled = true;
    regenBtn.textContent = 'Regenerating…';

    let res;
    try {
      res = await window.api.agents.regenerate(currentContent, instruction);
    } catch (e) {
      res = { ok: false, reason: 'error' };
    }

    // Stale-guard: if the tab/folder changed or the editor closed while the
    // request was in flight, discard the response — no DOM update, no write.
    if (tab.els.teamAgentsBody !== bodyAtRequest || !editor.isConnected) return;

    regenBtn.disabled = false;
    saveBtn.disabled = false;
    regenBtn.textContent = prevLabel;

    if (!res || !res.ok) {
      const reason = res && res.reason;
      if (reason === 'no-key') {
        showAiMsg('Set ANTHROPIC_API_KEY (Settings) to use AI regeneration — no request was sent.');
      } else if (reason === 'empty-instruction') {
        showAiMsg('Enter an instruction describing how this agent should change.');
      } else {
        showAiMsg('AI regeneration failed (' + (reason || 'error') + '). Your edits were kept.');
      }
      return;
    }

    const validated = validateRegeneratedAgent(res.content, agentName);
    if (!validated.ok) {
      showAiMsg('AI returned an invalid agent file: ' + validated.error + ' Your edits were kept.');
      return;
    }

    // Preview: load the proposal into the fields. Nothing is written until Save.
    descInput.value = validated.fields.description;
    toolsInput.value = validated.fields.tools;
    modelInput.value = validated.fields.model;
    bodyInput.value = validated.fields.body;
    showNote();
  });

  return card;
}

// ── Team tab · Add agent (TASK-095) ─────────────────────────────────────────
// Create a real `<folder>/.claude/agents/<name>.md` subagent definition from a
// small form. Q2: this does NOT change orchestrate dispatch (the skill's
// phase→agent mapping is fixed) — new agents are for manual/display use only.
// KEEP the frontmatter shape in sync with the bundled agents (assets/agents/*.md)
// and lib/agent-files.js: canonical key order name / description / tools / model,
// then the body after the closing fence.

// Reserved fallback agent name (mirror of FALLBACK_AGENT in
// lib/orchestrate-agents.js) — never a valid user-created agent name.
const AGENT_FALLBACK_NAME = 'general-purpose';
// Allowed slug shape (mirror of NAME_RE in lib/agent-files.js).
const AGENT_NAME_SLUG_RE = /^[a-z0-9-]+$/;

// Starter body seeded into the prompt textarea so a new agent file is never
// created with an empty body.
const ADD_AGENT_BODY_STARTER =
  'You are a specialized subagent.\n\n' +
  'Describe this agent\'s role, responsibilities, and the hard rules it must follow.\n';

// Validate a proposed agent name (mirror of validateAgentName in
// lib/agent-files.js, plus the extra degenerate-slug guards the ticket requires).
// Returns { valid, error }. SECURITY: the name is written UNFOLDED as
// `name: <slug>` in the frontmatter, so it MUST be constrained to `[a-z0-9-]+`
// (which contains no newline, colon or `---`) — this function is the enforcement
// point. Leading/trailing-hyphen and all-hyphen slugs are also rejected so the
// value is always a real token.
function validateAgentNameRenderer(name, existing) {
  if (typeof name !== 'string' || name === '') {
    return { valid: false, error: 'Name is required.' };
  }
  if (!AGENT_NAME_SLUG_RE.test(name)) {
    return {
      valid: false,
      error: 'Name may only contain lowercase letters, digits and hyphens.'
    };
  }
  if (/^-/.test(name) || /-$/.test(name) || /^-+$/.test(name)) {
    return { valid: false, error: 'Name may not start or end with a hyphen.' };
  }
  if (name === AGENT_FALLBACK_NAME) {
    return { valid: false, error: '"' + AGENT_FALLBACK_NAME + '" is a reserved agent name.' };
  }
  const set = existing instanceof Set
    ? existing
    : new Set(Array.isArray(existing) ? existing : []);
  if (set.has(name)) {
    return { valid: false, error: 'An agent named "' + name + '" already exists.' };
  }
  return { valid: true, error: null };
}

// SECURITY (shared-serializer gap): tools/model are emitted UNFOLDED as a single
// `key: value` frontmatter line. A newline (or CR / Unicode line separator) in
// the value would let it inject a second frontmatter line or a premature `---`
// fence and corrupt the file. This is the guard: an empty (trimmed) value means
// "omit the key"; any line-break or control character is REJECTED (no write); a
// value beginning with `---` is refused for good measure. Because the value can
// never contain a newline, a single physical `key: value` line cannot break out
// of the frontmatter.
function sanitizeAgentScalarField(raw, label) {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (v === '') return { ok: true, value: '' };
  if (/[\r\n\u2028\u2029]/.test(v) || /[\u0000-\u001f\u007f]/.test(v)) {
    return { ok: false, error: label + ' must be a single line (no line breaks or control characters).' };
  }
  if (/^---/.test(v)) {
    return { ok: false, error: label + ' may not begin with "---".' };
  }
  return { ok: true, value: v };
}

// Sanitize the optional `tools` field: single-line (injection guard above) AND a
// comma/space separated list of tool tokens.
function sanitizeAgentToolsField(raw) {
  const base = sanitizeAgentScalarField(raw, 'Tools');
  if (!base.ok || base.value === '') return base;
  if (!/^[A-Za-z0-9._\-\s,()*:/]+$/.test(base.value)) {
    return { ok: false, error: 'Tools must be a comma-separated list of tool names.' };
  }
  return base;
}

// Sanitize the optional `model` field: single-line (injection guard above) AND a
// single bare token (letters, digits, dot, hyphen, underscore).
function sanitizeAgentModelField(raw) {
  const base = sanitizeAgentScalarField(raw, 'Model');
  if (!base.ok || base.value === '') return base;
  if (!/^[A-Za-z0-9._-]+$/.test(base.value)) {
    return { ok: false, error: 'Model must be a single token (letters, digits, dot, hyphen, underscore).' };
  }
  return base;
}

// Build a full agent-definition file from validated/sanitized form fields. Fresh
// object, canonical key order (name, description, tools?, model?) matching the
// bundled agents. `description` is emitted via the SAME folded `description: >-`
// 2-space-indented path the editor uses (formatAgentDescription) — the
// injection-safe home for free text. Produces `---\n…\n---\n\n<body>\n` (LF), a
// shape that round-trips through parseAgentFileRenderer / lib parseAgentFile.
function buildAgentFileContent(fields) {
  const lines = ['---', 'name: ' + fields.name];
  for (const l of formatAgentDescription(fields.description)) lines.push(l);
  if (fields.tools) lines.push('tools: ' + fields.tools);
  if (fields.model) lines.push('model: ' + fields.model);
  lines.push('---');
  const body = String(fields.body != null ? fields.body : '')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');
  return lines.join('\n') + '\n\n' + body + '\n';
}

// Read <folder>/.claude/agents/ and collect the set of names already in use —
// both each file's basename (minus .md) and its parsed `name:` frontmatter — for
// the duplicate guard. Tolerant of a missing directory / unreadable files.
async function readExistingAgentNames(tab) {
  const set = new Set();
  if (!tab || !tab.folder) return set;
  const agentsDir = tasksJoin(tab.folder, '.claude', 'agents');
  try {
    const res = await window.api.fs.findByExt(agentsDir, '.md');
    if (res && res.ok && Array.isArray(res.files)) {
      for (const fp of res.files) {
        const base = tasksBasename(fp).replace(/\.md$/i, '');
        if (base) set.add(base);
        let fr = null;
        try { fr = await window.api.fs.readFile(fp); } catch (_) {}
        if (fr && fr.ok && !fr.binary && typeof fr.content === 'string') {
          const parsed = parseAgentFileRenderer(fr.content);
          const nm = parsed && parsed.fm && parsed.fm.name;
          if (nm && String(nm).trim()) set.add(String(nm).trim());
        }
      }
    }
  } catch (err) {
    console.error('[add agent existing]', err);
  }
  return set;
}

// Open the "Add agent" modal and wire Create/Cancel. Create validates the name
// (inline, no write), requires a description, sanitizes tools/model against
// frontmatter injection, mkdir -p's .claude/agents/, refuses to overwrite an
// existing target file (existence checked right before writing), then performs
// ONE writeWithMirror and refreshes the panel so the agent appears immediately.
// Cancel discards without writing.
function openAddAgentModal(tab) {
  if (!tab || !tab.folder) return;
  const modal = document.getElementById('addAgentModal');
  if (!modal) return;
  const nameInput = modal.querySelector('.addagent-name');
  const descInput = modal.querySelector('.addagent-description');
  const toolsInput = modal.querySelector('.addagent-tools');
  const modelInput = modal.querySelector('.addagent-model');
  const bodyInput = modal.querySelector('.addagent-body');
  const errEl = modal.querySelector('.addagent-error');
  const cancelBtn = modal.querySelector('.addagent-cancel');
  const createBtn = modal.querySelector('.addagent-create');

  nameInput.value = '';
  descInput.value = '';
  toolsInput.value = '';
  modelInput.value = '';
  bodyInput.value = ADD_AGENT_BODY_STARTER;
  errEl.textContent = '';
  createBtn.disabled = false;

  // Snapshot the names already in use for the duplicate guard (refreshed each
  // open). The write-time existence check is the authoritative race guard; this
  // just gives an early inline duplicate message.
  let existingNames = new Set();
  readExistingAgentNames(tab).then((s) => { existingNames = s; }).catch(() => {});

  const showErr = (m) => { errEl.textContent = m; };

  modal.classList.remove('hidden');
  nameInput.focus();

  let disposeCreate = null;
  let disposeCancel = null;
  const cleanup = () => {
    modal.classList.add('hidden');
    if (disposeCreate) disposeCreate();
    if (disposeCancel) disposeCancel();
  };
  // bindActionOnce is `{ once: true }` and self-detaches on fire; every early
  // return re-arms Create so the button stays live for a retry.
  const armCreate = () => { disposeCreate = bindActionOnce(createBtn, 'click', onCreate); };
  const onCancel = () => cleanup();

  async function onCreate() {
    const name = nameInput.value.trim();
    const description = descInput.value;

    // Name validation (mirror of validateAgentName) — inline, NO write.
    const nameCheck = validateAgentNameRenderer(name, existingNames);
    if (!nameCheck.valid) { showErr(nameCheck.error); armCreate(); return; }

    // Description is REQUIRED (an empty description breaks agent discovery).
    if (!agentDescriptionValid(description)) {
      showErr('Description is required.');
      armCreate();
      return;
    }

    // tools/model sanitization — reject frontmatter injection, NO write.
    const toolsChk = sanitizeAgentToolsField(toolsInput.value);
    if (!toolsChk.ok) { showErr(toolsChk.error); armCreate(); return; }
    const modelChk = sanitizeAgentModelField(modelInput.value);
    if (!modelChk.ok) { showErr(modelChk.error); armCreate(); return; }

    const content = buildAgentFileContent({
      name,
      description,
      tools: toolsChk.value,
      model: modelChk.value,
      body: bodyInput.value
    });

    const agentsDir = tasksJoin(tab.folder, '.claude', 'agents');
    const targetPath = tasksJoin(agentsDir, name + '.md');

    createBtn.disabled = true;

    // mkdir -p .claude/agents/ (no-op if it already exists).
    try {
      await window.api.fs.mkdir(agentsDir);
    } catch (err) {
      createBtn.disabled = false;
      showErr('Could not create ' + agentsDir + ': ' + ((err && err.message) || String(err)));
      armCreate();
      return;
    }

    // Existing-file guard checked RIGHT BEFORE writing (races with a bundled
    // install copying the same file) → abort, NO overwrite. This is now
    // belt-and-suspenders: it gives a friendly early message, but the
    // authoritative race guard is the exclusive-create (flag:'wx') write below,
    // which the OS makes atomic (see the { exclusive: true } arg).
    try {
      const ex = await window.api.fs.exists(targetPath);
      if (ex && ex.ok && ex.exists) {
        createBtn.disabled = false;
        showErr('A file already exists at ' + targetPath + ' — not overwriting.');
        armCreate();
        return;
      }
    } catch (_) { /* fall through to the write, which will surface any error */ }

    // Single write (mirror is a natural no-op — a brand-new agent has no
    // pre-existing assets/ copy, and writeWithMirror never creates one).
    // TASK-127: the PRIMARY agent-file write opts into exclusive-create so a
    // file that appears between the fs.exists check and the write can NOT be
    // silently overwritten — the OS returns EEXIST and we abort. The mirror
    // write inside writeWithMirror stays default-overwrite.
    let res;
    try {
      res = await writeWithMirror(tab, targetPath, content, { exclusive: true });
    } catch (e) {
      res = { ok: false, error: (e && e.message) || String(e) };
    }
    createBtn.disabled = false;

    if (!res || !res.ok) {
      // Mirror-only failure: the primary file DID land, so it exists on disk —
      // treat it as created, log the (essentially unreachable) drift, refresh
      // and close rather than orphan the modal on an un-retryable state.
      if (res && res.primaryOk) {
        console.error('[add agent] mirror drift', res.mirrorPath, res.mirrorError);
        cleanup();
        refreshTeamAgents(tab);
        return;
      }
      // TASK-127: an EEXIST from the exclusive-create write means the file was
      // created in the race window (or the pre-check was skipped) — surface the
      // same friendly no-overwrite message rather than a raw errno string.
      const errMsg = (res && res.error) || 'unknown error';
      if (/EEXIST|already exists/i.test(errMsg)) {
        showErr('A file already exists at ' + targetPath + ' — not overwriting.');
        armCreate();
        return;
      }
      showErr('Create failed: ' + errMsg);
      armCreate();
      return;
    }

    // Success: close and re-read the directory so the new agent appears now.
    cleanup();
    refreshTeamAgents(tab);
  }

  armCreate();
  disposeCancel = bindActionOnce(cancelBtn, 'click', onCancel);
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
  updatePlanBtn(tab);
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
    // Team config (TASK-101): read tasks/team-config.json with keep-last-good
    // semantics that mirror the ticket keep-last-good-parse below. A read failure
    // or invalid JSON mid-poll keeps the last good config (t.config) rather than
    // dropping to defaults and flickering the board; the first-ever failure leaves
    // t.config null → the board renders the six default lanes. normalizeTasksColumns
    // tolerates any junk, so nothing here can throw the poll.
    try {
      const cfgPath = tasksJoin(tasksDir, 'team-config.json');
      const cfgRes = await window.api.fs.readFile(cfgPath);
      if (cfgRes && cfgRes.ok && !cfgRes.binary && typeof cfgRes.content === 'string') {
        try {
          t.config = JSON.parse(cfgRes.content);
        } catch (_) {
          // Invalid JSON mid-poll → keep last good (null on a first-ever read,
          // which renders defaults, per the corrupt-config scenario).
        }
      } else {
        // The read failed. Distinguish an intentional delete from a transient read
        // error (F3, TASK-119): probe existence. A confirmed not-found (file gone)
        // reverts to the six default lanes so a user who deletes team-config.json to
        // return to defaults sees them immediately; a transient read error (file
        // still present but unreadable) keeps the last-good config so the board
        // doesn't flicker. An out-of-root probe (ex.ok === false) also keeps last-good.
        const ex = await window.api.fs.exists(cfgPath);
        if (ex && ex.ok && ex.exists === false) {
          t.config = null;
        }
      }
    } catch (_) { /* keep last good config */ }
    // Reflect the config's skill.concurrencyDefault on the toolbar dropdown when
    // the user has no per-folder override (TASK-106). Cheap + idempotent.
    syncTasksConcurrencyOption(tab);
    // Agent set for lane badges (TASK-101): the names present in .claude/agents/
    // (file basenames), used only to flag a lane's configured agent as missing.
    // Cheap directory listing; kept last-good on a failed read.
    try {
      const agentsDir = tasksJoin(tab.folder, '.claude', 'agents');
      // Only TRUST an enumeration when the directory is confirmed present (F2,
      // TASK-119). fs.findByExt returns ok:true with an empty list for a MISSING dir
      // too, so enumerating unconditionally would set an empty Set and falsely flag
      // every configured agent as missing. Probe existence first:
      //  - confirmed present dir → enumerate (an empty Set = confirmed no agents, so
      //    a configured agent is genuinely missing → warn);
      //  - confirmed not-present dir → leave the list UNKNOWN (null) so badges show
      //    no false "unknown agent" warning;
      //  - a listing failure of a present dir, or an out-of-root probe → keep last-good.
      const dir = await window.api.fs.exists(agentsDir);
      if (dir && dir.ok && dir.exists && dir.isDir) {
        const ar = await window.api.fs.findByExt(agentsDir, '.md');
        if (ar && ar.ok && Array.isArray(ar.files)) {
          const names = new Set();
          for (const fp of ar.files) {
            const base = tasksBasename(fp).replace(/\.md$/i, '');
            if (base) names.add(base);
          }
          t.agentNames = names;
        }
      } else if (dir && dir.ok && dir.exists === false) {
        t.agentNames = null;
      }
    } catch (_) { /* keep last good agent set */ }
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
    // status, so a ticket that momentarily lives in two folders shows once. Pass
    // the folder's validated user statuses (TASK-102) so a user-column ticket
    // prefers its tasks/<slug>/ copy just like a system-status one.
    const deduped = dedupeTicketsByFolder(
      candidates, tasksUserStatusSet(normalizeTasksColumns(t.config)));
    const next = new Map();
    for (const tk of deduped) next.set(tk.file, tk);
    t.tickets = next;
    const ticketSig = Array.from(next.values())
      .map((tk) => `${tk.fm.id}|${tk.fm.status}|${tk.fm.updated}`)
      .sort()
      .join('~');
    // The team config + agent set participate in the signature (TASK-101) so a
    // config or agent-file edit re-renders the board within a poll tick even when
    // no ticket file changed.
    const sig = tasksConfigSig(t.config, t.agentNames) + '~~' + ticketSig;
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
  // Config-aware target (TASK-102): a user-column status owns tasks/<slug>/ just
  // like a system status; a removed/out-of-enum status owns no folder (left in
  // place). userStatuses is derived from the folder's validated columns.
  const userStatuses = tasksUserStatusSet(normalizeTasksColumns(tab.tasks && tab.tasks.config));
  const targetFolder = ticketFolderForStatusWith(status, userStatuses);
  if (targetFolder == null) return { ok: true, moved: false, path: srcPath };
  // SECURITY (TASK-102): never build a folder path from an unvalidated slug. The
  // target came from an allowlist (system statuses / validated user columns), but
  // re-gate it here before any mkdir/rename so no untrusted string reaches the fs.
  if (!isSafeTasksSlug(targetFolder)) return { ok: true, moved: false, path: srcPath };
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
  // Config-aware (TASK-102): a user-column ticket reconciles into tasks/<slug>/;
  // a ticket whose column was removed (status no longer in system nor user set)
  // has no target folder, so it is never moved and stays put (routed to `unknown`
  // on the board) — no write, no data loss.
  const userStatuses = tasksUserStatusSet(normalizeTasksColumns(t.config));
  const stale = entries.filter((e) => {
    const target = ticketFolderForStatusWith(e.fm.status, userStatuses);
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

// Rebuild the board's lane DOM wholesale from `columns` (TASK-101). Clears the
// board container and appends one lane per column (in config order) plus a hidden
// `unknown` catch-all lane at the end. Returns a status → { el, cards, count }
// map used for routing/count updates. Rebuilding from scratch each render (rather
// than mutating in place) means the per-lane drop / add listeners attached in
// buildTasksLaneEl can never accumulate across renders.
function rebuildTasksLanes(tab, columns) {
  const board = tab.els.tasksBoard;
  board.innerHTML = '';
  const lanes = {};
  for (const col of columns) {
    const laneEl = buildTasksLaneEl(tab, col);
    board.appendChild(laneEl);
    lanes[col.status] = { el: laneEl, cards: laneEl.querySelector('.tasks-lane-cards'), count: 0 };
  }
  // The hidden `unknown` lane always exists to catch out-of-config statuses; it is
  // a system-style lane with no agent and no drop target.
  const unknownEl = buildTasksLaneEl(tab, {
    status: TASKS_UNKNOWN_STATUS, label: 'Unknown', description: '', agent: null, system: true,
  });
  unknownEl.classList.add('hidden');
  board.appendChild(unknownEl);
  lanes[TASKS_UNKNOWN_STATUS] = {
    el: unknownEl, cards: unknownEl.querySelector('.tasks-lane-cards'), count: 0,
  };
  return lanes;
}

// Build one `.tasks-lane` element for a normalised column. Header shows the label
// (with the description as a `title` tooltip) and — when the column names an
// agent — a small display-only agent badge (Q2: metadata, never a dispatch). A
// user column carries the `.user-lane` accent class; the post-processing lane
// keeps its `+` Add button; every non-`unknown` lane is a drop target.
//
// SECURITY: label/description/agent come from an untrusted, user-editable config
// file, so they are written via textContent / the title property (never
// innerHTML) — a value like `<img src=x onerror=alert(1)>` renders as literal
// text and can inject no markup.
function buildTasksLaneEl(tab, col) {
  const status = col.status;
  const isUser = col.system !== true;
  const laneEl = document.createElement('div');
  laneEl.className = 'tasks-lane' + (isUser ? ' user-lane' : '');
  laneEl.dataset.status = status;

  const header = document.createElement('div');
  header.className = 'tasks-lane-header';

  const labelEl = document.createElement('span');
  labelEl.className = 'tasks-lane-label';
  labelEl.textContent = col.label != null ? String(col.label) : '';
  const desc = typeof col.description === 'string' ? col.description.trim() : '';
  if (desc) labelEl.title = desc;
  header.appendChild(labelEl);

  const agent = col.agent != null ? String(col.agent).trim() : '';
  if (agent) {
    const badge = document.createElement('span');
    // Only warn when the agent list is CONFIRMED (a Set: the .claude/agents/ dir was
    // enumerated) and this agent is absent from it (F2, TASK-119). When the list is
    // unknown — null: not yet loaded, or the dir is absent/unreadable — render a
    // neutral badge so a correctly-configured board never flashes a spurious warning.
    const confirmed = tab.tasks.agentNames instanceof Set;
    const missing = confirmed && !tab.tasks.agentNames.has(agent);
    badge.className = 'tasks-lane-agent' + (missing ? ' missing' : '');
    badge.textContent = agent;
    badge.title = missing ? ('Unknown agent (no .claude/agents/ definition): ' + agent) : ('Agent: ' + agent);
    header.appendChild(badge);
  }

  const countEl = document.createElement('span');
  countEl.className = 'tasks-lane-count';
  countEl.textContent = '0';
  header.appendChild(countEl);

  // Post-processing lane Add affordance (TASK-028): only this lane has one.
  // Clicking it opens the new-ticket modal in post-processing mode, creating a
  // ticket with status AND kind: post-processing. stopPropagation so the click
  // never bubbles into a lane handler.
  if (status === TASKS_POST_PROCESSING_STATUS) {
    const addBtn = document.createElement('button');
    addBtn.className = 'tasks-lane-add';
    addBtn.title = 'Add a post-processing ticket';
    addBtn.textContent = '+';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openNewTaskModal(tab, {
        status: TASKS_POST_PROCESSING_STATUS,
        kind: TASKS_POST_PROCESSING_KIND,
      });
    });
    header.appendChild(addBtn);
  }

  laneEl.appendChild(header);

  const cards = document.createElement('div');
  cards.className = 'tasks-lane-cards';
  laneEl.appendChild(cards);

  // The `unknown` lane is a read-only holding area for out-of-config tickets; it
  // isn't a real status, so don't let a drop write `status: unknown`.
  if (status !== TASKS_UNKNOWN_STATUS) attachTasksLaneDrop(tab, laneEl, status);
  return laneEl;
}

// Transient board notice (TASK-102): show a brief, auto-hidden message above the
// board (e.g. a refused drop). textContent only — never innerHTML — so any
// ticket-derived text (id / claiming agent) in the message can inject no markup.
// The timer is parked on the element so overlapping notices reset cleanly and one
// tab's notice never hides another's.
function showTasksNotice(tab, message) {
  const el = tab.els && tab.els.tasksNotice;
  if (!el) return;
  el.textContent = String(message);
  el.classList.remove('hidden');
  if (el._noticeTimer) clearTimeout(el._noticeTimer);
  el._noticeTimer = setTimeout(() => { el.classList.add('hidden'); }, 4000);
}

// Shared active+claim refusal predicate/message (TASK-102/TASK-111). A ticket in
// an active state (defining / in-progress / testing) that also carries a claiming
// `agent` is live work, so moving it into a USER lane is refused. Returns the
// notice message (matching the drop-guard wording) when the move must be refused,
// or null when it may proceed. Centralising this keeps the drop guard
// (attachTasksLaneDrop, evaluated against the last-polled snapshot) and the
// defense-in-depth re-check in moveTicketToStatus (evaluated against fresh on-disk
// frontmatter) from ever drifting apart. `userStatuses` is the live user-status
// set — the guard applies only when `status` is a configured user lane; system
// lanes (done/todo/…) are an intentional manual override and never refused.
function tasksActiveClaimRefusal(fm, status, userStatuses) {
  if (!userStatuses.has(status) || !fm ||
      !TASKS_ACTIVE_STATUSES.includes(fm.status) ||
      !ticketFieldNonEmpty(fm.agent)) {
    return null;
  }
  const who = String(fm.agent).trim();
  const id = fm.id ? String(fm.id) : 'This ticket';
  return `${id} is being worked on by ${who} — finish or unclaim it before moving it here.`;
}

// Wire a lane as a drop target: dropping a card rewrites that ticket's `status`
// frontmatter to the lane it lands in. Dragging a `done` ticket back onto `todo`
// opens the bug-capture modal instead (TASK-020). Called per fresh lane element
// each render, so re-querying the lane on drop is implicit (the closure captures
// the current element/status).
function attachTasksLaneDrop(tab, laneEl, status) {
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
    if (!file) return;
    const dragged = tab.tasks.tickets.get(file);
    if (dragged && dragged.fm && dragged.fm.status === 'done' && status === 'todo') {
      openBugReportModal(tab, file);
      return;
    }
    // Refuse yanking an actively-worked ticket into a USER lane (TASK-102): a
    // ticket in an active state (defining / in-progress / testing) that also
    // carries a claiming `agent` is live work, so moving it out from under the
    // agent is blocked with a visible notice and NO write. System-lane drops are
    // unaffected — an override there is the existing manual behaviour. The user
    // status set is re-read from the live config at drop time (the board may have
    // re-rendered mid-drag), and only a target that is a configured user column
    // triggers the guard.
    const userStatuses = tasksUserStatusSet(normalizeTasksColumns(tab.tasks.config));
    const refusal = dragged && dragged.fm
      ? tasksActiveClaimRefusal(dragged.fm, status, userStatuses)
      : null;
    if (refusal) {
      showTasksNotice(tab, refusal);
      return;
    }
    moveTicketToStatus(tab, file, status);
  });
}

function renderTasksBoard(tab) {
  const t = tab.tasks;
  // Live board search (TASK-132): read the query straight off tab.tasks at render
  // time (never from the DOM) so the filter survives the wholesale lane rebuild
  // that happens on every poll re-render. `filtering` is the trimmed-non-empty
  // gate; an empty / whitespace-only query behaves exactly like no filter. The
  // matcher (taskMatchesSearch) decides which cards get appended to lane DOM;
  // everything derived from the full ticket set (running count, build/plan
  // buttons, wake-lock + attention reporting) is still computed from ALL tickets
  // below, never the filtered subset. `matched` tallies how many cards were
  // actually rendered so the status line can show "X of N".
  const searchQuery = t.searchQuery || '';
  const filtering = searchQuery.trim() !== '';
  let matched = 0;
  // Resolve the board columns from the last-good team config (TASK-101). A null
  // config (never read / no file) yields exactly the six default system lanes, so
  // the no-config board is behaviourally identical to the historic hardcoded
  // lanes. `columns` is the ordered system+user set; the hidden `unknown` lane is
  // appended by rebuildTasksLanes. Lanes are rebuilt wholesale each render (as the
  // cards were), so per-lane listeners can never stack up.
  const columns = normalizeTasksColumns(t.config);
  const userStatuses = tasksUserStatusSet(columns);
  const lanes = rebuildTasksLanes(tab, columns);
  // Stale-done archiving (TASK-065): sample the clock once at the render call
  // site (like formatBuildDuration) and collect archived done cards to fold into
  // the "Archived (N)" expander at the bottom of the Done lane. The Done lane
  // count still counts these (total = visible + archived stays truthful).
  const now = Date.now();
  const archivedDoneCards = [];
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
    // Board search filter (TASK-132): skip cards that don't match the active
    // query BEFORE building any DOM. Skipping here means non-matching tickets
    // never touch lane DOM or lane.count, so each lane's count reflects matching
    // cards only and empty lanes render empty (the unknown lane's hide-at-0 rule
    // below then keys off the matching count, as intended). The full `tickets`
    // array is still used after the loop for the running count and all build/plan
    // accounting, so this filter is purely presentational.
    if (!taskMatchesSearch(tk, searchQuery)) continue;
    matched++;
    // Config-aware routing (TASK-101), mirroring laneForStatusFor /
    // isKnownStatusFor in lib/ticket-lanes.js. A status is "known" when it is a
    // fixed valid status OR a user column declared in the config; `failed-testing`
    // has no dedicated lane so it folds into `testing` (keeping its red marker) —
    // never dumped into `todo`; a user column status gets its OWN lane; anything
    // else is treated as unknown and routed to the dedicated `unknown` lane rather
    // than being silently dumped into `todo`. If the target lane is somehow absent
    // from the DOM, fall back to `todo` so the board never crashes on bad data.
    const unknown = !TASKS_VALID_STATUSES.includes(tk.fm.status) && !userStatuses.has(tk.fm.status);
    let laneKey;
    if (unknown) laneKey = TASKS_UNKNOWN_STATUS;
    else if (tk.fm.status === TASKS_FAILED_STATUS) laneKey = 'testing';
    else laneKey = tk.fm.status;
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
    // "Won't do" resolution (TASK-074): a ticket the user declined (done +
    // resolution: wont-do) shows a struck-through / muted title in the Done lane,
    // including inside the Done lane's "Archived (N)" expander (the same card node
    // is folded into the expander below, so the treatment carries over). Only an
    // exact `wont-do` resolution triggers this (isWontDoTicket).
    if (isWontDoTicket(tk.fm)) titleEl.classList.add('wont-do');
    card.appendChild(idEl);
    // Ticket type bar (TASK-075): a thin horizontal colored strip between the id
    // header and the title, encoding the ticket's type from persisted frontmatter
    // only. Red (.bug) for a bug ticket (non-empty `bug-of`), yellow (.review) for
    // a PR-review ticket (non-empty `review-of`), green (default, no modifier) for
    // everything else — including post-processing and unknown-status cards. Bug
    // wins when both markers are present. Rendered on every card in every lane
    // (the same construction path feeds the Done lane's Archived expander and
    // unknown-status cards), so the bar is universal.
    const typeEl = document.createElement('div');
    // Text alternative (TASK-082): the bar encodes type by color only, which
    // excludes color-blind users. Mirror the status dot's `title` convention
    // below (~5947) so the meaning is available on hover / to screen readers.
    // The label is derived from the SAME predicates as the color class (bug
    // checked first, so bug wins over review) so label and color can never
    // disagree, and is a fixed literal per type (no ticket text interpolated,
    // no injection surface). Set via attribute/property, never innerHTML.
    const typeLabel = isBugTicket(tk.fm) ? 'Bug' : (isReviewTicket(tk.fm) ? 'Review' : 'Normal');
    typeEl.className = 'task-card-type' +
      (isBugTicket(tk.fm) ? ' bug' : (isReviewTicket(tk.fm) ? ' review' : ''));
    typeEl.title = typeLabel;
    typeEl.setAttribute('aria-label', typeLabel);
    // Announceable role (TASK-083): `aria-label` on a role-less generic <div> is
    // not guaranteed to be exposed by assistive tech. `role="img"` reliably
    // exposes the label for this purely-decorative colored strip while keeping it
    // non-interactive/non-focusable (no tabindex). Set via attribute, never
    // innerHTML; the label/color logic above is unchanged.
    typeEl.setAttribute('role', 'img');
    card.appendChild(typeEl);
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
    // Claiming agent id (TASK-021): while the orchestrate swarm builds tickets in
    // parallel, claimTicket stamps the claiming agent's id into the in-flight
    // ticket's frontmatter (lib/ticket-queue.js). Surface it as a small,
    // unobtrusive label so the parallelism is visible. Derived purely from
    // persisted frontmatter and rendered only when `agent` is non-empty (mirroring
    // the ticketFieldNonEmpty guard), so it appears/updates/clears on the normal
    // poll cycle and nothing is fabricated. Shown regardless of status (including
    // out-of-enum cards) whenever a non-empty agent is present.
    if (ticketFieldNonEmpty(tk.fm.agent)) {
      const agentEl = document.createElement('div');
      agentEl.className = 'task-card-agent';
      agentEl.textContent = String(tk.fm.agent).trim();
      agentEl.title = String(tk.fm.agent).trim();
      card.appendChild(agentEl);
    }
    card.addEventListener('click', () => openTaskModal(tab, tk));
    // Archived stale-done cards (TASK-065) are held back from the normal Done
    // list and folded into the expander below, but still counted so the Done
    // lane count reports the true total. All card behaviour (click → modal,
    // drag out of Done) is unchanged; only where the node is appended differs.
    if (laneKey === 'done' && ticketIsArchived(tk.fm, now)) {
      archivedDoneCards.push(card);
    } else {
      lane.cards.appendChild(card);
    }
    lane.count++;
  }
  // Fold archived done cards into a collapsible "Archived (N)" expander at the
  // bottom of the Done lane. No expander is rendered when the count is 0 (never
  // "Archived (0)"). The open/closed state lives on tab.tasks.archiveExpanded so
  // it survives the poll re-render (which wipes lane innerHTML each cycle); it is
  // re-applied here every render and toggled synchronously on click so the panel
  // opens/closes immediately without waiting for the next poll.
  const doneLane = lanes.done;
  if (doneLane && archivedDoneCards.length) {
    const expander = document.createElement('div');
    expander.className = 'tasks-archived';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tasks-archived-toggle';
    toggle.textContent = `Archived (${archivedDoneCards.length})`;
    const body = document.createElement('div');
    body.className = 'tasks-archived-cards';
    for (const c of archivedDoneCards) body.appendChild(c);
    const applyState = () => {
      const open = !!t.archiveExpanded;
      expander.classList.toggle('expanded', open);
      body.classList.toggle('hidden', !open);
      toggle.setAttribute('aria-expanded', String(open));
    };
    toggle.addEventListener('click', () => {
      t.archiveExpanded = !t.archiveExpanded;
      applyState();
    });
    applyState();
    expander.appendChild(toggle);
    expander.appendChild(body);
    doneLane.cards.appendChild(expander);
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
  // No-match state (TASK-132): when a non-empty query matches zero tickets on a
  // NON-empty board, show a dedicated friendly message — NOT the "No tickets yet"
  // empty-board banner (whose showEmpty stays strictly total===0-based, so it
  // never fires just because a filter matched nothing, and a genuinely empty
  // board with a query shows only the empty banner, never both).
  if (tab.els.tasksNoMatch) {
    const showNoMatch = filtering && total > 0 && matched === 0;
    if (showNoMatch) tab.els.tasksNoMatch.textContent = 'No tickets match your search.';
    tab.els.tasksNoMatch.classList.toggle('hidden', !showNoMatch);
  }
  const polling = t.pollTimer ? ' · polling' : '';
  // Live concurrent-build count (TASK-021): how many tickets are actively being
  // worked right now, i.e. status in TASKS_ACTIVE_STATUSES (the same set that
  // paints the blue dot), so the count matches the visible dots — a merely
  // claimed but non-active card must NOT inflate it. Derived purely from persisted
  // frontmatter, so it updates on the normal poll cycle. Omitted entirely (not
  // "0 running") when nothing is active, leaving the existing status text intact.
  const running = tickets.reduce(
    (n, tk) => n + (TASKS_ACTIVE_STATUSES.includes(tk.fm.status) ? 1 : 0), 0);
  const runningFrag = running ? ` · ${running} running` : '';
  // Status line (TASK-132): while a filter is active show "X of N tickets"
  // (matched of total); otherwise the historic "N tickets". The running fragment
  // and polling suffix are appended in both cases since they derive from the full
  // ticket set, not the filtered subset.
  tab.els.tasksStatus.textContent = total
    ? (filtering
        ? `${matched} of ${total} ticket${total === 1 ? '' : 's'}${runningFrag}${polling}`
        : `${total} ticket${total === 1 ? '' : 's'}${runningFrag}${polling}`)
    : '';
  updateBuildBtn(tab);
  updatePlanBtn(tab);
  maybeContinueBuild(tab);
  reportTasksActivity();
  // Board question/answer state is fresh here — re-evaluate window attention so a
  // newly-waiting (or newly-answered) ticket updates the OS flash (TASK-078).
  reportWindowAttention();
}

// Keep-awake signal (TASK-036). Report the app-wide count of tickets that are
// actively being worked to the main process so it can hold / release a single OS
// wake-lock while any orchestrate work is running. Aggregated across ALL tabs
// (every project board contributes) because the wake-lock is one app-wide
// resource — reporting only the current tab would let another tab's active build
// be forgotten. The status set mirrors lib/keep-awake.js's KEEP_AWAKE_STATUSES
// (the board's active statuses PLUS post-processing). Cheap enough to run on every
// board render; main.js de-dupes (start/stop are no-ops when already in state).
const TASKS_KEEP_AWAKE_STATUSES = ['defining', 'in-progress', 'testing', 'post-processing'];
function reportTasksActivity() {
  if (!window.api || !window.api.tasks || !window.api.tasks.reportActivity) return;
  let active = 0;
  for (const tb of TABS.values()) {
    const tickets = tb.tasks && tb.tasks.tickets;
    if (!tickets || typeof tickets.values !== 'function') continue;
    for (const tk of tickets.values()) {
      if (tk && tk.fm && TASKS_KEEP_AWAKE_STATUSES.includes(tk.fm.status)) active++;
    }
  }
  try { window.api.tasks.reportActivity(active); } catch (_) {}
}

// Window-attention signal (TASK-078). Report the app-wide count of live "needs
// attention" conditions to the main process so it can request / clear the OS
// taskbar flash while the window is unfocused. Aggregated across ALL tabs and
// boards (the flash is one app-wide resource). A condition is: a tab in `waiting`
// (Claude paused on a TUI menu) or `finished` (idle, awaiting the next prompt), or
// a board ticket waiting for an answer (isTicketWaitingForAnswer). attentionCount
// sums all three — the main-side verdict only flashes when count > 0 AND the
// window is unfocused, and dedupes, so this is cheap to call on every transition.
function reportWindowAttention() {
  if (!window.api || !window.api.attention || !window.api.attention.report) return;
  let attentionCount = 0;
  for (const tb of TABS.values()) {
    if (tb && (tb.status === 'waiting' || tb.status === 'finished')) attentionCount++;
    const tickets = tb && tb.tasks && tb.tasks.tickets;
    if (!tickets || typeof tickets.values !== 'function') continue;
    for (const tk of tickets.values()) {
      if (tk && isTicketWaitingForAnswer(tk.fm)) attentionCount++;
    }
  }
  try { window.api.attention.report(attentionCount); } catch (_) {}
}

// Populate the task modal's status <select> from the folder's board columns
// (TASK-102): one <option> per configured column in board order (value = slug,
// label = column label) plus the fixed "Won't do" pseudo-entry. Rebuilt on every
// open so a config change (added / renamed / re-ordered user column) is reflected
// immediately. With a null/absent config normalizeTasksColumns yields the six
// system defaults, so the option list is byte-identical to the historic hardcoded
// one. SECURITY: labels come from an untrusted, user-editable config file, so
// each is written via textContent (never innerHTML) — markup in a label renders
// as literal text.
function populateTaskStatusOptions(statusSel, columns) {
  statusSel.textContent = '';
  for (const col of columns) {
    const opt = document.createElement('option');
    opt.value = col.status;
    opt.textContent = col.label != null && String(col.label) !== '' ? String(col.label) : col.status;
    statusSel.appendChild(opt);
  }
  // "Won't do" resolution pseudo-entry (TASK-074): not a real status; maps to
  // status: done + resolution: wont-do on save (see doWrite). Always last.
  const wontDo = document.createElement('option');
  wontDo.value = '__wont-do__';
  wontDo.textContent = "Won't do";
  statusSel.appendChild(wontDo);
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
  const costEl = modal.querySelector('.task-modal-cost');
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

  // Build the status options from this folder's board columns (TASK-102) before
  // any fill, so selecting a user status saves it via the existing whole-file
  // write path below. fill() still injects the current status as a fallback option
  // when it isn't one of these (e.g. failed-testing, or a status whose column was
  // removed), so an existing status is never silently rewritten on save.
  populateTaskStatusOptions(statusSel, normalizeTasksColumns(tab.tasks.config));

  const fill = (fmObj, body) => {
    idEl.textContent = fmObj.id || '';
    titleInput.value = fmObj.title || '';
    // Preserve the stored status even when it is not one of the select's options
    // (TASK-028/TASK-102): the <select> offers the configured board columns, but a
    // ticket may legitimately be `failed-testing` (a valid status with no lane) or
    // carry a status whose user column was removed from the config. Injecting the
    // current value as a selected option means saving does NOT silently rewrite it
    // — status only changes if the user actually picks a different option. Any
    // prior injected option is removed first so re-fills (the disk-refresh pass)
    // never accumulate duplicates.
    const prevInjected = statusSel.querySelector('option[data-injected="1"]');
    if (prevInjected) prevInjected.remove();
    const curStatus = fmObj.status != null && String(fmObj.status).trim() !== ''
      ? String(fmObj.status) : 'todo';
    const hasOption = Array.from(statusSel.options).some((o) => o.value === curStatus);
    if (!hasOption) {
      const opt = document.createElement('option');
      opt.value = curStatus;
      opt.textContent = curStatus;
      opt.dataset.injected = '1';
      statusSel.appendChild(opt);
    }
    statusSel.value = curStatus;
    // "Won't do" resolution (TASK-074): a ticket persisted as `status: done` +
    // `resolution: wont-do` re-opens with the fixed "Won't do" pseudo-option
    // selected instead of plain "Done". The pseudo-option's value (`__wont-do__`)
    // is not a real status, so it never collides with the injected current-status
    // option above (which only fires for out-of-enum statuses like `failed-testing`)
    // and picking plain "Done" instead clears the marker on save (see doWrite).
    if (isWontDoTicket(fmObj)) statusSel.value = '__wont-do__';
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
    // Per-activity cost view (TASK-070): a read-only breakdown of the complete
    // ticket cost by activity (ba/code/test/review/post-processing/…). Each row
    // shows the activity, model, duration, tokens up/down and cost (absent
    // fragments dropped), followed by a totals row. Hidden entirely when the
    // ticket carries no activity data.
    if (costEl) {
      const lines = ticketActivityLines(fmObj);
      const totalLine = ticketActivityTotalLine(fmObj);
      costEl.textContent = '';
      if (lines.length) {
        const head = document.createElement('div');
        head.className = 'task-modal-cost-label';
        head.textContent = `Cost by activity (${lines.length})`;
        costEl.appendChild(head);
        for (const line of lines) {
          const row = document.createElement('div');
          row.className = 'task-modal-cost-row';
          row.textContent = line;
          costEl.appendChild(row);
        }
        if (totalLine) {
          const trow = document.createElement('div');
          trow.className = 'task-modal-cost-total';
          trow.textContent = totalLine;
          costEl.appendChild(trow);
        }
      }
      costEl.classList.toggle('hidden', lines.length === 0);
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
    // "Won't do" resolution (TASK-074): the "Won't do" pseudo-option maps to
    // `status: done` + `resolution: wont-do` in this single whole-file write — no
    // status-enum change, so the file reconciles into tasks/done/ via the existing
    // reconcileTicketFolders flow. Picking any real status instead clears a prior
    // `wont-do` marker (only when it was exactly `wont-do`, so an unrelated
    // `resolution` value round-trips untouched as an unknown key).
    if (statusSel.value === '__wont-do__') {
      newFm.status = 'done';
      newFm.resolution = 'wont-do';
    } else {
      newFm.status = statusSel.value;
      if (newFm.resolution != null && String(newFm.resolution).trim() === 'wont-do') {
        delete newFm.resolution;
      }
    }
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

// Shared post-install registration step (TASK-131). Installing the orchestration
// skill only COPIES files into <project>/.claude/; Claude Code discovers project
// skills at session STARTUP only, so a `claude` session that was already running
// when the user clicked Install never registers the freshly-copied skill. Rather
// than auto-relaunch (which would silently discard the running conversation and
// could kill an in-flight response), surface a user-triggered Restart. All three
// install surfaces (Tasks banner, Workflow panel, Agents panel) route through this
// one helper after a successful `tasks:installSkill` so the behavior can't diverge.
//
// Safe no-op when the tab's agent is `opencode` or no cmd PTY is alive
// (`tab.cmd.id` null): skills are Claude-specific and there is no session to
// restart. Only the installing tab is affected; other tabs pointed at the same
// folder stay stale (documented limitation). `surfaceEl` is the persistent
// container the inline notice is placed into (never the transient banner, which
// is hidden/re-rendered on success).
function promptSkillRegistration(tab, surfaceEl) {
  if (!tab || !surfaceEl) return;
  // Skills only apply to the claude session; the opencode pane / a dead PTY has
  // nothing to register, so no notice and no error.
  if (tab.agent === 'opencode') return;
  if (!tab.cmd || !tab.cmd.id) return;

  // Never stack duplicate notices (e.g. a reinstall over an existing skill using
  // the same button) — drop any prior one first.
  const existing = surfaceEl.querySelector('.skill-restart-notice');
  if (existing) existing.remove();

  const notice = document.createElement('div');
  notice.className = 'skill-restart-notice install-banner';

  const text = document.createElement('div');
  text.className = 'install-banner-text';
  const strong = document.createElement('strong');
  strong.textContent = 'Skill installed.';
  // textContent only (no innerHTML) — consistent with the other install surfaces.
  const rest = document.createTextNode(
    ' Restart the Claude session to register the skill. Restarting ends the current session.');
  text.appendChild(strong);
  text.appendChild(rest);
  notice.appendChild(text);

  const actions = document.createElement('div');
  actions.className = 'install-banner-actions';
  const btn = document.createElement('button');
  btn.className = 'skillRestartBtn small-btn primary-btn';
  btn.textContent = 'Restart';
  btn.addEventListener('click', async () => {
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Restarting…';
    try {
      // Existing kill-and-respawn path: the new session discovers the just-copied
      // skill at its startup, so a subsequently queued /orchestrate build|plan
      // runs the skill.
      await launchCmdAgent(tab);
      // Success — the notice has served its purpose. skillInstalled stays true.
      notice.remove();
    } catch (err) {
      console.error('[skill restart]', err);
      // The files are validly on disk; only session registration is pending, so
      // keep skillInstalled true and tell the user to restart Claude manually.
      strong.textContent = 'Restart failed.';
      rest.textContent = ' Restart the Claude session manually to register the skill.';
      btn.disabled = false;
      btn.textContent = prev;
    }
  });
  actions.appendChild(btn);
  notice.appendChild(actions);

  // Placement: the Tasks board's persistent container also holds the board (a
  // scroll-area that would push a trailing notice off-screen), so insert the
  // notice above the board; every other surface (panel bodies) appends to the end.
  const board = surfaceEl.querySelector('.tasksBoard');
  if (board && board.parentNode === surfaceEl) surfaceEl.insertBefore(notice, board);
  else surfaceEl.appendChild(notice);
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
      if (textEl) {
        // .install-banner-text is a static element from index.html with
        // pre-existing children; clear it before appending so repeated failures
        // don't stack duplicate nodes. Build via textContent (mirrors
        // buildWorkflowInstallHint/buildAgentsInstallHint) so an error string
        // containing HTML-like markup renders literally, never parsed as HTML.
        textEl.textContent = '';
        const strong = document.createElement('strong');
        strong.textContent = 'Install failed.';
        textEl.appendChild(strong);
        textEl.appendChild(document.createTextNode(' ' + ((res && res.error) || 'unknown error')));
      }
      btn.disabled = false;
      btn.textContent = prev;
      return;
    }
    tab.tasks.skillInstalled = true;
    tab.els.tasksSkillBanner.classList.add('hidden');
    tab.els.tasksBuildBtn.disabled = false;
    btn.textContent = prev;
    pollTasksOnce(tab, true);
    // Files are copied, but the running claude session must be restarted to
    // register the skill (TASK-131). The banner is now hidden, so the notice goes
    // into its persistent parent (the Tasks view), above the board.
    promptSkillRegistration(tab, tab.els.tasksSkillBanner.parentNode);
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

// The config-level build concurrency default (skill.concurrencyDefault from
// tasks/team-config.json, kept last-good in tab.tasks.config by the poll). Returns
// the RAW value (a number/string) or null when absent — resolution/clamping is the
// caller's job. Never throws. This is the middle rung of the precedence chain
// localStorage → config → TASKS_DEFAULT_CONCURRENCY (TASK-106).
function tasksConfigConcurrencyDefault(tab) {
  const cfg = tab && tab.tasks ? tab.tasks.config : null;
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null;
  const skill = cfg.skill;
  if (!skill || typeof skill !== 'object' || Array.isArray(skill)) return null;
  const v = skill.concurrencyDefault;
  return (v == null || v === '') ? null : v;
}

// The current resolved concurrency for this folder. Precedence (TASK-106): a
// per-folder localStorage value wins; otherwise the config's
// skill.concurrencyDefault; otherwise TASKS_DEFAULT_CONCURRENCY. Read fresh so the
// queued build command never diverges from a stale in-memory value. Never throws.
function currentTasksConcurrency(tab) {
  const key = tasksConcurrencyStorageKey(tab);
  if (key) {
    let stored = null;
    try { stored = localStorage.getItem(key); } catch (_) { stored = null; }
    if (stored != null && String(stored).trim() !== '') {
      return readStoredTasksConcurrency(stored);
    }
  }
  const cfgDefault = tasksConfigConcurrencyDefault(tab);
  if (cfgDefault != null) return resolveTasksConcurrency(cfgDefault);
  return TASKS_DEFAULT_CONCURRENCY;
}

// Reflect the resolved concurrency on the Tasks toolbar <select>, but ONLY when
// the user has no per-folder localStorage override — so a config-default change
// (TASK-106) shows up while an explicit user choice is never overwritten. Called
// after each poll loads the config and after a workflow-panel Save. Idempotent.
function syncTasksConcurrencyOption(tab) {
  const sel = tab.els.tasksConcurrency;
  if (!sel) return;
  const key = tasksConcurrencyStorageKey(tab);
  if (key) {
    let stored = null;
    try { stored = localStorage.getItem(key); } catch (_) { stored = null; }
    if (stored != null && String(stored).trim() !== '') return; // user override wins
  }
  populateTasksConcurrencyOptions(tab);
  sel.value = String(currentTasksConcurrency(tab));
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

// Counts of tickets per status, from the last poll snapshot. `post-processing`
// is tracked (TASK-028) but deliberately NOT part of the Build pending count
// (todo + failed-testing) — post-processing tickets are never built by the swarm.
function taskStatusCounts(tab) {
  const counts = { todo: 0, defining: 0, 'in-progress': 0, testing: 0, 'failed-testing': 0, 'post-processing': 0, done: 0, other: 0 };
  for (const tk of tab.tasks.tickets.values()) {
    // A ticket with `kind: post-processing` is never built by the swarm
    // (lib/ticket-queue.js refuses to dispatch it), so keep it out of the
    // buildable `todo`/`failed-testing` buckets even if its status was tampered
    // to one of those — otherwise the Build pending count and maybeContinueBuild
    // would treat it as pending work and spin forever. Lane placement (which is
    // status-driven, elsewhere) is unaffected by this counting-only exclusion.
    if (isTasksPostProcessingTicket(tk.fm)) { counts['post-processing']++; continue; }
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

// Gate the Plan button the same way Build is gated (TASK-030): usable only when a
// folder is open AND the orchestration skill is installed, since planning hands
// `/orchestrate plan …` to the same skill-driven flow Build uses. Refreshed on the
// same board updates that call updateBuildBtn.
function updatePlanBtn(tab) {
  const btn = tab.els.tasksPlanBtn;
  if (!btn) return;
  const installed = !!(tab.folder && tab.tasks.skillInstalled);
  btn.disabled = !installed;
  btn.title = installed
    ? 'Describe a feature and let the planner break it into tickets'
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

// TASK-079 Part A: auto-start an "/orchestrate build" run the moment a ticket is
// created (New-ticket modal, bug create, or Slack `create ticket`), even when the
// auto-build toggle is OFF — so a newly added ticket is defined/built right away
// without the user pressing Build. Reuses queueBuild/buildCommandFor and the SAME
// single-run guard maybeContinueBuild relies on, so it NEVER launches a second
// overlapping run: if the continuous auto-build loop is already on, or a build
// command is already queued, or Claude is mid-dispatch / not idle-ready, this is a
// no-op — the already-active run's mid-build intake (SKILL Phase 2 step 1) picks
// the new ticket up instead.
function autoQueueBuildOnCreate(tab) {
  if (!tab || !tab.folder) return;
  const t = tab.tasks;
  if (!t || !t.skillInstalled) return;              // no skill installed -> no build run
  if (t.autoBuild) return;                          // the continuous loop already drives it
  if (tab.status !== 'finished') return;            // a run is in flight / Claude not idle-ready
  if (tab.queueFiring) return;                      // mid-dispatch, don't stack
  if (tab.promptQueue.some(isBuildCommand)) return; // a build run is already queued
  queueBuild(tab);
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
  // Defense-in-depth re-check (TASK-111): the drop guard in attachTasksLaneDrop
  // evaluates the last-polled in-memory snapshot, so an agent that claims the
  // ticket on disk in the window between the last poll and the drop slips past it.
  // Re-apply the SAME active+claim refusal against the FRESH frontmatter we just
  // re-read, before any write/rename. Only a target that is a configured user lane
  // triggers it (system lanes such as done/todo remain an intentional manual
  // override, incl. the bug-modal `'todo'` caller); active-but-unclaimed or
  // claimed-but-not-active still pass. A failed/unparseable fresh read leaves `fm`
  // as the snapshot, so this degrades to today's behaviour with no new failure mode.
  const userStatuses = tasksUserStatusSet(normalizeTasksColumns(tab.tasks.config));
  const refusal = tasksActiveClaimRefusal(fm, newStatus, userStatuses);
  if (refusal) {
    showTasksNotice(tab, refusal);
    pollTasksOnce(tab, true);
    return;
  }
  const newFm = Object.assign({}, fm);
  newFm.status = newStatus;
  // "Won't do" (TASK-074/TASK-080): the `resolution: wont-do` marker is reachable
  // only via the task-modal status select; a plain drag means normal done. So when
  // a moved ticket carries a lingering `wont-do` marker, clear it here — otherwise
  // dragging a won't-do ticket out of Done and back would silently re-flag it
  // struck-through with no modal involved. Only the exact trimmed `wont-do` value
  // is cleared (mirrors doWrite's revert path); any other `resolution` value
  // round-trips untouched, and tickets with no `resolution` key are unaffected.
  if (newFm.resolution != null && String(newFm.resolution).trim() === 'wont-do') {
    delete newFm.resolution;
  }
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
  for (const laneEl of tab.els.tasksBoard.querySelectorAll('.tasks-lane')) {
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

// Browser-side mirror of lib/modal-actions.js's `bindActionOnce` (TASK-024).
// The renderer can't `require` the lib module, so the listener-lifecycle logic
// is duplicated here — same lib-canonical + renderer-mirror convention as the
// TASK-021 (ticket-progress) / TASK-020 (bug-report append) helpers. Keep this
// byte-for-byte behaviour-identical to lib/modal-actions.js: changing one
// without the other is a bug.
//
// Why it exists: modal openers attach submit/cancel `click` handlers on every
// open. Without this, re-opening a modal before dismissing it left the prior
// invocation's handler — bound to the EARLIER `file` — still attached, so a
// submit could fire against a stale ticket. bindActionOnce FIRST detaches
// whatever it previously bound for this (el, event), then attaches the fresh
// handler with `{ once: true }`, so a re-open never leaves a stale listener and
// the handler fires at most once.
const _modalBoundHandlers = new WeakMap();
function bindActionOnce(el, event, handler) {
  if (!el || typeof el.addEventListener !== 'function') {
    throw new TypeError('bindActionOnce: el must expose addEventListener');
  }
  let perEvent = _modalBoundHandlers.get(el);
  if (!perEvent) { perEvent = new Map(); _modalBoundHandlers.set(el, perEvent); }

  // Detach the previously-bound handler for this (el, event) FIRST.
  const prev = perEvent.get(event);
  if (prev && typeof el.removeEventListener === 'function') {
    el.removeEventListener(event, prev);
  }

  el.addEventListener(event, handler, { once: true });
  perEvent.set(event, handler);

  return function dispose() {
    const cur = _modalBoundHandlers.get(el);
    if (cur && cur.get(event) === handler) {
      if (typeof el.removeEventListener === 'function') {
        el.removeEventListener(event, handler);
      }
      cur.delete(event);
    }
  };
}

// Browser-side mirror of lib/bug-switch-warning.js (TASK-042 logic, hardened by
// TASK-044). The renderer can't `require` the lib module, so the bug-create
// "forward switch" warning logic is duplicated here — same lib-canonical +
// renderer-mirror convention as bindActionOnce above. Keep these byte-for-byte
// behaviour-identical to lib/bug-switch-warning.js: the drift guard in
// test/task-044-bug-switch-warning.e2e.test.js fails if they diverge.
//
// Decision: given the ORIGINAL ids this session has already folded a STEP-1
// `## Bug Reports` entry against, `staleBugSwitchTargets` returns those that are
// NOT the currently-selected original (the folds that would dangle); the warning
// is advisory and NEVER blocks Create.
function staleBugSwitchTargets(selectedOriginalId, committedFoldTargets) {
  const out = [];
  if (!committedFoldTargets) return out;
  for (const originalId of committedFoldTargets) {
    if (originalId !== selectedOriginalId) out.push(originalId);
  }
  return out;
}
function shouldWarnBugSwitch(selectedOriginalId, committedFoldTargets) {
  return staleBugSwitchTargets(selectedOriginalId, committedFoldTargets).length > 0;
}
// The original-select is a PERSISTENT element that survives modal re-opens, so a
// `change` listener bound on every open would accumulate. We stash the current
// handler on the element (`_bugSwitchWarnHandler`); attaching FIRST detaches any
// prior handler, guaranteeing AT MOST ONE live `change` listener. The disposer
// removes it (only if still current) on modal cleanup. bindActionOnce's
// `{ once: true }` is wrong here — the user may switch the select repeatedly.
function attachBugSwitchWarning(el, handler) {
  if (!el || typeof el.addEventListener !== 'function') {
    throw new TypeError('attachBugSwitchWarning: el must expose addEventListener');
  }
  const prev = el._bugSwitchWarnHandler;
  if (prev && typeof el.removeEventListener === 'function') {
    el.removeEventListener('change', prev);
  }
  el._bugSwitchWarnHandler = handler;
  el.addEventListener('change', handler);
  return function dispose() {
    if (el._bugSwitchWarnHandler === handler) {
      if (typeof el.removeEventListener === 'function') {
        el.removeEventListener('change', handler);
      }
      el._bugSwitchWarnHandler = null;
    }
  };
}
// Write the warning via textContent — NEVER innerHTML — so an original id like
// `<script>…` lands as literal text and cannot inject markup / child nodes.
function writeBugWarnText(el, text) {
  if (!el) return;
  el.textContent = text == null ? '' : String(text);
}

// New-ticket modal. Writes a fresh ticket following the skill's file contract so
// the orchestrator (and the build loop) can pick it up. `opts` selects the mode
// (TASK-028): with no opts the toolbar "New ticket" button creates a `todo`
// ticket with NO kind field; the post-processing lane's Add button passes
// { status: 'post-processing', kind: 'post-processing' } to create a
// post-processing ticket (status AND kind: post-processing) in tasks/post-processing/.
function openNewTaskModal(tab, opts) {
  if (!tab.folder) return;
  const mode = opts || {};
  const status = mode.status || 'todo';
  const kind = mode.kind || null;
  const modal = document.getElementById('newTaskModal');
  if (!modal) return;
  const idEl = modal.querySelector('.newtask-id');
  const titleInput = modal.querySelector('.newtask-title');
  const bodyArea = modal.querySelector('.newtask-body');
  const errEl = modal.querySelector('.newtask-error');
  const cancelBtn = modal.querySelector('.newtask-cancel');
  const createBtn = modal.querySelector('.newtask-create');
  const bugBtn = modal.querySelector('.newtask-bug');
  const bugOfRow = modal.querySelector('.newtask-bug-of-row');
  const bugOfSelect = modal.querySelector('.newtask-bug-of');
  const bugWarnEl = modal.querySelector('.newtask-bug-warn');

  const id = nextTaskId(tab);
  idEl.textContent = id;
  titleInput.value = '';
  bodyArea.value = '';
  errEl.textContent = '';

  // ── Bug mode (TASK-031) ────────────────────────────────────────────────────
  // The Bug button toggles the create flow into creating a NEW bug ticket in
  // `todo` that is (a) linked to an ORIGINAL ticket via a `bug-of` frontmatter
  // key and (b) folded into that original's `## Bug Reports` section. This is
  // DISTINCT from openBugReportModal (drag done→todo), which appends to the SAME
  // ticket and creates no second ticket. Normal (non-bug) create is unchanged.
  const NORMAL_BODY_PLACEHOLDER = "Describe what needs doing and why. This becomes the ticket's Description.";
  const BUG_BODY_PLACEHOLDER = 'Describe the bug: steps to reproduce, expected vs actual behaviour…';
  const NORMAL_CREATE_LABEL = 'Create ticket';
  const BUG_CREATE_LABEL = 'Create bug ticket';

  // Only the plain toolbar "New ticket" path (no opts) offers Bug mode; the
  // post-processing Add path passes { status/kind } and keeps Bug hidden.
  const allowBug = !!bugBtn && !kind && status === 'todo';
  if (bugBtn) bugBtn.classList.toggle('hidden', !allowBug);

  // Populate the original-ticket selector from the live board (tab.tasks.tickets
  // Map values → fm.id), deduped and numeric-sorted. Rebuilt on every open so it
  // reflects the current board.
  if (bugOfSelect) {
    const ids = [];
    const seen = new Set();
    for (const tk of tab.tasks.tickets.values()) {
      const tid = tk && tk.fm && tk.fm.id;
      if (tid && !seen.has(tid)) { seen.add(tid); ids.push(tid); }
    }
    ids.sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
    bugOfSelect.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select original ticket…';
    bugOfSelect.appendChild(placeholder);
    for (const tid of ids) {
      const opt = document.createElement('option');
      opt.value = tid;
      opt.textContent = tid;
      bugOfSelect.appendChild(opt);
    }
    bugOfSelect.value = '';
  }

  let bugMode = false;
  // Session-scoped set of COMMITTED STEP-1 folds (TASK-042, replacing the TASK-038
  // single-slot `{ originalId, id }` memo). When a bug-create attempt succeeds at
  // STEP 1 (folding the report into the original) but the same target is revisited
  // later in the session — either a same-target STEP-2 retry (TASK-038) or a
  // switch-back A→B→A — we must NOT re-fold a second `## Bug Reports` entry. The
  // single-slot memo only remembered the MOST-RECENT target, so a switch-back
  // double-folded. We instead remember EVERY committed fold this session, keyed on
  // the composite (originalId, id) pair via foldKey. `id` is fixed per modal
  // session, so the key effectively partitions by originalId. Reset (cleared) by
  // leaveBugMode() — which runs on open, cancel/cleanup, and bug-mode toggle-off —
  // so a fresh open, a cancel, or a toggle-off starts a genuinely clean session.
  const bugFoldedTargets = new Set();
  const foldKey = (origId, bugId) => origId + ' ' + bugId;
  // Recover the originalId from a foldKey given the session-constant `id` suffix
  // (`<originalId> <id>`): used only to name the stale target in the switch warning.
  const foldKeyOriginal = (key) => key.slice(0, key.length - (id.length + 1));
  // Forward-switch dangling-fold warning (TASK-042, option b). If STEP 1 committed
  // a fold against original A and the user then switches the select to a DIFFERENT
  // original B, A keeps its `Reported as <id>` entry even though the bug may end up
  // filed against B. We do NOT auto-remove that fold (avoids extra writes); instead
  // we surface a non-blocking amber warning. Recomputed on every select change and
  // cleared when leaving bug mode.
  const updateBugSwitchWarning = () => {
    if (!bugWarnEl) return;
    const selected = bugOfSelect ? bugOfSelect.value : '';
    // Map the committed foldKeys back to their originals and let the mirrored
    // decision helper pick the stale (cross-target) ones. Equivalent to the old
    // per-key `key !== foldKey(selected, id)` scan (id is session-constant, so
    // key-equality iff original-equality) — behaviour-identical, now sharing the
    // lib/bug-switch-warning.js logic.
    const stale = bugMode
      ? staleBugSwitchTargets(selected, Array.from(bugFoldedTargets, foldKeyOriginal))
      : [];
    if (stale.length) {
      writeBugWarnText(bugWarnEl, 'Heads up: ' + stale.join(', ') + ' already has a recorded bug report (Reported as ' + id + ') from this session. Switching the target leaves that fold in place — it will not be removed automatically.');
      bugWarnEl.classList.remove('hidden');
    } else {
      writeBugWarnText(bugWarnEl, '');
      bugWarnEl.classList.add('hidden');
    }
  };
  const enterBugMode = () => {
    bugMode = true;
    if (bugOfRow) bugOfRow.classList.remove('hidden');
    bodyArea.placeholder = BUG_BODY_PLACEHOLDER;
    createBtn.textContent = BUG_CREATE_LABEL;
    if (bugBtn) bugBtn.classList.add('active');
    errEl.textContent = '';
  };
  const leaveBugMode = () => {
    bugMode = false;
    if (bugOfRow) bugOfRow.classList.add('hidden');
    if (bugOfSelect) bugOfSelect.value = '';
    bodyArea.placeholder = NORMAL_BODY_PLACEHOLDER;
    createBtn.textContent = NORMAL_CREATE_LABEL;
    if (bugBtn) bugBtn.classList.remove('active');
    // Clear ALL committed-fold tracking (TASK-042, superseding the TASK-038 single
    // memo). leaveBugMode runs on open, cancel/cleanup, and toggle-off, so any of
    // those starts a genuinely fresh bug-create session that will fold new
    // `## Bug Reports` entries rather than skip STEP 1. Also drop the switch warning.
    bugFoldedTargets.clear();
    if (bugWarnEl) { bugWarnEl.textContent = ''; bugWarnEl.classList.add('hidden'); }
  };
  // Every (re)open resets to normal create mode: no stale original selection,
  // no lingering bug-mode UI from a prior open.
  leaveBugMode();
  errEl.textContent = '';

  modal.classList.remove('hidden');
  titleInput.focus();

  // Sibling of the bug modal — same stale-listener risk, so it gets the same
  // fix (TASK-024): bindActionOnce detaches any prior open's handler first, then
  // binds fresh with `{ once: true }`. Retry paths (empty title / create error)
  // re-arm via armCreate since `{ once: true }` self-detaches on fire.
  let disposeCreate = null;
  let disposeCancel = null;
  let disposeBug = null;
  let disposeBugSwitch = null;
  const cleanup = () => {
    modal.classList.add('hidden');
    if (disposeCreate) disposeCreate();
    if (disposeCancel) disposeCancel();
    if (disposeBug) disposeBug();
    if (disposeBugSwitch) disposeBugSwitch();
    leaveBugMode();
  };
  const armCreate = () => { disposeCreate = bindActionOnce(createBtn, 'click', onCreate); };
  const armBug = () => { if (bugBtn) disposeBug = bindActionOnce(bugBtn, 'click', onBug); };
  const onCancel = () => cleanup();
  const onBug = () => {
    // Toggle bug mode. bindActionOnce is `{ once: true }` so it self-detaches on
    // fire — re-arm to keep the toggle live.
    if (bugMode) leaveBugMode(); else enterBugMode();
    armBug();
  };

  // Normal create path (unchanged behaviour): a plain `todo`/post-processing
  // ticket with NO bug-of link.
  const onCreateNormal = async () => {
    const title = titleInput.value.trim();
    if (!title) { errEl.textContent = 'Title is required.'; titleInput.focus(); armCreate(); return; }
    createBtn.disabled = true;
    try {
      const now = new Date().toISOString();
      const fm = { id, title, status, created: now, updated: now };
      // Post-processing tickets carry kind: post-processing (TASK-028) so the
      // swarm excludes them; serializeTicket keeps it after the leading keys.
      if (kind) fm.kind = kind;
      // Route the user's description through the shared heading-escape mirror
      // (TASK-033) so a line like `## Additional Context` can't forge a section
      // boundary and hijack a user-owned section on the next parse. Same helper
      // the bug-report path uses; covers both the toolbar New-ticket path and the
      // post-processing Add path since both flow through here.
      const description = neutralizeBugText(bodyArea.value.trim()) || 'What needs doing and why.';
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
      // Folder-per-status layout (TASK-008): write the new ticket straight into
      // its status subfolder (tasks/todo/ or tasks/post-processing/) rather than
      // the top level, avoiding an immediate reconciliation move on the next poll.
      const tasksDir = tasksJoin(tab.folder, 'tasks');
      const subfolder = ticketFolderForStatus(status);
      const destDir = subfolder ? tasksJoin(tasksDir, subfolder) : tasksDir;
      await window.api.fs.mkdir(destDir);
      const filePath = tasksJoin(destDir, `${id}-${taskSlug(title)}.md`);
      const wr = await window.api.fs.writeFile(filePath, serializeTicket(fm, body));
      if (!wr || !wr.ok) {
        errEl.textContent = 'Create failed: ' + ((wr && wr.error) || 'unknown');
        createBtn.disabled = false;
        armCreate();
        return;
      }
      createBtn.disabled = false;
      cleanup();
      // TASK-132: creating a ticket clears any active board search (query state +
      // input value) so the newly created card is never hidden behind the filter;
      // the board then renders unfiltered.
      clearTasksSearch(tab);
      pollTasksOnce(tab, true);
      // TASK-079 Part A: a newly created buildable ticket auto-starts a build run.
      // Post-processing tickets are never built by the swarm, so skip those.
      if (status === 'todo') autoQueueBuildOnCreate(tab);
    } catch (err) {
      errEl.textContent = 'Create failed: ' + (err.message || err);
      createBtn.disabled = false;
      armCreate();
    }
  };

  // Bug create path (TASK-031). WRITE ORDER: update the ORIGINAL first (re-read +
  // append + write); only if that succeeds do we create the NEW bug ticket. A
  // failure to update the original therefore aborts before any bug ticket is
  // written, so we never leave an orphaned bug ticket pointing at an un-updated
  // original. Reuses appendBugReportToMarkdown + neutralizeBugText + the create
  // write path — no bespoke append/escape logic.
  const onCreateBug = async () => {
    const title = titleInput.value.trim();
    const originalId = bugOfSelect ? bugOfSelect.value : '';
    const bugDesc = bodyArea.value.trim();
    if (!title) { errEl.textContent = 'Title is required.'; titleInput.focus(); armCreate(); return; }
    if (!originalId) { errEl.textContent = 'Select the original ticket this bug is against.'; if (bugOfSelect) bugOfSelect.focus(); armCreate(); return; }
    if (!bugDesc) { errEl.textContent = 'Describe the bug before creating.'; bodyArea.focus(); armCreate(); return; }
    // Validate the original exists on the board BEFORE writing anything, so we
    // never create a bug ticket linking to a nonexistent original.
    let originalTicket = null;
    for (const tk of tab.tasks.tickets.values()) {
      if (tk && tk.fm && tk.fm.id === originalId) { originalTicket = tk; break; }
    }
    if (!originalTicket) { errEl.textContent = 'Original ticket ' + originalId + ' is no longer on the board.'; armCreate(); return; }
    createBtn.disabled = true;
    try {
      const now = new Date().toISOString();

      // ── STEP 1: update the ORIGINAL first. Re-read the freshest copy so a
      // concurrent agent write isn't clobbered, fold the bug into `## Bug
      // Reports` (inserted before `## Additional Context`, which is never
      // overwritten/moved), bump updated, preserve created, whole-file write.
      //
      // Retry / switch-back idempotence (TASK-042, generalising TASK-038): if a
      // STEP-1 fold already committed for THIS (originalId, id) pair this session,
      // skip it entirely — the original already carries the `## Bug Reports` entry
      // and re-appending would fold a duplicate. Because we track EVERY committed
      // target (not just the most-recent), a switch-back A→B→A recognises A as
      // already-folded and skips STEP 1, where the old single-slot memo (holding B)
      // would have wrongly double-folded A. A same-target STEP-2 retry (TASK-038)
      // stays correct — its key is still in the set.
      const key = foldKey(originalId, id);
      const step1AlreadyDone = bugFoldedTargets.has(key);
      if (!step1AlreadyDone) {
        const origPath = originalTicket.path;
        let origFm = originalTicket.fm;
        let origBody = originalTicket.body;
        let read = null;
        try {
          read = await window.api.fs.readFile(origPath);
        } catch (e) {
          errEl.textContent = 'Cannot read original ticket ' + originalId + ': ' + (e.message || e);
          createBtn.disabled = false; armCreate(); return;
        }
        if (!read || !read.ok || read.binary) {
          errEl.textContent = 'Cannot read original ticket ' + originalId + ((read && read.error) ? ': ' + read.error : '.');
          createBtn.disabled = false; armCreate(); return;
        }
        const parsed = parseTicketFrontmatter(read.content);
        if (!parsed) {
          errEl.textContent = 'Original ticket ' + originalId + ' is not a valid ticket file.';
          createBtn.disabled = false; armCreate(); return;
        }
        origFm = parsed.fm; origBody = parsed.body;
        // Name the new bug ticket id in the original's folded entry so the link is
        // bidirectional (TASK-037): the new ticket already references the original
        // (bug-of + `Bug against <ID>` body line), and now the original references
        // the new ticket via a `Reported as <NEW_ID>` line prefixed onto the bug
        // text. The WHOLE composed string (id line + desc) is passed as `bug`, so
        // appendBugReportToMarkdown's internal neutralizeBugText escapes it — the id
        // cannot forge a `## ` section boundary either.
        const newOrigBody = appendBugReportToMarkdown(origBody, { bug: 'Reported as ' + id + '\n' + bugDesc, timestamp: now });
        const newOrigFm = Object.assign({}, origFm);
        newOrigFm.updated = now;
        if (!newOrigFm.created) newOrigFm.created = now;
        const owr = await window.api.fs.writeFile(origPath, serializeTicket(newOrigFm, newOrigBody));
        if (!owr || !owr.ok) {
          errEl.textContent = 'Failed to update original ticket: ' + ((owr && owr.error) || 'unknown');
          createBtn.disabled = false; armCreate(); return;
        }
        // Keep the in-memory copy fresh so a subsequent poll/read isn't stale.
        originalTicket.body = newOrigBody;
        originalTicket.fm = newOrigFm;
        // STEP 1 committed — record this (originalId, id) fold so any later revisit
        // this session (same-target STEP-2 retry OR a switch-back to this original)
        // skips STEP 1 and cannot fold a duplicate `## Bug Reports` entry. STEP-1
        // FAILURE paths above return without adding, so a retry redoes STEP 1.
        bugFoldedTargets.add(key);
        // A newly-committed fold may now be stale relative to the current selection
        // if the user subsequently switches; refresh the switch warning state.
        updateBugSwitchWarning();
      }

      // ── STEP 2: create the NEW bug ticket in tasks/todo/, linked via `bug-of`.
      // The extra `bug-of` key is appended after the leading five by
      // serializeTicket and round-trips through parseTicketFrontmatter.
      const fm = { id, title, status: 'todo', created: now, updated: now };
      fm['bug-of'] = originalId;
      const description = neutralizeBugText(bugDesc);
      const body = [
        '',
        '## Description',
        'Bug against ' + neutralizeBugText(originalId),
        '',
        description,
        '',
        '## Acceptance Criteria',
        '- [ ] First testable criterion',
        '',
        '## Additional Context',
        '(User-owned. Read it before building. Never overwrite it.)',
        ''
      ].join('\n');
      const tasksDir = tasksJoin(tab.folder, 'tasks');
      const subfolder = ticketFolderForStatus('todo');
      const destDir = subfolder ? tasksJoin(tasksDir, subfolder) : tasksDir;
      await window.api.fs.mkdir(destDir);
      const filePath = tasksJoin(destDir, `${id}-${taskSlug(title)}.md`);
      const wr = await window.api.fs.writeFile(filePath, serializeTicket(fm, body));
      if (!wr || !wr.ok) {
        // STEP 2 failed but STEP 1 already committed. Leave this target's key in
        // bugFoldedTargets so a retry (TASK-038) skips STEP 1 and re-attempts only
        // STEP 2 — no duplicate `## Bug Reports` entry gets folded on retry.
        errEl.textContent = 'Bug ticket create failed (original was updated, retry writes only the bug ticket): ' + ((wr && wr.error) || 'unknown');
        createBtn.disabled = false;
        armCreate();
        return;
      }
      createBtn.disabled = false;
      cleanup();
      // TASK-132: clear any active board search so the new bug ticket is visible.
      clearTasksSearch(tab);
      pollTasksOnce(tab, true);
      // TASK-079 Part A: the new bug ticket is a plain `todo`, so auto-start a run.
      autoQueueBuildOnCreate(tab);
    } catch (err) {
      errEl.textContent = 'Bug create failed: ' + (err.message || err);
      createBtn.disabled = false;
      armCreate();
    }
  };

  const onCreate = async () => {
    if (bugMode) { await onCreateBug(); return; }
    await onCreateNormal();
  };

  disposeCancel = bindActionOnce(cancelBtn, 'click', onCancel);
  armBug();
  armCreate();

  // Forward-switch dangling-fold warning wiring (TASK-042, hardened TASK-044). A
  // persistent `change` listener on the original-select recomputes the warning
  // whenever the user picks a different original. attachBugSwitchWarning (mirror
  // of lib/bug-switch-warning.js) detaches any handler a prior open left on this
  // persistent DOM element, binds exactly one, and returns a disposer for cleanup
  // — guaranteeing no listener accumulation across modal re-opens.
  if (bugOfSelect) {
    disposeBugSwitch = attachBugSwitchWarning(bugOfSelect, updateBugSwitchWarning);
  }
}

// Open the planning modal (TASK-030). The user describes a feature (free text,
// typically a bullet list); on submit we hand it to the orchestrate plan flow by
// composing `/orchestrate plan <text>` and enqueuing it onto tab.promptQueue —
// the SAME prompt-queue handoff the Build button uses (there is no programmatic
// agent API). This button writes NO ticket files; the planner does that. Modeled
// on openNewTaskModal/openBugReportModal for the open/clear/focus/bindActionOnce
// lifecycle. The user's text is passed verbatim as a SINGLE prompt string — no
// truncation, no newline splitting.
function openPlanModal(tab) {
  if (!tab.folder) return;
  const modal = document.getElementById('planModal');
  if (!modal) return;
  const bodyArea = modal.querySelector('.plan-body');
  const errEl = modal.querySelector('.plan-error');
  const cancelBtn = modal.querySelector('.plan-cancel');
  const submitBtn = modal.querySelector('.plan-submit');

  bodyArea.value = '';
  errEl.textContent = '';
  submitBtn.disabled = false;
  modal.classList.remove('hidden');
  bodyArea.focus();

  let disposeSubmit = null;
  let disposeCancel = null;
  const cleanup = () => {
    modal.classList.add('hidden');
    if (disposeSubmit) disposeSubmit();
    if (disposeCancel) disposeCancel();
  };
  // Re-arm the once-submit listener for the empty-input retry path that leaves the
  // modal open: `{ once: true }` self-detaches on fire (mirror openNewTaskModal).
  const armSubmit = () => { disposeSubmit = bindActionOnce(submitBtn, 'click', onSubmit); };
  const onCancel = () => cleanup();
  const onSubmit = () => {
    const text = bodyArea.value.trim();
    if (!text) {
      errEl.textContent = 'Describe what you want built.';
      bodyArea.focus();
      armSubmit();
      return;
    }
    // Compose the plan command and enqueue it exactly like saveQueuePrompt/queueBuild:
    // push onto the queue, repaint, and only dispatch immediately when the agent is
    // idle (finished). Multi-line text stays a single string — no newline split.
    tab.promptQueue.push('/orchestrate plan ' + text);
    renderQueue(tab);
    if (tab.status === 'finished') tryDispatchNextPrompt(tab);
    cleanup();
    // TASK-132: running Plan while a filter is active clears the active board
    // search (query state + input value) and renders unfiltered, so the tickets
    // the planner is about to create are not hidden behind a stale filter.
    clearTasksSearch(tab);
  };
  disposeCancel = bindActionOnce(cancelBtn, 'click', onCancel);
  armSubmit();
}

// ── Bug reports (TASK-020) ──────────────────────────────────────────────────
// Browser-side mirror of lib/ticket-bug-reports.js (the renderer can't require
// Node modules, so the append logic is duplicated here — same pattern as the
// TASK-003/007/008 helpers). Appends a `## Bug Reports` entry, preserving every
// other section verbatim and keeping the user-owned `## Additional Context`
// section at the tail. Kept in sync with the pure lib helper.

// Neutralize heading-forging in user bug text (TASK-022). Escapes the leading
// run of `#`s on each line with a backslash so no body line starts with `## `
// and forges a level-2 section boundary when the ticket is re-parsed, while the
// text still renders as the literal `## …`. MUST stay byte-for-byte in step
// with the canonical shared helper `escapeLeadingHeadingRun` in
// lib/markdown-escape.js (TASK-027).
function neutralizeBugText(text) {
  const s = text == null ? '' : String(text);
  return s
    .split('\n')
    .map((line) => line.replace(/^(\s*)(#+)(\s)/, '$1\\$2$3'))
    .join('\n');
}

function appendBugReportToMarkdown(markdown, { bug, timestamp } = {}) {
  const BUG_REPORTS_HEADING = '## Bug Reports';
  const ADDITIONAL_CONTEXT_HEADING = '## Additional Context';
  const body = typeof markdown === 'string' ? markdown : '';
  const isSection = (headingLine, section) =>
    headingLine.trim().toLowerCase() === section.toLowerCase();

  const lines = body.split('\n');
  const preamble = [];
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (/^## /.test(line)) {
      if (current) sections.push(current);
      current = { heading: line, lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) sections.push(current);

  const ts = timestamp || new Date().toISOString();
  const bugText = neutralizeBugText(bug == null ? '' : String(bug).trim());
  const entryLines = [`### ${ts}`, '', bugText];

  const idx = sections.findIndex((s) => isSection(s.heading, BUG_REPORTS_HEADING));
  if (idx !== -1) {
    const sec = sections[idx];
    const kept = sec.lines.slice();
    while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
    sec.lines = kept.length ? [...kept, '', ...entryLines] : ['', ...entryLines];
  } else {
    const newSection = { heading: BUG_REPORTS_HEADING, lines: ['', ...entryLines] };
    const acIdx = sections.findIndex((s) => isSection(s.heading, ADDITIONAL_CONTEXT_HEADING));
    if (acIdx !== -1) sections.splice(acIdx, 0, newSection);
    else sections.push(newSection);
  }

  const out = preamble.slice();
  for (const sec of sections) {
    out.push(sec.heading);
    for (const l of sec.lines) out.push(l);
  }
  return out.join('\n');
}

// Open the bug-capture modal for a `done` ticket dragged onto `todo` (TASK-020).
// On submit with non-empty text: re-read the freshest file, append the bug to the
// `## Bug Reports` section (preserving all other sections incl. Additional
// Context), write the whole file back, then move the ticket to `todo`. Cancel or
// empty input aborts without touching the ticket.
function openBugReportModal(tab, file) {
  const ticket = tab.tasks.tickets.get(file);
  if (!ticket) return;
  const modal = document.getElementById('bugReportModal');
  if (!modal) return;
  const idEl = modal.querySelector('.bugreport-id');
  const bodyArea = modal.querySelector('.bugreport-body');
  const errEl = modal.querySelector('.bugreport-error');
  const cancelBtn = modal.querySelector('.bugreport-cancel');
  const submitBtn = modal.querySelector('.bugreport-submit');

  idEl.textContent = (ticket.fm && ticket.fm.id) || '';
  bodyArea.value = '';
  errEl.textContent = '';
  submitBtn.disabled = false;
  modal.classList.remove('hidden');
  bodyArea.focus();

  let disposeSubmit = null;
  let disposeCancel = null;
  const cleanup = () => {
    modal.classList.add('hidden');
    if (disposeSubmit) disposeSubmit();
    if (disposeCancel) disposeCancel();
  };
  // Re-arm the once-submit listener for retry paths (empty input / save error)
  // that intentionally leave the modal open: `{ once: true }` self-detaches on
  // fire, so a subsequent submit click would be dead without re-binding.
  const armSubmit = () => { disposeSubmit = bindActionOnce(submitBtn, 'click', onSubmit); };
  const onCancel = () => cleanup();
  const onSubmit = async () => {
    const bug = bodyArea.value.trim();
    if (!bug) { errEl.textContent = 'Describe the bug before submitting.'; bodyArea.focus(); armSubmit(); return; }
    submitBtn.disabled = true;
    try {
      const filePath = ticket.path;
      let fm = ticket.fm;
      let body = ticket.body;
      // Re-read the freshest copy so a concurrent agent write isn't clobbered.
      try {
        const fr = await window.api.fs.readFile(filePath);
        if (fr && fr.ok && !fr.binary) {
          const parsed = parseTicketFrontmatter(fr.content);
          if (parsed) { fm = parsed.fm; body = parsed.body; }
        }
      } catch (_) {}
      const newBody = appendBugReportToMarkdown(body, { bug, timestamp: new Date().toISOString() });
      const newFm = Object.assign({}, fm);
      newFm.updated = new Date().toISOString();
      if (!newFm.created) newFm.created = newFm.updated;
      const wr = await window.api.fs.writeFile(filePath, serializeTicket(newFm, newBody));
      if (!wr || !wr.ok) {
        errEl.textContent = 'Save failed: ' + ((wr && wr.error) || 'unknown');
        submitBtn.disabled = false;
        armSubmit();
        return;
      }
      // Keep the in-memory copy fresh so moveTicketToStatus re-reads/writes the
      // bug body (it reads the freshest file anyway, but this avoids a stale body).
      ticket.body = newBody;
      ticket.fm = newFm;
      cleanup();
      await moveTicketToStatus(tab, file, 'todo');
    } catch (err) {
      errEl.textContent = 'Save failed: ' + (err.message || err);
      submitBtn.disabled = false;
      armSubmit();
    }
  };
  // Bind via bindActionOnce (mirror of lib/modal-actions.js): each open first
  // DETACHES the prior invocation's handler (bound to an earlier `file`) then
  // binds fresh with `{ once: true }`. A re-open before dismissal therefore
  // never leaves a stale-file submit listener attached, so a submit only ever
  // writes/moves the ticket named by the most recent open.
  disposeCancel = bindActionOnce(cancelBtn, 'click', onCancel);
  armSubmit();
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
      postReplies: tab.slack.postReplies,
      summarize: tab.slack.summarize
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
  // Stop and null the periodic flush timer for this tab (no leak across folder
  // switches) even though stopSlackListening already cleared it (TASK-061).
  if (s.flushTimer) { clearInterval(s.flushTimer); s.flushTimer = null; }
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
  // Clear any half-finished multi-step command prompt (TASK-072).
  s.pendingCommand = null;
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
  if (cfg && typeof cfg.summarize === 'boolean') {
    tab.els.slackSummarize.checked = cfg.summarize;
    s.summarize = cfg.summarize;
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
    s.summarize = !!tab.els.slackSummarize.checked;
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
  // Ensure the periodic flush timer is stopped and nulled (no leak) even though
  // stopSlackListening already cleared it (TASK-061).
  if (s.flushTimer) { clearInterval(s.flushTimer); s.flushTimer = null; }
  // Clear the session anchor + in-flight state so a later reconnect creates a
  // fresh single anchor rather than reusing a stale thread (criterion 7).
  s.threadTs = null;
  s.awaitingResponse = false;
  s.captureBuffer = '';
  s.replyThreadTs = null;
  s.inbox = [];
  // Clear any half-finished multi-step command prompt (TASK-072).
  s.pendingCommand = null;
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
  // Start streaming mid-run output to the anchor thread (TASK-061).
  startSlackFlushTimer(tab);
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
  stopSlackFlushTimer(tab);
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

// Should the accumulated capture buffer be flushed to the anchor thread on a
// periodic tick WHILE the run is still busy? True only when the proxy is
// enabled, replies are being posted, there is buffered output, and the run is
// busy. Mirrors shouldFlushCapture in lib/slack-proxy.js; keep in sync.
function slackShouldFlushCapture(s) {
  return !!(
    slackProxyEnabled(s) &&
    s.postReplies &&
    typeof s.captureBuffer === 'string' &&
    s.captureBuffer.length > 0 &&
    s.busy === true
  );
}

// Mask common secret shapes in AUTO-POSTED terminal output before it reaches
// Slack (slackFlushTick + slackOnFinished). Runs AFTER cleanTerminalOutput,
// which strips ANSI/chrome but does NO secret redaction. Deliberately
// CONSERVATIVE to avoid mangling ordinary prose/code: anchors on known token
// prefixes and high-entropy length thresholds. Each match → '***REDACTED***'.
// Covers: secret-looking KEY=VALUE / KEY: VALUE pairs, Bearer <token>, sk-…,
// xoxb-/xoxp-/xoxe-/xoxd-/xapp-…, ghp_…, github_pat_…, glpat-…, npm_…, dop_v1_…,
// AIza…, SG.<id>.<secret>, bare JWTs, AKIA…/ASIA… and hex(>=32)/base64(>=40) blobs.
// Never throws: null/undefined/non-string → ''.
// Mirrors redactSecrets in lib/slack-proxy.js; keep in sync.
function redactSecrets(text) {
  if (typeof text !== 'string' || !text) return '';
  const R = '***REDACTED***';
  let out = text;
  // KEY=VALUE / KEY: VALUE with a secret-looking key name (mask value, keep key).
  out = out.replace(
    /\b([\w.-]*(?:secret|token|key|password|passwd|pwd|apikey)[\w.-]*)(\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s]+)/gi,
    (m, key, sep) => key + sep + R
  );
  // Bearer <token> (keep the scheme word, mask the credential).
  out = out.replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/g, 'Bearer ' + R);
  // Inline connection-string credentials scheme://user:password@host — mask
  // ONLY the password (group 2), keeping scheme+user (group 1) and the '@'
  // (group 3) readable; also covers the password-only form scheme://:pass@host
  // (empty user). Char classes exclude '@', whitespace and '/' so the match
  // cannot run past the authority, and a URL with no ':pass@' segment (e.g.
  // https://example.com/path or http://host:8080/path) is left untouched.
  // Linear — no nested quantifiers, so backtracking-safe.
  out = out.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:@/]*:)([^@\s/]+)(@)/g, '$1' + R + '$3');
  // Known token prefixes with plausible length/charset.
  out = out.replace(/\bsk-[A-Za-z0-9_-]{16,}/g, R);
  out = out.replace(/\bx(?:ox[baprsed]|app)-[A-Za-z0-9-]{8,}/g, R);
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, R);
  out = out.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, R);
  out = out.replace(/\bglpat-[A-Za-z0-9_-]{16,}/g, R);
  out = out.replace(/\bnpm_[A-Za-z0-9]{30,}/g, R);
  out = out.replace(/\bdop_v1_[A-Za-z0-9]{40,}/g, R);
  out = out.replace(/\bAIza[A-Za-z0-9_-]{20,}/g, R);
  out = out.replace(/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, R);
  out = out.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, R);
  // Bare JWTs (base64url header.payload.signature) — mask BEFORE the blob rules.
  out = out.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, R);
  // High-entropy blobs above a length threshold (hex first, then base64). These
  // mask UNCONDITIONALLY: over-redaction (e.g. masking a bare git SHA) is the safe
  // direction for a security boundary that posts to an external destination.
  // A blanket 40-hex exemption was tried (TASK-069) and reverted — real secrets
  // are also exactly 40 hex (legacy GitHub OAuth tokens, hex-encoded 160-bit keys)
  // and would have leaked unlabeled.
  out = out.replace(/\b[0-9a-fA-F]{32,}\b/g, R);
  out = out.replace(/(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/g, R);
  return out;
}

// Mechanical, deterministic readability pass for the two AUTO-POST paths
// (slackFlushTick + slackOnFinished). Runs BETWEEN cleanTerminalOutput and
// redactSecrets so redactSecrets stays the LAST transform before posting and
// the TASK-063 guarantee is untouched. Dedupe / strip / collapse ONLY — never
// rewrites, reorders or summarizes: collapses consecutive identical lines,
// drops whole Claude-TUI noise lines (spinner "…ing…" progress lines,
// "(esc to interrupt)" hints, standalone elapsed/token counters, ⏵⏵ mode
// hints), collapses 2+ blank-line runs to one, trims. Never throws:
// null/undefined/non-string → ''.
// Mirrors humanizeSlackOutput in lib/slack-proxy.js; keep in sync.
function humanizeSlackOutput(text) {
  if (typeof text !== 'string' || !text) return '';
  // Whole-line Claude-TUI noise patterns, tested against the TRIMMED line so a
  // real content line that merely contains such a glyph mid-line is never hit.
  const NOISE = [
    // Spinner progress line: leading spinner glyph + a "…ing…" gerund phrase,
    // e.g. "✻ Thinking… (esc to interrupt)".
    /^[✻✽✶✢✳✷✴✵✺∗·]\s+.*[A-Za-z]+ing(?:…|\.\.\.)/,
    // Standalone "(esc to interrupt)" hint line.
    /^\(?\s*esc to interrupt\s*\)?$/i,
    // Standalone elapsed / token counter line, e.g. "12s", "↑ 1.2k tokens",
    // "5s · 234 tokens".
    /^[·•\s]*(?:\d+(?:\.\d+)?\s*[smh](?:\s+\d+(?:\.\d+)?\s*[smh])*|[↑↓⚒]?\s*[\d.,]+\s*[kKmM]?\s*tokens?)(?:\s*·\s*(?:\d+(?:\.\d+)?\s*[smh](?:\s+\d+(?:\.\d+)?\s*[smh])*|[↑↓⚒]?\s*[\d.,]+\s*[kKmM]?\s*tokens?))*$/i,
    // Mode/permission hint line, e.g. "⏵⏵ accept edits on (shift+tab to cycle)".
    /^⏵/,
  ];
  const kept = [];
  let prev = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r/g, '');
    const trimmed = line.trim();
    if (trimmed && NOISE.some((re) => re.test(trimmed))) continue;
    if (line === prev) continue; // collapse consecutive identical (TUI redraw)
    kept.push(line);
    prev = line;
  }
  // Collapse any remaining 2+ blank-line runs to a single blank line, then trim.
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Neutralize ("defang") Slack broadcast/mention CONTROL SEQUENCES in app-posted
// command / failure replies so crafted, semi-trusted content (thread text,
// ticket titles, error strings) cannot induce a channel-wide ping or a mention.
// Replace the opening `<` of a `<!…>` / `<@…>` / `<#…>` token with `&lt;`, which
// Slack renders as a literal `<`, so the token displays inertly and is never
// interpreted. A lone `<` in ordinary prose/code is untouched. Never throws.
// Applied on the command/failure reply path only (handleSlackCommand); the
// user-composed and Claude-output post paths are deliberately left alone.
// Mirrors defangSlackControlSequences in lib/slack-proxy.js; keep in sync.
function defangSlackControlSequences(text) {
  if (typeof text !== 'string' || !text) return '';
  return text.replace(/<([!@#][^>\n]*)>/g, '&lt;$1>');
}

// ── Slack command core (mirrors lib/slack-commands.js) ─────────────────────
// The renderer cannot require() the lib module, so the pure command-decision
// functions are mirrored VERBATIM here and kept in sync with
// lib/slack-commands.js. See that file for the full rationale. Handlers do NOT
// live in the pure core — they are wired below in SLACK_COMMAND_HANDLERS keyed
// by the entry `name`.

// The built-in command registry. The `tasks` command (TASK-058) answers "show
// me the tasks" (and aliases) in-thread with the live board; the `help` command
// (TASK-059) lists every registered command. Handlers live below in
// SLACK_COMMAND_HANDLERS keyed by `name`.
// Mirrors DEFAULT_COMMANDS in lib/slack-commands.js; keep in sync.
const SLACK_DEFAULT_COMMANDS = [
  {
    name: 'tasks',
    description: 'Show the tasks board and what is being worked on',
    patterns: ['show me the tasks', 'show tasks', 'list tasks', 'tasks', 'what are you working on'],
  },
  {
    name: 'help',
    description: 'List the commands this thread understands',
    patterns: ['help', 'commands', 'show commands', 'what can you do'],
  },
  {
    name: 'status',
    description: 'Show session status: folder, Claude activity, queue and active tickets',
    patterns: ['status', 'show status', "what's your status", 'are you busy'],
  },
  {
    name: 'create-ticket',
    description: 'Create a new ticket on the tasks board',
    patterns: ['create ticket', 'create a ticket', 'new ticket', 'add ticket'],
  },
];

// Normalize a raw Slack message into the canonical form used for matching:
// lowercase, trimmed, internal whitespace runs collapsed to single spaces, and
// trailing punctuation (. ! ? …) stripped. Never throws: anything that is not a
// string returns ''.
// Mirrors normalizeCommandInput in lib/slack-commands.js; keep in sync.
function normalizeCommandInput(text) {
  if (typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?…]+$/u, '')
    .trim();
}

// Match a message against a registry. `text` is normalized, then the FIRST entry
// (registry order) whose `patterns` (each normalized) contains that string wins.
// Matching is WHOLE-PHRASE after normalization — never substring/fuzzy. Returns
// { name, command } or null. Never throws.
// Mirrors matchCommand in lib/slack-commands.js; keep in sync.
function matchCommand(text, registry = SLACK_DEFAULT_COMMANDS) {
  const normalized = normalizeCommandInput(text);
  if (!normalized) return null;
  if (!Array.isArray(registry)) return null;
  for (const entry of registry) {
    if (!entry || !Array.isArray(entry.patterns)) continue;
    for (const pattern of entry.patterns) {
      if (typeof pattern !== 'string') continue;
      if (normalizeCommandInput(pattern) === normalized) {
        return { name: entry.name, command: entry };
      }
    }
  }
  return null;
}

// List the commands in a registry as [{ name, description }] in registry order.
// Returns [] for a null/empty/non-array registry and never throws; malformed
// entries are skipped.
// Mirrors listCommands in lib/slack-commands.js; keep in sync.
function listCommands(registry = SLACK_DEFAULT_COMMANDS) {
  if (!Array.isArray(registry)) return [];
  const out = [];
  for (const entry of registry) {
    if (!entry) continue;
    out.push({ name: entry.name, description: entry.description });
  }
  return out;
}

// Format the tasks board into a single Slack mrkdwn string (TASK-058, made
// config-aware in TASK-104). Inputs:
//   tickets  — an array of ticket wrappers `{ fm }` (as produced by the board
//              poll) OR bare frontmatter objects; both are tolerated.
//   columns  — OPTIONAL normalised board columns (each { status, label, system },
//              as produced by normalizeTasksColumns from the shared, already-loaded
//              team config — NOT re-read here). Omitted / null / junk yields the
//              six fixed system lanes, so the no-config output is byte-identical
//              to the historic fixed-lane summary.
// See the handler below for how the board + config are read. Never throws:
// empty/null `tickets` → "The tasks board is empty."; tickets missing id/title
// render "(no id)"/"(untitled)" placeholders.
// Mirrors formatTasksSummary in lib/slack-commands.js; keep in sync. ADAPTATION:
// the lib version pulls ACTIVE_STATUSES/FAILED_STATUS/laneStatusesFor/
// laneForStatusFor from require('./ticket-lanes'); the renderer cannot require
// Node modules, so it reuses the EXISTING renderer lane mirrors
// (TASKS_ACTIVE_STATUSES / TASKS_FAILED_STATUS, ~5199) and derives the lane order
// via tasksLaneStatusesFor — the renderer mirror of laneStatusesFor that RE-INJECTS
// the six system lanes and interleaves user columns, so a raw/PARTIAL `columns`
// array yields the same order + counts the lib does (TASK-122; normalizeTasksColumns
// already returns that order, so today's normalised-columns output is unchanged).
// Routing uses tasksLaneForStatusFor (mirror of laneForStatusFor): failed-testing →
// testing, system/user lane status → itself, anything else → unknown.
function formatTasksSummary(tickets, columns) {
  if (!Array.isArray(tickets) || tickets.length === 0) {
    return 'The tasks board is empty.';
  }

  const fms = tickets.map((t) => (t && t.fm ? t.fm : t) || {});
  const idOf = (fm) => (fm.id != null && String(fm.id).trim() !== '' ? String(fm.id).trim() : '(no id)');
  const titleOf = (fm) => (fm.title != null && String(fm.title).trim() !== '' ? String(fm.title).trim() : '(untitled)');
  const lineOf = (fm) => `${idOf(fm)} — ${titleOf(fm)} (${fm.status})`;

  // Config-aware lane order + labels. tasksLaneStatusesFor re-injects the six
  // system lanes and interleaves user columns (== laneStatusesFor), so partial /
  // raw columns match the lib; null/junk/[] → the six system lanes, keeping the
  // no-config output identical to the historic fixed-lane summary. The count-piece
  // label stays the raw SLUG for system lanes (regression) and uses the configured
  // LABEL for user columns.
  const cols = Array.isArray(columns)
    ? columns.filter((c) => c && typeof c === 'object' && !Array.isArray(c))
    : [];
  const laneOrder = tasksLaneStatusesFor(cols);
  const labelBySlug = new Map();
  for (const col of cols) {
    const slug = typeof col.status === 'string' ? col.status.trim() : '';
    if (slug === '' || labelBySlug.has(slug)) continue;
    const label = col.system === true
      ? slug
      : (typeof col.label === 'string' && col.label.trim() !== '' ? col.label : slug);
    labelBySlug.set(slug, label);
  }
  const pieceLabel = (slug) => (labelBySlug.has(slug) ? labelBySlug.get(slug) : slug);

  const active = fms.filter((fm) => TASKS_ACTIVE_STATUSES.includes(fm.status));
  const failed = fms.filter((fm) => fm.status === TASKS_FAILED_STATUS);

  // Lane counts: seed every configured lane at 0 and route via tasksLaneForStatusFor
  // (failed-testing → testing; system/user status → itself; else "unknown"). A lane
  // outside laneOrder (only "unknown") folds into the trailing unknown count.
  const counts = new Map(laneOrder.map((s) => [s, 0]));
  let unknown = 0;
  for (const fm of fms) {
    const lane = tasksLaneForStatusFor(fm.status, cols);
    if (counts.has(lane)) counts.set(lane, counts.get(lane) + 1);
    else unknown += 1;
  }

  const parts = ['*Currently working on:*'];
  if (active.length) {
    for (const fm of active) parts.push(lineOf(fm));
  } else {
    parts.push('Nothing is being worked on right now.');
  }

  if (failed.length) {
    parts.push('', '*Failed testing:*');
    for (const fm of failed) parts.push(lineOf(fm));
  }

  const countPieces = laneOrder.map((s) => `${pieceLabel(s)} ${counts.get(s)}`);
  if (unknown > 0) countPieces.push(`unknown ${unknown}`);
  parts.push('', countPieces.join(' · '));

  return parts.join('\n');
}

// Format the command registry into a single Slack mrkdwn help string (TASK-059).
// Iterates the SAME registry the matcher uses, so help can never drift from the
// commands that actually work. One line per command, in registry order:
//   *<name>* — <description> (say: "<pattern1>", "<pattern2>", …)
// Entries with a missing/empty description render "(no description)"; entries
// with no usable (non-empty string) patterns omit the "(say: …)" suffix. An
// empty/null/non-array registry (or one with no renderable entries) returns
// "No commands are available." Never throws; malformed entries are skipped.
// Mirrors formatHelp in lib/slack-commands.js; keep in sync.
function formatHelp(registry = SLACK_DEFAULT_COMMANDS) {
  if (!Array.isArray(registry) || registry.length === 0) {
    return 'No commands are available.';
  }
  const lines = [];
  for (const entry of registry) {
    if (!entry) continue;
    const name = entry.name != null && String(entry.name).trim() !== '' ? String(entry.name).trim() : '(unnamed)';
    const description = entry.description != null && String(entry.description).trim() !== '' ? String(entry.description).trim() : '(no description)';
    let line = `*${name}* — ${description}`;
    const patterns = Array.isArray(entry.patterns)
      ? entry.patterns.filter((p) => typeof p === 'string' && p.trim() !== '')
      : [];
    if (patterns.length) {
      line += ` (say: ${patterns.map((p) => `"${p}"`).join(', ')})`;
    }
    lines.push(line);
  }
  if (lines.length === 0) return 'No commands are available.';
  return lines.join('\n');
}

// Format a one-shot session snapshot into a single Slack mrkdwn string
// (TASK-060). Pure formatting: the status handler below gathers the live `info`
// object and this function shapes it into text. Every field is optional — a
// missing/partial/non-object `info` renders placeholders and NEVER throws.
// Mirrors formatStatusReply in lib/slack-commands.js; keep in sync (BYTE-IDENTICAL).
function formatStatusReply(info) {
  const i = info && typeof info === 'object' ? info : {};
  const folder = i.folder ? String(i.folder) : '(no folder open)';
  const claude = i.claudeState === 'busy' ? 'busy' : 'idle';
  const transport = i.transport === 'socket' ? 'Socket Mode' : i.transport === 'poll' ? 'polling' : 'none';
  const queued = typeof i.queued === 'number' && Number.isFinite(i.queued) ? i.queued : 0;
  const activeTickets = i.activeTickets == null ? 'unknown' : i.activeTickets;
  return [
    '*Session status*',
    `Folder: ${folder}`,
    `Claude: ${claude}`,
    `Transport: ${transport}`,
    `Queued: ${queued}`,
    `Active tickets: ${activeTickets}`,
  ].join('\n');
}

// Parse a two-step "create ticket" reply into a ticket draft (TASK-072). See the
// full rules in the lib comment: case-insensitive `title:`/`description:` labels
// in either order, comma/newline-preceded field boundaries, first-label-wins,
// multiline/comma-tolerant description, required non-empty title, missing/empty
// description → default. Never throws.
// Mirrors parseCreateTicketReply in lib/slack-commands.js; keep in sync (BYTE-IDENTICAL).
function parseCreateTicketReply(text) {
  if (typeof text !== 'string') return { ok: false, error: 'Expected a text reply.' };
  const re = /(^|[,\n])\s*(title|description)\s*:/gi;
  const matches = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    matches.push({ field: m[2].toLowerCase(), boundary: m.index, valueStart: m.index + m[0].length });
  }
  const fields = {};
  for (let i = 0; i < matches.length; i++) {
    const end = i + 1 < matches.length ? matches[i + 1].boundary : text.length;
    const value = text.slice(matches[i].valueStart, end).trim();
    if (!(matches[i].field in fields)) fields[matches[i].field] = value;
  }
  const title = (fields.title || '').trim();
  if (!title) return { ok: false, error: 'Missing title.' };
  const description = (fields.description || '').trim() || 'What needs doing and why.';
  return { ok: true, title, description };
}

// TASK-072: the two-step create-ticket prompt strings. Both restate the exact
// reply format the parser accepts; the re-prompt fires on an unparseable reply.
const CREATE_TICKET_PROMPT = 'What ticket should I create? Reply with `title: <your title>, description: <your description>` (description optional), or say `cancel`.';
const CREATE_TICKET_REPROMPT = "Sorry, I couldn't read that. Reply with `title: <your title>, description: <your description>` (description optional), or say `cancel`.";

// Renderer-side handler map: command `name` → async (tab, msg) => reply text.
// Handlers return a reply STRING; handleSlackCommand posts it into the anchor
// thread (with chunkText/postToSlack chunking) and never forwards it to Claude.
const SLACK_COMMAND_HANDLERS = {
  // TASK-058: reply with the live tasks board. Force-refreshes the board first
  // (the `true` flag bypasses the "tasks tab visible" gate) and reads the map
  // AFTER the awaited poll so the summary is never a stale snapshot. A failed
  // poll leaves an empty map → formatTasksSummary returns "The tasks board is
  // empty." rather than throwing.
  tasks: async (tab) => {
    if (!tab.folder) return 'No project folder is open.';
    let exists = false;
    try {
      const res = await window.api.fs.exists(tasksJoin(tab.folder, 'tasks'));
      exists = !!(res && res.ok && res.exists);
    } catch (_) {
      exists = false;
    }
    if (!exists) return 'No tasks board found in this project.';
    await pollTasksOnce(tab, true);
    // Config-aware summary (TASK-104): reuse the ALREADY-LOADED team config from
    // the board poll (tab.tasks.config) — normalizeTasksColumns tolerates a null
    // config (→ the six system lanes), so this never re-reads team-config.json.
    return formatTasksSummary(
      Array.from(tab.tasks.tickets.values()),
      normalizeTasksColumns(tab.tasks && tab.tasks.config));
  },
  // TASK-059: list every registered command from the live registry so help can
  // never drift from what the matcher actually understands. Pure formatting, no
  // I/O — works even while Claude is busy.
  help: async () => formatHelp(SLACK_DEFAULT_COMMANDS),
  // TASK-060: one-shot session snapshot — open folder, Claude activity, live
  // transport, queued Slack messages and how many tickets are actively worked.
  // Reads live state only; posts in-thread and never forwards to Claude, so it
  // works while Claude is busy and correctly reports "busy". The board read is
  // force-refreshed (bypasses the "tasks tab visible" gate) and wrapped in
  // try/catch: no folder OR any failure → activeTickets = null ("unknown"),
  // never crashing / never a silent no-reply.
  status: async (tab) => {
    let activeTickets = null;
    if (tab.folder) {
      try {
        await pollTasksOnce(tab, true);
        activeTickets = 0;
        for (const tk of tab.tasks.tickets.values()) {
          if (tk && tk.fm && TASKS_ACTIVE_STATUSES.includes(tk.fm.status)) activeTickets += 1;
        }
      } catch (_) {
        activeTickets = null;
      }
    }
    const info = {
      folder: tab.folder,
      claudeState: tab.status,
      transport: tab.slack.transport,
      queued: (tab.slack.inbox || []).length,
      activeTickets,
    };
    return formatStatusReply(info);
  },
  // TASK-072: begin the two-step create-ticket prompt. Refuses (setting NO
  // pending state) when no folder is open; otherwise records the pending prompt
  // on tab.slack and returns the prompt text. Re-issuing "create ticket" while a
  // prompt is already open is handled by the pending check in
  // handleIncomingSlackMessage (which re-prompts) — at most one pending command.
  'create-ticket': async (tab) => {
    if (!tab.folder) return 'No project folder is open.';
    tab.slack.pendingCommand = { name: 'create-ticket' };
    return CREATE_TICKET_PROMPT;
  },
};

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

  // The user's message always shows in the pane first.
  appendSlackMessage(tab, { who: 'slack', author: msg.user || 'user', text, ts: msg.ts });

  // Pending two-step prompt (TASK-072)? A create-ticket prompt consumes the next
  // accepted anchor-thread reply BEFORE any command match: while pending, this
  // reply is never matched against the registry (so "status"/"help"/etc. do NOT
  // run), never pushed to s.inbox and never forwarded to Claude. `cancel` exits;
  // anything else is parsed by the create-ticket flow.
  if (s.pendingCommand && s.pendingCommand.name === 'create-ticket') {
    handleCreateTicketReply(tab, text);
    return;
  }

  // App-handled command? Answer it in-thread and RETURN — the message never
  // enters the inbox and no pty write ever occurs for it. Commands run even
  // while Claude is busy (they bypass the idle gate in slackTryDispatch).
  const matched = matchCommand(text, SLACK_DEFAULT_COMMANDS);
  if (matched) {
    handleSlackCommand(tab, matched, msg);
    return;
  }

  s.inbox.push({ text, ts: msg.ts, user: msg.user });
  slackTryDispatch(tab);
}

// Run an app-side command matched in the anchor thread and post its reply back
// into that SAME thread. Never forwards to Claude, never touches the idle gate
// or dispatch state (awaitingResponse / captureBuffer / tab.status), and never
// crashes the renderer — a throwing/rejecting handler posts a short failure
// reply instead.
async function handleSlackCommand(tab, matched, msg) {
  const s = tab.slack;
  const handler = SLACK_COMMAND_HANDLERS[matched.name];
  if (typeof handler !== 'function') {
    // Command is known to the registry but has no handler wired in this build.
    postToSlack(tab, "That command isn't available in this session.", s.threadTs);
    return;
  }
  try {
    // Defang Slack control sequences (mentions/broadcasts) in handler replies:
    // TASK-058/059/060 echo semi-trusted thread/ticket/error content, so a
    // crafted <!channel> etc. must not become a live ping via the reply.
    const replyText = defangSlackControlSequences(await handler(tab, msg));
    if (typeof replyText === 'string' && replyText.trim()) {
      postToSlack(tab, replyText, s.threadTs);
      appendSlackMessage(tab, { who: 'system', text: replyText });
    }
  } catch (err) {
    // Caught sync throws AND rejected promises: post a failure reply, never crash.
    // Error messages can carry attacker-derived content, so defang before posting.
    const detail = (err && err.message) || String(err);
    postToSlack(tab, defangSlackControlSequences('Command failed: ' + detail), s.threadTs);
  }
}

// Post a reply from the create-ticket pending flow (TASK-072). Every reply this
// flow emits (prompt echo, re-prompt, confirmation, errors) is defanged so a
// crafted <!channel> in a title/description can never become a live ping, then
// posted into the anchor thread and mirrored into the Slack pane — exactly like
// handleSlackCommand's reply path.
function postCreateTicketReply(tab, text) {
  const s = tab.slack;
  const reply = defangSlackControlSequences(text);
  if (!reply) return;
  postToSlack(tab, reply, s.threadTs);
  appendSlackMessage(tab, { who: 'system', text: reply });
}

// Consume a reply while a create-ticket prompt is pending (TASK-072). `cancel`
// (normalized) clears the pending state and confirms cancellation. Otherwise the
// reply is parsed by parseCreateTicketReply: an unparseable/empty-title reply
// STAYS pending and re-prompts; a successful parse creates the ticket exactly
// like the New-ticket modal path (onCreateNormal) — force-poll, nextTaskId,
// identical body template, serializeTicket into tasks/todo/, then re-poll and a
// confirmation reply. File I/O only (never touches Claude), so it works while
// Claude is busy. Never throws — any failure clears pending and reports it.
async function handleCreateTicketReply(tab, text) {
  const s = tab.slack;
  // `cancel` always exits the pending prompt.
  if (normalizeCommandInput(text) === 'cancel') {
    s.pendingCommand = null;
    postCreateTicketReply(tab, 'Ticket creation cancelled.');
    return;
  }
  const parsed = parseCreateTicketReply(text);
  if (!parsed.ok) {
    // Unparseable / empty title → restate the format and stay pending.
    postCreateTicketReply(tab, CREATE_TICKET_REPROMPT);
    return;
  }
  try {
    // Force-refresh the board so nextTaskId sees the latest ids, then build the
    // ticket with the SAME frontmatter + body template as onCreateNormal. The
    // title is newline-neutralized by serializeTicket/frontmatterValueLine (no
    // frontmatter injection); the description runs through neutralizeBugText so a
    // line like "## Additional Context" cannot forge a section boundary.
    // Residual race: two near-simultaneous creates can compute the same id
    // between this poll and the write; the board reconciles on the next poll.
    await pollTasksOnce(tab, true);
    const id = nextTaskId(tab);
    const now = new Date().toISOString();
    const fm = { id, title: parsed.title, status: 'todo', created: now, updated: now };
    const description = neutralizeBugText(parsed.description) || 'What needs doing and why.';
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
    const tasksDir = tasksJoin(tab.folder, 'tasks');
    const subfolder = ticketFolderForStatus('todo');
    const destDir = subfolder ? tasksJoin(tasksDir, subfolder) : tasksDir;
    await window.api.fs.mkdir(destDir);
    const filePath = tasksJoin(destDir, `${id}-${taskSlug(parsed.title)}.md`);
    const wr = await window.api.fs.writeFile(filePath, serializeTicket(fm, body));
    if (!wr || !wr.ok) {
      s.pendingCommand = null;
      postCreateTicketReply(tab, 'Create failed: ' + ((wr && wr.error) || 'unknown'));
      return;
    }
    s.pendingCommand = null;
    await pollTasksOnce(tab, true);
    postCreateTicketReply(tab, `Created ${id} — ${parsed.title} (todo).`);
    // TASK-079 Part A: the Slack-created ticket is a plain `todo`, so auto-start a
    // build run (no-op if one is already active — the same single-run guard).
    autoQueueBuildOnCreate(tab);
  } catch (err) {
    s.pendingCommand = null;
    postCreateTicketReply(tab, 'Create failed: ' + ((err && err.message) || String(err)));
  }
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

// Request an LLM summary of already-cleaned+redacted auto-post text from the
// main process (TASK-073). ALWAYS resolves to a string and NEVER throws into
// the flush path: when the toggle is off, no key is configured, the window is
// too short, or the call fails/times out, it returns the INPUT text unchanged
// so the caller's final redactSecrets() reproduces exactly TASK-071's output.
// The `text` passed in MUST already be redacted (it is, in both callers) — the
// external summarizer must never receive un-redacted secrets.
async function slackSummarizeOutput(tab, text) {
  const s = tab.slack;
  if (!s || !s.summarize || !text) return text;
  try {
    const res = await window.api.slack.summarize(text, true);
    if (res && res.ok && typeof res.text === 'string' && res.text) return res.text;
  } catch (_) { /* fall through to the unchanged input */ }
  return text;
}

// Called when the cmd pane goes idle ("finished"). If a Slack prompt was in
// flight, post Claude's captured reply back to the channel, then dispatch the
// next queued Slack message (if any). Async because it may await an LLM summary
// (TASK-073); the buffer + in-flight flags are cleared SYNCHRONOUSLY before any
// await so a finished run can never be double-posted or leave dispatch stuck.
async function slackOnFinished(tab) {
  const s = tab.slack;
  // No-op unless the proxy is active. Always clear the in-flight flag so a run
  // that finished can never leave dispatch permanently stuck.
  if (!s || !slackProxyEnabled(s)) { if (s) s.awaitingResponse = false; return; }

  // Flush whatever Claude output accumulated into the single anchor thread,
  // regardless of what triggered the run (Slack reply or direct typing). Clean
  // chrome, then run the readability pass (TASK-071), then redact secrets so the
  // text is fully redacted BEFORE it can reach the external summarizer (TASK-073
  // redact-before-send). Shared with slackFlushTick so NO auto-post path ever
  // posts, or sends to the summarizer, un-redacted output.
  const inner = redactSecrets(humanizeSlackOutput(cleanTerminalOutput(s.captureBuffer)));
  s.captureBuffer = '';
  s.awaitingResponse = false;
  s.replyThreadTs = null;
  if (inner) {
    // TASK-073 pipeline: redact → summarize → redact (redaction stays LAST).
    // slackSummarizeOutput returns `inner` unchanged when summarization is
    // disabled/unavailable/errors, so the fallback is exactly TASK-071 output.
    const summarized = await slackSummarizeOutput(tab, inner);
    const reply = redactSecrets(summarized);
    if (reply) {
      appendSlackMessage(tab, { who: 'claude', text: reply });
      if (s.postReplies) {
        await postToSlack(tab, reply, s.threadTs);
      }
    }
  }
  // Give the TUI a beat to settle, then dispatch the next queued Slack message
  // (covers messages that arrived while Claude was still busy).
  if (s.inbox.length) {
    setTimeout(() => slackTryDispatch(tab), QUEUE_SEND_DELAY_MS);
  }
}

// Periodic flush during a long busy run (TASK-061). onCmdData keeps appending to
// s.captureBuffer while the proxy is enabled; without this the anchor thread stays
// silent for minutes until slackOnFinished posts at idle. Each tick consumes the
// buffer so the interval flush and the finish flush together post every byte of
// output exactly once — no overlap, no duplicate posts.
async function slackFlushTick(tab) {
  const s = tab.slack;
  if (!s) return;
  // Build the decision state and defer to the mirrored pure helper.
  const state = {
    connected: s.connected,
    threadTs: s.threadTs,
    postReplies: s.postReplies,
    captureBuffer: s.captureBuffer,
    busy: tab.status === 'busy',
  };
  if (!slackShouldFlushCapture(state)) return; // no-op when disabled/idle/empty/unchecked

  // CLEAR the buffer BEFORE the await so any output that arrives during the post
  // lands in the next window — never lost, never double-sent. Clean chrome, then
  // run the readability pass (TASK-071), then redact secrets so the text is
  // fully redacted BEFORE it can reach the external summarizer (TASK-073
  // redact-before-send). Shared with slackOnFinished so NO auto-post path ever
  // posts, or sends to the summarizer, un-redacted output.
  const inner = redactSecrets(humanizeSlackOutput(cleanTerminalOutput(s.captureBuffer)));
  s.captureBuffer = '';
  // Pure TUI redraw noise cleans to '' → skip the post, buffer stays consumed.
  if (!inner) return;
  // TASK-073 pipeline: redact → summarize → redact (redaction stays LAST). On
  // disabled/unavailable/error slackSummarizeOutput returns `inner` unchanged,
  // so this falls back to exactly TASK-071's cleaned+redacted output. The call
  // is time-bounded in main so it can never stall the periodic flush.
  const summarized = await slackSummarizeOutput(tab, inner);
  const text = redactSecrets(summarized);
  if (!text) return;
  appendSlackMessage(tab, { who: 'claude', text });
  // A failure here is surfaced by postToSlack's own error path; this text is not
  // retried (the buffer is already consumed) and the interval keeps running.
  await postToSlack(tab, text, s.threadTs);
}

// Start the periodic flush timer. Clear any prior one first so rapid
// connect/disconnect/reconnect leaves exactly one timer alive (mirrors the
// pollTimer clear-before-set guard in startSlackPolling).
function startSlackFlushTimer(tab) {
  const s = tab.slack;
  if (s.flushTimer) clearInterval(s.flushTimer);
  s.flushTimer = setInterval(() => slackFlushTick(tab), SLACK_FLUSH_INTERVAL_MS);
}

// Stop the periodic flush timer (timer nulled; no leak — mirrors stopSlackPolling).
function stopSlackFlushTimer(tab) {
  const s = tab.slack;
  if (s.flushTimer) { clearInterval(s.flushTimer); s.flushTimer = null; }
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

// Platform-truthful empty-state copy (TASK-133). On win32 the static HTML copy
// (naming cmd.exe / Git Bash) is left byte-identical; off win32 both panes are the
// user's login shell, so the intro sentence is rewritten via textContent. A stale
// preload → isWin() true → Windows copy shown.
if (!isWin()) {
  const emptyMsgP = dom.emptyState && dom.emptyState.querySelector('.empty-msg p');
  if (emptyMsgP) {
    emptyMsgP.textContent = 'Pick a folder to open your login shell with claude and a second terminal side-by-side. Use + Folder… to open more folders in their own tabs.';
  }
}

// Focus changes flip the OS-flash verdict (flash only while unfocused), so
// re-report on both edges to re-evaluate immediately: blur can start a flash if an
// attention condition already holds; focus clears it (TASK-078).
window.addEventListener('focus', reportWindowAttention);
window.addEventListener('blur', reportWindowAttention);

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
    // A pty exiting can end a waiting/finished condition — re-report so the OS
    // attention flash clears if this was the last one (TASK-078).
    reportWindowAttention();
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

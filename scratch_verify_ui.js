'use strict';
const { _electron: electron } = require('playwright');
const path = require('path');

(async () => {
  const app = await electron.launch({
    args: [path.join(__dirname)],
    cwd: __dirname,
  });
  await app.firstWindow();
  await new Promise((r) => setTimeout(r, 1500));
  let win = null;
  for (const w of app.windows()) {
    const url = w.url();
    console.log('window url:', url);
    if (!/^devtools:/.test(url)) win = w;
  }
  if (!win) throw new Error('main app window not found among: ' + app.windows().map((w) => w.url()).join(', '));
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(1000);

  const diag = await win.evaluate(() => ({
    href: location.href,
    readyState: document.readyState,
    hasCreateTab: typeof window.createTab,
    hasApi: typeof window.api,
  }));
  console.log('DIAG:', JSON.stringify(diag));

  // Bypass the native folder-picker dialog: open this project's own folder
  // directly via the renderer's internal tab helpers (classic script -> window.*).
  const folder = __dirname;
  const result = await win.evaluate(async (folderPath) => {
    document.querySelector('.emptyState')?.classList.add('hidden');
    const tab = createTab();
    activateTab(tab.id);
    await openFolderInTab(tab, folderPath);
    return { tabId: tab.id, folder: tab.folder };
  }, folder);
  console.log('Opened folder in tab:', JSON.stringify(result));

  await win.waitForTimeout(500);

  // Switch to the Team tab.
  await win.evaluate(() => {
    const btn = document.querySelector('[data-tab="team"]');
    if (btn) btn.click();
  });
  await win.waitForTimeout(1500);

  // Let refreshTeamBoard / refreshTeamWorkflow settle (they're async fs reads).
  await win.waitForTimeout(1500);

  const report = await win.evaluate(() => {
    const boardBody = document.querySelector('.teamBoardBody');
    const workflowBody = document.querySelector('.teamWorkflowBody');
    const phaseSelects = boardBody ? boardBody.querySelectorAll('.team-column-phase-select').length : -1;
    const enabledCheckboxes = workflowBody ? workflowBody.querySelectorAll('.team-workflow-enabled-checkbox').length : -1;
    const orderControls = workflowBody ? workflowBody.querySelectorAll('.team-workflow-order-controls').length : -1;
    const regenBoxes = workflowBody ? workflowBody.querySelectorAll('.team-workflow-regen').length : -1;
    const saveSection = workflowBody ? !!workflowBody.querySelector('.team-workflow-phase-save') : false;
    const boardText = boardBody ? boardBody.textContent.slice(0, 400) : '(no board body)';
    const workflowText = workflowBody ? workflowBody.textContent.slice(0, 400) : '(no workflow body)';
    return { phaseSelects, enabledCheckboxes, orderControls, regenBoxes, saveSection, boardText, workflowText };
  });
  console.log('REPORT:', JSON.stringify(report, null, 2));

  // Screenshot the Team tab view.
  await win.screenshot({ path: path.join(__dirname, 'scratch_team_tab.png'), fullPage: true });
  console.log('Screenshot saved.');

  await app.close();
})().catch((err) => {
  console.error('VERIFY FAILED:', err);
  process.exit(1);
});

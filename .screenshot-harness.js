// TEMPORARY screenshot harness (delete after use). Boots the REAL main.js in
// this same Electron process — no source changes — waits for the renderer to
// settle, then writes a PNG of the actual window via Electron's capturePage().
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = process.env.SHOT_OUT || path.join(__dirname, 'shot.png');
const WAIT_MS = Number(process.env.SHOT_WAIT_MS || 22000);

require('./main.js');

app.whenReady().then(() => {
  // Open a real workspace tab on this project folder, the way a user would, so
  // the cmd pane (and therefore the usage bar) actually exists to photograph.
  setTimeout(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    try {
      const r = await win.webContents.executeJavaScript(
        `(async () => { const t = createTab(); await openFolderInTab(t, ${JSON.stringify(__dirname)}); return document.querySelectorAll('.ws-tab').length; })()`
      );
      console.log('[shot] opened folder; tabs =', r);
    } catch (e) {
      console.error('[shot] open folder failed:', e.message);
    }
  }, 3000);

  setTimeout(async () => {
    const wins = BrowserWindow.getAllWindows();
    if (!wins.length) { console.error('[shot] no window'); app.exit(1); return; }
    const win = wins[0];
    try {
      // Report what the renderer actually rendered, so a blank frame is obvious.
      const probe = await win.webContents.executeJavaScript(`(() => {
        const bars = Array.from(document.querySelectorAll('.usageBar'));
        const tabs = document.querySelectorAll('.ws-tab').length;
        return JSON.stringify({
          tabs,
          bars: bars.length,
          visible: bars.filter(b => !b.classList.contains('hidden')).length,
          detail: bars.map(b => ({
            hidden: b.classList.contains('hidden'),
            cls: b.className,
            label: b.querySelector('.usageBarLabel') && b.querySelector('.usageBarLabel').textContent,
            fill: b.querySelector('.usageBarFill') && b.querySelector('.usageBarFill').style.width,
            pace: b.querySelector('.usageBarPace') && b.querySelector('.usageBarPace').style.left,
            title: b.title
          }))
        });
      })()`);
      console.log('[shot] renderer state:', probe);
    } catch (e) {
      console.error('[shot] probe failed:', e.message);
    }
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(OUT, img.toPNG());
      console.log('[shot] wrote', OUT, img.getSize());
    } catch (e) {
      console.error('[shot] capture failed:', e.message);
    }
    app.exit(0);
  }, WAIT_MS);
});

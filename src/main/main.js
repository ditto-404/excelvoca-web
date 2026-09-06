const { app, BrowserWindow } = require('electron');
const path = require('path');
const { registerIpcHandlers, flushGithub } = require('./ipc');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 860,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', '..', 'index.html'));
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Saves are buffered and pushed to GitHub on a timer (see ipc.js), so quitting
// mid-buffer would leave the last answers unsynced until the next launch. Hold
// the quit just long enough for one final commit.
let flushedOnQuit = false;
app.on('before-quit', (event) => {
  if (flushedOnQuit) return;
  event.preventDefault();
  flushedOnQuit = true;
  flushGithub().finally(() => app.quit());
});

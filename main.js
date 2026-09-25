// Pixel Companion — Electron shell.
//
// Wraps the existing local server (companion-server.js — same one used from
// the terminal) and the app UI into a real desktop app: a window, a tray
// icon with show/hide + always-on-top, and no need to run `node
// companion-server.js` yourself or remember a localhost URL.

const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const path = require('path');

// Starting this (rather than spawning it as a subprocess) runs its HTTP
// server in this same process — same code path as running it from a
// terminal, just embedded.
const { PORT } = require('./companion-server.js');

let win = null;
let tray = null;
let alwaysOnTop = false;

function createWindow(){
  win = new BrowserWindow({
    // Sized for the whole square scene at a crisp 1.5x (see .app in the page)
    // plus the status line and chat beneath it.
    width: 800,
    height: 1020,
    minWidth: 520,
    minHeight: 700,
    title: 'Pixel Companion',
    alwaysOnTop,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 127.0.0.1 rather than localhost: the server listens on IPv4 loopback only,
  // and naming it avoids any dependence on how `localhost` resolves.
  win.loadURL(`http://127.0.0.1:${PORT}/`);

  // Keep the app alive in the tray instead of quitting when the window closes.
  win.on('close', (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function toggleWindow(){
  if (!win) return;
  if (win.isVisible()) win.hide();
  else { win.show(); win.focus(); }
}

function buildTrayMenu(){
  return Menu.buildFromTemplate([
    { label: 'Show / Hide', click: toggleWindow },
    {
      label: 'Always on Top',
      type: 'checkbox',
      checked: alwaysOnTop,
      click: (item) => {
        alwaysOnTop = item.checked;
        if (win) win.setAlwaysOnTop(alwaysOnTop);
      },
    },
    {
      label: 'Launch at Login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => { app.isQuiting = true; app.quit(); },
    },
  ]);
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock.hide(); // menu-bar/tray companion, not a dock app

  createWindow();

  const icon = nativeImage.createFromPath(path.join(__dirname, 'tray-icon.png'));
  tray = new Tray(icon);
  tray.setToolTip('Pixel Companion');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', toggleWindow);
});

// Any real quit — Cmd+Q, logout, restart, shutdown — goes through
// before-quit first. Without this, the close handler above treats it like the
// red close button, hides the window and cancels the quit, so the app would
// block a Mac from restarting. Only a plain window close should just hide.
app.on('before-quit', () => { app.isQuiting = true; });

app.on('window-all-closed', () => {
  // Stay running in the tray on all platforms — quitting is explicit (tray menu).
});

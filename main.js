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
    width: 620,
    height: 800,
    minWidth: 420,
    minHeight: 600,
    title: 'Pixel Companion',
    alwaysOnTop,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(`http://localhost:${PORT}/`);

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

app.on('window-all-closed', () => {
  // Stay running in the tray on all platforms — quitting is explicit (tray menu).
});

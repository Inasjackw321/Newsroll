// Newsroll desktop app: runs the news server inside the app and shows it in
// a native window, so there's nothing to start from a terminal.
const { app, BrowserWindow, Menu, shell, nativeTheme } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PREFERRED_PORT = 47821; // fixed so saved settings (topic, last visit) persist between launches
const isMac = process.platform === 'darwin';

let win = null;
let ollamaProcess = null;
let baseUrl = null;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

// Apps launched from the dock/Start menu don't inherit the shell PATH, so add
// the usual places Ollama gets installed.
function withCommonPaths() {
  const extra = isMac
    ? ['/opt/homebrew/bin', '/usr/local/bin', '/Applications/Ollama.app/Contents/Resources']
    : process.platform === 'win32'
      ? [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama')]
      : ['/usr/local/bin', '/usr/bin'];
  return [process.env.PATH, ...extra].filter(Boolean).join(path.delimiter);
}

// Start Ollama in the background if it's installed but not running.
async function ensureOllama() {
  const host = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
  try {
    await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(1500) });
    return; // already running
  } catch {
    /* not running — try to start it */
  }
  try {
    ollamaProcess = spawn('ollama', ['serve'], { stdio: 'ignore', env: { ...process.env, PATH: withCommonPaths() }, windowsHide: true });
    ollamaProcess.on('error', () => (ollamaProcess = null)); // not installed; the app explains how in the Ask panel
  } catch {
    ollamaProcess = null;
  }
}

// ---------- Window size memory ----------
const stateFile = () => path.join(app.getPath('userData'), 'window.json');
function loadBounds() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return { width: 560, height: 900 };
  }
}
function saveBounds() {
  if (!win || win.isMinimized() || win.isFullScreen()) return;
  try {
    fs.writeFileSync(stateFile(), JSON.stringify(win.getBounds()));
  } catch {
    /* not important */
  }
}

function createWindow() {
  win = new BrowserWindow({
    ...loadBounds(),
    minWidth: 380,
    minHeight: 560,
    title: 'Newsroll',
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#000000' : '#ffffff',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'public', 'icon-512.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadURL(baseUrl);
  win.once('ready-to-show', () => win.show());
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.on('closed', () => (win = null));

  // Story links open in the normal web browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(baseUrl)) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
}

function buildMenu() {
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Refresh News', accelerator: 'CmdOrCtrl+R', click: () => win?.webContents.executeJavaScript("document.getElementById('refreshBtn').click()") },
        { label: 'Ask a Question', accelerator: 'CmdOrCtrl+K', click: () => win?.webContents.executeJavaScript("document.getElementById('askInput').focus()") },
        { type: 'separator' },
        { label: 'News Sources…', accelerator: 'CmdOrCtrl+,', click: () => win?.webContents.executeJavaScript("window.newsroll?.openSettings('sources')") },
        { label: 'AI Model…', click: () => win?.webContents.executeJavaScript("window.newsroll?.openSettings('ai')") },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'reload', accelerator: 'Shift+CmdOrCtrl+R' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Get Ollama (for AI features)', click: () => shell.openExternal('https://ollama.com/download') }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  process.env.NEWSROLL_DATA = app.getPath('userData');
  await ensureOllama();

  const { start } = require('../server');
  const port = await start(PREFERRED_PORT);
  baseUrl = `http://127.0.0.1:${port}/`;

  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});

app.on('before-quit', () => {
  // Only stop Ollama if Newsroll started it.
  if (ollamaProcess) ollamaProcess.kill();
});

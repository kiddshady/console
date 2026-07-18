const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, globalShortcut } = require('electron');

// Kill the intermittent white flash on minimize→restore (Win11). When a window is
// minimised Windows marks it occluded; Chromium then backgrounds it and frees its GPU
// compositor surface. On restore the swap chain repaints blank for a frame → white flash.
// These app-level switches stop the occluded-window backgrounding so the surface survives
// and the last frame is already there on restore. Must run before app.whenReady().
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

const path = require('path');
const os = require('os');
const fs = require('fs');

let mainWindow;
let tray = null;
let isQuitting = false;

// --- Single instance lock ---
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1113,
    height: 626,
    minWidth: 900,
    minHeight: 600,
    resizable: false,
    maximizable: false,
    backgroundColor: '#050507',
    titleBarStyle: 'hidden',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Forward renderer console logs to main process terminal
  mainWindow.webContents.on('console-message', (e, ...args) => {
    // Electron 33+ may pass (event, details) or (event, level, message, line, sourceId)
    let level, message;
    if (args.length === 1 && typeof args[0] === 'object') {
      level = args[0].level;
      message = args[0].message;
    } else {
      level = args[0];
      message = args[1];
    }
    const tag = level === 2 ? '❌' : level === 1 ? '⚠️' : 'ℹ️';
    console.log(`${tag} [RENDERER] ${message}`);
  });

  // Log load failures
  mainWindow.webContents.on('did-fail-load', (e, code, desc, url) => {
    console.error(`❌ [RENDERER] Failed to load: ${url} — ${code} ${desc}`);
  });

  // Log preload errors
  mainWindow.webContents.on('preload-error', (e, preloadPath, error) => {
    console.error(`❌ [PRELOAD] ${preloadPath}: ${error.message}`);
  });

  // Aviso al renderer cuando la ventana gana foco a nivel SO. El evento del
  // BrowserWindow capta TODOS los alt-tab / click en taskbar / restore desde tray,
  // que el 'focus' del window DOM a veces se pierde en Windows (frameless + DWM).
  // El renderer usa esto para enfocar la terminal del tab activo.
  mainWindow.on('focus', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:focus');
    }
  });

  // Intercept close → hide to tray instead of quitting
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      return false;
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// --- Tray icon ---
function createTray() {
  const iconPath = path.join(__dirname, 'console-tray.ico');
  const trayIcon = nativeImage.createFromPath(iconPath);
  tray = new Tray(trayIcon);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Console', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
  ]);

  tray.setToolTip('Console — Terminal');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
}

// --- Global hotkey: Ctrl+Alt+C → toggle show/hide ---
function registerHotkeys() {
  const ret = globalShortcut.register('CommandOrControl+Alt+C', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible() && mainWindow.isFocused()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  if (!ret) console.error('[CONSOLE] Failed to register global hotkey Ctrl+Alt+C');
}

// --- IPC: window controls ---
ipcMain.on('window:minimize', () => {
  if (mainWindow) mainWindow.minimize();
});
// Maximize disabled — window stays at fixed dimensions
ipcMain.on('window:close', () => {
  if (mainWindow) mainWindow.close();
});

// --- IPC: terminal PTY ---
const ptyProcesses = new Map();
let ptyIdCounter = 0;

// El osc7-init.ps1 viaja embebido en app.asar, y pwsh (proceso externo) NO puede
// leer adentro del asar. Node sí: copiamos el contenido a una ruta REAL (userData)
// y devolvemos esa ruta para dot-sourcear desde ahí. Cache por proceso; null si
// falla (el terminal arranca igual, sin OSC 7). Escapamos comillas simples para PS.
let osc7ScriptPath;
function getOsc7ScriptPath() {
  if (osc7ScriptPath !== undefined) return osc7ScriptPath;
  try {
    const src = path.join(__dirname, 'shell', 'osc7-init.ps1'); // legible vía fs asar-aware
    const content = fs.readFileSync(src, 'utf8');
    const dest = path.join(app.getPath('userData'), 'osc7-init.ps1'); // FS real
    fs.writeFileSync(dest, content, 'utf8');
    osc7ScriptPath = dest;
  } catch (err) {
    console.error('[CONSOLE] OSC7 script setup failed:', err.message);
    osc7ScriptPath = null;
  }
  return osc7ScriptPath;
}
const psQuote = (p) => p.replace(/'/g, "''"); // comilla simple PS = duplicarla

// Directorio de arranque de toda shell nueva. En Windows, la raíz del disco; fuera de
// Windows 'C:\' no existe, así que caemos al home. Espejo de umbrovex.defaultCwd.
const DEFAULT_CWD = process.platform === 'win32' ? 'C:\\' : os.homedir();

ipcMain.handle('pty:create', (event, opts) => {
  let pty;
  try {
    pty = require('node-pty');
    console.log('[CONSOLE] node-pty loaded OK');
  } catch (err) {
    console.error('[CONSOLE] node-pty FAILED to load:', err.message);
    throw new Error(`node-pty not available: ${err.message}`);
  }
  const isWin = process.platform === 'win32';
  const shell = opts.shell || (isWin ? 'pwsh.exe' : 'bash');
  // On Windows: cargamos el core-profile del usuario y LUEGO el init de Console que
  // agrega OSC 7 (reporte de cwd) envolviendo el prompt. El core-profile queda
  // intacto; la lógica OSC 7 vive en el repo (src/shell/osc7-init.ps1) y se copia
  // a userData porque pwsh no puede leerla desde dentro de app.asar.
  let shellArgs = [];
  if (isWin) {
    const userProfile = 'C:\\PowerShell\\core-profile.ps1';
    const umbrovexInit = getOsc7ScriptPath();
    const bootstrap = umbrovexInit
      ? `. '${psQuote(userProfile)}'; . '${psQuote(umbrovexInit)}'`
      : `. '${psQuote(userProfile)}'`;
    shellArgs = ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', bootstrap];
  }
  const id = ++ptyIdCounter;
  const ptyProc = pty.spawn(shell, shellArgs, {
    name: 'xterm-color',
    cols: opts.cols || 80,
    rows: opts.rows || 24,
    cwd: opts.cwd || DEFAULT_CWD,
    env: process.env
  });

  ptyProcesses.set(id, ptyProc);

  ptyProc.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:data', { id, data });
    }
  });

  ptyProc.onExit(({ exitCode }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:exit', { id, exitCode });
    }
    ptyProcesses.delete(id);
  });

  return id;
});

ipcMain.handle('pty:write', (event, { id, data }) => {
  const proc = ptyProcesses.get(id);
  if (proc) proc.write(data);
});

ipcMain.handle('pty:resize', (event, { id, cols, rows }) => {
  const proc = ptyProcesses.get(id);
  if (proc) proc.resize(cols, rows);
});

ipcMain.handle('pty:kill', (event, { id }) => {
  const proc = ptyProcesses.get(id);
  if (proc) {
    proc.kill();
    ptyProcesses.delete(id);
  }
});

// --- IPC: auto-update (electron-updater) ---
// electron-updater sólo funciona en la app EMPAQUETADA (lee app-update.yml + el
// latest.yml del release de GitHub). En dev (npm start) no hay nada de eso: el check
// dispara una SIMULACIÓN del flujo completo, emitiendo los mismos 'update:status' que
// el path real, para poder ver/QA el toast sin publicar un release.
let _autoUpdater;            // instancia cacheada (lazy require; puede quedar null)
let _updaterWired = false;   // listeners registrados una sola vez
let updateManual = false;    // el check en curso lo pidió el usuario → feedback visible

function getAutoUpdater() {
  if (_autoUpdater !== undefined) return _autoUpdater;
  try {
    _autoUpdater = require('electron-updater').autoUpdater;
    _autoUpdater.autoDownload = false;          // primero avisamos; el usuario decide
    _autoUpdater.autoInstallOnAppQuit = true;
    _autoUpdater.logger = { info: console.log, warn: console.warn, error: console.error, debug: () => {} };
  } catch (err) {
    console.error('[CONSOLE] electron-updater no disponible:', err.message);
    _autoUpdater = null;
  }
  return _autoUpdater;
}

function sendUpdate(phase, extra) {
  sendToRenderer('update:status', { phase, manual: updateManual, ...(extra || {}) });
}

// Envío defensivo al renderer (la ventana puede estar oculta/destruida).
function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function wireAutoUpdater(up) {
  if (_updaterWired || !up) return;
  _updaterWired = true;
  up.on('checking-for-update', () => sendUpdate('checking'));
  up.on('update-available',     (info) => sendUpdate('available', { version: info && info.version }));
  up.on('update-not-available', () => sendUpdate('none'));
  up.on('download-progress',    (p) => sendUpdate('downloading', { percent: Math.round((p && p.percent) || 0) }));
  up.on('update-downloaded',    (info) => sendUpdate('downloaded', { version: info && info.version }));
  up.on('error',                (err) => sendUpdate('error', { error: (err && err.message) || String(err) }));
}

// Simulación en dev: mismos update:status que el path real, con timers.
let simTimers = [];
const SIM_VERSION = '0.2.0';
function clearSim() { simTimers.forEach(clearTimeout); simTimers = []; }
function simCheck() {
  clearSim();
  sendUpdate('checking');
  simTimers.push(setTimeout(() => sendUpdate('available', { version: SIM_VERSION }), 950));
}
function simDownload() {
  clearSim();
  let pct = 0;
  const tick = () => {
    pct += 4 + Math.floor(Math.random() * 15);
    if (pct >= 100) {
      sendUpdate('downloading', { percent: 100 });
      simTimers.push(setTimeout(() => sendUpdate('downloaded', { version: SIM_VERSION }), 450));
      return;
    }
    sendUpdate('downloading', { percent: pct });
    simTimers.push(setTimeout(tick, 240));
  };
  simTimers.push(setTimeout(tick, 200));
}

ipcMain.handle('update:check', (event, opts) => {
  updateManual = !!(opts && opts.manual);
  if (!app.isPackaged) { simCheck(); return { simulated: true }; }
  const up = getAutoUpdater();
  if (!up) { sendUpdate('error', { error: 'Updater unavailable.' }); return { ok: false }; }
  wireAutoUpdater(up);
  Promise.resolve(up.checkForUpdates()).catch((err) => sendUpdate('error', { error: err.message }));
  return { ok: true };
});

ipcMain.handle('update:download', () => {
  if (!app.isPackaged) { simDownload(); return { simulated: true }; }
  const up = getAutoUpdater();
  if (!up) return { ok: false };
  Promise.resolve(up.downloadUpdate()).catch((err) => sendUpdate('error', { error: err.message }));
  return { ok: true };
});

ipcMain.handle('update:install', () => {
  if (!app.isPackaged) { console.log('[CONSOLE] (dev sim) quitAndInstall'); sendUpdate('sim-install'); return { simulated: true }; }
  const up = getAutoUpdater();
  if (!up) return { ok: false };
  // CRÍTICO: sin isQuitting=true, el handler de 'close' esconde la ventana al tray y la
  // instalación nunca corre. Lo forzamos y salimos en el próximo tick.
  isQuitting = true;
  setImmediate(() => { try { up.quitAndInstall(); } catch (e) { console.error('[CONSOLE] quitAndInstall falló:', e.message); } });
  return { ok: true };
});

app.whenReady().then(() => {
  createWindow();
  createTray();
  registerHotkeys();
  // Chequeo automático al arrancar, sólo en la app empaquetada (en dev usá el comando
  // "Check for updates" de la paleta, que simula el flujo).
  if (app.isPackaged) {
    setTimeout(() => {
      updateManual = false;
      const up = getAutoUpdater();
      if (!up) return;
      wireAutoUpdater(up);
      Promise.resolve(up.checkForUpdates()).catch((err) => console.error('[CONSOLE] auto update-check falló:', err.message));
    }, 4000);
  }
});

app.on('window-all-closed', () => {
  // Don't quit — window is hidden to tray, PTYs keep running
});

app.on('before-quit', () => {
  globalShortcut.unregisterAll();
  isQuitting = true;
  ptyProcesses.forEach(p => { try { p.kill(); } catch {} });
  ptyProcesses.clear();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

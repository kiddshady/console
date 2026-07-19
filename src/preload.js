const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('umbrovex', {
  // Window controls
  minimize: () => ipcRenderer.send('window:minimize'),
  close: () => ipcRenderer.send('window:close'),
  // El main avisa cuando la ventana gana foco a nivel SO (alt-tab, taskbar, tray).
  onFocus: (callback) => ipcRenderer.on('window:focus', () => callback()),

  // PTY
  pty: {
    create: (opts) => ipcRenderer.invoke('pty:create', opts),
    write: (id, data) => ipcRenderer.invoke('pty:write', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.invoke('pty:resize', { id, cols, rows }),
    kill: (id) => ipcRenderer.invoke('pty:kill', { id }),
    onData: (callback) => ipcRenderer.on('pty:data', (e, { id, data }) => callback(id, data)),
    onExit: (callback) => ipcRenderer.on('pty:exit', (e, { id, exitCode }) => callback(id, exitCode)),
  },

  // Auto-update. check(manual): manual=true → feedback visible ("al día"/error).
  // onStatus recibe { phase, manual, version?, percent?, error? }.
  update: {
    check: (manual) => ipcRenderer.invoke('update:check', { manual: !!manual }),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    onStatus: (callback) => ipcRenderer.on('update:status', (e, payload) => callback(payload)),
  },

  // Platform info
  platform: process.platform,
  homeDir: process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\francisco',
  // Directorio donde arranca toda shell nueva. Tiene que coincidir con el DEFAULT_CWD
  // de main.js, que es el fallback si el renderer no manda cwd.
  defaultCwd: process.platform === 'win32' ? 'C:\\' : (process.env.HOME || '/'),
});

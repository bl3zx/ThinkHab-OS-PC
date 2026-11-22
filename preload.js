const { contextBridge, ipcRenderer } = require('electron');

// Мост между интерфейсом (app/index.html) и системой Windows
contextBridge.exposeInMainWorld('pc', {
  steamAccounts: () => ipcRenderer.invoke('steam:accounts'),
  steamResolve: (t) => ipcRenderer.invoke('steam:resolve', t),
  steamLink: (o) => ipcRenderer.invoke('steam:link', o),
  steamUnlink: () => ipcRenderer.invoke('steam:unlink'),
  steamSync: (force) => ipcRenderer.invoke('steam:sync', !!force),
  steamCheck: (id) => ipcRenderer.invoke('steam:check', id),
  steamLaunch: (id) => ipcRenderer.invoke('steam:launch', id),
  steamInstall: (id) => ipcRenderer.invoke('steam:install', id),
  deviceInfo: () => ipcRenderer.invoke('pc:info'),
  toggleRadio: (k) => ipcRenderer.invoke('pc:radio', k),
  exit: () => ipcRenderer.invoke('pc:exit'),
  onBrowserOpen: (cb) => ipcRenderer.on('brw:open', (_e, url) => cb(url))
});

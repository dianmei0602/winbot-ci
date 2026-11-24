// 更新：Electron 主进程通过 preload 暴露给界面（走 electron-updater，不再手搓 NSIS 调度）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('winbotUpdate', {
  check: () => ipcRenderer.invoke('update:check'),
  download: () => ipcRenderer.invoke('update:download'),
  install: () => ipcRenderer.invoke('update:install'),
  onProgress: (cb) => {
    const handler = (_e, info) => {
      try {
        cb(info);
      } catch {
        /* ignore */
      }
    };
    ipcRenderer.on('update:progress', handler);
    return () => ipcRenderer.removeListener('update:progress', handler);
  },
});

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vpnAPI', {
  connect: (serverId, config) => ipcRenderer.invoke('vpn:connect', serverId, config),
  disconnect: (serverId) => ipcRenderer.invoke('vpn:disconnect', serverId),
  getStatus: () => ipcRenderer.invoke('vpn:status'),
  checkWireGuard: () => ipcRenderer.invoke('vpn:check-wireguard'),
  minimize: () => ipcRenderer.invoke('app:minimize'),
  close: () => ipcRenderer.invoke('app:close'),
  getPlatform: () => ipcRenderer.invoke('app:platform')
});

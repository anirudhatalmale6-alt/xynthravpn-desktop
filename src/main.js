const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { exec, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

let mainWindow;
let tray;
let vpnProcess = null;
let isConnected = false;
let currentConfigPath = null;

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

function getWgQuickPath() {
  if (isWin) {
    const paths = [
      'C:\\Program Files\\WireGuard\\wireguard.exe',
      'C:\\Program Files (x86)\\WireGuard\\wireguard.exe'
    ];
    for (const p of paths) {
      if (fs.existsSync(p)) return p;
    }
    return 'wireguard';
  }
  if (isMac) {
    const paths = ['/usr/local/bin/wg-quick', '/opt/homebrew/bin/wg-quick', '/usr/bin/wg-quick'];
    for (const p of paths) {
      if (fs.existsSync(p)) return p;
    }
    return 'wg-quick';
  }
  return 'wg-quick';
}

function getConfigDir() {
  const dir = path.join(app.getPath('userData'), 'configs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeConfig(serverId, config) {
  const configDir = getConfigDir();
  const configPath = path.join(configDir, `${serverId}.conf`);
  fs.writeFileSync(configPath, config, { mode: 0o600 });
  return configPath;
}

function runElevated(command) {
  return new Promise((resolve, reject) => {
    if (isWin) {
      const psCommand = `Start-Process cmd -ArgumentList '/c ${command.replace(/'/g, "''")}' -Verb RunAs -Wait`;
      exec(`powershell -Command "${psCommand}"`, (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    } else {
      const sudo = require('sudo-prompt');
      sudo.exec(command, { name: 'XynthraVPN' }, (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    }
  });
}

async function connectVPN(serverId, config) {
  const configPath = writeConfig(serverId, config);
  currentConfigPath = configPath;

  try {
    if (isWin) {
      await runElevated(`"${getWgQuickPath()}" /installtunnelservice "${configPath}"`);
    } else {
      await runElevated(`${getWgQuickPath()} up "${configPath}"`);
    }
    isConnected = true;
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function disconnectVPN(serverId) {
  try {
    if (isWin) {
      const configPath = currentConfigPath || path.join(getConfigDir(), `${serverId}.conf`);
      await runElevated(`"${getWgQuickPath()}" /uninstalltunnelservice "${path.basename(configPath, '.conf')}"`);
    } else {
      const configPath = currentConfigPath || path.join(getConfigDir(), `${serverId}.conf`);
      await runElevated(`${getWgQuickPath()} down "${configPath}"`);
    }
    isConnected = false;
    currentConfigPath = null;
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function checkWireGuardInstalled() {
  try {
    if (isWin) {
      return fs.existsSync('C:\\Program Files\\WireGuard\\wireguard.exe') ||
             fs.existsSync('C:\\Program Files (x86)\\WireGuard\\wireguard.exe');
    }
    execSync('which wg-quick', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 700,
    minWidth: 380,
    minHeight: 600,
    maxWidth: 500,
    resizable: true,
    frame: false,
    transparent: false,
    backgroundColor: '#0a0b1e',
    titleBarStyle: 'hidden',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, '..', 'assets', 'icon.png')
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('close', (e) => {
    if (isConnected) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

app.whenReady().then(() => {
  createWindow();

  ipcMain.handle('vpn:connect', async (_, serverId, config) => {
    return await connectVPN(serverId, config);
  });

  ipcMain.handle('vpn:disconnect', async (_, serverId) => {
    return await disconnectVPN(serverId);
  });

  ipcMain.handle('vpn:status', () => {
    return { connected: isConnected };
  });

  ipcMain.handle('vpn:check-wireguard', () => {
    return { installed: checkWireGuardInstalled() };
  });

  ipcMain.handle('app:minimize', () => {
    mainWindow.minimize();
  });

  ipcMain.handle('app:close', () => {
    if (isConnected) {
      mainWindow.hide();
    } else {
      app.quit();
    }
  });

  ipcMain.handle('app:platform', () => {
    return process.platform;
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else {
    mainWindow.show();
  }
});

app.on('before-quit', async () => {
  if (isConnected && currentConfigPath) {
    try {
      if (isWin) {
        execSync(`"${getWgQuickPath()}" /uninstalltunnelservice "${path.basename(currentConfigPath, '.conf')}"`, { stdio: 'ignore' });
      } else {
        execSync(`sudo ${getWgQuickPath()} down "${currentConfigPath}"`, { stdio: 'ignore' });
      }
    } catch {}
  }
});

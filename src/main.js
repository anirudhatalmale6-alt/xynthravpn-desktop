const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const { exec, execSync, spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const http = require('http');

let mainWindow;
let isConnected = false;
let currentConfigPath = null;
let currentTunnelName = null;

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

function getWgPath() {
  if (isWin) {
    const paths = [
      'C:\\Program Files\\WireGuard\\wireguard.exe',
      'C:\\Program Files (x86)\\WireGuard\\wireguard.exe'
    ];
    for (const p of paths) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }
  const paths = ['/usr/local/bin/wg-quick', '/opt/homebrew/bin/wg-quick', '/usr/bin/wg-quick'];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  try {
    execSync('which wg-quick', { stdio: 'ignore' });
    return 'wg-quick';
  } catch {
    return null;
  }
}

function isWireGuardInstalled() {
  return getWgPath() !== null;
}

function getConfigDir() {
  const dir = path.join(app.getPath('userData'), 'configs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeConfig(serverId, config) {
  const configPath = path.join(getConfigDir(), `${serverId}.conf`);
  fs.writeFileSync(configPath, config, { mode: 0o600 });
  return configPath;
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        downloadFile(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function installWireGuardWindows() {
  const msiUrl = 'https://download.wireguard.com/windows-client/wireguard-installer.exe';
  const installerPath = path.join(app.getPath('temp'), 'wireguard-installer.exe');

  await downloadFile(msiUrl, installerPath);

  return new Promise((resolve, reject) => {
    const proc = spawn(installerPath, [], { stdio: 'ignore' });
    proc.on('close', (code) => {
      try { fs.unlinkSync(installerPath); } catch {}
      if (isWireGuardInstalled()) {
        resolve(true);
      } else {
        reject(new Error('WireGuard installation was cancelled or failed'));
      }
    });
    proc.on('error', reject);
  });
}

async function installWireGuardMac() {
  return new Promise((resolve, reject) => {
    const sudo = require('sudo-prompt');
    const brewCheck = 'which brew';
    exec(brewCheck, (err) => {
      if (err) {
        shell.openExternal('https://www.wireguard.com/install/');
        reject(new Error('Please install Homebrew first, then restart the app'));
        return;
      }
      sudo.exec('brew install wireguard-tools', { name: 'XynthraVPN Setup' }, (err2) => {
        if (err2) {
          shell.openExternal('https://www.wireguard.com/install/');
          reject(new Error('Auto-install failed. Please install WireGuard manually.'));
          return;
        }
        resolve(true);
      });
    });
  });
}

async function ensureWireGuard() {
  if (isWireGuardInstalled()) return { installed: true };

  try {
    if (isWin) {
      await installWireGuardWindows();
    } else if (isMac) {
      await installWireGuardMac();
    }
    return { installed: true };
  } catch (err) {
    return { installed: false, error: err.message };
  }
}

function runElevated(command) {
  return new Promise((resolve, reject) => {
    if (isWin) {
      exec(command, { timeout: 30000 }, (err, stdout, stderr) => {
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
  currentTunnelName = serverId;

  try {
    if (isWin) {
      const wgPath = getWgPath();
      if (!wgPath) throw new Error('WireGuard not found');
      const cmd = `"${wgPath}" /installtunnelservice "${configPath}"`;
      await runElevated(cmd);
    } else {
      const wgPath = getWgPath();
      if (!wgPath) throw new Error('wg-quick not found');
      await runElevated(`${wgPath} up "${configPath}"`);
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
      const wgPath = getWgPath();
      const tunnelName = currentTunnelName || serverId;
      await runElevated(`"${wgPath}" /uninstalltunnelservice "${tunnelName}"`);
    } else {
      const wgPath = getWgPath();
      const configPath = currentConfigPath || path.join(getConfigDir(), `${serverId}.conf`);
      await runElevated(`${wgPath} down "${configPath}"`);
    }
    isConnected = false;
    currentConfigPath = null;
    currentTunnelName = null;
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
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
    const wgStatus = await ensureWireGuard();
    if (!wgStatus.installed) {
      return { success: false, error: wgStatus.error || 'WireGuard setup required. Please follow the installer.' };
    }
    return await connectVPN(serverId, config);
  });

  ipcMain.handle('vpn:disconnect', async (_, serverId) => {
    return await disconnectVPN(serverId);
  });

  ipcMain.handle('vpn:status', () => {
    return { connected: isConnected };
  });

  ipcMain.handle('vpn:check-wireguard', () => {
    return { installed: isWireGuardInstalled() };
  });

  ipcMain.handle('vpn:setup-wireguard', async () => {
    return await ensureWireGuard();
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
        const wgPath = getWgPath();
        if (wgPath) execSync(`"${wgPath}" /uninstalltunnelservice "${currentTunnelName}"`, { stdio: 'ignore' });
      } else {
        const wgPath = getWgPath();
        if (wgPath) execSync(`sudo ${wgPath} down "${currentConfigPath}"`, { stdio: 'ignore' });
      }
    } catch {}
  }
});

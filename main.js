const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const https = require('https');
const fs = require('fs');
const { exec } = require('child_process');
const Store = require('electron-store');
const { getMachineFingerprint, validateLicenseKey } = require('./src/license');

// 在 Windows 下强制设置控制台为 UTF-8，避免输出中文时出现乱码
if (process.platform === 'win32') {
  try {
    const { execSync } = require('child_process');
    execSync('chcp 65001', { stdio: 'ignore' });
    if (process.stdout && typeof process.stdout.setDefaultEncoding === 'function') {
      process.stdout.setDefaultEncoding('utf8');
    }
  } catch (e) {
    // 忽略任何设置失败的错误
  }
}

// 修复磁盘缓存权限错误：指定用户数据目录并禁用 GPU 着色器缓存
try {
  const userDataPath = path.join(app.getPath('appData'), 'pick-helper');
  app.setPath('userData', userDataPath);
} catch (_) { }
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

// 数据存储
const store = new Store({
  defaults: {
    settings: {
      autoAccept: true,
      aramPick: true,
      heroPriority: [22, 48, 30, 21, 27, 17, 145, 42, 86, 36, 202], // 默认几个英雄
      // 预设分组（可存多个配置组），selectedPreset 保存当前正在使用的预设 id
      presets: [
        { id: 'default', name: '默认', heroPriority: [22, 48, 30, 21, 27, 17, 145, 42, 86, 36, 202] }
      ],
      selectedPreset: 'default',
      pollingInterval: 500
    },
    championData: {
      version: '',
      lastUpdate: '',
      champions: {}
    }
  }
});

const appVersion = app.getVersion();

let mainWindow = null;
let activationWindow = null;
let tray = null;
let lcuAuth = null;
let pollingTimer = null;
let gamePhase = '';
let isConnected = false;
let logs = [];
let isActivated = false;

// 日志函数：先对消息进行解码与清洗，确保输出可读
function sanitizeLogMessage(msg) {
  if (!msg && msg !== 0) return '';
  const stripControl = (s) => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

  try {
    // 字符串直接返回（去掉控制字符与 ANSI）
    if (typeof msg === 'string') {
      return stripControl(stripAnsi(msg));
    }

    // Node Buffer
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(msg)) {
      // 先尝试 UTF-8
      let utf8 = msg.toString('utf8');
      utf8 = stripAnsi(stripControl(utf8));

      // 若包含替代字符或大量乱码，尝试用 iconv-lite 按 GBK 解码（若可用）
      if (utf8.includes('�') || /[\uFFFD]/.test(utf8)) {
        try {
          const iconv = require('iconv-lite');
          if (iconv && iconv.decode) {
            const gbk = iconv.decode(msg, 'gbk');
            return stripAnsi(stripControl(gbk));
          }
        } catch (e) {
          // iconv-lite 未安装，忽略并返回 UTF-8 结果
        }
      }

      return utf8;
    }

    // Uint8Array / ArrayBuffer
    if (msg instanceof Uint8Array || msg instanceof ArrayBuffer) {
      const buf = msg instanceof ArrayBuffer ? new Uint8Array(msg) : msg;
      let decoded = '';
      try {
        decoded = new TextDecoder('utf-8').decode(buf);
        decoded = stripAnsi(stripControl(decoded));
      } catch (e) {
        decoded = String(msg);
      }

      if (decoded.includes('�')) {
        try {
          const iconv = require('iconv-lite');
          if (iconv && iconv.decode) {
            const nodeBuf = Buffer.from(buf);
            const gbk = iconv.decode(nodeBuf, 'gbk');
            return stripAnsi(stripControl(gbk));
          }
        } catch (e) { }
      }

      return decoded;
    }

    // 对象尝试 JSON 化
    if (typeof msg === 'object') {
      try {
        return JSON.stringify(msg);
      } catch (e) {
        return String(msg);
      }
    }

    return String(msg);
  } catch (e) {
    return String(msg);
  }
}

function addLog(message, type = 'info') {
  const safeMessage = sanitizeLogMessage(message);
  const log = {
    time: new Date().toLocaleString('zh-CN'),
    message: safeMessage,
    type
  };

  logs.unshift(log);
  if (logs.length > 100) logs.pop();

  if (mainWindow) {
    mainWindow.webContents.send('log:new', log);
  }
  console.log(`[${type}] ${safeMessage}`);
}

// ========== LCU API 相关 ==========

// 忽略自签名证书
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

function lcuRequest(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    if (!lcuAuth) {
      resolve(null);
      return;
    }

    const auth = Buffer.from(`riot:${lcuAuth.token}`).toString('base64');
    const options = {
      hostname: '127.0.0.1',
      port: lcuAuth.port,
      path: path,
      method: method,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      },
      rejectUnauthorized: false
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            if (method !== 'GET') {
              resolve(true);
            } else {
              resolve(data ? JSON.parse(data) : null);
            }
          } else {
            resolve(null);
          }
        } catch (e) {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// 延迟工具函数
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 通过 PowerShell 或 WMIC 获取进程命令行（兼容家庭版等无 WMIC 的系统）
function getProcessCommandLine(processName) {
  return new Promise((resolve) => {
    // 方法1：PowerShell Get-CimInstance（所有 Windows 版本都支持，包括家庭版）
    const psCmd = `Get-CimInstance Win32_Process -Filter "Name='${processName}'" | Select-Object -ExpandProperty CommandLine`;
    exec(psCmd, { shell: 'powershell.exe' }, (psError, psStdout) => {
      if (!psError && psStdout && psStdout.trim()) {
        resolve(psStdout.trim());
        return;
      }

      // 方法2：备选 PowerShell Get-WmiObject（旧版系统兼容）
      const wmiCmd = `Get-WmiObject Win32_Process -Filter "Name='${processName}'" | Select-Object -ExpandProperty CommandLine`;
      exec(wmiCmd, { shell: 'powershell.exe' }, (wmiError, wmiStdout) => {
        if (!wmiError && wmiStdout && wmiStdout.trim()) {
          resolve(wmiStdout.trim());
          return;
        }

        // 方法3：WMIC 兜底（专业版/企业版等）
        exec(`wmic process where "name='${processName}'" get CommandLine /format:list`, (wmicError, wmicStdout) => {
          if (!wmicError && wmicStdout) {
            resolve(wmicStdout.trim());
          } else {
            resolve(null);
          }
        });
      });
    });
  });
}

// 检测 LCU 客户端
function detectLCU() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      // 非 Windows 平台，返回模拟数据用于开发测试
      resolve(null);
      return;
    }
    // // 开发模式回退：允许通过环境变量手动指定 LCU 端口和 token（便于 dev 调试）
    // if (process.argv.includes('--dev')) {
    //   const envPort = process.env.LCU_PORT || process.env.LCUPORT || process.env.LCU_PORT;
    //   const envToken = process.env.LCU_TOKEN || process.env.LCUTOKEN || process.env.LCU_TOKEN;
    //   if (envPort && envToken) {
    //     resolve({ port: envPort, token: envToken });
    //     return;
    //   }
    // }
    getProcessCommandLine('LeagueClientUx.exe').then((cmdline) => {
      if (!cmdline) {
        resolve(null);
        return;
      }

      const portMatch = cmdline.match(/--app-port=(\d+)/);
      // 匹配 token：只捕获字母数字、短横线、下划线（排除末尾换行等干扰字符）
      const tokenMatch = cmdline.match(/--remoting-auth-token=([A-Za-z0-9\-_]+)/);

      if (portMatch && tokenMatch) {
        resolve({
          port: portMatch[1],
          token: tokenMatch[1]
        });
      } else {
        resolve(null);
      }
    }).catch(() => {
      resolve(null);
    });
  });
}

// ========== 英雄数据相关 ==========

async function fetchChampionData() {
  try {
    // 获取最新版本
    const versions = await new Promise((resolve, reject) => {
      https.get('https://ddragon.leagueoflegends.com/api/versions.json', (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(e); }
        });
      }).on('error', reject);
    });

    if (!versions || versions.length === 0) return false;

    const latestVersion = versions[0];
    const currentVersion = store.get('championData.version');

    // 版本相同且今天已更新，跳过
    const lastUpdate = store.get('championData.lastUpdate');
    const today = new Date().toDateString();
    if (currentVersion === latestVersion && lastUpdate === today) {
      addLog('英雄数据已是最新版本', 'info');
      return true;
    }

    // 获取英雄数据
    const url = `https://ddragon.leagueoflegends.com/cdn/${latestVersion}/data/zh_CN/champion.json`;
    const championData = await new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(e); }
        });
      }).on('error', reject);
    });

    // 转换为 ID -> 名称 的映射
    const champions = {};
    for (const key in championData.data) {
      const champ = championData.data[key];
      const id = parseInt(champ.key);
      champions[id] = {
        id,
        name: champ.name,
        title: champ.title,
        image: `https://ddragon.leagueoflegends.com/cdn/${latestVersion}/img/champion/${champ.image.full}`
      };
    }

    // 保存
    store.set('championData', {
      version: latestVersion,
      lastUpdate: today,
      champions
    });

    addLog(`英雄数据已更新至版本 ${latestVersion}`, 'success');
    return true;
  } catch (e) {
    addLog(`英雄数据更新失败: ${e.message}`, 'error');
    return false;
  }
}

// 每日检查更新
function checkDailyUpdate() {
  const lastUpdate = store.get('championData.lastUpdate');
  const today = new Date().toDateString();

  if (lastUpdate !== today) {
    addLog('开始检查英雄数据更新...', 'info');
    fetchChampionData();
  }
}

// ========== 主循环 ==========

let lastReadyState = '';
let inAramSelect = false;
let lastBenchStr = '';
let lastPickedId = 0;
let lastLocalChampionId = -999;
let lastTargetId = 0;
let lastSwapTargetId = 0;
let phaseCheckCounter = 0;
let lastPhase = '';

function resetSessionState() {
  lastReadyState = '';
  inAramSelect = false;
  lastBenchStr = '';
  lastPickedId = 0;
  lastLocalChampionId = -999;
  lastTargetId = 0;
  lastSwapTargetId = 0;
  phaseCheckCounter = 0;
  lastPhase = '';
}

async function mainLoop() {
  const settings = store.get('settings');

  // 检测客户端连接
  const auth = await detectLCU();

  if (!auth) {
    if (isConnected) {
      isConnected = false;
      gamePhase = '';
      resetSessionState();
      addLog('客户端已断开，等待重新连接...', 'warning');
      if (mainWindow) {
        mainWindow.webContents.send('status:update', { connected: false, phase: '' });
      }
    }
    return;
  }

  if (!isConnected || lcuAuth?.port !== auth.port) {
    lcuAuth = auth;
    isConnected = true;
    addLog(`客户端连接成功 - 端口: ${auth.port}`, 'success');
    // 连接后立即请求当前游戏阶段，避免 UI 显示为 '-'
    try {
      const phaseRes = await lcuRequest('/lol-gameflow/v1/gameflow-phase');
      console.log('game mode:', phaseRes);
      if (phaseRes) {
        gamePhase = phaseRes;
        lastPhase = phaseRes;
      }
    } catch (e) {
      // 忽略请求错误，保留现有 gamePhase
    }

    if (mainWindow) {
      mainWindow.webContents.send('status:update', { connected: true, phase: gamePhase });
    }
  }

  // 功能1：自动接受对局
  if (settings.autoAccept) {
    const readyRes = await lcuRequest('/lol-matchmaking/v1/ready-check');
    if (readyRes && readyRes.state === 'InProgress' && lastReadyState !== 'InProgress') {
      await lcuRequest('/lol-matchmaking/v1/ready-check/accept', 'POST');
      addLog('[匹配] 自动接受对局', 'success');
    }
    lastReadyState = readyRes?.state || '';
  }

  // 功能2：选角仪表盘更新 + 大乱斗自动选英雄
  // ★ 阶段检测：始终运行（不依赖 aramPick），确保持续推送仪表盘数据
  phaseCheckCounter++;
  if (phaseCheckCounter >= 5 || lastPhase === '') {
    const phaseRes = await lcuRequest('/lol-gameflow/v1/gameflow-phase');
    const currentPhase = phaseRes || '';
    phaseCheckCounter = 0;

    if (currentPhase !== lastPhase) {
      gamePhase = currentPhase;
      addLog(`[阶段] 当前游戏阶段: ${currentPhase}`, 'info');

      if (currentPhase === 'EndOfGame' || currentPhase === 'WaitingForStats') {
        const s = store.get('settings');
        s.aramPick = true; // 自动恢复 aramPick 开启状态
        if (mainWindow) {
          mainWindow.webContents.send('auto-pick:changed', true);
        }
        resetSessionState();
        addLog('[状态] 本局结束，已重置会话状态', 'info');
      }

      if (mainWindow) {
        mainWindow.webContents.send('status:update', { connected: true, phase: currentPhase });
      }

      lastPhase = currentPhase;
    }
  }

  // 不在选角阶段，跳过
  if (lastPhase !== 'ChampSelect') {
    if (inAramSelect) {
      inAramSelect = false;
      addLog('[选角] 已离开选角阶段', 'info');
      if (mainWindow) {
        mainWindow.webContents.send('pick:update', { inChampSelect: false });
      }
    }
    return;
  }

  // 获取选角会话（始终获取，用于仪表盘展示）
  const session = await lcuRequest('/lol-champ-select/v1/session');
  if (!session) return;

  // 判断是否是 ARAM
  let mode = session.gameMode;
  if (!mode && session.gameConfig) mode = session.gameConfig.gameMode;
  if (!mode && (session.benchEnabled || (session.benchChampions?.length > 0))) {
    mode = 'ARAM';
  }

  if (mode !== 'ARAM') {
    if (inAramSelect) {
      inAramSelect = false;
      addLog('[选角] 当前非大乱斗模式', 'info');
    }
    return;
  }

  if (!inAramSelect) {
    addLog('[选角] 检测到大乱斗选角阶段', 'success');
    inAramSelect = true;
    sendPickUpdate(true, session, settings);
  }

  // 提取备选池英雄
  const benchList = session.benchChampions || session.teamBenchChampions || [];
  const benchIds = benchList.map(c => c.championId);
  const benchStr = benchIds.join(',');

  if (benchStr !== lastBenchStr && benchStr) {
    addLog(`[选角] 备选池刷新: ${benchStr}`, 'info');
    lastBenchStr = benchStr;
    lastSwapTargetId = 0;
    sendPickUpdate(true, session, settings);
  }

  if (!benchIds.length) return;

  // 获取当前手持英雄
  const localCell = session.localPlayerCellId;
  let localChampionId = null;
  if (session.myTeam) {
    const localEntry = session.myTeam.find(e => e.cellId === localCell);
    if (localEntry) localChampionId = localEntry.championId;
  }

  if (localChampionId !== lastLocalChampionId) {
    const champData = store.get('championData.champions');
    const champName = champData[localChampionId]?.name || localChampionId;
    addLog(`[选角] 当前手持: ${champName}`, 'info');
    lastLocalChampionId = localChampionId;
    lastSwapTargetId = 0;
    sendPickUpdate(true, session, settings);
  }

  // ★ 自动交换逻辑：仅在 aramPick 开启时执行
  if (settings.aramPick && settings.heroPriority && settings.heroPriority.length > 0) {
    // 计算当前手持优先级
    const heroIdList = settings.heroPriority;
    let currentIndex = 999;
    if (localChampionId && heroIdList.includes(localChampionId)) {
      currentIndex = heroIdList.indexOf(localChampionId);
    }

    // 计算备选池最高优先级
    let targetId = null;
    let bestIndex = 999;
    for (let i = 0; i < heroIdList.length; i++) {
      if (benchIds.includes(heroIdList[i])) {
        targetId = heroIdList[i];
        bestIndex = i;
        break;
      }
    }

    if (!targetId) {
      if (lastPickedId !== -1) {
        addLog('[选角] 备选池无优先级内英雄，等待刷新', 'info');
        lastPickedId = -1;
        lastTargetId = 0;
      }
      return;
    }

    if (targetId !== lastTargetId) {
      const champData = store.get('championData.champions');
      const champName = champData[targetId]?.name || targetId;
      addLog(`[选角] 发现更高优先级: ${champName} (排名: ${bestIndex + 1})`, 'info');
      lastTargetId = targetId;
    }

    // 执行交换（带验证重试）
    if (bestIndex < currentIndex && lastSwapTargetId !== targetId) {
      const champData = store.get('championData.champions');
      const champName = champData[targetId]?.name || targetId;
      addLog(`[选角] 执行交换: ${champName}`, 'success');

      const maxRetries = 3;
      let swapSuccess = false;

      for (let retry = 0; retry < maxRetries; retry++) {
        const swapResult = await lcuRequest(
          `/lol-champ-select/v1/session/bench/swap/${targetId}`,
          'POST'
        );

        if (!swapResult) {
          addLog(`[选角] 交换请求失败 (第${retry + 1}次)`, 'error');
          if (retry < maxRetries - 1) {
            await sleep(300);
          }
          continue;
        }

        // 等待 LCU 处理交换
        await sleep(350);

        // 验证是否真的换到了目标英雄
        const verifySession = await lcuRequest('/lol-champ-select/v1/session');
        if (verifySession && verifySession.myTeam) {
          const vLocalCell = verifySession.localPlayerCellId;
          const vLocalEntry = verifySession.myTeam.find(e => e.cellId === vLocalCell);
          if (vLocalEntry && vLocalEntry.championId === targetId) {
            swapSuccess = true;
            addLog(`[选角] 交换成功: ${champName} (第${retry + 1}次尝试)`, 'success');
            // 更新缓存
            lastLocalChampionId = targetId;
            sendPickUpdate(true, verifySession, settings);
            break;
          } else {
            const heldName = vLocalEntry?.championId
              ? (champData[vLocalEntry.championId]?.name || vLocalEntry.championId)
              : '未知';
            addLog(`[选角] 交换未生效，当前手持: ${heldName} (第${retry + 1}次)`, 'warning');
          }
        }
      }

      if (!swapSuccess) {
        addLog(`[选角] 交换最终失败: ${champName}，已重试${maxRetries}次`, 'error');
      }

      lastSwapTargetId = targetId;
    }
  }
}

function startPolling() {
  if (pollingTimer) clearInterval(pollingTimer);
  const settings = store.get('settings');
  pollingTimer = setInterval(mainLoop, settings.pollingInterval || 1000);
  addLog('已启动主循环', 'info');
}

// ========== 选角仪表盘事件推送 ==========

function sendPickUpdate(inChampSelect, session, settings) {
  if (!mainWindow) return;

  const champData = store.get('championData.champions');
  const heroIdList = settings.heroPriority || [];
  const data = {
    inChampSelect,
    benchChampions: [],
    localChampion: null,
    progress: 0,
    lastAction: null
  };

  if (inChampSelect && session) {
    // 备选池
    const benchList = session.benchChampions || session.teamBenchChampions || [];
    data.benchChampions = benchList.map(c => ({
      id: c.championId,
      name: (champData[c.championId] && champData[c.championId].name) || ('ID:' + c.championId),
      image: (champData[c.championId] && champData[c.championId].image) || '',
      priorityIndex: heroIdList.includes(c.championId) ? heroIdList.indexOf(c.championId) : null
    }));

    // 当前手持
    const localCell = session.localPlayerCellId;
    let localChampionId = null;
    if (session.myTeam) {
      const localEntry = session.myTeam.find(e => e.cellId === localCell);
      if (localEntry) localChampionId = localEntry.championId;
    }
    if (localChampionId) {
      data.localChampion = {
        id: localChampionId,
        name: (champData[localChampionId] && champData[localChampionId].name) || ('ID:' + localChampionId),
        image: (champData[localChampionId] && champData[localChampionId].image) || '',
        priorityIndex: heroIdList.includes(localChampionId) ? heroIdList.indexOf(localChampionId) : null
      };
    }

    // 简易进度（根据选角阶段 actions 数量估算）
    const actions = session.actions || [];
    const totalActions = (actions.length || 0) + (benchList.length || 0);
    data.progress = Math.min(95, totalActions * 8);
  }

  mainWindow.webContents.send('pick:update', data);
}

// ========== 激活窗口 ==========

function createActivationWindow() {
  activationWindow = new BrowserWindow({
    width: 500,
    height: 620,
    minWidth: 500,
    minHeight: 620,
    resizable: false,
    frame: false,
    transparent: false,
    backgroundColor: '#1a1a2e',
    title: `PickHelper v${appVersion}`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    icon: path.join(__dirname, 'assets/icon.png')
  });

  activationWindow.loadFile(path.join(__dirname, 'src/activation.html'));
  activationWindow.setAlwaysOnTop(true);

  activationWindow.on('closed', () => {
    activationWindow = null;
  });
}

// ========== 窗口创建 ==========

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 820,
    height: 780,
    minWidth: 820,
    minHeight: 780,
    resizable: false,
    frame: false,
    transparent: false,
    backgroundColor: '#f0f2f5',
    title: `PickHelper v${appVersion}`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    icon: path.join(__dirname, 'assets/icon.png')
  });

  mainWindow.loadFile(path.join(__dirname, 'src/index.html'));

  // 开发模式打开开发者工具
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.on('minimize', (e) => {
    // 最小化到托盘
    e.preventDefault();
    mainWindow.hide();
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets/icon.png');
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(iconPath);
  } catch {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  const contextMenu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]);
  tray.setToolTip(`PickHelper v${appVersion} - LOL 辅助工具`);
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow?.show();
    }
  });
}

// ========== IPC 通信 ==========

ipcMain.handle('app:get-status', () => {
  return {
    connected: isConnected,
    phase: gamePhase,
    championVersion: store.get('championData.version'),
    lastUpdate: store.get('championData.lastUpdate')
  };
});

ipcMain.handle('app:get-app-version', () => {
  return appVersion;
});

ipcMain.handle('app:get-settings', () => {
  return store.get('settings');
});

ipcMain.handle('app:get-presets', () => {
  const s = store.get('settings');
  return { presets: s.presets || [], selectedPreset: s.selectedPreset || null };
});

ipcMain.handle('app:set-selected-preset', (_, id) => {
  const s = store.get('settings');
  s.selectedPreset = id;
  // 同步 heroPriority 到 settings.heroPriority
  const preset = (s.presets || []).find(p => p.id === id);
  if (preset && Array.isArray(preset.heroPriority)) {
    s.heroPriority = [...preset.heroPriority];
  }
  store.set('settings', s);
  addLog(`已切换预设: ${id}`, 'info');
  // 广播更新到渲染进程
  try {
    if (mainWindow) {
      mainWindow.webContents.send('presets:updated', { presets: s.presets || [], selectedPreset: s.selectedPreset });
    }
  } catch (e) { }
  return true;
});

ipcMain.handle('app:save-presets', (_, presets) => {
  const s = store.get('settings');
  s.presets = Array.isArray(presets) ? presets : s.presets;
  store.set('settings', s);
  addLog('预设已保存', 'success');
  try {
    if (mainWindow) {
      mainWindow.webContents.send('presets:updated', { presets: s.presets || [], selectedPreset: s.selectedPreset });
    }
  } catch (e) { }
  return true;
});

ipcMain.handle('app:save-settings', (_, settings) => {
  store.set('settings', settings);
  addLog('设置已保存', 'success');
  return true;
});

ipcMain.handle('app:get-champions', () => {
  return store.get('championData.champions');
});

ipcMain.handle('app:get-logs', () => {
  return logs;
});

// 接收渲染进程错误并记录
ipcMain.on('renderer:error', (_, info) => {
  const msg = `渲染器错误: ${info.message || ''} ${info.filename ? `at ${info.filename}:${info.lineno || 0}:${info.colno || 0}` : ''}`;
  const detail = info.stack || '';
  addLog(`${msg}\n${detail}`, 'error');
});

ipcMain.on('renderer:console', (_, args) => {
  try {
    addLog(`渲染器 console.error: ${args.join(' ')}`, 'error');
  } catch (e) {
    addLog(`渲染器 console.error: ${String(args)}`, 'error');
  }
});

ipcMain.handle('app:refresh-champions', async () => {
  addLog('手动刷新英雄数据...', 'info');
  const result = await fetchChampionData();
  return {
    success: result,
    version: store.get('championData.version'),
    lastUpdate: store.get('championData.lastUpdate')
  };
});

// 手动交换英雄：渲染进程点击备选池卡片触发
ipcMain.handle('app:manual-swap', async (_, heroId) => {
  if (!lcuAuth || !heroId) return { success: false, error: '未连接或参数无效' };

  // ★ 先保存关闭状态，防止 await 期间 mainLoop 再次触发自动交换
  const s = store.get('settings');
  s.aramPick = false;
  store.set('settings', s);
  addLog('[设置] 手动选择后已关闭自动选英雄', 'info');

  // 同步开关状态到渲染进程
  if (mainWindow) {
    mainWindow.webContents.send('auto-pick:changed', false);
  }

  // 再执行交换（此时自动选择已关闭，mainLoop 不会干扰），带验证重试
  const maxRetries = 3;
  let swapSuccess = false;

  for (let retry = 0; retry < maxRetries; retry++) {
    const swapResult = await lcuRequest(
      `/lol-champ-select/v1/session/bench/swap/${heroId}`,
      'POST'
    );

    if (!swapResult) {
      addLog(`[手动] 交换请求失败 (第${retry + 1}次)`, 'error');
      if (retry < maxRetries - 1) {
        await sleep(300);
      }
      continue;
    }

    // 等待 LCU 处理交换
    await sleep(350);

    // 验证是否真的换到了目标英雄
    const verifySession = await lcuRequest('/lol-champ-select/v1/session');
    if (verifySession && verifySession.myTeam) {
      const vLocalCell = verifySession.localPlayerCellId;
      const vLocalEntry = verifySession.myTeam.find(e => e.cellId === vLocalCell);
      if (vLocalEntry && vLocalEntry.championId === heroId) {
        swapSuccess = true;
        const champData = store.get('championData.champions');
        const champName = (champData[heroId] && champData[heroId].name) || heroId;
        addLog(`[手动] 交换成功: ${champName} (第${retry + 1}次尝试)`, 'success');

        // 强制重置手持 ID 缓存，确保 sendPickUpdate 会更新手持显示
        lastLocalChampionId = heroId;
        const s = store.get('settings');
        sendPickUpdate(true, verifySession, s);
        break;
      } else {
        const heldId = vLocalEntry?.championId;
        const champData = store.get('championData.champions');
        const heldName = heldId ? (champData[heldId]?.name || heldId) : '未知';
        addLog(`[手动] 交换未生效，当前手持: ${heldName} (第${retry + 1}次)`, 'warning');
      }
    }
  }

  if (!swapSuccess) {
    addLog(`[手动] 交换最终失败，已重试${maxRetries}次`, 'error');
    return { success: false, error: `交换失败，已重试${maxRetries}次` };
  }

  return { success: true };
});

// 设置自动选英雄开关
ipcMain.handle('app:set-auto-pick', (_, enabled) => {
  const s = store.get('settings');
  s.aramPick = !!enabled;
  store.set('settings', s);
  addLog(`[设置] 自动选英雄已${enabled ? '开启' : '关闭'}`, 'info');
  return true;
});

ipcMain.handle('window:minimize', () => {
  mainWindow?.minimize();
});

ipcMain.handle('window:close', () => {
  mainWindow?.close();
});

// ========== 许可证激活相关 IPC ==========

ipcMain.handle('app:get-machine-code', () => {
  return getMachineFingerprint();
});

ipcMain.handle('app:activate-license', (_, licenseKey) => {
  const result = validateLicenseKey(licenseKey);
  if (result.valid) {
    store.set('license', {
      key: licenseKey,
      machineCode: result.machineCode,
      activatedAt: new Date().toISOString(),
      expiry: result.expiry
    });
    isActivated = true;
    addLog('[许可证] 软件激活成功', 'success');
  }
  return result;
});

ipcMain.handle('app:activation-complete', () => {
  // 关闭激活窗口，显示主窗口
  if (activationWindow) {
    activationWindow.close();
    activationWindow = null;
  }
  // 启动主界面
  createWindow();
  createTray();
  startPolling();
  checkDailyUpdate();
});

// ========== 许可证检查 ==========

function checkLicense() {
  const license = store.get('license');
  if (!license || !license.key) {
    return false;
  }
  const result = validateLicenseKey(license.key);
  if (result.valid) {
    isActivated = true;
    return true;
  }
  return false;
}

// ========== 应用生命周期 ==========

app.whenReady().then(async () => {
  // 检查许可证
  if (!checkLicense()) {
    // 未激活，显示激活窗口
    createActivationWindow();
    return;
  }

  // 检查英雄数据更新
  await fetchChampionData();
  checkDailyUpdate();

  createWindow();
  createTray();
  startPolling();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 每日检查更新（每小时检查一次是否跨天）
setInterval(checkDailyUpdate, 60 * 60 * 1000);

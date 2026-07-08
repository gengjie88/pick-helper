/**
 * PickHelper - LOL 大乱斗自动选英雄辅助工具
 * 主进程入口，负责：LCU API 通信、轮询检测、自动交换、窗口管理、IPC 通信
 */
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const https = require('https');        // LCU API 和英雄数据请求（自签名证书）
const fs = require('fs');
const { exec } = require('child_process'); // 检测 LCU 进程命令行参数
const Store = require('electron-store');   // JSON 文件持久化配置
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

// ========== 持久化存储配置 ==========
// 所有配置保存在用户 AppData 目录下的 config.json
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

// ========== 应用全局状态变量 ==========

const appVersion = app.getVersion();

// --- Electron 窗口 ---
let mainWindow = null;         // BrowserWindow | null - 主窗口
let activationWindow = null;   // BrowserWindow | null - 激活/许可证窗口
let tray = null;               // Tray | null - 系统托盘

// --- LCU 客户端连接 ---
let lcuAuth = null;            // { port: string, token: string } | null - LCU API 认证信息
let pollingTimer = null;       // interval ID - 主循环定时器
let gamePhase = '';            // string - 当前游戏阶段（Lobby/ChampSelect/InProgress...）
let isConnected = false;       // boolean - LCU 客户端是否已连接

// --- 日志与许可 ---
let logs = [];                 // 日志数组，最多保留 100 条
let isActivated = false;       // boolean - 许可证是否已验证通过

/**
 * 清洗日志消息 - 移除控制字符和 ANSI 转义码，确保可读
 * 支持 String / Buffer / Uint8Array / ArrayBuffer / Object
 * @param {*} msg - 原始消息
 * @returns {string} 可读的纯文本
 */
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

/**
 * 添加一条日志，同时输出到控制台和推送至渲染进程
 * @param {string} message - 日志内容
 * @param {'info'|'success'|'warning'|'error'} [type='info'] - 日志级别
 */
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

// ========== LCU API 通信 ==========

// LCU 使用自签名证书，必须关闭 TLS 证书验证
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

/**
 * 向 LCU API 发送请求（本地回环，无需网络）
 * @param {string} path - API 路径，如 '/lol-gameflow/v1/gameflow-phase'
 * @param {string} [method='GET'] - HTTP 方法
 * @param {object} [body=null] - 请求体（仅 POST/PUT）
 * @returns {Promise<object|boolean|null>} 响应数据，失败返回 null
 */
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
              // POST/PUT 等也解析响应体，方便调用方检查 LCU 级错误
              if (data) {
                try {
                  const parsed = JSON.parse(data);
                  // LCU 有时返回 { errorCode, message } 但状态码仍为 2xx
                  if (parsed && parsed.errorCode) {
                    resolve(null);
                    return;
                  }
                  resolve(parsed);
                } catch (_) {
                  resolve(true);
                }
              } else {
                resolve(true);
              }
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

    // 超时保护：LCU 无响应时 5 秒后释放，防止 mainLoop 永久卡死
    req.setTimeout(5000, () => {
      req.destroy();
      resolve(null);
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

/**
 * Promise 版本的延迟函数
 * @param {number} ms - 毫秒
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 获取指定进程的命令行参数（用于提取 LCU 端口和 token）
 * 使用多种方式兜底，兼容不同 Windows 版本
 * @param {string} processName - 进程名，如 'LeagueClientUx.exe'
 * @returns {Promise<string|null>} 命令行字符串
 */
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

/**
 * 检测 LCU 客户端是否运行，提取 API 端口和认证 token
 * 通过读取 LeagueClientUx.exe 进程的命令行参数获取
 * @returns {Promise<{port:string, token:string}|null>}
 */
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

// ========== 英雄数据管理 ==========

/**
 * 从 DataDragon CDN 获取最新英雄数据（ID→名称/头像映射）
 * 每日自动缓存，版本未变且当天已更新则跳过
 * @returns {Promise<boolean>} 是否成功
 */
async function fetchChampionData() {
  try {
    // 获取最新版本（10 秒超时）
    const versions = await new Promise((resolve, reject) => {
      const req = https.get('https://ddragon.leagueoflegends.com/api/versions.json', (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('请求超时')); });
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

    // 获取英雄数据（10 秒超时）
    const url = `https://ddragon.leagueoflegends.com/cdn/${latestVersion}/data/zh_CN/champion.json`;
    const championData = await new Promise((resolve, reject) => {
      const req = https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('请求超时')); });
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

/**
 * 每日检查英雄数据是否需要更新（跨天时触发）
 * 通过 setInterval 每小时检查一次是否跨天
 */
function checkDailyUpdate() {
  const lastUpdate = store.get('championData.lastUpdate');
  const today = new Date().toDateString();

  if (lastUpdate !== today) {
    addLog('开始检查英雄数据更新...', 'info');
    fetchChampionData();
  }
}

// ========== 主循环状态变量 ==========
// 这些变量在每局游戏结束后通过 resetSessionState() 重置

let lastReadyState = '';       // 上次"接受对局"状态，防止重复点击接受
let inAramSelect = false;      // 当前是否处于大乱斗选角阶段
let lastBenchStr = '';         // 上次备选池 ID 快照（逗号分隔），用于检测变化
let lastPickedId = 0;          // 上次"无可用英雄"标记（-1 表示已记录）
let lastLocalChampionId = -999;// 上次手持英雄 ID，变化时触发日志和 UI 更新
let lastTargetId = 0;          // 上次日志输出的目标英雄 ID，防止重复日志
let lastSwapTargetId = 0;      // 上次尝试交换的目标 ID，防止重复交换同一英雄
let swapFailCount = 0;         // 连续交换失败计数（≥3 时退避，等待备选池刷新）
let phaseCheckCounter = 0;     // 阶段检测计数器（每 5 次轮询检测一次阶段变化）
let lastPhase = '';            // 上一次的游戏阶段
let mainLoopRunning = false;   // 互斥锁，防止 setInterval 导致 mainLoop 重叠执行

/**
 * 重置所有会话级状态（每局游戏结束后调用）
 */
function resetSessionState() {
  lastReadyState = '';
  inAramSelect = false;
  lastBenchStr = '';
  lastPickedId = 0;
  lastLocalChampionId = -999;
  lastTargetId = 0;
  lastSwapTargetId = 0;
  swapFailCount = 0;
  phaseCheckCounter = 0;
  lastPhase = '';
}

/**
 * 主循环入口（带互斥锁包装）
 * 由 setInterval 定时调用，间隔由 settings.pollingInterval 决定（默认 500ms）
 * setInterval 不会等待 async 完成，使用互斥锁防止重叠执行
 * 异常由 try/catch 兜底，确保锁一定释放
 */
async function mainLoop() {
  // 互斥锁：防止上一次 mainLoop 尚未完成时再次进入（setInterval 不等待 async 完成）
  if (mainLoopRunning) {
    return;
  }
  mainLoopRunning = true;

  try {
    await mainLoopInner();
  } catch (e) {
    addLog(`[主循环] 异常: ${e.message}`, 'error');
  } finally {
    mainLoopRunning = false;
  }
}

/**
 * 主循环核心逻辑
 * 每轮执行流程：
 *   1. 读取最新 settings（快照）
 *   2. 检测 LCU 连接状态 → 未连接则返回
 *   3. 自动接受对局（如开启 autoAccept）
 *   4. 每 5 次轮询检测一次游戏阶段变化
 *   5. 若处于 ChampSelect + ARAM → 获取会话 → 执行自动交换决策
 */
async function mainLoopInner() {
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

  // 功能1：自动接受对局（仅当状态从非 InProgress 变为 InProgress 时触发一次）
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
        store.set('settings', s); // ★ 必须持久化，否则 UI 显示 ON 但 store 仍是 false
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

  // ★ 自动交换决策算法：
  //   1. 计算当前手持英雄在 heroPriority 中的排名 (currentIndex)
  //   2. 遍历 heroPriority 找到备选池中排名最高的英雄 (bestIndex, targetId)
  //   3. 如果 bestIndex < currentIndex → 备选池有更高优先级英雄 → 执行交换
  //   4. 交换带 3 次重试 + 验证，防止 LCU 竞态
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
        // ★ 修复：失败时不设置 lastSwapTargetId，允许下次轮询重试
        // 但增加失败计数，连续失败过多时做退避
        swapFailCount++;
        if (swapFailCount >= 3) {
          addLog(`[选角] 连续失败${swapFailCount}次，跳过本轮等待备选池刷新`, 'warning');
          lastSwapTargetId = targetId; // 连续失败3次后才标记，等备选池变化再重试
          swapFailCount = 0;
        }
      } else {
        // ★ 修复：仅在成功时标记
        lastSwapTargetId = targetId;
        swapFailCount = 0;
      }
    }
  }
}

/**
 * 启动主循环定时器
 * 清除旧定时器，按 settings.pollingInterval 重新创建
 */
function startPolling() {
  if (pollingTimer) clearInterval(pollingTimer);
  const settings = store.get('settings');
  pollingTimer = setInterval(mainLoop, settings.pollingInterval || 1000);
  addLog('已启动主循环', 'info');
}

// ========== 选角仪表盘数据推送 ==========

/**
 * 向渲染进程推送选角仪表盘数据（备选池、手持英雄、进度等）
 * @param {boolean} inChampSelect - 是否处于选角阶段
 * @param {object} session - LCU 选角会话对象
 * @param {object} settings - 当前设置快照
 */
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

// ========== 激活窗口（许可证验证） ==========

/**
 * 创建激活/许可证验证窗口
 * 未激活时显示，激活成功后关闭并启动主窗口
 */
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

// ========== 主窗口 ==========

/**
 * 创建主窗口（无边框、固定大小、加载 index.html）
 */
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

/**
 * 创建系统托盘图标（右键菜单：显示窗口 / 退出）
 * 点击托盘图标切换窗口显示/隐藏
 */
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

// ========== IPC 通信（主进程 ←→ 渲染进程） ==========

// --- 状态查询 ---

/** 获取当前连接状态和游戏阶段 */
ipcMain.handle('app:get-status', () => {
  return {
    connected: isConnected,
    phase: gamePhase,
    championVersion: store.get('championData.version'),
    lastUpdate: store.get('championData.lastUpdate')
  };
});

/** 获取应用版本号 */
ipcMain.handle('app:get-app-version', () => {
  return appVersion;
});

// --- 设置相关 ---

/** 获取完整 settings 对象 */
ipcMain.handle('app:get-settings', () => {
  return store.get('settings');
});

/** 获取预设列表和当前选中预设 */
ipcMain.handle('app:get-presets', () => {
  const s = store.get('settings');
  return { presets: s.presets || [], selectedPreset: s.selectedPreset || null };
});

/** 切换到指定预设（同步 heroPriority 到 settings）并广播 */
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

/** 保存预设列表并广播 */
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

/** 
 * 保存设置（合并模式：渲染进程传来的 settings 与当前 store 合并，
 * presets/selectedPreset/pollingInterval 强制保留主进程值防止被过期快照覆盖）
 */
ipcMain.handle('app:save-settings', (_, settings) => {
  // 合并保存：渲染进程可能不含 presets 等字段，用当前 store 值兜底
  const current = store.get('settings');
  store.set('settings', {
    ...current,
    ...settings,
    presets: current.presets,
    selectedPreset: current.selectedPreset,
    pollingInterval: current.pollingInterval
  });
  addLog('设置已保存', 'success');
  return true;
});

/** 获取缓存的英雄数据映射（ID → {name, image}） */
ipcMain.handle('app:get-champions', () => {
  return store.get('championData.champions');
});

/** 获取全部日志（最近 100 条） */
ipcMain.handle('app:get-logs', () => {
  return logs;
});

// --- 错误收集 ---

/** 接收渲染进程未捕获错误 */
ipcMain.on('renderer:error', (_, info) => {
  const msg = `渲染器错误: ${info.message || ''} ${info.filename ? `at ${info.filename}:${info.lineno || 0}:${info.colno || 0}` : ''}`;
  const detail = info.stack || '';
  addLog(`${msg}\n${detail}`, 'error');
});

/** 接收渲染进程 console.error 输出 */
ipcMain.on('renderer:console', (_, args) => {
  try {
    addLog(`渲染器 console.error: ${args.join(' ')}`, 'error');
  } catch (e) {
    addLog(`渲染器 console.error: ${String(args)}`, 'error');
  }
});

// --- 英雄数据 ---

/** 手动刷新英雄数据（从 DataDragon CDN 重新拉取） */
ipcMain.handle('app:refresh-champions', async () => {
  addLog('手动刷新英雄数据...', 'info');
  const result = await fetchChampionData();
  return {
    success: result,
    version: store.get('championData.version'),
    lastUpdate: store.get('championData.lastUpdate')
  };
});

// --- 英雄交换 ---

/**
 * 手动交换英雄（渲染进程点击备选池卡片触发）
 * 流程：先关闭 aramPick 防止自动逻辑干扰 → 执行交换 → 验证
 * @param {number} heroId - 目标英雄 ID
 */
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

// --- 开关与窗口控制 ---

/** 设置自动选英雄开关状态 */
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

// ========== 许可证激活 ==========

/** 获取本机机器码（用于许可证绑定） */
ipcMain.handle('app:get-machine-code', () => {
  return getMachineFingerprint();
});

/** 验证许可证密钥，成功则存储激活信息 */
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

/** 激活完成：关闭激活窗口，启动主界面和轮询 */
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

/**
 * 检查本地存储的许可证是否有效
 * @returns {boolean} 是否已激活
 */
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
  // 第一步：检查许可证 → 未激活则显示激活窗口
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

/**
 * Preload 脚本 - 安全的 IPC 桥接层
 * 通过 contextBridge 向渲染进程暴露 window.electronAPI，
 * 渲染进程只能调用这里声明的方法，无法直接访问 Node.js API（contextIsolation）
 */
const { contextBridge, ipcRenderer } = require('electron');

// 暴露给渲染进程的安全 API
contextBridge.exposeInMainWorld('electronAPI', {
  // --- 状态查询 ---
  /** 获取当前连接状态和游戏阶段 */
  getStatus: () => ipcRenderer.invoke('app:get-status'),
  /** 监听连接状态变化（主进程主动推送） */
  onStatusUpdate: (callback) => {
    ipcRenderer.on('status:update', (_, data) => callback(data));
  },

  // --- 设置与预设 ---
  /** 获取完整 settings 对象 */
  getSettings: () => ipcRenderer.invoke('app:get-settings'),
  /** 保存设置到主进程 store */
  saveSettings: (settings) => ipcRenderer.invoke('app:save-settings', settings),
  /** 获取预设列表 */
  getPresets: () => ipcRenderer.invoke('app:get-presets'),
  /** 切换当前预设 */
  setSelectedPreset: (id) => ipcRenderer.invoke('app:set-selected-preset', id),
  /** 保存预设列表 */
  savePresets: (presets) => ipcRenderer.invoke('app:save-presets', presets),
  /** 监听预设变化（主进程广播） */
  onPresetsUpdated: (callback) => {
    ipcRenderer.on('presets:updated', (_, data) => callback(data));
  },

  // --- 英雄数据 ---
  /** 获取缓存的英雄数据（ID → 名称/头像） */
  getChampions: () => ipcRenderer.invoke('app:get-champions'),
  /** 手动刷新英雄数据（从 CDN 重新拉取） */
  refreshChampions: () => ipcRenderer.invoke('app:refresh-champions'),

  // --- 日志 ---
  /** 获取历史日志列表 */
  getLogs: () => ipcRenderer.invoke('app:get-logs'),
  /** 监听新日志（实时推送） */
  onNewLog: (callback) => {
    ipcRenderer.on('log:new', (_, log) => callback(log));
  },

  // --- 选角仪表盘 ---
  /** 监听选角数据更新（备选池、手持英雄等） */
  onPickUpdate: (callback) => {
    ipcRenderer.on('pick:update', (_, data) => callback(data));
  },

  // --- 英雄交换 ---
  /** 手动交换到指定英雄（点击备选池卡片触发） */
  manualSwap: (heroId) => ipcRenderer.invoke('app:manual-swap', heroId),

  // --- 自动选英雄开关 ---
  /** 设置自动选英雄开关 */
  setAutoPickEnabled: (enabled) => ipcRenderer.invoke('app:set-auto-pick', enabled),
  /** 监听开关状态变化（手动交换关闭 / 对局结束恢复） */
  onAutoPickChanged: (callback) => {
    ipcRenderer.on('auto-pick:changed', (_, enabled) => callback(enabled));
  },

  // --- 窗口控制 ---
  minimize: () => ipcRenderer.invoke('window:minimize'),
  close: () => ipcRenderer.invoke('window:close'),

  // --- 许可证 ---
  /** 获取本机机器指纹 */
  getMachineCode: () => ipcRenderer.invoke('app:get-machine-code'),
  /** 验证许可证密钥 */
  activateLicense: (licenseKey) => ipcRenderer.invoke('app:activate-license', licenseKey),
  /** 激活完成：关闭激活窗口，启动主界面 */
  activationComplete: () => ipcRenderer.invoke('app:activation-complete'),
  /** 获取应用版本号 */
  getAppVersion: () => ipcRenderer.invoke('app:get-app-version')
});

// ========== 全局错误捕获 ==========
// 将渲染进程的未捕获错误转发到主进程，统一记录到日志

/** 捕获 window.onerror（同步错误） */
window.addEventListener('error', (event) => {
  try {
    ipcRenderer.send('renderer:error', {
      type: 'error',
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      stack: event.error && event.error.stack ? event.error.stack : null
    });
  } catch (e) {}
});

/** 捕获 Promise 未处理的 rejection */
window.addEventListener('unhandledrejection', (event) => {
  try {
    ipcRenderer.send('renderer:error', {
      type: 'unhandledrejection',
      message: event.reason ? (event.reason.message || String(event.reason)) : 'unhandledrejection',
      stack: event.reason && event.reason.stack ? event.reason.stack : null
    });
  } catch (e) {}
});

/** 拦截 console.error，转发到主进程日志（保留原始行为） */
(function() {
  const _consoleError = console.error.bind(console);
  console.error = function(...args) {
    try {
      ipcRenderer.send('renderer:console', args.map(a => {
        try { return typeof a === 'string' ? a : JSON.stringify(a); } catch (e) { return String(a); }
      }));
    } catch (e) {}
    _consoleError(...args);
  };
})();

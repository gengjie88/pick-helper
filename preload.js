const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 状态相关
  getStatus: () => ipcRenderer.invoke('app:get-status'),
  onStatusUpdate: (callback) => {
    ipcRenderer.on('status:update', (_, data) => callback(data));
  },

  // 设置相关
  getSettings: () => ipcRenderer.invoke('app:get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('app:save-settings', settings),
  // 预设相关
  getPresets: () => ipcRenderer.invoke('app:get-presets'),
  setSelectedPreset: (id) => ipcRenderer.invoke('app:set-selected-preset', id),
  savePresets: (presets) => ipcRenderer.invoke('app:save-presets', presets),
  onPresetsUpdated: (callback) => {
    ipcRenderer.on('presets:updated', (_, data) => callback(data));
  },

  // 英雄数据
  getChampions: () => ipcRenderer.invoke('app:get-champions'),
  refreshChampions: () => ipcRenderer.invoke('app:refresh-champions'),

  // 日志
  getLogs: () => ipcRenderer.invoke('app:get-logs'),
  onNewLog: (callback) => {
    ipcRenderer.on('log:new', (_, log) => callback(log));
  },

  // 选角仪表盘事件
  onPickUpdate: (callback) => {
    ipcRenderer.on('pick:update', (_, data) => callback(data));
  },

  // 手动交换英雄（从备选池点击）
  manualSwap: (heroId) => ipcRenderer.invoke('app:manual-swap', heroId),

  // 设置自动选英雄开关状态
  setAutoPickEnabled: (enabled) => ipcRenderer.invoke('app:set-auto-pick', enabled),

  // 监听自动选择开关变化
  onAutoPickChanged: (callback) => {
    ipcRenderer.on('auto-pick:changed', (_, enabled) => callback(enabled));
  },

  // 窗口控制
  minimize: () => ipcRenderer.invoke('window:minimize'),
  close: () => ipcRenderer.invoke('window:close')
});

// 渲染进程全局错误捕获，转发到主进程，便于定位问题
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

window.addEventListener('unhandledrejection', (event) => {
  try {
    ipcRenderer.send('renderer:error', {
      type: 'unhandledrejection',
      message: event.reason ? (event.reason.message || String(event.reason)) : 'unhandledrejection',
      stack: event.reason && event.reason.stack ? event.reason.stack : null
    });
  } catch (e) {}
});

// 捕获 console.error 输出并转发（保留原行为）
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

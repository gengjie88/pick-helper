// 设置页面渲染进程

// DOM 元素
const backBtn = document.getElementById('backBtn');
const minimizeBtn = document.getElementById('minimizeBtn');
const closeBtn = document.getElementById('closeBtn');
const autoAcceptToggle = document.getElementById('autoAcceptToggle');
const aramPickToggle = document.getElementById('aramPickToggle');
const heroSearch = document.getElementById('heroSearch');
const heroDropdown = document.getElementById('heroDropdown');
const selectedHeroes = document.getElementById('selectedHeroes');
const dataVersion = document.getElementById('dataVersion');
const refreshBtn = document.getElementById('refreshBtn');
const logContainer = document.getElementById('logContainer');
const debugBtn = document.getElementById('debugBtn');
const textLogModal = document.getElementById('textLogModal');
const textLogArea = document.getElementById('textLogArea');
const closeTextLogBtn = document.getElementById('closeTextLogBtn');
const copyLogBtn = document.getElementById('copyLogBtn');
const presetManageSelect = document.getElementById('presetManageSelect');
const presetNameInput = document.getElementById('presetNameInput');
const addPresetBtn = document.getElementById('addPresetBtn');
const savePresetBtn = document.getElementById('savePresetBtn');
const delPresetBtn = document.getElementById('delPresetBtn');

// 立即绑定窗口控制，确保在异步 init 之前也能响应
if (backBtn) {
  backBtn.addEventListener('click', () => {
    window.electronAPI.navigate('home');
  });
}

if (minimizeBtn) {
  minimizeBtn.addEventListener('click', () => {
    window.electronAPI.minimize();
  });
}

if (closeBtn) {
  closeBtn.addEventListener('click', () => {
    window.electronAPI.close();
  });
}

// 全局数据
let allChampions = {};
let heroPriority = [];
let currentSettings = {};
let presetsList = [];
let isCreatingPreset = false;
let currentPresetId = null;

// 尝试将可能的二进制/Buffer 日志消息按 UTF-8 解码为字符串
function decodeLogMessage(msg) {
  if (!msg && msg !== 0) return '';
  if (typeof msg === 'string') return msg;
  // Electron 有时会传递 Buffer-like 对象
  try {
    // Node Buffer
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(msg)) {
      return msg.toString('utf8');
    }
  } catch (e) {}

  try {
    // Uint8Array / ArrayBuffer
    if (msg instanceof Uint8Array) {
      return new TextDecoder('utf-8').decode(msg);
    }
    if (msg instanceof ArrayBuffer) {
      return new TextDecoder('utf-8').decode(new Uint8Array(msg));
    }
  } catch (e) {}

  // 最后尝试 JSON stringify -> string
  try {
    return String(msg);
  } catch (e) {
    return '';
  }
}

// 切换开关状态
function toggleSwitch(el) {
  el.classList.toggle('active');
  return el.classList.contains('active');
}

// 保存设置
async function saveSettings() {
  currentSettings.autoAccept = autoAcceptToggle.classList.contains('active');
  currentSettings.aramPick = aramPickToggle.classList.contains('active');
  currentSettings.heroPriority = [...heroPriority];
  
  await window.electronAPI.saveSettings(currentSettings);
}

// 渲染已选英雄列表
function renderSelectedHeroes() {
  if (heroPriority.length === 0) {
    selectedHeroes.innerHTML = '<div class="empty-state" style="padding:20px;">暂无英雄，请搜索添加</div>';
    return;
  }

  let html = '';
  heroPriority.forEach((id, index) => {
    const champ = allChampions[id];
    if (champ) {
      html += `
        <div class="selected-hero-item" data-id="${id}" draggable="true">
          <div class="selected-hero-rank">${index + 1}</div>
          <img class="selected-hero-avatar" src="${champ.image}" alt="${champ.name}">
          <span class="selected-hero-name">${champ.name}</span>
          <button class="remove-btn" data-id="${id}" title="移除">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      `;
    }
  });

  selectedHeroes.innerHTML = html;

  // 绑定删除事件
  document.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id);
      removeHero(id);
    });
  });

  // 绑定拖拽事件
  let dragSrcId = null;
  document.querySelectorAll('.selected-hero-item').forEach(item => {
    item.addEventListener('dragstart', (e) => {
      dragSrcId = parseInt(item.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(dragSrcId)); } catch (err) {}
      item.classList.add('dragging');
    });

    item.addEventListener('dragend', (e) => {
      item.classList.remove('dragging');
      dragSrcId = null;
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      const targetId = parseInt(item.dataset.id);
      const draggedId = dragSrcId || parseInt(e.dataTransfer.getData('text/plain'));
      if (!draggedId || draggedId === targetId) return;
      // 重排 heroPriority
      heroPriority = heroPriority.filter(h => h !== draggedId);
      const targetIndex = heroPriority.findIndex(h => h === targetId);
      if (targetIndex === -1) {
        heroPriority.push(draggedId);
      } else {
        heroPriority.splice(targetIndex, 0, draggedId);
      }
      renderSelectedHeroes();
      saveSettings();
    });
  });
}

// 添加英雄
function addHero(id) {
  if (!heroPriority.includes(id)) {
    heroPriority.push(id);
    renderSelectedHeroes();
    saveSettings();
  }
  heroSearch.value = '';
  heroDropdown.classList.remove('show');
}

// 移除英雄
function removeHero(id) {
  heroPriority = heroPriority.filter(hid => hid !== id);
  renderSelectedHeroes();
  saveSettings();
}

// 搜索英雄
function searchHeroes(query) {
  if (!query.trim()) {
    heroDropdown.classList.remove('show');
    return;
  }

  const results = Object.values(allChampions).filter(champ => {
    const name = champ.name || '';
    const title = champ.title || '';
    const q = query.toLowerCase();
    return name.toLowerCase().includes(q) || title.toLowerCase().includes(q);
  }).slice(0, 10); // 最多显示10个结果

  if (results.length === 0) {
    heroDropdown.innerHTML = '<div class="hero-option" style="color:#94a3b8;cursor:default;">未找到匹配的英雄</div>';
  } else {
    let html = '';
    results.forEach(champ => {
      const isSelected = heroPriority.includes(champ.id);
      html += `
        <div class="hero-option" data-id="${champ.id}" style="${isSelected ? 'opacity:0.5;' : ''}">
          <img class="hero-option-avatar" src="${champ.image}" alt="${champ.name}">
          <span class="hero-option-name">${champ.name}</span>
        </div>
      `;
    });
    heroDropdown.innerHTML = html;

    // 绑定点击事件
    heroDropdown.querySelectorAll('.hero-option').forEach(item => {
      item.addEventListener('click', () => {
        const id = parseInt(item.dataset.id);
        if (!heroPriority.includes(id)) {
          addHero(id);
        }
      });
    });
  }

  heroDropdown.classList.add('show');
}

// 渲染日志
function renderLogs(logs) {
  if (!logs || logs.length === 0) {
    logContainer.innerHTML = `
      <div class="log-item info">
        <span class="log-time">--:--:--</span>
        <span class="log-msg">暂无日志</span>
      </div>
    `;
    return;
  }

  let html = '';
  logs.slice(0, 50).forEach(log => {
    const time = log.time ? log.time.split(' ')[1] || log.time : '--:--:--';
    const msg = decodeLogMessage(log.message);
    html += `
      <div class="log-item ${log.type || 'info'}">
        <span class="log-time">${time}</span>
        <span class="log-msg">${msg}</span>
      </div>
    `;
  });

  logContainer.innerHTML = html;
}

// 添加单条日志
function addLog(log) {
  const time = log.time ? log.time.split(' ')[1] || log.time : '--:--:--';
  const msg = decodeLogMessage(log.message);
  const newLog = document.createElement('div');
  newLog.className = `log-item ${log.type || 'info'}`;
  newLog.innerHTML = `
    <span class="log-time">${time}</span>
    <span class="log-msg">${msg}</span>
  `;
  
  logContainer.insertBefore(newLog, logContainer.firstChild);
  
  // 限制日志数量
  while (logContainer.children.length > 50) {
    logContainer.removeChild(logContainer.lastChild);
  }
}

// 更新数据版本显示
async function updateDataVersion() {
  try {
    const status = await window.electronAPI.getStatus();
    if (status.championVersion) {
      const date = status.lastUpdate ? new Date(status.lastUpdate) : null;
      const dateStr = date ? `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}` : '-';
      dataVersion.textContent = `v${status.championVersion} · 更新于 ${dateStr}`;
    } else {
      dataVersion.textContent = '暂无数据';
    }
  } catch (e) {
    dataVersion.textContent = '加载失败';
  }
}

// 初始化
async function init() {
  // 显示应用版本
  try {
    const v = await window.electronAPI.getAppVersion();
    const tag = document.getElementById('appVersionTagSettings');
    if (v && tag) tag.textContent = 'v' + v;
  } catch (_) {}

  // 获取设置
  currentSettings = await window.electronAPI.getSettings();
  heroPriority = [...(currentSettings.heroPriority || [])];

  // 载入预设
  try {
    const res = await window.electronAPI.getPresets();
    presetsList = res.presets || [];
    const selected = res.selectedPreset || (presetsList[0] && presetsList[0].id) || '';
    function renderPresetOptions() {
      presetManageSelect.innerHTML = '';
      presetsList.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name || p.id;
        presetManageSelect.appendChild(opt);
      });
      // 保证至少有一个选项
      if (presetsList.length === 0) {
        presetsList.push({ id: 'default', name: '默认', heroPriority: [...heroPriority] });
      }
    }

    renderPresetOptions();
    if (selected) {
      presetManageSelect.value = selected;
      const cur = presetsList.find(p => p.id === selected);
      if (cur) {
        presetNameInput.value = cur.name || '';
        heroPriority = [...(cur.heroPriority || [])];
        currentPresetId = cur.id;
      }
    } else if (presetsList[0]) {
      presetManageSelect.value = presetsList[0].id;
      presetNameInput.value = presetsList[0].name || '';
      heroPriority = [...(presetsList[0].heroPriority || [])];
      currentPresetId = presetsList[0].id;
    }

    // 选中时立即同步到主界面并加载到编辑区
    presetManageSelect.addEventListener('change', async () => {
      const id = presetManageSelect.value;
      if (!id) return;
      currentPresetId = id;
      isCreatingPreset = false;
      const p = presetsList.find(x => x.id === id);
      if (p) {
        presetNameInput.value = p.name || '';
        heroPriority = [...(p.heroPriority || [])];
        renderSelectedHeroes();
        // 立即同步选中预设到主进程（首页会切换）
        await window.electronAPI.setSelectedPreset(id);
      }
      updatePresetButtonsState();
    });

    // 监听主进程广播的预设更新，保持 UI 同步
    if (window.electronAPI.onPresetsUpdated) {
      window.electronAPI.onPresetsUpdated((data) => {
        try {
          presetsList = data.presets || [];
          const sel = data.selectedPreset || (presetsList[0] && presetsList[0].id) || '';
          renderPresetOptions();
          if (sel) presetManageSelect.value = sel;
          updatePresetButtonsState();
        } catch (e) {}
      });
    }
  } catch (e) {
    console.error('加载预设失败', e);
  }

  function updatePresetButtonsState() {
    // 禁用删除当只有一个预设或处于新建状态
    if (!delPresetBtn) return;
    if (isCreatingPreset || presetsList.length <= 1) {
      delPresetBtn.disabled = true;
    } else {
      delPresetBtn.disabled = false;
    }
  }

  // 设置开关状态
  if (currentSettings.autoAccept) {
    autoAcceptToggle.classList.add('active');
  } else {
    autoAcceptToggle.classList.remove('active');
  }

  if (currentSettings.aramPick) {
    aramPickToggle.classList.add('active');
  } else {
    aramPickToggle.classList.remove('active');
  }

  // 获取英雄数据
  allChampions = await window.electronAPI.getChampions();

  // 渲染已选英雄
  renderSelectedHeroes();

  // 更新数据版本
  updateDataVersion();

  // 获取日志
  const logs = await window.electronAPI.getLogs();
  renderLogs(logs);

  // 监听新日志
  window.electronAPI.onNewLog((log) => {
    addLog(log);
  });

  // 调试日志按钮事件
  if (debugBtn) {
    debugBtn.addEventListener('click', async () => {
      const logs = await window.electronAPI.getLogs();
      const text = (logs || []).map(l => `${l.time || ''} ${l.type || ''} ${decodeLogMessage(l.message) || ''}`).join('\n');
      if (textLogArea) textLogArea.value = text;
      if (textLogModal) textLogModal.style.display = 'block';
    });
  }

  if (closeTextLogBtn) {
    closeTextLogBtn.addEventListener('click', () => {
      if (textLogModal) textLogModal.style.display = 'none';
    });
  }

  if (copyLogBtn) {
    copyLogBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(textLogArea.value || '');
      } catch (e) {
        console.error('复制失败', e);
      }
    });
  }

  // 开关事件
  autoAcceptToggle.addEventListener('click', () => {
    toggleSwitch(autoAcceptToggle);
    saveSettings();
  });

  aramPickToggle.addEventListener('click', () => {
    toggleSwitch(aramPickToggle);
    saveSettings();
  });

  // 搜索框事件
  heroSearch.addEventListener('input', (e) => {
    searchHeroes(e.target.value);
  });

  heroSearch.addEventListener('focus', () => {
    if (heroSearch.value.trim()) {
      searchHeroes(heroSearch.value);
    }
  });

  // 点击外部关闭下拉
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-box')) {
      heroDropdown.classList.remove('show');
    }
  });

  // 刷新按钮
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = '刷新中...';
    
    try {
      const result = await window.electronAPI.refreshChampions();
      if (result.success) {
        allChampions = await window.electronAPI.getChampions();
        renderSelectedHeroes();
        updateDataVersion();
      }
    } catch (e) {
      console.error('刷新失败:', e);
    }
    
    refreshBtn.disabled = false;
    refreshBtn.textContent = '刷新';
  });

  // 预设管理按钮
  if (addPresetBtn) {
    addPresetBtn.addEventListener('click', async () => {
      // 进入新建模式：清空列表，等待用户编辑并点击保存生成新预设
      isCreatingPreset = true;
      currentPresetId = null;
      presetNameInput.value = '';
      heroPriority = [];
      renderSelectedHeroes();
      updatePresetButtonsState();
      // 清空下拉选择（不立即创建）
      presetManageSelect.selectedIndex = -1;
    });
  }

  if (savePresetBtn) {
    savePresetBtn.addEventListener('click', async () => {
      const name = presetNameInput.value.trim() || `预设 ${new Date().toLocaleString()}`;
      // 如果处于新建模式或名称与当前预设不同，则新建预设
      if (isCreatingPreset || !currentPresetId) {
        const id = `preset_${Date.now()}`;
        presetsList.push({ id, name, heroPriority: [...heroPriority] });
        await window.electronAPI.savePresets(presetsList);
        // 选中新建的预设并同步
        await window.electronAPI.setSelectedPreset(id);
        isCreatingPreset = false;
        currentPresetId = id;
      } else {
        // 非新建，判断名称是否被修改（若修改，则新建；否则更新当前）
        const cur = presetsList.find(p => p.id === currentPresetId) || {};
        if (cur.name !== name) {
          // 名称修改 -> 新建
          const id = `preset_${Date.now()}`;
          presetsList.push({ id, name, heroPriority: [...heroPriority] });
          await window.electronAPI.savePresets(presetsList);
          await window.electronAPI.setSelectedPreset(id);
          currentPresetId = id;
        } else {
          // 更新当前预设的数据
          const idx = presetsList.findIndex(p => p.id === currentPresetId);
          if (idx !== -1) {
            presetsList[idx].heroPriority = [...heroPriority];
            presetsList[idx].name = name;
            await window.electronAPI.savePresets(presetsList);
            await window.electronAPI.setSelectedPreset(currentPresetId);
          }
        }
      }
      // reload local presetsList from main process
      const res = await window.electronAPI.getPresets();
      presetsList = res.presets || [];
      // refresh UI
      presetManageSelect.innerHTML = '';
      presetsList.forEach(p => {
        const opt = document.createElement('option'); opt.value = p.id; opt.textContent = p.name || p.id;
        presetManageSelect.appendChild(opt);
      });
      if (currentPresetId) presetManageSelect.value = currentPresetId;
      updatePresetButtonsState();
    });
  }

  if (delPresetBtn) {
    delPresetBtn.addEventListener('click', async () => {
      const id = presetManageSelect.value || currentPresetId;
      if (!id) return;
      // 禁止删除当只有一个预设
      if (presetsList.length <= 1) return;
      if (!confirm('确认删除当前预设？此操作不可撤销。')) return;
      presetsList = presetsList.filter(p => p.id !== id);
      await window.electronAPI.savePresets(presetsList);
      // 如果删除了当前选中，切换到第一个
      const res2 = await window.electronAPI.getPresets();
      presetsList = res2.presets || [];
      if (presetsList[0]) {
        await window.electronAPI.setSelectedPreset(presetsList[0].id);
        currentPresetId = presetsList[0].id;
        presetNameInput.value = presetsList[0].name || '';
        heroPriority = [...(presetsList[0].heroPriority || [])];
        renderSelectedHeroes();
      }
      // refresh options
      presetManageSelect.innerHTML = '';
      presetsList.forEach(p => {
        const opt = document.createElement('option'); opt.value = p.id; opt.textContent = p.name || p.id;
        presetManageSelect.appendChild(opt);
      });
      updatePresetButtonsState();
    });
  }

  
}

init();

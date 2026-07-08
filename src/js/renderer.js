// 主页面渲染进程（单页整合版）

// ===== 游戏阶段中文映射 =====
const phaseMap = {
  'None': '大厅',
  'Lobby': '房间',
  'Matchmaking': '匹配中',
  'ReadyCheck': '接受对局',
  'ChampSelect': '选角中',
  'GameStart': '游戏开始',
  'InProgress': '游戏中',
  'WaitingForStats': '等待结算',
  'EndOfGame': '游戏结束',
  'PreEndOfGame': '即将结束',
  'Reconnect': '重连中'
};

// ===== DOM 元素 =====
// 标题栏
const autoAcceptBtn = document.getElementById('autoAcceptBtn');
const statusDot = document.getElementById('statusDot');
const connectionText = document.getElementById('connectionText');
const dataVersionTop = document.getElementById('dataVersionTop');
const appVersionTag = document.getElementById('appVersionTag');
const refreshBtnTop = document.getElementById('refreshBtnTop');
const minimizeBtn = document.getElementById('minimizeBtn');
const closeBtn = document.getElementById('closeBtn');

// 仪表盘
const pickDashboard = document.getElementById('pickDashboard');
const aramPickBtn = document.getElementById('aramPickBtn');
const phaseBadge = document.getElementById('phaseBadge');
const progressFill = document.getElementById('progressFill');
const pickProgress = document.getElementById('pickProgress');
const benchGrid = document.getElementById('benchGrid');
const benchEmpty = document.getElementById('benchEmpty');
const currentHold = document.getElementById('currentHold');
const holdChampion = document.getElementById('holdChampion');

// 英雄配置
const presetManageSelect = document.getElementById('presetManageSelect');
const presetNameInput = document.getElementById('presetNameInput');
const addPresetBtn = document.getElementById('addPresetBtn');
const savePresetBtn = document.getElementById('savePresetBtn');
const delPresetBtn = document.getElementById('delPresetBtn');
const heroSearch = document.getElementById('heroSearch');
const heroDropdown = document.getElementById('heroDropdown');
const selectedHeroes = document.getElementById('selectedHeroes');

// 图表
const ahChartDom = document.getElementById('ahChart');

// 日志
const logContainer = document.getElementById('logContainer');

// ===== 全局数据 =====
let allChampions = {};
let heroPriority = [];
let currentSettings = {};
let presetsList = [];
let isCreatingPreset = false;
let currentPresetId = null;

// ===== 开关按钮 =====
function setSwitchActive(btn, active) {
  if (active) {
    btn.classList.add('active');
  } else {
    btn.classList.remove('active');
  }
}

function isSwitchActive(btn) {
  return btn.classList.contains('active');
}

autoAcceptBtn.addEventListener('click', () => {
  autoAcceptBtn.classList.toggle('active');
  saveCurrentSettings();
});

aramPickBtn.addEventListener('click', () => {
  aramPickBtn.classList.toggle('active');
  saveCurrentSettings();
});

async function saveCurrentSettings() {
  currentSettings.autoAccept = isSwitchActive(autoAcceptBtn);
  currentSettings.aramPick = isSwitchActive(aramPickBtn);
  currentSettings.heroPriority = [...heroPriority];
  await window.electronAPI.saveSettings(currentSettings);
}

// ===== 状态更新 =====
function updateConnectionStatus(connected) {
  if (connected) {
    statusDot.className = 'status-dot connected';
    connectionText.textContent = '已连接';
  } else {
    statusDot.className = 'status-dot disconnected';
    connectionText.textContent = '未连接';
  }
}

function updateGamePhase(phase) {
  const display = phase && phaseMap[phase] ? phaseMap[phase] : (phase || '-');
  phaseBadge.textContent = display;

  // 阶段样式
  phaseBadge.classList.remove('in-progress', 'selecting');
  if (phase === 'ChampSelect') {
    phaseBadge.classList.add('selecting');
  } else if (phase === 'InProgress') {
    phaseBadge.classList.add('in-progress');
  }

  // 选角仪表盘可见性
  if (phase === 'ChampSelect') {
    pickProgress.style.display = '';
  } else {
    pickProgress.style.display = 'none';
    progressFill.style.width = '0%';
    if (!pickDashboard.dataset.wasActive) {
      // 非选角阶段清除 bench
      benchGrid.innerHTML = '<div class="bench-empty" id="benchEmpty">等待进入选角阶段...</div>';
      currentHold.style.display = 'none';
    }
  }
  pickDashboard.dataset.wasActive = (phase === 'ChampSelect') ? '1' : '';
}

// ===== 仪表盘：选角数据更新 =====
function updatePickDashboard(data) {
  const { inChampSelect, benchChampions, localChampion, progress, lastAction } = data || {};

  if (!inChampSelect) {
    progressFill.style.width = '0%';
    benchGrid.innerHTML = '<div class="bench-empty">等待进入选角阶段...</div>';
    currentHold.style.display = 'none';
    return;
  }

  // 进度条
  if (typeof progress === 'number') {
    progressFill.style.width = Math.min(100, Math.max(0, progress)) + '%';
  }

  // 备选池
  if (benchChampions && benchChampions.length > 0) {
    benchGrid.innerHTML = '';

    benchChampions.forEach(champ => {
      const card = document.createElement('div');
      card.className = 'bench-card';

      if (champ.priorityIndex !== undefined && champ.priorityIndex !== null) {
        card.classList.add('priority');
        if (champ.priorityIndex === 0) {
          card.classList.add('top-priority');
        }
      }

      // 手动选择：始终可点击，点击即交换
      card.classList.add('clickable');
      card.title = '点击交换到此英雄';
      card.addEventListener('click', async () => {
        await manualSwapHero(champ.id);
      });

      card.innerHTML = `
        <img class="bench-card-avatar" src="${champ.image || ''}" alt="${champ.name}" 
             onerror="this.style.background='#e2e8f0';this.src=''">
        <span class="bench-card-name">${champ.name || ('ID:' + champ.id)}</span>
      `;

      if (champ.priorityIndex !== undefined && champ.priorityIndex !== null) {
        const badge = document.createElement('span');
        badge.className = 'bench-card-badge' + (champ.priorityIndex === 0 ? ' top' : '');
        badge.textContent = '#' + (champ.priorityIndex + 1);
        card.appendChild(badge);
      }

      benchGrid.appendChild(card);
    });

    if (benchGrid.querySelector('#benchEmpty')) {
      benchGrid.querySelector('#benchEmpty').remove();
    }
  } else {
    benchGrid.innerHTML = '<div class="bench-empty">备选池暂无英雄</div>';
  }

  // 当前手持
  if (localChampion && localChampion.id) {
    currentHold.style.display = 'flex';
    holdChampion.innerHTML = `
      <img class="hold-avatar" src="${localChampion.image || ''}" alt="${localChampion.name}" 
           onerror="this.style.background='#e2e8f0';this.src=''">
      <span class="hold-name">${localChampion.name || ('ID:' + localChampion.id)}</span>
      ${localChampion.priorityIndex !== undefined && localChampion.priorityIndex !== null 
        ? `<span class="hold-rank">优先级 #${localChampion.priorityIndex + 1}</span>` : ''}
    `;
  } else {
    currentHold.style.display = 'none';
  }
}

// ===== 手动交换英雄 =====
async function manualSwapHero(heroId) {
  if (!heroId) return;

  // 立即关闭自动选择开关（UI 反馈）
  if (isSwitchActive(aramPickBtn)) {
    setSwitchActive(aramPickBtn, false);
  }

  const result = await window.electronAPI.manualSwap(heroId);
  if (!result || !result.success) {
    addLogEntry({ time: new Date().toLocaleString('zh-CN'), message: '手动交换失败，请重试', type: 'error' });
  }
}

// ===== 英雄优先级配置 =====
function renderSelectedHeroes() {
  if (!heroPriority.length) {
    selectedHeroes.innerHTML = '<div class="empty-state">暂无英雄，请搜索添加</div>';
    return;
  }

  let html = '';
  heroPriority.forEach((id, index) => {
    const champ = allChampions[id];
    if (champ) {
      html += `
        <div class="selected-hero-item" data-id="${id}" draggable="true">
          <div class="selected-hero-rank">${index + 1}</div>
          <img class="selected-hero-avatar" src="${champ.image}" alt="${champ.name}" onerror="this.style.background='#e2e8f0';this.src=''">
          <span class="selected-hero-name">${champ.name}</span>
          <button class="remove-btn" data-id="${id}" title="移除">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>`;
    }
  });
  selectedHeroes.innerHTML = html;

  // 删除按钮
  selectedHeroes.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeHero(parseInt(btn.dataset.id));
    });
  });

  // 拖拽排序
  let dragSrcId = null;
  selectedHeroes.querySelectorAll('.selected-hero-item').forEach(item => {
    item.addEventListener('dragstart', (e) => {
      dragSrcId = parseInt(item.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(dragSrcId)); } catch (_) {}
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => {
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
      heroPriority = heroPriority.filter(h => h !== draggedId);
      const idx = heroPriority.findIndex(h => h === targetId);
      heroPriority.splice(idx === -1 ? heroPriority.length : idx, 0, draggedId);
      renderSelectedHeroes();
      saveCurrentSettings();
    });
  });
}

function addHero(id) {
  if (!heroPriority.includes(id)) {
    heroPriority.push(id);
    renderSelectedHeroes();
    saveCurrentSettings();
  }
  heroSearch.value = '';
  heroDropdown.classList.remove('show');
}

function removeHero(id) {
  heroPriority = heroPriority.filter(h => h !== id);
  renderSelectedHeroes();
  saveCurrentSettings();
}

function searchHeroes(query) {
  if (!query.trim()) {
    heroDropdown.classList.remove('show');
    return;
  }
  const results = Object.values(allChampions).filter(c => {
    const q = query.toLowerCase();
    return (c.name || '').toLowerCase().includes(q) || (c.title || '').toLowerCase().includes(q);
  }).slice(0, 10);

  if (!results.length) {
    heroDropdown.innerHTML = '<div class="hero-option" style="color:#94a3b8;cursor:default;">未找到匹配的英雄</div>';
  } else {
    heroDropdown.innerHTML = results.map(c =>
      `<div class="hero-option" data-id="${c.id}" style="${heroPriority.includes(c.id) ? 'opacity:0.5;' : ''}">
        <img class="hero-option-avatar" src="${c.image}" alt="${c.name}" onerror="this.style.background='#e2e8f0';this.src=''">
        <span class="hero-option-name">${c.name}</span>
      </div>`
    ).join('');
    heroDropdown.querySelectorAll('.hero-option').forEach(item => {
      item.addEventListener('click', () => {
        const id = parseInt(item.dataset.id);
        if (!heroPriority.includes(id)) addHero(id);
      });
    });
  }
  heroDropdown.classList.add('show');
}

// ===== 预设管理 =====
function renderPresetOptions() {
  presetManageSelect.innerHTML = '';
  presetsList.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name || p.id;
    presetManageSelect.appendChild(opt);
  });
  if (!presetsList.length) {
    presetsList.push({ id: 'default', name: '默认', heroPriority: [...heroPriority] });
    const opt = document.createElement('option');
    opt.value = 'default';
    opt.textContent = '默认';
    presetManageSelect.appendChild(opt);
  }
}

function updatePresetButtonsState() {
  delPresetBtn.disabled = isCreatingPreset || presetsList.length <= 1;
}

async function syncPresetToMain(id) {
  await window.electronAPI.setSelectedPreset(id);
}

// ===== 日志 =====
function renderLogs(logs) {
  if (!logs || !logs.length) {
    logContainer.innerHTML = '<div class="log-item info"><span class="log-time">--:--:--</span><span class="log-msg">暂无日志</span></div>';
    return;
  }
  logContainer.innerHTML = logs.slice(0, 100).map(l => {
    const time = l.time ? l.time.split(' ')[1] || l.time : '--:--:--';
    return `<div class="log-item ${l.type || 'info'}"><span class="log-time">${time}</span><span class="log-msg">${escapeHtml(String(l.message || ''))}</span></div>`;
  }).join('');
}

function addLogEntry(log) {
  const time = log.time ? log.time.split(' ')[1] || log.time : '--:--:--';
  const div = document.createElement('div');
  div.className = `log-item ${log.type || 'info'}`;
  div.innerHTML = `<span class="log-time">${time}</span><span class="log-msg">${escapeHtml(String(log.message || ''))}</span>`;
  logContainer.insertBefore(div, logContainer.firstChild);
  while (logContainer.children.length > 100) logContainer.removeChild(logContainer.lastChild);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ===== 数据版本 =====
async function updateDataVersion() {
  try {
    const status = await window.electronAPI.getStatus();
    const ver = status.championVersion || '-';
    const dateStr = status.lastUpdate ? (() => {
      const d = new Date(status.lastUpdate);
      return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
    })() : '-';
    const text = `v${ver} · ${dateStr}`;
    dataVersionTop.textContent = text;
  } catch (_) {
    dataVersionTop.textContent = 'v-';
  }
}

// ===== 技能急速换算图表 =====
function initAhChart() {
  if (!ahChartDom || typeof echarts === 'undefined') return;

  // 生成曲线数据：AH 0~500
  const data = [];
  for (let ah = 0; ah <= 500; ah += 2) {
    const cdr = (ah / (100 + ah)) * 100;
    data.push([ah, +cdr.toFixed(2)]);
  }

  // 标注点
  const markPoints = [
    { name: '40%≈66.7AH', coord: [66.7, 40], symbolOffset: [0, -12] },
    { name: '50%=100AH',  coord: [100, 50], symbolOffset: [0, -12] },
    { name: '66.7%=200AH', coord: [200, 66.7], symbolOffset: [0, -12] },
    { name: '83.3%=500AH', coord: [500, 83.3], symbolOffset: [0, -12] },
  ];

  const chart = echarts.init(ahChartDom);

  const option = {
    grid: {
      left: 48,
      right: 24,
      top: 18,
      bottom: 36,
    },
    xAxis: {
      type: 'value',
      name: '技能急速 (AH)',
      nameLocation: 'center',
      nameGap: 28,
      nameTextStyle: { fontSize: 11, color: '#64748b' },
      min: 0,
      max: 500,
      interval: 100,
      axisLabel: { fontSize: 10, color: '#94a3b8' },
      axisLine: { lineStyle: { color: '#e2e8f0' } },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: '#f1f5f9', type: 'dashed' } },
    },
    yAxis: {
      type: 'value',
      name: '等效冷却缩减 (%)',
      nameLocation: 'center',
      nameGap: 34,
      nameTextStyle: { fontSize: 11, color: '#64748b' },
      min: 0,
      max: 85,
      interval: 20,
      axisLabel: {
        fontSize: 10,
        color: '#94a3b8',
        formatter: '{value}',
      },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: '#f1f5f9', type: 'dashed' } },
    },
    series: [
      {
        type: 'line',
        data: data,
        smooth: true,
        symbol: 'none',
        lineStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
            { offset: 0, color: '#3b82f6' },
            { offset: 1, color: '#8b5cf6' },
          ]),
          width: 2.5,
        },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(59,130,246,0.12)' },
            { offset: 1, color: 'rgba(139,92,246,0.02)' },
          ]),
        },
        markPoint: {
          data: markPoints,
          symbol: 'pin',
          symbolSize: 36,
          itemStyle: {
            color: '#f59e0b',
            borderColor: '#fff',
            borderWidth: 2,
            shadowBlur: 6,
            shadowColor: 'rgba(0,0,0,0.15)',
          },
          label: {
            show: true,
            fontSize: 9,
            color: '#1e293b',
            fontWeight: 600,
            formatter: '{b}',
          },
        },
      },
    ],
    tooltip: {
      trigger: 'axis',
      formatter: function (params) {
        const p = params[0];
        if (p && p.data) {
          return `技能急速：<b>${p.data[0]}</b><br/>等效冷却缩减：<b>${p.data[1]}%</b>`;
        }
        return '';
      },
      backgroundColor: '#fff',
      borderColor: '#e2e8f0',
      textStyle: { color: '#1e293b', fontSize: 11 },
      extraCssText: 'border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.08);',
    },
  };

  chart.setOption(option);

  // 响应窗口大小变化
  window.addEventListener('resize', () => {
    chart.resize();
  });

  // 面板大小变化时也调整图表（简单用 MutationObserver 监听）
  if (ahChartDom.parentElement) {
    const observer = new ResizeObserver(() => {
      chart.resize();
    });
    observer.observe(ahChartDom.parentElement);
  }
}
async function init() {
  // 显示应用版本
  try {
    const v = await window.electronAPI.getAppVersion();
    if (v && appVersionTag) appVersionTag.textContent = 'v' + v;
  } catch (_) {}

  // 设置
  currentSettings = await window.electronAPI.getSettings();
  heroPriority = [...(currentSettings.heroPriority || [])];

  if (currentSettings.autoAccept) setSwitchActive(autoAcceptBtn, true);
  if (currentSettings.aramPick) setSwitchActive(aramPickBtn, true);

  // 英雄数据
  allChampions = await window.electronAPI.getChampions();

  // 状态
  try {
    const status = await window.electronAPI.getStatus();
    updateConnectionStatus(status.connected);
    updateGamePhase(status.phase);
  } catch (_) {}

  // 渲染
  renderSelectedHeroes();
  await updateDataVersion();

  // 预设
  try {
    const res = await window.electronAPI.getPresets();
    presetsList = res.presets || [];
    const sel = res.selectedPreset || (presetsList[0] && presetsList[0].id) || '';
    renderPresetOptions();
    if (sel) {
      presetManageSelect.value = sel;
      const cur = presetsList.find(p => p.id === sel);
      if (cur) {
        presetNameInput.value = cur.name || '';
        heroPriority = [...(cur.heroPriority || [])];
        currentPresetId = cur.id;
        renderSelectedHeroes();
      }
    } else if (presetsList[0]) {
      presetManageSelect.value = presetsList[0].id;
      presetNameInput.value = presetsList[0].name || '';
      heroPriority = [...(presetsList[0].heroPriority || [])];
      currentPresetId = presetsList[0].id;
      renderSelectedHeroes();
    }
    updatePresetButtonsState();
  } catch (_) {}

  // 日志
  try {
    const logs = await window.electronAPI.getLogs();
    renderLogs(logs);
  } catch (_) {}

  // 技能急速换算图表
  initAhChart();

  // ===== 事件监听 =====
  window.electronAPI.onStatusUpdate((data) => {
    updateConnectionStatus(data.connected);
    updateGamePhase(data.phase);
  });

  window.electronAPI.onNewLog((log) => {
    addLogEntry(log);
  });

  // 选角仪表盘事件
  if (window.electronAPI.onPickUpdate) {
    window.electronAPI.onPickUpdate((data) => {
      updatePickDashboard(data);
    });
  }

  // 自动选择开关同步（主进程手动交换后关闭 / 对局结束自动恢复）
  if (window.electronAPI.onAutoPickChanged) {
    window.electronAPI.onAutoPickChanged((enabled) => {
      currentSettings.aramPick = enabled; // ★ 同步内存状态，防止 currentSettings 与实际不一致
      if (enabled) {
        setSwitchActive(aramPickBtn, true);
      } else {
        setSwitchActive(aramPickBtn, false);
      }
    });
  }

  // 预设广播
  if (window.electronAPI.onPresetsUpdated) {
    window.electronAPI.onPresetsUpdated((data) => {
      try {
        presetsList = data.presets || [];
        const sel = data.selectedPreset || (presetsList[0] && presetsList[0].id) || '';
        renderPresetOptions();
        if (sel) presetManageSelect.value = sel;
        updatePresetButtonsState();
      } catch (_) {}
    });
  }

  // 窗口按钮
  minimizeBtn.addEventListener('click', () => window.electronAPI.minimize());
  closeBtn.addEventListener('click', () => window.electronAPI.close());

  // 预设切换
  presetManageSelect.addEventListener('change', async () => {
    const id = presetManageSelect.value;
    if (!id) return;
    isCreatingPreset = false;
    currentPresetId = id;
    const p = presetsList.find(x => x.id === id);
    if (p) {
      presetNameInput.value = p.name || '';
      heroPriority = [...(p.heroPriority || [])];
      renderSelectedHeroes();
    }
    await syncPresetToMain(id);
    updatePresetButtonsState();
  });

  // 新建预设
  addPresetBtn.addEventListener('click', () => {
    isCreatingPreset = true;
    currentPresetId = null;
    presetNameInput.value = '';
    heroPriority = [];
    renderSelectedHeroes();
    presetManageSelect.selectedIndex = -1;
    updatePresetButtonsState();
  });

  // 保存预设
  savePresetBtn.addEventListener('click', async () => {
    const name = presetNameInput.value.trim() || ('预设 ' + new Date().toLocaleString());
    if (isCreatingPreset || !currentPresetId) {
      const id = 'preset_' + Date.now();
      presetsList.push({ id, name, heroPriority: [...heroPriority] });
      await window.electronAPI.savePresets(presetsList);
      await syncPresetToMain(id);
      isCreatingPreset = false;
      currentPresetId = id;
    } else {
      const idx = presetsList.findIndex(p => p.id === currentPresetId);
      if (idx !== -1) {
        presetsList[idx].heroPriority = [...heroPriority];
        presetsList[idx].name = name;
        await window.electronAPI.savePresets(presetsList);
        await syncPresetToMain(currentPresetId);
      }
    }
    const res = await window.electronAPI.getPresets();
    presetsList = res.presets || [];
    renderPresetOptions();
    if (currentPresetId) presetManageSelect.value = currentPresetId;
    updatePresetButtonsState();
  });

  // 删除预设
  delPresetBtn.addEventListener('click', async () => {
    const id = presetManageSelect.value || currentPresetId;
    if (!id || presetsList.length <= 1) return;
    if (!confirm('确认删除当前预设？此操作不可撤销。')) return;
    presetsList = presetsList.filter(p => p.id !== id);
    await window.electronAPI.savePresets(presetsList);
    const res = await window.electronAPI.getPresets();
    presetsList = res.presets || [];
    if (presetsList[0]) {
      await syncPresetToMain(presetsList[0].id);
      currentPresetId = presetsList[0].id;
      presetNameInput.value = presetsList[0].name || '';
      heroPriority = [...(presetsList[0].heroPriority || [])];
      renderSelectedHeroes();
    }
    renderPresetOptions();
    updatePresetButtonsState();
  });

  // 搜索
  heroSearch.addEventListener('input', (e) => searchHeroes(e.target.value));
  heroSearch.addEventListener('focus', () => {
    if (heroSearch.value.trim()) searchHeroes(heroSearch.value);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-box')) heroDropdown.classList.remove('show');
  });

  // 刷新数据（标题栏按钮）
  refreshBtnTop.addEventListener('click', async () => {
    refreshBtnTop.style.pointerEvents = 'none';
    refreshBtnTop.style.opacity = '0.5';
    refreshBtnTop.style.animation = 'spin 0.8s linear infinite';
    try {
      const result = await window.electronAPI.refreshChampions();
      if (result.success) {
        allChampions = await window.electronAPI.getChampions();
        renderSelectedHeroes();
        updateDataVersion();
      }
    } catch (_) {}
    refreshBtnTop.style.animation = '';
    refreshBtnTop.style.opacity = '';
    refreshBtnTop.style.pointerEvents = '';
  });
}

init();

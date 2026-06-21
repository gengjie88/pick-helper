// 主页面渲染进程

// 游戏阶段中文映射
const phaseMap = {
  'None': '无',
  'Lobby': '大厅',
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

// DOM 元素
const connectionStatusEl = document.getElementById('connectionStatus');
const gamePhaseEl = document.getElementById('gamePhase');
const heroListEl = document.getElementById('heroList');
const updateTimeEl = document.getElementById('updateTime');
const presetSelectEl = document.getElementById('presetSelect');
const settingsBtn = document.getElementById('settingsBtn');
const minimizeBtn = document.getElementById('minimizeBtn');
const closeBtn = document.getElementById('closeBtn');

// 更新连接状态
function updateConnectionStatus(connected) {
  if (connected) {
    connectionStatusEl.className = 'status-value connected';
    connectionStatusEl.innerHTML = '<span class="status-dot connected"></span>已连接';
  } else {
    connectionStatusEl.className = 'status-value disconnected';
    connectionStatusEl.innerHTML = '<span class="status-dot disconnected"></span>未连接';
  }
}

// 更新游戏阶段
function updateGamePhase(phase) {
  if (phase && phaseMap[phase]) {
    gamePhaseEl.textContent = phaseMap[phase];
  } else if (phase) {
    gamePhaseEl.textContent = phase;
  } else {
    gamePhaseEl.textContent = '-';
  }
}

// 渲染英雄列表
async function renderHeroList() {
  try {
    const [settings, champions] = await Promise.all([
      window.electronAPI.getSettings(),
      window.electronAPI.getChampions()
    ]);

    const heroIds = settings.heroPriority || [];

    if (heroIds.length === 0) {
      heroListEl.innerHTML = '<div class="empty-state">暂无预选英雄<br>请到设置中添加</div>';
      return;
    }

    let html = '';
    heroIds.forEach((id, index) => {
      const champ = champions[id];
      if (champ) {
        html += `
          <div class="hero-item">
            <div class="hero-rank">${index + 1}</div>
            <img class="hero-avatar" src="${champ.image}" alt="${champ.name}" onerror="this.style.background='#e2e8f0';this.src=''">
            <div class="hero-info">
              <div class="hero-name">${champ.name}</div>
              <div class="hero-title">${champ.title || ''}</div>
            </div>
          </div>
        `;
      } else {
        html += `
          <div class="hero-item">
            <div class="hero-rank">${index + 1}</div>
            <div class="hero-avatar" style="background:#e2e8f0;display:flex;align-items:center;justify-content:center;font-size:10px;color:#94a3b8;">ID:${id}</div>
            <div class="hero-info">
              <div class="hero-name">未知英雄</div>
              <div class="hero-title">ID: ${id}</div>
            </div>
          </div>
        `;
      }
    });

    heroListEl.innerHTML = html;
  } catch (e) {
    heroListEl.innerHTML = '<div class="empty-state">加载失败</div>';
    console.error('渲染英雄列表失败:', e);
  }
}

// 预设相关
async function loadPresets() {
  try {
    const res = await window.electronAPI.getPresets();
    const presets = res.presets || [];
    const selectedPreset = res.selectedPreset || (presets[0] && presets[0].id) || '';
    presetSelectEl.innerHTML = '';
    presets.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name || p.id;
      presetSelectEl.appendChild(opt);
    });
    if (selectedPreset) presetSelectEl.value = selectedPreset;
    presetSelectEl.addEventListener('change', async () => {
      const id = presetSelectEl.value;
      await window.electronAPI.setSelectedPreset(id);
      // 重新渲染 hero 列表（从设置读取）
      await renderHeroList();
    });
  } catch (e) {
    console.error('加载预设失败', e);
  }
}

// 更新数据更新时间
async function updateUpdateTime() {
  try {
    const status = await window.electronAPI.getStatus();
    if (status.lastUpdate) {
      const date = new Date(status.lastUpdate);
      const formatted = `${date.getMonth() + 1}月${date.getDate()}日`;
      updateTimeEl.textContent = `数据更新: ${formatted} · v${status.championVersion || '-'}`;
    } else {
      updateTimeEl.textContent = '数据更新: -';
    }
  } catch (e) {
    console.error('获取更新时间失败:', e);
  }
}

// 初始化
async function init() {
  // 获取初始状态
  try {
    const status = await window.electronAPI.getStatus();
    updateConnectionStatus(status.connected);
    updateGamePhase(status.phase);
  } catch (e) {
    console.error('获取状态失败:', e);
  }

  // 渲染英雄列表
  await renderHeroList();
  // 载入预设
  if (presetSelectEl) await loadPresets();
  await updateUpdateTime();

  // 监听状态更新
  window.electronAPI.onStatusUpdate((data) => {
    updateConnectionStatus(data.connected);
    updateGamePhase(data.phase);
  });

  // 按钮事件
  settingsBtn.addEventListener('click', () => {
    window.electronAPI.navigate('settings');
  });

  minimizeBtn.addEventListener('click', () => {
    window.electronAPI.minimize();
  });

  closeBtn.addEventListener('click', () => {
    window.electronAPI.close();
  });

  // 选角/自动选中提示已移除（恢复为不显示模态框的默认行为）

  // 监听预设更新，及时刷新下拉与首页列表
  if (window.electronAPI.onPresetsUpdated) {
    window.electronAPI.onPresetsUpdated(async (data) => {
      try {
        // 重新加载 presets 到下拉
        const res = await window.electronAPI.getPresets();
        const presets = res.presets || [];
        const selectedPreset = res.selectedPreset || (presets[0] && presets[0].id) || '';
        presetSelectEl.innerHTML = '';
        presets.forEach(p => {
          const opt = document.createElement('option');
          opt.value = p.id; opt.textContent = p.name || p.id;
          presetSelectEl.appendChild(opt);
        });
        if (selectedPreset) presetSelectEl.value = selectedPreset;
        // 重新渲染英雄列表以使用最新 settings
        await renderHeroList();
      } catch (e) {}
    });
  }

  // 选角提示模态已移除
}

init();

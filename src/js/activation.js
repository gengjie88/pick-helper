// 激活页面逻辑
let currentMachineCode = '';

// 页面加载时获取机器码
window.addEventListener('DOMContentLoaded', async () => {
  // 显示版本号
  try {
    const version = await window.electronAPI.getAppVersion();
    if (version) {
      document.getElementById('versionBadge').textContent = 'v' + version;
    }
  } catch (e) {}

  try {
    currentMachineCode = await window.electronAPI.getMachineCode();
    document.getElementById('machineCode').textContent = currentMachineCode || '获取失败';
  } catch (e) {
    document.getElementById('machineCode').textContent = '获取失败';
    showAlert('无法获取机器码，请重启软件重试', 'error');
  }

  // 回车键激活
  document.getElementById('licenseKey').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') activate();
  });
});

// 复制机器码
function copyMachineCode() {
  const code = document.getElementById('machineCode').textContent;
  if (!code || code === '加载中...' || code === '获取失败') return;

  navigator.clipboard.writeText(code).then(() => {
    const btn = document.getElementById('btnCopy');
    btn.textContent = '已复制 ✓';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = '复制';
      btn.classList.remove('copied');
    }, 2000);
  }).catch(() => {
    showAlert('复制失败，请手动选中机器码复制', 'error');
  });
}

// 激活
async function activate() {
  const licenseKey = document.getElementById('licenseKey').value.trim();
  if (!licenseKey) {
    showAlert('请输入许可证密钥', 'error');
    return;
  }

  const btn = document.getElementById('btnActivate');
  btn.disabled = true;
  btn.textContent = '验证中...';

  try {
    const result = await window.electronAPI.activateLicense(licenseKey);
    if (result.valid) {
      showAlert('✅ 激活成功！软件即将启动...', 'success');
      setTimeout(() => {
        window.electronAPI.activationComplete();
      }, 1500);
    } else {
      showAlert('❌ ' + (result.message || '激活失败'), 'error');
    }
  } catch (e) {
    showAlert('❌ 激活验证失败，请检查密钥是否正确', 'error');
  }

  btn.disabled = false;
  btn.textContent = '激活软件';
}

// 显示提示信息
function showAlert(message, type) {
  const alert = document.getElementById('alert');
  alert.textContent = message;
  alert.className = 'alert show alert-' + type;
}

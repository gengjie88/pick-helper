const crypto = require('crypto');
const os = require('os');
const { execSync } = require('child_process');

// ========== 密钥配置（发布时请修改此密钥） ==========
const SECRET_KEY = crypto.createHash('sha256').update('PickHelper-2024-Secret-Key-@#!gengjie').digest();
const IV = Buffer.from('PH-IV-16bytesKEY', 'utf8'); // 正好 16 字节 IV

// ========== 机器指纹生成 ==========
function getMachineFingerprint() {
  const parts = [
    os.hostname(),
    os.userInfo().username,
    os.platform(),
    os.arch(),
    os.cpus()[0]?.model || '',
    os.totalmem().toString(),
  ];

  // Windows: 尝试获取主板序列号和卷序列号
  if (process.platform === 'win32') {
    try {
      const diskSerial = execSync('wmic diskdrive get serialnumber', { encoding: 'utf8', timeout: 5000 });
      parts.push(diskSerial.replace(/\s/g, '').replace('SerialNumber', ''));
    } catch (_) {}
    try {
      const biosSerial = execSync('wmic bios get serialnumber', { encoding: 'utf8', timeout: 5000 });
      parts.push(biosSerial.replace(/\s/g, '').replace('SerialNumber', ''));
    } catch (_) {}
    try {
      const macAddresses = [];
      const nets = os.networkInterfaces();
      for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
          if (net.mac && net.mac !== '00:00:00:00:00:00') {
            macAddresses.push(net.mac);
          }
        }
      }
      parts.push(macAddresses.sort().join(','));
    } catch (_) {}
  }

  const raw = parts.join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').substring(0, 16);
}

// ========== AES 解密（仅运行时校验需要） ==========

function decrypt(encrypted) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-cbc', SECRET_KEY, IV);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (_) {
    return null;
  }
}

// ========== 许可证密钥校验 ==========

/**
 * 校验许可证密钥
 * @param {string} licenseKey - 用户输入的许可证密钥
 * @returns {{ valid: boolean, message: string, machineCode: string }}
 */
function validateLicenseKey(licenseKey) {
  if (!licenseKey || typeof licenseKey !== 'string') {
    return { valid: false, message: '许可证密钥不能为空' };
  }

  // 去掉分隔符
  const hex = licenseKey.replace(/-/g, '').toLowerCase();

  if (hex.length < 32) {
    return { valid: false, message: '许可证密钥格式不正确' };
  }

  const decrypted = decrypt(hex);
  if (!decrypted) {
    return { valid: false, message: '许可证密钥无效' };
  }

  let payload;
  try {
    payload = JSON.parse(decrypted);
  } catch (_) {
    return { valid: false, message: '许可证密钥已损坏' };
  }

  if (!payload.mc) {
    return { valid: false, message: '许可证密钥无效' };
  }

  // 校验机器码
  const currentMachineCode = getMachineFingerprint();
  if (payload.mc !== currentMachineCode) {
    return {
      valid: false,
      message: '许可证与当前设备不匹配',
      machineCode: currentMachineCode,
    };
  }

  // 校验过期时间
  if (payload.exp && payload.exp !== 'permanent') {
    const expiryDate = new Date(payload.exp);
    if (isNaN(expiryDate.getTime()) || expiryDate < new Date()) {
      return {
        valid: false,
        message: `许可证已过期 (${payload.exp})`,
        machineCode: currentMachineCode,
      };
    }
  }

  return {
    valid: true,
    message: '许可证验证成功',
    machineCode: currentMachineCode,
    expiry: payload.exp,
  };
}

module.exports = {
  getMachineFingerprint,
  validateLicenseKey,
};

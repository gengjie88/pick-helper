/**
 * 代码混淆构建脚本
 * 
 * 功能：
 * 1. 混淆 main.js 和 preload.js 到 dist-obfuscated/
 * 2. 混淆 src/js/ 下的渲染进程 JS 文件
 * 3. 复制其他资源文件
 * 4. 替换原始文件为混淆版本
 * 
 * 在 npm run pack / npm run dist 前自动执行
 */

const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = path.join(__dirname, '..');

// 混淆选项
const obfuscatorOptions = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.4,
  debugProtection: false,
  debugProtectionInterval: 0,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal',
  log: false,
  numbersToExpressions: true,
  renameGlobals: false,
  selfDefending: true,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 10,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayEncoding: ['base64'],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersChainedCalls: true,
  stringArrayWrappersType: 'function',
  stringArrayThreshold: 0.75,
  transformObjectKeys: true,
  unicodeEscapeSequence: false,
};

// 需要混淆的文件
const filesToObfuscate = [
  'main.js',
  'preload.js',
  'src/license.js',
  'src/js/renderer.js',
  'src/js/settings.js',
  'src/js/activation.js',
];

// 备份目录
const BACKUP_DIR = path.join(ROOT, '.backup-obfuscated');

console.log('');
console.log('═══════════════════════════════════════');
console.log('   🔒 PickHelper 代码混淆工具');
console.log('═══════════════════════════════════════');
console.log('');

// 创建备份目录
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// 备份并混淆文件
for (const filePath of filesToObfuscate) {
  const fullPath = path.join(ROOT, filePath);
  
  if (!fs.existsSync(fullPath)) {
    console.log(`  ⚠ 跳过（不存在）: ${filePath}`);
    continue;
  }

  const originalCode = fs.readFileSync(fullPath, 'utf8');
  
  // 备份原始文件
  const backupPath = path.join(BACKUP_DIR, path.basename(filePath));
  fs.writeFileSync(backupPath, originalCode, 'utf8');

  try {
    const result = JavaScriptObfuscator.obfuscate(originalCode, obfuscatorOptions);
    const obfuscatedCode = result.getObfuscatedCode();
    
    fs.writeFileSync(fullPath, obfuscatedCode, 'utf8');
    console.log(`  ✓ 已混淆: ${filePath}`);
  } catch (err) {
    console.error(`  ✗ 混淆失败: ${filePath} - ${err.message}`);
  }
}

console.log('');
console.log('═══════════════════════════════════════');
console.log('   混淆完成！备份文件保存在:');
console.log(`   ${BACKUP_DIR}`);
console.log('');
console.log('   运行 npx electron-forge make 打包');
console.log('═══════════════════════════════════════');
console.log('');

// 生成还原脚本
const restoreScript = `
@echo off
echo 正在还原源文件...
${filesToObfuscate.map(f => {
  const bn = path.basename(f);
  const originalDir = path.dirname(f);
  const targetPath = originalDir === '.' ? bn : `${originalDir}\\${bn}`;
  return `copy /Y ".backup-obfuscated\\${bn}" "${targetPath}"`;
}).join('\n')}
echo 还原完成！
pause
`;

fs.writeFileSync(path.join(ROOT, 'restore-sources.bat'), restoreScript, 'utf8');
console.log('  已生成还原脚本: restore-sources.bat');

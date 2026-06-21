// 图标生成脚本：使用 Electron 渲染 SVG 并保存为 PNG
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(async () => {
  const svgPath = path.join(__dirname, '..', 'assets', 'icon.svg');
  const pngPath = path.join(__dirname, '..', 'assets', 'icon.png');

  const svgContent = fs.readFileSync(svgPath, 'utf-8');

  const html = `<!DOCTYPE html><html><head><style>
    html,body{width:512px;height:512px;margin:0;padding:0;overflow:hidden}
    img{width:512px;height:512px}
  </style></head><body>
    <img src="data:image/svg+xml,${encodeURIComponent(svgContent)}" width="512" height="512">
  </body></html>`;

  const win = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    frame: false,
    webPreferences: { 
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  // 等待渲染完成
  await new Promise(r => setTimeout(r, 1000));

  const image = await win.webContents.capturePage();
  const pngBuffer = image.toPNG();

  fs.writeFileSync(pngPath, pngBuffer);
  console.log(`✅ 图标已生成: ${pngPath} (${pngBuffer.length} bytes)`);

  win.close();
  app.quit();
});

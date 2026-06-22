// 图标生成脚本：使用 Electron 渲染 SVG 并保存为 PNG + ICO
const { app, BrowserWindow, nativeImage } = require("electron");
const fs = require("fs");
const path = require("path");

function writeICO(pngs, icoPath) {
  const count = pngs.length;
  const headerSize = 6;
  const entrySize = 16;
  const dirSize = headerSize + count * entrySize;
  const offsets = [];
  let offset = dirSize;
  for (const p of pngs) { offsets.push(offset); offset += p.buf.length; }
  const fd = fs.openSync(icoPath, "w");
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(count, 4);
  fs.writeSync(fd, header);
  for (let i = 0; i < count; i++) {
    const p = pngs[i];
    const entry = Buffer.alloc(entrySize);
    const v = p.size >= 256 ? 0 : p.size;
    entry.writeUInt8(v, 0); entry.writeUInt8(v, 1); entry.writeUInt8(0, 2); entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(p.buf.length, 8); entry.writeUInt32LE(offsets[i], 12);
    fs.writeSync(fd, entry);
  }
  for (const p of pngs) { fs.writeSync(fd, p.buf); }
  fs.closeSync(fd);
}

async function renderIcon(size) {
  const svgPath = path.join(__dirname, "..", "assets", "icon.svg");
  const svgContent = fs.readFileSync(svgPath, "utf-8");
  const html = "<!DOCTYPE html><html><head><style>html,body{width:" + size + "px;height:" + size + "px;margin:0;padding:0;overflow:hidden;background:transparent}img{width:" + size + "px;height:" + size + "px}</style></head><body><img src=\"data:image/svg+xml," + encodeURIComponent(svgContent) + "\" width=\"" + size + "\" height=\"" + size + "\"></body></html>";
  const win = new BrowserWindow({ width: size, height: size, show: false, frame: false, transparent: true, webPreferences: { nodeIntegration: false, contextIsolation: true } });
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  await new Promise(r => setTimeout(r, 800));
  const image = await win.webContents.capturePage();
  const buf = image.toPNG();
  win.close();
  return buf;
}

app.whenReady().then(async () => {
  const assetsDir = path.join(__dirname, "..", "assets");
  const pngPath = path.join(assetsDir, "icon.png");
  const icoPath = path.join(assetsDir, "icon.ico");
  console.log(""); console.log("🎨 正在生成图标...");
  const png512 = await renderIcon(512);
  fs.writeFileSync(pngPath, png512);
  console.log("  ✅ icon.png (512x512, " + png512.length + " bytes)");
  const sizes = [16, 32, 48, 256];
  const pngs = [];
  for (const s of sizes) {
    const buf = await renderIcon(s);
    pngs.push({ size: s, buf });
    console.log("  ✅ ico 内含: " + s + "x" + s + " (" + buf.length + " bytes)");
  }
  writeICO(pngs, icoPath);
  console.log("  ✅ icon.ico (" + fs.statSync(icoPath).size + " bytes)");
  console.log(""); app.quit();
});

const { app, BrowserWindow, ipcMain } = require('electron')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
app.setPath('userData', path.join(app.getAppPath(), 'fixture-user-data'))
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
let server, window
const fixture = `<!doctype html><meta charset="utf-8"><style>html,body{background:white;color:#111;font:16px sans-serif}table{border-collapse:collapse;margin-top:20px}td,th{border:1px solid #ccc;padding:6px}output{display:block;margin-top:16px}</style><h1>Browser fixture</h1>
<form id="form"><label>Name <input id="name" value="old"></label><input type="password" value="private-fixture-sentinel">
<button id="save">Save</button></form><output id="result">Waiting</output>
<table><tr><th>Item</th><th>Count</th></tr><tr><td>Demo</td><td>2</td></tr></table>
<script>window.events=[];nameInput=document.getElementById('name');nameInput.addEventListener('input',e=>events.push({type:'input',trusted:e.isTrusted}));
document.getElementById('save').addEventListener('click',e=>{events.push({type:'click',trusted:e.isTrusted});document.getElementById('result').textContent='Saved '+nameInput.value});
document.addEventListener('keydown',e=>events.push({type:'keydown',key:e.key,trusted:e.isTrusted}));
document.getElementById('form').addEventListener('submit',e=>{e.preventDefault();document.getElementById('result').textContent='Saved '+nameInput.value})</script>`
const done = report => {
  if (report.screenshotPng) {
    fs.writeFileSync(path.join(path.dirname(process.env.DSH_SIDEBROWSER_REPORT), 'fixture.png'), Buffer.from(report.screenshotPng, 'base64'))
    delete report.screenshotPng
  }
  fs.writeFileSync(process.env.DSH_SIDEBROWSER_REPORT, JSON.stringify({ ...report, electron: process.versions.electron }, null, 2))
  if (window && !window.isDestroyed()) window.destroy()
  server?.close(); app.exit(report.success ? 0 : 1)
}
ipcMain.on('fixture-done', (_event, report) => done(report))
ipcMain.handle('fixture-host-capture', async (_event, { name, width }) => {
  if (!['wide','wide-low','narrow','error'].includes(name)) throw new Error('Invalid fixture capture')
  const image = await window.webContents.capturePage({ x: 0, y: 0, width, height: 640 })
  const file = path.join(path.dirname(process.env.DSH_SIDEBROWSER_REPORT), `feedback-${name}.png`)
  fs.writeFileSync(file, image.toPNG())
  return { file, size: image.getSize() }
})
app.whenReady().then(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/asset.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); res.end('window.externalDiagnostic=17;\n//# sourceMappingURL=/asset.js.map'); return }
    if (req.url === '/asset.js.map') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"version":3,"sources":["original.ts"],"mappings":""}'); return }
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write('data: sse-default-fixture\n\nevent: detail\ndata: sse-named-fixture\n\n'); return
    }
    if (req.url === '/beacon') { req.resume(); res.writeHead(204); res.end(); return }
    if (req.url.startsWith('/api')) {
      res.writeHead(req.url.includes('error') ? 503 : 200, { 'content-type': 'application/json', 'x-debug-fixture': 'yes' })
      res.end(req.url.includes('large') ? JSON.stringify({ text: 'x'.repeat(40000) }) : JSON.stringify({ ok: true, method: req.method })); return
    }
    if (req.url.startsWith('/offline')) { req.socket.destroy(); return }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(fixture)
  })
  server.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
    let buffered = Buffer.alloc(0)
    socket.on('error', () => {})
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk])
      while (buffered.length >= 6) {
        const op = buffered[0] & 15, length = buffered[1] & 127
        if (length >= 126) { socket.destroy(); return }
        if (buffered.length < 6 + length) return
        const payload = Buffer.alloc(length)
        for (let i = 0; i < length; i++) payload[i] = buffered[6 + i] ^ buffered[2 + i % 4]
        buffered = buffered.subarray(6 + length)
        if (op === 8) { socket.end(Buffer.concat([Buffer.from([0x88, length]), payload])); return }
        if (op === 1) socket.write(Buffer.concat([Buffer.from([0x81, length]), payload]))
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  process.env.DSH_SIDEBROWSER_FIXTURE_URL = 'http://127.0.0.1:' + server.address().port + '/'
  window = new BrowserWindow({ show: false, width: 840, height: 680, webPreferences: { nodeIntegration: true, contextIsolation: false, webviewTag: true, sandbox: false, backgroundThrottling: false } })
  window.webContents.on('will-attach-webview', (_event, prefs) => Object.assign(prefs, { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: false }))
  window.webContents.on('did-attach-webview', (_event, guest) => guest.setBackgroundThrottling(false))
  await window.loadFile(path.join(__dirname, 'index.html'))
}).catch(error => done({ success: false, error: error.stack }))
setTimeout(() => done({ success: false, error: 'Fixture main watchdog expired' }), 35000).unref()

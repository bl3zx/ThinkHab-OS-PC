const { app, BrowserWindow, ipcMain, shell, Menu, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');

// звук загрузки должен играть сразу, без нажатия
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
const CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;

function createWindow() {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    fullscreen: true,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    show: false,
    title: 'ThinkHab',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: false
    }
  });
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  win.once('ready-to-show', () => win.show());
  // при возврате в лаунчер (например, из игры) обновляем библиотеку
  win.on('focus', () => {
    win.webContents.executeJavaScript('window.onResume&&window.onResume()').catch(() => {});
  });
  // F11 — переключить полный экран
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      e.preventDefault();
    }
  });
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((wc, p, cb) => cb(false));
  const bs = session.fromPartition('persist:browser');
  bs.setUserAgent(CHROME_UA);
  bs.setPermissionRequestHandler((wc, p, cb) => cb(['fullscreen', 'clipboard-sanitized-write'].includes(p)));
  loadModel();
  createWindow();
});

// ссылки, которые сайт пытается открыть в новом окне, открываем во встроенном браузере
app.on('web-contents-created', (e, contents) => {
  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(({ url }) => {
      if (win) win.webContents.send('brw:open', url);
      return { action: 'deny' };
    });
  }
});

app.on('window-all-closed', () => app.quit());

/* ================= Steam ================= */

const SKIP = new Set(['228980', '1007']); // служебные компоненты Steam, не игры

// разбор файлов Valve (.vdf / .acf)
function parseVdf(text) {
  const re = /"((?:[^"\\]|\\.)*)"|(\{)|(\})/g;
  const toks = [];
  let m;
  while ((m = re.exec(text))) {
    if (m[2]) toks.push({ o: 1 });
    else if (m[3]) toks.push({ c: 1 });
    else toks.push({ s: m[1].replace(/\\(.)/g, '$1') });
  }
  let i = 0;
  function obj() {
    const o = {};
    while (i < toks.length) {
      const k = toks[i];
      if (k.c) { i++; return o; }
      const key = k.s;
      i++;
      const v = toks[i];
      if (v && v.o) { i++; o[key] = obj(); }
      else { o[key] = v ? v.s : ''; i++; }
    }
    return o;
  }
  return obj();
}

function steamPath() {
  const queries = [
    ['HKCU\\Software\\Valve\\Steam', 'SteamPath'],
    ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath']
  ];
  for (const [key, name] of queries) {
    try {
      const out = cp.execFileSync('reg', ['query', key, '/v', name], { encoding: 'utf8', windowsHide: true });
      const m = out.match(/REG_SZ\s+(.+)/);
      if (m) {
        const p = m[1].trim().replace(/\//g, '\\');
        if (fs.existsSync(p)) return p;
      }
    } catch (e) { /* пробуем дальше */ }
  }
  for (const p of ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function libraries(sp) {
  const libs = new Set([sp]);
  try {
    const v = parseVdf(fs.readFileSync(path.join(sp, 'steamapps', 'libraryfolders.vdf'), 'utf8'));
    const root = v.libraryfolders || v.LibraryFolders || {};
    for (const k of Object.keys(root)) {
      const e = root[k];
      if (e && typeof e === 'object' && e.path) libs.add(e.path);
      else if (typeof e === 'string' && /^[A-Za-z]:/.test(e)) libs.add(e);
    }
  } catch (e) { /* файл может отсутствовать */ }
  return [...libs].filter((p) => { try { return fs.existsSync(path.join(p, 'steamapps')); } catch (e) { return false; } });
}

// игры, установленные на этом ПК: манифест appmanifest_ID.acf + папка игры
function installedGames() {
  const sp = steamPath();
  if (!sp) return { sp: null, games: [] };
  const out = new Map();
  for (const lib of libraries(sp)) {
    const dir = path.join(lib, 'steamapps');
    let files = [];
    try { files = fs.readdirSync(dir); } catch (e) { /* пропуск */ }
    for (const f of files) {
      const m = f.match(/^appmanifest_(\d+)\.acf$/);
      if (!m || SKIP.has(m[1])) continue;
      try {
        const a = parseVdf(fs.readFileSync(path.join(dir, f), 'utf8')).AppState || {};
        const folder = a.installdir ? path.join(dir, 'common', a.installdir) : null;
        const ok = !!folder && fs.existsSync(folder) && ((parseInt(a.StateFlags || '0', 10) & 4) === 4);
        out.set(m[1], { id: m[1], name: a.name || ('App ' + m[1]), installed: ok });
      } catch (e) { /* битый манифест */ }
    }
  }
  return { sp, games: [...out.values()] };
}

// аккаунты, которые входили в Steam на этом ПК
function steamAccounts() {
  const sp = steamPath();
  if (!sp) return { sp: null, accounts: [] };
  try {
    const users = parseVdf(fs.readFileSync(path.join(sp, 'config', 'loginusers.vdf'), 'utf8')).users || {};
    const accounts = Object.keys(users).map((id) => ({
      id,
      name: users[id].PersonaName || users[id].AccountName || id,
      recent: users[id].MostRecent === '1'
    }));
    accounts.sort((a, b) => Number(b.recent) - Number(a.recent));
    return { sp, accounts };
  } catch (e) {
    return { sp, accounts: [] };
  }
}

const CFG = () => path.join(app.getPath('userData'), 'steam.json');
function loadCfg() { try { return JSON.parse(fs.readFileSync(CFG(), 'utf8')) || {}; } catch (e) { return {}; } }
function saveCfg(c) { try { fs.mkdirSync(path.dirname(CFG()), { recursive: true }); fs.writeFileSync(CFG(), JSON.stringify(c)); } catch (e) { /* ignore */ } }

const decodeXml = (t) => String(t || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const cdata = (t) => decodeXml(String(t || '').replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '')).trim();

// список всех игр аккаунта
async function fetchOwned(cfg) {
  if (cfg.key) {
    const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(cfg.key)}&steamid=${cfg.id}&include_appinfo=1&include_played_free_games=1&format=json`;
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('net');
    const j = await r.json();
    const g = (j.response && j.response.games) || [];
    if (!g.length) throw new Error('private');
    return g.map((x) => ({ id: String(x.appid), name: x.name || ('App ' + x.appid), h: Math.round((x.playtime_forever || 0) / 6) / 10 }));
  }
  const r = await fetch(`https://steamcommunity.com/profiles/${cfg.id}/games?tab=all&xml=1`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('net');
  const t = await r.text();
  const games = [];
  const re = /<game>([\s\S]*?)<\/game>/g;
  let m;
  while ((m = re.exec(t))) {
    const b = m[1];
    const id = (b.match(/<appID>(\d+)<\/appID>/) || [])[1];
    const nm = (b.match(/<name>([\s\S]*?)<\/name>/) || [])[1];
    const h = (b.match(/<hoursOnRecord>([\d.,]+)<\/hoursOnRecord>/) || [])[1];
    if (id) games.push({ id, name: cdata(nm) || ('App ' + id), h: h ? parseFloat(h.replace(/,/g, '')) : 0 });
  }
  if (!games.length) throw new Error('private');
  return games;
}

async function steamSync(force) {
  const cfg = loadCfg();
  const inst = installedGames();
  let owned = cfg.owned || [];
  let err = null;
  if (cfg.id && (force || !cfg.t || Date.now() - cfg.t > 600000)) {
    try {
      owned = await fetchOwned(cfg);
      cfg.owned = owned;
      cfg.t = Date.now();
      saveCfg(cfg);
    } catch (e) {
      err = e.message === 'private' ? 'private' : 'net';
    }
  }
  const map = new Map();
  owned.forEach((o) => map.set(o.id, { id: o.id, name: o.name, h: o.h || 0, installed: false }));
  if (cfg.id) {
    // установленные игры показываем всегда (даже если профиль закрыт)
    inst.games.forEach((g) => {
      const e = map.get(g.id);
      if (e) e.installed = g.installed;
      else map.set(g.id, { id: g.id, name: g.name, h: 0, installed: g.installed });
    });
  }
  const games = [...map.values()].sort((a, b) => (Number(b.installed) - Number(a.installed)) || (b.h - a.h) || a.name.localeCompare(b.name));
  return { linked: !!cfg.id, id: cfg.id || '', name: cfg.name || '', steamFound: !!inst.sp, err, games };
}

async function resolveSteam(text) {
  const t = String(text || '').trim();
  let m = t.match(/(7656119\d{10})/);
  if (m) return { id: m[1] };
  m = t.match(/steamcommunity\.com\/id\/([^/?#\s]+)/i);
  const vanity = m ? m[1] : (/^[\w-]{2,32}$/.test(t) ? t : null);
  if (!vanity) return { error: 'bad' };
  try {
    const r = await fetch(`https://steamcommunity.com/id/${encodeURIComponent(vanity)}?xml=1`, { signal: AbortSignal.timeout(15000) });
    const x = await r.text();
    const id = (x.match(/<steamID64>(\d+)<\/steamID64>/) || [])[1];
    if (!id) return { error: 'notfound' };
    const nm = (x.match(/<steamID>([\s\S]*?)<\/steamID>/) || [])[1];
    return { id, name: cdata(nm) };
  } catch (e) {
    return { error: 'net' };
  }
}

async function profileName(id) {
  try {
    const r = await fetch(`https://steamcommunity.com/profiles/${id}?xml=1`, { signal: AbortSignal.timeout(10000) });
    const x = await r.text();
    return cdata((x.match(/<steamID>([\s\S]*?)<\/steamID>/) || [])[1]);
  } catch (e) {
    return '';
  }
}

ipcMain.handle('steam:accounts', () => steamAccounts());
ipcMain.handle('steam:resolve', (_e, t) => resolveSteam(t));
ipcMain.handle('steam:link', async (_e, o) => {
  const id = String((o && o.id) || '').replace(/\D/g, '');
  if (!id) return steamSync(false);
  const name = (o && o.name) || (await profileName(id)) || id;
  saveCfg({ id, name, key: (o && o.key) || '', owned: [], t: 0 });
  return steamSync(true);
});
ipcMain.handle('steam:unlink', () => { saveCfg({}); return steamSync(false); });
ipcMain.handle('steam:sync', (_e, force) => steamSync(!!force));
// проверка «установлена ли игра на этом ПК» по файлам игры
ipcMain.handle('steam:check', (_e, id) => {
  const g = installedGames().games.find((x) => x.id === String(id));
  return !!(g && g.installed);
});
ipcMain.handle('steam:launch', (_e, id) => shell.openExternal('steam://rungameid/' + String(id).replace(/\D/g, '')));
ipcMain.handle('steam:install', (_e, id) => shell.openExternal('steam://install/' + String(id).replace(/\D/g, '')));

/* ================= Система ================= */

let sysModel = null;
function loadModel() {
  try {
    cp.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$c=Get-CimInstance Win32_ComputerSystem;"$($c.Manufacturer)|$($c.Model)"'],
    { windowsHide: true, timeout: 10000 }, (err, out) => {
      if (!err && out) {
        const [a, b] = out.trim().split('|');
        sysModel = { brand: a || '', model: b || '' };
      }
    });
  } catch (e) { /* ignore */ }
}

ipcMain.handle('pc:info', () => {
  const cpus = os.cpus() || [];
  let stTotal = 0;
  let stFree = 0;
  try {
    const s = fs.statfsSync((process.env.SystemDrive || 'C:') + '\\');
    stTotal = (s.blocks * s.bsize) / 1e9;
    stFree = (s.bavail * s.bsize) / 1e9;
  } catch (e) { /* ignore */ }
  let built = 'N/A';
  try {
    const d = fs.statSync(process.execPath).mtime;
    built = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
  } catch (e) { /* ignore */ }
  return {
    brand: sysModel ? sysModel.brand : '',
    model: sysModel ? sysModel.model : os.hostname(),
    android: `${os.version()} (${os.release()})`,
    soc: cpus[0] ? cpus[0].model.trim() : 'N/A',
    cores: cpus.length,
    abi: process.arch,
    mhz: cpus[0] ? cpus[0].speed : 0,
    ramTotal: Math.round(os.totalmem() / 1048576),
    ramFree: Math.round(os.freemem() / 1048576),
    stTotal,
    stFree,
    ver: app.getVersion(),
    built
  };
});

// Wi-Fi / Bluetooth / авиарежим: открываем соответствующую страницу параметров Windows
ipcMain.handle('pc:radio', (_e, k) => {
  const page = { wifi: 'ms-settings:network-wifi', bt: 'ms-settings:bluetooth', air: 'ms-settings:network-airplanemode' }[k];
  return page ? shell.openExternal(page) : null;
});

ipcMain.handle('pc:exit', () => { app.quit(); });

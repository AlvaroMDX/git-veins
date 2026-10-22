const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const https = require('https');

// optional { redmineUrl, redmineKey }: lets the branch card show the task title
const CONFIG = path.join(os.homedir(), '.claude', 'git-veins', 'config.json');

const LIMITS = [150, 300, 600, 1200];

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch {
    return {};
  }
}

function getJson(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(body)) : reject(new Error('HTTP ' + res.statusCode))));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function redmineIssue(id) {
  const { redmineUrl, redmineKey } = readConfig();
  if (!redmineUrl || !redmineKey) return { id, error: 'no config' };
  try {
    const { issue } = await getJson(`${redmineUrl.replace(/\/$/, '')}/issues/${id}.json`, { 'X-Redmine-API-Key': redmineKey });
    return { id, subject: issue.subject, status: issue.status?.name, assignee: issue.assigned_to?.name };
  } catch (e) {
    return { id, error: e.message };
  }
}

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    cp.execFile('git', args, { cwd, maxBuffer: 128 * 1024 * 1024, windowsHide: true }, (err, out, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(out));
  });
}

async function toplevel(dir) {
  try {
    return path.normalize((await git(dir, ['rev-parse', '--show-toplevel'])).trim());
  } catch {
    return null;
  }
}

async function guessRepo() {
  const file = vscode.window.activeTextEditor?.document.uri;
  if (file?.scheme === 'file') {
    const repo = await toplevel(path.dirname(file.fsPath));
    if (repo) return repo;
  }
  for (const f of vscode.workspace.workspaceFolders || []) {
    const repo = await toplevel(f.uri.fsPath);
    if (repo) return repo;
  }
  return null;
}

async function pickRepo() {
  const repos = new Set();
  for (const f of vscode.workspace.workspaceFolders || []) {
    const repo = await toplevel(f.uri.fsPath);
    if (repo) repos.add(repo);
  }
  const items = [...repos].map((r) => ({ label: path.basename(r), description: r }));
  items.push({ label: '$(folder-opened) Otra carpeta…', description: '' });
  const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Repositorio a diseccionar' });
  if (!choice) return null;
  if (choice.description) return choice.description;
  const uri = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false });
  if (!uri) return null;
  const repo = await toplevel(uri[0].fsPath);
  if (!repo) vscode.window.showWarningMessage('Esa carpeta no es un repositorio git.');
  return repo;
}

class VeinsView {
  constructor(context) {
    this.context = context;
    this.repo = null;
    this.panel = null;
    this.limit = context.globalState.get('gitVeins.limit', 300);
  }

  resolveWebviewView(view) {
    this.panel = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => vscode.window.showErrorMessage(e.message)));
    view.onDidDispose(() => {
      this.panel = null;
    });
  }

  async show(repo) {
    await vscode.commands.executeCommand('gitVeins.view.focus');
    if (repo) this.setRepo(repo);
  }

  setRepo(repo) {
    if (repo === this.repo) return;
    this.repo = repo;
    this.watch();
    this.load();
  }

  watch() {
    this.watcher?.dispose();
    const pattern = new vscode.RelativePattern(vscode.Uri.file(path.join(this.repo, '.git')), '{HEAD,packed-refs,refs/**}');
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const later = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.load(), 1500);
    };
    this.watcher.onDidChange(later);
    this.watcher.onDidCreate(later);
    this.watcher.onDidDelete(later);
  }

  async load() {
    if (!this.panel) return;
    const post = (m) => this.panel?.webview.postMessage(m);
    if (!this.repo) {
      this.repo = await guessRepo();
      if (!this.repo) return post({ type: 'error', message: 'no hay ningún repositorio git abierto. Pulsa «Repositorio».' });
      this.watch();
    }
    try {
      const [log, branch] = await Promise.all([
        git(this.repo, ['log', '--exclude=refs/stash', '--all', '--topo-order', '-n', String(this.limit),
          '--format=%H%x1f%P%x1f%an%x1f%at%x1f%s%x1f%D%x1e']),
        git(this.repo, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ''),
      ]);
      const commits = log.split('\x1e').map((r) => r.replace(/^\s+/, '')).filter(Boolean).map((r) => {
        const [h, p, a, t, s, d] = r.split('\x1f');
        return { h, p: p ? p.split(' ') : [], a, t: Number(t) * 1000, s, d: (d || '').trim() };
      });
      post({ type: 'data', repo: this.repo, name: path.basename(this.repo), branch: branch.trim(), limit: this.limit, limits: LIMITS, commits });
    } catch (e) {
      post({ type: 'error', message: e.message });
    }
  }

  async onMessage(m) {
    switch (m.type) {
      case 'ready':
      case 'refresh':
        return this.load();
      case 'limit':
        this.limit = Number(m.value) || 300;
        await this.context.globalState.update('gitVeins.limit', this.limit);
        return this.load();
      case 'repo': {
        const repo = await pickRepo();
        if (repo) this.setRepo(repo);
        return;
      }
      case 'issue':
        return this.panel?.webview.postMessage({ type: 'issue', ...(await redmineIssue(m.id)) });
      case 'copy':
        await vscode.env.clipboard.writeText(m.hash);
        vscode.window.setStatusBarMessage(`Hash ${m.hash.slice(0, 9)} copiado`, 2500);
        return;
      case 'show': {
        let text = await git(this.repo, ['show', '--stat', '--patch', '--format=fuller', m.hash]);
        if (text.length > 400000) text = text.slice(0, 400000) + '\n… (recortado)';
        const doc = await vscode.workspace.openTextDocument({ content: text, language: 'diff' });
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
        return;
      }
    }
  }

  html() {
    const wv = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const media = (f) => wv.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', f));
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${wv.cspSource} data:; style-src ${wv.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('style.css')}">
<title>Git Veins</title>
</head>
<body>
<canvas id="scene"></canvas>
<div id="labels"><div id="hoverLbl" class="lbl" hidden></div></div>
<header id="plate">
  <div class="fig">Fig. I</div>
  <h1>Systema venosum <em id="repoName">repositorii</em></h1>
  <div class="sub" id="sub">—</div>
</header>
<nav id="bar">
  <button id="repo" title="Elegir repositorio">Repositorio</button>
  <select id="limit" title="Commits a cargar"></select>
  <button id="refresh" title="Volver a leer el historial">⟳</button>
  <button id="fit" title="Encuadrar">⌂</button>
  <button id="spin" class="toggle" title="Girar">↻</button>
  <button id="caps" class="toggle on" title="Capilares">Capilares</button>
  <label class="check" title="Mostrar siempre los nombres de las ramas"><input type="checkbox" id="tags">Nombres</label>
  <label class="time" title="Recorrer la historia">pasado<input id="time" type="range" min="0" max="0" value="0">presente</label>
</nav>
<aside id="legend">
  <div><i class="sw main"></i>Vena principal · rama más larga</div>
  <div><i class="sw red"></i><i class="sw blue"></i>Ramas · arterias y venas</div>
  <div><i class="dot gold"></i>Nódulo dorado · merge</div>
  <div class="hint">clic: copiar hash · doble clic: ver commit</div>
</aside>
<div id="tip" hidden></div>
<div id="msg" hidden></div>
<script nonce="${nonce}" src="${media('main.js')}"></script>
</body>
</html>`;
  }
}

function activate(context) {
  const veins = new VeinsView(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('gitVeins.view', veins, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('gitVeins.open', () => veins.show()),
    vscode.commands.registerCommand('gitVeins.pickRepo', async () => {
      const repo = await pickRepo();
      if (repo) veins.show(repo);
    }),
  );
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -100);
  item.text = '$(heart) Venas';
  item.tooltip = 'Git Veins: ver el grafo del repositorio como lámina anatómica 3D';
  item.command = 'gitVeins.open';
  item.show();
  context.subscriptions.push(item);
}

function deactivate() {}

module.exports = { activate, deactivate };

// preview.js <repo> <out.html> <extra-js>: webview page fed with the repo's log and fake Redmine answers
const { execFileSync } = require('child_process');
const fs = require('fs');
const [repo, out, extra = ''] = process.argv.slice(2);
const ext = require('path').resolve(__dirname, '..').split('\\').join('/') + '/';
const log = execFileSync('git', ['log', '--exclude=refs/stash', '--all', '--topo-order', '-n', '300', '--format=%H%x1f%P%x1f%an%x1f%at%x1f%s%x1f%D%x1e'], { cwd: repo }).toString();
const commits = log.split('\x1e').map((r) => r.replace(/^\s+/, '')).filter(Boolean).map((r) => {
  const [h, p, a, t, s, d] = r.split('\x1f');
  return { h, p: p ? p.split(' ') : [], a, t: Number(t) * 1000, s, d: (d || '').trim() };
});
const data = { type: 'data', repo: 'demo', name: 'acme-portal', branch: 'task/1101', limit: 300, limits: [150, 300, 600, 1200], commits };
const issues = {
  1024: ['Inicio de sesión con bloqueo por intentos fallidos', 'Cerrada', 'Lucía Prado'],
  1031: ['Facturas exportables a PDF', 'Cerrada', 'Marcos Vidal'],
  1040: ['Tema oscuro en toda la aplicación', 'Cerrada', 'Irene Soler'],
  1052: ['Buscador global', 'Ready for PRE', 'Hugo Ferrer'],
  1063: ['Resumen semanal por correo', 'Cerrada', 'Lucía Prado'],
  1077: ['Gráfica de ingresos mensuales', 'Ready for PRE', 'Marcos Vidal'],
  1085: ['Mapa de clientes por región', 'Cerrada', 'Irene Soler'],
  1092: ['Registro de auditoría', 'In progress', 'Hugo Ferrer'],
  1101: ['Portal del cliente', 'In progress', 'Irene Soler'],
};
const issueMsgs = Object.entries(issues).map(([id, [subject, status, assignee]]) => ({ type: 'issue', id, subject, status, assignee }));
const body = fs.readFileSync(ext + 'extension.js', 'utf8').match(/<body>([\s\S]*?)<script/)[1];
fs.writeFileSync(out, `<!doctype html><html><head><meta charset=utf-8><link rel=stylesheet href="file:///${ext}media/style.css"></head><body>${body}
<script src="file:///${ext}media/main.js"></script>
<script>setTimeout(()=>{postMessage(${JSON.stringify(data)},'*');${JSON.stringify(issueMsgs)}.forEach(m=>postMessage(m,'*'));},100);
${extra}</script></body></html>`);

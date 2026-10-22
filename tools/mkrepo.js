// builds a fictional repo for README screenshots
const { execFileSync } = require('child_process');
const fs = require('fs');
const dir = process.argv[2];
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
let t = Date.UTC(2026, 6, 1) / 1000;
const people = [['Lucía Prado', 'lucia@example.com'], ['Marcos Vidal', 'marcos@example.com'], ['Irene Soler', 'irene@example.com'], ['Hugo Ferrer', 'hugo@example.com']];
let who = 0;
let seq = 0;
const g = (...a) => execFileSync('git', a, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: people[who][0], GIT_AUTHOR_EMAIL: people[who][1], GIT_COMMITTER_NAME: people[who][0], GIT_COMMITTER_EMAIL: people[who][1], GIT_AUTHOR_DATE: `${t} +0200`, GIT_COMMITTER_DATE: `${t} +0200` } }).toString();
const commit = (msg) => { t += 3600 * (3 + Math.floor(Math.random() * 20)); fs.writeFileSync(dir + '/f' + (++seq) + '.txt', msg); g('add', '.'); g('commit', '-q', '-m', msg); };
g('init', '-q', '-b', 'main');
commit('Initial project structure');
commit('Add build pipeline');
g('checkout', '-q', '-b', 'develop');
commit('Set up linting and formatting');
const features = [
  ['task/1024', ['Add login form', 'Validate credentials on submit', 'Rate-limit failed logins']],
  ['task/1031', ['Create invoices table', 'Export invoices to PDF']],
  ['task/1040', ['Add dark theme tokens', 'Theme switcher in settings', 'Fix contrast on buttons', 'Persist theme choice']],
  ['task/1052', ['Search endpoint', 'Debounce search input']],
  ['task/1063', ['Notifications service', 'Email digest template', 'Unsubscribe link']],
  ['task/1077', ['Upgrade charts library', 'Monthly revenue chart']],
  ['task/1085', ['Map view of customers', 'Cluster markers', 'Filter by region']],
  ['task/1092', ['Audit log model', 'Audit log screen']],
];
let n = 0;
for (const [name, msgs] of features) {
  who = n % people.length;
  g('checkout', '-q', 'develop');
  if (n % 3 === 1) { who = (n + 1) % people.length; commit('Bump dependencies'); who = n % people.length; }
  g('checkout', '-q', '-b', name);
  msgs.forEach(commit);
  n++;
  if (n % 2 === 0 || n === features.length) continue;
  g('checkout', '-q', 'develop');
  g('merge', '-q', '--no-ff', name, '-m', `Merge branch '${name}' into 'develop'`);
}
// merge the even ones later so branches overlap in time
for (const [name] of features.filter((_, i) => i % 2 === 1 && i < features.length - 1)) {
  g('checkout', '-q', 'develop');
  who = 0;
  g('merge', '-q', '--no-ff', name, '-m', `Merge branch '${name}' into 'develop'`);
  g('branch', '-q', '-D', name);
}
g('checkout', '-q', 'main');
g('merge', '-q', '--no-ff', 'develop', '-m', "Merge branch 'develop' into 'main'");
g('tag', 'v1.0.0');
g('checkout', '-q', 'develop');
commit('Start 1.1 cycle');
g('checkout', '-q', '-b', 'task/1101');
who = 2; commit('Customer portal skeleton'); commit('Portal: invoices list');
g('checkout', '-q', 'develop');
who = 1; commit('Hotfix: timezone in reports');
g('checkout', '-q', 'task/1101');

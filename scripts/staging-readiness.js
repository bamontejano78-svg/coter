'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REQUIRED_ACTION_SECRETS = [
  'TEST_DB_PASSWORD',
  'TEST_JWT_SECRET',
  'TEST_ENCRYPTION_KEY',
  'SSH_HOST',
  'SSH_USER',
  'SSH_PRIVATE_KEY',
  'STAGING_DEPLOY_PATH',
  'STAGING_URL',
];

const checks = [];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: options.timeout || 15000,
    env: { ...process.env, ...(options.env || {}) },
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    output: `${result.stdout || ''}${result.stderr || ''}`.trim(),
  };
}

function pass(name, detail) {
  checks.push({ level: 'pass', name, detail });
}

function warn(name, detail) {
  checks.push({ level: 'warn', name, detail });
}

function fail(name, detail) {
  checks.push({ level: 'fail', name, detail });
}

function maskRemote(remote) {
  return remote
    .replace(/https:\/\/[^/@:]+:[^/@]+@/gi, 'https://***:***@')
    .replace(/https:\/\/[^/@]+@/gi, 'https://***@');
}

function repoFromRemote(remote) {
  const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/i);
  return match ? match[1].replace(/\.git$/i, '') : null;
}

function checkNode() {
  const result = run('node', ['-v']);
  if (!result.ok) {
    fail('Node.js', 'node no esta disponible');
    return;
  }
  const version = result.stdout.trim();
  const major = Number(version.replace(/^v/, '').split('.')[0]);
  if (major === 20) pass('Node.js', version);
  else warn('Node.js', `${version}; CI y produccion estan fijados a Node 20`);
}

function checkGitRemote() {
  const url = run('git', ['remote', 'get-url', 'origin']);
  if (!url.ok) {
    fail('Git remote', 'origin no esta configurado');
    return null;
  }
  const remote = url.stdout.trim();
  if (/https:\/\/[^/@:]+:[^/@]+@/i.test(remote) || /https:\/\/[^/@]+@/i.test(remote)) {
    fail('Git remote', `origin contiene credenciales: ${maskRemote(remote)}`);
  } else {
    pass('Git remote', maskRemote(remote));
  }
  return repoFromRemote(remote);
}

function checkGitState() {
  const branch = run('git', ['branch', '--show-current']);
  if (branch.ok) {
    const name = branch.stdout.trim() || '(detached)';
    if (name === 'main') pass('Git branch', name);
    else warn('Git branch', `${name}; el deploy automatico de staging corre al pushear main`);
  } else {
    warn('Git branch', 'no se pudo leer la rama actual');
  }

  const status = run('git', ['status', '--porcelain']);
  if (!status.ok) {
    fail('Git status', 'no se pudo leer el estado del worktree');
    return;
  }
  const changed = status.stdout.split(/\r?\n/).filter(Boolean).length;
  if (changed === 0) pass('Git status', 'worktree limpio');
  else fail('Git status', `${changed} cambios locales pendientes; commit + push requeridos para CI/CD real`);

  const trackedProdEnv = run('git', ['ls-files', '.env.production']);
  if (!trackedProdEnv.ok || trackedProdEnv.stdout.trim()) {
    fail('Secrets en Git', '.env.production sigue trackeado');
  } else {
    pass('Secrets en Git', '.env.production no esta trackeado');
  }
}

function checkGitHub(repo) {
  const auth = run('gh', ['auth', 'status'], { timeout: 10000 });
  if (!auth.ok) {
    fail('GitHub CLI', 'gh no esta autenticado o el token local es invalido');
    return;
  }
  pass('GitHub CLI', 'autenticado');

  if (!repo) {
    warn('GitHub secrets', 'no se pudo inferir owner/repo desde origin');
    return;
  }

  const secretList = run('gh', ['secret', 'list', '--repo', repo], { timeout: 15000 });
  if (!secretList.ok) {
    fail('GitHub secrets', `no se pudo listar secrets de ${repo}`);
    return;
  }

  const present = new Set(secretList.stdout.split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean));
  const missing = REQUIRED_ACTION_SECRETS.filter((name) => !present.has(name));
  if (missing.length === 0) {
    pass('GitHub secrets', `presentes: ${REQUIRED_ACTION_SECRETS.join(', ')}`);
  } else {
    fail('GitHub secrets', `faltan: ${missing.join(', ')}`);
  }
}

function checkDocker() {
  const docker = run('docker', ['--version']);
  if (!docker.ok) {
    fail('Docker', 'docker no esta disponible en esta maquina');
    return;
  }
  pass('Docker', docker.stdout.trim());

  const compose = run('docker', ['compose', 'version']);
  if (!compose.ok) {
    fail('Docker Compose', 'docker compose no esta disponible');
  } else {
    pass('Docker Compose', compose.stdout.trim());
  }
}

function checkStagingEnv() {
  const preflight = run('node', ['scripts/staging-preflight.js'], { timeout: 15000 });
  if (preflight.ok) {
    pass('.env.staging', 'preflight OK');
  } else {
    fail('.env.staging', 'preflight fallido o archivo ausente');
  }
}

function checkPackageScripts() {
  const pkg = require(path.join(ROOT, 'package.json'));
  for (const script of ['staging:preflight', 'staging:smoke', 'staging:readiness']) {
    if (pkg.scripts && pkg.scripts[script]) pass(`npm ${script}`, pkg.scripts[script]);
    else fail(`npm ${script}`, 'script no definido');
  }
}

function printReport() {
  const icon = { pass: 'OK', warn: 'WARN', fail: 'FAIL' };
  console.log('Staging readiness');
  for (const check of checks) {
    console.log(`${icon[check.level]} ${check.name}: ${check.detail}`);
  }
  const fails = checks.filter((check) => check.level === 'fail').length;
  const warnings = checks.filter((check) => check.level === 'warn').length;
  console.log(`\nResumen: ${fails} bloqueos, ${warnings} avisos`);
  if (fails > 0) process.exit(1);
}

const repo = checkGitRemote();
checkNode();
checkPackageScripts();
checkGitState();
checkGitHub(repo);
checkDocker();
checkStagingEnv();
printReport();

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(resolve(root, 'config/runtime-lock.json'), 'utf8'));
const { python: requiredPython, packages } = lock.documentTools ?? {};
if (!requiredPython || !Array.isArray(packages) || packages.length === 0) {
  throw new Error('config/runtime-lock.json must define documentTools.python and documentTools.packages.');
}

const bundledPython = 'C:/Users/luna/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const candidates = [];
if (process.env.ASTRA_PYTHON) candidates.push(process.env.ASTRA_PYTHON);
if (existsSync(bundledPython)) candidates.push(bundledPython);
candidates.push('python');

let basePython;
const failures = [];
for (const candidate of candidates) {
  const result = spawnSync(candidate, ['-c', 'import json,sys; print(json.dumps({"executable":sys.executable,"version":"{}.{}".format(*sys.version_info[:2])}))'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    failures.push(`${candidate}: ${result.error?.message ?? result.stderr.trim() ?? `exit ${result.status}`}`);
    continue;
  }
  const info = JSON.parse(result.stdout.trim());
  if (info.version !== requiredPython) {
    failures.push(`${info.executable}: Python ${info.version}, expected ${requiredPython}`);
    continue;
  }
  basePython = info.executable;
  break;
}
if (!basePython) {
  throw new Error(`Could not find Python ${requiredPython}. Set ASTRA_PYTHON to its executable. Attempts: ${failures.join('; ')}`);
}

const venv = resolve(root, '.runtime/python');
const venvPython = resolve(venv, 'Scripts/python.exe');
const cache = resolve(root, '.runtime/pip-cache');
const run = (executable, args) => {
  const result = spawnSync(executable, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} ${args.join(' ')} failed with exit code ${result.status}.`);
};

console.log(`Creating document-tools venv with Python ${requiredPython}: ${basePython}`);
run(basePython, ['-m', 'venv', '--copies', venv]);
run(venvPython, ['-m', 'pip', 'install', '--no-input', '--disable-pip-version-check', '--cache-dir', cache, ...packages]);

const packageInfo = {};
for (const requirement of packages) {
  const match = /^([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+-]+)$/.exec(requirement);
  if (!match) throw new Error(`Expected an exactly pinned document tool package, got: ${requirement}`);
  packageInfo[match[1].toLowerCase().replaceAll('_', '-')] = match[2];
}
const imports = {
  'python-docx': 'docx',
  pillow: 'PIL',
  lxml: 'lxml',
};
const checks = Object.fromEntries(Object.entries(packageInfo).map(([name, version]) => {
  const module = imports[name];
  if (!module) throw new Error(`No import verification mapping for ${name}.`);
  return [name, { module, version }];
}));
const verifyCode = [
  'import importlib,json,sys',
  'checks=json.loads(sys.argv[1])',
  'for name,item in checks.items():',
  ' module=importlib.import_module(item["module"])',
  ' actual=getattr(module,"__version__",None)',
  ' if str(actual)!=item["version"]: raise SystemExit(name + ": expected " + item["version"] + ", got " + str(actual))',
  ' print(name + " " + str(actual) + ": import OK")',
].join('\n');
run(venvPython, ['-c', verifyCode, JSON.stringify(checks)]);

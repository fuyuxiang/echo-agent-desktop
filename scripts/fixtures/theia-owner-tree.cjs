'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const [mode, directory, guard] = process.argv.slice(2);
if (mode === 'owner') {
  const child = spawn(process.execPath, [__filename, 'backend', directory], {
    detached: true,
    env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(guard)}`, ECHO_THEIA_PARENT_FD: '3' },
    stdio: ['ignore', 'ignore', 'inherit', 'pipe'],
  });
  process.on('SIGUSR2', () => child.stdio[3].destroy());
  setInterval(() => {}, 1000); // The desktop has a lifetime independent of Node.
  const timer = setInterval(() => {
    const ready = path.join(directory, 'backend.json');
    if (!fs.existsSync(ready)) return;
    const backend = JSON.parse(fs.readFileSync(ready));
    fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ ownerPid: process.pid, backendPid: child.pid, ...backend }));
    clearInterval(timer);
  }, 20);
} else if (mode === 'backend') {
  const worker = spawn(process.execPath, [__filename, 'worker', directory], { stdio: 'ignore' });
  fs.writeFileSync(path.join(directory, 'backend.json'), JSON.stringify({ workerPid: worker.pid }));
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
} else if (mode === 'worker') {
  fs.writeFileSync(path.join(directory, 'worker.json'), JSON.stringify({ inheritedOwnerFd: process.env.ECHO_THEIA_PARENT_FD !== undefined }));
  process.on('SIGTERM', () => {});
  setTimeout(() => fs.writeFileSync(path.join(directory, 'late-write'), 'unreclaimed'), 5000);
  setInterval(() => {}, 1000);
} else {
  throw new Error('Unknown owned tree fixture mode');
}

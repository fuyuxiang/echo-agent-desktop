'use strict';

// The desktop owns the other end of this private socket. Its descriptor is
// close-on-exec everywhere except this one, process-group-leading backend.
// EOF therefore also covers SIGKILL/crashes where Rust cannot run Drop.
const descriptor = process.env.ECHO_THEIA_PARENT_FD;
delete process.env.ECHO_THEIA_PARENT_FD;
if (descriptor !== undefined && process.platform !== 'win32') {
  const fd = Number(descriptor);
  if (!/^\d+$/.test(descriptor) || !Number.isSafeInteger(fd) || fd < 3
      || !require('node:fs').fstatSync(fd).isSocket()) {
    throw new Error('Invalid desktop parent lifetime socket');
  }
  const socket = new (require('node:net').Socket)({ fd, readable: true, writable: false });
  let ownerLost = false;
  const killOwnedGroup = () => {
    // The backend is its own process-group leader. Never accept a PID/group
    // from the environment, and never signal the parent or a process by name.
    try { process.kill(-process.pid, 'SIGKILL'); }
    catch { process.exit(1); }
  };
  const closeOwnedTree = () => {
    if (ownerLost) return;
    ownerLost = true;
    // Give Theia's existing signal hooks a chance to release terminals and
    // IPC workers. Its normal exit must also reclaim stubborn descendants.
    process.once('exit', killOwnedGroup);
    process.once('SIGTERM', () => {});
    setTimeout(killOwnedGroup, 1000);
    try { process.kill(-process.pid, 'SIGTERM'); }
    catch { killOwnedGroup(); }
  };
  socket.on('end', closeOwnedTree);
  socket.on('close', closeOwnedTree);
  socket.on('error', closeOwnedTree);
  socket.on('data', closeOwnedTree); // The owner never sends application data.
  socket.resume();
  socket.unref();
}

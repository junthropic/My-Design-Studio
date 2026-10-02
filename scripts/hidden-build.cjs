// Loaded only by the signing build's Node child process, never into the user's shell.
// electron-builder's nested tools must inherit the same no-visible-console rule.
const cp = require('node:child_process');
const { promisify } = require('node:util');
const addPromisified = (name) => {
  const wrapped = cp[name];
  wrapped[promisify.custom] = (...args) => {
    let child;
    const promise = new Promise((resolve, reject) => {
      child = wrapped(...args, (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        } else resolve({ stdout, stderr });
      });
    });
    promise.child = child;
    return promise;
  };
};
for (const key of ['spawn', 'spawnSync']) {
  const original = cp[key];
  cp[key] = function (file, args, options) {
    if (!Array.isArray(args)) {
      options = args;
      args = [];
    }
    return original.call(this, file, args, { ...options, windowsHide: true, shell: false });
  };
}
for (const key of ['execFile', 'execFileSync']) {
  const original = cp[key];
  cp[key] = function (file, args, options, callback) {
    if (!Array.isArray(args)) {
      callback = options;
      options = args;
      args = [];
    }
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }
    return original.call(
      this,
      file,
      args,
      { ...options, windowsHide: true, shell: false },
      ...(typeof callback === 'function' ? [callback] : []),
    );
  };
  if (key === 'execFile') addPromisified(key);
}
for (const key of ['exec', 'execSync']) {
  const original = cp[key];
  cp[key] = function (command, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }
    return original.call(
      this,
      command,
      { ...options, windowsHide: true },
      ...(typeof callback === 'function' ? [callback] : []),
    );
  };
  if (key === 'exec') addPromisified(key);
}
require('node:module').syncBuiltinESMExports();

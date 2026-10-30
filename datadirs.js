// Where Maya keeps its data, checked BEFORE anything else loads. server.js requires this first: memory.js (reached through call.js) creates its folder the moment it is imported,
// so a folder that cannot be created used to end in a raw "EACCES: permission denied, mkdir" stack trace at import time, before any of server.js ran.
// On Render only what is under the persistent disk's mount path survives a deploy or a restart; render.yaml points the four variables at /var/data. If a variable points at a path
// the app cannot create or write (the disk is not attached), Maya REFUSES TO START with a plain message: configured-but-missing storage must never silently become wipeable storage.
// (Clearing the four variables by hand, on purpose, is the one emergency path: they then fall back to the app folder and the start-up warning says so.)
// Printed: the variable name, the folder's last name, the error code. Never a full path.
const fs = require('node:fs');
const path = require('node:path');

const APP = __dirname;
const DIRS = { MAYA_DATA_DIR: ['data', 'profiles'], MAYA_CARE_DIR: ['data', 'care'], MAYA_WA_DIR: ['data', 'whatsapp'], MAYA_MEDIA_DIR: ['data', 'media'] };   // the defaults, under the app folder

// Creates each folder and checks it can be written to; returns what it found. Does not exit: guard() does.
function inspect(env = process.env, app = APP) {
  const out = { failed: null, inside: 0, separate: 0, of: Object.keys(DIRS).length };
  let appDev = null; try { appDev = fs.statSync(app).dev; } catch { /* the app folder is there, we are running from it */ }
  for (const [key, d] of Object.entries(DIRS)) {
    const dir = path.resolve(env[key] || path.join(app, ...d));   // an empty value counts as unset
    try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); }
    catch (e) { out.failed = { key, code: e.code || 'ERROR', name: path.basename(dir) }; return out; }
    if (dir === app || dir.startsWith(app + path.sep)) out.inside += 1;
    try { if (fs.statSync(dir).dev !== appDev) out.separate += 1; } catch { /* counted as not separate */ }   // a mounted disk is a different filesystem from the app folder
  }
  return out;
}

const failMessage = (f) => `FATAL: the data folder for ${f.key} ("${f.name}") cannot be created or written to (${f.code}). Is the persistent disk attached, and does ${f.key} point inside its mount path (render.yaml uses /var/data)? Maya did not start, so nothing is written to the wrong place.\n`;

// Called first thing by server.js. Exits with status 1 and a plain message if a folder is unusable; otherwise returns an object whose report(mode) prints the start-up lines.
function guard(env = process.env, app = APP) {
  const found = inspect(env, app);
  if (found.failed) { process.stderr.write(failMessage(found.failed)); process.exit(1); }
  return {
    ...found,
    // Real mode only (as before): counts, and a warning when the data cannot be on a persistent disk.
    report(mode) {
      if (mode !== 'real') return;
      console.log('data directories', JSON.stringify({ insideTheAppFolder: found.inside, onSeparateDisk: found.separate, of: found.of }));
      if (found.inside) console.warn(`WARNING: ${found.inside} of ${found.of} data folders are inside the app folder, which is wiped on every deploy and restart. Set the MAYA_*_DIR variables to the persistent disk (render.yaml).`);
      else if (found.separate < found.of) console.warn(`WARNING: ${found.of - found.separate} of ${found.of} data folders are on the same filesystem as the app, not on a separate disk. Unless this is a development machine, the persistent disk is not mounted and the data will be lost on a deploy.`);
    },
  };
}

module.exports = { inspect, guard, failMessage, DIRS };

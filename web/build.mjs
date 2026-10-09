import { cp, lstat, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, 'dist');
// Enumerate individual public files. Additional files in assets/ or admin/ are
// excluded, just like .env, docs, Cloud Functions and backend libraries.
const publicFiles = [
  'index.html', 'styles.css', 'app.js', 'config.js', 'assets/icon.svg',
  'admin/index.html', 'admin/styles.css', 'admin/app.js',
];
for (const name of publicFiles) {
  // Reject links in both the file and its parent directory.
  for (let path = join(root, name); path !== root; path = dirname(path)) {
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Public files must not contain symlinks');
  }
  if (!(await lstat(join(root, name))).isFile()) throw new Error(`Expected a public file: ${name}`);
}
const icon = await readFile(join(root, 'assets/icon.svg'), 'utf8');
if (!/^<svg\s/.test(icon) || !icon.includes('xmlns="http://www.w3.org/2000/svg"') || !icon.includes('</svg>')) {
  throw new Error('Expected a standalone SVG favicon');
}
try {
  if ((await lstat(output)).isSymbolicLink()) throw new Error('dist must not be a symlink');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await rm(output, { recursive: true, force: true });
await mkdir(output);
for (const name of publicFiles) {
  await mkdir(dirname(join(output, name)), { recursive: true });
  await cp(join(root, name), join(output, name));
}
await cp(join(root, 'assets/icon.svg'), join(output, 'favicon.svg'));
console.log('Public Web files built in dist; Node.js APIs remain in cloud-functions.');

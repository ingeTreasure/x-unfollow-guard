// Supply sharp via the workspace runtime or install it as a development dependency.
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
(async () => {
  const root = path.join(__dirname, '..');
  const source = await fs.readFile(path.join(root, 'icons/logo.svg'));
  for (const size of [16, 32, 48, 128, 512]) {
    await sharp(source, { density: 600 }).resize(size, size).png().toFile(path.join(root, size === 512 ? 'icons/logo.png' : `icons/icon${size}.png`));
  }
})();

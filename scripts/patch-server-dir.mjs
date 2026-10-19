import fs from 'fs';

let content = fs.readFileSync('src/web/server.js', 'utf8');

if (!content.includes("import { DATA_DIR } from '../fsUtil.js';")) {
  content = "import { DATA_DIR } from '../fsUtil.js';\n" + content;
  fs.writeFileSync('src/web/server.js', content, 'utf8');
  console.log('server.js DATA_DIR imported');
} else {
  console.log('DATA_DIR already imported');
}

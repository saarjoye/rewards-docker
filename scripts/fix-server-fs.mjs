import fs from 'fs';

let content = fs.readFileSync('src/web/server.js', 'utf8');

if (!content.includes("import fs from 'fs';")) {
  content = "import fs from 'fs';\n" + content;
  fs.writeFileSync('src/web/server.js', content, 'utf8');
  console.log('server.js import fs added');
} else {
  console.log('fs already imported');
}

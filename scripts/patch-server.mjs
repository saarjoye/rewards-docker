import fs from 'fs';

let content = fs.readFileSync('src/web/server.js', 'utf8');

if (!content.includes("import browserManager from '../browser/browser.js';")) {
  content = content.replace(
    "import scheduler from '../scheduler.js';",
    "import scheduler from '../scheduler.js';\nimport browserManager from '../browser/browser.js';"
  );
}

content = content.replace(
  '      currentTaskSection: taskManager.currentTaskSection,\n      accounts',
  '      currentTaskSection: taskManager.currentTaskSection,\n      browserState: browserManager.getState(),\n      notify: cfg.notify,\n      accounts'
);

fs.writeFileSync('src/web/server.js', content, 'utf8');
console.log('server.js updated successfully');

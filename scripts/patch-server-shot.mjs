import fs from 'fs';

let content = fs.readFileSync('src/web/server.js', 'utf8');

const routeCode = `
  // 12. 获取无头浏览器实时视口微缩截屏
  app.get('/api/browser/screenshot', (req, res) => {
    const candidatePaths = [
      path.join(DATA_DIR, 'after_black_claim_clicked.png'),
      path.join(DATA_DIR, 'drawer_wait_4s.png'),
      path.join(DATA_DIR, 'puzzle_completed.png'),
      path.join(DATA_DIR, 'webui_with_memory_monitor.png')
    ];
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-cache');
        return res.sendFile(p);
      }
    }
    res.status(404).send('No screenshot');
  });
`;

if (!content.includes('/api/browser/screenshot')) {
  content = content.replace(
    '  // 9. SSE 实时日志推流',
    routeCode + '\n  // 9. SSE 实时日志推流'
  );
  fs.writeFileSync('src/web/server.js', content, 'utf8');
  console.log('server.js screenshot route added');
} else {
  console.log('screenshot route already exists');
}

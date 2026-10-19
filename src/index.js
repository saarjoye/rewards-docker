import configManager from './config.js';
import logger from './logger.js';
import scheduler from './scheduler.js';
import { createServer } from './web/server.js';

async function bootstrap() {
  console.log(`
  ==============================================================
  🎁 Microsoft Rewards 全自动化架构平台 (v3.0 重构标准版)
  ==============================================================
  `);

  const cfg = configManager.get();
  const port = process.env.PORT || cfg.server?.port || 5308;

  const app = createServer();
  const server = app.listen(port, '0.0.0.0', () => {
    logger.log('🚀', `Web 控制台已成功启动，访问入口: http://localhost:${port}`);
    logger.log('💡', `若是 NAS / Docker 容器部署，请访问: http://<宿主机IP>:${port}`);
  });

  // 启动后台定时调度器与午夜收割引擎
  scheduler.start();

  // 优雅停机信号处理
  const shutdown = () => {
    logger.log('🛑', '正在安全退出服务...');
    scheduler.stop();
    server.close(() => {
      process.exit(0);
    });
    server.closeAllConnections?.();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch((err) => {
  console.error('服务启动失败:', err);
  process.exit(1);
});

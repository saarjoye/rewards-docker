const fs = require('fs');

const testFiles = [
  'test/serverSmoke.test.js',
  'test/tasksRun.test.js',
  'test/tasksStop.test.js'
];

for (const file of testFiles) {
  let content = fs.readFileSync(file, 'utf8');
  if (!content.includes('origAdmin = JSON.parse')) {
    content = content.replace(
      '  // 注入管理员测试会话',
      '  const origAdmin = JSON.parse(JSON.stringify(configManager.get().admin || {}));\n  // 注入管理员测试会话'
    );
    content = content.replace(
      'test(\'POST /api/tasks/run 灵活任务调度接口测试\', async () => {\n  configManager.setAdminCredentials',
      'test(\'POST /api/tasks/run 灵活任务调度接口测试\', async () => {\n  const origAdmin = JSON.parse(JSON.stringify(configManager.get().admin || {}));\n  configManager.setAdminCredentials'
    );
    content = content.replace(
      'test(\'POST /api/tasks/stop 中断任务接口测试\', async () => {\n  configManager.setAdminCredentials',
      'test(\'POST /api/tasks/stop 中断任务接口测试\', async () => {\n  const origAdmin = JSON.parse(JSON.stringify(configManager.get().admin || {}));\n  configManager.setAdminCredentials'
    );
    content = content.replace(
      '  } finally {\n    server.close();\n  }',
      '  } finally {\n    configManager.get().admin = origAdmin;\n    configManager.save();\n    server.close();\n  }'
    );
    content = content.replace(
      '  } finally {\n    taskManager.runAllAccountsTasks = origRunAll;\n    taskManager.runAccountTasks = origRunSingle;\n    server.close();\n  }',
      '  } finally {\n    taskManager.runAllAccountsTasks = origRunAll;\n    taskManager.runAccountTasks = origRunSingle;\n    configManager.get().admin = origAdmin;\n    configManager.save();\n    server.close();\n  }'
    );
    fs.writeFileSync(file, content, 'utf8');
    console.log('Fixed', file);
  }
}

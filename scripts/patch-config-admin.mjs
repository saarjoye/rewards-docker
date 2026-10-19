import fs from 'fs';

let content = fs.readFileSync('src/config.js', 'utf8');

// 在 DEFAULT_CONFIG 增加 admin 配置项
const oldDefaultAdmin = '  notify: {';
const newDefaultAdmin = `  admin: {
    initialized: false,
    username: '',
    salt: '',
    passwordHash: '',
    sessionSecret: ''
  },
  notify: {`;

if (!content.includes('admin: {')) {
  content = content.replace(oldDefaultAdmin, newDefaultAdmin);
}

// 在 ConfigManager 增加管理方法
const adminMethods = `
  ensureAdminSessionSecret() {
    if (!this.config.admin) this.config.admin = {};
    if (!this.config.admin.sessionSecret) {
      this.config.admin.sessionSecret = Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
      this.save();
    }
    return this.config.admin.sessionSecret;
  }

  getAdminConfig() {
    this.ensureAdminSessionSecret();
    return this.config.admin || {};
  }

  setAdminCredentials(username, salt, passwordHash) {
    this.ensureAdminSessionSecret();
    this.config.admin.initialized = true;
    this.config.admin.username = username;
    this.config.admin.salt = salt;
    this.config.admin.passwordHash = passwordHash;
    this.save();
    return this.config.admin;
  }
`;

if (!content.includes('ensureAdminSessionSecret()')) {
  content = content.replace('  getPublicConfig() {', adminMethods + '\n  getPublicConfig() {');
}

// 在 getPublicConfig 中脱敏 admin 字段
const oldPublic = '    if (cfg.notify?.weworkApp?.secret) {';
const newPublic = `    if (cfg.admin) {
      cfg.admin = {
        initialized: !!cfg.admin.initialized,
        username: cfg.admin.username || ''
      };
    }
    if (cfg.notify?.weworkApp?.secret) {`;

if (!content.includes('cfg.admin = {')) {
  content = content.replace(oldPublic, newPublic);
}

fs.writeFileSync('src/config.js', content, 'utf8');
console.log('config.js updated with admin auth support');

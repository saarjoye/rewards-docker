import fs from 'fs';
import { chromium } from 'patchright-core';
import http from 'http';
import { createServer } from '../src/web/server.js';
import configManager from '../src/config.js';
import { createAdminSessionToken, getAdminSessionCookieName } from '../src/identity/adminAuth.js';

const secret = configManager.ensureAdminSessionSecret();
const token = createAdminSessionToken('admin', secret);
const app = createServer();
const server = http.createServer(app);
await new Promise(r => server.listen(5398, r));

const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
});
const context = await browser.newContext();
await context.addCookies([{ name: getAdminSessionCookieName(), value: token, domain: '127.0.0.1', path: '/' }]);
const page = await context.newPage();

page.on('response', res => {
  if (res.status() >= 400) {
    console.log(`HTTP ${res.status()} -> ${res.url()}`);
  }
});

await page.goto('http://127.0.0.1:5398/', { waitUntil: 'load' });
await page.waitForTimeout(1000);

await browser.close();
await new Promise(r => server.close(r));

#!/usr/bin/env node
/**
 * Semi-Automatic Facebook Login & Cookie Saver
 * Auto-fills email/password, you solve security checks, then press ENTER
 */

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const SESSION_FILE = path.join(__dirname, 'session.json');
const USER_DATA_DIR = path.join(__dirname, '.fb-profile');
const FB_EMAIL = process.env.FB_EMAIL || '';
const FB_PASSWORD = process.env.FB_PASSWORD || '';

puppeteer.use(StealthPlugin());

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('\n📱 SEMI-AUTOMATIC FACEBOOK LOGIN\n');
  console.log('This script will:');
  console.log('  1. Open Facebook');
  console.log('  2. Auto-fill your email & password');
  console.log('  3. Wait for YOU to solve security checks (if any)');
  console.log('  4. Then press ENTER to save cookies\n');

  if (!FB_EMAIL || !FB_PASSWORD) {
    console.log('❌ Error: FB_EMAIL and FB_PASSWORD not set in .env file\n');
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    userDataDir: USER_DATA_DIR,
  });

  const page = await browser.newPage();
  console.log('Opening Facebook...\n');
  await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle2' });

  console.log('✓ Facebook opened');
  console.log('⏳ Auto-filling email & password...\n');

  // Auto-fill email
  try {
    await page.waitForSelector('input[name="email"]', { timeout: 5000 });
    await page.type('input[name="email"]', FB_EMAIL, { delay: 50 });
    console.log('✓ Email filled');
  } catch (e) {
    console.log('⚠️  Could not find email field:', e.message);
  }

  // Auto-fill password
  try {
    await page.waitForSelector('input[name="pass"]', { timeout: 5000 });
    await page.type('input[name="pass"]', FB_PASSWORD, { delay: 50 });
    console.log('✓ Password filled');
  } catch (e) {
    console.log('⚠️  Could not find password field:', e.message);
  }

  // Click login button
  try {
    await page.waitForSelector('button[name="login"]', { timeout: 5000 });
    await page.click('button[name="login"]');
    console.log('✓ Login button clicked');
  } catch (e) {
    console.log('⚠️  Could not find login button:', e.message);
  }

  console.log('\n👉 Next steps:');
  console.log('   1. If a security check appears (Captcha, 2FA, etc), solve it');
  console.log('   2. Wait until you see your Facebook home feed');
  console.log('   3. Return to this terminal');
  console.log('   4. Press ENTER to save your session\n');

  // Wait for user to press ENTER
  await new Promise(r => process.stdin.once('data', r));

  console.log('\n💾 Saving cookies...');
  const cookies = await page.cookies();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(cookies, null, 2));
  console.log(`✓ Saved ${cookies.length} cookies to session.json\n`);

  const cUserCookie = cookies.find(c => c.name === 'c_user');
  if (cUserCookie) {
    console.log('✅ Valid session found! Ready to deploy.\n');
  } else {
    console.log('⚠️  Note: No c_user cookie found. Make sure you logged in.\n');
  }

  console.log('📋 Next commands to deploy:\n');
  console.log('  git add manual-login.js session.json src/index.js');
  console.log('  git commit -m "Save verified session cookies"');
  console.log('  git push origin main\n');

  await browser.close();
  console.log('✓ Done! Browser closed.\n');
}

try {
  await main();
} catch (err) {
  console.error('❌ Error:', err.message);
  process.exit(1);
}

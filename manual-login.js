#!/usr/bin/env node
/**
 * FULLY MANUAL Facebook Login & Cookie Saver
 * Simple: opens Facebook, you log in, you press ENTER, cookies are saved
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

puppeteer.use(StealthPlugin());

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('\n📱 MANUAL FACEBOOK LOGIN\n');
  console.log('This opens Facebook in a browser window.');
  console.log('You manually log in, solve any reCAPTCHA, then press ENTER here.\n');

  const browser = await puppeteer.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    userDataDir: USER_DATA_DIR,
  });

  const page = await browser.newPage();
  console.log('Opening Facebook...\n');
  await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle2' });

  console.log('✓ Facebook is now open in a browser window');
  console.log('👉 Next steps:');
  console.log('   1. Log in to your Facebook account');
  console.log('   2. Solve any reCAPTCHA security checks');
  console.log('   3. Wait until you see your Facebook home feed');
  console.log('   4. Return to this terminal');
  console.log('   5. Press ENTER to save your session\n');

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

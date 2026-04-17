import fs from 'fs/promises';
import readline from 'readline';
import { SESSION_FILE } from './config.js';

export async function loadSessionFromDisk() {
  try {
    const raw = await fs.readFile(SESSION_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : data.cookies || [];
  } catch {
    return null;
  }
}

export async function saveSessionCookies(cookies) {
  await fs.writeFile(SESSION_FILE, JSON.stringify(cookies, null, 2), 'utf8');
}

export function hasUserCookie(cookies) {
  return cookies.some((c) => c.name === 'c_user' && c.value);
}

export function isLoginOrCheckpointUrl(url) {
  if (!url) return true;
  try {
    const u = new URL(url);
    const p = u.pathname.toLowerCase();
    return (
      p.includes('/login') ||
      p.includes('/checkpoint') ||
      p.includes('/recover') ||
      p.includes('two_factor') ||
      p.includes('two-factor')
    );
  } catch {
    return true;
  }
}

export async function collectFacebookCookies(page) {
  const urls = ['https://www.facebook.com', 'https://web.facebook.com'];
  const merged = [];
  const seen = new Set();
  for (const url of urls) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const list = await page.cookies();
      for (const c of list) {
        const k = `${c.name}|${c.domain}|${c.path}`;
        if (!seen.has(k)) {
          seen.add(k);
          merged.push(c);
        }
      }
    } catch {
      /* ignore */
    }
  }
  return merged;
}

function promptLine(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** Blocks until the user presses Enter (keeps the browser open until then). */
export function waitForEnter(
  message = '\nPress Enter here when you are done reviewing the post dialog — then the browser will close.\n'
) {
  return promptLine(message);
}

export async function waitUntilLoggedIn(page, { interactivePrompt = true } = {}) {
  const maxWaitMs = 30 * 60 * 1000;
  const start = Date.now();

  if (interactivePrompt) {
    console.log(
      '\n>>> Log in to Facebook in the browser window. This script will continue when your session is active.\n'
    );
  }

  while (Date.now() - start < maxWaitMs) {
    const url = page.url();
    let cookies = [];
    try {
      cookies = await page.cookies();
    } catch {
      /* ignore */
    }

    if (hasUserCookie(cookies) && !isLoginOrCheckpointUrl(url)) {
      return true;
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  if (interactivePrompt) {
    await promptLine('Session not detected. Press Enter after you finish logging in, or Ctrl+C to exit... ');
    const cookies = await page.cookies();
    return hasUserCookie(cookies) && !isLoginOrCheckpointUrl(page.url());
  }

  return false;
}

export async function ensureFreshLogin(page, reason) {
  console.warn(`\n>>> ${reason}\n>>> Please log in again in the browser.`);
  await promptLine('Press Enter after you have logged in successfully... ');
  const ok = await waitUntilLoggedIn(page, { interactivePrompt: false });
  if (!ok) {
    const cookies = await collectFacebookCookies(page);
    if (hasUserCookie(cookies)) {
      await saveSessionCookies(cookies);
      return true;
    }
    throw new Error('Login was not detected after manual re-authentication.');
  }
  const cookies = await collectFacebookCookies(page);
  await saveSessionCookies(cookies);
  return true;
}

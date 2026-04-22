function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function randomStepDelay() {
  return randomBetween(2000, 5000);
}

export function randomCharDelay() {
  return randomBetween(50, 150);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function randomMouseMove(page) {
  const vp = page.viewport();
  const w = vp?.width ?? 1280;
  const h = vp?.height ?? 800;
  const x = randomBetween(40, Math.max(41, w - 40));
  const y = randomBetween(40, Math.max(41, h - 40));
  await page.mouse.move(x, y, { steps: randomBetween(8, 20) });
}

export async function humanType(page, text) {
  for (const char of text) {
    await page.keyboard.type(char, { delay: randomCharDelay() });
  }
}

// All selectors scoped to the dialog so we never hit a comment box in the feed.
const DIALOG_SEL = 'div[role="dialog"]';
const TEXTBOX_SEL = `${DIALOG_SEL} div[role="textbox"][contenteditable="true"]`;

/**
 * Re-focus the Lexical textbox each time we need it (avoids stale handles).
 * Lexical re-creates DOM nodes on every edit, so we must never cache element refs.
 */
async function focusComposer(page) {
  await page.evaluate((sel) => {
    const box = document.querySelector(sel);
    if (!box) return;
    box.scrollIntoView({ block: 'center' });
    const p = box.querySelector('p');
    (p || box).click();
    box.focus();
  }, TEXTBOX_SEL);
  await sleep(600);
}

async function getComposerText(page) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? (el.innerText || el.textContent || '').trim() : '';
  }, TEXTBOX_SEL);
}

async function selectAllAndDelete(page) {
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.down(mod);
  await page.keyboard.press('a');
  await page.keyboard.up(mod);
  await sleep(100);
  await page.keyboard.press('Backspace');
  await sleep(400);
}

/**
 * Focuses Facebook's Lexical contenteditable composer and types text using
 * FAST clipboard paste method - instant for large posts!
 */
export async function typeIntoFacebookComposer(page, text) {
  const exists = await page.$(TEXTBOX_SEL);
  if (!exists) throw new Error('Could not find the post composer textbox.');

  console.log(`[compose] Fast paste method — inserting ${text.length} characters instantly…`);
  
  // Focus and clear composer
  await focusComposer(page);
  await selectAllAndDelete(page);
  await focusComposer(page);
  await sleep(300);

  // Use clipboard paste - INSTANT, no waiting!
  try {
    await page.evaluate(async (t) => {
      try {
        await navigator.clipboard.writeText(t);
      } catch {
        // Fallback: set via DOM if clipboard unavailable
        const el = document.querySelector('div[role="textbox"][contenteditable="true"]');
        if (el) {
          el.innerText = t;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    }, text);

    // Paste (Ctrl+V or Cmd+V)
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.down(mod);
    await page.keyboard.press('v');
    await page.keyboard.up(mod);
    await sleep(800);

    console.log('[compose] ✓ Text inserted successfully (clipboard paste method).');
  } catch (err) {
    console.error('[compose] Error during text insertion:', err.message);
    throw err;
  }
}

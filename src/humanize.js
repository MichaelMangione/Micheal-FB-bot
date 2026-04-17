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
 * multiple strategies until one succeeds.
 */
export async function typeIntoFacebookComposer(page, text) {
  const exists = await page.$(TEXTBOX_SEL);
  if (!exists) throw new Error('Could not find the post composer textbox.');

  const snippet = text.slice(0, Math.min(10, text.length));

  // --- Strategy 1: keyboard.type (most human-like) --------------------
  console.log('[compose] Strategy 1 — keyboard typing…');
  await focusComposer(page);
  for (const char of text) {
    await page.keyboard.type(char, { delay: randomCharDelay() });
  }
  await sleep(600);

  let current = await getComposerText(page);
  if (current.includes(snippet)) {
    console.log('[compose] Keyboard typing succeeded.');
    return;
  }

  // --- Strategy 2: execCommand('insertText') --------------------------
  console.log('[compose] Strategy 2 — execCommand…');
  await focusComposer(page);
  await selectAllAndDelete(page);
  await focusComposer(page);

  await page.evaluate(
    (sel, t) => {
      const el = document.querySelector(sel);
      if (el) el.focus();
      document.execCommand('insertText', false, t);
    },
    TEXTBOX_SEL,
    text
  );
  await sleep(600);

  current = await getComposerText(page);
  if (current.includes(snippet)) {
    console.log('[compose] execCommand succeeded.');
    return;
  }

  // --- Strategy 3: InputEvent dispatch --------------------------------
  console.log('[compose] Strategy 3 — InputEvent dispatch…');
  await focusComposer(page);
  await selectAllAndDelete(page);
  await focusComposer(page);

  await page.evaluate(
    (sel, t) => {
      const el = document.querySelector(sel);
      if (!el) return;
      el.focus();
      for (const ch of t) {
        el.dispatchEvent(
          new InputEvent('beforeinput', {
            inputType: 'insertText',
            data: ch,
            bubbles: true,
            cancelable: true,
            composed: true,
          })
        );
        el.dispatchEvent(
          new InputEvent('input', {
            inputType: 'insertText',
            data: ch,
            bubbles: true,
            cancelable: false,
            composed: true,
          })
        );
      }
    },
    TEXTBOX_SEL,
    text
  );
  await sleep(600);

  current = await getComposerText(page);
  if (current.includes(snippet)) {
    console.log('[compose] InputEvent dispatch succeeded.');
    return;
  }

  // --- Strategy 4: clipboard paste ------------------------------------
  console.log('[compose] Strategy 4 — clipboard paste…');
  await focusComposer(page);
  await selectAllAndDelete(page);
  await focusComposer(page);

  await page.evaluate(async (t) => {
    await navigator.clipboard.writeText(t);
  }, text);
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.down(mod);
  await page.keyboard.press('v');
  await page.keyboard.up(mod);
  await sleep(800);

  current = await getComposerText(page);
  if (current.includes(snippet)) {
    console.log('[compose] Clipboard paste succeeded.');
    return;
  }

  console.warn(
    '[compose] WARNING — none of the typing strategies confirmed text in the composer. ' +
      'The browser is still open so you can check manually.'
  );
}

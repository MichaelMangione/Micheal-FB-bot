import { sleep } from './humanize.js';

const IN_URL = 'https://2captcha.com/in.php';
const RES_URL = 'https://2captcha.com/res.php';

async function pollCaptchaResult(apiKey, taskId) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const u = new URL(RES_URL);
    u.searchParams.set('key', apiKey);
    u.searchParams.set('action', 'get');
    u.searchParams.set('id', taskId);
    u.searchParams.set('json', '1');

    const res = await fetch(u);
    const raw = await res.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      if (raw.startsWith('OK|')) return raw.slice(3);
      if (raw === 'CAPCHA_NOT_READY' || raw.includes('NOT_READY')) {
        await sleep(4000);
        continue;
      }
      throw new Error(raw);
    }

    if (data.status === 1 && data.request) {
      return typeof data.request === 'string' ? data.request : String(data.request);
    }
    const req = data.request || '';
    if (String(req).includes('NOT_READY') || req === 'CAPCHA_NOT_READY') {
      await sleep(4000);
      continue;
    }
    throw new Error(typeof req === 'string' ? req : raw);
  }
  throw new Error('2captcha: timed out waiting for solution');
}

export async function submitRecaptchaV2(apiKey, siteKey, pageUrl) {
  const u = new URL(IN_URL);
  u.searchParams.set('key', apiKey);
  u.searchParams.set('method', 'userrecaptcha');
  u.searchParams.set('googlekey', siteKey);
  u.searchParams.set('pageurl', pageUrl);
  u.searchParams.set('json', '1');

  const res = await fetch(u);
  const data = await res.json();
  if (data.status !== 1) {
    throw new Error(data.request || '2captcha: failed to create reCAPTCHA task');
  }
  return pollCaptchaResult(apiKey, data.request);
}

export async function submitImageCaptchaBase64(apiKey, base64Image) {
  const body = new URLSearchParams();
  body.set('key', apiKey);
  body.set('method', 'base64');
  body.set('body', base64Image);

  const res = await fetch(IN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  let taskId;
  if (text.startsWith('OK|')) {
    taskId = text.slice(3);
  } else {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(text);
    }
    if (data.status !== 1) throw new Error(data.request || text);
    taskId = data.request;
  }
  return pollCaptchaResult(apiKey, taskId);
}

export async function extractRecaptchaSiteKey(page) {
  return page.evaluate(() => {
    const ds = document.querySelector('[data-sitekey]');
    if (ds) return ds.getAttribute('data-sitekey');
    for (const f of document.querySelectorAll('iframe[src*="recaptcha"]')) {
      const m = f.getAttribute('src')?.match(/[?&]k=([^&]+)/);
      if (m) return decodeURIComponent(m[1]);
    }
    return null;
  });
}

export async function injectRecaptchaResponse(page, token) {
  await page.evaluate((t) => {
    const setVal = (el) => {
      if (!el) return;
      el.value = t;
      el.textContent = t;
      el.innerHTML = t;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setVal(document.getElementById('g-recaptcha-response'));
    document.querySelectorAll('textarea[name="g-recaptcha-response"]').forEach(setVal);
  }, token);
}

async function imageUrlToBase64(page, src) {
  return page.evaluate(async (url) => {
    const r = await fetch(url, { credentials: 'include' });
    const buf = await r.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }, src);
}

async function findCaptchaImageSrc(page) {
  return page.evaluate(() => {
    const imgs = [...document.querySelectorAll('img')];
    for (const img of imgs) {
      const s = (img.currentSrc || img.src || '').toLowerCase();
      if (!s) continue;
      if (s.includes('captcha') || s.includes('captcha_image') || s.includes('security_check')) {
        return img.currentSrc || img.src;
      }
    }
    return null;
  });
}

/**
 * Detects reCAPTCHA v2 or a simple image CAPTCHA and submits to 2captcha.
 * Returns true if something was solved, false if no CAPTCHA was found.
 */
export async function detectAndSolveCaptcha(page, apiKey) {
  const isTransientNavError = (err) => {
    const msg = String(err?.message || err || '').toLowerCase();
    return (
      msg.includes('execution context was destroyed') ||
      msg.includes('cannot find context with specified id') ||
      msg.includes('navigating frame was detached') ||
      msg.includes('target closed') ||
      msg.includes('protocol error')
    );
  };

  if (!apiKey) {
    console.warn('[captcha] CAPTCHA_API_KEY is empty — cannot solve CAPTCHA.');
    return false;
  }

  console.log('[captcha] Checking for CAPTCHA…');
  await sleep(500);

  let siteKey = null;
  try {
    siteKey = await extractRecaptchaSiteKey(page);
  } catch (err) {
    if (isTransientNavError(err)) {
      console.log('[captcha] Navigation in progress while checking reCAPTCHA. Skipping this round.');
      return false;
    }
    throw err;
  }
  if (siteKey) {
    console.log('[captcha] reCAPTCHA v2 detected; sending to 2captcha…');
    const token = await submitRecaptchaV2(apiKey, siteKey, page.url());
    await injectRecaptchaResponse(page, token);
    console.log('[captcha] reCAPTCHA response injected.');
    return true;
  }

  let imgSrc = null;
  try {
    imgSrc = await findCaptchaImageSrc(page);
  } catch (err) {
    if (isTransientNavError(err)) {
      console.log('[captcha] Navigation in progress while checking image CAPTCHA. Skipping this round.');
      return false;
    }
    throw err;
  }
  if (imgSrc) {
    console.log('[captcha] Image CAPTCHA detected; sending to 2captcha…');
    let b64;
    try {
      b64 = await imageUrlToBase64(page, imgSrc);
    } catch {
      const handle = await page.$('img[src*="captcha"], img[alt*="CAPTCHA" i]');
      if (handle) {
        b64 = await handle.screenshot({ encoding: 'base64' });
      } else {
        throw new Error('Could not read CAPTCHA image');
      }
    }
    const text = await submitImageCaptchaBase64(apiKey, b64);
    let filled = false;
    try {
      filled = await page.evaluate((solution) => {
        const inputs = [
          ...document.querySelectorAll('input[name*="captcha" i]'),
          ...document.querySelectorAll('input[id*="captcha" i]'),
          ...document.querySelectorAll('input[type="text"]'),
        ];
        const visible = inputs.find((el) => {
          const st = window.getComputedStyle(el);
          return st.display !== 'none' && st.visibility !== 'hidden' && el.offsetParent !== null;
        });
        if (visible) {
          visible.value = solution;
          visible.dispatchEvent(new Event('input', { bubbles: true }));
          visible.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        return false;
      }, text);
    } catch (err) {
      if (isTransientNavError(err)) {
        console.log('[captcha] Navigation changed before CAPTCHA answer could be injected.');
        return false;
      }
      throw err;
    }
    if (!filled) {
      console.warn('[captcha] Could not find a text field for image CAPTCHA solution.');
    } else {
      console.log('[captcha] Image CAPTCHA solution entered.');
    }
    return true;
  }

  return false;
}

/**
 * Repeatedly solves CAPTCHA while present (e.g. after navigation or challenge).
 */
export async function resolveCaptchasUntilClear(page, apiKey, { maxRounds = 5 } = {}) {
  if (!apiKey?.trim()) return;
  for (let i = 0; i < maxRounds; i++) {
    const found = await detectAndSolveCaptcha(page, apiKey);
    if (!found) return;
    await sleep(2000);
    let still = null;
    try {
      still = (await extractRecaptchaSiteKey(page)) || (await findCaptchaImageSrc(page));
    } catch {
      return;
    }
    if (!still) return;
  }
}

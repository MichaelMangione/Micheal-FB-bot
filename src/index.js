import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';

import {
  CAPTCHA_API_KEY,
  FB_EMAIL,
  FB_PASSWORD,
  HEADLESS,
  POST_IMAGE_DIR,
  PAUSE_AFTER_COMPOSE_MS,
  RESET_POSTS,
  SKIP_POST,
  TARGET_GROUP_URLS,
  USER_AGENT,
  USER_DATA_DIR,
  WAIT_FOR_ENTER_BEFORE_CLOSE,
  SESSION_FILE,
  validateConfig,
} from './config.js';

import { resolveCaptchasUntilClear } from './captcha.js';
import { randomStepDelay, randomMouseMove, sleep, typeIntoFacebookComposer } from './humanize.js';
import { pickImageByPostId } from './media.js';
import {
  loadPosts,
  loadScheduleConfig,
  loadPostingState,
  canPostAccordingToLimit,
  getNextPost,
  updateStateAfterPost,
  formatDelay,
} from './scheduler.js';
import {
  loadSessionFromDisk,
  collectFacebookCookies,
  waitUntilLoggedIn,
  ensureFreshLogin,
  isLoginOrCheckpointUrl,
  hasUserCookie,
  waitForEnter,
} from './session.js';

const timers = new Map();

function startTimer(label) {
  timers.set(label, Date.now());
  console.log(`⏱️  [timer] ${label} started`);
}

function endTimer(label) {
  const startedAt = timers.get(label);
  if (!startedAt) return;
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
  console.log(`✓ [timer] ${label} - took ${elapsed}s`);
  timers.delete(label);
}

async function saveSessionCookies(pageOrCookies) {
  const cookies = Array.isArray(pageOrCookies)
    ? pageOrCookies
    : pageOrCookies?.cookies
      ? await pageOrCookies.cookies()
      : [];
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(cookies, null, 2), 'utf8');
  } catch (err) {
    console.warn('[session] Failed to save cookies:', err.message);
  }
}

async function restoreSessionCookies(page) {
  const cookies = await loadSessionFromDisk();
  if (cookies?.length) {
    try {
      await page.setCookie(...cookies);
    } catch (err) {
      console.warn('[session] Cookie restore warning:', err.message);
    }
  }
}

async function isLoggedInState(page) {
  try {
    const cookies = await page.cookies();
    const hasUser = hasUserCookie(cookies);
    const url = page.url();
    const isLoginPage = isLoginOrCheckpointUrl(url);
    const loggedIn = hasUser && !isLoginPage;
    
    if (!loggedIn) {
      console.log(`[isLoggedInState-debug] hasUserCookie=${hasUser}, isLoginPage=${isLoginPage}, url=${url}`);
    }
    
    return loggedIn;
  } catch (err) {
    console.log(`[isLoggedInState-error] ${err.message}`);
    return false;
  }
}

async function isPageAlive(page) {
  try {
    return !!page && !page.isClosed() && typeof page.url === 'function';
  } catch {
    return false;
  }
}

async function autoLoginIfNeeded(page) {
  const transientError = (err) => {
    const msg = String(err?.message || err || '').toLowerCase();
    return (
      msg.includes('execution context was destroyed') ||
      msg.includes('navigating frame was detached') ||
      msg.includes('cannot find context') ||
      msg.includes('target closed')
    );
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log('[login] ====== AUTO-LOGIN ATTEMPT ======');
      if (await isLoggedInState(page)) {
        console.log('[login] Already logged in.');
        return true;
      }

      const tryClick = async (selectors) => {
        for (const selector of selectors) {
          const handle = await page.$(selector);
          if (handle) {
            try {
              await handle.click();
              console.log(`[login] ✓ Clicked: ${selector}`);
              return true;
            } catch (err) {
              console.log(`[login] ✗ Click failed for ${selector}: ${err.message}`);
              /* continue */
            }
          }
        }
        console.log(`[login] ✗ No clickable button found from: ${selectors.join(', ')}`);
        return false;
      };
      
      const tryClickByText = async (textPatterns) => {
        for (const pattern of textPatterns) {
          const found = await page.evaluate((text) => {
            const elements = document.querySelectorAll('div, button, a, [role="button"]');
            for (const el of elements) {
              if (el.textContent && el.textContent.toLowerCase().includes(text.toLowerCase())) {
                // Make sure it's visible
                const rect = el.getBoundingClientRect();
                if (rect.width > 5 && rect.height > 5) {
                  el.click();
                  return true;
                }
              }
            }
            return false;
          }, pattern);
          
          if (found) {
            console.log(`[login] ✓ Clicked by text: "${pattern}"`);
            return true;
          }
        }
        console.log(`[login] ✗ No clickable element found with text: ${textPatterns.join(', ')}`);
        return false;
      };

      console.log('[login] ====== STEP 1: Looking for Email Field ======');
      const emailField = await page.$('input[name="email"], input[type="email"], #email');
      if (emailField) {
        await emailField.click({ clickCount: 3 });
        await sleep(300);
        await page.keyboard.type(FB_EMAIL, { delay: 60 });
        console.log('[login] ✓ Email field filled');
        await sleep(500);
        await tryClick(['button[name="login"]', 'button[type="submit"]', 'div[role="button"][aria-label*="Continue" i]']);
        await sleep(2500);  // Wait for password field to load
      } else {
        console.log('[login] Email field not immediately visible');
      }

      console.log('[login] ====== STEP 2: Looking for Continue Button ======');
      // Try selectors first, then text-based fallback
      let continueClicked = await tryClick([
        'button[name="login"]',
        'button[type="submit"]',
        'div[role="button"][aria-label*="Continue" i]',
        'div[role="button"][aria-label*="Log In" i]',
      ]);
      
      if (!continueClicked) {
        console.log('[login] Selector-based continue failed, trying text-based...');
        continueClicked = await tryClickByText(['Continue', 'Next', 'Log in']);
      }
      
      await sleep(2000);  // Wait for password field to appear

      console.log('[login] ====== STEP 3: Looking for Password Field ======');
      const passwordField = await page.$('input[name="pass"], input[type="password"], #pass');
      if (passwordField) {
        await passwordField.click({ clickCount: 3 });
        await sleep(300);
        await page.keyboard.type(FB_PASSWORD, { delay: 60 });
        console.log('[login] ✓ Password field filled');
        await sleep(800);
        
        // Try multiple methods to submit the form
        let formSubmitted = false;
        
        // Method 1: Try pressing Enter key
        try {
          await page.keyboard.press('Enter');
          console.log('[login] ✓ Submitted form via Enter key');
          formSubmitted = true;
        } catch {
          console.log('[login] Enter key submit failed');
        }
        
        // Method 2: If Enter didn't work, try the login button by selector
        if (!formSubmitted) {
          const loginClicked = await tryClick([
            'button[name="login"]',
            'button[type="submit"]',
            'div[role="button"][aria-label*="Log In" i]',
            'button[aria-label*="Log In" i]',
            'div[data-testid="login_button"]'
          ]);
          
          if (loginClicked) {
            console.log('[login] ✓ Form submitted via button click');
            formSubmitted = true;
          }
        }
        
        // Method 3: If selectors didn't work, try text-based
        if (!formSubmitted) {
          console.log('[login] Selector-based login failed, trying text-based...');
          const loginByText = await tryClickByText(['Log in', 'Log In', 'Continue']);
          if (loginByText) {
            console.log('[login] ✓ Form submitted via text-based click');
            formSubmitted = true;
          }
        }

        if (formSubmitted) {
          console.log('[login] Waiting for page to load after login (max 15s)...');
          // Wait for navigation or page to load new content
          await Promise.race([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => console.log('[login] No navigation detected')),
            page.waitForFunction(() => !document.querySelector('input[name="email"]') && !document.querySelector('input[name="pass"]'), { timeout: 15000 }).catch(() => console.log('[login] Form fields still present')),
            sleep(8000)
          ]);
          
          // Check if we're on a two-step verification page (reCAPTCHA security checkpoint)
          await sleep(1000);
          const pageUrl = page.url();
          if (pageUrl.includes('two_step_verification') || pageUrl.includes('checkpoint')) {
            console.log(`[login] ⚠️ Two-step verification required! URL: ${pageUrl}`);
            console.log('[login] Waiting for reCAPTCHA to load...');
            
            // Wait for reCAPTCHA to appear
            try {
              await page.waitForFunction(
                () => {
                  // Check for reCAPTCHA or Google frame
                  const hasRecaptcha = !!document.querySelector('[data-sitekey]') || 
                                      !!document.querySelector('iframe[src*="recaptcha"]') ||
                                      !!document.querySelector('[class*="recaptcha"]');
                  return hasRecaptcha;
                },
                { timeout: 5000 }
              ).catch(() => console.log('[login] reCAPTCHA load timeout, attempting solve anyway...'));
            } catch {
              // Continue anyway
            }
            
            console.log('[login] Attempting to solve reCAPTCHA...');
            
            // Try to solve any reCAPTCHA on this page
            try {
              const captchaSolved = await resolveCaptchasUntilClear(page, CAPTCHA_API_KEY);
              if (captchaSolved) {
                console.log('[login] ✓ reCAPTCHA solved, waiting for verification...');
                // Wait for page to navigate after CAPTCHA solution
                await Promise.race([
                  page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
                  sleep(5000)
                ]);
              } else {
                console.log('[login] ⚠️ No reCAPTCHA detected on verification page');
              }
            } catch (captchaErr) {
              console.warn(`[login] CAPTCHA solving error: ${captchaErr.message}`);
            }
          }
          
          // Check if we successfully logged in
          const stillOnLogin = !!(await page.$('input[name="email"], input[name="pass"]'));
          console.log(`[login] After login wait - still on login form: ${stillOnLogin}`);
        } else {
          console.log('[login] ⚠️ Could not submit login form by any method');
        }
      } else {
        console.log('[login] No password field found - page state unclear');
      }

      await sleep(2000);
      console.log('[login] ====== AUTO-LOGIN COMPLETE ======');
      return isLoggedInState(page);
    } catch (err) {
      if (!transientError(err) || attempt === 3) throw err;
      console.warn(`[login] Transient page reset during login (attempt ${attempt}/3). Retrying...`);
      await sleep(1500);
    }
  }

  return false;
}

async function openGroupComposer(page) {
  await randomMouseMove(page);
  
  // CRITICAL: Check if we're on a login page - this explains why composer can't be found
  const pageUrl = page.url();
  if (pageUrl.includes('/login') || pageUrl.includes('/login.php')) {
    console.error(`[composer] ❌ CRITICAL: On login page, not group page! URL: ${pageUrl}`);
    throw new Error('Still on Facebook login page - session may have expired or login failed.');
  }

  const openers = [
    // Current Facebook selectors (2024+)
    'div[role="button"][aria-label*="Create a post" i]',
    'div[role="button"][aria-label*="Write something" i]',
    'div[role="button"][aria-label*="Create post" i]',
    'div[role="button"][aria-label*="What\'s on your mind" i]',
    'div[data-placer*="composer" i]',
    '[data-testid="create_post_button"]',
    '[data-testid="status_composer_container"] [role="button"]',
    'a[aria-label*="Create a post" i]',
    'button[aria-label*="Create a post" i]',
  ];

  // Composer can be slow to render in some groups, so retry many times.
  for (let attempt = 1; attempt <= 5; attempt++) {
    const alreadyOpen = await page.$('[role="dialog"] [role="textbox"], [role="dialog"] div[contenteditable="true"]');
    if (alreadyOpen) return;

    // Debug: Check page state on first attempt
    if (attempt === 1) {
      const pageUrl = page.url();
      const buttonCount = await page.$$eval('[role="button"]', els => els.length).catch(() => 0);
      const divCount = await page.$$eval('div[role="button"]', els => els.length).catch(() => 0);
      console.log(`[composer-debug] URL: ${pageUrl}, total [role="button"]: ${buttonCount}, div[role="button"]: ${divCount}`);
      
      // Log what text-based buttons we see
      const visibleButtons = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('[role="button"], button'));
        return buttons.slice(0, 10).map(b => ({
          aria: b.getAttribute('aria-label'),
          textSnippet: (b.textContent || '').substring(0, 30).trim(),
          testid: b.getAttribute('data-testid')
        }));
      });
      console.log(`[composer-debug] Sample buttons:`, JSON.stringify(visibleButtons, null, 2));
    }

    // Try selector-based approach
    for (const selector of openers) {
      const el = await page.$(selector);
      if (el) {
        try {
          await el.click();
          await sleep(900);
        } catch {
          /* continue */
        }
      }
    }

    // Fallback 1: Click by visible text in larger buttons/divs
    await page.evaluate(() => {
      const candidates = [
        'create a post',
        'write something',
        "what's on your mind",
        'share with your friends',
        'create post',
        'share a post'
      ];
      
      // Find all interactive elements
      const elements = document.querySelectorAll('[role="button"], button, [role="menuitem"], a, div[tabindex="0"]');
      for (const el of elements) {
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        const text = (el.textContent || '').toLowerCase().trim();
        const dataTestId = (el.getAttribute('data-testid') || '').toLowerCase();
        
        // Check if this looks like a composer button
        if (candidates.some((w) => aria.includes(w) || text.includes(w) || dataTestId.includes('composer'))) {
          // Make sure it's visible and clickable
          const rect = el.getBoundingClientRect();
          if (rect.width > 10 && rect.height > 10) {
            el.click();
            break;
          }
        }
      }
    });

    await sleep(500);

    // Fallback 2: Look for status composer container and click inside it
    const composerFound = await page.evaluate(() => {
      const composer = document.querySelector('[data-testid="status_composer_container"]') ||
                       document.querySelector('[data-testid="create_post_button"]') ||
                       document.querySelector('[role="region"]');
      if (composer) {
        // Try to find and click any button inside
        const btns = composer.querySelectorAll('[role="button"], button');
        if (btns.length > 0) {
          btns[0].click();
          return true;
        }
      }
      return false;
    });
    
    if (composerFound) {
      await sleep(800);
    }

    try {
      await page.waitForFunction(
        () => !!document.querySelector('[role="dialog"] [role="textbox"], [role="dialog"] div[contenteditable="true"]'),
        { timeout: 6000 }
      );
      return;
    } catch {
      console.log(`[composer] Attempt ${attempt}/5 failed, retrying...`);
      await sleep(1500);
    }
  }

  throw new Error('Could not open the Facebook composer.');
}

async function getDialogComposerText(page) {
  return page.evaluate(() => {
    const box = document.querySelector('div[role="dialog"] div[role="textbox"][contenteditable="true"]');
    if (!box) return '';
    return (box.innerText || box.textContent || '').trim();
  });
}

async function ensureComposerHasText(page, text, groupIndex) {
  const tag = `[group ${groupIndex}]`;
  const snippet = (text || '').slice(0, 20).toLowerCase();

  let current = (await getDialogComposerText(page)).toLowerCase();
  if (snippet && current.includes(snippet)) return true;

  console.log(`${tag} ⚠️ Composer text missing before submit. Retrying type once...`);
  await typeIntoFacebookComposer(page, text);
  await sleep(1000);

  current = (await getDialogComposerText(page)).toLowerCase();
  const ok = snippet && current.includes(snippet);
  if (!ok) {
    throw new Error('Composer text not detected after retry; aborting submit to avoid image-only post.');
  }
  return true;
}

async function hasComposerImage(page) {
  return page.evaluate(() => {
    // Prefer the active composer dialog (the one that has the textbox).
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    const dialog = dialogs.find((d) => d.querySelector('[role="textbox"]')) || dialogs[0] || null;
    if (!dialog) return false;

    // Most reliable: a file input inside composer currently has selected files.
    for (const input of dialog.querySelectorAll('input[type="file"]')) {
      if (input.files && input.files.length > 0) return true;
    }

    // Fallback 1: image nodes/URLs in composer.
    for (const img of dialog.querySelectorAll('img')) {
      const src = img.src || '';
      if (src.startsWith('blob:') || src.startsWith('data:') || src.includes('scontent')) return true;
    }

    // Fallback 2: background-image previews.
    for (const el of dialog.querySelectorAll('[style]')) {
      const bg = el.style.backgroundImage || '';
      if (bg.includes('blob:') || bg.includes('scontent')) return true;
    }

    // Fallback 3: attachment action controls Facebook shows when media exists.
    return !!(
      dialog.querySelector('[aria-label*="Remove photo" i]') ||
      dialog.querySelector('[aria-label*="Edit photo" i]') ||
      dialog.querySelector('[aria-label*="Edit all" i]') ||
      dialog.querySelector('[data-testid*="photo"]')
    );
  });
}

async function ensureComposerHasImage(page, imagePath, groupIndex) {
  const tag = `[group ${groupIndex}]`;
  // Give Facebook a moment to render the attachment state before re-uploading.
  await sleep(1500);
  if (await hasComposerImage(page)) return true;

  console.log(`${tag} ⚠️ Image missing before submit. Retrying image upload once...`);
  const retryOk = await uploadImageToComposer(page, imagePath, groupIndex);
  await sleep(1200);
  if (!retryOk || !(await hasComposerImage(page))) {
    throw new Error('Image not detected in composer after retry; aborting submit to avoid text-only post.');
  }
  return true;
}

async function waitForImageUploadToSettle(page, groupIndex) {
  const tag = `[group ${groupIndex}]`;
  try {
    await page.waitForFunction(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return true;
      const busy =
        !!dialog.querySelector('[aria-label*="Uploading" i]') ||
        !!dialog.querySelector('[aria-label*="Processing" i]') ||
        !!dialog.querySelector('[role="progressbar"]');
      return !busy;
    }, { timeout: 12000 });
    console.log(`${tag} ✅ Image upload settled`);
  } catch {
    console.log(`${tag} ⚠️ Image settling timeout; proceeding`);
  }
}

async function uploadImageToComposer(groupPage, imagePath, groupIndex) {
  const tag = `[group ${groupIndex}]`;
  console.log(`${tag} 🖼️  Starting image upload: ${imagePath}`);

  if (!fs.existsSync(imagePath)) {
    console.log(`${tag} ❌ File does not exist: ${imagePath}`);
    return false;
  }

  const inputsBefore = await groupPage.$$eval('input[type="file"]', (els) => els.length);
  console.log(`${tag} File inputs before photo click: ${inputsBefore}`);

  // Preferred path: handle native file chooser directly.
  const chooserSelectors = [
    '[role="dialog"] [role="button"][aria-label*="photo" i]',
    '[role="dialog"] [role="button"][aria-label*="image" i]',
    '[role="dialog"] button[aria-label*="photo" i]',
    '[role="dialog"] button[aria-label*="image" i]',
    'div[role="button"][aria-label*="photo" i]',
    'div[role="button"][aria-label*="image" i]',
  ];

  for (const selector of chooserSelectors) {
    const btn = await groupPage.$(selector);
    if (!btn) continue;
    try {
      const chooserPromise = groupPage.waitForFileChooser({ timeout: 2500 });
      await btn.click();
      const chooser = await chooserPromise;
      await chooser.accept([imagePath]);
      console.log(`${tag} ✅ File chooser accepted via selector: ${selector}`);

      await groupPage.screenshot({ path: './debug_after_upload.png', fullPage: false });
      
      // Just verify the browser accepted the file (file input has value)
      // Visual preview rendering is unpredictable; file acceptance is the key signal
      const fileAccepted = await groupPage.evaluate(() => {
        return document.querySelectorAll('input[type="file"]').length > 0;
      });
      
      if (fileAccepted) {
        console.log(`${tag} ✅ File chooser accepted and file input exists`);
        await sleep(2000); // Brief pause for preview to start rendering
        return true;
      } else {
        console.log(`${tag} ❌ File input disappeared after chooser accept`);
        return false;
      }
    } catch {
      // Not the right button for file chooser; continue trying others.
    }
  }

  let photoClicked = false;

  try {
    const clicked = await groupPage.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return false;
      for (const btn of dialog.querySelectorAll('[role="button"], button')) {
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        if (aria.includes('photo') || aria.includes('image')) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    if (clicked) {
      photoClicked = true;
      console.log(`${tag} ✅ Method 1: dialog photo button clicked`);
    }
  } catch {
    /* continue */
  }

  if (!photoClicked) {
    try {
      const found = await groupPage.evaluate(() => {
        const textbox = document.querySelector('[role="textbox"]');
        if (!textbox) return false;
        let container = textbox;
        for (let i = 0; i < 10; i++) {
          container = container.parentElement;
          if (!container) break;
          for (const btn of container.querySelectorAll('[role="button"], button')) {
            const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
            const title = (btn.getAttribute('title') || '').toLowerCase();
            if (aria.includes('photo') || aria.includes('image') || title.includes('photo') || title.includes('image')) {
              btn.click();
              return true;
            }
          }
        }
        return false;
      });
      if (found) {
        photoClicked = true;
        console.log(`${tag} ✅ Method 2: textbox-parent button clicked`);
      }
    } catch {
      /* continue */
    }
  }

  if (!photoClicked) {
    try {
      const clicked = await groupPage.evaluate(() => {
        for (const elem of document.querySelectorAll('[role="button"], button, [role="menuitem"]')) {
          const aria = (elem.getAttribute('aria-label') || '').toLowerCase();
          const title = (elem.getAttribute('title') || '').toLowerCase();
          if (aria.includes('photo') || aria.includes('image') || title.includes('photo') || title.includes('image')) {
            elem.click();
            return true;
          }
        }
        return false;
      });
      if (clicked) {
        photoClicked = true;
        console.log(`${tag} ✅ Method 3: global sweep clicked`);
      }
    } catch {
      /* continue */
    }
  }

  if (!photoClicked) {
    console.log(`${tag} ❌ Could not find photo button — skipping image`);
    return false;
  }

  try {
    await groupPage.waitForFunction(
      (countBefore) => document.querySelectorAll('input[type="file"]').length > countBefore,
      { timeout: 8000 },
      inputsBefore
    );
    console.log(`${tag} ✅ New file input appeared`);
  } catch (e) {
    console.log(`${tag} ⚠️  No new file input appeared: ${e.message}`);
  }

  await sleep(500);

  const allInputs = await groupPage.$$('input[type="file"]');
  const inputsAfter = allInputs.length;
  console.log(`${tag} File inputs after photo click: ${inputsAfter}`);

  if (!inputsAfter) {
    console.log(`${tag} ❌ No file inputs available after clicking photo`);
    return false;
  }

  const composerInput = allInputs[inputsAfter - 1];

  try {
    await composerInput.uploadFile(imagePath);
    console.log(`${tag} ✅ uploadFile() on composer input (index ${inputsAfter})`);

    await groupPage.screenshot({ path: './debug_after_upload.png', fullPage: false });

    // Don't wait for visual preview; instead, verify the file was accepted by the input
    // Facebook's preview rendering timing is unreliable; file acceptance is the signal
    const hasFileValue = await groupPage.evaluate(() => {
      for (const input of document.querySelectorAll('input[type="file"]')) {
        if (input.files && input.files.length > 0) {
          return true;
        }
      }
      return false;
    });

    if (hasFileValue) {
      console.log(`${tag} ✅ Image file accepted by input element`);
      await sleep(2000); // Brief pause for preview to start rendering
      return true;
    } else {
      console.log(`${tag} ❌ File input has no value after uploadFile()`);
      return false;
    }
  } catch (err) {
    console.log(`${tag} ❌ Upload failed: ${err.message}`);
    return false;
  }
}

async function submitPost(page, { requireImage = false, imagePath = null, groupIndex = null } = {}) {
  const tag = groupIndex ? `[group ${groupIndex}]` : '[submit]';

  const waitForSubmitSignal = async () => {
    try {
      // Give server time to process the click
      await sleep(800);

      const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => null);
      const uiPromise = page.waitForFunction(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const bodyText = (document.body?.innerText || '').toLowerCase();

        // Success signal 1: composer dialog closed after submit.
        const dialogClosed = !dialog;

        // Success signal 2: Additional success text Facebook shows
        const hasPostedSignal =
          bodyText.includes('your post is pending') ||
          bodyText.includes('post submitted') ||
          bodyText.includes('post sent for review') ||
          bodyText.includes('your post is live') ||
          bodyText.includes('post has been published') ||
          bodyText.includes('ready to share') ||
          bodyText.includes('shared with');

        // Success signal 3: Check if dialog content changed (processing state)
        const postButton = dialog ? dialog.querySelector('[role="button"][aria-label="Post"]') : null;
        const buttonDisabledOrHidden = postButton && (
          postButton.getAttribute('aria-disabled') === 'true' ||
          postButton.style.display === 'none' ||
          postButton.offsetHeight === 0
        );

        // Log state every second for debugging
        if (window.__submitCheckCounter === undefined) window.__submitCheckCounter = 0;
        if (window.__submitCheckCounter % 5 === 0) {
          console.log(`[submit-check] dialogClosed=${dialogClosed}, hasPostedSignal=${hasPostedSignal}, buttonDisabled=${!!buttonDisabledOrHidden}`);
        }
        window.__submitCheckCounter++;

        return dialogClosed || hasPostedSignal || buttonDisabledOrHidden;
      }, { timeout: 12000 }).catch((err) => {
        console.log('[submit-check] waitForFunction timeout:', err.message);
        return null;
      });

      const result = await Promise.race([navPromise, uiPromise]);
      console.log('[submit-check] Promise.race completed');

      // Final check in current context
      const confirmed = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const bodyText = (document.body?.innerText || '').toLowerCase();
        const postButton = dialog ? dialog.querySelector('[role="button"][aria-label="Post"]') : null;
        const buttonDisabledOrHidden = postButton && (
          postButton.getAttribute('aria-disabled') === 'true' ||
          postButton.style.display === 'none' ||
          postButton.offsetHeight === 0
        );
        
        const success = (
          !dialog ||
          bodyText.includes('your post is pending') ||
          bodyText.includes('post submitted') ||
          bodyText.includes('post sent for review') ||
          bodyText.includes('your post is live') ||
          bodyText.includes('post has been published') ||
          bodyText.includes('ready to share') ||
          bodyText.includes('shared with') ||
          buttonDisabledOrHidden
        );

        console.log(`[submit-final-check] dialog=${!!dialog}, success=${success}`);
        return success;
      });

      if (confirmed) {
        console.log('[submit-signal] ✓ Submit confirmation received');
        return true;
      } else {
        console.log('[submit-signal] ⚠️ No submit confirmation detected');
        return false;
      }
    } catch (err) {
      const msg = String(err?.message || '').toLowerCase();
      console.log('[submit-signal] Exception during wait:', msg);
      // Facebook often destroys execution context right after successful submit
      if (msg.includes('execution context was destroyed') || msg.includes('navigating frame was detached')) {
        console.log('[submit-signal] ✓ Context destroyed (likely successful submit)');
        return true;
      }
      return false;
    }
  };

  const clickPrimaryPostButton = async () => {
    // First try: exact aria-label match
    const exact = await page.$('[role="dialog"] [role="button"][aria-label="Post"]');
    if (exact) {
      try {
        await exact.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
        await exact.click({ delay: 60 });
        console.log('[submit-debug] ✓ Clicked via exact aria-label selector');
        return true;
      } catch (e) {
        console.log('[submit-debug] Exact selector found but click failed:', e.message);
      }
    }

    // Fallback: comprehensive DOM analysis
    const result = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const logs = [];
      
      if (!dialog) {
        logs.push('No dialog found');
        return { success: false, reason: 'no_dialog', logs };
      }

      const all = Array.from(dialog.querySelectorAll('[role="button"], button'));
      logs.push(`Found ${all.length} total buttons in dialog`);

      const candidates = [];
      const visibleButtons = [];
      
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        const txt = (el.textContent || '').trim();
        const txtLower = txt.toLowerCase();
        const aria = (el.getAttribute('aria-label') || '').trim();
        const ariaLower = aria.toLowerCase();
        const rect = el.getBoundingClientRect();
        const disabled = el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled');
        const hidden = rect.width < 8 || rect.height < 8 || el.offsetParent === null;

        // Log all buttons with substantial size
        if (!hidden) {
          const btnInfo = `[button ${i}] text="${txt}", aria="${aria}", size=${Math.round(rect.width)}x${Math.round(rect.height)}, disabled=${disabled}`;
          logs.push(btnInfo);
          visibleButtons.push({ i, txt, aria, disabled });
        }

        // Strategy 1: Direct text/aria match for "Post"
        const isPost = 
          txtLower === 'post' || 
          ariaLower === 'post' || 
          ariaLower.includes('post');
        
        if (isPost && !disabled && !hidden) {
          candidates.push({ 
            el, 
            bottom: rect.bottom, 
            right: rect.right,
            width: rect.width,
            height: rect.height,
            text: txt,
            aria: aria,
            strategy: 'direct-post-match'
          });
        }
      }

      if (candidates.length > 0) {
        // Primary action is typically the bottom-right Post button
        candidates.sort((a, b) => (b.bottom - a.bottom) || (b.right - a.right));
        const target = candidates[0].el;
        logs.push(`Found ${candidates.length} Post button candidate(s), clicking: text="${candidates[0].text}", strategy=${candidates[0].strategy}`);
        
        try {
          target.scrollIntoView({ block: 'center', inline: 'center' });
          target.click();
          logs.push('✓ Post button click succeeded');
          return { success: true, reason: 'post_button_clicked', logs };
        } catch (e) {
          logs.push(`✗ Click failed: ${e.message}`);
          return { success: false, reason: 'click_failed', error: e.message, logs };
        }
      }

      // Strategy 2: If no "Post" button found, try the bottom-right action button
      logs.push('No Post button found, trying bottom-right strategy...');
      const allEnabled = [];
      for (const el of all) {
        const disabled = el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled');
        const rect = el.getBoundingClientRect();
        const hidden = rect.width < 8 || rect.height < 8 || el.offsetParent === null;
        
        if (!disabled && !hidden) {
          allEnabled.push({ el, bottom: rect.bottom, right: rect.right, text: (el.textContent || '').trim() });
        }
      }

      if (allEnabled.length > 0) {
        // Bottom-right button is typically the primary action
        allEnabled.sort((a, b) => (b.bottom - a.bottom) || (b.right - a.right));
        const target = allEnabled[0].el;
        logs.push(`Clicking bottom-right button: text="${allEnabled[0].text}"`);
        
        try {
          target.scrollIntoView({ block: 'center', inline: 'center' });
          target.click();
          logs.push('✓ Bottom-right button click succeeded');
          return { success: true, reason: 'bottom_right_button', logs };
        } catch (e) {
          logs.push(`✗ Bottom-right click failed: ${e.message}`);
          return { success: false, reason: 'bottom_right_failed', error: e.message, logs };
        }
      }

      logs.push(`No enabled buttons found. Visible buttons: ${visibleButtons.map(b => `"${b.txt}"`).join(', ') || 'none'}`);
      return { success: false, reason: 'no_enabled_buttons', logs };
    });

    // Log everything returned from page.evaluate
    if (result.logs && Array.isArray(result.logs)) {
      for (const logMsg of result.logs) {
        console.log(`[submit-debug] ${logMsg}`);
      }
    }

    if (!result.success) {
      console.log(`[submit-debug] Button click failed: ${result.reason}`, result.error || '');
    }
    return result.success;
  };

  const ensureImageAtSubmit = async () => {
    if (!requireImage) return true;
    if (await hasComposerImage(page)) return true;
    await sleep(1200);
    if (await hasComposerImage(page)) return true;
    if (imagePath && groupIndex) {
      console.log(`${tag} ⚠️ Image missing at submit; re-attaching once...`);
      const uploaded = await uploadImageToComposer(page, imagePath, groupIndex);
      if (uploaded) {
        await waitForImageUploadToSettle(page, groupIndex);
      }
      return hasComposerImage(page);
    }
    return false;
  };

  for (let attempt = 1; attempt <= 4; attempt++) {
    const imageReady = await ensureImageAtSubmit();
    if (!imageReady) {
      throw new Error('Image missing at submit time; aborting to avoid text-only post.');
    }

    console.log(`${tag} Attempt ${attempt}: Clicking post button...`);
    const clicked = await clickPrimaryPostButton();
    
    if (!clicked) {
      // Try keyboard shortcut if click fails
      console.log(`${tag} ⚠️ Primary click failed (no button found), trying keyboard...`);
      try {
        // Tab to next button + Enter
        await page.keyboard.press('Tab');
        await sleep(300);
        await page.keyboard.press('Enter');
        await sleep(800);
      } catch (e) {
        console.log(`${tag} ⚠️ Keyboard attempt failed: ${e.message}`);
        if (attempt >= 4) {
          throw new Error('Could not find enabled primary Post button in composer dialog.');
        }
        await sleep(1500);
        continue;
      }
    } else {
      // Button was clicked, wait before checking
      const waitDuration = attempt === 1 ? 2500 : 2000;
      await sleep(waitDuration);
    }
    
    const ok = await waitForSubmitSignal();
    if (ok) {
      console.log(`${tag} ✓ Post submitted successfully on attempt ${attempt}`);
      return true;
    }

    if (attempt < 4) {
      console.log(`${tag} ⚠️ Submit not confirmed on attempt ${attempt}, retrying...`);
      // Between attempts, check dialog state and wait
      const dialogExists = await page.evaluate(() => !!document.querySelector('[role="dialog"]'));
      if (dialogExists) {
        console.log(`${tag} Dialog still open, preparing for retry...`);
        await sleep(1500);
      } else {
        // Dialog closed but we didn't detect it properly
        console.log(`${tag} ℹ️ Dialog closed between checks - success`);
        return true;
      }
    } else {
      console.log(`${tag} ⚠️ Max attempts reached, checking final state...`);
      // Final check: maybe dialog closed but signal wasn't detected
      const dialogExists = await page.evaluate(() => !!document.querySelector('[role="dialog"]'));
      if (!dialogExists) {
        console.log(`${tag} ✓ Dialog closed (success by default)`);
        return true;
      }
    }
  }

  throw new Error('Post click did not produce a submit confirmation (dialog still open).');
}

async function navigateToGroupWithRetry(page, url, groupIndex) {
  const label = `[group ${groupIndex}]`;
  const attempts = [
    { waitUntil: 'networkidle2', timeout: 120000 },
    { waitUntil: 'domcontentloaded', timeout: 120000 },
  ];

  for (let i = 0; i < attempts.length; i++) {
    try {
      await page.goto(url, attempts[i]);
      return;
    } catch (err) {
      const msg = err?.message || String(err);
      console.warn(`${label} Navigation attempt ${i + 1}/${attempts.length} failed: ${msg}`);
      if (i === attempts.length - 1) throw err;
      await sleep(2000);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  validateConfig();

  // Clean up stale singleton lock file to prevent "profile in use" errors on container restart
  const singletonLockPath = path.join(USER_DATA_DIR, 'SingletonLock');
  try {
    if (fs.existsSync(singletonLockPath)) {
      fs.unlinkSync(singletonLockPath);
      console.log('[startup] Cleaned up stale SingletonLock file');
    }
  } catch (err) {
    console.warn('[startup] Could not clean SingletonLock:', err.message);
  }

  const scheduleConfig = loadScheduleConfig();
  const schedulingEnabled = scheduleConfig.scheduling.enabled;
  const posts = schedulingEnabled ? loadPosts() : [];
  const state = schedulingEnabled ? loadPostingState() : null;

  let postsToPost = [];
  if (schedulingEnabled && posts.length > 0) {
    const nextPost = getNextPost(posts, state);
    if (nextPost) {
      postsToPost = [nextPost];
      console.log(`[scheduler] Found next post: Post #${nextPost.id}`);
    } else {
      console.log('[scheduler] All posts have been completed.');
      return;
    }
  } else if (!schedulingEnabled && process.env.POST_TEXT?.trim()) {
    postsToPost = [{ id: 1, text: process.env.POST_TEXT }];
  } else {
    throw new Error('No posts to post: enable scheduling or set POST_TEXT.');
  }

  const launchOptions = {
    headless: HEADLESS ? 'new' : false,  // 'new' for headless, false for visible window
    userDataDir: USER_DATA_DIR,
    args: [
      ...(HEADLESS ? ['--headless'] : []),  // Explicitly add --headless flag when HEADLESS=true
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',        // important for Railway
      '--disable-extensions',
      '--disable-web-resources',
      '--disable-sync',          // Prevents singleton lock issues on container restart
      '--disable-blink-features=AutomationControlled',
      '--no-service-autorun',
    ],
    defaultViewport: { width: 1280, height: 900 },
  };

  // Debug: Log HEADLESS setting and args
  console.log(`[puppeteer] HEADLESS mode: ${HEADLESS ? 'ENABLED' : 'DISABLED'}`);
  console.log(`[puppeteer] Launch args: ${JSON.stringify(launchOptions.args.slice(0, 5))}...`);

  // Use system Chromium if PUPPETEER_EXECUTABLE_PATH is set (Railway)
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    console.log(`[puppeteer] Using Chromium at: ${launchOptions.executablePath}`);
  }

  const browser = await puppeteer.launch(launchOptions);

  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);

  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await restoreSessionCookies(page);
  await resolveCaptchasUntilClear(page, CAPTCHA_API_KEY);

  console.log('[session] Attempting auto-login...');
  await autoLoginIfNeeded(page);
  await sleep(2000);

  // Debug: Check logged-in state after auto-login
  const loggedInCheck = await isLoggedInState(page);
  const debugCookies = await page.cookies();
  const userCookie = debugCookies.find(c => c.name === 'c_user');
  const pageUrl = page.url();
  console.log(`[session-debug] URL: ${pageUrl}, has c_user: ${!!userCookie}, isLoggedInState: ${loggedInCheck}`);
  if (userCookie) {
    console.log(`[session-debug] c_user value: ${userCookie.value}`);
  }

  // In headless/container mode, don't wait for manual input - just try auto-login once
  if (HEADLESS) {
    // On Railway: auto-login only, no manual fallback
    if (!loggedInCheck) {
      console.log('[session] ⚠️ Auto-login check failed. Current state: URL=' + pageUrl + ', hasCookie=' + !!userCookie);
      console.log('[session] ⚠️ Attempting to continue anyway... May fail at group posting.');
    }
  } else {
    // Local dev: allow manual login if auto-login fails
    if (!loggedInCheck) {
      const ok = await waitUntilLoggedIn(page);
      if (!ok) {
        await browser.close();
        throw new Error('Login was not completed.');
      }
    }
  }

  const cookies = await collectFacebookCookies(page);
  await saveSessionCookies(cookies);
  console.log('[session] Cookies saved to session.json');
  console.log(`[multi-group] Posting to ${TARGET_GROUP_URLS.length} group(s).`);

  const postStartTime = Date.now();

  for (const post of postsToPost) {
    try {
      if (schedulingEnabled && state && !canPostAccordingToLimit(scheduleConfig, state)) {
        console.log('[scheduler] Daily limit reached. Stopping.');
        await browser.close();
        return;
      }

      console.log(`\n${'='.repeat(70)}`);
      console.log(`📝 POST #${post.id} START TIME: ${new Date().toLocaleTimeString()}`);
      console.log(`${'='.repeat(70)}`);

      for (let i = 0; i < TARGET_GROUP_URLS.length; i++) {
        const groupUrl = TARGET_GROUP_URLS[i];
        const isLast = i === TARGET_GROUP_URLS.length - 1;
        const groupTimerLabel = `Group ${i + 1} total time`;

        console.log(`\n[group ${i + 1}/${TARGET_GROUP_URLS.length}] ${groupUrl}`);
        startTimer(groupTimerLabel);

        let groupPage = null;

        try {
          groupPage = await browser.newPage();
          await groupPage.setUserAgent(USER_AGENT);

          // Forward browser console logs for debugging
          groupPage.on('console', (msg) => {
            const location = msg.location();
            const prefix = location ? ` [${location.url}:${location.lineNumber}]` : '';
            if (msg.text().includes('[submit-') || msg.text().includes('[button ') || msg.text().includes('[compose')) {
              console.log(`[browser-console]${prefix} ${msg.text()}`);
            }
          });

          const stored = await loadSessionFromDisk();
          if (stored?.length) {
            try { await groupPage.setCookie(...stored); }
            catch (err) { console.warn('[session] Cookie apply warning:', err.message); }
          }

          console.log(`[group ${i + 1}] Opening in new tab...`);
          startTimer(`Group ${i + 1} navigation`);
          await navigateToGroupWithRetry(groupPage, groupUrl, i + 1);
          endTimer(`Group ${i + 1} navigation`);

          await autoLoginIfNeeded(groupPage);
          await saveSessionCookies(groupPage);

          startTimer(`Group ${i + 1} captcha`);
          await resolveCaptchasUntilClear(groupPage, CAPTCHA_API_KEY);
          endTimer(`Group ${i + 1} captcha`);

          if (isLoginOrCheckpointUrl(groupPage.url()) || !(await isLoggedInState(groupPage))) {
            // Session expired: refresh from main Facebook page and restore cookies
            console.log(`[group ${i + 1}] 🔄 Session expired, refreshing from main page...`);
            await navigateToGroupWithRetry(groupPage, 'https://www.facebook.com/', i + 1);
            
            // Restore fresh cookies
            const freshCookies = await loadSessionFromDisk();
            if (freshCookies?.length) {
              try {
                await groupPage.setCookie(...freshCookies);
                console.log(`[group ${i + 1}] ✅ Restored cookies from session`);
              } catch (err) {
                console.warn(`[group ${i + 1}] Cookie restore warning:`, err.message);
              }
            }
            
            // Navigate back to group with fresh session
            await sleep(1000);
            await navigateToGroupWithRetry(groupPage, groupUrl, i + 1);
            await autoLoginIfNeeded(groupPage);
            await resolveCaptchasUntilClear(groupPage, CAPTCHA_API_KEY);
          }

          console.log(`[group ${i + 1}] Opening composer...`);
          
          // Add explicit wait for page content to render after login
          try {
            await Promise.race([
              groupPage.waitForSelector('[role="button"]', { timeout: 8000 }),
              groupPage.waitForFunction(() => document.querySelectorAll('[role="button"]').length > 3, { timeout: 8000 })
            ]).catch(() => {
              // UI might take time, but continue anyway
              console.warn(`[group ${i + 1}] ⚠️ Waiting for UI elements timed out, continuing...`);
            });
          } catch {
            // Ignore - page might still be usable
          }
          
          await sleep(1500); // Give page time to stabilize after login
          
          startTimer(`Group ${i + 1} composer open`);
          await openGroupComposer(groupPage);
          endTimer(`Group ${i + 1} composer open`);

          await randomMouseMove(groupPage);
          await sleep(randomStepDelay());

          let selectedImagePath = null;
          if (POST_IMAGE_DIR) {
            try {
              selectedImagePath = await pickImageByPostId(POST_IMAGE_DIR, post.id);
              if (!selectedImagePath) {
                console.log(`[group ${i + 1}] No image available for this post`);
              }
            } catch (imgErr) {
              console.warn(`[group ${i + 1}] ⚠️ Image pick error: ${imgErr.message}`);
            }
          }

          if (!(await isPageAlive(groupPage))) {
            throw new Error('Page closed or crashed before typing could start');
          }

          console.log(`[group ${i + 1}] Typing message...`);
          startTimer(`Group ${i + 1} typing`);
          await typeIntoFacebookComposer(groupPage, post.text);
          endTimer(`Group ${i + 1} typing`);

          await ensureComposerHasText(groupPage, post.text, i + 1);

          if (selectedImagePath) {
            startTimer(`Group ${i + 1} image upload`);
            const uploaded = await uploadImageToComposer(groupPage, selectedImagePath, i + 1);
            endTimer(`Group ${i + 1} image upload`);
            if (!uploaded) {
              console.warn(`[group ${i + 1}] ⚠️ Initial image upload did not confirm preview`);
              await ensureComposerHasImage(groupPage, selectedImagePath, i + 1);
            } else {
              console.log(`[group ${i + 1}] ✅ Image upload accepted; proceeding without early re-upload`);
            }
            await sleep(2000);
          }

          if (selectedImagePath) {
            await sleep(1000);
          } else {
            await sleep(PAUSE_AFTER_COMPOSE_MS);
          }

          if (SKIP_POST) {
            console.log(`[group ${i + 1}] ✅ Draft ready. SKIP_POST=true — not clicking Post.`);
          } else {
            if (selectedImagePath) {
              await waitForImageUploadToSettle(groupPage, i + 1);
            }
            console.log(`[group ${i + 1}] Submitting post...`);
            startTimer(`Group ${i + 1} submit`);
            await submitPost(groupPage, {
              requireImage: !!selectedImagePath,
              imagePath: selectedImagePath,
              groupIndex: i + 1,
            });
            endTimer(`Group ${i + 1} submit`);
            console.log(`[group ${i + 1}] ✅ Post submitted!`);
            await sleep(PAUSE_AFTER_COMPOSE_MS);
          }

          if (!isLast) {
            console.log(`[group ${i + 1}] Waiting 30s before next group...`);
            await sleep(30000);
          }
        } catch (err) {
          console.error(`❌ [group ${i + 1}] Error: ${err.message}`);
          if (String(err.message || '').toLowerCase().includes('connection closed')) {
            throw err;
          }
          console.log(`[group ${i + 1}] Skipping and continuing...`);

          if (!isLast) {
            console.log(`[group ${i + 1}] Waiting 15s to recover...`);
            await sleep(15000);
          }
        } finally {
          if (groupPage) {
            try { await groupPage.close(); console.log(`[group ${i + 1}] Tab closed.`); }
            catch { /* already closed */ }
          }
          endTimer(groupTimerLabel);
        }
      }

      if (schedulingEnabled && state) {
        updateStateAfterPost(state, post.id);
        console.log(`[scheduler] Post #${post.id} done. Posted today: ${state.postsInLast24h}`);
        const nextPost = getNextPost(posts, state);
        if (nextPost) {
          console.log(`[scheduler] Next post in ${formatDelay(scheduleConfig.scheduling.delayBetweenPostsMs)} (Post #${nextPost.id})`);
        }
        const totalMin = ((Date.now() - postStartTime) / 1000 / 60).toFixed(2);
        console.log(`\n${'='.repeat(70)}`);
        console.log(`✅ POST #${post.id} COMPLETED - Total time: ${totalMin} minutes`);
        console.log(`${'='.repeat(70)}\n`);
      }
    } catch (postErr) {
      console.error(`[posting] Error on post #${post.id}: ${postErr.message}`);
      if (String(postErr.message || '').toLowerCase().includes('connection closed')) {
        console.error('[posting] Browser disconnected. Stopping run so this post can be retried next launch.');
        throw postErr;
      }
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log('🎉 ALL POSTS COMPLETED');
  console.log('='.repeat(70));

  if (WAIT_FOR_ENTER_BEFORE_CLOSE) await waitForEnter();
  else await sleep(15000);

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

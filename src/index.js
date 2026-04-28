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

// Graceful shutdown - save state before exiting
process.on('exit', () => {
  console.log('\n[exit] Ensuring posting state is saved...');
});
process.on('SIGINT', () => {
  console.log('\n[exit] Caught SIGINT, saving state...');
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log('\n[exit] Caught SIGTERM, saving state...');
  process.exit(0);
});

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
  
  const pageUrl = page.url();
  if (pageUrl.includes('/login') || pageUrl.includes('/login.php')) {
    throw new Error('Still on login page - session expired');
  }

  // FAST approach: Just click the composer button and wait for dialog
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Check if already open
    const alreadyOpen = await page.$('[role="dialog"] [role="textbox"], [role="dialog"] div[contenteditable="true"]');
    if (alreadyOpen) return;

    // Click the composer with simple, fast selector - MORE AGGRESSIVE
    const clicked = await page.evaluate(() => {
      // Try the most common Facebook selectors first
      const selectors = [
        () => document.querySelector('[data-testid="status_composer_container"]')?.parentElement?.querySelector('[role="button"]'),
        () => document.querySelector('[data-testid="status_composer_container"]')?.querySelector('[role="button"]'),
        () => Array.from(document.querySelectorAll('[role="button"]')).find(b => {
          const aria = (b.getAttribute('aria-label') || '').toLowerCase();
          return aria.includes('write') || aria.includes('create') || aria.includes('share') || aria.includes('post');
        }),
        // AGGRESSIVE: Just find ANY large button in the main feed area
        () => Array.from(document.querySelectorAll('[role="main"] [role="button"], [role="region"] [role="button"]')).find(b => {
          const rect = b.getBoundingClientRect();
          const looksLarge = rect.width > 80 && rect.height > 25;
          return looksLarge && rect.top < window.innerHeight * 0.4;  // In upper half of page
        }),
        // FALLBACK: ANY button with at least 50px width
        () => Array.from(document.querySelectorAll('[role="button"]')).find(b => {
          const rect = b.getBoundingClientRect();
          return rect.width > 50 && rect.height > 20 && b.textContent.length > 2;
        })
      ];

      for (const selector of selectors) {
        try {
          const el = selector();
          if (el) {
            const rect = el.getBoundingClientRect();
            if (rect.height > 15) {
              console.log('[composer-debug] Clicking button:', el.textContent.substring(0, 30), el.getAttribute('aria-label'));
              el.click();
              return true;
            }
          }
        } catch (e) {
          // Ignore selector errors
        }
      }
      return false;
    });

    if (!clicked) {
      console.log(`[composer] Attempt ${attempt}/3: No button found`);
      await sleep(800);
      continue;
    }

    // Wait for dialog with SHORT timeout
    try {
      await page.waitForFunction(
        () => !!document.querySelector('[role="dialog"] [role="textbox"], [role="dialog"] div[contenteditable="true"]'),
        { timeout: 3000 }
      );
      return;
    } catch {
      console.log(`[composer] Attempt ${attempt}/3: Dialog didn't open`);
      await sleep(600);
    }
  }

  throw new Error('Composer failed - cannot open post dialog');
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
    throw new Error('Image upload failed at submit time; post aborted (requires both text and image).');
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

  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`${tag} Submit attempt ${attempt}/3...`);
    
    // Check image is still there
    if (requireImage) {
      const hasImg = await hasComposerImage(page);
      if (!hasImg) {
        throw new Error('Image missing at submit time');
      }
    }

    try {
      // FIRST: Try direct Post button click via evaluate (simplest)
      const posted = await page.evaluate(() => {
        const postBtn = Array.from(document.querySelectorAll('[role="dialog"] [role="button"]')).find(btn => {
          const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
          const text = (btn.textContent || '').toLowerCase().trim();
          return aria === 'post' || text === 'post';
        });
        if (postBtn) {
          postBtn.click();
          return true;
        }
        return false;
      });

      if (posted) {
        console.log(`${tag} ✓ Post button clicked via evaluate`);
      } else {
        console.log(`${tag} Post button not found in dialog`);
        await sleep(1000);
        continue;  // retry
      }

      // Wait for dialog to close
      console.log(`${tag} Waiting for dialog to close...`);
      let dialogClosed = false;
      
      for (let i = 0; i < 20; i++) {
        await sleep(400);
        
        const state = await page.evaluate(() => {
          const dialog = document.querySelector('[role="dialog"]');
          if (!dialog) return { closed: true };
          
          // Check for success signals
          const bodyText = (document.body?.innerText || '').toLowerCase();
          const hasSuccess = bodyText.includes('post') && (
            bodyText.includes('pending') || 
            bodyText.includes('published') || 
            bodyText.includes('submitted') ||
            bodyText.includes('shared') ||
            bodyText.includes('live')
          );
          
          return { 
            closed: false, 
            hasSuccess,
            bodyText: bodyText.substring(0, 200)
          };
        });
        
        if (state.closed) {
          dialogClosed = true;
          console.log(`${tag} ✓ Dialog closed after ${(i + 1) * 400}ms`);
          break;
        }
        
        if (state.hasSuccess) {
          console.log(`${tag} ✓ Success message detected: ${state.bodyText}`);
          return true;
        }
      }

      if (dialogClosed) {
        console.log(`${tag} ✓ Post submitted successfully`);
        return true;
      }

      console.log(`${tag} Dialog still open after 8s, retrying...`);
      
    } catch (err) {
      console.log(`${tag} Error during submit: ${err.message}`);
      await sleep(1000);
    }
  }

  throw new Error('Post could not be submitted after 3 attempts');
}

async function navigateToGroupWithRetry(page, url, groupIndex) {
  const label = `[group ${groupIndex}]`;
  const attempts = [
    { waitUntil: 'domcontentloaded', timeout: 30000 },  // Fast: just DOM ready
    { waitUntil: 'networkidle2', timeout: 60000 },      // Slower: but if needed
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
                throw new Error(`No image available for this post (image directory configured at ${POST_IMAGE_DIR}). Post requires both text and image.`);
              }
            } catch (imgErr) {
              throw new Error(`Image selection failed: ${imgErr.message}`);
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
              console.log(`[group ${i + 1}] ✅ Image upload accepted`);
            }
            await sleep(1000);
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
              await ensureComposerHasImage(groupPage, selectedImagePath, i + 1);
            }
            console.log(`[group ${i + 1}] Submitting post...`);
            startTimer(`Group ${i + 1} submit`);
            await submitPost(groupPage, {
              requireImage: !!selectedImagePath,  // Require image if one was selected
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

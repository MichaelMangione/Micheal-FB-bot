import fs from 'fs';

import { CAPTCHA_API_KEY, ENGAGEMENT_STATE_FILE } from './config.js';
import { resolveCaptchasUntilClear } from './captcha.js';
import { humanType, randomMouseMove, sleep } from './humanize.js';

const DEFAULT_STATE = {
  version: 1,
  engagedItems: {},
  commentPoolUsage: {},
};

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function getGroupId(groupUrl) {
  try {
    const url = new URL(groupUrl);
    const match = url.pathname.match(/\/groups\/([^/?#]+)/i);
    if (match?.[1]) return decodeURIComponent(match[1]);
    const parts = url.pathname.split('/').filter(Boolean);
    return decodeURIComponent(parts[parts.length - 1] || 'unknown-group');
  } catch {
    return 'unknown-group';
  }
}

function cloneDefaultState() {
  return {
    version: 1,
    engagedItems: {},
    commentPoolUsage: {},
  };
}

function loadState() {
  if (!fs.existsSync(ENGAGEMENT_STATE_FILE)) {
    return cloneDefaultState();
  }

  try {
    const raw = fs.readFileSync(ENGAGEMENT_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      version: Number.isFinite(Number(parsed.version)) ? Number(parsed.version) : 1,
      engagedItems: parsed.engagedItems && typeof parsed.engagedItems === 'object' ? parsed.engagedItems : {},
      commentPoolUsage:
        parsed.commentPoolUsage && typeof parsed.commentPoolUsage === 'object' ? parsed.commentPoolUsage : {},
    };
  } catch (err) {
    console.warn(`[engagement] Failed to load state, starting fresh: ${err.message}`);
    return cloneDefaultState();
  }
}

function saveState(state) {
  const tmpPath = `${ENGAGEMENT_STATE_FILE}.${process.pid}.tmp`;
  const payload = JSON.stringify(state, null, 2);

  try {
    fs.writeFileSync(tmpPath, payload, 'utf8');
    if (fs.existsSync(ENGAGEMENT_STATE_FILE)) {
      fs.rmSync(ENGAGEMENT_STATE_FILE, { force: true });
    }
    fs.renameSync(tmpPath, ENGAGEMENT_STATE_FILE);
  } catch (err) {
    console.warn(`[engagement] Failed to save state: ${err.message}`);
    try {
      if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true });
    } catch {
      /* ignore */
    }
  }
}

function ensureGroupState(state, groupId) {
  if (!state.engagedItems[groupId]) {
    state.engagedItems[groupId] = {
      likedPosts: [],
      commentedPosts: [],
    };
  }

  const groupState = state.engagedItems[groupId];
  if (!Array.isArray(groupState.likedPosts)) groupState.likedPosts = [];
  if (!Array.isArray(groupState.commentedPosts)) groupState.commentedPosts = [];
  return groupState;
}

function normalizeCommentPool(pool) {
  const comments = Array.isArray(pool?.comments)
    ? pool.comments.filter((comment) => comment && typeof comment.id === 'string' && typeof comment.text === 'string')
    : [];

  return { version: Number.isFinite(Number(pool?.version)) ? Number(pool.version) : 1, comments };
}

function pickComment(commentsPool, usage, now, cooldownMs) {
  const pool = normalizeCommentPool(commentsPool);
  const eligible = pool.comments.filter((comment) => {
    const last = usage[comment.id]?.lastUsed;
    if (!last) return true;
    return now - Date.parse(last) >= cooldownMs;
  });

  if (eligible.length > 0) {
    return eligible[Math.floor(Math.random() * eligible.length)];
  }

  return [...pool.comments].sort((a, b) => {
    const lastA = usage[a.id]?.lastUsed || '1970-01-01T00:00:00Z';
    const lastB = usage[b.id]?.lastUsed || '1970-01-01T00:00:00Z';
    return Date.parse(lastA) - Date.parse(lastB);
  })[0];
}

function extractPostId(permalink) {
  if (!permalink) return '';

  try {
    const url = new URL(permalink);
    const direct = url.searchParams.get('fbid') || url.searchParams.get('story_fbid');
    if (direct) return direct;

    const parts = url.pathname.split('/').filter(Boolean);
    const tail = parts[parts.length - 1] || '';
    if (tail) return decodeURIComponent(tail).replace(/\/+$/, '');
  } catch {
    /* ignore */
  }

  return permalink.replace(/\/+$/, '');
}

async function clearCaptchaIfPresent(page) {
  if (!CAPTCHA_API_KEY) return;
  try {
    await resolveCaptchasUntilClear(page, CAPTCHA_API_KEY);
  } catch (err) {
    console.warn(`[engagement] CAPTCHA handling warning: ${err.message}`);
  }
}

async function waitForFeed(page, timeoutMs = 15000) {
  try {
    await page.waitForSelector('[role="feed"]', { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function scrollFeed(page, maxScrolls) {
  const passes = Math.max(1, Math.min(Number(maxScrolls) || 4, 6));
  for (let i = 0; i < passes; i += 1) {
    await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.85)));
    await sleep(randomBetween(1000, 2000));
  }
}

async function discoverPosts(page, groupUrl, config) {
  await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
  if (!(await waitForFeed(page))) {
    return [];
  }

  await clearCaptchaIfPresent(page);
  await scrollFeed(page, config.maxScrolls);
  await clearCaptchaIfPresent(page);

  const rawArticles = await page.$$eval('[role="feed"] [role="article"]', (articles) => {
    const permalinkPatterns = [/\/posts\//i, /story_fbid=/i, /\/permalink\//i, /\/groups\//i];

    // Exclude comment articles nested inside another article (Facebook nests comment
    // articles inside post articles; we only want the top-level post articles)
    const topLevel = articles.filter((a) => !a.parentElement?.closest('[role="article"]'));

    return topLevel.map((article, index) => {
      const text = (article.innerText || '').trim();
      const anchors = Array.from(article.querySelectorAll('a[href]'));
      const permalinkAnchor = anchors.find((anchor) => {
        const href = anchor.href || '';
        return permalinkPatterns.some((pattern) => pattern.test(href));
      });

      const authorAnchor = anchors.find((anchor) => {
        const href = anchor.href || '';
        const label = (anchor.textContent || '').trim();
        if (!label || label.length > 120) return false;
        if (permalinkAnchor && href === permalinkAnchor.href) return false;
        if (/\/posts\//i.test(href) || /story_fbid=/i.test(href) || /\/permalink\//i.test(href)) return false;
        if (/\/groups\//i.test(href) && /\bpost\b/i.test(label)) return false;
        return true;
      });

      const sponsored = /(^|\s)sponsored(\s|$)/i.test(text) || !!article.querySelector('[aria-label*="Sponsored" i]');
      const isPoll = /\bpoll\b/i.test(text) || !!article.querySelector('[aria-label*="Poll" i]');
      const isFundraiser = /fundraiser/i.test(text) || !!article.querySelector('[aria-label*="Fundraiser" i]');
      const isMarketplace = /marketplace/i.test(text) || !!article.querySelector('[aria-label*="Marketplace" i]');

      return {
        index,
        permalink: permalinkAnchor?.href || '',
        authorName: (authorAnchor?.textContent || '').trim(),
        sponsored,
        isPoll,
        isFundraiser,
        isMarketplace,
        textSnippet: text.slice(0, 250),
      };
    });
  });

  return rawArticles
    .map((article) => ({
      ...article,
      postId: extractPostId(article.permalink),
    }))
    .filter((article) => article.postId);
}

function isEligiblePost(post, groupState, botUsername) {
  if (!post?.postId) return false;
  if (post.sponsored || post.isPoll || post.isFundraiser || post.isMarketplace) return false;

  const normalizedBotName = normalize(botUsername);
  if (normalizedBotName && normalize(post.authorName).includes(normalizedBotName)) return false;

  if (groupState.likedPosts.includes(post.postId)) return false;
  if (groupState.commentedPosts.some((entry) => entry.postId === post.postId)) return false;

  return true;
}

async function getArticleHandle(page, post) {
  const allArticles = await page.$$("[role='feed'] [role='article']");
  // Only top-level post articles, not nested comment articles
  const articles = await Promise.all(
    allArticles.map(async (a) => {
      const isNested = await a.evaluate((el) => !!el.parentElement?.closest('[role="article"]'));
      return isNested ? null : a;
    })
  ).then((results) => results.filter(Boolean));

  // Prefer permalink match — stable even when the feed reorders
  if (post.permalink) {
    for (const article of articles) {
      try {
        const hasLink = await article.evaluate(
          (el, href) => Array.from(el.querySelectorAll('a[href]')).some((a) => a.href === href),
          post.permalink
        );
        if (hasLink) return article;
      } catch {}
    }
  }

  // Fall back to index if permalink lookup found nothing
  return articles[post.index] || null;
}

// Searches article + up to 2 ancestor levels for the Facebook action bar button
// identified by its data-ad-rendering-role attribute (like_button | comment_button | share_button)
function findPostActionBtn(article, roleAttr) {
  const containers = [article, article.parentElement, article.parentElement?.parentElement].filter(Boolean);
  for (const c of containers) {
    const marker = c.querySelector(`[data-ad-rendering-role="${roleAttr}"]`);
    if (marker) return marker.closest('[role="button"]') || marker;
  }
  return null;
}

async function clickLikeOnArticle(page, articleHandle) {
  await articleHandle.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await sleep(400);

  const box = await articleHandle.boundingBox();
  if (!box) return false;

  // Find the [data-ad-rendering-role="like_button"] closest to this article by screen position
  const result = await page.evaluate((artTop, artHeight) => {
    const artMid = artTop + artHeight / 2;
    const markers = Array.from(document.querySelectorAll('[data-ad-rendering-role="like_button"]'));
    let best = null, bestDist = Infinity;
    for (const m of markers) {
      const btn = m.closest('[role="button"]') || m;
      const r = btn.getBoundingClientRect();
      const dist = Math.abs((r.top + r.height / 2) - artMid);
      if (dist < bestDist) { bestDist = dist; best = btn; }
    }
    if (!best) return 'not_found';
    if (best.getAttribute('aria-label') === 'Remove Like') return 'already_liked';
    best.scrollIntoView({ block: 'center', behavior: 'instant' });
    best.click();
    return 'clicked';
  }, box.y, box.height);

  if (result === 'not_found') {
    console.log('[engagement] Like button ([data-ad-rendering-role="like_button"]) not found on page');
    return false;
  }
  if (result === 'already_liked') return true;

  await randomMouseMove(page);
  await sleep(randomBetween(800, 1500));

  // Verify: the button nearest the article now reads "Remove Like"
  const liked = await page.evaluate((artTop, artHeight) => {
    const artMid = artTop + artHeight / 2;
    const markers = Array.from(document.querySelectorAll('[data-ad-rendering-role="like_button"]'));
    let best = null, bestDist = Infinity;
    for (const m of markers) {
      const btn = m.closest('[role="button"]') || m;
      const r = btn.getBoundingClientRect();
      const dist = Math.abs((r.top + r.height / 2) - artMid);
      if (dist < bestDist) { bestDist = dist; best = btn; }
    }
    return best ? best.getAttribute('aria-label') === 'Remove Like' : true;
  }, box.y, box.height);

  return liked;
}

async function openCommentComposer(page, articleHandle) {
  try {
    // Scroll article into center of viewport — FB may ignore clicks on off-screen elements
    await articleHandle.evaluate((article) => {
      article.scrollIntoView({ block: 'center', behavior: 'instant' });
    });
    await sleep(randomBetween(600, 1000));

    // Poll for the Lexical comment editor — data-lexical-editor="true" is Facebook's editor marker
    const pollForBox = async (maxMs = 5000) => {
      const deadline = Date.now() + maxMs;
      while (Date.now() < deadline) {
        const box = await page.$('div[contenteditable="true"][data-lexical-editor="true"]');
        if (box) return box;
        await sleep(500);
      }
      return null;
    };

    // Strategy 1: directly click visible Lexical editor comment box
    const directBox = await articleHandle.$('div[contenteditable="true"][data-lexical-editor="true"]');
    if (directBox) {
      await randomMouseMove(page);
      await directBox.click();
      if (await pollForBox(3000)) return true;
    }

    // Strategy 2: click the post-level "Leave a comment" button via data-ad-rendering-role="comment_button".
    // Use viewport position to find the action bar button nearest this article.
    const articleBox = await articleHandle.boundingBox();
    const actionClicked = articleBox ? await page.evaluate((artTop, artHeight) => {
      const artMid = artTop + artHeight / 2;
      const markers = Array.from(document.querySelectorAll('[data-ad-rendering-role="comment_button"]'));
      let best = null, bestDist = Infinity;
      for (const m of markers) {
        const btn = m.closest('[role="button"]') || m;
        const r = btn.getBoundingClientRect();
        const dist = Math.abs((r.top + r.height / 2) - artMid);
        if (dist < bestDist) { bestDist = dist; best = btn; }
      }
      if (!best) {
        const allRoles = Array.from(document.querySelectorAll('[data-ad-rendering-role]'))
          .map(el => el.getAttribute('data-ad-rendering-role'));
        return `NO_BUTTON roles_on_page:${JSON.stringify([...new Set(allRoles)])}`;
      }
      best.scrollIntoView({ block: 'center', behavior: 'instant' });
      best.click();
      return best.getAttribute('aria-label') || 'comment_button';
    }, articleBox.y, articleBox.height) : 'NO_BOX';

    if (actionClicked?.startsWith('NO_BUTTON:')) {
      console.log(`[engagement] No action button found. ${actionClicked.slice(10)}`);
    } else if (actionClicked) {
      console.log(`[engagement] Action button clicked: ${actionClicked}`);
      const box = await pollForBox(6000);
      if (box) return true;
      console.log('[engagement] Reply button clicked but textbox did not appear within 6s');
    }

    // Strategy 3: directly focus the Lexical editor if it appeared after the click
    const focusResult = await page.evaluate(() => {
      const box = document.querySelector('div[contenteditable="true"][data-lexical-editor="true"]');
      if (box) { box.scrollIntoView({ block: 'center', behavior: 'instant' }); box.focus(); return true; }
      return false;
    });
    if (focusResult) {
      if (await pollForBox(3000)) return true;
    } else {
      console.log('[engagement] No [data-lexical-editor="true"] found on page');
    }

    return false;
  } catch (err) {
    console.log(`[engagement] openCommentComposer unexpected error: ${err.message}`);
    return false;
  }
}

async function getCommentTextbox(page) {
  // Facebook's comment box: div[contenteditable="true"][data-lexical-editor="true"]
  return page.$('div[contenteditable="true"][data-lexical-editor="true"]');
}

async function commentComposerHasText(page) {
  return page.evaluate(() => {
    const box = document.querySelector('div[contenteditable="true"][data-lexical-editor="true"]');
    return box ? (box.innerText || box.textContent || '').trim().length > 0 : false;
  });
}

async function articleContainsCommentText(articleHandle, snippet) {
  if (!snippet) return false;
  const normalizedSnippet = normalize(snippet);
  return articleHandle.evaluate((article, expected) => {
    const text = String(article.innerText || article.textContent || '').toLowerCase();
    return text.includes(expected);
  }, normalizedSnippet);
}

async function submitCommentOnArticle(page, articleHandle, commentText) {
  const textbox = await getCommentTextbox(page);
  if (!textbox) {
    console.log('[engagement] submitCommentOnArticle: no textbox found');
    return false;
  }

  await textbox.click();
  await sleep(randomBetween(800, 1500));
  await humanType(page, commentText);
  await sleep(randomBetween(1500, 3000));

  // Wait up to 3s for the "Post comment" button to become enabled (aria-disabled="true" → removed)
  let submitButton = null;
  for (let i = 0; i < 6; i++) {
    submitButton = await page.$('div[aria-label="Post comment"][role="button"]:not([aria-disabled="true"])');
    if (submitButton) break;
    await sleep(500);
  }

  if (submitButton) {
    console.log('[engagement] Clicking Post comment button');
    await submitButton.click({ delay: 50 });
  } else {
    console.log('[engagement] Post comment button not ready, trying Enter');
    try { await page.keyboard.press('Enter'); } catch { /* ignore */ }
  }

  await sleep(2500);

  const cleared = !(await commentComposerHasText(page));
  const textVisible = await articleContainsCommentText(articleHandle, commentText.slice(0, 20));
  return cleared || textVisible;
}

function recordLike(state, groupId, postId) {
  const groupState = ensureGroupState(state, groupId);
  if (!groupState.likedPosts.includes(postId)) {
    groupState.likedPosts.push(postId);
  }
  saveState(state);
}

function recordComment(state, groupId, postId, commentId) {
  ensureGroupState(state, groupId).commentedPosts.push({
    postId,
    commentId,
    ts: new Date().toISOString(),
  });

  const now = new Date().toISOString();
  const usage = state.commentPoolUsage[commentId] || { lastUsed: null, useCount: 0 };
  state.commentPoolUsage[commentId] = {
    lastUsed: now,
    useCount: (usage.useCount || 0) + 1,
  };

  saveState(state);
}

/**
 * Run the engagement phase for ONE group.
 * @param {import('puppeteer').Page} page
 * @param {string} groupUrl
 * @param {object} config
 * @returns {Promise<void>}
 */
export async function runEngagement(page, groupUrl, config) {
  const groupId = getGroupId(groupUrl);
  const state = loadState();
  const groupState = ensureGroupState(state, groupId);
  const engagement = config?.engagement || {};
  const commentsPool = normalizeCommentPool(engagement.commentsPool);

  try {
    if (!engagement.enabled) return;

    if (!groupUrl) {
      console.warn('[engagement] Missing group URL; skipping engagement phase.');
      return;
    }

    if (!(await waitForFeed(page))) {
      console.warn(`[engagement] Feed did not load for group ${groupId}; skipping.`);
      return;
    }

    const posts = await discoverPosts(page, groupUrl, engagement);
    const eligiblePosts = posts.filter((post) => isEligiblePost(post, groupState, engagement.botUsername));

    if (!eligiblePosts.length) {
      console.warn(`[engagement] No eligible posts found for group ${groupId}; skipping engagement.`);
      return;
    }

    if (commentsPool.comments.length === 0) {
      console.warn('[engagement] comments.json has no usable comments; commenting will be skipped.');
    }

    const likeTarget = Math.max(0, Number(engagement.likesPerGroup) || 0);
    const likeAttempts = shuffle(eligiblePosts);
    let likesDone = 0;

    for (const post of likeAttempts) {
      if (likesDone >= likeTarget) break;

      const articleHandle = await getArticleHandle(page, post);
      if (!articleHandle) continue;

      const ok = await clickLikeOnArticle(page, articleHandle);
      if (!ok) continue;

      recordLike(state, groupId, post.postId);
      likesDone += 1;

      if (likesDone < likeTarget) {
        await sleep(randomBetween(8000, 25000));
      }
    }

    if (likesDone < likeTarget) {
      console.warn(`[engagement] Only liked ${likesDone}/${likeTarget} posts in group ${groupId}.`);
    }

    const commentTarget = Math.max(0, Number(engagement.commentsPerGroup) || 0);
    if (!commentTarget || commentsPool.comments.length === 0) {
      return;
    }

    await sleep(randomBetween(10000, 30000));

    const commentCandidates = shuffle(eligiblePosts);
    let commentsDone = 0;
    const triedPosts = new Set();

    while (commentsDone < commentTarget && triedPosts.size < commentCandidates.length) {
      const post = commentCandidates.find((candidate) => !triedPosts.has(candidate.postId));
      if (!post) break;
      triedPosts.add(post.postId);

      const comment = pickComment(
        commentsPool,
        state.commentPoolUsage,
        Date.now(),
        Number(engagement.commentReuseCooldownMs) || 86400000
      );
      console.log(`[engagement] Selected comment for post ${post.postId}: ${comment ? comment.id + ' / ' + comment.text : 'NONE'}`);
      if (!comment) {
        console.warn('[engagement] No comment could be selected from comments.json.');
        break;
      }

      const articleHandle = await getArticleHandle(page, post);
      if (!articleHandle) {
        console.log(`[engagement] No article handle for post ${post.postId} (index ${post.index}, permalink: ${post.permalink?.slice(0, 80)})`);
        continue;
      }

      console.log(`[engagement] Opening comment composer for post ${post.postId} (index ${post.index})`);
      const opened = await openCommentComposer(page, articleHandle);
      if (!opened) {
        console.log(`[engagement] openCommentComposer FAILED for post ${post.postId}`);
        continue;
      }
      console.log(`[engagement] Comment composer opened for post ${post.postId}`);

      const submitted = await submitCommentOnArticle(page, articleHandle, comment.text);
      console.log(`[engagement] submitCommentOnArticle result for post ${post.postId}: ${submitted}`);
      if (!submitted) {
        console.warn(`[engagement] Comment submission failed on post ${post.postId}; trying another post.`);
        continue;
      }

      recordComment(state, groupId, post.postId, comment.id);
      commentsDone += 1;
    }

    if (commentsDone < commentTarget) {
      console.warn(`[engagement] Only commented on ${commentsDone}/${commentTarget} posts in group ${groupId}.`);
    }
  } catch (err) {
    console.warn(`[engagement] Non-fatal engagement error for group ${groupId}: ${err.message}`);
  }
}
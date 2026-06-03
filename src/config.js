import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');

// Load .env.example first (template / local defaults), then .env so real secrets in .env win.
dotenv.config({ path: path.join(ROOT_DIR, '.env.example') });
dotenv.config({ path: path.join(ROOT_DIR, '.env'), override: true });

export const CAPTCHA_API_KEY = process.env.CAPTCHA_API_KEY || '';
export const FB_EMAIL = process.env.FB_EMAIL || '';
export const FB_PASSWORD = process.env.FB_PASSWORD || '';

// Determine headless mode: Always headless in container (/app path), otherwise use HEADLESS env var
const isContainer = process.cwd().startsWith('/app');
const headlessFromEnv = String(process.env.HEADLESS || 'false').toLowerCase() === 'true';
export const HEADLESS = isContainer || headlessFromEnv;  // Headless if in container OR if HEADLESS=true

// Always log for debugging (no condition)
console.log(`[config] isContainer=${isContainer}, cwd=${process.cwd()}, HEADLESS_env=${process.env.HEADLESS}, final HEADLESS=${HEADLESS}`);
export const TARGET_GROUP_URL = process.env.TARGET_GROUP_URL || '';

// Multi-group support: comma-separated list in TARGET_GROUP_URLS, falls back to TARGET_GROUP_URL.
const _rawUrls = process.env.TARGET_GROUP_URLS || '';
export const TARGET_GROUP_URLS = _rawUrls
  ? _rawUrls.split(',').map((u) => u.trim()).filter(Boolean)
  : TARGET_GROUP_URL
  ? [TARGET_GROUP_URL]
  : [];

export const POST_TEXT = process.env.POST_TEXT || '';

export const COMMENTS_FILE = path.join(ROOT_DIR, 'comments.json');
export const ENGAGEMENT_STATE_FILE = path.join(ROOT_DIR, '.engagement-state.json');

export const DEFAULT_ENGAGEMENT_CONFIG = {
  enabled: true,
  likesPerGroup: 2,
  commentsPerGroup: 1,
  maxScrolls: 4,
  cooldownMs: 1200000,
  cooldownJitterPct: 10,
  commentReuseCooldownMs: 86400000,
};

function readOptionalIntEnv(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

export function loadCommentsPool() {
  const data = readJsonFile(COMMENTS_FILE, null);
  if (!data || typeof data !== 'object') {
    return { version: 1, comments: [] };
  }

  const comments = Array.isArray(data.comments)
    ? data.comments
        .filter((comment) => comment && typeof comment.id === 'string' && typeof comment.text === 'string')
        .map((comment) => ({ id: comment.id.trim(), text: comment.text.trim() }))
        .filter((comment) => comment.id && comment.text)
    : [];

  return {
    version: Number.isFinite(Number(data.version)) ? Number(data.version) : 1,
    comments,
  };
}

export function buildEngagementConfig(scheduleConfig = {}) {
  const scheduled = scheduleConfig?.engagement || {};
  return {
    enabled: scheduled.enabled ?? DEFAULT_ENGAGEMENT_CONFIG.enabled,
    likesPerGroup:
      readOptionalIntEnv('LIKES_PER_GROUP') ?? scheduled.likesPerGroup ?? DEFAULT_ENGAGEMENT_CONFIG.likesPerGroup,
    commentsPerGroup:
      readOptionalIntEnv('COMMENTS_PER_GROUP') ??
      scheduled.commentsPerGroup ??
      DEFAULT_ENGAGEMENT_CONFIG.commentsPerGroup,
    maxScrolls: readOptionalIntEnv('MAX_SCROLLS') ?? scheduled.maxScrolls ?? DEFAULT_ENGAGEMENT_CONFIG.maxScrolls,
    cooldownMs:
      readOptionalIntEnv('ENGAGEMENT_COOLDOWN_MS') ??
      scheduled.cooldownMs ??
      DEFAULT_ENGAGEMENT_CONFIG.cooldownMs,
    cooldownJitterPct: scheduled.cooldownJitterPct ?? DEFAULT_ENGAGEMENT_CONFIG.cooldownJitterPct,
    commentReuseCooldownMs:
      readOptionalIntEnv('COMMENT_REUSE_COOLDOWN_MS') ??
      scheduled.commentReuseCooldownMs ??
      DEFAULT_ENGAGEMENT_CONFIG.commentReuseCooldownMs,
    botUsername: process.env.FB_BOT_USERNAME || '',
    commentsPool: loadCommentsPool(),
  };
}

function resolveOptionalPath(raw) {
  if (!raw?.trim()) return '';
  const p = raw.trim();
  return path.isAbsolute(p) ? p : path.join(ROOT_DIR, p);
}

/** Folder with images (jpg/png/gif/webp). One file is chosen at random. Empty = text only. */
export const POST_IMAGE_DIR = resolveOptionalPath(process.env.POST_IMAGE_DIR);

/** When true (default), composer is filled but Post is not clicked — safe for testing. */
export const SKIP_POST = String(process.env.SKIP_POST ?? 'true').toLowerCase() !== 'false';

/** Wait for Enter in the terminal before closing the browser so the Facebook dialog stays open. */
export const WAIT_FOR_ENTER_BEFORE_CLOSE =
  String(process.env.WAIT_FOR_ENTER_BEFORE_CLOSE ?? 'true').toLowerCase() !== 'false';

/** Extra ms after typing (and after image) so you can see the content before Post or before closing. */
export const PAUSE_AFTER_COMPOSE_MS = Math.max(
  0,
  Number.parseInt(process.env.PAUSE_AFTER_COMPOSE_MS ?? '5000', 10) || 5000
);

/** When true, resets posting state to start from post 1 (ignores .posting-state.json). */
export const RESET_POSTS = String(process.env.RESET_POSTS ?? 'false').toLowerCase() === 'true';

/** Run pending-post cleanup once per local day after this hour (0-23). */
export const MORNING_PENDING_CLEANUP_HOUR = Math.min(
  23,
  Math.max(0, Number.parseInt(process.env.MORNING_PENDING_CLEANUP_HOUR ?? '6', 10) || 6)
);

/** When true, delete pending posts from all target groups once each morning before posting. */
export const MORNING_PENDING_CLEANUP_ENABLED =
  String(process.env.MORNING_PENDING_CLEANUP_ENABLED ?? 'true').toLowerCase() !== 'false';

export { ROOT_DIR };
export const SESSION_FILE = path.join(ROOT_DIR, 'session.json');
export const USER_DATA_DIR = path.join(ROOT_DIR, '.fb-profile');

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function validateConfig() {
  const missing = [];
  if (!TARGET_GROUP_URLS.length) missing.push('TARGET_GROUP_URLS (or TARGET_GROUP_URL)');
  if (!POST_TEXT) missing.push('POST_TEXT');
  if (missing.length) {
    throw new Error(
      `Missing required env vars: ${missing.join(', ')}. Set them in .env (preferred) or .env.example.`
    );
  }
}

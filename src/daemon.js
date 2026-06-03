#!/usr/bin/env node

/**
 * Daemon script for continuous post scheduling
 * 
 * This script runs the posting bot on a schedule, respecting delays between posts
 * and daily post limits. It will:
 * 
 * 1. Run the main posting bot
 * 2. Wait for the configured delay
 * 3. Check if daily limits are met
 * 4. Repeat until all posts are completed
 * 
 * Usage:
 *   node src/daemon.js
 * 
 * Configuration:
 *   - Edit schedule.json to adjust delays and daily limits
 *   - The script logs to console and .posting-state.json tracks progress
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  loadPosts,
  loadScheduleConfig,
  loadPostingState,
  getNextPost,
  formatDelay,
  sleep,
} from './scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Run the main posting bot as a subprocess
 */
function runBotProcess() {
  return new Promise((resolve, reject) => {
    console.log('\n' + '='.repeat(60));
    console.log(`[daemon] Starting bot at ${new Date().toISOString()}`);
    console.log('='.repeat(60));

    const indexPath = path.join(__dirname, 'index.js');
    const proc = spawn('node', [indexPath], {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
      shell: false,
    });

    proc.on('close', (code) => {
      if (code === 0) {
        console.log('[daemon] Bot process completed successfully');
        resolve();
      } else {
        console.error(`[daemon] Bot process exited with code ${code}`);
        reject(new Error(`Bot process exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      console.error('[daemon] Bot process error:', err);
      reject(err);
    });
  });
}

/**
 * Main daemon loop
 */
async function runDaemon() {
  console.log('[daemon] Post scheduling daemon starting...');

  const scheduleConfig = loadScheduleConfig();
  const posts = loadPosts();

  if (!scheduleConfig.scheduling.enabled) {
    console.log('[daemon] Scheduling is disabled in schedule.json');
    return;
  }

  if (posts.length === 0) {
    console.log('[daemon] No posts found in posts.json');
    return;
  }

  const delayMs = scheduleConfig.scheduling.delayBetweenPostsMs;
  const dailyLimit = scheduleConfig.scheduling.postsPerDay;

  console.log(`[daemon] Configuration:`);
  console.log(`  - Total posts: ${posts.length}`);
  console.log(`  - Delay between posts: ${formatDelay(delayMs)}`);
  console.log(`  - Posts per day: ${dailyLimit || 'unlimited'}`);
  console.log(`  - Mode: ${scheduleConfig.scheduling.mode}`);

  let consecutiveErrors = 0;
  const maxErrors = 10;

  // Main daemon loop - runs until all posts are done
  while (true) {
    // Stop if no posts remain
    const stateBeforeRun = loadPostingState();
    const nextPost = getNextPost(posts, stateBeforeRun);
    if (!nextPost) {
      console.log('[daemon] All posts completed. Shutting down.');
      break;
    }

    try {
      // Run the bot for one post
      await runBotProcess();
      consecutiveErrors = 0;

      // After a successful post, check if more remain
      const updatedState = loadPostingState();
      const nextPostAfter = getNextPost(posts, updatedState);

      if (!nextPostAfter) {
        console.log('[daemon] All posts completed. Shutting down.');
        break;
      }

      console.log(`\n[daemon] Waiting ${formatDelay(delayMs)} before next post...`);
      console.log(`[daemon] Post #${nextPostAfter.id} will run at ${new Date(Date.now() + delayMs).toISOString()}`);

      // Countdown with periodic log every hour
      const checkInterval = Math.min(3600000, delayMs / 4);
      const startTime = Date.now();
      while (Date.now() - startTime < delayMs) {
        const remaining = delayMs - (Date.now() - startTime);
        if (remaining > 0) {
          await sleep(Math.min(checkInterval, remaining));
          const stillLeft = delayMs - (Date.now() - startTime);
          if (stillLeft > 60000) {
            console.log(`[daemon] Still waiting... (${formatDelay(stillLeft)} remaining)`);
          }
        }
      }

      console.log('[daemon] Delay complete. Proceeding with next post...');
    } catch (err) {
      console.error(`[daemon] Error during posting: ${err.message}`);
      consecutiveErrors++;

      if (consecutiveErrors >= maxErrors) {
        console.error(`[daemon] ❌ ${maxErrors} consecutive errors. Stopping daemon.`);
        process.exit(1);
      }

      // Longer retry delay — session failures need time to resolve
      const retryDelay = 15 * 60 * 1000; // 15 minutes
      console.log(`[daemon] Retry ${consecutiveErrors}/${maxErrors} in ${formatDelay(retryDelay)}...`);
      await sleep(retryDelay);
    }
  }
}

// Run the daemon
runDaemon().catch((err) => {
  console.error('[daemon] Fatal error:', err);
  process.exit(1);
});

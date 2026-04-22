#!/usr/bin/env node
/**
 * Quick test to validate 2Captcha API key
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env
dotenv.config({ path: path.join(__dirname, '.env') });

const apiKey = process.env.CAPTCHA_API_KEY;

if (!apiKey) {
  console.error('❌ CAPTCHA_API_KEY not set in .env');
  process.exit(1);
}

console.log(`🔍 Testing CAPTCHA key: ${apiKey.substring(0, 8)}...`);
console.log('📡 Making request to 2captcha API...\n');

// Test the API key by making a simple balance check request
async function testCaptchaKey() {
  try {
    const url = new URL('https://2captcha.com/res.php');
    url.searchParams.set('key', apiKey);
    url.searchParams.set('action', 'getbalance');
    url.searchParams.set('json', '1');

    const response = await fetch(url);
    const text = await response.text();
    
    console.log('Raw response:', text);
    
    try {
      const data = JSON.parse(text);
      
      if (data.status === 1) {
        console.log('\n✅ API KEY IS VALID!');
        console.log(`💰 Account balance: $${data.request}`);
        return true;
      } else {
        console.log('\n❌ API KEY IS INVALID or ERROR');
        console.log(`Error: ${data.request || data.error || 'Unknown error'}`);
        return false;
      }
    } catch {
      // Try legacy response format
      if (text.startsWith('OK|')) {
        console.log('\n✅ API KEY IS VALID!');
        console.log(`💰 Account balance: $${text.substring(3)}`);
        return true;
      } else if (text === 'ERROR_KEY_INVALID' || text.includes('ERROR')) {
        console.log('\n❌ API KEY IS INVALID');
        console.log(`Error: ${text}`);
        return false;
      } else {
        console.log('\n⚠️ Unexpected response format:', text);
        return false;
      }
    }
  } catch (err) {
    console.error('\n❌ Network/Connection Error:');
    console.error(err.message);
    return false;
  }
}

const isValid = await testCaptchaKey();
process.exit(isValid ? 0 : 1);

import fs from 'fs';
import path from 'path';

const distIndexPath = path.resolve('dist', 'index.html');
const placeholders = {
  __VITE_FIREBASE_API_KEY__: process.env.VITE_FIREBASE_API_KEY || '',
  __VITE_FIREBASE_AUTH_DOMAIN__: process.env.VITE_FIREBASE_AUTH_DOMAIN || '',
  __VITE_FIREBASE_PROJECT_ID__: process.env.VITE_FIREBASE_PROJECT_ID || '',
  __VITE_FIREBASE_STORAGE_BUCKET__: process.env.VITE_FIREBASE_STORAGE_BUCKET || '',
  __VITE_FIREBASE_MESSAGING_SENDER_ID__: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
  __VITE_FIREBASE_APP_ID__: process.env.VITE_FIREBASE_APP_ID || '',
  __VITE_FIREBASE_MEASUREMENT_ID__: process.env.VITE_FIREBASE_MEASUREMENT_ID || '',
};

const missing = Object.entries(placeholders)
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missing.length > 0) {
  console.error(`Missing Firebase env values for: ${missing.join(', ')}`);
  process.exit(1);
}

if (!fs.existsSync(distIndexPath)) {
  console.error('dist/index.html not found. Run the build first.');
  process.exit(1);
}

let html = fs.readFileSync(distIndexPath, 'utf8');
for (const [placeholder, value] of Object.entries(placeholders)) {
  html = html.split(placeholder).join(value);
}

if (html.includes('__VITE_FIREBASE_')) {
  console.error('Unreplaced Firebase placeholders remain in dist/index.html.');
  process.exit(1);
}

fs.writeFileSync(distIndexPath, html, 'utf8');

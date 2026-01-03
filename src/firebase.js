import { initializeApp } from 'firebase/app';
import { getAnalytics } from 'firebase/analytics';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const runtimeConfig = typeof window !== 'undefined' ? window.__FIREBASE_CONFIG__ : {};
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || runtimeConfig.apiKey,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || runtimeConfig.authDomain,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || runtimeConfig.projectId,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || runtimeConfig.storageBucket,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || runtimeConfig.messagingSenderId,
  appId: import.meta.env.VITE_FIREBASE_APP_ID || runtimeConfig.appId,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || runtimeConfig.measurementId,
};

const app = initializeApp(firebaseConfig);
const analytics = typeof window !== 'undefined' ? getAnalytics(app) : null;
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();
const db = getFirestore(app);

export { app, analytics, auth, db, googleProvider };

import { initializeApp } from 'firebase/app';
import { getAnalytics } from 'firebase/analytics';
import { getAuth, onAuthStateChanged, signInAnonymously } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: 'AIzaSyCWpDWiQLOUuqDjLpY_ea8n2K8s2HcbwlY',
  authDomain: 'drogas-hsvp.firebaseapp.com',
  projectId: 'drogas-hsvp',
  storageBucket: 'drogas-hsvp.firebasestorage.app',
  messagingSenderId: '550785141924',
  appId: '1:550785141924:web:0ff08da69a056d60186a31',
  measurementId: 'G-NFVFVGSXYZ',
};

const app = initializeApp(firebaseConfig);
const analytics = typeof window !== 'undefined' ? getAnalytics(app) : null;
const auth = getAuth(app);
const db = getFirestore(app);

const ensureAnonymousSignIn = () =>
  new Promise((resolve, reject) => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        unsubscribe();
        resolve(user);
        return;
      }
      try {
        const credential = await signInAnonymously(auth);
        unsubscribe();
        resolve(credential.user);
      } catch (error) {
        unsubscribe();
        reject(error);
      }
    });
  });

export { app, analytics, auth, db, ensureAnonymousSignIn };

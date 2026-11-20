import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth, signInAnonymously, signInWithCustomToken } from "firebase/auth";
import { initializeAppCheck, ReCaptchaV3Provider } from "firebase/app-check";
import { getFirestore } from "firebase/firestore";

const env = import.meta.env ?? {};
const firebaseConfig = Object.freeze({
  apiKey: env.VITE_FIREBASE_API_KEY || "",
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || "",
  projectId: env.VITE_FIREBASE_PROJECT_ID || "",
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || "",
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || "",
  appId: env.VITE_FIREBASE_APP_ID || ""
});

const hasRequiredConfig = Boolean(
  firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId && firebaseConfig.appId
);

export const firebaseApp = (() => {
  if (!hasRequiredConfig) {
    console.warn("GrassVault Firebase is disabled: set VITE_FIREBASE_* configuration variables.");
    return null;
  }
  try {
    return getApps().some((app) => app.name === "grassvault")
      ? getApp("grassvault")
      : initializeApp(firebaseConfig, "grassvault");
  } catch (error) {
    console.error("GrassVault could not initialize Firebase.", error);
    return null;
  }
})();

export const firebaseAppCheck = (() => {
  if (!firebaseApp) return null;
  const debugTokenEnabled = env.VITE_FIREBASE_APPCHECK_DEBUG_TOKEN === "true";
  const siteKey = env.VITE_FIREBASE_RECAPTCHA_V3_SITE_KEY || "";
  if (debugTokenEnabled && typeof self !== "undefined") self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  if (!siteKey) {
    console.warn("Firebase App Check is not initialized: set VITE_FIREBASE_RECAPTCHA_V3_SITE_KEY.");
    return null;
  }
  try {
    return initializeAppCheck(firebaseApp, {
      provider: new ReCaptchaV3Provider(siteKey),
      isTokenAutoRefreshEnabled: true
    });
  } catch (error) {
    console.error("GrassVault could not initialize Firebase App Check.", error);
    return null;
  }
})();

export const firebaseAuth = firebaseApp ? getAuth(firebaseApp) : null;
export const firestore = firebaseApp ? getFirestore(firebaseApp) : null;
export const auth = firebaseAuth;
export const db = firestore;

export async function signInFirebaseUser({ customToken } = {}) {
  if (!firebaseAuth) throw new Error("Firebase Auth is unavailable. Check the Firebase configuration.");
  if (typeof customToken === "string" && customToken.trim()) {
    return signInWithCustomToken(firebaseAuth, customToken.trim());
  }
  return signInAnonymously(firebaseAuth);
}

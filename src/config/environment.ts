// Environment configuration for BlurShield extension
export const config = {
  // Firebase configuration from environment variables
  firebase: {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  },

  // OAuth configuration from environment variables
  oauth: {
    clientId: import.meta.env.VITE_OAUTH_CLIENT_ID,
    scopes: ["email", "profile"],
  },

  // Extension configuration
  extension: {
    version: "1.0.0",
    name: "BlurShield",
    maxBlursPerDay: 10,
    maxTextSelectionLength: 100,
  },
};

// Validate required configuration
if (typeof window !== "undefined") {
  console.log("BlurShield config loaded:", {
    hasFirebaseConfig: !!config.firebase.apiKey,
    hasOAuthConfig: !!config.oauth.clientId,
    version: config.extension.version,
  });
}

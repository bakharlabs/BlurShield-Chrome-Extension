// Extension-specific Firebase Authentication service using Chrome Identity API
import {
  signInWithCredential,
  GoogleAuthProvider,
  signOut,
  onAuthStateChanged,
} from "firebase/auth";
import { auth } from "./firebase-config";
import browser from "webextension-polyfill";

// Use Chrome's native identity API directly without conflicting type declarations

// Use Chrome's native identity API
const chromeIdentity = (globalThis as any).chrome?.identity;

export interface AuthUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
}

class ExtensionAuthService {
  private currentUser: AuthUser | null = null;
  private authStateListeners: ((user: AuthUser | null) => void)[] = [];

  constructor() {
    // Initialize current user immediately if Firebase has one
    this.initializeCurrentUser();

    // Listen for auth state changes
    onAuthStateChanged(auth, (user) => {
      if (user) {
        this.currentUser = {
          uid: user.uid,
          email: user.email,
          displayName: user.displayName,
          photoURL: user.photoURL,
        };
      } else {
        this.currentUser = null;
      }

      // Notify all listeners
      this.authStateListeners.forEach((listener) => listener(this.currentUser));

      // Broadcast auth state change to content scripts via background

      this.notifyBackgroundOfAuthChange(this.currentUser);
    });
  }

  // Initialize current user from Firebase auth immediately
  private initializeCurrentUser(): void {
    const user = auth.currentUser;

    if (user) {
      this.currentUser = {
        uid: user.uid,
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL,
      };
    } else {
      this.currentUser = null;
    }
  }

  // DEPRECATED: Force account selection by completely clearing Chrome's auth cache
  // This method is no longer used - account selection now happens automatically after sign-out
  /* async signInWithAccountSelection(): Promise<AuthUser> {

    try {
      // Step 1: Aggressive sign-out first
      await this.signOut();

      // Step 2: Wait for Chrome to process the clearing
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Step 3: Try to force Chrome to forget the session entirely
      if (chromeIdentity) {
        // Use launchWebAuthFlow with explicit account selection
        try {

          const authUrl =
            `https://accounts.google.com/oauth/authorize?` +
            `client_id=1063241686793-e7467aljgg3ifkqn99is7tod7p6493bb.apps.googleusercontent.com&` +
            `response_type=token&` +
            `redirect_uri=https://blur-anything-extension.firebaseapp.com&` +
            `scope=email%20profile&` +
            `prompt=select_account&` + // Force account picker
            `access_type=online&` +
            `state=${Date.now()}`;

          const redirectUrl = await new Promise<string>((resolve, reject) => {
            const timeoutId = setTimeout(() => {
              reject(new Error("Account selection timed out"));
            }, 60000);

            chromeIdentity.launchWebAuthFlow(
              {
                url: authUrl,
                interactive: true,
              },
              (redirectUrl: string) => {
                clearTimeout(timeoutId);

                if ((globalThis as any).chrome.runtime.lastError) {
                  reject(new Error("Account selection failed or cancelled"));
                } else {
                  resolve(redirectUrl);
                }
              }
            );
          });

          // Extract access token from redirect URL
          const accessToken = new URL(redirectUrl).hash.match(
            /access_token=([^&]+)/
          )?.[1];

          if (!accessToken) {
            throw new Error("No access token received from account selection");
          }

          // Sign in to Firebase with the new token
          const credential = GoogleAuthProvider.credential(null, accessToken);
          const result = await signInWithCredential(auth, credential);

          if (!result.user) {
            throw new Error("Firebase sign-in failed");
          }

          const authUser: AuthUser = {
            uid: result.user.uid,
            email: result.user.email,
            displayName: result.user.displayName,
            photoURL: result.user.photoURL,
          };

          return authUser;
        } catch (webAuthError) {

          // Fall back to regular sign-in
        }
      }

      // Fallback: Regular sign-in (but after aggressive clearing)

      return await this.signInWithGoogle();
    } catch (error) {
      console.error("Account selection completely failed:", error);
      throw new Error(
        "Account selection failed. Please try: 1) Go to google.com 2) Sign out 3) Sign in with desired account 4) Return to extension"
      );
    }
  } */

  private isSigningIn = false;

  // Sign in with Google using Chrome Identity API
  async signInWithGoogle(): Promise<AuthUser> {
    // Prevent multiple simultaneous sign-in attempts
    if (this.isSigningIn) {
      throw new Error("Sign-in already in progress");
    }

    this.isSigningIn = true;

    try {
      if (!chromeIdentity) {
        throw new Error("Chrome Identity API not available");
      }

      // Simple sign-in flow
      const token = await new Promise<string>((resolve, reject) => {
        chromeIdentity.getAuthToken({ interactive: true }, (token: string) => {
          const lastError = (globalThis as any).chrome.runtime.lastError;
          if (lastError) {
            // Handle user cancellation gracefully
            if (
              lastError.message.includes("did not approve") ||
              lastError.message.includes("cancelled") ||
              lastError.message.includes("canceled")
            ) {
              reject(new Error("Sign-in cancelled by user"));
            } else {
              reject(new Error(lastError.message));
            }
          } else {
            resolve(token);
          }
        });
      });

      if (!token) {
        throw new Error("Failed to get OAuth token");
      }

      // Quick Firebase sign-in
      const credential = GoogleAuthProvider.credential(null, token);
      const result = await signInWithCredential(auth, credential);
      const user = result.user;

      const authUser: AuthUser = {
        uid: user.uid,
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL,
      };

      // Update state immediately
      this.currentUser = authUser;
      this.authStateListeners.forEach((listener) => listener(authUser));
      this.notifyBackgroundOfAuthChange(authUser);

      return authUser;
    } catch (error) {
      const errorMessage = (error as Error).message;

      // Don't log cancellation as an error - it's normal user behavior
      if (errorMessage.includes("cancelled")) {
      } else {
        console.error("Error signing in with Google:", error);
      }

      throw error;
    } finally {
      this.isSigningIn = false;
    }
  }

  // Ultra-fast sign out
  async signOut(): Promise<void> {
    try {
      // Quick Firebase sign-out
      await signOut(auth);

      // Clear Chrome tokens to prevent account confusion on next sign-in
      if (chromeIdentity) {
        chromeIdentity.clearAllCachedAuthTokens(() => {});
      }

      // Update state immediately
      this.currentUser = null;
      this.authStateListeners.forEach((listener) => listener(null));
      this.notifyBackgroundOfAuthChange(null);
    } catch (error) {
      console.error("Error during sign-out:", error);
      throw error;
    }
  }

  // Notify background script about authentication state change
  private async notifyBackgroundOfAuthChange(
    user: AuthUser | null
  ): Promise<void> {
    try {
      await browser.runtime.sendMessage({
        type: "BROADCAST_AUTH_STATE",
        user: user,
      });
    } catch (error) {}
  }

  // REMOVED: Slow token clearing method - using fast single clear instead

  // DEPRECATED: Web auth flow method (commented out as it causes authorization page load errors)
  /*
  private async performAccountSelection(): Promise<AuthUser> {
    try {

      // Quick token clear (no waiting)
      if (chromeIdentity) {
        try {
          await new Promise<void>((resolve) => {
            chromeIdentity.clearAllCachedAuthTokens(() => {

                  resolve();
            });
          });

          // Small delay to let Chrome process the clearing
          await new Promise((resolve) => setTimeout(resolve, 200));
        } catch (error) {

        }
      }

      // Simple, fast web auth flow
      const authUrl =
        `https://accounts.google.com/oauth/authorize?` +
        `client_id=1063241686793-e7467aljgg3ifkqn99is7tod7p6493bb.apps.googleusercontent.com&` +
        `response_type=token&` +
        `redirect_uri=https://blur-anything-extension.firebaseapp.com&` +
        `scope=email%20profile&` +
        `prompt=select_account&` + // Force account picker
        `state=${Date.now()}`;

      const redirectUrl = await new Promise<string>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new Error("Account selection timed out"));
        }, 30000); // Shorter timeout

        chromeIdentity.launchWebAuthFlow(
          {
            url: authUrl,
            interactive: true,
          },
          (redirectUrl: string) => {
            clearTimeout(timeoutId);

            const lastError = (globalThis as any).chrome.runtime.lastError;
            if (lastError) {
              console.error("❌ Chrome runtime error:", lastError.message);

              // Provide more specific error messages
              if (lastError.message.includes("Authorization page")) {
                reject(
                  new Error("Account selection was cancelled or failed to load")
                );
              } else if (lastError.message.includes("User did not approve")) {
                reject(new Error("Account selection was cancelled by user"));
              } else if (lastError.message.includes("Timeout")) {
                reject(
                  new Error("Account selection timed out - please try again")
                );
              } else {
                reject(
                  new Error(`Account selection failed: ${lastError.message}`)
                );
              }
            } else {

              resolve(redirectUrl);
            }
          }
        );
      });

      // Extract token quickly
      const accessToken = new URL(redirectUrl).hash.match(
        /access_token=([^&]+)/
      )?.[1];

      if (!accessToken) {
        throw new Error("No access token received");
      }

      // Fast Firebase sign-in
      const credential = GoogleAuthProvider.credential(null, accessToken);
      const result = await signInWithCredential(auth, credential);

      if (!result.user) {
        throw new Error("Firebase sign-in failed");
      }

      const authUser: AuthUser = {
        uid: result.user.uid,
        email: result.user.email,
        displayName: result.user.displayName,
        photoURL: result.user.photoURL,
      };

      return authUser;
    } catch (error) {
      console.error("Account selection error:", error);
      throw error;
    }
  }
  */

  // Get current user
  getCurrentUser(): AuthUser | null {
    // Double-check Firebase auth in case of timing issues
    const firebaseUser = auth.currentUser;
    if (firebaseUser && !this.currentUser) {
      this.initializeCurrentUser();
    }

    return this.currentUser;
  }

  // Set current user (for cross-context synchronization)
  setCurrentUser(user: AuthUser | null): void {
    this.currentUser = user;

    // Notify all listeners
    this.authStateListeners.forEach((listener) => listener(user));
  }

  // Force refresh current user state from Firebase
  refreshCurrentUser(): void {
    this.initializeCurrentUser();
  }

  // Check if user is authenticated
  isAuthenticated(): boolean {
    return this.currentUser !== null;
  }

  // Add auth state listener
  onAuthStateChange(callback: (user: AuthUser | null) => void): () => void {
    this.authStateListeners.push(callback);

    // Return unsubscribe function
    return () => {
      const index = this.authStateListeners.indexOf(callback);
      if (index > -1) {
        this.authStateListeners.splice(index, 1);
      }
    };
  }
}

// Export singleton instance
export const extensionAuthService = new ExtensionAuthService();
export default extensionAuthService;

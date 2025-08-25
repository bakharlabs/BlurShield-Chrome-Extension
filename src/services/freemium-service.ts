// Freemium service for managing user tiers and feature restrictions
import browser from "webextension-polyfill";
import { extensionAuthService } from "../firebase/extension-auth-service";
import { auth } from "../firebase/firebase-config";

export type UserTier = "free" | "premium";

export interface FeatureLimits {
  // Daily limits
  maxBlursPerDay: number;

  // Blur types allowed
  allowedBlurTypes: BlurType[];

  // Capability restrictions (reduce rather than remove)
  maxBlurIntensity: number; // percentage (0-100)
  maxRectangleSize: { width: number; height: number }; // pixels
  maxTextSelectionLength: number; // characters

  // Feature availability
  canPersistBlurs: boolean; // URL persistence across reloads
  canSync: boolean; // Cross-device sync
  canUseAdvancedStyles: boolean;
  canUseCustomCSS: boolean;
  canExportSettings: boolean;
  canUsePrioritySupport: boolean;

  // Advanced features
  canUseCustomAreas: boolean;
  canUseAutoBlur: boolean;
  canUseBulkActions: boolean;
}

export type BlurType = "click" | "rectangle" | "text" | "custom-area";

export interface DailyUsage {
  date: string; // YYYY-MM-DD format
  blurCount: number;
}

class FreemiumService {
  private currentTier: UserTier = "free";
  private dailyUsage: DailyUsage | null = null;

  constructor() {
    this.initializeDailyUsage();

    // Check current user immediately
    const currentUser = extensionAuthService.getCurrentUser();
    if (currentUser) {
      this.currentTier = "premium";
    } else {
      this.currentTier = "free";
    }

    // Listen for auth state changes to update user tier
    extensionAuthService.onAuthStateChange(async (user) => {
      if (user) {
        // Signed-in users get premium features (paid features coming soon)
        this.currentTier = "premium";
      } else {
        this.currentTier = "free";
      }
    });
  }

  // Initialize daily usage tracking
  private async initializeDailyUsage(): Promise<void> {
    try {
      // Check if extension context is still valid
      if (!this.isExtensionContextValid()) {
        this.dailyUsage = {
          date: new Date().toISOString().split("T")[0],
          blurCount: 0,
        };
        return;
      }

      const today = new Date().toISOString().split("T")[0];
      const stored = await browser.storage.local.get(["dailyUsage"]);

      if (stored.dailyUsage && stored.dailyUsage.date === today) {
        this.dailyUsage = stored.dailyUsage;
      } else {
        // Reset for new day
        this.dailyUsage = { date: today, blurCount: 0 };
        await this.saveDailyUsage();
      }
    } catch (error) {
      console.error("Failed to initialize daily usage:", error);
      this.dailyUsage = {
        date: new Date().toISOString().split("T")[0],
        blurCount: 0,
      };
    }
  }

  // Save daily usage to storage
  private async saveDailyUsage(): Promise<void> {
    try {
      // Check if extension context is still valid
      if (!this.isExtensionContextValid()) {
        return;
      }

      await browser.storage.local.set({ dailyUsage: this.dailyUsage });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message?.includes("Extension context invalidated")
      ) {
        return;
      }
      console.error("Failed to save daily usage:", error);
    }
  }

  // Check if extension context is still valid
  private isExtensionContextValid(): boolean {
    try {
      // Try to access browser runtime - will throw if context is invalid
      return !!browser?.runtime?.id;
    } catch (error) {
      return false;
    }
  }

  // Get current user tier
  getUserTier(): UserTier {
    return this.currentTier;
  }

  // Check if user is premium
  isPremium(): boolean {
    return this.currentTier === "premium";
  }

  // Debug method to check auth state
  debugAuthState(): void {
    // Force refresh auth state first
    extensionAuthService.refreshCurrentUser();

    const user = extensionAuthService.getCurrentUser();

    console.log("- Is premium:", this.isPremium());

    // If there's a user but tier is wrong, fix it
    if (user && this.currentTier !== "premium") {
      this.currentTier = "premium";
    }
  }

  // Get feature limits based on user tier
  getFeatureLimits(): FeatureLimits {
    switch (this.currentTier) {
      case "premium":
        return {
          maxBlursPerDay: Infinity,
          allowedBlurTypes: ["click", "rectangle", "text", "custom-area"],
          maxBlurIntensity: 100,
          maxRectangleSize: { width: Infinity, height: Infinity },
          maxTextSelectionLength: Infinity,
          canPersistBlurs: true,
          canSync: true,
          canUseAdvancedStyles: true,
          canUseCustomCSS: true,
          canExportSettings: true,
          canUsePrioritySupport: true,
          canUseCustomAreas: true,
          canUseAutoBlur: true,
          canUseBulkActions: true,
        };

      case "free":
      default:
        return {
          maxBlursPerDay: 10, // Daily limit for free users
          allowedBlurTypes: ["click", "rectangle", "text"], // Allow all basic blur types
          maxBlurIntensity: 50, // Reduced blur intensity
          maxRectangleSize: { width: 200, height: 200 }, // Small rectangles
          maxTextSelectionLength: 100, // Reasonable text selection limit
          canPersistBlurs: false, // No URL persistence
          canSync: false,
          canUseAdvancedStyles: false,
          canUseCustomCSS: false,
          canExportSettings: false,
          canUsePrioritySupport: false,
          canUseCustomAreas: false,
          canUseAutoBlur: false,
          canUseBulkActions: false,
        };
    }
  }

  // Check if user can add more blurs today
  async canAddBlur(): Promise<boolean> {
    this.debugAuthState();

    if (this.isPremium()) {
      return true; // Premium users have no daily limits
    }

    try {
      // Ensure daily usage is current
      await this.initializeDailyUsage();

      const limits = this.getFeatureLimits();
      const currentCount = this.dailyUsage?.blurCount || 0;

      return currentCount < limits.maxBlursPerDay;
    } catch (error) {
      return true; // Default to allowing blur if we can't check
    }
  }

  // Check if blur type is allowed for current user
  canUseBlurType(blurType: BlurType): boolean {
    const limits = this.getFeatureLimits();
    return limits.allowedBlurTypes.includes(blurType);
  }

  // Get maximum blur intensity for current tier
  getMaxBlurIntensity(): number {
    const limits = this.getFeatureLimits();
    return limits.maxBlurIntensity;
  }

  // Get maximum rectangle size for current tier
  getMaxRectangleSize(): { width: number; height: number } {
    const limits = this.getFeatureLimits();
    return limits.maxRectangleSize;
  }

  // Get maximum text selection length for current tier
  getMaxTextSelectionLength(): number {
    const limits = this.getFeatureLimits();
    return limits.maxTextSelectionLength;
  }

  // Increment daily blur count
  async incrementDailyBlurCount(): Promise<void> {
    if (this.isPremium()) {
      return; // Premium users don't have daily limits
    }

    try {
      await this.initializeDailyUsage();

      if (this.dailyUsage) {
        const oldCount = this.dailyUsage.blurCount;
        this.dailyUsage.blurCount++;

        await this.saveDailyUsage();
      }
    } catch (error) {
      // Continue silently - don't block the blur operation
    }
  }

  // Get current daily blur count
  getDailyBlurCount(): number {
    return this.dailyUsage?.blurCount || 0;
  }

  // Get remaining daily blurs
  getRemainingDailyBlurs(): number {
    if (this.isPremium()) {
      return Infinity;
    }

    const limits = this.getFeatureLimits();
    const currentCount = this.getDailyBlurCount();

    return Math.max(0, limits.maxBlursPerDay - currentCount);
  }

  // Debug function to reset daily usage (for testing)
  async resetDailyUsage(): Promise<void> {
    this.dailyUsage = {
      date: new Date().toISOString().split("T")[0],
      blurCount: 0,
    };
    await this.saveDailyUsage();
  }

  // Test sign-in manually (call from console)
  async testSignIn(): Promise<void> {
    try {
      const result = await extensionAuthService.signInWithGoogle();

      // Force refresh state
      this.debugAuthState();
    } catch (error) {
      console.error("❌ Manual sign-in failed:", error);
    }
  }

  // Test auth state across contexts
  testAuthContext(): void {
    console.log(
      "- Extension current user:",
      extensionAuthService.getCurrentUser()?.email || "null"
    );

    console.log("- Is premium:", this.isPremium());
  }

  // Manual auth state update (for cross-context synchronization)
  updateAuthState(user: any): void {
    if (user) {
      // Signed-in users get premium features (paid features coming soon)
      this.currentTier = "premium";
    } else {
      this.currentTier = "free";
    }
  }

  // Get upgrade message for specific feature or limitation
  getUpgradeMessage(reason: string): string {
    const user = extensionAuthService.getCurrentUser();

    switch (reason) {
      case "daily-limit":
        if (!user) {
          return "🎯 Daily blur limit reached! Sign in for unlimited blurs.";
        }
        return "📈 Daily limit reached! Paid subscription coming soon for premium features.";

      case "blur-intensity":
        if (!user) {
          return "🔧 Want stronger blurs? Sign in to unlock 100% blur intensity.";
        }
        return "💪 Paid subscription coming soon for premium features.";

      case "rectangle-size":
        if (!user) {
          return "📏 Rectangle size limited! Sign in to blur unlimited areas.";
        }
        return "📐 Paid subscription coming soon for premium features.";

      case "text-selection":
        if (!user) {
          return "📝 Text selection limited to 5 characters. Sign in to select unlimited text.";
        }
        return "📖 Paid subscription coming soon for premium features.";

      case "blur-type-rectangle":
        return user
          ? "🔲 Rectangle blur available! Paid features coming soon."
          : "🔲 Rectangle blur requires an account. Sign in to unlock premium features.";

      case "blur-type-text":
        return user
          ? "📝 Text blur available! Paid features coming soon."
          : "📝 Text blur requires an account. Sign in to unlock premium features.";

      case "blur-type-custom":
        return "🎨 Custom area blur available for signed-in users! Paid features coming soon.";

      case "persistence":
        return user
          ? "💾 Blur persistence available! Paid features coming soon."
          : "💾 Blur persistence requires an account. Sign in to save blurs across page reloads.";

      case "sync":
        return user
          ? "☁️ Cross-device sync available! Paid features coming soon."
          : "☁️ Cross-device sync requires an account. Sign in to access blurs anywhere.";

      case "advanced-styles":
        return user
          ? "🎨 Advanced blur styles available! Paid features coming soon."
          : "🎨 Advanced blur styles require an account. Sign in to unlock visual effects.";

      case "custom-css":
        return "💻 Custom CSS available for signed-in users! Paid features coming soon.";

      case "export":
        return user
          ? "📤 Export/Import available! Paid features coming soon."
          : "📤 Export/Import requires an account. Sign in to backup your settings.";

      case "auto-blur":
        return "🤖 Auto-blur available for signed-in users! Paid features coming soon.";

      case "bulk-actions":
        return user
          ? "⚡ Bulk actions available! Paid features coming soon."
          : "⚡ Bulk actions require an account. Sign in to manage multiple blurs efficiently.";

      default:
        return user
          ? "🚀 This feature is available! Paid features coming soon."
          : "🚀 This feature requires an account. Sign in to unlock more capabilities.";
    }
  }

  // Show upgrade notification with tier-specific messaging
  showUpgradeNotification(reason: string, callback?: () => void): void {
    // Prevent duplicate notifications
    const existing = document.querySelector(
      ".blur-anything-upgrade-notification"
    );
    if (existing) {
      return;
    }

    const message = this.getUpgradeMessage(reason);
    const user = extensionAuthService.getCurrentUser();

    // Create notification element
    const notification = document.createElement("div");
    notification.className = "blur-anything-upgrade-notification";

    // Determine appropriate actions based on user state and current tier
    let actionButtons = "";

    if (!user) {
      // Anonymous user - encourage sign up
      actionButtons = `
        <button class="upgrade-btn primary" id="upgrade-sign-in">Sign In Free</button>
        <button class="upgrade-btn secondary" id="upgrade-dismiss">Maybe Later</button>
      `;
    } else {
      // Signed-in user - show coming soon message
      actionButtons = `
        <button class="upgrade-btn premium" id="upgrade-premium">Paid Features Coming Soon</button>
        <button class="upgrade-btn secondary" id="upgrade-dismiss">Dismiss</button>
      `;
    }

    notification.innerHTML = `
      <div class="upgrade-content">
        <div class="upgrade-icon">🔒</div>
        <div class="upgrade-text">${message}</div>
        <div class="upgrade-actions">
          ${actionButtons}
        </div>
      </div>
    `;

    // Add styles
    notification.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 16px;
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.3);
      z-index: 10000;
      max-width: 360px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      animation: slideInRight 0.3s ease-out;
    `;

    // Add animation styles if not already present
    if (!document.getElementById("upgrade-notification-styles")) {
      const style = document.createElement("style");
      style.id = "upgrade-notification-styles";
      style.textContent = `
        @keyframes slideInRight {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
        .upgrade-content { display: flex; flex-direction: column; gap: 12px; }
        .upgrade-icon { font-size: 24px; text-align: center; }
        .upgrade-text { font-size: 14px; line-height: 1.4; text-align: center; }
        .upgrade-actions { display: flex; gap: 8px; flex-wrap: wrap; }
        .upgrade-btn { 
          flex: 1; padding: 8px 12px; border: none; border-radius: 6px; 
          font-weight: 600; cursor: pointer; transition: all 0.2s;
          font-size: 12px; min-width: 80px;
        }
        .upgrade-btn.primary { background: #28a745; color: white; }
        .upgrade-btn.premium { background: #6f42c1; color: white; }
        .upgrade-btn.secondary { background: rgba(0,0,0,0.2); color: white; }
        .upgrade-btn:hover { transform: translateY(-1px); opacity: 0.9; }
      `;
      document.head.appendChild(style);
    }

    document.body.appendChild(notification);

    // Handle sign in button
    const signInBtn = notification.querySelector("#upgrade-sign-in");
    signInBtn?.addEventListener("click", async () => {
      notification.remove();
      if (callback) callback();

      // Try to open popup programmatically for sign-in
      try {
        if (this.isExtensionContextValid()) {
          const response = await browser.runtime.sendMessage({
            action: "openSignInPopup",
          });

          if (response.success) {
          } else {
            this.showComingSoonMessage(
              "Please click the extension icon in your browser toolbar to sign in."
            );
          }
        } else {
          this.showComingSoonMessage(
            "Please click the extension icon in your browser toolbar to sign in."
          );
        }
      } catch (error) {
        this.showComingSoonMessage(
          "Please click the extension icon in your browser toolbar to sign in."
        );
      }
    });

    // Handle premium upgrade button (coming soon)
    const premiumBtn = notification.querySelector("#upgrade-premium");
    premiumBtn?.addEventListener("click", () => {
      notification.remove();
      this.showComingSoonMessage(
        "Paid subscription system is coming soon! All premium features are currently free for signed-in users."
      );
    });

    // Handle dismiss button
    const dismissBtn = notification.querySelector("#upgrade-dismiss");
    dismissBtn?.addEventListener("click", () => {
      notification.remove();
      if (callback) callback();
    });

    // Auto-dismiss after 10 seconds
    setTimeout(() => {
      if (notification.parentNode) {
        notification.remove();
      }
    }, 10000);
  }

  // Show coming soon message for subscription tiers
  private showComingSoonMessage(tierName: string): void {
    const messageDiv = document.createElement("div");
    messageDiv.style.cssText = `
      position: fixed; top: 20px; right: 20px; background: #007cba; color: white;
      padding: 12px 16px; border-radius: 8px; z-index: 10001; max-width: 300px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    `;
    messageDiv.textContent = `${tierName} coming soon! Payment integration will be added in the next update.`;
    document.body.appendChild(messageDiv);

    setTimeout(() => {
      if (messageDiv.parentNode) {
        messageDiv.remove();
      }
    }, 5000);
  }

  // Check if feature is available and show upgrade notification if not
  checkFeatureAccess(feature: string, callback?: () => void): boolean {
    const limits = this.getFeatureLimits();
    let hasAccess = false;
    let reason = feature;

    switch (feature) {
      case "blur-type-rectangle":
        hasAccess = limits.allowedBlurTypes.includes("rectangle");
        break;
      case "blur-type-text":
        hasAccess = limits.allowedBlurTypes.includes("text");
        break;
      case "blur-type-custom":
        hasAccess = limits.allowedBlurTypes.includes("custom-area");
        break;
      case "persistence":
        hasAccess = limits.canPersistBlurs;
        break;
      case "sync":
        hasAccess = limits.canSync;
        break;
      case "advanced-styles":
        hasAccess = limits.canUseAdvancedStyles;
        break;
      case "custom-css":
        hasAccess = limits.canUseCustomCSS;
        break;
      case "export":
        hasAccess = limits.canExportSettings;
        break;
      case "auto-blur":
        hasAccess = limits.canUseAutoBlur;
        break;
      case "bulk-actions":
        hasAccess = limits.canUseBulkActions;
        break;
      default:
        hasAccess = true;
    }

    if (!hasAccess) {
      this.showUpgradeNotification(reason, callback);
    }

    return hasAccess;
  }

  // Get tier display info for UI
  getTierDisplayInfo(): { name: string; color: string; features: string[] } {
    switch (this.currentTier) {
      case "premium":
        return {
          name: "PREMIUM",
          color: "#6f42c1",
          features: [
            "Unlimited daily blurs",
            "All blur types",
            "Custom areas",
            "Auto-blur",
            "Custom CSS",
          ],
        };

      case "free":
      default:
        return {
          name: "FREE",
          color: "#6c757d",
          features: [
            "10 daily blurs",
            "Click blur only",
            "50% max intensity",
            "No persistence",
          ],
        };
    }
  }

  // Get subscription tier pricing info (for future payment integration)
  getTierPricing(): {
    premium: { monthly: number; yearly: number };
  } {
    return {
      premium: {
        monthly: 4.99,
        yearly: 49.99,
      },
    };
  }
}

// Export singleton instance
export const freemiumService = new FreemiumService();
export default freemiumService;

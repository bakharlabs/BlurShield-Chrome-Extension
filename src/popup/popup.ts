// Modern Popup script for BlurShield extension

import browser from "webextension-polyfill";
import { extensionAuthService as authService } from "../firebase/extension-auth-service";
import { freemiumService } from "../services/freemium-service";

// Helper function to show temporary messages
function showTemporaryMessage(message: string, duration: number = 3000) {
  const messageDiv = document.createElement("div");
  messageDiv.style.cssText = `
    position: fixed; top: 20px; right: 20px; background: #2563eb; color: white;
    padding: 12px 16px; border-radius: 12px; z-index: 10000; max-width: 300px;
    font-size: 14px; line-height: 1.4; box-shadow: 0 10px 25px rgba(37, 99, 235, 0.3);
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    backdrop-filter: blur(10px); border: 1px solid rgba(255, 255, 255, 0.1);
  `;
  messageDiv.textContent = message;
  document.body.appendChild(messageDiv);

  // Animate in
  messageDiv.style.transform = "translateX(100%)";
  requestAnimationFrame(() => {
    messageDiv.style.transition = "all 0.3s ease-out";
    messageDiv.style.transform = "translateX(0)";
  });

  setTimeout(() => {
    if (document.body.contains(messageDiv)) {
      messageDiv.style.transform = "translateX(100%)";
      messageDiv.style.opacity = "0";
      setTimeout(() => {
        if (document.body.contains(messageDiv)) {
          document.body.removeChild(messageDiv);
        }
      }, 300);
    }
  }, duration);
}

interface Settings {
  blurIntensity: number;
  isEnabled: boolean;
  persistBlurs: boolean;
  hideTabTitles: boolean;
  autoBlurSensitive: boolean;
}

class PopupController {
  private settings: Settings = {
    blurIntensity: 10,
    isEnabled: true,
    persistBlurs: true,
    hideTabTitles: false,
    autoBlurSensitive: false,
  };

  constructor() {
    this.init();
  }

  private async init() {
    await this.loadSettings();
    this.setupEventListeners();
    this.updateUI();
    this.setupAuth();
    this.updateTierUI();
  }

  private setupEventListeners() {
    // Extension toggle
    const extensionToggle = document.getElementById(
      "extensionToggle"
    ) as HTMLInputElement;
    if (extensionToggle) {
      extensionToggle.checked = this.settings.isEnabled;
      extensionToggle.addEventListener("change", () => {
        this.settings.isEnabled = extensionToggle.checked;
        this.saveSettings();
        this.updateStatusIndicator();

        // Show/hide toolbar based on extension state
        this.toggleToolbar(this.settings.isEnabled);
      });
    }

    // User profile dropdown
    const userProfile = document.getElementById("userProfile");
    const userDropdown = document.getElementById("userDropdown");

    userProfile?.addEventListener("click", () => {
      userDropdown?.classList.toggle("show");
    });

    // Close dropdown when clicking outside
    document.addEventListener("click", (event) => {
      if (!userProfile?.contains(event.target as Node)) {
        userDropdown?.classList.remove("show");
      }
    });

    // Settings button
    const openOptionsBtn = document.getElementById("openOptions");
    openOptionsBtn?.addEventListener("click", () => {
      browser.tabs.create({
        url: browser.runtime.getURL("src/options/options.html"),
      });
    });

    // Auto-show toolbar when popup opens (if extension is enabled)
    if (this.settings.isEnabled) {
      this.showToolbar();
    }
  }

  private async loadSettings() {
    try {
      const savedSettings = await browser.runtime.sendMessage({
        action: "getSettings",
      });
      this.settings = { ...this.settings, ...savedSettings };
    } catch (error) {
      console.error("Failed to load settings:", error);
    }
  }

  private async saveSettings() {
    try {
      await browser.runtime.sendMessage({
        action: "updateSettings",
        settings: this.settings,
      });
    } catch (error) {
      console.error("Failed to save settings:", error);
    }
  }

  private updateUI() {
    this.updateStats();
    this.updateStatusIndicator();

    // Set up interval to update stats every 2 seconds to catch new blurs
    setInterval(() => {
      this.updateStats();
    }, 2000);
  }

  private updateStatusIndicator() {
    const statusText = document.getElementById("statusText") as HTMLElement;

    if (statusText) {
      if (this.settings.isEnabled) {
        statusText.textContent = "Active & Ready";
        statusText.className = "status active";
      } else {
        statusText.textContent = "Inactive";
        statusText.className = "status inactive";
      }
    }
  }

  private async updateStats() {
    try {
      const [tab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });

      if (tab.id) {
        const response = await browser.tabs.sendMessage(tab.id, {
          action: "getBlurCounts",
        });

        if (response?.success) {
          const { counts } = response;

          // Update individual blur type counts
          const clickBlursCount = document.getElementById(
            "blurredElementsCount"
          );
          const drawBlursCount = document.getElementById("blurredAreasCount");
          const textBlursCount = document.getElementById("blurredTextCount");

          if (clickBlursCount) {
            clickBlursCount.textContent = counts.clickBlurs?.toString() || "0";
          }
          if (drawBlursCount) {
            drawBlursCount.textContent = counts.drawBlurs?.toString() || "0";
          }
          if (textBlursCount) {
            textBlursCount.textContent = counts.textBlurs?.toString() || "0";
          }
        }
      }
    } catch (error) {
      // Set default values if content script is not available
      const clickBlursCount = document.getElementById("blurredElementsCount");
      const drawBlursCount = document.getElementById("blurredAreasCount");
      const textBlursCount = document.getElementById("blurredTextCount");

      if (clickBlursCount) clickBlursCount.textContent = "0";
      if (drawBlursCount) drawBlursCount.textContent = "0";
      if (textBlursCount) textBlursCount.textContent = "0";
    }
  }

  private async showToolbar() {
    try {
      const [tab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });

      if (tab.id) {
        try {
          await browser.tabs.sendMessage(tab.id, { action: "ping" });
          await browser.tabs.sendMessage(tab.id, { action: "showToolbar" });
        } catch (pingError) {}
      }
    } catch (error) {}
  }

  private async toggleToolbar(show: boolean) {
    try {
      const [tab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });

      if (tab.id) {
        try {
          await browser.tabs.sendMessage(tab.id, { action: "ping" });
        } catch (pingError) {
          showTemporaryMessage("Toolbar not available on this page");
          return;
        }

        const action = show ? "showToolbar" : "hideToolbar";
        await browser.tabs.sendMessage(tab.id, { action });
      }
    } catch (error) {
      console.error("Failed to toggle toolbar:", error);
      showTemporaryMessage("Failed to toggle toolbar");
    }
  }

  private setupAuth() {
    const signOutBtn = document.getElementById("signOutBtn");

    // Check initial auth state
    const currentUser = authService.getCurrentUser();
    if (currentUser) {
      this.updateUIForSignedInUser(currentUser);
    } else {
      this.updateUIForSignedOutUser();
    }

    // Sign out button (in dropdown)
    signOutBtn?.addEventListener("click", async () => {
      try {
        await authService.signOut();

        // No notification - UI will update automatically
        this.updateUIForSignedOutUser();
        this.updateTierUI();
      } catch (error) {
        console.error("Error signing out:", error);
        showTemporaryMessage("❌ Sign-out failed. Please try again.");
      }
    });

    // Auth state listener
    authService.onAuthStateChange((user: any) => {
      if (user) {
        this.updateUIForSignedInUser(user);
      } else {
        this.updateUIForSignedOutUser();
      }
      this.updateTierUI();
      // Re-setup dropdowns after UI state change
      setTimeout(() => {
        this.setupDropdowns();
      }, 100);
    });

    // Setup dropdown functionality
    this.setupDropdowns();
  }

  private removeDropdownListeners() {
    const userProfile = document.getElementById("userProfile");
    const guestProfile = document.getElementById("guestProfile");

    if (userProfile && (userProfile as any)._dropdownHandler) {
      userProfile.removeEventListener(
        "click",
        (userProfile as any)._dropdownHandler
      );
      (userProfile as any)._dropdownHandler = null;
    }

    if (guestProfile && (guestProfile as any)._dropdownHandler) {
      guestProfile.removeEventListener(
        "click",
        (guestProfile as any)._dropdownHandler
      );
      (guestProfile as any)._dropdownHandler = null;
    }
  }

  private setupDropdowns() {
    // Remove any existing click listeners to prevent duplicates
    this.removeDropdownListeners();

    // Setup user profile dropdown (signed in)
    const userProfile = document.getElementById("userProfile");
    const userDropdown = document.getElementById("userDropdown");

    // Ensure dropdowns start in hidden state
    if (userDropdown) {
      userDropdown.classList.remove("show");
      // Force hidden state with inline styles
      userDropdown.style.opacity = "0";
      userDropdown.style.visibility = "hidden";
      userDropdown.style.transform = "translateY(-10px)";
    }

    if (userProfile) {
      const userClickHandler = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();

        if (userDropdown) {
          const isCurrentlyShowing = userDropdown.classList.contains("show");

          // Use opacity as the source of truth instead of class
          const isActuallyVisible = userDropdown.style.opacity === "1";

          if (isActuallyVisible) {
            // Hide dropdown
            userDropdown.classList.remove("show");
            userDropdown.style.opacity = "0";
            userDropdown.style.visibility = "hidden";
            userDropdown.style.transform = "translateY(-10px)";
          } else {
            // Show dropdown
            userDropdown.classList.add("show");
            userDropdown.style.opacity = "1";
            userDropdown.style.visibility = "visible";
            userDropdown.style.transform = "translateY(0)";
          }
        }

        // Close guest dropdown if open
        const guestDropdown = document.getElementById("guestDropdown");
        if (guestDropdown) {
          guestDropdown.classList.remove("show");
          guestDropdown.style.opacity = "0";
          guestDropdown.style.visibility = "hidden";
          guestDropdown.style.transform = "translateY(-10px)";
        }
      };
      userProfile.addEventListener("click", userClickHandler);
      // Store handler for later removal
      (userProfile as any)._dropdownHandler = userClickHandler;
    }

    // Setup guest profile dropdown (signed out)
    const guestProfile = document.getElementById("guestProfile");
    const guestDropdown = document.getElementById("guestDropdown");

    // Ensure guest dropdown starts in hidden state
    if (guestDropdown) {
      guestDropdown.classList.remove("show");
      // Force hidden state with inline styles
      guestDropdown.style.opacity = "0";
      guestDropdown.style.visibility = "hidden";
      guestDropdown.style.transform = "translateY(-10px)";
    }

    if (guestProfile) {
      const guestClickHandler = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();

        if (guestDropdown) {
          const isCurrentlyShowing = guestDropdown.classList.contains("show");

          // Use opacity as the source of truth instead of class
          const isActuallyVisible = guestDropdown.style.opacity === "1";

          if (isActuallyVisible) {
            // Hide dropdown
            guestDropdown.classList.remove("show");
            guestDropdown.style.opacity = "0";
            guestDropdown.style.visibility = "hidden";
            guestDropdown.style.transform = "translateY(-10px)";
          } else {
            // Show dropdown
            guestDropdown.classList.add("show");
            guestDropdown.style.opacity = "1";
            guestDropdown.style.visibility = "visible";
            guestDropdown.style.transform = "translateY(0)";
          }
        }

        // Close user dropdown if open
        if (userDropdown) {
          userDropdown.classList.remove("show");
          userDropdown.style.opacity = "0";
          userDropdown.style.visibility = "hidden";
          userDropdown.style.transform = "translateY(-10px)";
        }
      };
      guestProfile.addEventListener("click", guestClickHandler);
      // Store handler for later removal
      (guestProfile as any)._dropdownHandler = guestClickHandler;
    }

    // Close dropdowns when clicking outside
    document.addEventListener("click", (event) => {
      if (
        !userProfile?.contains(event.target as Node) &&
        !guestProfile?.contains(event.target as Node)
      ) {
        if (userDropdown) {
          userDropdown.classList.remove("show");
          userDropdown.style.opacity = "0";
          userDropdown.style.visibility = "hidden";
          userDropdown.style.transform = "translateY(-10px)";
        }
        if (guestDropdown) {
          guestDropdown.classList.remove("show");
          guestDropdown.style.opacity = "0";
          guestDropdown.style.visibility = "hidden";
          guestDropdown.style.transform = "translateY(-10px)";
        }
      }
    });

    // Sign in from dropdown
    const signInFromDropdown = document.getElementById("signInFromDropdown");

    signInFromDropdown?.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Disable button to prevent multiple clicks
      const button = signInFromDropdown as HTMLButtonElement;
      if (button.disabled) {
        return;
      }

      button.disabled = true;
      const originalText = button.textContent;
      button.textContent = "Signing in...";

      try {
        const user = await authService.signInWithGoogle();

        // No notification - UI will update automatically
        guestDropdown?.classList.remove("show");
      } catch (error) {
        const errorMessage = (error as Error).message;

        // Handle different error types - don't log cancellation as error
        if (errorMessage.includes("cancelled")) {
          // Silent cancellation - no error message
        } else if (errorMessage.includes("already in progress")) {
          // Silent - no error message
        } else {
          console.error("❌ Error signing in:", error);
          showTemporaryMessage("❌ Sign-in failed. Please try again.");
        }
      } finally {
        // Re-enable button after delay
        setTimeout(() => {
          button.disabled = false;
          button.textContent = originalText;
        }, 1000);
      }
    });

    // Open options from guest dropdown
    const openOptionsFromGuest = document.getElementById(
      "openOptionsFromGuest"
    );
    openOptionsFromGuest?.addEventListener("click", () => {
      browser.runtime.openOptionsPage();
      guestDropdown?.classList.remove("show");
    });

    // Open options from user dropdown
    const openOptionsFromUser = document.getElementById("openOptionsFromUser");
    openOptionsFromUser?.addEventListener("click", () => {
      browser.runtime.openOptionsPage();
      userDropdown?.classList.remove("show");
    });
  }

  private updateUIForSignedInUser(user: any) {
    const signedInState = document.getElementById("signedInState");
    const signedOutState = document.getElementById("signedOutState");
    const userAvatar = document.getElementById(
      "userAvatar"
    ) as HTMLImageElement;
    const userName = document.getElementById("userName");
    const userTier = document.getElementById("userTier");

    if (signedOutState) signedOutState.style.display = "none";
    if (signedInState) signedInState.style.display = "flex";

    if (userAvatar && user.photoURL) {
      userAvatar.src = user.photoURL;
    }
    if (userName) {
      userName.textContent = user.displayName || user.email || "User";
    }

    // Update tier display in dropdown
    if (userTier) {
      const isPremium = freemiumService.isPremium();
      userTier.textContent = isPremium ? "Premium Plan" : "Free Plan";
    }
  }

  private updateUIForSignedOutUser() {
    const signedInState = document.getElementById("signedInState");
    const signedOutState = document.getElementById("signedOutState");

    if (signedOutState) signedOutState.style.display = "block";
    if (signedInState) signedInState.style.display = "none";
  }

  private async updateTierUI() {
    const tierBadge = document.getElementById("tierBadge");
    const blurCount = document.getElementById("blurCount");
    const blurLimit = document.getElementById("blurLimit");
    const progressFill = document.getElementById("progressFill");
    const upgradeBtn = document.getElementById("upgradeBtn");
    const usageCard = document.querySelector(".usage-card") as HTMLElement;
    const accountCard = document.querySelector(".account-card") as HTMLElement;

    // Get tier info
    const tierInfo = freemiumService.getTierDisplayInfo();
    const featureLimits = freemiumService.getFeatureLimits();
    const dailyCount = freemiumService.getDailyBlurCount();
    const isPremium = freemiumService.isPremium();

    // Update tier badge
    if (tierBadge) {
      tierBadge.textContent = tierInfo.name.toUpperCase();
      tierBadge.className = `tier-badge ${isPremium ? "premium" : ""}`;
    }

    // Update usage display
    if (blurCount) blurCount.textContent = dailyCount.toString();
    if (blurLimit) {
      blurLimit.textContent = isPremium
        ? "∞"
        : featureLimits.maxBlursPerDay.toString();
    }

    // Update progress bar
    if (progressFill) {
      if (isPremium) {
        progressFill.style.width = "100%";
        progressFill.className = "progress-fill premium";
      } else {
        const percentage = (dailyCount / featureLimits.maxBlursPerDay) * 100;
        progressFill.style.width = `${Math.min(percentage, 100)}%`;
        progressFill.className = "progress-fill";
      }
    }

    // Add premium styling to cards
    if (isPremium) {
      usageCard?.classList.add("premium");
      accountCard?.classList.add("premium");
    } else {
      usageCard?.classList.remove("premium");
      accountCard?.classList.remove("premium");
    }

    // Show/hide upgrade button
    if (upgradeBtn) {
      if (isPremium) {
        upgradeBtn.style.display = "none";
      } else {
        upgradeBtn.style.display = "flex";
        upgradeBtn.onclick = () => this.handleUpgradeClick();
      }
    }
  }

  private handleUpgradeClick() {
    const currentUser = authService.getCurrentUser();

    if (!currentUser) {
      // Not signed in - trigger sign in
      const signInBtn = document.getElementById("signInBtn");
      if (signInBtn) {
        signInBtn.click();
      }
    } else {
      // Already signed in - show coming soon message
      showTemporaryMessage(
        "💫 Paid features coming soon! You already have unlimited access.",
        4000
      );
    }
  }
}

// CSS for spin animation
const style = document.createElement("style");
style.textContent = `
  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
  .animate-spin {
    animation: spin 1s linear infinite;
  }
`;
document.head.appendChild(style);

// Initialize the popup when DOM is loaded
document.addEventListener("DOMContentLoaded", () => {
  new PopupController();
});

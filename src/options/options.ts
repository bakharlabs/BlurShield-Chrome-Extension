// Options page script for BlurShield extension

import browser from "webextension-polyfill";
import { freemiumService } from "../services/freemium-service";
import { extensionAuthService } from "../firebase/extension-auth-service";

interface Settings {
  blurIntensity: number;
  isEnabled: boolean;
  persistBlurs: boolean;
  hideTabTitles: boolean;
  autoBlurSensitive: boolean;
}

class OptionsController {
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
      this.showToast("Settings saved successfully!", "success");
    } catch (error) {
      console.error("Failed to save settings:", error);
      this.showToast("Failed to save settings", "error");
    }
  }

  private setupEventListeners() {
    // Extension enabled toggle
    const extensionEnabled = document.getElementById(
      "extensionEnabled"
    ) as HTMLInputElement;
    extensionEnabled?.addEventListener("change", () => {
      this.settings.isEnabled = extensionEnabled.checked;
      this.saveSettings();
    });

    // Persist blurs toggle
    const persistBlurs = document.getElementById(
      "persistBlurs"
    ) as HTMLInputElement;
    persistBlurs?.addEventListener("change", () => {
      this.settings.persistBlurs = persistBlurs.checked;
      this.saveSettings();
    });

    // Hide tab titles toggle (premium feature)
    const hideTabTitles = document.getElementById(
      "hideTabTitles"
    ) as HTMLInputElement;
    hideTabTitles?.addEventListener("change", () => {
      if (!freemiumService.isPremium()) {
        hideTabTitles.checked = false;
        freemiumService.checkFeatureAccess("hide-tab-titles");
        return;
      }
      this.settings.hideTabTitles = hideTabTitles.checked;
      this.saveSettings();
    });

    // Auto-blur sensitive content toggle (premium feature)
    const autoBlurSensitive = document.getElementById(
      "autoBlurSensitive"
    ) as HTMLInputElement;
    autoBlurSensitive?.addEventListener("change", () => {
      if (!freemiumService.isPremium()) {
        autoBlurSensitive.checked = false;
        freemiumService.checkFeatureAccess("auto-blur-sensitive");
        return;
      }
      this.settings.autoBlurSensitive = autoBlurSensitive.checked;
      this.saveSettings();
    });

    // Blur intensity slider
    const blurIntensitySlider = document.getElementById(
      "defaultBlurIntensity"
    ) as HTMLInputElement;
    blurIntensitySlider?.addEventListener("input", () => {
      this.settings.blurIntensity = parseInt(blurIntensitySlider.value);
      this.updateBlurIntensityValue();
      this.saveSettings();
    });

    // Export settings button (premium feature)
    const exportSettings = document.getElementById("exportSettings");
    exportSettings?.addEventListener("click", () => {
      if (!freemiumService.isPremium()) {
        freemiumService.checkFeatureAccess("export-settings");
        return;
      }
      this.exportSettings();
    });

    // Import settings button (premium feature)
    const importSettings = document.getElementById("importSettings");
    importSettings?.addEventListener("click", () => {
      if (!freemiumService.isPremium()) {
        freemiumService.checkFeatureAccess("import-settings");
        return;
      }
      this.importSettings();
    });

    // Import file input
    const importFileInput = document.getElementById(
      "importFileInput"
    ) as HTMLInputElement;
    importFileInput?.addEventListener("change", (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (file) {
        this.importSettings(file);
      }
    });

    // Clear all data button
    const clearAllData = document.getElementById("clearAllData");
    clearAllData?.addEventListener("click", () => {
      this.showConfirmDialog(
        "Clear All Data",
        "Are you sure you want to permanently delete all saved blur data from all websites? This action cannot be undone.",
        () => {
          this.clearAllData();
        }
      );
    });

    // Premium upgrade button
    const upgradeToPremium = document.getElementById("upgradeToPremium");
    upgradeToPremium?.addEventListener("click", () => {
      this.handleUpgradeClick();
    });

    // Reset to defaults
    const resetToDefaults = document.getElementById("resetToDefaults");
    resetToDefaults?.addEventListener("click", () => {
      this.showConfirmDialog(
        "Reset Settings",
        "Are you sure you want to reset all settings to their default values?",
        () => {
          this.resetToDefaults();
        }
      );
    });
  }

  // Handle upgrade button click
  private async handleUpgradeClick() {
    const user = extensionAuthService.getCurrentUser();

    if (!user) {
      this.showToast("Please sign in first to get premium features", "info");
      return;
    }

    this.showToast(
      "Payment system coming soon! For now, signing in gives you premium features.",
      "info"
    );
  }

  // Clear all saved blur data
  private async clearAllData() {
    try {
      // Clear all blur data from storage
      await browser.storage.sync.remove(["blurredElements"]);
      await browser.storage.local.clear();

      // Send message to all tabs to clear their blur data
      const tabs = await browser.tabs.query({});
      const clearPromises = tabs.map(async (tab) => {
        if (tab.id) {
          try {
            await browser.tabs.sendMessage(tab.id, { action: "clearAllBlurs" });
          } catch (error) {
            // Tab might not have content script loaded, ignore error
          }
        }
      });

      await Promise.all(clearPromises);

      this.showToast("All blur data has been successfully cleared!", "success");
    } catch (error) {
      console.error("❌ Error clearing all data:", error);
      this.showToast("Failed to clear all data. Please try again.", "error");
    }
  }

  public updateUI() {
    // Update toggles
    const extensionEnabled = document.getElementById(
      "extensionEnabled"
    ) as HTMLInputElement;
    if (extensionEnabled) {
      extensionEnabled.checked = this.settings.isEnabled;
    }

    const persistBlurs = document.getElementById(
      "persistBlurs"
    ) as HTMLInputElement;
    if (persistBlurs) {
      persistBlurs.checked = this.settings.persistBlurs;
    }

    const hideTabTitles = document.getElementById(
      "hideTabTitles"
    ) as HTMLInputElement;
    if (hideTabTitles) {
      hideTabTitles.checked = this.settings.hideTabTitles;
    }

    const autoBlurSensitive = document.getElementById(
      "autoBlurSensitive"
    ) as HTMLInputElement;
    if (autoBlurSensitive) {
      autoBlurSensitive.checked = this.settings.autoBlurSensitive;
    }

    // Update blur intensity slider
    const blurIntensitySlider = document.getElementById(
      "defaultBlurIntensity"
    ) as HTMLInputElement;
    if (blurIntensitySlider) {
      blurIntensitySlider.value = this.settings.blurIntensity.toString();
    }

    this.updateBlurIntensityValue();
    this.updatePremiumSettings();
  }

  private updateBlurIntensityValue() {
    const blurIntensityValue = document.getElementById("blurIntensityValue");
    if (blurIntensityValue) {
      blurIntensityValue.textContent = `${this.settings.blurIntensity}px`;
    }
  }

  // Update premium settings based on user status
  private updatePremiumSettings() {
    const isPremium = freemiumService.isPremium();

    // Enable/disable premium settings
    const hideTabTitles = document.getElementById(
      "hideTabTitles"
    ) as HTMLInputElement;
    const autoBlurSensitive = document.getElementById(
      "autoBlurSensitive"
    ) as HTMLInputElement;
    const exportBtn = document.getElementById(
      "exportSettings"
    ) as HTMLButtonElement;
    const importBtn = document.getElementById(
      "importSettings"
    ) as HTMLButtonElement;

    if (hideTabTitles) {
      hideTabTitles.disabled = !isPremium;
    }

    if (autoBlurSensitive) {
      autoBlurSensitive.disabled = !isPremium;
    }

    if (exportBtn) {
      exportBtn.disabled = !isPremium;
      if (!isPremium) {
        exportBtn.title = "Premium feature - sign in to export settings";
      }
    }

    if (importBtn) {
      importBtn.disabled = !isPremium;
      if (!isPremium) {
        importBtn.title = "Premium feature - sign in to import settings";
      }
    }

    // Update premium badges visibility
    const premiumBadges = document.querySelectorAll(".premium-badge");
    premiumBadges.forEach((badge) => {
      (badge as HTMLElement).style.display = isPremium ? "none" : "inline";
    });

    // Update upgrade button
    const upgradeBtn = document.getElementById("upgradeToPremium");
    if (upgradeBtn) {
      upgradeBtn.textContent = isPremium
        ? "Premium Active"
        : "Get Premium Features";
      upgradeBtn.style.background = isPremium ? "#28a745" : "";
      (upgradeBtn as HTMLButtonElement).disabled = isPremium;
    }
  }

  private resetToDefaults() {
    this.settings = {
      blurIntensity: 10,
      isEnabled: true,
      persistBlurs: true,
      hideTabTitles: false,
      autoBlurSensitive: false,
    };
    this.saveSettings();
    this.updateUI();
    this.showToast("Settings reset to defaults", "success");
  }

  private exportSettings() {
    try {
      const exportData = {
        settings: this.settings,
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      };

      const blob = new Blob([JSON.stringify(exportData, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = `blur-anything-settings-${new Date()
        .toISOString()
        .slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      this.showToast("Settings exported successfully!", "success");
    } catch (error) {
      console.error("Failed to export settings:", error);
      this.showToast("Failed to export settings", "error");
    }
  }

  private importSettings(file?: File) {
    if (!file) {
      const input = document.getElementById(
        "importFileInput"
      ) as HTMLInputElement;
      input.click();
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const importData = JSON.parse(e.target?.result as string);

        if (importData.settings) {
          this.settings = { ...this.settings, ...importData.settings };
          this.saveSettings();
          this.updateUI();
          this.showToast("Settings imported successfully!", "success");
        } else {
          throw new Error("Invalid settings file");
        }
      } catch (error) {
        console.error("Failed to import settings:", error);
        this.showToast("Failed to import settings - invalid file", "error");
      }
    };
    reader.readAsText(file);
  }

  private showToast(message: string, type: "success" | "error" | "info") {
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.textContent = message;

    toast.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      padding: 12px 24px;
      border-radius: 6px;
      color: white;
      font-weight: 500;
      z-index: 10000;
      animation: slideInRight 0.3s ease-out;
    `;

    if (type === "success") {
      toast.style.background = "#28a745";
    } else if (type === "error") {
      toast.style.background = "#dc3545";
    } else {
      toast.style.background = "#007bff";
    }

    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = "slideOutRight 0.3s ease-in";
      setTimeout(() => {
        if (document.body.contains(toast)) {
          document.body.removeChild(toast);
        }
      }, 300);
    }, 3000);
  }

  private showConfirmDialog(
    title: string,
    message: string,
    onConfirm: () => void
  ) {
    const overlay = document.createElement("div");
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.5);
      z-index: 10000;
      display: flex;
      align-items: center;
      justify-content: center;
    `;

    const dialog = document.createElement("div");
    dialog.style.cssText = `
      background: white;
      padding: 24px;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
      max-width: 400px;
      text-align: center;
    `;

    dialog.innerHTML = `
      <h3 style="margin: 0 0 16px 0; color: #333;">${title}</h3>
      <p style="margin: 0 0 24px 0; color: #666;">${message}</p>
      <div style="display: flex; gap: 12px; justify-content: center;">
        <button id="confirm-btn" style="
          padding: 8px 16px;
          background: #dc3545;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
        ">Confirm</button>
        <button id="cancel-btn" style="
          padding: 8px 16px;
          background: #6c757d;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
        ">Cancel</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const confirmBtn = dialog.querySelector("#confirm-btn");
    const cancelBtn = dialog.querySelector("#cancel-btn");

    confirmBtn?.addEventListener("click", () => {
      onConfirm();
      document.body.removeChild(overlay);
    });

    cancelBtn?.addEventListener("click", () => {
      document.body.removeChild(overlay);
    });

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        document.body.removeChild(overlay);
      }
    });
  }
}

// Initialize the options controller when the page loads
document.addEventListener("DOMContentLoaded", () => {
  const controller = new OptionsController();

  // Update premium UI when auth state changes
  extensionAuthService.onAuthStateChange(() => {
    // Small delay to ensure freemium service has updated
    setTimeout(() => {
      controller.updateUI();
    }, 100);
  });
});

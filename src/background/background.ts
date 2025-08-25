// Background service worker for BlurShield extension

import browser from "webextension-polyfill";

// Extension installation/update handler
browser.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    // Set default settings
    await browser.storage.sync.set({
      blurIntensity: 10,
      isEnabled: false,
      blurredElements: {},
      persistBlurs: true,
    });

    // Create context menu
    createContextMenu();
  } else if (details.reason === "update") {
    // Reset click blur to disabled by default for all users
    const settings = await browser.storage.sync.get([
      "blurIntensity",
      "blurredElements",
      "persistBlurs",
    ]);
    await browser.storage.sync.set({
      ...settings,
      isEnabled: false, // Reset to new default
    });
  }
});

// Create context menu for text selection blur
function createContextMenu() {
  browser.contextMenus.create({
    id: "blur-selected-text",
    title: "Blur selected text",
    contexts: ["selection"],
  });
}

// Handle context menu clicks
browser.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "blur-selected-text" && tab?.id) {
    // Send message to content script to blur selected text
    await browser.tabs.sendMessage(tab.id, {
      action: "blurSelectedText",
      text: info.selectionText,
    });
  }
});

// Handle messages from content scripts and popup
browser.runtime.onMessage.addListener(async (message, _sender) => {
  // Handle auth state broadcasting first
  if (message.type === "BROADCAST_AUTH_STATE") {
    try {
      // Get all tabs
      const tabs = await browser.tabs.query({});

      // Send message to each tab's content script
      for (const tab of tabs) {
        if (tab.id) {
          try {
            await browser.tabs.sendMessage(tab.id, {
              type: "AUTH_STATE_CHANGED",
              user: message.user,
            });
          } catch (error) {
            // Content script might not be loaded on this tab, ignore
          }
        }
      }

      return { success: true };
    } catch (error) {
      console.error("Failed to broadcast auth state:", error);
      return {
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  // Handle regular actions
  switch (message.action) {
    case "getSettings":
      const settings = await browser.storage.sync.get([
        "blurIntensity",
        "isEnabled",
        "persistBlurs",
      ]);

      // Ensure default values if settings don't exist
      const response = {
        blurIntensity: settings.blurIntensity ?? 10,
        isEnabled: settings.isEnabled ?? false,
        persistBlurs: settings.persistBlurs ?? true,
      };

      return response;

    case "updateSettings":
      await browser.storage.sync.set(message.settings);
      // Notify all tabs about settings change
      const tabs = await browser.tabs.query({});
      tabs.forEach((tab) => {
        if (tab.id) {
          browser.tabs
            .sendMessage(tab.id, {
              action: "settingsUpdated",
              settings: message.settings,
            })
            .catch(() => {
              // Ignore errors for tabs that don't have content script
            });
        }
      });
      return { success: true };

    case "saveBlurData":
      const saveUrl = message.url;
      if (saveUrl) {
        const blurredElements = await browser.storage.sync.get(
          "blurredElements"
        );
        blurredElements.blurredElements = blurredElements.blurredElements || {};
        blurredElements.blurredElements[saveUrl] = message.blurData;
        await browser.storage.sync.set(blurredElements);
      }
      return { success: true };

    case "getBlurData":
      const currentTabUrl = message.url;
      const savedBlurs = await browser.storage.sync.get("blurredElements");
      return savedBlurs.blurredElements?.[currentTabUrl] || [];

    case "clearAllBlurs":
      if (message.url) {
        const blurredElements = await browser.storage.sync.get(
          "blurredElements"
        );
        if (blurredElements.blurredElements) {
          delete blurredElements.blurredElements[message.url];
          await browser.storage.sync.set(blurredElements);
        }
      }
      return { success: true };

    case "openSignInPopup":
      // Open the extension popup to allow user to sign in
      try {
        await browser.action.openPopup();
        return { success: true };
      } catch (error) {
        return { error: "Please click the extension icon to sign in" };
      }

    default:
      return { error: "Unknown action" };
  }
});

// Handle tab privacy features
browser.tabs.onActivated.addListener(async () => {
  const settings = await browser.storage.sync.get(["isEnabled"]);
  if (settings.isEnabled) {
    // Additional privacy features can be implemented here
  }
});

// Handle service worker lifecycle properly for Manifest V3
// This addresses deprecation warnings about unload events

// Service worker install event
addEventListener("install", (event) => {
  // @ts-ignore - skipWaiting exists in service worker context
  event.waitUntil(skipWaiting());
});

// Service worker activate event
addEventListener("activate", (event) => {
  // @ts-ignore - clients exists in service worker context
  event.waitUntil(clients.claim());
});

// Handle extension suspension for Manifest V3 (replaces deprecated unload)
browser.runtime.onSuspend?.addListener(() => {
  // Clean up any resources here instead of using deprecated unload events
});

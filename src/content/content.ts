// Content script for BlurShield extension

import browser from "webextension-polyfill";
import { extensionAuthService as authService } from "../firebase/extension-auth-service";
import { syncService } from "../firebase/sync-service";
import { freemiumService } from "../services/freemium-service";

// Check if we're in a proper browser extension context
function isExtensionContext(): boolean {
  try {
    // Check if extension APIs are available
    if (typeof chrome === "undefined" && typeof browser === "undefined") {
      return false;
    }

    // Check if we have a valid extension runtime
    if (typeof chrome !== "undefined") {
      return !!(chrome.runtime && chrome.runtime.id);
    }

    if (typeof browser !== "undefined") {
      return !!(browser.runtime && browser.runtime.id);
    }

    return false;
  } catch (error) {
    return false;
  }
}

// Exit early if not in extension context
if (!isExtensionContext()) {
  // Mark as skipped and exit
  if (typeof window !== "undefined") {
    (window as any).blurAnythingSkipped = true;
  }
  // Don't initialize anything else
} else {
  // Only initialize if we're in a proper extension context

  interface BlurData {
    selector: string;
    type: "element" | "area" | "text";
    coords?: { x: number; y: number; width: number; height: number };
    text?: string;
    timestamp: number;
  }

  class BlurAnything {
    private isEnabled = false;
    private blurIntensity = 10;
    private blurredElements: BlurData[] = [];
    private isBlurMode = false;
    private isDrawingMode = false;
    private isTextSelectionMode = false;
    private isEraserMode = false;
    private blursHidden = false;
    private blursToCleanup: number[] = [];
    private startCoords: { x: number; y: number } | null = null;
    private drawingOverlay: HTMLDivElement | null = null;
    private hoverIndicator: HTMLDivElement | null = null;

    private intensityUpdateTimer: number | null = null;
    private holdInterval: number | null = null;
    private holdTimeout: number | null = null;
    private floatingToolbar: HTMLDivElement | null = null;

    constructor() {
      this.init();
    }

    private async init() {
      // Inject CSS styles first
      this.injectContentStyles();

      // CRITICAL: Try to apply any existing blurs IMMEDIATELY for privacy
      // This uses cached local storage data before even loading from extension storage
      this.attemptImmediateBlurRestoration();

      await this.loadSettings();
      await this.loadBlurData();
      this.setupEventListeners();
      this.createHoverIndicator();
      this.createFloatingToolbar();

      // Set initial mode based on extension enabled state
      if (this.isEnabled) {
        this.setExclusiveMode("blur");
      }

      // Update the disabled state to ensure blurs are hidden if extension is disabled
      this.updateDisabledState();

      // Apply blurs with multiple timing strategies for better reliability
      this.scheduleBlurRestoration();
    }

    private async loadSettings() {
      try {
        const settings = await browser.runtime.sendMessage({
          action: "getSettings",
        });

        // Handle case where settings might be null or undefined
        if (!settings || typeof settings !== "object") {
          this.isEnabled = false;
          this.blurIntensity = 10;
          return;
        }

        this.isEnabled = settings.isEnabled ?? false;
        this.blurIntensity = settings.blurIntensity ?? 10;
      } catch (error) {
        console.error("Failed to load settings:", error);
        // Use defaults if loading fails
        this.isEnabled = false;
        this.blurIntensity = 10;
      }
    }

    private async loadBlurData() {
      let loadedFromFirebase = false;

      // Try to load from Firebase first if user is authenticated
      if (authService.isAuthenticated()) {
        try {
          const firebaseData = await syncService.loadBlurData(
            window.location.href
          );
          if (firebaseData && firebaseData.length > 0) {
            this.blurredElements = firebaseData;
            loadedFromFirebase = true;
          }
        } catch (error) {}
      }

      // If not loaded from Firebase, try extension storage
      if (!loadedFromFirebase) {
        try {
          const blurData = await browser.runtime.sendMessage({
            action: "getBlurData",
            url: window.location.href,
          });
          this.blurredElements = blurData || [];

          // Debug: Log what we loaded

          // Sync any local data that might be newer
          this.syncLocalDataIfNeeded();
        } catch (error) {
          // Load from local storage as fallback
          this.blurredElements = this.loadBlurDataLocally();
        }
      }
    }

    private setupEventListeners() {
      // Click to blur functionality
      document.addEventListener("click", this.handleClick.bind(this), true);

      // Hover indicator
      document.addEventListener(
        "mouseover",
        this.handleMouseOver.bind(this),
        true
      );
      document.addEventListener(
        "mouseout",
        this.handleMouseOut.bind(this),
        true
      );

      // Keyboard shortcuts
      document.addEventListener("keydown", this.handleKeyDown.bind(this));

      // Drawing mode for custom areas
      document.addEventListener("mousedown", this.handleMouseDown.bind(this));
      document.addEventListener("mousemove", this.handleMouseMove.bind(this));
      document.addEventListener("mouseup", this.handleMouseUp.bind(this));

      // Listen for messages from background script
      browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
        this.handleMessage(message, sender, sendResponse);
        return true; // Keep message channel open for async response
      });
    }

    private createHoverIndicator() {
      this.hoverIndicator = document.createElement("div");
      this.hoverIndicator.id = "blur-anything-hover-indicator";
      this.hoverIndicator.style.cssText = `
      position: absolute;
      pointer-events: none;
      border: 2px dashed #007cba;
      background-color: rgba(0, 124, 186, 0.1);
      z-index: 999999;
      display: none;
      border-radius: 4px;
    `;
      document.body.appendChild(this.hoverIndicator);
    }

    private async handleClick(event: MouseEvent) {
      // Don't allow any blur interactions when extension is disabled
      if (!this.isEnabled) return;

      const target = event.target as HTMLElement;

      // Check if clicking on our own UI elements
      if (this.isExtensionElement(target)) {
        return; // Don't blur our own UI elements
      }

      // PRIORITY: Handle clicks on existing blur elements for removal (always enabled)
      const isBlurredElement =
        target.classList.contains("blur-anything-blurred") ||
        target.classList.contains("blur-anything-text-blur") ||
        target.hasAttribute("data-blur-applied") ||
        this.isElementBlurredByCSS(target);

      // Only remove blurs when in eraser mode or extension is disabled
      if (isBlurredElement && (this.isEraserMode || !this.isEnabled)) {
        event.preventDefault();
        event.stopPropagation();
        this.eraseBlur(target);
        return;
      }

      // If clicking on blurred element while in blur mode, just ignore (don't add another blur)
      if (isBlurredElement && this.isBlurMode) {
        return;
      }

      // Only handle new blur creation in specific modes (blur mode or eraser mode)
      if (!this.isBlurMode && !this.isEraserMode) return;

      // Also check if toolbar is visible for new blur creation
      const isToolbarVisible = this.floatingToolbar?.style.display === "flex";
      if (!isToolbarVisible) return;

      event.preventDefault();
      event.stopPropagation();

      if (this.isEraserMode) {
        this.eraseBlur(target);
      } else {
        await this.blurElement(target);
      }
    }

    private isElementBlurredByCSS(element: HTMLElement): boolean {
      // Check if this element is blurred by our injected CSS rules
      for (const blur of this.blurredElements) {
        if (blur.type === "element") {
          try {
            const blurredElement = document.querySelector(blur.selector);
            if (blurredElement === element) {
              return true;
            }
          } catch (e) {
            // Ignore selector errors
          }
        }
      }

      // Also check if element has data-blur-id attribute (our marker for one-click blurs)
      if (element.hasAttribute("data-blur-id")) {
        return true;
      }

      // Check computed style for blur filter
      const computedStyle = window.getComputedStyle(element);
      if (computedStyle.filter && computedStyle.filter.includes("blur")) {
        return true;
      }

      return false;
    }

    private isExtensionElement(element: HTMLElement): boolean {
      // In eraser mode, allow clicking on blur elements to erase them
      if (this.isEraserMode) {
        // Only block toolbar and UI elements, but allow blur elements to be erased
        if (
          element.id?.startsWith("blur-anything-") &&
          !element.classList?.contains("blur-anything-blurred") &&
          !element.classList?.contains("blur-anything-area") &&
          !element.classList?.contains("blur-anything-text-blur")
        ) {
          return true;
        }

        // Check for toolbar elements specifically
        let parent = element.parentElement;
        while (parent) {
          if (parent.id === "blur-anything-floating-toolbar") return true;
          if (parent.classList?.contains("toolbar-btn")) return true;
          if (parent.classList?.contains("toolbar-content")) return true;
          if (parent.classList?.contains("toolbar-handle")) return true;
          parent = parent.parentElement;
        }

        return false;
      }

      // In non-eraser modes, block extension UI elements but allow blur elements for removal
      if (
        element.id?.startsWith("blur-anything-") &&
        !element.classList?.contains("blur-anything-blurred") &&
        !element.classList?.contains("blur-anything-area") &&
        !element.classList?.contains("blur-anything-text-blur")
      )
        return true;

      // Don't block blur elements - they should be clickable for removal
      // if (element.classList?.contains("blur-anything-blurred")) return true;
      // if (element.classList?.contains("blur-anything-area")) return true;

      // Check if any parent element is part of our extension UI (but not blur elements)
      let parent = element.parentElement;
      while (parent) {
        if (
          parent.id?.startsWith("blur-anything-") &&
          !parent.classList?.contains("blur-anything-blurred") &&
          !parent.classList?.contains("blur-anything-area") &&
          !parent.classList?.contains("blur-anything-text-blur")
        )
          return true;
        // Don't block clicks if parent is a blur element
        // if (parent.classList?.contains("blur-anything-blurred")) return true;
        // if (parent.classList?.contains("blur-anything-area")) return true;

        // Specifically check for toolbar elements
        if (parent.id === "blur-anything-floating-toolbar") return true;
        if (parent.classList?.contains("toolbar-btn")) return true;
        if (parent.classList?.contains("toolbar-content")) return true;
        if (parent.classList?.contains("toolbar-handle")) return true;

        parent = parent.parentElement;
      }

      return false;
    }

    private handleMouseOver(event: MouseEvent) {
      if (!this.isEnabled || (!this.isBlurMode && !this.isEraserMode)) return;

      // Also check if toolbar is visible - no hover indicators when toolbar is hidden
      const isToolbarVisible = this.floatingToolbar?.style.display === "flex";
      if (!isToolbarVisible) return;

      const target = event.target as HTMLElement;
      if (this.isExtensionElement(target)) return;

      this.showHoverIndicator(target);
    }

    private handleMouseOut(_event: MouseEvent) {
      if (!this.isEnabled || (!this.isBlurMode && !this.isEraserMode)) return;
      this.hideHoverIndicator();
    }

    private showHoverIndicator(element: HTMLElement) {
      if (!this.hoverIndicator) return;

      const rect = element.getBoundingClientRect();
      const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
      const scrollY = window.pageYOffset || document.documentElement.scrollTop;

      // Change color based on mode
      if (this.isEraserMode) {
        this.hoverIndicator.style.borderColor = "#dc3545"; // Red for eraser
        this.hoverIndicator.style.backgroundColor = "rgba(220, 53, 69, 0.1)";
      } else {
        this.hoverIndicator.style.borderColor = "#007cba"; // Blue for blur
        this.hoverIndicator.style.backgroundColor = "rgba(0, 124, 186, 0.1)";
      }

      this.hoverIndicator.style.display = "block";
      this.hoverIndicator.style.left = `${rect.left + scrollX}px`;
      this.hoverIndicator.style.top = `${rect.top + scrollY}px`;
      this.hoverIndicator.style.width = `${rect.width}px`;
      this.hoverIndicator.style.height = `${rect.height}px`;
    }

    private hideHoverIndicator() {
      if (this.hoverIndicator) {
        this.hoverIndicator.style.display = "none";
      }
    }

    private async blurElement(element: HTMLElement) {
      // Check freemium restrictions for click blur
      if (!freemiumService.canUseBlurType("click")) {
        freemiumService.showUpgradeNotification("click-blur");
        return;
      }

      // Check blur count limit
      if (!(await freemiumService.canAddBlur())) {
        freemiumService.showUpgradeNotification("blur-limit");
        return;
      }

      // Create unique selector for the element
      const selector = this.generateSelector(element);

      // Check if element is already blurred
      const existingBlur = this.blurredElements.find(
        (blur) => blur.selector === selector
      );
      if (existingBlur) {
        this.unblurElement(element, selector);
        return;
      }

      // Apply blur effect
      this.applyBlurToElement(element);

      // Increment blur count for freemium tracking
      await freemiumService.incrementDailyBlurCount();

      // Save blur data (temporarily - not persisted until user saves)
      const blurData: BlurData = {
        selector,
        type: "element",
        timestamp: Date.now(),
      };

      this.blurredElements.push(blurData);
      // Don't auto-save - let user decide when to persist
    }

    private unblurElement(element: HTMLElement, selector: string) {
      // Use comprehensive blur removal
      this.removeBlurFromElement(element);

      // IMPORTANT: Remove from saved data FIRST, then rebuild CSS
      this.blurredElements = this.blurredElements.filter(
        (blur) => blur.selector !== selector
      );

      // Rebuild CSS without this blur
      this.rebuildInjectedCSS();

      // IMPORTANT: Save the changes to storage so erased blurs don't come back on reload
      this.saveBlurData();

      // Decrement blur count for freemium tracking
      // Note: Daily blur count decrementation not implemented for simplicity
    }

    private eraseBlur(element: HTMLElement) {
      // Check if element is blurred by class OR by our injected CSS
      const isBlurredByClass = element.classList.contains(
        "blur-anything-blurred"
      );
      const isBlurredByCSS = this.isElementBlurredByCSS(element);

      if (isBlurredByClass || isBlurredByCSS) {
        // Find the original selector from stored blur data
        let originalSelector = null;
        for (const blur of this.blurredElements) {
          if (blur.type === "element") {
            try {
              const testElement = document.querySelector(blur.selector);
              if (testElement === element) {
                originalSelector = blur.selector;
                break;
              }
            } catch (e) {
              // Ignore selector errors
            }
          }
        }

        const selector = originalSelector || this.generateSelector(element);

        this.unblurElement(element, selector);
        return true;
      }

      // Check if clicking on a text blur
      if (element.classList.contains("blur-anything-text-blur")) {
        // Remove text blur by unwrapping the content
        const parent = element.parentNode;
        if (parent) {
          // Get the text content before removing
          const textContent = element.textContent || "";

          // Since text blurs only contain plain text, simple replacement is sufficient
          if (textContent.trim()) {
            parent.insertBefore(document.createTextNode(textContent), element);
          }
          parent.removeChild(element);

          // Remove from saved data using multiple methods to ensure cleanup
          const elementId = element.id;
          if (elementId) {
            // Remove by ID selector
            this.blurredElements = this.blurredElements.filter(
              (blur) => blur.selector !== `#${elementId}`
            );
          }

          // Also remove by text content for better cleanup
          if (textContent.trim()) {
            this.blurredElements = this.blurredElements.filter((blur) => {
              if (blur.type === "text" && blur.text) {
                return blur.text.trim() !== textContent.trim();
              }
              return true;
            });
          }

          // Force save the updated data
          this.saveBlurData().catch(console.error);
        }
        return true;
      }

      // Check if clicking on a blur area
      if (element.classList.contains("blur-anything-area")) {
        // CRITICAL: Clear all filters before removing to prevent layering artifacts
        element.style.removeProperty("backdrop-filter");
        element.style.removeProperty("-webkit-backdrop-filter");
        element.style.removeProperty("filter");

        // Force a repaint to ensure filters are cleared
        element.offsetHeight;

        element.remove();
        // Remove from saved data
        const coords = element.getAttribute("data-coords");
        if (coords) {
          const [x, y] = coords.split(",").map(Number);
          this.blurredElements = this.blurredElements.filter(
            (blur) => blur.coords?.x !== x || blur.coords?.y !== y
          );
          // Don't auto-save when removing blur areas
        }
        return true;
      }

      return false;
    }

    private applyBlurToElement(element: HTMLElement) {
      try {
        // Double-check element validity before applying blur
        if (!this.canApplyBlurToElement(element)) {
          throw new Error(`Cannot apply blur to ${element.tagName} element`);
        }

        // Try multiple approaches to apply blur
        this.applyBlurWithFallbacks(element);

        // Add a class for easier identification
        element.classList.add("blur-anything-blurred");

        // Mark with a data attribute for tracking
        element.setAttribute("data-blur-applied", "true");
      } catch (error) {
        console.error("Failed to apply blur to element:", element, error);
        throw error; // Re-throw so caller can handle
      }
    }

    private applyBlurWithFallbacks(element: HTMLElement) {
      const blurFilter = `blur(${this.blurIntensity}px)`;

      // Method 1: Try direct style.filter assignment
      try {
        const currentFilter = element.style.filter || "";
        const cleanFilter = currentFilter.replace(/blur\([^)]*\)/g, "").trim();

        if (cleanFilter) {
          element.style.filter = `${cleanFilter} ${blurFilter}`;
        } else {
          element.style.filter = blurFilter;
        }
        return; // Success
      } catch (error) {
        console.warn("Method 1 (direct filter) failed:", error);
      }

      // Method 2: Try using setProperty
      try {
        const currentFilter = element.style.getPropertyValue("filter") || "";
        const cleanFilter = currentFilter.replace(/blur\([^)]*\)/g, "").trim();
        const newFilter = cleanFilter
          ? `${cleanFilter} ${blurFilter}`
          : blurFilter;

        element.style.setProperty("filter", newFilter);
        return; // Success
      } catch (error) {
        console.warn("Method 2 (setProperty) failed:", error);
      }

      // Method 3: Try using setAttribute on style
      try {
        const currentStyle = element.getAttribute("style") || "";
        const filterRegex = /filter\s*:\s*[^;]*/gi;
        let newStyle = currentStyle.replace(filterRegex, "");

        if (newStyle && !newStyle.endsWith(";")) {
          newStyle += "; ";
        }
        newStyle += `filter: ${blurFilter};`;

        element.setAttribute("style", newStyle);
        return; // Success
      } catch (error) {
        console.warn("Method 3 (setAttribute) failed:", error);
      }

      // Method 4: Create wrapper element as last resort
      try {
        this.applyBlurWithWrapper(element);
        return; // Success
      } catch (error) {
        console.warn("Method 4 (wrapper) failed:", error);
      }

      throw new Error("All blur application methods failed");
    }

    private applyBlurWithWrapper(element: HTMLElement) {
      // Create a wrapper div with the blur effect
      const wrapper = document.createElement("div");
      wrapper.className = "blur-anything-wrapper";
      wrapper.style.cssText = `
      backdrop-filter: blur(${this.blurIntensity}px);
      -webkit-backdrop-filter: blur(${this.blurIntensity}px);
      display: inline-block;
      position: relative;
    `;

      // Insert wrapper before the element
      const parent = element.parentNode;
      if (!parent) {
        throw new Error("Element has no parent for wrapper approach");
      }

      parent.insertBefore(wrapper, element);
      wrapper.appendChild(element);
    }

    private generateSelector(element: HTMLElement): string {
      try {
        // Generate a unique CSS selector for the element
        if (element.id && this.isValidCSSIdentifier(element.id)) {
          const idSelector = `#${this.escapeCSSIdentifier(element.id)}`;
          // Test the selector to make sure it works
          try {
            document.querySelector(idSelector);
            return idSelector;
          } catch {
            // Fall through to other methods
          }
        }

        const path: string[] = [];
        let current = element;
        let attempts = 0;
        const maxAttempts = 6;

        while (current && current !== document.body && attempts < maxAttempts) {
          attempts++;
          let selector = current.tagName.toLowerCase();

          // Add classes if they're valid CSS identifiers
          if (current.className && current.className.trim()) {
            const classes = current.className
              .trim()
              .split(/\s+/)
              .filter((cls) => this.isValidCSSIdentifier(cls))
              .map((cls) => this.escapeCSSIdentifier(cls))
              .slice(0, 3); // Limit to 3 classes to avoid overly long selectors

            if (classes.length > 0) {
              selector += "." + classes.join(".");
            }
          }

          // Add nth-child for uniqueness, but be more selective
          const parent = current.parentElement;
          if (parent && this.shouldAddNthChild(current, parent)) {
            const siblings = Array.from(parent.children).filter(
              (sibling) => sibling.tagName === current.tagName
            );
            if (siblings.length > 1 && siblings.length <= 20) {
              // Avoid huge nth-child values
              const index = siblings.indexOf(current) + 1;
              selector += `:nth-child(${index})`;
            }
          }

          path.unshift(selector);
          current = current.parentElement!;

          // Test if current path is unique enough
          if (path.length >= 2) {
            const testSelector = path.join(" > ");
            try {
              const matches = document.querySelectorAll(testSelector);
              if (matches.length === 1 && matches[0] === element) {
                return testSelector; // Found unique selector
              }
            } catch {
              // Invalid selector, continue building
            }
          }
        }

        const finalSelector = path.join(" > ");

        // Final validation of the selector
        try {
          const testElement = document.querySelector(finalSelector);
          if (testElement === element) {
            return finalSelector;
          }
        } catch {
          // Selector is invalid, fall back to a simple approach
        }

        // Fallback: use tag name with data attribute
        const fallbackId = `blur-${Date.now()}-${Math.random()
          .toString(36)
          .substr(2, 9)}`;
        element.setAttribute("data-blur-id", fallbackId);
        return `[data-blur-id="${fallbackId}"]`;
      } catch (error) {
        // Ultimate fallback
        const fallbackId = `blur-fallback-${Date.now()}`;
        element.setAttribute("data-blur-fallback", fallbackId);
        return `[data-blur-fallback="${fallbackId}"]`;
      }
    }

    private isValidCSSIdentifier(str: string): boolean {
      // CSS identifier must start with letter, underscore, or hyphen (not number)
      // and contain only letters, numbers, hyphens, and underscores
      return /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(str);
    }

    private escapeCSSIdentifier(str: string): string {
      // Escape special characters in CSS identifiers
      return str.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
    }

    private shouldAddNthChild(element: Element, parent: Element): boolean {
      // Only add nth-child if really necessary for uniqueness
      const tagSelector = element.tagName.toLowerCase();
      const classSelector = element.className
        ? `.${element.className
            .split(" ")
            .filter((c) => this.isValidCSSIdentifier(c))
            .join(".")}`
        : "";

      const baseSelector = tagSelector + classSelector;

      try {
        const matches = parent.querySelectorAll(baseSelector);
        return matches.length > 1;
      } catch {
        return true; // If we can't test, better to be safe
      }
    }

    private createFallbackSelector(
      blurData: any,
      index: number
    ): string | null {
      try {
        // Try to create a simpler, more reliable selector
        const originalSelector = blurData.selector;

        // Method 1: Try to simplify by removing complex parts
        let simplifiedSelector = originalSelector
          .replace(/\s+/g, " ") // Normalize whitespace
          .replace(/\s*>\s*/g, " > ") // Normalize child combinators
          .replace(/:[^:>\s]+/g, "") // Remove pseudo-selectors except nth-child
          .replace(/\[[^\]]*\]/g, ""); // Remove attribute selectors

        // Test simplified selector
        try {
          const element = document.querySelector(simplifiedSelector);
          if (element) {
            return simplifiedSelector;
          }
        } catch {
          // Continue to next method
        }

        // Method 2: Try just the last part (most specific)
        const parts = originalSelector.split(" > ");
        if (parts.length > 1) {
          const lastPart = parts[parts.length - 1].replace(/:[^:>\s]+/g, "");
          try {
            const element = document.querySelector(lastPart);
            if (element) {
              return lastPart;
            }
          } catch {
            // Continue to next method
          }
        }

        // Method 3: Try just tag names
        const tagOnlySelector = originalSelector
          .replace(/\.[^>\s:]+/g, "") // Remove all classes
          .replace(/:[^:>\s]+/g, "") // Remove pseudo-selectors
          .replace(/\[[^\]]*\]/g, "") // Remove attributes
          .replace(/\s+/g, " ")
          .trim();

        if (tagOnlySelector && tagOnlySelector !== originalSelector) {
          try {
            const element = document.querySelector(tagOnlySelector);
            if (element) {
              return tagOnlySelector;
            }
          } catch {
            // Continue to final method
          }
        }

        // Method 4: Create a data attribute fallback
        const elements = document.querySelectorAll("*");
        for (let i = 0; i < elements.length; i++) {
          const el = elements[i] as HTMLElement;
          if (!el.hasAttribute("data-blur-fallback")) {
            const fallbackId = `blur-recovery-${index}-${Date.now()}`;
            el.setAttribute("data-blur-fallback", fallbackId);
            return `[data-blur-fallback="${fallbackId}"]`;
          }
        }

        return null;
      } catch (error) {
        return null;
      }
    }

    private handleKeyDown(event: KeyboardEvent) {
      // Don't allow keyboard shortcuts when extension is disabled
      if (!this.isEnabled) return;

      // Ctrl/Cmd + Shift + B to toggle draw mode
      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        event.key === "B"
      ) {
        event.preventDefault();
        if (this.isDrawingMode) {
          this.setExclusiveMode("none");
        } else {
          this.setExclusiveMode("draw");
        }
      }

      // Escape to exit any active mode
      if (event.key === "Escape") {
        if (this.isDrawingMode || this.isEraserMode) {
          this.setExclusiveMode("none");
          this.hideDrawingOverlay();
        }
      }
    }

    private handleMouseDown(event: MouseEvent) {
      if (!this.isEnabled || !this.isDrawingMode) {
        return;
      }

      // Prevent starting on already blurred areas or UI elements
      const target = event.target as HTMLElement;
      if (this.isExtensionElement(target)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      this.startCoords = { x: event.pageX, y: event.pageY };
      this.createDrawingOverlay();
    }

    private handleMouseMove(event: MouseEvent) {
      if (
        !this.isEnabled ||
        !this.isDrawingMode ||
        !this.startCoords ||
        !this.drawingOverlay
      ) {
        return;
      }

      const width = Math.abs(event.pageX - this.startCoords.x);
      const height = Math.abs(event.pageY - this.startCoords.y);
      const left = Math.min(event.pageX, this.startCoords.x);
      const top = Math.min(event.pageY, this.startCoords.y);

      this.drawingOverlay.style.left = `${left}px`;
      this.drawingOverlay.style.top = `${top}px`;
      this.drawingOverlay.style.width = `${width}px`;
      this.drawingOverlay.style.height = `${height}px`;
    }

    private async handleMouseUp(event: MouseEvent) {
      if (
        !this.isEnabled ||
        !this.isDrawingMode ||
        !this.startCoords ||
        !this.drawingOverlay
      ) {
        return;
      }

      const width = Math.abs(event.pageX - this.startCoords.x);
      const height = Math.abs(event.pageY - this.startCoords.y);

      // Check minimum size
      if (width < 10 || height < 10) {
        this.hideDrawingOverlay();
        this.startCoords = null;
        return;
      }

      // Check maximum size based on user tier

      freemiumService.debugAuthState(); // Debug current auth state
      const maxSize = freemiumService.getMaxRectangleSize();

      if (width > maxSize.width || height > maxSize.height) {
        // Show upgrade notification
        freemiumService.showUpgradeNotification("rectangle-size", () => {});

        this.hideDrawingOverlay();
        this.startCoords = null;
        return;
      }

      // Check daily blur limit

      freemiumService.debugAuthState(); // Debug current auth state
      const canAddBlur = await freemiumService.canAddBlur();

      if (!canAddBlur) {
        // Show upgrade notification
        freemiumService.showUpgradeNotification("daily-limit", () => {});

        this.hideDrawingOverlay();
        this.startCoords = null;
        return;
      }

      await this.createBlurArea();

      this.hideDrawingOverlay();
      this.startCoords = null;
    }

    private createDrawingOverlay() {
      this.drawingOverlay = document.createElement("div");
      this.drawingOverlay.id = "blur-anything-drawing-overlay";
      this.drawingOverlay.style.cssText = `
      position: absolute;
      border: 2px dashed #007cba;
      background-color: rgba(0, 124, 186, 0.2);
      z-index: 999999;
      pointer-events: none;
      border-radius: 4px;
    `;
      document.body.appendChild(this.drawingOverlay);
    }

    private hideDrawingOverlay() {
      if (this.drawingOverlay) {
        this.drawingOverlay.remove();
        this.drawingOverlay = null;
      }
    }

    private createProperBlurOverlay(blurArea: HTMLElement, intensity: number) {
      // Simple approach: apply backdrop-filter directly to the main element
      blurArea.style.backdropFilter = `blur(${intensity}px)`;
      blurArea.style.setProperty(
        "-webkit-backdrop-filter",
        `blur(${intensity}px)`
      );
      blurArea.style.background = "rgba(0, 0, 0, 0.1)";
    }

    private updateBlurOverlay(blurArea: HTMLElement, intensity: number) {
      blurArea.style.backdropFilter = `blur(${intensity}px)`;
      blurArea.style.setProperty(
        "-webkit-backdrop-filter",
        `blur(${intensity}px)`
      );
    }

    private setupIntensityHoldButton(selector: string, change: number) {
      const button = this.floatingToolbar?.querySelector(
        selector
      ) as HTMLElement;
      if (!button) return;

      // Single click
      button.addEventListener("click", (e) => {
        e.preventDefault();
        if (!this.holdTimeout) {
          // Only if not holding
          this.adjustBlurIntensity(change);
          // Add visual feedback
          button.style.backgroundColor = "rgba(255, 0, 0, 0.3)";
          setTimeout(() => {
            button.style.backgroundColor = "";
          }, 150);
        }
      });

      // Hold functionality
      button.addEventListener("mousedown", (e) => {
        e.preventDefault();

        // Visual feedback for hold
        button.style.backgroundColor = "rgba(255, 0, 0, 0.5)";

        // Start hold after 500ms
        this.holdTimeout = window.setTimeout(() => {
          this.holdInterval = window.setInterval(() => {
            this.adjustBlurIntensity(change);
          }, 200); // Repeat every 200ms
        }, 500); // Start after 500ms hold
      });

      // Stop hold
      const stopHold = () => {
        if (this.holdTimeout) {
          clearTimeout(this.holdTimeout);
          this.holdTimeout = null;
        }
        if (this.holdInterval) {
          clearInterval(this.holdInterval);
          this.holdInterval = null;
        }
        button.style.backgroundColor = "";
      };

      button.addEventListener("mouseup", stopHold);
      button.addEventListener("mouseleave", stopHold);
      button.addEventListener("touchend", stopHold);
      button.addEventListener("touchcancel", stopHold);
    }

    private async createBlurArea() {
      if (!this.drawingOverlay || !this.startCoords) {
        return;
      }

      const rect = this.drawingOverlay.getBoundingClientRect();
      const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
      const scrollY = window.pageYOffset || document.documentElement.scrollTop;

      const blurArea = document.createElement("div");
      blurArea.className = "blur-anything-area";
      const effectiveIntensity = Math.max(1, this.blurIntensity);

      // Set position and size first
      blurArea.style.cssText = `
      position: absolute;
      left: ${rect.left + scrollX}px;
      top: ${rect.top + scrollY}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      z-index: 999998;
      border: none;
      cursor: pointer;
      overflow: hidden;
    `;

      // Add to DOM first
      document.body.appendChild(blurArea);

      // Now apply blur
      this.createProperBlurOverlay(blurArea, effectiveIntensity);

      // Save blur data
      const blurData: BlurData = {
        selector: `.blur-anything-area[data-coords="${rect.left + scrollX},${
          rect.top + scrollY
        }"]`,
        type: "area",
        coords: {
          x: rect.left + scrollX,
          y: rect.top + scrollY,
          width: rect.width,
          height: rect.height,
        },
        timestamp: Date.now(),
      };

      blurArea.setAttribute(
        "data-coords",
        `${rect.left + scrollX},${rect.top + scrollY}`
      );

      this.blurredElements.push(blurData);

      // Increment blur count for freemium tracking
      await freemiumService.incrementDailyBlurCount();

      // Show immediate feedback that the area was created
      this.showToolbarNotification(
        `Draw area created! Total: ${this.blurredElements.length}`
      );

      // Don't auto-save - let user decide when to persist
    }

    private async saveBlurData() {
      // Always save locally first for immediate backup
      this.saveBlurDataLocally();

      // Try to save to Firebase if user is authenticated
      if (authService.isAuthenticated()) {
        try {
          await syncService.saveBlurData(
            window.location.href,
            this.blurredElements
          );
        } catch (error) {}
      }

      // Also save to extension storage as fallback
      try {
        await browser.runtime.sendMessage({
          action: "saveBlurData",
          url: window.location.href,
          blurData: this.blurredElements,
        });

        // If extension storage works, we can keep local as backup
      } catch (error) {
        // Local storage already saved above as fallback
      }
    }

    private applyExistingBlurs() {
      if (!this.blurredElements || this.blurredElements.length === 0) {
        return;
      }

      let appliedCount = 0;
      let missedCount = 0;

      this.blurredElements.forEach((blurData, index) => {
        try {
          if (blurData.type === "element") {
            // Validate selector first
            if (!blurData.selector || typeof blurData.selector !== "string") {
              missedCount++;
              return;
            }

            let element: HTMLElement | null = null;

            try {
              element = document.querySelector(
                blurData.selector
              ) as HTMLElement;
            } catch (selectorError) {
              console.warn(
                `Invalid CSS selector for blur ${index + 1}: ${
                  blurData.selector
                }`,
                {
                  error: selectorError,
                  selector: blurData.selector,
                  selectorLength: blurData.selector.length,
                  containsSpecialChars: /[^\w\s\-\.#>:()]/g.test(
                    blurData.selector
                  ),
                  errorType:
                    selectorError instanceof DOMException
                      ? "DOMException"
                      : typeof selectorError,
                }
              );

              // Try to fix the selector by creating a fallback
              try {
                const fallbackSelector = this.createFallbackSelector(
                  blurData,
                  index
                );
                if (fallbackSelector) {
                  element = document.querySelector(
                    fallbackSelector
                  ) as HTMLElement;
                }
              } catch (fallbackError) {}

              if (!element) {
                // Try one more time with a more lenient selector search
                try {
                  // Extract the data-blur-id from the selector if it exists
                  const blurIdMatch = blurData.selector.match(
                    /data-blur-id="([^"]+)"/
                  );
                  if (blurIdMatch) {
                    const blurId = blurIdMatch[1];
                    element = document.querySelector(
                      `[data-blur-id="${blurId}"]`
                    ) as HTMLElement;
                  }
                } catch (retryError) {
                  // Ignore retry errors
                }

                if (!element) {
                  missedCount++;
                  // Mark this blur for cleanup since element no longer exists
                  this.markBlurForCleanup(index);
                  return;
                }
              }
            }

            if (element) {
              // Additional element validation
              if (!this.canApplyBlurToElement(element)) {
                console.debug(
                  `Skipping blur for element ${index + 1} (${
                    element.tagName
                  }) - element validation failed`
                );
                missedCount++;
                return;
              }

              // Check if element is already blurred to avoid double-application
              if (!element.classList.contains("blur-anything-blurred")) {
                try {
                  this.applyBlurToElement(element);

                  appliedCount++;
                } catch (blurError) {
                  console.error(
                    `Failed to apply blur to element for blur ${index + 1}:`,
                    {
                      error: blurError,
                      element: element,
                      tagName: element.tagName,
                      className: element.className,
                      id: element.id,
                      selector: blurData.selector,
                      errorType:
                        blurError instanceof DOMException
                          ? "DOMException"
                          : typeof blurError,
                      errorCode:
                        blurError instanceof DOMException
                          ? blurError.code
                          : "N/A",
                      errorName:
                        blurError instanceof DOMException
                          ? blurError.name
                          : "N/A",
                      errorMessage:
                        blurError instanceof Error
                          ? blurError.message
                          : String(blurError),
                    }
                  );
                  missedCount++;
                }
              }
            } else {
              missedCount++;

              // Mark this blur for removal since the element no longer exists
              this.markBlurForCleanup(index);
            }
          } else if (blurData.type === "area" && blurData.coords) {
            try {
              // Validate coordinates
              if (!this.areValidCoordinates(blurData.coords)) {
                missedCount++;
                return;
              }

              // Check if blur area already exists and is properly restored
              const coordsString = `${blurData.coords.x},${blurData.coords.y}`;

              const existingArea = document.querySelector(
                `[data-coords="${coordsString}"]`
              );

              if (!existingArea) {
                this.recreateBlurArea(blurData);
                appliedCount++;
              } else {
                // Check if existing area has proper blur applied
                const htmlArea = existingArea as HTMLElement;
                const hasBlur =
                  htmlArea.style.backdropFilter &&
                  htmlArea.style.backdropFilter.includes("blur");

                if (!hasBlur) {
                  this.createProperBlurOverlay(htmlArea, this.blurIntensity);
                  appliedCount++;
                } else {
                }
              }
            } catch (areaError) {
              console.error(
                `Failed to recreate blur area for blur ${index + 1}:`,
                areaError
              );
              missedCount++;
            }
          } else if (blurData.type === "text") {
            // PERFORMANCE FIX: Use conservative text blur restoration
            // Only try to restore by exact selector match, no DOM searching
            try {
              const testElement = document.querySelector(blurData.selector);

              if (testElement) {
              }

              // Try selector-based restoration first
              if (
                this.restoreTextBlurBySelector(blurData.selector, blurData.text)
              ) {
                appliedCount++;
              } else {
                // Fallback: Try to find and blur the text content
                if (
                  blurData.text &&
                  this.findAndBlurTextContent(blurData.text, index)
                ) {
                  appliedCount++;
                } else {
                  missedCount++;
                  // Mark for cleanup since the text no longer exists
                  this.markBlurForCleanup(index);
                }
              }
            } catch (textError) {
              console.error(
                `Error in conservative text blur restoration:`,
                textError
              );
              missedCount++;
            }
          }
        } catch (error) {
          console.error(`Error applying blur ${index + 1}:`, error);
          missedCount++;
        }
      });

      if (appliedCount > 0 || missedCount > 0) {
      }

      // Clean up any invalid blur entries
      this.performBlurCleanup();
    }

    private recreateBlurArea(blurData: BlurData) {
      if (!blurData.coords) {
        console.error("No coordinates provided for blur area");
        return;
      }

      const blurArea = document.createElement("div");
      blurArea.className = "blur-anything-area";
      blurArea.setAttribute(
        "data-coords",
        `${blurData.coords.x},${blurData.coords.y}`
      );
      // Use the new overlay approach instead of backdrop-filter
      this.createProperBlurOverlay(blurArea, this.blurIntensity);

      blurArea.style.cssText = `
      position: absolute;
      left: ${blurData.coords.x}px;
      top: ${blurData.coords.y}px;
      width: ${blurData.coords.width}px;
      height: ${blurData.coords.height}px;
      z-index: 999998;
      border: none;
      cursor: pointer;
      overflow: hidden;
    `;

      // Note: Click handling is managed by the main event handler and eraser mode

      document.body.appendChild(blurArea);
    }

    private handleMessage(
      message: any,
      _sender: any,
      sendResponse: (response: any) => void
    ) {
      switch (message.action) {
        case "blurSelectedText":
          this.blurSelectedText();
          sendResponse({ success: true });
          break;
        case "settingsUpdated":
          this.isEnabled = message.settings.isEnabled;
          this.blurIntensity = message.settings.blurIntensity;
          this.updateBlurIntensity();
          this.updateToolbarStates();
          this.updateDisabledState();
          sendResponse({ success: true });
          break;
        case "clearAllBlurs":
          this.clearAllBlurs();
          sendResponse({ success: true });
          break;
        case "toggleExtension":
          this.isEnabled = !this.isEnabled;
          if (!this.isEnabled) {
            // Disable all modes when extension is disabled
            this.isBlurMode = false;
            this.isDrawingMode = false;
            this.isTextSelectionMode = false;
            this.isEraserMode = false;
            this.cleanupTextSelectionMode();
            this.hideFloatingToolbar();
            document.body.style.cursor = "default";
          } else {
            // When re-enabling, default to blur mode
            this.setExclusiveMode("blur");
          }
          this.updateToolbarStates();
          sendResponse({ success: true, isEnabled: this.isEnabled });
          break;

        case "toggleDrawMode":
          // Only allow toggling if extension is enabled
          if (!this.isEnabled) {
            sendResponse({
              success: false,
              error: "Extension is disabled",
              drawModeActive: false,
            });
            break;
          }

          this.isDrawingMode = !this.isDrawingMode;
          document.body.style.cursor = this.isDrawingMode
            ? "crosshair"
            : "default";

          if (this.isDrawingMode) {
            this.hideHoverIndicator();
          }

          sendResponse({
            success: true,
            drawModeActive: this.isDrawingMode,
          });
          break;
        case "toggleEraserMode":
          // Only allow toggling if extension is enabled
          if (!this.isEnabled) {
            sendResponse({
              success: false,
              error: "Extension is disabled",
              eraserModeActive: false,
            });
            break;
          }

          this.isEraserMode = !this.isEraserMode;
          document.body.style.cursor = this.isEraserMode
            ? "crosshair"
            : "default";

          if (this.isEraserMode) {
            this.hideHoverIndicator();
          }

          // Update body classes for mode-specific styling
          this.updateDisabledState();

          sendResponse({
            success: true,
            eraserModeActive: this.isEraserMode,
          });
          break;
        case "getEraserModeStatus":
          sendResponse({
            success: true,
            eraserModeActive: this.isEraserMode,
          });
          break;
        case "toggleAllBlurs":
          this.toggleAllBlurs();
          sendResponse({
            success: true,
            blursHidden: this.blursHidden,
          });
          break;
        case "getBlurToggleStatus":
          sendResponse({
            success: true,
            blursHidden: this.blursHidden,
          });
          break;
        case "getCurrentBlurData":
          sendResponse({
            success: true,
            blurData: this.blurredElements,
          });
          break;
        case "saveBlurData":
          if (message.forceSync) {
            // Force sync to both local and extension storage
            this.saveBlurData();
            sendResponse({ success: true });
          } else {
            sendResponse({ error: "Use force sync for manual saves" });
          }
          break;
        case "showToolbar":
          if (this.isEnabled) {
            this.showFloatingToolbar();
            // Default to blur mode when toolbar is shown
            this.setExclusiveMode("blur");
            sendResponse({ success: true });
          } else {
            sendResponse({ success: false, error: "Extension is disabled" });
          }
          break;
        case "hideToolbar":
          this.hideFloatingToolbar();
          // Disable all interaction modes when toolbar is hidden
          this.isBlurMode = false;
          this.isDrawingMode = false;
          this.isTextSelectionMode = false;
          this.isEraserMode = false;
          this.cleanupTextSelectionMode();
          document.body.style.cursor = "default";
          this.hideHoverIndicator();
          sendResponse({ success: true });
          break;
        case "getToolbarState":
          const isVisible = this.floatingToolbar?.style.display === "flex";
          sendResponse({ success: true, isVisible });
          break;
        case "ping":
          // Simple ping to check if content script is available
          sendResponse({ success: true, ready: true });
          break;
        case "getBlurCounts":
          // Count different types of blurs on the page
          const clickBlurs = this.blurredElements.filter(
            (blur) => blur.type === "element"
          ).length;
          const drawBlurs = this.blurredElements.filter(
            (blur) => blur.type === "area"
          ).length;
          const textBlurs = this.blurredElements.filter(
            (blur) => blur.type === "text"
          ).length;

          sendResponse({
            success: true,
            counts: {
              clickBlurs,
              drawBlurs,
              textBlurs,
              total: this.blurredElements.length,
            },
          });
          break;
        default:
          sendResponse({ error: "Unknown action" });
      }
    }

    private blurSelectedText() {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;

      const range = selection.getRangeAt(0);
      if (range.collapsed) return;

      // Create a span to wrap the selected text
      const span = document.createElement("span");
      span.className = "blur-anything-text-blur";
      span.style.filter = `blur(${this.blurIntensity}px)`;
      span.style.cursor = "pointer";

      try {
        range.surroundContents(span);

        // Add click handler to remove blur
        span.addEventListener("click", (e) => {
          e.stopPropagation();
          const parent = span.parentNode;
          if (parent) {
            parent.insertBefore(
              document.createTextNode(span.textContent || ""),
              span
            );
            parent.removeChild(span);
          }
        });

        selection.removeAllRanges();
      } catch (error) {
        console.error("Failed to blur selected text:", error);
      }
    }

    private updateBlurIntensity() {
      // Debounce multiple rapid calls
      if (this.intensityUpdateTimer) {
        clearTimeout(this.intensityUpdateTimer);
      }

      this.intensityUpdateTimer = window.setTimeout(() => {
        this.performBlurIntensityUpdate();
      }, 50); // 50ms debounce
    }

    private performBlurIntensityUpdate() {
      // Update all existing blurred elements
      document.querySelectorAll(".blur-anything-blurred").forEach((element) => {
        const htmlElement = element as HTMLElement;
        htmlElement.style.filter = htmlElement.style.filter.replace(
          /blur\([^)]*\)/g,
          `blur(${this.blurIntensity}px)`
        );
      });

      // Update blur areas
      document.querySelectorAll(".blur-anything-area").forEach((area) => {
        const htmlArea = area as HTMLElement;

        // Check if this blur area is currently hidden (toggle state)
        const isHidden = htmlArea.hasAttribute("data-original-backdrop");

        if (isHidden) {
          // Update the stored backdrop value instead of the current style
          htmlArea.setAttribute(
            "data-original-backdrop",
            `blur(${this.blurIntensity}px)`
          );
        } else {
          // Use backdrop-filter for draw areas (to blur content behind them)

          // No need for area size calculations - using uniform intensity

          // Use uniform intensity for all sizes to prevent grey overlay
          const effectiveIntensity = Math.max(1, this.blurIntensity);

          // CRITICAL: Clear ALL existing filters FIRST to prevent layering
          htmlArea.style.removeProperty("backdrop-filter");
          htmlArea.style.removeProperty("-webkit-backdrop-filter");
          htmlArea.style.removeProperty("filter");

          // Force a repaint to ensure filters are cleared
          htmlArea.offsetHeight;

          // Update the blur overlay instead of backdrop-filter
          this.updateBlurOverlay(htmlArea, effectiveIntensity);

          // Use minimal background opacity to avoid grey highlighting
          const backgroundOpacity = 0.05;
          htmlArea.style.backgroundColor = `rgba(0, 0, 0, ${backgroundOpacity})`;
        }
      });

      // Update text blurs
      document.querySelectorAll(".blur-anything-text-blur").forEach((text) => {
        const htmlText = text as HTMLElement;
        htmlText.style.filter = `blur(${this.blurIntensity}px)`;
      });
    }

    private showToolbarNotification(message: string, duration: number = 2000) {
      // Remove any existing toolbar notification
      const existingNotification = document.getElementById(
        "blur-anything-toolbar-notification"
      );
      if (existingNotification) {
        existingNotification.remove();
      }

      const notification = document.createElement("div");
      notification.id = "blur-anything-toolbar-notification";
      notification.style.cssText = `
      position: fixed;
      bottom: 80px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.8);
      color: white;
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 14px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      z-index: 1000000;
      pointer-events: none;
      animation: fadeInOut ${duration}ms ease-in-out;
      max-width: 300px;
      text-align: center;
      word-wrap: break-word;
    `;

      notification.textContent = message;

      // Add fade animation if not already present
      if (!document.getElementById("toolbar-notification-styles")) {
        const style = document.createElement("style");
        style.id = "toolbar-notification-styles";
        style.textContent = `
        @keyframes fadeInOut {
          0%, 100% { opacity: 0; transform: translateX(-50%) translateY(10px); }
          15%, 85% { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
      `;
        document.head.appendChild(style);
      }

      document.body.appendChild(notification);

      // Remove after animation
      setTimeout(() => {
        notification.remove();
      }, duration);
    }

    private clearAllBlurs() {
      // Method 0: Remove injected CSS first (this is the key fix!)
      this.removeInjectedBlurCSS();

      // Method 1: Remove all elements with blur-anything-blurred class
      const blurredElements = document.querySelectorAll(
        ".blur-anything-blurred"
      );

      blurredElements.forEach((element) => {
        const htmlElement = element as HTMLElement;
        this.removeBlurFromElement(htmlElement);
      });

      // Method 2: Also check elements from our saved data (in case class was removed)

      this.blurredElements.forEach((blurData) => {
        if (blurData.type === "element" && blurData.selector) {
          try {
            const element = document.querySelector(
              blurData.selector
            ) as HTMLElement;
            if (element) {
              this.removeBlurFromElement(element);
            }
          } catch (error) {}
        }
      });

      // Method 3: Search for any element with blur filter (comprehensive check)

      const allElements = document.querySelectorAll("*");
      let foundBlurredElements = 0;
      allElements.forEach((element) => {
        const htmlElement = element as HTMLElement;
        const computedStyle = window.getComputedStyle(htmlElement);
        const inlineFilter = htmlElement.style.filter;
        const styleAttr = htmlElement.getAttribute("style") || "";

        if (
          inlineFilter?.includes("blur") ||
          styleAttr.includes("blur") ||
          computedStyle.filter?.includes("blur")
        ) {
          foundBlurredElements++;

          // Try to remove blur from this element too
          this.removeBlurFromElement(htmlElement);
        }
      });

      // Remove all blur areas
      document.querySelectorAll(".blur-anything-area").forEach((area) => {
        const htmlArea = area as HTMLElement;
        // Clear all filters before removing to prevent layering artifacts
        htmlArea.style.removeProperty("backdrop-filter");
        htmlArea.style.removeProperty("-webkit-backdrop-filter");
        htmlArea.style.removeProperty("filter");
        htmlArea.remove();
      });

      // Remove all text blurs (simple text-only approach)
      document.querySelectorAll(".blur-anything-text-blur").forEach((span) => {
        const parent = span.parentNode;
        if (parent) {
          try {
            // Since text blurs only contain plain text, simple replacement is sufficient
            const textContent = span.textContent || "";
            if (textContent.trim()) {
              parent.insertBefore(document.createTextNode(textContent), span);
            }
            parent.removeChild(span);
          } catch (error) {
            console.error("Error removing text blur:", error);
          }
        }
      });

      // Clear the saved data AFTER processing all elements

      this.blurredElements = [];
      this.saveBlurData();
      this.clearLocalData();

      // Force a final check for any remaining blurred elements
      setTimeout(() => {
        const remainingBlurred = document.querySelectorAll(
          ".blur-anything-blurred"
        );
        if (remainingBlurred.length > 0) {
          remainingBlurred.forEach((element, index) => {
            this.removeBlurFromElement(element as HTMLElement);
          });
        }
      }, 100);

      // Show notification about what was cleared
      this.showToolbarNotification(
        `Cleared all blurs. Found ${foundBlurredElements} blurred elements.`
      );
    }

    /*private removedShowDrawModeNotification() {
    // Remove existing notification if any
    //this.hideDrawModeNotification();

    this.drawModeNotification = document.createElement("div");
    this.drawModeNotification.id = "blur-anything-draw-notification";
    this.drawModeNotification.innerHTML = `
      <div class="notification-content">
        <div class="notification-header">
          <svg class="notification-icon" viewBox="0 0 24 24" width="20" height="20">
            <path fill="currentColor" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
          </svg>
          <span class="notification-title">Draw Mode Active</span>
        </div>
        <div class="notification-instructions">
          Click and drag to create blur areas • Press <kbd>ESC</kbd> to exit
        </div>
      </div>
    `;

    this.drawModeNotification.style.cssText = `
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: linear-gradient(135deg, #007cba 0%, #0056b3 100%);
      color: white;
      padding: 16px 20px;
      border-radius: 12px;
      box-shadow: 0 8px 25px rgba(0, 124, 186, 0.3);
      z-index: 999999;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      line-height: 1.4;
      max-width: 400px;
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.2);
      animation: slideDown 0.3s ease-out;
    `;

    // Add animation styles
    const style = document.createElement("style");
    style.textContent = `
      @keyframes slideDown {
        from {
          opacity: 0;
          transform: translateX(-50%) translateY(-20px);
        }
        to {
          opacity: 1;
          transform: translateX(-50%) translateY(0);
        }
      }
      
      #blur-anything-draw-notification .notification-content {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      
      #blur-anything-draw-notification .notification-header {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 600;
      }
      
      #blur-anything-draw-notification .notification-instructions {
        font-size: 12px;
        opacity: 0.9;
        display: flex;
        align-items: center;
        gap: 4px;
      }
      
      #blur-anything-draw-notification kbd {
        background: rgba(255, 255, 255, 0.2);
        border: 1px solid rgba(255, 255, 255, 0.3);
        border-radius: 4px;
        padding: 2px 6px;
        font-size: 11px;
        font-family: monospace;
      }
    `;

    document.head.appendChild(style);
    document.body.appendChild(this.drawModeNotification);
  }*/

    /*private hideDrawModeNotification() {
    if (this.drawModeNotification) {
      this.drawModeNotification.remove();
      this.drawModeNotification = null;
    }
  }*/

    /*private showEraserModeNotification() {
    // Remove existing notification if any
    //this.hideEraserModeNotification();

    this.eraserNotification = document.createElement("div");
    this.eraserNotification.id = "blur-anything-eraser-notification";
    this.eraserNotification.innerHTML = `
      <div class="notification-content">
        <div class="notification-header">
          <svg class="notification-icon" viewBox="0 0 24 24" width="20" height="20">
            <path fill="currentColor" d="M16.24,3.56L21.19,8.5C21.97,9.29 21.97,10.55 21.19,11.34L12,20.53C10.44,22.09 7.91,22.09 6.34,20.53L2.81,17C2.03,16.21 2.03,14.95 2.81,14.16L13.41,3.56C14.2,2.78 15.46,2.78 16.24,3.56M4.22,15.58L7.76,19.11C8.54,19.9 9.8,19.9 10.59,19.11L14.12,15.58L9.17,10.63L4.22,15.58Z"/>
          </svg>
          <span class="notification-title">Eraser Mode Active</span>
        </div>
        <div class="notification-instructions">
          Click on blurred elements or areas to remove them • Press <kbd>ESC</kbd> to exit
        </div>
      </div>
    `;

    this.eraserNotification.style.cssText = `
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: linear-gradient(135deg, #dc3545 0%, #c82333 100%);
      color: white;
      padding: 16px 20px;
      border-radius: 12px;
      box-shadow: 0 8px 25px rgba(220, 53, 69, 0.3);
      z-index: 999999;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      line-height: 1.4;
      max-width: 400px;
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.2);
      animation: slideDown 0.3s ease-out;
    `;

    // Add animation styles
    const style = document.createElement("style");
    style.textContent = `
      #blur-anything-eraser-notification .notification-content {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      
      #blur-anything-eraser-notification .notification-header {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 600;
      }
      
      #blur-anything-eraser-notification .notification-instructions {
        font-size: 12px;
        opacity: 0.9;
        display: flex;
        align-items: center;
        gap: 4px;
      }
      
      #blur-anything-eraser-notification kbd {
        background: rgba(255, 255, 255, 0.2);
        border: 1px solid rgba(255, 255, 255, 0.3);
        border-radius: 4px;
        padding: 2px 6px;
        font-size: 11px;
        font-family: monospace;
      }
    `;

    document.head.appendChild(style);
    document.body.appendChild(this.eraserNotification);
  }*/

    /*private hideEraserModeNotification() {
    if (this.eraserNotification) {
      this.eraserNotification.remove();
      this.eraserNotification = null;
    }
  }*/

    private toggleAllBlurs() {
      this.blursHidden = !this.blursHidden;

      const body = document.body;
      if (this.blursHidden) {
        body.classList.add("blur-anything-blurs-hidden");

        // Remove the injected CSS that creates the blurs
        this.removeInjectedBlurCSS();

        // Inject CSS to hide blurs when body has the hidden class
        if (!document.getElementById("blur-anything-toggle-css")) {
          const style = document.createElement("style");
          style.id = "blur-anything-toggle-css";
          style.textContent = `
          body.blur-anything-blurs-hidden .blur-anything-blurred,
          body.blur-anything-blurs-hidden .blur-anything-text-blur,
          body.blur-anything-blurs-hidden .blur-anything-area,
          body.blur-anything-blurs-hidden [data-blur-applied] {
            filter: none !important;
            backdrop-filter: none !important;
            -webkit-backdrop-filter: none !important;
            opacity: 0.7 !important;
          }
        `;
          document.head.appendChild(style);
        }
      } else {
        body.classList.remove("blur-anything-blurs-hidden");

        // Restore the injected CSS for one-click blurs
        this.preInjectBlurCSS(this.blurredElements);
      }

      // CSS handles the actual blur toggling now - much simpler and more reliable!
      // Toggle all blurred elements
      const blurredElements = document.querySelectorAll(
        ".blur-anything-blurred"
      );

      blurredElements.forEach((element) => {
        const htmlElement = element as HTMLElement;
        if (this.blursHidden) {
          // Store the original filter and hide blur
          const originalFilter = htmlElement.style.filter;

          htmlElement.setAttribute("data-original-filter", originalFilter);
          const newFilter = originalFilter.replace(/blur\([^)]*\)/g, "").trim();
          htmlElement.style.filter = newFilter;

          htmlElement.style.opacity = "0.7"; // Slight transparency to indicate hidden state
        } else {
          // Restore the original filter
          const originalFilter = htmlElement.getAttribute(
            "data-original-filter"
          );
          if (originalFilter) {
            htmlElement.style.filter = originalFilter;
            htmlElement.removeAttribute("data-original-filter");
          }
          htmlElement.style.opacity = "1";
        }
      });

      // Toggle all blur areas
      const blurAreas = document.querySelectorAll(".blur-anything-area");

      blurAreas.forEach((area) => {
        const htmlArea = area as HTMLElement;
        if (this.blursHidden) {
          // Store original backdrop-filter and hide blur
          const currentBackdrop =
            htmlArea.style.backdropFilter ||
            htmlArea.style.getPropertyValue("-webkit-backdrop-filter");
          const originalBackdrop =
            currentBackdrop && currentBackdrop !== "none"
              ? currentBackdrop
              : `blur(${this.blurIntensity}px)`;

          htmlArea.setAttribute("data-original-backdrop", originalBackdrop);
          htmlArea.style.backdropFilter = "none";
          htmlArea.style.setProperty("-webkit-backdrop-filter", "none");
          htmlArea.style.backgroundColor = "transparent";
          htmlArea.style.border = "none";
        } else {
          // Restore original backdrop-filter
          const originalBackdrop = htmlArea.getAttribute(
            "data-original-backdrop"
          );
          const restoreBackdrop =
            originalBackdrop || `blur(${this.blurIntensity}px)`;

          // Clear existing filters first to prevent layering
          htmlArea.style.removeProperty("backdrop-filter");
          htmlArea.style.removeProperty("-webkit-backdrop-filter");
          htmlArea.style.removeProperty("filter");

          // Force repaint
          htmlArea.offsetHeight;

          // Apply fresh backdrop filter
          htmlArea.style.backdropFilter = restoreBackdrop;
          htmlArea.style.setProperty(
            "-webkit-backdrop-filter",
            restoreBackdrop
          );

          // Use consistent background opacity
          const backgroundOpacity = 0.05;
          htmlArea.style.backgroundColor = `rgba(0, 0, 0, ${backgroundOpacity})`;
          htmlArea.style.border = "none";
          htmlArea.removeAttribute("data-original-backdrop");
        }
      });

      // Toggle all text blurs
      const textBlurs = document.querySelectorAll(".blur-anything-text-blur");

      textBlurs.forEach((text) => {
        const htmlText = text as HTMLElement;
        if (this.blursHidden) {
          // Store the original filter and hide blur
          const originalFilter = htmlText.style.filter;

          htmlText.setAttribute("data-original-filter", originalFilter);
          const newFilter = originalFilter.replace(/blur\([^)]*\)/g, "").trim();
          htmlText.style.filter = newFilter;

          htmlText.style.opacity = "0.7"; // Slight transparency to indicate hidden state
        } else {
          // Restore the original filter
          const originalFilter = htmlText.getAttribute("data-original-filter");
          if (originalFilter) {
            htmlText.style.filter = originalFilter;
            htmlText.removeAttribute("data-original-filter");
          }
          htmlText.style.opacity = "1";
        }
      });

      // Show notification
      this.showToggleNotification();
    }

    private showToggleNotification() {
      // Remove any existing toggle notification
      const existingNotification = document.getElementById(
        "blur-anything-toggle-notification"
      );
      if (existingNotification) {
        existingNotification.remove();
      }

      const notification = document.createElement("div");
      notification.id = "blur-anything-toggle-notification";

      const action = this.blursHidden ? "hidden" : "shown";
      const icon = this.blursHidden
        ? "M12,9A3,3 0 0,0 9,12A3,3 0 0,0 12,15A3,3 0 0,0 15,12A3,3 0 0,0 12,9M12,17A5,5 0 0,1 7,12A5,5 0 0,1 12,7A5,5 0 0,1 17,12A5,5 0 0,1 12,17M12,4.5C7,4.5 2.73,7.61 1,12C2.73,16.39 7,19.5 12,19.5C17,19.5 21.27,16.39 23,12C21.27,7.61 17,4.5 12,4.5Z"
        : "M11.83,9L15,12.16C15,12.11 15,12.05 15,12A3,3 0 0,0 12,9C11.94,9 11.89,9 11.83,9M7.53,9.8L9.08,11.35C9.03,11.56 9,11.77 9,12A3,3 0 0,0 12,15C12.22,15 12.44,14.97 12.65,14.92L14.2,16.47C13.53,16.8 12.79,17 12,17A5,5 0 0,1 7,12C7,11.21 7.2,10.47 7.53,9.8M2,4.27L4.28,6.55L4.73,7C3.08,8.3 1.78,10 1,12C2.73,16.39 7,19.5 12,19.5C13.55,19.5 15.03,19.2 16.38,18.66L16.81,19.09L19.73,22L21,20.73L3.27,3M12,7A5,5 0 0,1 17,12C17,12.64 16.87,13.26 16.64,13.82L19.57,16.75C21.07,15.5 22.27,13.86 23,12C21.27,7.61 17,4.5 12,4.5C10.6,4.5 9.26,4.75 8,5.2L10.17,7.35C10.76,7.13 11.37,7 12,7Z";

      notification.innerHTML = `
      <div class="toggle-notification-content">
        <svg class="toggle-icon" viewBox="0 0 24 24" width="20" height="20">
          <path fill="currentColor" d="${icon}"/>
        </svg>
        <span class="toggle-message">All blurs ${action}</span>
      </div>
    `;

      const bgColor = this.blursHidden ? "#ffc107" : "#28a745";
      notification.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: ${bgColor};
      color: white;
      padding: 12px 16px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      z-index: 999999;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      font-weight: 500;
      animation: slideInRight 0.3s ease-out;
    `;

      // Add animation styles
      const style = document.createElement("style");
      style.textContent = `
      @keyframes slideInRight {
        from {
          transform: translateX(100%);
          opacity: 0;
        }
        to {
          transform: translateX(0);
          opacity: 1;
        }
      }
      
      #blur-anything-toggle-notification .toggle-notification-content {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      
      #blur-anything-toggle-notification .toggle-icon {
        flex-shrink: 0;
      }
    `;

      document.head.appendChild(style);
      document.body.appendChild(notification);

      // Auto-hide after 2 seconds
      setTimeout(() => {
        if (notification.parentNode) {
          notification.style.animation = "slideInRight 0.3s ease-out reverse";
          setTimeout(() => {
            notification.remove();
            style.remove();
          }, 300);
        }
      }, 2000);
    }

    private saveBlurDataLocally() {
      try {
        const localData = {
          url: window.location.href,
          blurData: this.blurredElements,
          timestamp: Date.now(),
        };
        localStorage.setItem("blur-anything-data", JSON.stringify(localData));
      } catch (error) {}
    }

    private loadBlurDataLocally(): BlurData[] {
      try {
        const saved = localStorage.getItem("blur-anything-data");
        if (saved) {
          const data = JSON.parse(saved);
          if (data.url === window.location.href && data.blurData) {
            return data.blurData;
          }
        }
      } catch (error) {}
      return [];
    }

    private async syncLocalDataIfNeeded() {
      try {
        const saved = localStorage.getItem("blur-anything-data");
        if (saved) {
          const data = JSON.parse(saved);
          if (
            data.url === window.location.href &&
            data.blurData &&
            data.blurData.length > 0 &&
            data.timestamp
          ) {
            // Check if local data is newer than what we loaded
            const localCount = data.blurData.length;
            const extensionCount = this.blurredElements.length;

            if (localCount > extensionCount) {
              this.blurredElements = data.blurData;

              // Try to sync back to extension storage
              try {
                await browser.runtime.sendMessage({
                  action: "saveBlurData",
                  blurData: this.blurredElements,
                });

                // If successful, we can remove the local backup
                // (but keep it for now as a safety net)
              } catch (syncError) {}
            }
          }
        }
      } catch (error) {}
    }

    private clearLocalData() {
      try {
        localStorage.removeItem("blur-anything-data");
      } catch (error) {}
    }

    private preInjectBlurCSS(blurData: BlurData[]) {
      try {
        // Create CSS rules for instant blur application
        let cssRules = "";

        blurData.forEach((blur) => {
          if (blur.type === "element" && blur.selector) {
            // Pre-blur elements by selector
            cssRules += `${blur.selector} { filter: blur(${this.blurIntensity}px) !important; }\n`;
          } else if (blur.type === "area" && blur.coords) {
            // Pre-create area blurs with coordinates
            const coordsString = `${blur.coords.x},${blur.coords.y},${blur.coords.width},${blur.coords.height}`;
            cssRules += `[data-coords="${coordsString}"] { backdrop-filter: blur(${this.blurIntensity}px) !important; -webkit-backdrop-filter: blur(${this.blurIntensity}px) !important; }\n`;
          }
        });

        if (cssRules) {
          // Inject CSS immediately for instant blur effect
          const styleElement = document.createElement("style");
          styleElement.id = "blur-anything-instant-css";
          styleElement.textContent = cssRules;

          // Insert at the very beginning of head for maximum priority
          if (document.head) {
            document.head.insertBefore(styleElement, document.head.firstChild);
          } else {
            // Fallback: inject into HTML if head doesn't exist yet
            document.documentElement.appendChild(styleElement);
          }
        }
      } catch (error) {}
    }

    private injectContentStyles() {
      // Inject content script CSS styles
      if (!document.getElementById("blur-anything-content-styles")) {
        const style = document.createElement("style");
        style.id = "blur-anything-content-styles";
        style.textContent = `
        /* Content script styles for BlurShield extension */
        .blur-anything-blurred {
          transition: filter 0.3s ease;
        }

        .blur-anything-area {
          border: none;
          transition: all 0.3s ease;
          isolation: isolate;
          will-change: backdrop-filter;
          transform: translateZ(0);
          backface-visibility: hidden;
          perspective: 1000px;
          box-sizing: border-box;
        }

        .blur-anything-area:hover {
          background-color: rgba(0, 0, 0, 0.2);
        }

        .blur-anything-text-blur {
          transition: filter 0.3s ease;
          cursor: pointer;
        }

        body.blur-anything-enabled.blur-anything-eraser-mode .blur-anything-text-blur:hover {
          background-color: rgba(255, 255, 0, 0.15) !important;
          outline: 2px solid rgba(255, 255, 0, 0.3) !important;
          outline-offset: 1px !important;
        }
      `;
        document.head.appendChild(style);
      }
    }

    private removeInjectedBlurCSS() {
      // Remove the main injected CSS
      const injectedStyle = document.getElementById(
        "blur-anything-instant-css"
      );
      if (injectedStyle) {
        injectedStyle.remove();
      } else {
      }

      // Also check for any other blur-related style elements that might exist
      const allStyles = document.querySelectorAll("style");
      allStyles.forEach((style, index) => {
        if (
          style.textContent &&
          style.textContent.includes("blur(") &&
          style.textContent.includes("!important")
        ) {
          // Check if it's our CSS by looking for our selector patterns
          if (
            style.textContent.includes("filter: blur(") ||
            style.textContent.includes("backdrop-filter: blur(")
          ) {
            style.remove();
          }
        }
      });
    }

    private removeInjectedCSSRule(selector: string) {
      console.log(
        `BlurShield: Attempting to remove CSS rule for selector: ${selector}`
      );

      // Remove a specific CSS rule for a selector from the injected stylesheet
      const injectedStyle = document.getElementById(
        "blur-anything-instant-css"
      ) as HTMLStyleElement;

      if (injectedStyle && injectedStyle.sheet) {
        try {
          const sheet = injectedStyle.sheet as CSSStyleSheet;
          const rules = sheet.cssRules || sheet.rules;

          // Find and remove the rule for this selector
          let found = false;
          for (let i = rules.length - 1; i >= 0; i--) {
            const rule = rules[i] as CSSStyleRule;
            if (rule.selectorText === selector) {
              sheet.deleteRule(i);
              console.log(
                `BlurShield: Successfully removed CSS rule for ${selector}`
              );
              found = true;
              break;
            }
          }

          if (!found) {
            console.log(
              `BlurShield: No CSS rule found for selector ${selector}`
            );
            // Fallback: rebuild the entire stylesheet
            this.rebuildInjectedCSS();
          }
        } catch (error) {
          console.log(
            `BlurShield: Error removing CSS rule for ${selector}:`,
            error
          );
          // Fallback: rebuild the entire stylesheet without this selector
          this.rebuildInjectedCSS();
        }
      } else {
        this.rebuildInjectedCSS();
      }
    }

    private rebuildInjectedCSS() {
      // Remove existing CSS and rebuild with current blur elements

      this.removeInjectedBlurCSS();
      this.preInjectBlurCSS(this.blurredElements);
    }

    private attemptImmediateBlurRestoration() {
      try {
        // Try to load blur data from local storage immediately (faster than extension storage)
        const localBlurData = this.loadBlurDataLocally();
        if (localBlurData && localBlurData.length > 0) {
          this.blurredElements = localBlurData;

          // PERFORMANCE FIX: Pre-inject CSS instead of multiple DOM operations
          this.preInjectBlurCSS(localBlurData);

          // Single application attempt (not multiple)
          this.applyExistingBlurs();
        }
      } catch (error) {}
    }

    private scheduleBlurRestoration() {
      // PERFORMANCE FIX: Only restore area and element blurs, not text blurs
      // Text blurs are too unstable when automatically restored

      // Call 1: Immediate (for elements already in DOM)
      this.applyExistingBlurs();

      // Call 2: After DOM is more likely to be ready (single retry)
      setTimeout(() => {
        this.applyExistingBlurs();
      }, 100);

      // Disable mutation observer and interaction listeners for text blurs
      // They cause too much DOM instability
      // this.setupMutationObserver();
      // this.setupInteractionListeners();
    }

    private canApplyBlurToElement(element: HTMLElement): boolean {
      try {
        // Check if element is valid and in the DOM
        if (!element || !element.parentNode || !document.contains(element)) {
          return false;
        }

        // Check if it's actually an HTMLElement
        if (!(element instanceof HTMLElement)) {
          return false;
        }

        // Check if element is visible
        let style;
        try {
          style = window.getComputedStyle(element);
          if (style.display === "none" || style.visibility === "hidden") {
            return false;
          }
        } catch (styleError) {
          return false;
        }

        // Avoid applying blur to certain element types that might cause issues
        const problematicTags = [
          "html",
          "head",
          "title",
          "meta",
          "link",
          "script",
          "style",
          "noscript",
          "iframe",
          "embed",
          "object",
          "svg",
          "canvas",
        ];
        if (problematicTags.includes(element.tagName.toLowerCase())) {
          return false;
        }

        // Check if element is read-only or has special restrictions
        if (
          element.hasAttribute("readonly") ||
          element.hasAttribute("disabled")
        ) {
          return false;
        }

        // Check for elements with contenteditable="false"
        if (element.getAttribute("contenteditable") === "false") {
          return false;
        }

        // Test if we can modify the element's style safely
        try {
          const originalFilter = element.style.filter;
          const testFilter = "blur(0px)";
          element.style.filter = testFilter;

          // Check if the filter was actually applied
          if (element.style.filter !== testFilter) {
            element.style.filter = originalFilter;
            // For standard HTML elements like H1, P, DIV, etc., this is usually fine
            // Only return false for truly problematic elements
            const standardTags = [
              "h1",
              "h2",
              "h3",
              "h4",
              "h5",
              "h6",
              "p",
              "div",
              "span",
              "section",
              "article",
              "aside",
              "main",
              "nav",
              "header",
              "footer",
              "ul",
              "ol",
              "li",
              "a",
              "img",
              "button",
              "input",
              "textarea",
              "label",
              "form",
            ];
            if (standardTags.includes(element.tagName.toLowerCase())) {
              return true; // Allow standard HTML elements even if test fails
            }
            return false;
          }

          element.style.filter = originalFilter;
          return true;
        } catch (styleError) {
          // For standard HTML elements, try to proceed anyway using fallback methods
          const standardTags = [
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
            "p",
            "div",
            "span",
            "section",
            "article",
            "aside",
            "main",
            "nav",
            "header",
            "footer",
            "ul",
            "ol",
            "li",
            "a",
            "img",
            "button",
            "input",
            "textarea",
            "label",
            "form",
          ];
          return standardTags.includes(element.tagName.toLowerCase());
        }
      } catch (error) {
        return false;
      }
    }

    private areValidCoordinates(coords: any): boolean {
      return (
        coords &&
        typeof coords.x === "number" &&
        typeof coords.y === "number" &&
        typeof coords.width === "number" &&
        typeof coords.height === "number" &&
        coords.width > 0 &&
        coords.height > 0 &&
        coords.x >= 0 &&
        coords.y >= 0
      );
    }
    private createFloatingToolbar() {
      if (this.floatingToolbar) return;

      this.floatingToolbar = document.createElement("div");
      this.floatingToolbar.id = "blur-anything-floating-toolbar";
      this.floatingToolbar.innerHTML = `
      <div class="toolbar-content">
        <button class="toolbar-btn" id="toolbarBlurMode" title="Toggle Blur Mode">●</button>
        <button class="toolbar-btn" id="toolbarDrawMode" title="Draw Mode">▢</button>
        <button class="toolbar-btn" id="toolbarTextMode" title="Text Selection Mode">T</button>
        <button class="toolbar-btn" id="toolbarEraserMode" title="Eraser">✗</button>
        <button class="toolbar-btn intensity-btn" id="toolbarIntensityMinus" title="Decrease Blur Intensity">−</button>
        <div class="intensity-display" id="intensityDisplay" title="Current Blur Intensity">${this.blurIntensity}</div>
        <button class="toolbar-btn intensity-btn" id="toolbarIntensityPlus" title="Increase Blur Intensity">+</button>
        <button class="toolbar-btn" id="toolbarToggleBlurs" title="Toggle Blurs">👁</button>
        <button class="toolbar-btn" id="toolbarSaveBlurs" title="Save Current Blurs">💾</button>
        <button class="toolbar-btn" id="toolbarClearAll" title="Clear All">🗑</button>
        <button class="toolbar-btn" id="toolbarClose" title="Close">×</button>
      </div>
    `;

      this.addToolbarStyles();
      this.positionToolbar();
      this.setupToolbarEvents();
      this.updateIntensityDisplay();
      document.body.appendChild(this.floatingToolbar);
    }

    private showFloatingToolbar() {
      if (this.floatingToolbar && this.isEnabled) {
        this.floatingToolbar.style.display = "flex";
      }
    }

    private hideFloatingToolbar() {
      if (this.floatingToolbar) {
        this.floatingToolbar.style.display = "none";
      }
    }

    private addToolbarStyles() {
      if (document.getElementById("blur-anything-toolbar-styles")) return;

      const style = document.createElement("style");
      style.id = "blur-anything-toolbar-styles";
      style.textContent = `
      #blur-anything-floating-toolbar {
        position: fixed; 
        bottom: 20px; 
        left: 50%; 
        transform: translateX(-50%);
        z-index: 999999;
        background: rgba(40, 40, 45, 0.95); 
        backdrop-filter: blur(15px);
        -webkit-backdrop-filter: blur(15px);
        border: 1px solid rgba(80, 80, 85, 0.8); 
        border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.4); 
        display: none; 
        gap: 6px; 
        padding: 8px 12px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
        user-select: none; 
        transition: all 0.3s ease;
        max-width: 90vw;
      }

      #blur-anything-floating-toolbar:hover {
        box-shadow: 0 12px 40px rgba(0,0,0,0.5);
        transform: translateX(-50%) translateY(-2px);
      }

      .toolbar-content { 
        display: flex; 
        gap: 4px; 
        align-items: center;
      }

      .toolbar-btn { 
        width: 36px; 
        height: 36px; 
        border: 2px solid transparent; 
        border-radius: 8px;
        background: transparent; 
        cursor: pointer; 
        color: rgba(255, 255, 255, 0.9);
        transition: all 0.2s ease; 
        display: flex; 
        align-items: center; 
        justify-content: center;
        font-size: 16px;
        position: relative;
        font-weight: 500;
      }

      .toolbar-btn:hover { 
        background: rgba(255, 255, 255, 0.1); 
        color: rgba(255, 255, 255, 1); 
        transform: scale(1.05);
        box-shadow: 0 2px 8px rgba(255, 255, 255, 0.2);
      }

      .toolbar-btn:active {
        transform: scale(0.95);
      }

      .toolbar-btn.active { 
        background: #007cba; 
        color: white; 
        box-shadow: 0 2px 12px rgba(0, 124, 186, 0.5);
        transform: scale(1.1);
        border: 2px solid #ffffff;
      }

      .toolbar-btn.active:hover {
        background: #0056b3;
        transform: scale(1.1);
      }

      /* Save button saved state */
      .toolbar-btn.saved {
        background: #28a745;
        color: white;
        box-shadow: 0 2px 8px rgba(40, 167, 69, 0.3);
        transform: scale(1.05);
      }

      .toolbar-btn.saved:hover {
        background: #218838;
      }

      /* Intensity controls styling */
      .intensity-btn {
        width: 28px;
        height: 28px;
        font-size: 18px;
        font-weight: bold;
        line-height: 1;
      }

      .intensity-display {
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 32px;
        height: 28px;
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 6px;
        font-size: 12px;
        font-weight: bold;
        color: rgba(255, 255, 255, 0.9);
        user-select: none;
        margin: 0 2px;
      }

      /* Close button styling */
      .toolbar-btn:last-child {
        margin-left: 8px;
        border-left: 1px solid rgba(255, 255, 255, 0.2);
        padding-left: 12px;
      }

      .toolbar-btn:last-child:hover {
        background: rgba(220, 53, 69, 0.9);
        color: white;
        border-color: rgba(220, 53, 69, 0.5);
      }

      /* Responsive design */
      @media (max-width: 768px) {
        #blur-anything-floating-toolbar {
          bottom: 10px;
          padding: 6px 8px;
          gap: 4px;
        }

        .toolbar-btn {
          width: 32px;
          height: 32px;
          font-size: 14px;
        }

        .toolbar-btn:last-child {
          margin-left: 6px;
          padding-left: 8px;
        }
      }

      /* Very small screens - make more compact */
      @media (max-width: 480px) {
        #blur-anything-floating-toolbar {
          bottom: 5px;
          padding: 4px 6px;
          gap: 2px;
          border-radius: 8px;
        }

        .toolbar-btn {
          width: 28px;
          height: 28px;
          font-size: 12px;
        }

        .toolbar-btn:last-child {
          margin-left: 4px;
          padding-left: 6px;
        }
      }
    `;
      document.head.appendChild(style);
    }

    private positionToolbar() {
      // Toolbar is now statically positioned via CSS at bottom center
      // No need for dynamic positioning
    }

    private setupToolbarEvents() {
      if (!this.floatingToolbar) return;

      // Button events - exclusive selection (only one mode at a time)
      this.floatingToolbar
        .querySelector("#toolbarBlurMode")
        ?.addEventListener("click", () => {
          // Toggle blur mode or switch to it from other modes
          if (this.isBlurMode) {
            // Already in blur mode, disable it
            this.setExclusiveMode("none");
          } else {
            // Switch to blur mode
            this.setExclusiveMode("blur");
          }
        });

      this.floatingToolbar
        .querySelector("#toolbarDrawMode")
        ?.addEventListener("click", () => {
          // Toggle draw mode or switch to it from other modes
          if (this.isDrawingMode) {
            // Already in draw mode, disable it
            this.setExclusiveMode("none");
          } else {
            // Switch to draw mode
            this.setExclusiveMode("draw");
          }
        });

      this.floatingToolbar
        .querySelector("#toolbarTextMode")
        ?.addEventListener("click", () => {
          // Toggle text selection mode or switch to it from other modes
          if (this.isTextSelectionMode) {
            // Already in text mode, disable it
            this.setExclusiveMode("none");
          } else {
            // Switch to text selection mode
            this.setExclusiveMode("text");
          }
        });

      this.floatingToolbar
        .querySelector("#toolbarEraserMode")
        ?.addEventListener("click", () => {
          // Toggle eraser mode or switch to it from other modes
          if (this.isEraserMode) {
            // Already in eraser mode, disable it
            this.setExclusiveMode("none");
          } else {
            // Switch to eraser mode
            this.setExclusiveMode("eraser");
          }
        });

      // Setup hold functionality for intensity buttons
      this.setupIntensityHoldButton("#toolbarIntensityMinus", -1);
      this.setupIntensityHoldButton("#toolbarIntensityPlus", 1);

      this.floatingToolbar
        .querySelector("#toolbarToggleBlurs")
        ?.addEventListener("click", () => {
          this.toggleAllBlurs();
          this.updateToolbarStates();
        });

      this.floatingToolbar
        .querySelector("#toolbarSaveBlurs")
        ?.addEventListener("click", () => {
          this.saveCurrentBlurs();
        });

      this.floatingToolbar
        .querySelector("#toolbarClearAll")
        ?.addEventListener("click", () => {
          this.clearAllBlurs();
        });

      this.floatingToolbar
        .querySelector("#toolbarClose")
        ?.addEventListener("click", () => {
          this.setExclusiveMode("none");
          this.hideFloatingToolbar();
          // Notify any listening popups that toolbar was closed
          browser.runtime.sendMessage({ action: "toolbarClosed" }).catch(() => {
            // Popup might not be open, ignore errors
          });
        });
    }

    private saveCurrentBlurs() {
      // Check freemium restrictions for saving
      if (!freemiumService.checkFeatureAccess("save")) {
        return;
      }

      if (this.blurredElements.length === 0) {
        this.showToolbarNotification("No blurs to save");
        return;
      }

      try {
        // Debug: Log what we're saving with detailed breakdown

        this.blurredElements.forEach((blur, index) => {
          if (blur.type === "area" && blur.coords) {
            console.log(
              `     Coords: (${blur.coords.x}, ${blur.coords.y}) ${blur.coords.width}x${blur.coords.height}`
            );
          }
          if (blur.type === "text" && blur.text) {
          }
        });

        // Save current blurs
        this.saveBlurData();
        this.showToolbarNotification(
          `Saved ${this.blurredElements.length} blur${
            this.blurredElements.length === 1 ? "" : "s"
          }`
        );

        // Update save button visual state temporarily
        const saveBtn =
          this.floatingToolbar?.querySelector("#toolbarSaveBlurs");
        if (saveBtn) {
          saveBtn.classList.add("saved");
          setTimeout(() => {
            saveBtn.classList.remove("saved");
          }, 2000);
        }
      } catch (error) {
        console.error("Failed to save blurs:", error);
        this.showToolbarNotification("Failed to save blurs");
      }
    }

    private adjustBlurIntensity(change: number) {
      const newIntensity = Math.max(
        1,
        Math.min(10, this.blurIntensity + change)
      );

      if (newIntensity === this.blurIntensity) {
        // At limits
        if (newIntensity === 1) {
          this.showToolbarNotification("Minimum blur intensity (1px)");
        } else if (newIntensity === 10) {
          this.showToolbarNotification("Maximum blur intensity (10px)");
        }
        return;
      }

      this.blurIntensity = newIntensity;

      // Update display
      this.updateIntensityDisplay();

      // Apply to existing blurs
      this.updateBlurIntensity();

      // Show feedback
      this.showToolbarNotification(`Blur intensity: ${this.blurIntensity}px`);

      // Save setting
      this.saveIntensitySetting();
    }

    private updateIntensityDisplay() {
      const display = this.floatingToolbar?.querySelector("#intensityDisplay");
      if (display) {
        display.textContent = this.blurIntensity.toString();
      }
    }

    private async saveIntensitySetting() {
      try {
        await browser.runtime.sendMessage({
          action: "updateSettings",
          settings: {
            blurIntensity: this.blurIntensity,
            isEnabled: this.isEnabled,
            persistBlurs: true,
          },
        });
      } catch (error) {}
    }

    private setExclusiveMode(
      mode: "blur" | "draw" | "text" | "eraser" | "none"
    ) {
      // If extension is disabled, only allow "none" mode
      if (!this.isEnabled && mode !== "none") {
        console.log("Cannot switch to mode", mode, "- extension is disabled");
        return;
      }

      // Clear all modes first
      this.isBlurMode = false;
      this.isDrawingMode = false;
      this.isTextSelectionMode = false;
      this.isEraserMode = false;

      // Reset cursor
      document.body.style.cursor = "default";

      // Clean up any mode-specific functionality
      this.cleanupTextSelectionMode();

      // Set the requested mode
      switch (mode) {
        case "blur":
          this.isBlurMode = true;
          document.body.style.cursor = "pointer";
          break;
        case "draw":
          this.isDrawingMode = true;
          document.body.style.cursor = "crosshair";
          this.hideHoverIndicator();
          break;
        case "text":
          this.isTextSelectionMode = true;
          document.body.style.cursor = "text";
          this.hideHoverIndicator();
          this.setupTextSelectionMode();
          break;
        case "eraser":
          this.isEraserMode = true;
          document.body.style.cursor = "crosshair";
          this.hideHoverIndicator();
          break;
        case "none":
          // All modes disabled
          break;
      }

      // Update UI states and body classes
      this.updateToolbarStates();
      this.updateDisabledState();
    }

    private updateToolbarStates() {
      if (!this.floatingToolbar) return;

      // Update mode buttons (exclusive selection)
      this.floatingToolbar
        .querySelector("#toolbarBlurMode")
        ?.classList.toggle("active", this.isBlurMode);
      this.floatingToolbar
        .querySelector("#toolbarDrawMode")
        ?.classList.toggle("active", this.isDrawingMode);
      this.floatingToolbar
        .querySelector("#toolbarTextMode")
        ?.classList.toggle("active", this.isTextSelectionMode);
      this.floatingToolbar
        .querySelector("#toolbarEraserMode")
        ?.classList.toggle("active", this.isEraserMode);

      // Toggle blurs button is independent
      this.floatingToolbar
        .querySelector("#toolbarToggleBlurs")
        ?.classList.toggle("active", this.blursHidden);

      // Update the global disabled state
      this.updateDisabledState();
    }

    private updateDisabledState() {
      // Apply or remove the disabled class to hide/show all blurs
      if (this.isEnabled) {
        document.body.classList.remove("blur-anything-disabled");
        document.body.classList.add("blur-anything-enabled");
        this.restoreAllBlurs();
      } else {
        document.body.classList.add("blur-anything-disabled");
        document.body.classList.remove("blur-anything-enabled");
        this.hideAllBlurs();
      }

      // Update mode-specific classes
      document.body.classList.toggle(
        "blur-anything-eraser-mode",
        this.isEraserMode
      );
    }

    private hideAllBlurs() {
      // Hide all blurred elements by storing and removing their inline styles
      document.querySelectorAll(".blur-anything-blurred").forEach((element) => {
        const htmlElement = element as HTMLElement;
        if (htmlElement.style.filter) {
          // Store the original filter for restoration
          htmlElement.setAttribute(
            "data-original-filter",
            htmlElement.style.filter
          );
          htmlElement.style.filter = "";
        }
      });

      // Hide all blur areas by storing and removing their backdrop filters
      document.querySelectorAll(".blur-anything-area").forEach((area) => {
        const htmlArea = area as HTMLElement;
        if (
          htmlArea.style.backdropFilter ||
          htmlArea.style.getPropertyValue("-webkit-backdrop-filter")
        ) {
          // Store original backdrop filters
          if (htmlArea.style.backdropFilter) {
            htmlArea.setAttribute(
              "data-original-backdrop-filter",
              htmlArea.style.backdropFilter
            );
            htmlArea.style.backdropFilter = "";
          }
          if (htmlArea.style.getPropertyValue("-webkit-backdrop-filter")) {
            htmlArea.setAttribute(
              "data-original-webkit-backdrop-filter",
              htmlArea.style.getPropertyValue("-webkit-backdrop-filter")
            );
            htmlArea.style.setProperty("-webkit-backdrop-filter", "");
          }
          // Also hide background
          if (htmlArea.style.backgroundColor) {
            htmlArea.setAttribute(
              "data-original-background-color",
              htmlArea.style.backgroundColor
            );
            htmlArea.style.backgroundColor = "transparent";
          }
        }
      });

      // Hide all text blurs
      document.querySelectorAll(".blur-anything-text-blur").forEach((text) => {
        const htmlText = text as HTMLElement;
        if (htmlText.style.filter) {
          htmlText.setAttribute("data-original-filter", htmlText.style.filter);
          htmlText.style.filter = "";
        }
      });
    }

    private restoreAllBlurs() {
      // Restore all blurred elements
      document.querySelectorAll(".blur-anything-blurred").forEach((element) => {
        const htmlElement = element as HTMLElement;
        const originalFilter = htmlElement.getAttribute("data-original-filter");
        if (originalFilter) {
          htmlElement.style.filter = originalFilter;
          htmlElement.removeAttribute("data-original-filter");
        }
      });

      // Restore all blur areas
      document.querySelectorAll(".blur-anything-area").forEach((area) => {
        const htmlArea = area as HTMLElement;

        const originalBackdropFilter = htmlArea.getAttribute(
          "data-original-backdrop-filter"
        );
        if (originalBackdropFilter) {
          htmlArea.style.backdropFilter = originalBackdropFilter;
          htmlArea.removeAttribute("data-original-backdrop-filter");
        }

        const originalWebkitBackdropFilter = htmlArea.getAttribute(
          "data-original-webkit-backdrop-filter"
        );
        if (originalWebkitBackdropFilter) {
          htmlArea.style.setProperty(
            "-webkit-backdrop-filter",
            originalWebkitBackdropFilter
          );
          htmlArea.removeAttribute("data-original-webkit-backdrop-filter");
        }

        const originalBackgroundColor = htmlArea.getAttribute(
          "data-original-background-color"
        );
        if (originalBackgroundColor) {
          htmlArea.style.backgroundColor = originalBackgroundColor;
          htmlArea.removeAttribute("data-original-background-color");
        }
      });

      // Restore all text blurs
      document.querySelectorAll(".blur-anything-text-blur").forEach((text) => {
        const htmlText = text as HTMLElement;
        const originalFilter = htmlText.getAttribute("data-original-filter");
        if (originalFilter) {
          htmlText.style.filter = originalFilter;
          htmlText.removeAttribute("data-original-filter");
        }
      });
    }

    private setupTextSelectionMode() {
      // Add mouseup listener to catch text selections
      document.addEventListener("mouseup", this.handleTextSelection.bind(this));
      document.addEventListener(
        "touchend",
        this.handleTextSelection.bind(this)
      );
    }

    private cleanupTextSelectionMode() {
      // Remove text selection listeners
      document.removeEventListener(
        "mouseup",
        this.handleTextSelection.bind(this)
      );
      document.removeEventListener(
        "touchend",
        this.handleTextSelection.bind(this)
      );
    }

    private async handleTextSelection() {
      if (!this.isEnabled || !this.isTextSelectionMode) return;

      // Check freemium restrictions for text selection
      if (!freemiumService.checkFeatureAccess("text-selection")) {
        return;
      }

      // Check blur count limit
      if (!(await freemiumService.canAddBlur())) {
        freemiumService.showUpgradeNotification("daily-limit");
        return;
      }

      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;

      const selectedText = selection.toString().trim();

      // Validate text selection for stability
      if (selectedText.length === 0) {
        return;
      }
      if (selectedText.length < 1) {
        return;
      }

      // Check text selection length based on user tier
      const maxTextLength = freemiumService.getMaxTextSelectionLength();
      if (selectedText.length > maxTextLength) {
        // Show more helpful notification with current limits
        this.showToolbarNotification(
          `Text selection too long: ${selectedText.length} > ${maxTextLength} characters. Sign in for unlimited text selection.`,
          4000
        );

        // Clear selection
        selection.removeAllRanges();
        return;
      }

      // Check if selection contains non-text elements (images, icons, etc.)
      const range = selection.getRangeAt(0);
      const selectedContent = range.cloneContents();

      // Basic validation will be done later in canSafelyWrapSelection

      // Check for images, icons, or other non-text elements
      const hasImages =
        selectedContent.querySelectorAll(
          'img, svg, i[class*="icon"], span[class*="icon"], .icon'
        ).length > 0;
      const hasOnlyWhitespace = selectedText.replace(/\s/g, "").length === 0;

      if (hasImages) {
        selection.removeAllRanges();
        this.showToolbarNotification(
          "Cannot blur images or icons - select text only"
        );
        return;
      }

      if (hasOnlyWhitespace) {
        selection.removeAllRanges();
        return;
      }

      try {
        // Continue with the range we already have

        // Check if selection contains existing blur elements (prevent nested blurs)
        const container = range.commonAncestorContainer;
        if (container.nodeType === Node.ELEMENT_NODE) {
          const element = container as Element;
          if (
            element.closest(".blur-anything-text-blur") ||
            element.querySelector(".blur-anything-text-blur") ||
            element.closest("#blur-anything-floating-toolbar")
          ) {
            selection.removeAllRanges();
            return;
          }
        }

        // Create a span to wrap the selected text
        const span = document.createElement("span");
        span.className = "blur-anything-text-blur";
        span.style.filter = `blur(${this.blurIntensity}px)`;
        span.style.transition = "filter 0.3s ease";

        // Safe text-only approach that doesn't disrupt DOM structure

        try {
          // Check if we can safely wrap the selection
          const canSafelyWrap = this.canSafelyWrapSelection(range);

          if (!canSafelyWrap) {
            this.showToolbarNotification(
              "Complex selection - use element blur instead"
            );
            selection.removeAllRanges();
            return;
          }

          // Always use text-only approach for consistency and simplicity
          span.textContent = selectedText;

          // Replace the selected content with our text-only span
          range.deleteContents();
          range.insertNode(span);
        } catch (error) {
          console.error("Failed to create text blur:", error);
          this.showToolbarNotification("Failed to blur selected text");
          selection.removeAllRanges();
          return;
        }

        // Generate unique selector for the blurred text
        const selector = this.generateSelectorForTextBlur(span);

        // Save blur data
        const blurData: BlurData = {
          selector: selector,
          type: "text",
          text: selectedText,
          timestamp: Date.now(),
        };

        console.log("Element with selector:", document.querySelector(selector));

        this.blurredElements.push(blurData);

        // Increment blur count for freemium tracking
        await freemiumService.incrementDailyBlurCount();

        // Don't auto-save - let user decide when to persist

        // Clear selection
        selection.removeAllRanges();

        // Show feedback
        this.showToolbarNotification(
          `Blurred: "${selectedText.substring(0, 30)}${
            selectedText.length > 30 ? "..." : ""
          }"`
        );
      } catch (error) {
        console.error("Failed to blur selected text:", error);
        this.showToolbarNotification("Failed to blur selected text");
      }
    }

    private canSafelyWrapSelection(range: Range): boolean {
      try {
        // Check if selection is within a single text node or simple structure
        const startContainer = range.startContainer;
        const endContainer = range.endContainer;

        // Same container is always safe
        if (startContainer === endContainer) {
          return true;
        }

        // Check if both containers are text nodes with the same parent
        if (
          startContainer.nodeType === Node.TEXT_NODE &&
          endContainer.nodeType === Node.TEXT_NODE
        ) {
          const startParent = startContainer.parentElement;
          const endParent = endContainer.parentElement;

          // Same parent element is usually safe
          if (startParent === endParent) {
            return true;
          }

          // Check if parents are simple inline elements (span, em, strong, etc.)
          const safeInlineElements = [
            "SPAN",
            "EM",
            "STRONG",
            "B",
            "I",
            "U",
            "SMALL",
            "SUB",
            "SUP",
          ];
          const startIsSafeInline =
            startParent && safeInlineElements.includes(startParent.tagName);
          const endIsSafeInline =
            endParent && safeInlineElements.includes(endParent.tagName);

          if (startIsSafeInline && endIsSafeInline) {
            // Check if they share the same grandparent
            return startParent?.parentElement === endParent?.parentElement;
          }
        }

        // Check if the range would cross block-level elements
        const commonAncestor = range.commonAncestorContainer;
        if (commonAncestor.nodeType === Node.ELEMENT_NODE) {
          const element = commonAncestor as Element;
          const blockElements = [
            "DIV",
            "P",
            "H1",
            "H2",
            "H3",
            "H4",
            "H5",
            "H6",
            "LI",
            "TD",
            "TH",
            "SECTION",
            "ARTICLE",
          ];

          // If common ancestor is a block element, it might be safe
          if (blockElements.includes(element.tagName)) {
            // Check if the selection doesn't cross other block elements within
            const fragment = range.cloneContents();
            const hasNestedBlocks =
              fragment.querySelectorAll(blockElements.join(",")).length > 0;
            return !hasNestedBlocks;
          }
        }

        return false;
      } catch (error) {
        console.error(
          "Error checking if selection can be safely wrapped:",
          error
        );
        return false;
      }
    }

    private generateSelectorForTextBlur(element: HTMLElement): string {
      // Generate a unique selector for text blur spans
      const timestamp = Date.now();
      const randomId = Math.random().toString(36).substring(2, 8);
      const uniqueId = `blur-text-${timestamp}-${randomId}`;

      element.id = uniqueId;
      return `#${uniqueId}`;
    }

    private findAndBlurTextContent(
      textContent: string,
      blurIndex: number
    ): boolean {
      if (!textContent || textContent.trim().length < 2) {
        return false;
      }

      const searchText = textContent.trim();

      // Use TreeWalker to find text nodes
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            // Skip if node is inside our own blur elements or toolbar
            const parent = node.parentElement;
            if (
              parent &&
              (parent.classList.contains("blur-anything-text-blur") ||
                parent.id?.startsWith("blur-anything-") ||
                parent.closest("#blur-anything-floating-toolbar"))
            ) {
              return NodeFilter.FILTER_REJECT;
            }

            // Check if this text node contains our target text
            const nodeText = (node.textContent || "").trim();
            if (nodeText.includes(searchText)) {
              return NodeFilter.FILTER_ACCEPT;
            }
            return NodeFilter.FILTER_REJECT;
          },
        }
      );

      let textNode = walker.nextNode() as Text;
      while (textNode) {
        const nodeText = textNode.textContent || "";
        const textIndex = nodeText.indexOf(searchText);

        if (textIndex !== -1) {
          try {
            // Create a range for the found text
            const range = document.createRange();
            range.setStart(textNode, textIndex);
            range.setEnd(textNode, textIndex + searchText.length);

            // Create a span to wrap the text
            const span = document.createElement("span");
            span.className = "blur-anything-text-blur";
            span.style.filter = `blur(${this.blurIntensity}px)`;
            span.style.transition = "filter 0.3s ease";
            span.style.cursor = "pointer";

            // Generate new unique ID for this restoration
            const uniqueId = `blur-text-restored-${blurIndex}-${Date.now()}`;
            span.id = uniqueId;

            // Wrap the text
            range.surroundContents(span);

            return true;
          } catch (error) {
            console.error(`Failed to wrap text "${textContent}":`, error);
            // Continue searching for other instances
          }
        }

        textNode = walker.nextNode() as Text;
      }

      return false;
    }

    private removeBlurFromElement(element: HTMLElement) {
      console.log("Initial style:", element.getAttribute("style"));

      // Method 1: Remove filter property
      element.style.removeProperty("filter");

      // Method 2: Clear filter using setProperty (fallback)
      try {
        element.style.setProperty("filter", "");
        console.log("After setProperty('') - filter:", element.style.filter);
        console.log(
          "After setProperty('') - style:",
          element.getAttribute("style")
        );
      } catch (error) {}

      // Method 3: Remove filter from style attribute directly (comprehensive fallback)
      try {
        const currentStyle = element.getAttribute("style") || "";
        if (currentStyle.includes("filter")) {
          const cleanStyle = currentStyle
            .replace(/filter\s*:\s*[^;]*;?/gi, "")
            .replace(/;\s*;/g, ";")
            .replace(/^;+|;+$/g, "")
            .trim();

          if (cleanStyle) {
            element.setAttribute("style", cleanStyle);
          } else {
            element.removeAttribute("style");
          }
        }
      } catch (error) {}

      // Remove class and data attributes completely
      element.classList.remove("blur-anything-blurred");
      element.removeAttribute("data-blur-applied");
      element.removeAttribute("data-blur-id");

      // Remove any blur-related classes that might exist
      element.classList.remove("blur-anything-text-blur");

      // Force complete removal by setting inline styles with maximum specificity
      element.style.setProperty("filter", "none", "important");
      element.style.setProperty("backdrop-filter", "none", "important");
      element.style.setProperty("opacity", "1", "important");

      // Force a repaint
      element.offsetHeight;

      // Keep the override styles permanently to prevent any CSS from re-blurring
      // Don't remove them - this ensures the blur stays gone

      console.log("Final style:", element.getAttribute("style"));
    }

    private restoreTextBlurBySelector(
      selector: string,
      expectedText?: string
    ): boolean {
      try {
        // Try to find the element by its exact selector
        const element = document.querySelector(selector) as HTMLElement;

        if (!element) {
          return false;
        }

        // Verify it's not already a blur element
        if (element.classList.contains("blur-anything-text-blur")) {
          element.style.filter = `blur(${this.blurIntensity}px)`;
          element.style.transition = "filter 0.3s ease";
          element.style.cursor = "pointer";
          return true;
        }

        // If we have expected text, verify the content matches (optional validation)
        if (expectedText) {
          const elementText = element.textContent?.trim() || "";
          if (elementText !== expectedText.trim()) {
            // Still try to restore, but with a warning
          }
        }

        // Apply blur to the existing element
        element.classList.add("blur-anything-text-blur");
        element.style.filter = `blur(${this.blurIntensity}px)`;
        element.style.transition = "filter 0.3s ease";
        element.style.cursor = "pointer";

        return true;
      } catch (error) {
        console.error(
          `Failed to restore text blur by selector ${selector}:`,
          error
        );
        return false;
      }
    }

    private markBlurForCleanup(index: number) {
      if (!this.blursToCleanup.includes(index)) {
        this.blursToCleanup.push(index);
      }
    }

    private performBlurCleanup() {
      if (this.blursToCleanup.length === 0) return;

      // Sort in descending order to remove from highest index first
      // This prevents index shifting issues when removing multiple items
      const sortedIndices = this.blursToCleanup.sort((a, b) => b - a);

      let removedCount = 0;
      sortedIndices.forEach((index) => {
        if (index < this.blurredElements.length) {
          const removed = this.blurredElements.splice(index, 1);
          if (removed.length > 0) {
            removedCount++;
          }
        }
      });

      // Clear the cleanup list
      this.blursToCleanup = [];

      if (removedCount > 0) {
        // Save the cleaned data
        this.saveBlurData().catch((error) => {
          // Error handled
        });
      }
    }
  }

  // Initialize the extension when the page loads
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => new BlurAnything());
  } else {
    new BlurAnything();
  }

  // Listen for authentication state changes from popup/options
  browser.runtime.onMessage.addListener((message: any) => {
    if (message.type === "AUTH_STATE_CHANGED") {
      // Update the extension auth service with the new user state
      if (message.user) {
        authService.setCurrentUser(message.user);
      } else {
        authService.setCurrentUser(null);
      }

      // Force refresh freemium service state
      freemiumService.updateAuthState(message.user);

      return true; // Keep message channel open for async response
    }
  });
} // End of extension context check

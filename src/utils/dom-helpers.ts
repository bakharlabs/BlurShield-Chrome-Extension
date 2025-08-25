// Safe DOM manipulation utilities to prevent XSS attacks

/**
 * Safely create an element with text content (prevents XSS)
 */
export function createSafeElement(
  tagName: string,
  textContent?: string,
  className?: string
): HTMLElement {
  const element = document.createElement(tagName);
  if (textContent) {
    element.textContent = textContent; // Safe - automatically escapes
  }
  if (className) {
    element.className = className;
  }
  return element;
}

/**
 * Safely set text content (prevents XSS)
 */
export function setSafeText(element: HTMLElement, text: string): void {
  element.textContent = text;
}

/**
 * Safely create SVG icons using template strings
 */
export function createSafeIcon(
  iconPath: string,
  size: number = 20
): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size.toString());
  svg.setAttribute("height", size.toString());
  svg.setAttribute("fill", "currentColor");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", iconPath);
  svg.appendChild(path);

  return svg;
}

/**
 * Safely add styles to an element
 */
export function setSafeStyles(
  element: HTMLElement,
  styles: Record<string, string>
): void {
  Object.entries(styles).forEach(([property, value]) => {
    // Validate CSS property names to prevent injection
    if (/^[a-zA-Z-]+$/.test(property)) {
      element.style.setProperty(property, value);
    }
  });
}

/**
 * Validate and sanitize CSS selectors
 */
export function sanitizeSelector(selector: string): string {
  // Remove potentially dangerous characters, keep only valid CSS selector characters
  return selector.replace(/[^\w\-\.#\[\]=":>\s]/g, "");
}

/**
 * Safe way to create notification elements
 */
export function createSafeNotification(config: {
  title: string;
  message: string;
  type: "info" | "warning" | "error" | "success";
  iconPath?: string;
}): HTMLElement {
  const notification = createSafeElement("div", "", "blur-shield-notification");

  const header = createSafeElement("div", "", "notification-header");

  if (config.iconPath) {
    const icon = createSafeIcon(config.iconPath, 20);
    icon.setAttribute("class", "notification-icon");
    header.appendChild(icon);
  }

  const title = createSafeElement("span", config.title, "notification-title");
  header.appendChild(title);

  const message = createSafeElement(
    "div",
    config.message,
    "notification-message"
  );

  notification.appendChild(header);
  notification.appendChild(message);

  // Add type-specific class
  notification.classList.add(`notification-${config.type}`);

  return notification;
}

// Centralized error handling and logging

export class BlurShieldError extends Error {
  constructor(
    message: string,
    public code: string,
    public context?: Record<string, any>
  ) {
    super(message);
    this.name = "BlurShieldError";
  }
}

export enum ErrorCodes {
  AUTHENTICATION_FAILED = "AUTH_001",
  STORAGE_ERROR = "STORAGE_001",
  DOM_MANIPULATION_ERROR = "DOM_001",
  NETWORK_ERROR = "NETWORK_001",
  PERMISSION_DENIED = "PERM_001",
  INVALID_INPUT = "INPUT_001",
  CONFIGURATION_ERROR = "CONFIG_001",
}

class ErrorHandler {
  private isDevelopment = false;

  constructor() {
    // Check if in development mode (extension context doesn't have process.env)
    this.isDevelopment = false; // Set to true manually during development
  }

  /**
   * Handle and log errors safely
   */
  handle(error: Error | BlurShieldError, context?: Record<string, any>): void {
    const errorData = {
      message: error.message,
      name: error.name,
      stack: this.isDevelopment ? error.stack : undefined,
      context,
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent,
      url: window.location?.href,
    };

    // Log to console in development
    if (this.isDevelopment) {
      console.error("BlurShield Error:", errorData);
    }

    // Send to monitoring service in production (if implemented)
    if (!this.isDevelopment) {
      this.reportError(errorData);
    }
  }

  /**
   * Report errors to monitoring service
   */
  private reportError(errorData: any): void {
    // In production, you would send this to your error monitoring service
    // For now, we'll just store it locally for debugging
    try {
      const errors = JSON.parse(
        localStorage.getItem("blurshield_errors") || "[]"
      );
      errors.push(errorData);

      // Keep only last 10 errors to prevent storage bloat
      if (errors.length > 10) {
        errors.splice(0, errors.length - 10);
      }

      localStorage.setItem("blurshield_errors", JSON.stringify(errors));
    } catch (e) {
      // If we can't even log the error, fail silently
    }
  }

  /**
   * Create user-friendly error messages
   */
  getUserMessage(error: Error | BlurShieldError): string {
    if (error instanceof BlurShieldError) {
      switch (error.code) {
        case ErrorCodes.AUTHENTICATION_FAILED:
          return "Sign-in failed. Please try again or check your internet connection.";
        case ErrorCodes.STORAGE_ERROR:
          return "Unable to save your settings. Please try again.";
        case ErrorCodes.PERMISSION_DENIED:
          return "Permission denied. Please check your browser settings.";
        case ErrorCodes.NETWORK_ERROR:
          return "Network error. Please check your internet connection.";
        default:
          return "An unexpected error occurred. Please try again.";
      }
    }

    return "An unexpected error occurred. Please try again.";
  }

  /**
   * Safely execute async operations with error handling
   */
  async safeExecute<T>(
    operation: () => Promise<T>,
    fallback?: T,
    context?: Record<string, any>
  ): Promise<T | undefined> {
    try {
      return await operation();
    } catch (error) {
      this.handle(error as Error, context);
      return fallback;
    }
  }

  /**
   * Safely execute sync operations with error handling
   */
  safeSyncExecute<T>(
    operation: () => T,
    fallback?: T,
    context?: Record<string, any>
  ): T | undefined {
    try {
      return operation();
    } catch (error) {
      this.handle(error as Error, context);
      return fallback;
    }
  }
}

export const errorHandler = new ErrorHandler();

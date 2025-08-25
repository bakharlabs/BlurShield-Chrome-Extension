# Blur Anything - Chrome Extension

A one-click privacy tool that allows users to blur any content on web pages for privacy or focus purposes.

## Features

- **One-Click Blur**: Instantly blur paragraphs, headings, images, or videos by clicking on them
- **Custom Blur Areas**: Draw rectangles anywhere on the page to blur specific areas
- **Persistent Blur**: Save blur settings so they persist after page reloads or revisits
- **Text Selection Blur**: Blur selected text with right-click context menu
- **Customizable Settings**: Adjust blur intensity and clear all blurs

## Development Setup

### Prerequisites

- Node.js (v18 or higher)
- npm or yarn

### Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd blur-anything
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start development mode:
   ```bash
   npm run dev
   ```

4. Build for production:
   ```bash
   npm run build
   ```

### Loading the Extension

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" in the top right
3. Click "Load unpacked" and select the `dist` folder

## Project Structure

```
src/
├── manifest.json          # Extension manifest
├── background/
│   └── background.ts      # Service worker
├── content/
│   ├── content.ts         # Content script
│   └── content.css        # Content styles
├── popup/
│   ├── popup.html         # Extension popup
│   ├── popup.css          # Popup styles
│   └── popup.ts           # Popup logic
├── options/
│   ├── options.html       # Options page
│   ├── options.css        # Options styles
│   └── options.ts         # Options logic
└── icons/                 # Extension icons
```

## Usage

### Basic Blurring
- Click on any element on a webpage to blur it
- Click on a blurred element to remove the blur
- Hover over elements to see a preview indicator

### Custom Blur Areas
- Press `Ctrl+Shift+B` to enter draw mode
- Click and drag to create custom blur areas
- Press `Escape` to exit draw mode

### Text Selection
- Select text and right-click to blur via context menu

### Settings
- Click the extension icon to access quick controls
- Right-click the extension icon and select "Options" for detailed settings

## Keyboard Shortcuts

- `Ctrl+Shift+B`: Toggle draw mode for custom blur areas
- `Escape`: Exit draw mode

## Technology Stack

- **TypeScript**: Type-safe JavaScript
- **Vite**: Fast build tool and dev server
- **Manifest V3**: Latest Chrome extension format
- **Web Extensions API**: Cross-browser compatibility

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - see LICENSE file for details

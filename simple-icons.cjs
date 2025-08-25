// Simple icon creator using CommonJS
const fs = require('fs');

// Create a simple SVG icon and convert to different sizes
function createIconSVG(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="g1" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#4A90E2"/>
      <stop offset="100%" style="stop-color:#2E5BBA"/>
    </linearGradient>
    <linearGradient id="g2" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#6BB6FF"/>
      <stop offset="100%" style="stop-color:#4A90E2"/>
    </linearGradient>
  </defs>
  <path d="M64 10C64 10 20 25 20 65C20 95 64 118 64 118C64 118 108 95 108 65C108 25 64 10 64 10Z" fill="url(#g1)"/>
  <rect x="32" y="35" width="64" height="50" rx="8" fill="url(#g2)" opacity="0.9"/>
  <ellipse cx="64" cy="60" rx="20" ry="10" fill="white" opacity="0.95"/>
  <circle cx="64" cy="60" r="7" fill="#4A90E2"/>
  <circle cx="60" cy="56" r="3" fill="white" opacity="0.6"/>
</svg>`;
}

// Create icons directory
if (!fs.existsSync('icons')) {
  fs.mkdirSync('icons');
}

// Create SVG files for different sizes
const sizes = [16, 32, 48, 128];
sizes.forEach(size => {
  const svg = createIconSVG(size);
  fs.writeFileSync(`icons/icon-${size}.svg`, svg);
  console.log(`Created icon-${size}.svg`);
});

console.log('SVG icons created! You can convert these to PNG using online tools or image editors.');

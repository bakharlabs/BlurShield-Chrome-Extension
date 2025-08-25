const fs = require('fs');
const { createCanvas } = require('canvas');

function createShieldIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  
  // Clear canvas
  ctx.clearRect(0, 0, size, size);
  
  // Scale factor
  const scale = size / 128;
  
  // Shield gradient
  const shieldGradient = ctx.createLinearGradient(0, 0, size, size);
  shieldGradient.addColorStop(0, '#4A90E2');
  shieldGradient.addColorStop(1, '#2E5BBA');
  
  // Draw shield shape
  ctx.fillStyle = shieldGradient;
  ctx.beginPath();
  ctx.moveTo(size * 0.5, size * 0.08);
  ctx.bezierCurveTo(size * 0.15, size * 0.2, size * 0.15, size * 0.35, size * 0.15, size * 0.5);
  ctx.bezierCurveTo(size * 0.15, size * 0.75, size * 0.5, size * 0.92, size * 0.5, size * 0.92);
  ctx.bezierCurveTo(size * 0.5, size * 0.92, size * 0.85, size * 0.75, size * 0.85, size * 0.5);
  ctx.bezierCurveTo(size * 0.85, size * 0.35, size * 0.85, size * 0.2, size * 0.5, size * 0.08);
  ctx.closePath();
  ctx.fill();
  
  // Inner rectangle
  const centerGradient = ctx.createLinearGradient(size * 0.25, size * 0.27, size * 0.75, size * 0.67);
  centerGradient.addColorStop(0, '#6BB6FF');
  centerGradient.addColorStop(1, '#4A90E2');
  
  ctx.fillStyle = centerGradient;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.roundRect(size * 0.25, size * 0.27, size * 0.5, size * 0.4, size * 0.06);
  ctx.fill();
  ctx.globalAlpha = 1;
  
  // Eye
  ctx.fillStyle = 'white';
  ctx.globalAlpha = 0.95;
  ctx.beginPath();
  ctx.ellipse(size * 0.5, size * 0.47, size * 0.16, size * 0.08, 0, 0, 2 * Math.PI);
  ctx.fill();
  ctx.globalAlpha = 1;
  
  // Eye center
  ctx.fillStyle = '#4A90E2';
  ctx.beginPath();
  ctx.ellipse(size * 0.5, size * 0.47, size * 0.055, size * 0.055, 0, 0, 2 * Math.PI);
  ctx.fill();
  
  // Eye reflection
  ctx.fillStyle = 'white';
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  ctx.ellipse(size * 0.47, size * 0.44, size * 0.024, size * 0.024, 0, 0, 2 * Math.PI);
  ctx.fill();
  ctx.globalAlpha = 1;
  
  return canvas;
}

// Create icons
const sizes = [16, 32, 48, 128];

sizes.forEach(size => {
  const canvas = createShieldIcon(size);
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(`icons/icon-${size}.png`, buffer);
  console.log(`Created icon-${size}.png`);
});

console.log('All icons created successfully!');

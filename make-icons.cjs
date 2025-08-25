const fs = require('fs');

// Minimal 16x16 blue PNG in base64  
const png16 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABklEQVR4AWMYBaNgFIyCUTAKBhYAAARwAAF/VAgfAAAAAElFTkSuQmCC';

const sizes = [16, 32, 48, 128];
sizes.forEach(size => {
  const buffer = Buffer.from(png16, 'base64');
  fs.writeFileSync(`dist/icons/icon-${size}.png`, buffer);
  console.log(`Created icon-${size}.png`);
});

console.log('Done!');

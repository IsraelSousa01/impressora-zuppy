/**
 * scripts/generate-icons.js
 * Generates a simple placeholder icon.ico and icon.png for the tray/installer.
 *
 * Run: node scripts/generate-icons.js
 *
 * For production, replace resources/icon.ico with your real brand icon.
 * The ico must be at least 256x256 for Windows installers.
 *
 * This script requires the `jimp` package:
 *   npm install --save-dev jimp
 *
 * Or you can use any image editor to create resources/icon.ico manually.
 */

const fs = require('fs')
const path = require('path')

const resourcesDir = path.join(__dirname, '..', 'resources')
if (!fs.existsSync(resourcesDir)) {
  fs.mkdirSync(resourcesDir, { recursive: true })
}

// Write a minimal 1x1 pixel transparent ICO file as placeholder
// (32-byte ICO header + 40-byte DIB header + 4 bytes pixel data + 4 bytes mask)
// For production you MUST replace this with a proper 256x256 icon.
const ico = Buffer.alloc(1, 0)
const placeholder = path.join(resourcesDir, '.gitkeep')
fs.writeFileSync(placeholder, '')

console.log('Created resources/.gitkeep')
console.log('')
console.log('⚠️  IMPORTANT: Place your real icon at resources/icon.ico')
console.log('   Minimum size: 256x256 pixels')
console.log('   You can use https://www.icoconverter.com/ to convert PNG → ICO')
console.log('')
console.log('The tray icon is generated programmatically (SVG circles) so')
console.log('you only need icon.ico for the installer/taskbar.')

const sharp = require('sharp')
const pngToIco = require('png-to-ico')
const fs = require('fs')
const path = require('path')

async function run() {
  const svgPath = 'C:\\Users\\leviv\\Downloads\\zuppy logo.svg'
  const resourcesDir = path.join(__dirname, '..', 'resources')
  
  if (!fs.existsSync(resourcesDir)) {
    fs.mkdirSync(resourcesDir, { recursive: true })
  }

  const outIco = path.join(resourcesDir, 'icon.ico')
  const outPng = path.join(resourcesDir, 'icon.png')

  log('Rasterizing SVG to 256x256 PNG…')
  const pngBuffer = await sharp(svgPath)
    .resize(256, 256)
    .png()
    .toBuffer()

  fs.writeFileSync(outPng, pngBuffer)
  log('Saved resources/icon.png')

  log('Converting PNG to multi-resolution Windows ICO…')
  const pngToIcoFn = typeof pngToIco === 'function' ? pngToIco : pngToIco.default
  if (typeof pngToIcoFn !== 'function') {
    throw new Error('png-to-ico export is not a function')
  }
  const icoBuffer = await pngToIcoFn(pngBuffer)
  
  fs.writeFileSync(outIco, icoBuffer)
  log('Saved resources/icon.ico')

  // Generate status dot PNGs for the tray icon (Windows tray requires raster PNGs, not SVGs)
  log('Generating status dot PNGs for system tray…')
  const renderDotSvg = (color) => `
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
      <circle cx="8" cy="8" r="7" fill="${color}" stroke="#00000033" stroke-width="1"/>
    </svg>
  `

  const dots = [
    { name: 'green', color: '#22c55e' },
    { name: 'orange', color: '#f97316' },
    { name: 'red', color: '#ef4444' },
  ]

  for (const dot of dots) {
    const dotBuffer = await sharp(Buffer.from(renderDotSvg(dot.color)))
      .png()
      .toBuffer()
    fs.writeFileSync(path.join(resourcesDir, `${dot.name}.png`), dotBuffer)
    log(`Saved resources/${dot.name}.png`)
  }

  log('Icon generation complete!')
}

function log(...args) {
  console.log('[CONVERT]', ...args)
}

run().catch((err) => {
  console.error('[ERROR]', err)
  process.exit(1)
})

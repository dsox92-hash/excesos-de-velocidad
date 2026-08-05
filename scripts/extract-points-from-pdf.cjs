const fs = require('fs')
const path = require('path')
const { PDFParse } = require('pdf-parse')

function dmToDecimal(deg, min, negative) {
  const value = Number(deg) + Number(min) / 60
  return negative ? -value : value
}

function normalizeSpaces(text) {
  return String(text).replace(/\s+/g, ' ').trim()
}

async function main() {
  const pdfPath = path.resolve(__dirname, '..', '..', 'puntos de control.pdf')
  const outputPath = path.resolve(__dirname, '..', 'public', 'data', 'puntos_control.json')

  const parser = new PDFParse({ url: pdfPath })
  const result = await parser.getText()
  await parser.destroy()

  const text = result.text

  const regex = /(\d{3}\s+[A-ZÁÉÍÓÚÜÑ]+)\s+(.+?)\s+(\d+)\s+([A-Z0-9]+)\s+(LS|PA)\s+SI\s+(\d+)º(\d+\.\d+)'\s+(\d+)º(\d+\.\d+)'/g

  const rows = []

  for (const match of text.matchAll(regex)) {
    rows.push({
      ruta: normalizeSpaces(match[1]),
      descripcion: normalizeSpaces(match[2]),
      radiofaro: Number(match[3]),
      alias: normalizeSpaces(match[4]),
      tipo: normalizeSpaces(match[5]),
      latDM: `${match[6]}º${match[7]}'`,
      lonDM: `${match[8]}º${match[9]}'`,
      lat: dmToDecimal(match[6], match[7], false),
      lon: dmToDecimal(match[8], match[9], true),
    })
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, JSON.stringify(rows, null, 2), 'utf8')

  console.log('Puntos parseados:', rows.length)
  console.log('Guardado en:', outputPath)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

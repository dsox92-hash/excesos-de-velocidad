const center = { lat: 6.26835, lon: -75.596866 }
const origin = { lat: 6.275283, lon: -75.603033 }
const dest = { lat: 6.264783, lon: -75.587633 }
const loc = { lat: 6.26835, lon: -75.596866 }

const markers = [
  `${origin.lat},${origin.lon},lightblue1`,
  `${dest.lat},${dest.lon},ol-marker`,
  `${loc.lat},${loc.lon},red-pushpin`,
].join('|')

const params = new URLSearchParams({
  center: `${center.lat},${center.lon}`,
  zoom: '15',
  size: '1100x520',
  maptype: 'mapnik',
  markers,
})

const url = `https://staticmap.openstreetmap.de/staticmap.php?${params.toString()}`

console.log('URL:', url)

fetch(url)
  .then(async (response) => {
    console.log('Status:', response.status, response.statusText)
    console.log('Content-Type:', response.headers.get('content-type'))
    const bytes = (await response.arrayBuffer()).byteLength
    console.log('Bytes:', bytes)
  })
  .catch((error) => {
    console.error('Fetch error:', error)
    process.exit(1)
  })

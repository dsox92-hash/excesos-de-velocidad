import { useEffect, useMemo, useState } from 'react'
import { CircleMarker, MapContainer, Polyline, Popup, TileLayer, useMap } from 'react-leaflet'
import * as XLSX from 'xlsx'
import './App.css'

const SPEED_LIMIT = 66
const DEFAULT_CENTER = [6.244203, -75.581211]
const DEFAULT_ZOOM = 12
const DEFAULT_DATASET = '/data/BEA_DATOSEXPORTADOS.xls'
const DEFAULT_POINTS_CATALOG = '/data/puntos_control.json'
const TRAMO_LOCATION_CORRECTIONS = {
  'PEATONAL - RELOJ': 'RELOJ - IGUANA',
}

function toNumber(value) {
  if (typeof value === 'number') {
    return value
  }

  if (typeof value !== 'string') {
    return Number.NaN
  }

  const normalized = value.replace(',', '.').trim()
  return Number(normalized)
}

function normalizePlace(value) {
  if (!value || typeof value !== 'string') {
    return ''
  }

  return value
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function midpoint(a, b) {
  if (!a || !b) {
    return null
  }

  return {
    lat: (a.lat + b.lat) / 2,
    lon: (a.lon + b.lon) / 2,
  }
}

function buildSegmentKey(a, b) {
  if (!a || !b) {
    return ''
  }

  const tokenA = `${a.lat.toFixed(6)},${a.lon.toFixed(6)}`
  const tokenB = `${b.lat.toFixed(6)},${b.lon.toFixed(6)}`
  return [tokenA, tokenB].sort().join('|')
}

function midpointFromRouteGeometry(geometry) {
  if (!Array.isArray(geometry) || geometry.length < 2) {
    return null
  }

  let total = 0

  for (let i = 1; i < geometry.length; i += 1) {
    const [lonA, latA] = geometry[i - 1]
    const [lonB, latB] = geometry[i]
    total += Math.hypot(latB - latA, lonB - lonA)
  }

  if (total === 0) {
    return null
  }

  const target = total / 2
  let covered = 0

  for (let i = 1; i < geometry.length; i += 1) {
    const [lonA, latA] = geometry[i - 1]
    const [lonB, latB] = geometry[i]
    const segment = Math.hypot(latB - latA, lonB - lonA)

    if (covered + segment >= target) {
      const ratio = (target - covered) / segment
      const lat = latA + (latB - latA) * ratio
      const lon = lonA + (lonB - lonA) * ratio

      return { lat, lon }
    }

    covered += segment
  }

  const [lon, lat] = geometry[geometry.length - 1]
  return { lat, lon }
}

async function fetchRoadMidpoint(originPoint, destinationPoint) {
  const url =
    `https://router.project-osrm.org/route/v1/driving/${originPoint.lon},${originPoint.lat};` +
    `${destinationPoint.lon},${destinationPoint.lat}?overview=full&geometries=geojson`

  const response = await fetch(url)

  if (!response.ok) {
    throw new Error('No se pudo consultar la ruta vial para el tramo.')
  }

  const payload = await response.json()
  const route = payload?.routes?.[0]

  if (!route?.geometry?.coordinates) {
    return null
  }

  const point = midpointFromRouteGeometry(route.geometry.coordinates)

  if (!point) {
    return null
  }

  return {
    point,
    geometry: route.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
    source: 'osrm_road_route',
  }
}

function splitTramo(tramo) {
  if (!tramo || typeof tramo !== 'string') {
    return { from: '', to: '' }
  }

  const parts = tramo
    .split('-')
    .map((part) => normalizePlace(part))
    .filter(Boolean)

  if (parts.length < 2) {
    return { from: '', to: '' }
  }

  return { from: parts[0], to: parts[parts.length - 1] }
}

function normalizeTramoLabel(tramo) {
  const endpoints = splitTramo(tramo)

  if (!endpoints.from || !endpoints.to) {
    return normalizePlace(tramo)
  }

  return `${endpoints.from} - ${endpoints.to}`
}

function getCorrectedTramoForLocation(tramo) {
  const normalized = normalizeTramoLabel(tramo)
  const corrected = TRAMO_LOCATION_CORRECTIONS[normalized] || normalized

  return {
    reportedTramo: normalized,
    tramoForLocation: corrected,
    tramoWasCorrected: normalized !== corrected,
  }
}

function buildNameCandidates(primary, fallback) {
  const values = [normalizePlace(primary), normalizePlace(fallback)].filter(Boolean)
  return Array.from(new Set(values))
}

function scoreNameMatch(name, description) {
  const a = normalizePlace(name)
  const b = normalizePlace(description)

  if (!a || !b) {
    return -1
  }

  if (a === b) {
    return 100
  }

  if (b.includes(a) || a.includes(b)) {
    return 75
  }

  const tokensA = a.split(' ').filter(Boolean)
  const tokensB = new Set(b.split(' ').filter(Boolean))
  const overlap = tokensA.filter((token) => tokensB.has(token)).length

  if (overlap === 0) {
    return -1
  }

  return overlap * 10
}

function indexPoints(points) {
  const index = {}

  for (const point of points) {
    const key = normalizePlace(point.descripcion)

    if (!key) {
      continue
    }

    if (!index[key]) {
      index[key] = []
    }

    index[key].push(point)
  }

  return index
}

function resolvePoint(pointIndex, allPoints, names, route) {
  const routeKey = normalizePlace(route)

  for (const name of names) {
    const key = normalizePlace(name)
    const candidates = pointIndex[key] || []

    if (candidates.length === 0) {
      continue
    }

    if (routeKey) {
      const exactByRoute = candidates.find(
        (candidate) => normalizePlace(candidate.ruta) === routeKey,
      )

      if (exactByRoute) {
        return {
          point: exactByRoute,
          matchedBy: 'exacto en catalogo (descripcion + ruta)',
          usedName: key,
        }
      }
    }

    return {
      point: candidates[0],
      matchedBy: 'exacto en catalogo (descripcion)',
      usedName: key,
    }
  }

  let best = null
  let bestScore = -1

  for (const name of names) {
    for (const point of allPoints) {
      const score = scoreNameMatch(name, point.descripcion)
      const sameRoute = routeKey && normalizePlace(point.ruta) === routeKey
      const boosted = score + (sameRoute ? 15 : 0)

      if (boosted > bestScore) {
        bestScore = boosted
        best = { point, usedName: normalizePlace(name), sameRoute }
      }
    }
  }

  if (!best || bestScore < 10) {
    return null
  }

  return {
    point: best.point,
    matchedBy: best.sameRoute
      ? 'aproximado por tramo (coincidencia de texto + ruta)'
      : 'aproximado por tramo (coincidencia de texto)',
    usedName: best.usedName,
  }
}

function buildExcessPoint(originPoint, destinationPoint) {
  if (!originPoint || !destinationPoint) {
    return null
  }

  // Sin telemetria de GPS por segundo, el punto del exceso se ubica en el tramo
  // como punto medio entre origen y destino de control.
  return midpoint(originPoint, destinationPoint)
}

function resolveTramoLocation(record, pointIndex, allPoints) {
  const tramoMeta = getCorrectedTramoForLocation(record.tramo)
  const tramoEndpoints = splitTramo(tramoMeta.tramoForLocation)
  const reportedEndpoints = splitTramo(tramoMeta.reportedTramo)
  const originCandidates = [
    ...buildNameCandidates(tramoEndpoints.from, reportedEndpoints.from),
    ...buildNameCandidates(record.origen, ''),
  ]
  const destinationCandidates = [
    ...buildNameCandidates(tramoEndpoints.to, reportedEndpoints.to),
    ...buildNameCandidates(record.destino, ''),
  ]

  const originResult = resolvePoint(pointIndex, allPoints, originCandidates, record.ruta)
  const destinationResult = resolvePoint(
    pointIndex,
    allPoints,
    destinationCandidates,
    record.ruta,
  )

  const originPoint = originResult?.point || null
  const destinationPoint = destinationResult?.point || null
  const excessPoint = buildExcessPoint(originPoint, destinationPoint)

  let locationConfidence = 'sin coordenadas del catalogo'

  if (originPoint && destinationPoint) {
    locationConfidence = 'tramo resuelto por coordenadas de origen/destino del catalogo PDF'
  } else if (originPoint || destinationPoint) {
    locationConfidence = 'parcial: solo un extremo del tramo pudo ser resuelto'
  }

  return {
    originPoint,
    destinationPoint,
    excessPoint,
    originMatchedBy: originResult?.matchedBy || 'sin match',
    destinationMatchedBy: destinationResult?.matchedBy || 'sin match',
    originUsedName: originResult?.usedName || '',
    destinationUsedName: destinationResult?.usedName || '',
    tramoFrom: tramoEndpoints.from,
    tramoTo: tramoEndpoints.to,
    reportedTramo: tramoMeta.reportedTramo,
    tramoForLocation: tramoMeta.tramoForLocation,
    tramoWasCorrected: tramoMeta.tramoWasCorrected,
    locationSource: 'tramo -> puntos de control PDF',
    locationConfidence,
  }
}

function buildAnalysis(workbook) {
  const tramosSheet = workbook.Sheets.Tramos
  const marcasSheet = workbook.Sheets.Marcas
  const turnosSheet = workbook.Sheets.Turnos

  if (!tramosSheet) {
    throw new Error('No se encontro la hoja Tramos en el archivo.')
  }

  const tramos = XLSX.utils.sheet_to_json(tramosSheet, { defval: '' })
  const marcas = marcasSheet
    ? XLSX.utils.sheet_to_json(marcasSheet, { defval: '' })
    : []
  const turnos = turnosSheet
    ? XLSX.utils.sheet_to_json(turnosSheet, { defval: '' })
    : []

  const marcasById = new Map(
    marcas.map((marca) => [String(marca.AMR_IDMARCA), marca]),
  )
  const turnosById = new Map(
    turnos.map((turno) => [String(turno.VTR_IDTURNO), turno]),
  )

  const records = tramos
    .map((row) => {
      const speed = toNumber(row.ATM_VELMAX)
      const marca = marcasById.get(String(row.ATM_IDMARCA))
      const turno = marca
        ? turnosById.get(String(marca.AMR_IDTURNO))
        : undefined

      return {
        idMarca: row.ATM_IDMARCA,
        tramo: row.VTR_DESCRIPCION || '',
        origen: row.VTR_DESCRIPCIONPCO || '',
        destino: row.VTR_DESCRIPCIONPCD || '',
        horaProgramada: row.ATM_HORAPROG || '',
        horaBEA: row.ATM_HORABEA || '',
        velocidad: speed,
        fechaHoraVelocidad: row.ATM_FHVELMAX || '',
        exceso: speed - SPEED_LIMIT,
        idTurno: marca?.AMR_IDTURNO || '',
        ruta: turno?.VTR_RUTADESCRIP || '',
        conductor: turno?.VTR_NOMBRE || '',
        movil: turno?.VTR_NUMECON || '',
        row,
      }
    })
    .filter((record) => Number.isFinite(record.velocidad))

  const excessive = records
    .filter((record) => record.velocidad > SPEED_LIMIT)
    .sort((a, b) => b.velocidad - a.velocidad)

  const maxSpeed = records.reduce(
    (acc, current) => (current.velocidad > acc ? current.velocidad : acc),
    0,
  )

  return {
    records,
    excessive,
    summary: {
      totalRecords: records.length,
      excessCount: excessive.length,
      percentExcess:
        records.length > 0 ? (excessive.length / records.length) * 100 : 0,
      maxSpeed,
    },
  }
}

function parseWorkbookFromArrayBuffer(buffer) {
  const workbook = XLSX.read(buffer, { type: 'array' })
  return buildAnalysis(workbook)
}

function buildCsv(records) {
  const header = [
    'id_marca',
    'tramo',
    'origen',
    'destino',
    'velocidad_kmh',
    'limite_kmh',
    'exceso_kmh',
    'fecha_hora_velocidad',
    'ruta',
    'conductor',
    'movil',
    'origen_lat',
    'origen_lon',
    'destino_lat',
    'destino_lon',
    'lat',
    'lon',
    'fuente_ubicacion',
    'confianza_ubicacion',
  ]

  const lines = records.map((record) => {
    const row = [
      record.idMarca,
      record.tramo,
      record.origen,
      record.destino,
      record.velocidad,
      SPEED_LIMIT,
      record.exceso,
      record.fechaHoraVelocidad,
      record.ruta,
      record.conductor,
      record.movil,
      record.originPoint?.lat ?? '',
      record.originPoint?.lon ?? '',
      record.destinationPoint?.lat ?? '',
      record.destinationPoint?.lon ?? '',
      record.location?.lat ?? '',
      record.location?.lon ?? '',
      record.locationSource,
      record.locationConfidence,
    ]

    return row
      .map((value) => `"${String(value).replace(/"/g, '""')}"`)
      .join(',')
  })

  return [header.join(','), ...lines].join('\n')
}

function markerColorBySpeed(speed) {
  if (speed >= 90) {
    return '#7f1d1d'
  }

  if (speed >= 80) {
    return '#b45309'
  }

  return '#0f766e'
}

function createRecordUid(record) {
  return `${record.idMarca}-${record.fechaHoraVelocidad}-${record.tramo}`
}

function buildStaticMapUrl(record) {
  const center = record.location || DEFAULT_CENTER
  const centerLat = center.lat ?? center[0]
  const centerLon = center.lon ?? center[1]
  const points = []
  const bboxPoints = []

  if (record.originPoint) {
    bboxPoints.push({ lat: record.originPoint.lat, lon: record.originPoint.lon })
  }

  if (record.destinationPoint) {
    bboxPoints.push({ lat: record.destinationPoint.lat, lon: record.destinationPoint.lon })
  }

  if (record.location) {
    points.push(`${record.location.lon},${record.location.lat},pm2rdm`)
    bboxPoints.push({ lat: record.location.lat, lon: record.location.lon })
  }

  let spnLon = 0.008
  let spnLat = 0.006

  if (bboxPoints.length >= 2) {
    const lats = bboxPoints.map((point) => point.lat)
    const lons = bboxPoints.map((point) => point.lon)
    const latMin = Math.min(...lats)
    const latMax = Math.max(...lats)
    const lonMin = Math.min(...lons)
    const lonMax = Math.max(...lons)

    // Padding extra para que la evidencia muestre contexto vial y no un recorte excesivo.
    spnLat = Math.max((latMax - latMin) * 2.8, 0.006)
    spnLon = Math.max((lonMax - lonMin) * 2.8, 0.008)
  }

  const markerParam = points.join('~')
  const params = new URLSearchParams({
    ll: `${centerLon},${centerLat}`,
    zoom: '13',
    spn: `${spnLon.toFixed(6)},${spnLat.toFixed(6)}`,
    size: '650,450',
    l: 'map',
    lang: 'es_ES',
  })

  if (markerParam) {
    params.set('pt', markerParam)
  }

  return `https://static-maps.yandex.ru/1.x/?${params.toString()}`
}

function waitForImagesInDocument(doc, timeoutMs = 7000) {
  const images = Array.from(doc.images || [])

  if (images.length === 0) {
    return Promise.resolve()
  }

  const waiters = images.map((img) => {
    if (img.complete) {
      return Promise.resolve()
    }

    return new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true })
      img.addEventListener('error', resolve, { once: true })
    })
  })

  const timeout = new Promise((resolve) => {
    window.setTimeout(resolve, timeoutMs)
  })

  return Promise.race([Promise.all(waiters), timeout])
}

async function exportEvidenceReport(record) {
  const logoUrl = `${window.location.origin}/brand/logo.png`
  const mapUrl = buildStaticMapUrl(record)
  const generatedAt = new Date().toLocaleString('es-CO')
  const printableDate = new Date().toLocaleDateString('es-CO')

  const printableHtml = `
    <!doctype html>
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <title>Evidencia exceso ${record.idMarca}</title>
        <style>
          @page { size: A4 portrait; margin: 10mm; }
          * { box-sizing: border-box; }
          body { font-family: Arial, sans-serif; margin: 0; color: #1f2937; background: #fff; }
          .sheet {
            width: 190mm;
            min-height: 277mm;
            margin: 0 auto;
            border: 1px solid #cbd5e1;
            display: flex;
            flex-direction: column;
          }
          .head {
            display: grid;
            grid-template-columns: 84px 1fr 170px;
            align-items: center;
            gap: 12px;
            padding: 10px 12px;
            border-bottom: 1px solid #cbd5e1;
            background: #f8fafc;
          }
          .head img {
            width: 74px;
            height: 74px;
            object-fit: contain;
            border: 1px solid #cbd5e1;
            border-radius: 8px;
            background: #fff;
            padding: 4px;
          }
          .title h1 { margin: 0; font-size: 18px; }
          .title p { margin: 3px 0 0; font-size: 12px; color: #475569; }
          .meta {
            border: 1px solid #dbe3ee;
            border-radius: 8px;
            padding: 6px 8px;
            font-size: 11px;
            line-height: 1.45;
            background: #fff;
          }
          .section {
            padding: 10px 12px;
            border-bottom: 1px solid #e2e8f0;
          }
          .section h2 {
            margin: 0 0 8px;
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            color: #334155;
          }
          .grid {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 7px 10px;
          }
          .item {
            border: 1px solid #dbe3ee;
            border-radius: 8px;
            padding: 7px 8px;
            min-height: 52px;
          }
          .item .k { font-size: 10px; text-transform: uppercase; color: #64748b; letter-spacing: 0.06em; }
          .item .v { margin-top: 4px; font-size: 13px; font-weight: 700; }
          .map-wrap { padding: 10px 12px; }
          .map {
            border: 1px solid #cbd5e1;
            border-radius: 10px;
            overflow: hidden;
            height: 104mm;
            background: #e2e8f0;
          }
          .map img { width: 100%; height: 100%; object-fit: cover; display: block; }
          .legend {
            margin-top: 6px;
            font-size: 11px;
            color: #475569;
          }
          .footer {
            border-top: 1px solid #cbd5e1;
            padding: 7px 12px;
            font-size: 10px;
            color: #64748b;
            display: flex;
            justify-content: space-between;
            gap: 10px;
          }
          @media print {
            body { background: #fff; }
            .sheet { border: 1px solid #cbd5e1; }
          }
        </style>
      </head>
      <body>
        <section class="sheet">
          <header class="head">
            <img src="${logoUrl}" alt="Logo corporativo" />
            <div class="title">
              <h1>ACTA DE EVIDENCIA DE EXCESO DE VELOCIDAD</h1>
              <p>Control operacional de ruta - Cootransblan</p>
            </div>
            <div class="meta">
              <div><strong>Fecha acta:</strong> ${printableDate}</div>
              <div><strong>ID marca:</strong> ${record.idMarca}</div>
              <div><strong>Generado:</strong> ${generatedAt}</div>
            </div>
          </header>
          <div class="section">
            <h2>Datos del evento</h2>
            <div class="grid">
              <div class="item"><div class="k">Unidad</div><div class="v">${record.movil || 'No disponible'}</div></div>
              <div class="item"><div class="k">Conductor</div><div class="v">${record.conductor || 'No disponible'}</div></div>
              <div class="item"><div class="k">Hora del exceso</div><div class="v">${record.fechaHoraVelocidad || 'No disponible'}</div></div>
              <div class="item"><div class="k">Tramo</div><div class="v">${record.tramoForLocation || record.tramo || 'No disponible'}</div></div>
              <div class="item"><div class="k">Velocidad registrada</div><div class="v">${record.velocidad} km/h</div></div>
            </div>
          </div>
          <div class="map-wrap">
            <div class="map">
              <img src="${mapUrl}" alt="Mapa de ubicacion del exceso" />
            </div>
            <div class="legend">Marcador: exceso (rojo).</div>
          </div>

          <footer class="footer">
            <span>Documento de evidencia para efectos administrativos.</span>
            <span>Pagina 1 de 1</span>
          </footer>
        </section>
      </body>
    </html>
  `

  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.position = 'fixed'
  iframe.style.right = '0'
  iframe.style.bottom = '0'
  iframe.style.width = '1px'
  iframe.style.height = '1px'
  iframe.style.border = '0'
  iframe.style.opacity = '0'

  const cleanup = () => {
    window.setTimeout(() => {
      if (iframe.parentNode) {
        iframe.parentNode.removeChild(iframe)
      }
    }, 3000)
  }

  iframe.onload = async () => {
    try {
      const frameDoc = iframe.contentWindow?.document

      if (frameDoc) {
        await waitForImagesInDocument(frameDoc)
      }

      iframe.contentWindow?.focus()
      iframe.contentWindow?.print()
    } catch {
      // Fallback: descarga HTML si la impresion embebida falla.
      const blob = new Blob([printableHtml], { type: 'text/html;charset=utf-8' })
      const href = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = href
      anchor.download = `evidencia_exceso_${record.idMarca}.html`
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(href)
    } finally {
      cleanup()
    }
  }

  document.body.append(iframe)

  if ('srcdoc' in iframe) {
    iframe.srcdoc = printableHtml
    return
  }

  const frameDoc = iframe.contentWindow?.document

  if (!frameDoc) {
    const blob = new Blob([printableHtml], { type: 'text/html;charset=utf-8' })
    const href = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = href
    anchor.download = `evidencia_exceso_${record.idMarca}.html`
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(href)
    cleanup()
    return
  }

  frameDoc.open()
  frameDoc.write(printableHtml)
  frameDoc.close()
}

function MapFocusController({ selectedPoint }) {
  const map = useMap()

  useEffect(() => {
    if (!selectedPoint) {
      return
    }

    map.flyTo([selectedPoint.lat, selectedPoint.lon], 16, { duration: 0.85 })
  }, [selectedPoint, map])

  return null
}

function App() {
  const [analysis, setAnalysis] = useState(null)
  const [error, setError] = useState('')
  const [sourceName, setSourceName] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [pointsCatalog, setPointsCatalog] = useState([])
  const [pointIndex, setPointIndex] = useState({})
  const [pointCatalogCount, setPointCatalogCount] = useState(0)
  const [pointError, setPointError] = useState('')
  const [routeCache, setRouteCache] = useState({})
  const [isRouting, setIsRouting] = useState(false)
  const [routeError, setRouteError] = useState('')
  const [searchText, setSearchText] = useState('')
  const [minSpeed, setMinSpeed] = useState(SPEED_LIMIT + 1)
  const [selectedRecordUid, setSelectedRecordUid] = useState('')

  useEffect(() => {
    async function loadInitialData() {
      setIsLoading(true)
      setError('')
      setPointError('')

      try {
        const [datasetResponse, pointResponse] = await Promise.all([
          fetch(DEFAULT_DATASET),
          fetch(DEFAULT_POINTS_CATALOG),
        ])

        if (!datasetResponse.ok) {
          throw new Error('No se pudo cargar el archivo base desde public/data.')
        }

        if (!pointResponse.ok) {
          throw new Error('No se pudo cargar el catalogo de puntos del PDF.')
        }

        const buffer = await datasetResponse.arrayBuffer()
        const points = await pointResponse.json()
        const safePoints = Array.isArray(points) ? points : []
        const parsed = parseWorkbookFromArrayBuffer(buffer)

        setAnalysis(parsed)
        setPointsCatalog(safePoints)
        setPointIndex(indexPoints(safePoints))
        setPointCatalogCount(safePoints.length)
        setRouteCache({})
        setSourceName('BEA_DATOSEXPORTADOS.xls')
      } catch (loadError) {
        const message =
          loadError instanceof Error
            ? loadError.message
            : 'No fue posible leer los archivos base.'

        setError(message)
        setPointError(message)
      } finally {
        setIsLoading(false)
      }
    }

    loadInitialData()
  }, [])

  async function onUploadWorkbook(event) {
    const file = event.target.files?.[0]

    if (!file) {
      return
    }

    setIsLoading(true)
    setError('')
    setRouteError('')
    setRouteCache({})

    try {
      const buffer = await file.arrayBuffer()
      const parsed = parseWorkbookFromArrayBuffer(buffer)
      setAnalysis(parsed)
      setSourceName(file.name)
    } catch (uploadError) {
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : 'No fue posible analizar el archivo cargado.',
      )
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    async function resolveRoadPoints() {
      if (!analysis || !pointsCatalog.length) {
        return
      }

      const pending = []

      for (const record of analysis.excessive) {
        const resolved = resolveTramoLocation(record, pointIndex, pointsCatalog)

        if (!resolved.originPoint || !resolved.destinationPoint) {
          continue
        }

        const key = buildSegmentKey(resolved.originPoint, resolved.destinationPoint)

        if (!key || routeCache[key]) {
          continue
        }

        pending.push({ key, originPoint: resolved.originPoint, destinationPoint: resolved.destinationPoint })
      }

      if (pending.length === 0) {
        return
      }

      setIsRouting(true)
      setRouteError('')

      try {
        const updates = {}

        for (const item of pending) {
          try {
            const routeResult = await fetchRoadMidpoint(item.originPoint, item.destinationPoint)
            updates[item.key] = routeResult || { point: null, geometry: null, source: 'road_not_available' }
          } catch {
            updates[item.key] = { point: null, geometry: null, source: 'road_not_available' }
          }
        }

        setRouteCache((current) => ({ ...current, ...updates }))
      } catch (err) {
        setRouteError(
          err instanceof Error
            ? err.message
            : 'No fue posible resolver rutas viales para todos los tramos.',
        )
      } finally {
        setIsRouting(false)
      }
    }

    resolveRoadPoints()
  }, [analysis, pointIndex, pointsCatalog, routeCache])

  const enrichedExcessiveRecords = useMemo(() => {
    if (!analysis) {
      return []
    }

    return analysis.excessive.map((record) => {
      const resolved = resolveTramoLocation(record, pointIndex, pointsCatalog)
      const segmentKey = buildSegmentKey(resolved.originPoint, resolved.destinationPoint)
      const routed = segmentKey ? routeCache[segmentKey] : null

      let finalLocation = resolved.excessPoint
      let finalConfidence = resolved.locationConfidence
      let routeGeometry = null

      if (routed?.point) {
        finalLocation = routed.point
        finalConfidence = 'punto del exceso sobre via real (ruta vial origen-destino)'
        routeGeometry = routed.geometry
      }

      return {
        ...record,
        uid: createRecordUid(record),
        originPoint: resolved.originPoint,
        destinationPoint: resolved.destinationPoint,
        location: finalLocation,
        locationSource: resolved.locationSource,
        locationConfidence: finalConfidence,
        routeGeometry,
        routeSource: routed?.source || 'segment_midpoint_fallback',
        originMatchedBy: resolved.originMatchedBy,
        destinationMatchedBy: resolved.destinationMatchedBy,
        originUsedName: resolved.originUsedName,
        destinationUsedName: resolved.destinationUsedName,
        tramoFrom: resolved.tramoFrom,
        tramoTo: resolved.tramoTo,
        reportedTramo: resolved.reportedTramo,
        tramoForLocation: resolved.tramoForLocation,
        tramoWasCorrected: resolved.tramoWasCorrected,
      }
    })
  }, [analysis, pointIndex, pointsCatalog, routeCache])

  const filteredExcessiveRecords = useMemo(() => {
    return enrichedExcessiveRecords.filter((record) => {
      if (record.velocidad < minSpeed) {
        return false
      }

      if (!searchText.trim()) {
        return true
      }

      const haystack = [record.tramo, record.origen, record.destino, record.ruta]
        .join(' ')
        .toLowerCase()

      return haystack.includes(searchText.toLowerCase())
    })
  }, [enrichedExcessiveRecords, minSpeed, searchText])

  const rankedRecords = useMemo(() => {
    return filteredExcessiveRecords.map((record, index) => ({
      ...record,
      rank: index + 1,
    }))
  }, [filteredExcessiveRecords])

  useEffect(() => {
    if (rankedRecords.length === 0) {
      if (selectedRecordUid) {
        setSelectedRecordUid('')
      }
      return
    }

    const found = rankedRecords.some((record) => record.uid === selectedRecordUid)

    if (!found) {
      setSelectedRecordUid(rankedRecords[0].uid)
    }
  }, [rankedRecords, selectedRecordUid])

  const selectedRecord = useMemo(() => {
    return rankedRecords.find((record) => record.uid === selectedRecordUid) || null
  }, [rankedRecords, selectedRecordUid])

  const mapPoints = useMemo(() => {
    return rankedRecords.filter((record) => record.location)
  }, [rankedRecords])

  const mapCenter = useMemo(() => {
    if (selectedRecord?.location) {
      return [selectedRecord.location.lat, selectedRecord.location.lon]
    }

    if (mapPoints.length === 0) {
      return DEFAULT_CENTER
    }

    const total = mapPoints.reduce(
      (acc, item) => {
        return {
          lat: acc.lat + item.location.lat,
          lon: acc.lon + item.location.lon,
        }
      },
      { lat: 0, lon: 0 },
    )

    return [total.lat / mapPoints.length, total.lon / mapPoints.length]
  }, [mapPoints, selectedRecord])

  const unresolvedCount = rankedRecords.length - mapPoints.length

  function exportCsv() {
    const csv = buildCsv(filteredExcessiveRecords)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const href = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = href
    anchor.download = `excesos_mayores_${SPEED_LIMIT}_kmh.csv`
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(href)
  }

  function severityClass(speed) {
    if (speed >= 90) {
      return 'critical'
    }

    if (speed >= 80) {
      return 'high'
    }

    return 'medium'
  }

  return (
    <main className="app-shell">
      <header className="hero-panel">
        <div className="brand-block">
          <img src="/brand/logo.png" alt="Logo corporativo" className="brand-logo" />
          <div>
            <p className="eyebrow">Analisis de Velocidad BEA</p>
            <h1>Excesos de velocidad superiores a {SPEED_LIMIT} km/h</h1>
            <p className="subtitle">
              Filtra, ubica en mapa y documenta cada evento con evidencia
              auditable.
            </p>
          </div>
        </div>
        <div className="controls">
          <label className="file-input">
            <span>Cargar .xls/.xlsx</span>
            <input
              type="file"
              accept=".xls,.xlsx"
              onChange={onUploadWorkbook}
              disabled={isLoading}
            />
          </label>
          <p className="source-name">Fuente: {sourceName || 'sin archivo'}</p>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      {analysis && (
        <section className="summary-grid">
          <article>
            <h2>Registros analizados</h2>
            <p>{analysis.summary.totalRecords.toLocaleString('es-CO')}</p>
          </article>
          <article>
            <h2>Excesos encontrados</h2>
            <p>{analysis.summary.excessCount.toLocaleString('es-CO')}</p>
          </article>
          <article>
            <h2>% de exceso</h2>
            <p>{analysis.summary.percentExcess.toFixed(2)}%</p>
          </article>
          <article>
            <h2>Velocidad maxima</h2>
            <p>{analysis.summary.maxSpeed.toFixed(0)} km/h</p>
          </article>
        </section>
      )}

      <section className="filters-panel">
        <div>
          <label htmlFor="min-speed">Velocidad minima detectada</label>
          <input
            id="min-speed"
            type="number"
            min={SPEED_LIMIT + 1}
            value={minSpeed}
            onChange={(event) => setMinSpeed(Number(event.target.value) || SPEED_LIMIT + 1)}
          />
        </div>
        <div>
          <label htmlFor="search-text">Filtrar por tramo/ruta</label>
          <input
            id="search-text"
            type="text"
            placeholder="Ejemplo: TERMINAL, FRONTERA, 246"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
          />
        </div>
        <button
          type="button"
          className="export-button"
          onClick={exportCsv}
          disabled={filteredExcessiveRecords.length === 0}
        >
          Exportar evidencia CSV
        </button>
      </section>

      <section className="status-strip">
        <p>
          {isLoading
            ? 'Analizando archivo...'
            : `Eventos > ${SPEED_LIMIT} km/h: ${filteredExcessiveRecords.length}`}
        </p>
        <p>
          Catalogo PDF cargado: {pointCatalogCount} puntos de control
        </p>
        <p>Con ubicacion exacta por tramo: {mapPoints.length}</p>
        <p>Sin ubicacion resuelta: {unresolvedCount}</p>
        <p>{isRouting ? 'Ajustando puntos sobre via real...' : 'Ajuste vial aplicado'}</p>
        <p>
          Seleccionado: {selectedRecord ? `#${selectedRecord.rank} ${selectedRecord.tramo}` : 'ninguno'}
        </p>
        {selectedRecord && (
          <button
            type="button"
            className="quick-export-button"
            onClick={() => exportEvidenceReport(selectedRecord)}
          >
            Exportar evidencia seleccionada
          </button>
        )}
      </section>

      {pointError && <div className="warning-banner">{pointError}</div>}
      {routeError && <div className="warning-banner">{routeError}</div>}

      <section className="map-layout">
        <section className="map-panel">
          <MapContainer center={mapCenter} zoom={DEFAULT_ZOOM} scrollWheelZoom>
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />

            <MapFocusController selectedPoint={selectedRecord?.location || null} />

            {mapPoints
              .filter((record) => record.originPoint && record.destinationPoint)
              .map((record) => {
                const isSelected = selectedRecordUid === record.uid

                return (
                  <Polyline
                    key={`${record.uid}-segment`}
                    positions={
                      record.routeGeometry || [
                        [record.originPoint.lat, record.originPoint.lon],
                        [record.destinationPoint.lat, record.destinationPoint.lon],
                      ]
                    }
                    pathOptions={{
                      color: isSelected ? '#2563eb' : '#1d4ed8',
                      weight: isSelected ? 6 : 3,
                      opacity: isSelected ? 0.95 : 0.45,
                    }}
                  />
                )
              })}

            {mapPoints.map((record) => {
              const isSelected = selectedRecordUid === record.uid

              return (
                <CircleMarker
                  key={record.uid}
                  center={[record.location.lat, record.location.lon]}
                  radius={isSelected ? 13 : Math.min(Math.max(record.exceso, 4), 10)}
                  pathOptions={{
                    color: markerColorBySpeed(record.velocidad),
                    weight: isSelected ? 3 : 1.4,
                    fillColor: markerColorBySpeed(record.velocidad),
                    fillOpacity: isSelected ? 0.95 : 0.72,
                  }}
                  eventHandlers={{
                    click: () => {
                      setSelectedRecordUid(record.uid)
                    },
                  }}
                >
                  <Popup>
                    <strong>#{record.rank} {record.tramo}</strong>
                    <br />
                    Unidad: {record.movil || 'No disponible'}
                    <br />
                    Conductor: {record.conductor || 'No disponible'}
                    <br />
                    Hora exceso: {record.fechaHoraVelocidad || 'No disponible'}
                    <br />
                    Tramo: {record.tramoForLocation || record.tramo || 'No disponible'}
                  </Popup>
                </CircleMarker>
              )
            })}
          </MapContainer>
        </section>

        <section className="evidence-list">
          {rankedRecords.map((record) => (
          <article
            key={`${record.uid}-card`}
            className={`evidence-card ${severityClass(record.velocidad)} ${selectedRecordUid === record.uid ? 'selected' : ''}`}
          >
            <div className="card-top">
              <h3>#{record.rank} {record.tramoForLocation || record.tramo || 'Tramo sin descripcion'}</h3>
              <p>{record.velocidad.toFixed(0)} km/h</p>
            </div>
            <button
              type="button"
              className="locate-button"
              onClick={() => setSelectedRecordUid(record.uid)}
            >
              Ver este exceso en el mapa
            </button>
            <button
              type="button"
              className="export-item-button"
              onClick={() => exportEvidenceReport(record)}
            >
              Exportar evidencia
            </button>
            <div className="minimal-facts">
              <p><span>Unidad:</span> {record.movil || 'No disponible'}</p>
              <p><span>Conductor:</span> {record.conductor || 'No disponible'}</p>
              <p><span>Hora del exceso:</span> {record.fechaHoraVelocidad || 'No disponible'}</p>
              <p><span>Tramo:</span> {record.tramoForLocation || record.tramo || 'No disponible'}</p>
            </div>
          </article>
          ))}
        </section>
      </section>
    </main>
  )
}

export default App

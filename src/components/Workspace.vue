<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import jsPDF from 'jspdf'
import { useI18n } from 'vue-i18n'
import { storage, isDefaultCalibration } from '../utils/storage'
import { loadImageAsBlob } from '../utils/imageProcessing'

const props = defineProps({
  calibration: {
    type: Object,
    required: true
  },
  isUsingDefaultCalibration: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['has-content'])
const { t } = useI18n()

// Constants
const TARGET_WIDTH_MM = 111.55
const TARGET_HEIGHT_MM = 25.64

// State
const layers = ref([])
const activeLayerId = ref(null)
const isPanning = ref(false)
const isExporting = ref(false)
const showExportMenu = ref(false)

/** Items to be rendered one below the other in PDF export. */
const sessionItems = ref([])
const editingItemId = ref(null)

const A4_WIDTH_MM = 210
const A4_HEIGHT_MM = 297
const ITEM_GAP_MM = 5

// Print dimensions from calibration (configurable per template)
const pdfItemWidthMM = computed(() => props.calibration.printWidthMM ?? 111.6)
const pdfItemHeightMM = computed(() => props.calibration.printHeightMM ?? 27)

const activeLayer = computed(() => {
  return layers.value.find(l => l.id === activeLayerId.value) || null
})

// Load saved workspace settings
onMounted(async () => {
  const settings = await storage.loadWorkspaceSettings()
  if (settings.layers && settings.layers.length > 0) {
    layers.value = settings.layers
    activeLayerId.value = settings.activeLayerId || layers.value[0].id
  }
})

// Debounce helper for saving to IndexedDB to avoid lags during dragging
function debounce(fn, delay) {
  let timeout
  return (...args) => {
    clearTimeout(timeout)
    timeout = setTimeout(() => fn(...args), delay)
  }
}

const debouncedSave = debounce(async (layersVal, activeIdVal) => {
  await storage.saveWorkspaceSettings({
    layers: JSON.parse(JSON.stringify(layersVal)),
    activeLayerId: activeIdVal
  })
}, 500)

// Auto-save workspace settings
watch(layers, (newVal) => {
  debouncedSave(newVal, activeLayerId.value)
}, { deep: true })

watch(activeLayerId, (newVal) => {
  debouncedSave(layers.value, newVal)
})

// Emit content state
watch([layers, sessionItems], ([lys, items]) => {
  emit('has-content', lys.length > 0 || items.length > 0)
}, { immediate: true, deep: true })

// File upload: Add new image layer
const handleFileUpload = (e) => {
  const target = e.target
  if (target.files && target.files[0]) {
    const file = target.files[0]
    const reader = new FileReader()
    reader.onload = (event) => {
      const dataUrl = event.target?.result
      if (!dataUrl) return
      
      const newLayer = {
        id: crypto.randomUUID(),
        type: 'image',
        name: file.name.replace(/\.[^/.]+$/, ""), // clean extension
        imageDataUrl: dataUrl,
        scale: 1,
        panX: 0,
        panY: 0,
        rotation: 0,
        opacity: 1,
        blendMode: 'normal',
        visible: true
      }
      
      layers.value.push(newLayer)
      activeLayerId.value = newLayer.id

      // Check if image matches template proportions and auto-fit if it does
      const img = new Image()
      img.onload = () => {
        const uploadedAspect = img.width / img.height
        const templateAspect = props.calibration.templateWidthMM / props.calibration.templateHeightMM
        const diff = Math.abs(uploadedAspect - templateAspect) / templateAspect
        if (diff < 0.02) {
          fitLayerToTemplate(newLayer)
        }
      }
      img.src = dataUrl
    }
    reader.readAsDataURL(file)
  }
  target.value = '' // allow re-selecting the same file
}

// Drag & drop upload support
const handleDragOver = (e) => {
  e.preventDefault()
}

const handleDrop = (e) => {
  e.preventDefault()
  if (e.dataTransfer?.files && e.dataTransfer.files[0]) {
    const file = e.dataTransfer.files[0]
    if (file.type.startsWith('image/')) {
      const reader = new FileReader()
      reader.onload = (event) => {
        const dataUrl = event.target?.result
        if (!dataUrl) return
        
        const newLayer = {
          id: crypto.randomUUID(),
          type: 'image',
          name: file.name.replace(/\.[^/.]+$/, ""),
          imageDataUrl: dataUrl,
          scale: 1,
          panX: 0,
          panY: 0,
          rotation: 0,
          opacity: 1,
          blendMode: 'normal',
          visible: true
        }
        layers.value.push(newLayer)
        activeLayerId.value = newLayer.id
        
        const img = new Image()
        img.onload = () => {
          const uploadedAspect = img.width / img.height
          const templateAspect = props.calibration.templateWidthMM / props.calibration.templateHeightMM
          const diff = Math.abs(uploadedAspect - templateAspect) / templateAspect
          if (diff < 0.02) {
            fitLayerToTemplate(newLayer)
          }
        }
        img.src = dataUrl
      }
      reader.readAsDataURL(file)
    }
  }
}

// Remove the uploaded images (return to upload view)
const removeImage = () => {
  layers.value = []
  activeLayerId.value = null
  editingItemId.value = null
}

/** Renders a masked slot DataURL from a PrintItem + calibration (without template overlay). */
async function renderItemToMaskedDataUrl(item, calibration) {
  // Load template image
  const templateBlobUrl = await loadImageAsBlob(calibration.transparentTemplate)

  // Load all visible layers
  const layersToDraw = item.layers || []
  const loadedLayers = await Promise.all(
    layersToDraw
      .filter(layer => layer.visible && layer.imageDataUrl)
      .map(async (layer) => {
        try {
          const blobUrl = await loadImageAsBlob(layer.imageDataUrl)
          return { layer, blobUrl }
        } catch (e) {
          console.error('Failed to load layer image blob:', layer.name, e)
          return { layer, blobUrl: layer.imageDataUrl }
        }
      })
  )

  return new Promise((resolve, reject) => {
    const templateImg = new Image()
    templateImg.src = templateBlobUrl

    const cleanup = () => {
      if (templateBlobUrl !== calibration.transparentTemplate) {
        URL.revokeObjectURL(templateBlobUrl)
      }
      loadedLayers.forEach(({ blobUrl, layer }) => {
        if (blobUrl && blobUrl !== layer.imageDataUrl && blobUrl.startsWith('blob:')) {
          URL.revokeObjectURL(blobUrl)
        }
      })
    }

    const run = (loadedImages) => {
      const tw = templateImg.width
      const th = templateImg.height

      const cutoutLeftPx = (calibration.cutoutXMM / calibration.templateWidthMM) * tw
      const cutoutTopPx = (calibration.cutoutYMM / calibration.templateHeightMM) * th
      const cutoutWidthPx = (TARGET_WIDTH_MM / calibration.templateWidthMM) * tw
      const cutoutHeightPx = (TARGET_HEIGHT_MM / calibration.templateHeightMM) * th

      const canvas = document.createElement('canvas')
      canvas.width = tw
      canvas.height = th
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        cleanup()
        reject(new Error('Could not get canvas context'))
        return
      }

      ctx.clearRect(0, 0, tw, th)

      const useDefaultMask = isDefaultCalibration(calibration)

      // 1. Draw layers
      ctx.save()
      if (useDefaultMask) {
        ctx.beginPath()
        ctx.rect(cutoutLeftPx, cutoutTopPx, cutoutWidthPx, cutoutHeightPx)
        ctx.clip()
      }

      // Draw loaded layers in index order (bottom to top)
      loadedImages.forEach(({ img, layer }) => {
        ctx.save()

        // Set opacity
        ctx.globalAlpha = layer.opacity !== undefined ? layer.opacity : 1.0

        // Set blend mode
        if (layer.blendMode && layer.blendMode !== 'normal') {
          ctx.globalCompositeOperation = getCanvasBlendMode(layer.blendMode)
        } else {
          ctx.globalCompositeOperation = 'source-over'
        }

        const aspect = img.width / img.height
        const imgHeightPx = cutoutHeightPx * layer.scale
        const imgWidthPx = imgHeightPx * aspect
        const centerXpx = cutoutLeftPx + (0.5 + layer.panX) * cutoutWidthPx
        const centerYpx = cutoutTopPx + (0.5 + layer.panY) * cutoutHeightPx

        // Transform (Translate to center, Rotate, Draw offset)
        ctx.translate(centerXpx, centerYpx)
        if (layer.rotation) {
          ctx.rotate((layer.rotation * Math.PI) / 180)
        }
        ctx.drawImage(img, -imgWidthPx / 2, -imgHeightPx / 2, imgWidthPx, imgHeightPx)

        ctx.restore()
      })

      ctx.restore()

      // 2. Apply template mask for custom template
      if (!useDefaultMask) {
        ctx.save()
        ctx.globalCompositeOperation = 'destination-out'
        ctx.drawImage(templateImg, 0, 0, tw, th)
        ctx.restore()
      }

      cleanup()
      resolve(canvas.toDataURL('image/png'))
    }

    const loadedImages = []
    let loadedCount = 0
    const totalToLoad = loadedLayers.length + 1

    const checkReady = () => {
      loadedCount++
      if (loadedCount === totalToLoad) {
        const sortedImages = loadedLayers.map(({ layer }) => {
          return loadedImages.find(item => item.layer.id === layer.id)
        }).filter(Boolean)
        
        run(sortedImages)
      }
    }

    templateImg.onload = checkReady
    templateImg.onerror = () => { cleanup(); reject(new Error('Failed to load template image')) }

    loadedLayers.forEach(({ layer, blobUrl }) => {
      const img = new Image()
      img.src = blobUrl
      img.onload = () => {
        loadedImages.push({ img, layer })
        checkReady()
      }
      img.onerror = () => {
        console.error('Failed to load layer image:', layer.name)
        const emptyCanvas = document.createElement('canvas')
        emptyCanvas.width = 1
        emptyCanvas.height = 1
        const dummyImg = new Image()
        dummyImg.src = emptyCanvas.toDataURL()
        dummyImg.onload = () => {
          loadedImages.push({ img: dummyImg, layer })
          checkReady()
        }
      }
    })

    if (totalToLoad === 1) {
      templateImg.onload = () => run([])
    }
  })
}

// Blend mode helper for HTML5 Canvas
function getCanvasBlendMode(blendMode) {
  switch (blendMode) {
    case 'multiply': return 'multiply'
    case 'screen': return 'screen'
    case 'overlay': return 'overlay'
    case 'darken': return 'darken'
    case 'lighten': return 'lighten'
    case 'color-dodge': return 'color-dodge'
    case 'color-burn': return 'color-burn'
    case 'hard-light': return 'hard-light'
    case 'soft-light': return 'soft-light'
    case 'difference': return 'difference'
    case 'exclusion': return 'exclusion'
    default: return 'source-over'
  }
}

/**
 * Rendert den Cutout-Bereich eines Items für den PDF-Export.
 * 1. renderItemToMaskedDataUrl erzeugt das korrekt maskierte Bild (volle Template-Größe)
 * 2. Der Cutout-Bereich wird daraus zugeschnitten und in 300 DPI ausgegeben
 * 3. Bei Custom-Templates wird das Template-Overlay ebenfalls zugeschnitten aufgelegt
 */
async function renderCutoutForPDF(item, calibration) {
  const maskedDataUrl = await renderItemToMaskedDataUrl(item, calibration)
  const useDefault = isDefaultCalibration(calibration)

  // Pre-fetch template as blob for cross-origin safety
  const templateBlobUrl = !useDefault ? await loadImageAsBlob(calibration.transparentTemplate) : null

  return new Promise((resolve, reject) => {
    const maskedImg = new Image()
    maskedImg.src = maskedDataUrl

    const templateImg = templateBlobUrl ? new Image() : null
    if (templateImg) templateImg.src = templateBlobUrl

    let maskedReady = false
    let templateReady = useDefault

    const cleanup = () => {
      if (templateBlobUrl && templateBlobUrl !== calibration.transparentTemplate) {
        URL.revokeObjectURL(templateBlobUrl)
      }
    }

    const tryRender = () => {
      if (!maskedReady || !templateReady) return

      const tw = maskedImg.width
      const th = maskedImg.height

      const cutoutLeftPx = (calibration.cutoutXMM / calibration.templateWidthMM) * tw
      const cutoutTopPx = (calibration.cutoutYMM / calibration.templateHeightMM) * th
      const cutoutWidthPx = (TARGET_WIDTH_MM / calibration.templateWidthMM) * tw
      const cutoutHeightPx = (TARGET_HEIGHT_MM / calibration.templateHeightMM) * th

      const pxPerMM = 300 / 25.4
      const outWidth = Math.round(pdfItemWidthMM.value * pxPerMM)
      const outHeight = Math.round(pdfItemHeightMM.value * pxPerMM)

      const canvas = document.createElement('canvas')
      canvas.width = outWidth
      canvas.height = outHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) { cleanup(); reject(new Error('No canvas context')); return }

      const cutoutAspect = cutoutWidthPx / cutoutHeightPx
      const outAspect = outWidth / outHeight
      let destW, destH, destX, destY
      if (cutoutAspect > outAspect) {
        destW = outWidth
        destH = outWidth / cutoutAspect
      } else {
        destH = outHeight
        destW = outHeight * cutoutAspect
      }
      destX = (outWidth - destW) / 2
      destY = (outHeight - destH) / 2

      ctx.drawImage(maskedImg,
        cutoutLeftPx, cutoutTopPx, cutoutWidthPx, cutoutHeightPx,
        destX, destY, destW, destH
      )

      if (templateImg) {
        ctx.drawImage(templateImg,
          cutoutLeftPx, cutoutTopPx, cutoutWidthPx, cutoutHeightPx,
          destX, destY, destW, destH
        )
      }

      cleanup()
      resolve(canvas.toDataURL('image/png'))
    }

    maskedImg.onload = () => { maskedReady = true; tryRender() }
    maskedImg.onerror = () => { cleanup(); reject(new Error('Failed to load masked image')) }

    if (templateImg) {
      templateImg.onload = () => { templateReady = true; tryRender() }
      templateImg.onerror = () => { cleanup(); reject(new Error('Failed to load template')) }
    }
  })
}

/**
 * Erzeugt ein zugeschnittenes Preview-Bild (nur Cutout-Bereich) für die Session-Liste.
 * Wie renderCutoutForPDF, aber in niedrigerer Auflösung für schnelle Anzeige.
 */
async function renderCutoutPreview(item, calibration) {
  const maskedDataUrl = await renderItemToMaskedDataUrl(item, calibration)
  const useDefault = isDefaultCalibration(calibration)

  const templateBlobUrl = !useDefault ? await loadImageAsBlob(calibration.transparentTemplate) : null

  return new Promise((resolve, reject) => {
    const maskedImg = new Image()
    maskedImg.src = maskedDataUrl

    const templateImg = templateBlobUrl ? new Image() : null
    if (templateImg) templateImg.src = templateBlobUrl

    let maskedReady = false
    let templateReady = useDefault

    const cleanup = () => {
      if (templateBlobUrl && templateBlobUrl !== calibration.transparentTemplate) {
        URL.revokeObjectURL(templateBlobUrl)
      }
    }

    const tryRender = () => {
      if (!maskedReady || !templateReady) return

      const tw = maskedImg.width
      const th = maskedImg.height

      const cutoutLeftPx = (calibration.cutoutXMM / calibration.templateWidthMM) * tw
      const cutoutTopPx = (calibration.cutoutYMM / calibration.templateHeightMM) * th
      const cutoutWidthPx = (TARGET_WIDTH_MM / calibration.templateWidthMM) * tw
      const cutoutHeightPx = (TARGET_HEIGHT_MM / calibration.templateHeightMM) * th

      const outWidth = 800
      const outHeight = Math.round(outWidth * (cutoutHeightPx / cutoutWidthPx))

      const canvas = document.createElement('canvas')
      canvas.width = outWidth
      canvas.height = outHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) { cleanup(); reject(new Error('No canvas context')); return }

      ctx.drawImage(maskedImg,
        cutoutLeftPx, cutoutTopPx, cutoutWidthPx, cutoutHeightPx,
        0, 0, outWidth, outHeight
      )

      if (templateImg) {
        ctx.drawImage(templateImg,
          cutoutLeftPx, cutoutTopPx, cutoutWidthPx, cutoutHeightPx,
          0, 0, outWidth, outHeight
        )
      }

      cleanup()
      resolve(canvas.toDataURL('image/png'))
    }

    maskedImg.onload = () => { maskedReady = true; tryRender() }
    maskedImg.onerror = () => { cleanup(); reject(new Error('Failed to load masked image')) }

    if (templateImg) {
      templateImg.onload = () => { templateReady = true; tryRender() }
      templateImg.onerror = () => { cleanup(); reject(new Error('Failed to load template')) }
    }
  })
}

/** Add current image + position as entry to the list or update an existing item. */
const addToSession = async () => {
  if (layers.value.length === 0) return

  const designName = layers.value.find(l => l.type === 'image')?.name || 'Design'

  if (editingItemId.value) {
    // Update existing item in-place
    const idx = sessionItems.value.findIndex(i => i.id === editingItemId.value)
    if (idx !== -1) {
      const updated = {
        ...sessionItems.value[idx],
        layers: JSON.parse(JSON.stringify(layers.value)),
        imageName: designName,
        previewDataUrl: null
      }
      try {
        updated.previewDataUrl = await renderCutoutPreview(updated, props.calibration)
      } catch (e) {
        console.error('Preview rendering failed:', e)
      }
      sessionItems.value[idx] = updated
    }
    editingItemId.value = null
  } else {
    // Add new item
    const item = {
      id: crypto.randomUUID(),
      layers: JSON.parse(JSON.stringify(layers.value)),
      imageName: designName,
      previewDataUrl: null
    }
    try {
      item.previewDataUrl = await renderCutoutPreview(item, props.calibration)
    } catch (e) {
      console.error('Preview rendering failed:', e)
    }
    sessionItems.value.push(item)
  }
  removeImage()
}

const removeItem = (id) => {
  sessionItems.value = sessionItems.value.filter((i) => i.id !== id)
  if (editingItemId.value === id) {
    editingItemId.value = null
    removeImage()
  }
}

const editItem = (item) => {
  layers.value = JSON.parse(JSON.stringify(item.layers))
  activeLayerId.value = layers.value[layers.value.length - 1]?.id || null
  editingItemId.value = item.id
}

const cancelEdit = () => {
  editingItemId.value = null
  removeImage()
}

const clearSessionList = () => {
  sessionItems.value = []
  editingItemId.value = null
}

/** Items for PDF: session list or current editor as a single item. */
const itemsForPDF = computed(() => {
  if (sessionItems.value.length > 0) return sessionItems.value
  if (layers.value.length > 0)
    return [
      {
        id: 'current',
        layers: JSON.parse(JSON.stringify(layers.value)),
        imageName: layers.value.find(l => l.type === 'image')?.name || 'Design'
      }
    ]
  return []
})

const canExportPDF = computed(() => itemsForPDF.value.length > 0)

// PDF: all items stacked vertically, A4 width, page breaks
const generatePDF = async () => {
  const items = itemsForPDF.value
  if (items.length === 0) return

  isExporting.value = true
  showExportMenu.value = false

  try {
    const doc = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4'
    })

    // Center designs horizontally on A4
    const itemW = pdfItemWidthMM.value
    const itemH = pdfItemHeightMM.value
    const marginX = (A4_WIDTH_MM - itemW) / 2
    let y = ITEM_GAP_MM

    for (const item of items) {
      if (y + itemH > A4_HEIGHT_MM - ITEM_GAP_MM && y > ITEM_GAP_MM) {
        doc.addPage()
        y = ITEM_GAP_MM
      }

      const cutoutDataUrl = await renderCutoutForPDF(item, props.calibration)
      doc.addImage(cutoutDataUrl, 'PNG', marginX, y, itemW, itemH)
      y += itemH + ITEM_GAP_MM
    }

    const now = new Date()
    const ts = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      '-',
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0')
    ].join('')
    const filename = `battlepass-print-${ts}.pdf`

    // Create blob URL and open in new tab (shows browser PDF viewer)
    const blob = doc.output('blob')
    const url = URL.createObjectURL(blob)
    window.open(url, '_blank')

    // Delayed revoke – give the tab enough time to load the PDF
    setTimeout(() => URL.revokeObjectURL(url), 60000)

    // Also save as file (in case popup is blocked)
    doc.save(filename)
  } finally {
    isExporting.value = false
  }
}

// SVG Export
const exportSVG = async () => {
  if (layers.value.length === 0) return

  isExporting.value = true
  showExportMenu.value = false

  try {
    const svgWidth = TARGET_WIDTH_MM * 10 // Scale for better resolution
    const svgHeight = TARGET_HEIGHT_MM * 10

    const svgLayers = []
    
    // Load and draw each visible layer
    for (const layer of layers.value) {
      if (!layer.visible) continue
      
      const aspect = await new Promise((resolve) => {
        const img = new Image()
        img.onload = () => resolve(img.width / img.height)
        img.onerror = () => resolve(1)
        img.src = layer.imageDataUrl
      })

      const drawHeight = svgHeight * layer.scale
      const drawWidth = drawHeight * aspect

      const centerX = (0.5 + layer.panX) * svgWidth
      const centerY = (0.5 + layer.panY) * svgHeight

      const transformStr = `translate(${centerX}, ${centerY}) rotate(${layer.rotation || 0}) translate(${-drawWidth / 2}, ${-drawHeight / 2})`
      const opacityStr = layer.opacity !== undefined && layer.opacity !== 1 ? ` opacity="${layer.opacity}"` : ''
      const mixBlendModeStr = layer.blendMode && layer.blendMode !== 'normal' ? ` style="mix-blend-mode: ${layer.blendMode}"` : ''

      svgLayers.push(`<image x="0" y="0" width="${drawWidth}" height="${drawHeight}" xlink:href="${layer.imageDataUrl}" transform="${transformStr}"${opacityStr}${mixBlendModeStr} preserveAspectRatio="xMidYMid slice"/>`)
    }

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="${TARGET_WIDTH_MM}mm" height="${TARGET_HEIGHT_MM}mm"
     viewBox="0 0 ${svgWidth} ${svgHeight}">
  <defs>
    <clipPath id="cutout">
      <rect x="0" y="0" width="${svgWidth}" height="${svgHeight}" rx="20"/>
    </clipPath>
  </defs>
  <g clip-path="url(#cutout)">
    ${svgLayers.join('\n    ')}
  </g>
</svg>`

    const blob = new Blob([svg], { type: 'image/svg+xml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'battlepass-cutout.svg'
    a.click()
    URL.revokeObjectURL(url)
  } finally {
    isExporting.value = false
  }
}

// PNG Export (high resolution)
const exportPNG = async () => {
  if (layers.value.length === 0) return

  isExporting.value = true
  showExportMenu.value = false

  try {
    // High resolution export (300 DPI equivalent)
    const scale = 4
    const canvasWidth = Math.round(TARGET_WIDTH_MM * 11.811 * scale) // mm to px at 300dpi
    const canvasHeight = Math.round(TARGET_HEIGHT_MM * 11.811 * scale)

    const canvas = document.createElement('canvas')
    canvas.width = canvasWidth
    canvas.height = canvasHeight

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, canvasWidth, canvasHeight)

    // Create rounded clip path
    const radius = 20 * scale
    ctx.beginPath()
    ctx.roundRect(0, 0, canvasWidth, canvasHeight, radius)
    ctx.clip()

    for (const layer of layers.value) {
      if (!layer.visible) continue

      const img = await new Promise((resolve) => {
        const i = new Image()
        i.onload = () => resolve(i)
        i.onerror = () => resolve(null)
        i.src = layer.imageDataUrl
      })
      if (!img) continue

      ctx.save()
      ctx.globalAlpha = layer.opacity !== undefined ? layer.opacity : 1
      if (layer.blendMode && layer.blendMode !== 'normal') {
        ctx.globalCompositeOperation = getCanvasBlendMode(layer.blendMode)
      }

      const aspect = img.width / img.height
      const drawHeight = canvasHeight * layer.scale
      const drawWidth = drawHeight * aspect

      const centerX = (0.5 + layer.panX) * canvasWidth
      const centerY = (0.5 + layer.panY) * canvasHeight

      ctx.translate(centerX, centerY)
      if (layer.rotation) {
        ctx.rotate((layer.rotation * Math.PI) / 180)
      }
      ctx.drawImage(img, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight)
      ctx.restore()
    }

    await new Promise((resolve) => {
      canvas.toBlob((blob) => {
        if (blob) {
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = 'battlepass-cutout.png'
          a.click()
          URL.revokeObjectURL(url)
        }
        resolve()
      }, 'image/png')
    })
  } finally {
    isExporting.value = false
  }
}

// Export/Import Project Logic
const handleExportProject = () => {
  try {
    const projectData = {
      fileType: 'beytagger-project',
      version: 1,
      layers: JSON.parse(JSON.stringify(layers.value)),
      sessionItems: JSON.parse(JSON.stringify(sessionItems.value))
    }
    
    const jsonString = JSON.stringify(projectData)
    const blob = new Blob([jsonString], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    
    const now = new Date()
    const ts = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      '-',
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0')
    ].join('')
    const filename = `beytagger-project-${ts}.json`
    
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  } catch (error) {
    console.error('Failed to export project:', error)
    alert('Error exporting project')
  }
}

const handleImportProject = (e) => {
  const target = e.target
  if (target.files && target.files[0]) {
    const file = target.files[0]
    const reader = new FileReader()
    reader.onload = async (event) => {
      try {
        const content = event.target?.result
        if (!content || typeof content !== 'string') {
          throw new Error('Empty or invalid file content')
        }
        
        const projectData = JSON.parse(content)
        
        if (projectData.fileType !== 'beytagger-project') {
          throw new Error('Not a valid Beytagger project file')
        }
        
        // Restore layers
        if (Array.isArray(projectData.layers)) {
          layers.value = projectData.layers
        } else {
          layers.value = []
        }
        
        // Restore session items
        if (Array.isArray(projectData.sessionItems)) {
          const items = []
          for (const item of projectData.sessionItems) {
            const restoredItem = {
              id: item.id || crypto.randomUUID(),
              layers: item.layers || [],
              imageName: item.imageName || 'Design',
              previewDataUrl: item.previewDataUrl || null
            }
            if (!restoredItem.previewDataUrl && restoredItem.layers.length > 0) {
              try {
                restoredItem.previewDataUrl = await renderCutoutPreview(restoredItem, props.calibration)
              } catch (err) {
                console.error('Failed to generate preview for imported design:', err)
              }
            }
            items.push(restoredItem)
          }
          sessionItems.value = items
        } else {
          sessionItems.value = []
        }
        
        // Reset active layer if any
        if (layers.value.length > 0) {
          activeLayerId.value = layers.value[layers.value.length - 1].id
        } else {
          activeLayerId.value = null
        }
        
        editingItemId.value = null
        
        // Save to indexedDB workspace settings immediately
        await storage.saveWorkspaceSettings({
          layers: JSON.parse(JSON.stringify(layers.value)),
          activeLayerId: activeLayerId.value
        })
        
        alert(t('battlepass.import_success'))
      } catch (error) {
        console.error('Failed to import project:', error)
        alert(t('battlepass.import_error'))
      }
    }
    reader.readAsText(file)
  }
  target.value = '' // Reset input
}

// Layer stack controls
const moveLayerUp = (index) => {
  if (index === layers.value.length - 1) return
  const temp = layers.value[index]
  layers.value[index] = layers.value[index + 1]
  layers.value[index + 1] = temp
}

const moveLayerDown = (index) => {
  if (index === 0) return
  const temp = layers.value[index]
  layers.value[index] = layers.value[index - 1]
  layers.value[index - 1] = temp
}

const toggleLayerVisibility = (layer) => {
  layer.visible = !layer.visible
}

const removeLayer = (id) => {
  layers.value = layers.value.filter(l => l.id !== id)
  if (activeLayerId.value === id) {
    activeLayerId.value = layers.value[layers.value.length - 1]?.id || null
  }
}

const selectLayer = (id) => {
  activeLayerId.value = id
}

// Fit active layer width to template cutout width
const fitLayerToTemplate = (layer) => {
  if (!layer) return
  const cal = props.calibration
  layer.scale = cal.templateWidthMM / TARGET_WIDTH_MM
  layer.panX = cal.templateWidthMM / (2 * TARGET_WIDTH_MM) - cal.cutoutXMM / TARGET_WIDTH_MM - 0.5
  layer.panY = cal.templateHeightMM / (2 * TARGET_HEIGHT_MM) - cal.cutoutYMM / TARGET_HEIGHT_MM - 0.5
  layer.rotation = 0
}

const fitToTemplate = () => {
  if (activeLayer.value) {
    fitLayerToTemplate(activeLayer.value)
  }
}

// Reset position
const resetPosition = () => {
  if (activeLayer.value) {
    activeLayer.value.panX = 0
    activeLayer.value.panY = 0
    activeLayer.value.scale = 1
    activeLayer.value.rotation = 0
    activeLayer.value.opacity = 1
    activeLayer.value.blendMode = 'normal'
  }
}

// Pan Logic with improved sensitivity
const startPan = (e) => {
  if (e.button !== 0) return
  isPanning.value = true
}

const onPan = (e) => {
  if (!isPanning.value || !activeLayer.value) return
  const sensitivity = 0.002
  const currentScale = activeLayer.value.scale || 1
  activeLayer.value.panX += (e.movementX * sensitivity) / currentScale
  activeLayer.value.panY += (e.movementY * sensitivity) / currentScale
}

const stopPan = () => {
  isPanning.value = false
}

// Wheel zoom
const handleWheel = (e) => {
  e.preventDefault()
  if (!activeLayer.value) return
  const delta = e.deltaY > 0 ? -0.05 : 0.05
  activeLayer.value.scale = Math.max(0.1, Math.min(10, activeLayer.value.scale + delta))
}

// Styles
const containerStyle = computed(() => ({
  width: '100%',
  aspectRatio: `${TARGET_WIDTH_MM} / ${TARGET_HEIGHT_MM}`,
  position: 'relative',
  overflow: 'hidden',
  cursor: isPanning.value ? 'grabbing' : 'grab'
}))

const templateStyle = computed(() => ({
  position: 'absolute',
  width: `${(props.calibration.templateWidthMM / TARGET_WIDTH_MM) * 100}%`,
  height: `${(props.calibration.templateHeightMM / TARGET_HEIGHT_MM) * 100}%`,
  left: `${-(props.calibration.cutoutXMM / TARGET_WIDTH_MM) * 100}%`,
  top: `${-(props.calibration.cutoutYMM / TARGET_HEIGHT_MM) * 100}%`,
  maxWidth: 'none',
  maxHeight: 'none',
  pointerEvents: 'none',
  zIndex: 90
}))

const getLayerStyle = (layer) => {
  return {
    height: '100%',
    position: 'absolute',
    left: `${(0.5 + layer.panX) * 100}%`,
    top: `${(0.5 + layer.panY) * 100}%`,
    transform: `translate(-50%, -50%) scale(${layer.scale}) rotate(${layer.rotation || 0}deg)`,
    transformOrigin: 'center',
    userSelect: 'none',
    pointerEvents: 'none',
    zIndex: layers.value.indexOf(layer) + 1,
    mixBlendMode: layer.blendMode || 'normal'
  }
}
</script>

<template>
  <div class="workspace" @dragover="handleDragOver" @drop="handleDrop">
    <div class="workspace-header">
      <h2>{{ t('battlepass.workspace') }}</h2>
      <div class="project-actions">
        <label class="btn btn-secondary btn-small" :title="t('battlepass.import_project_title')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          {{ t('battlepass.import_project') }}
          <input type="file" hidden accept=".json" @change="handleImportProject">
        </label>
        <button
          class="btn btn-secondary btn-small"
          :disabled="layers.length === 0 && sessionItems.length === 0"
          @click="handleExportProject"
          :title="t('battlepass.export_project_title')"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          {{ t('battlepass.export_project') }}
        </button>
      </div>
    </div>

    <!-- Upload Section (only when no layers exist and no designs are saved) -->
    <div class="upload-section glass-panel" v-if="layers.length === 0 && sessionItems.length === 0">
      <div class="upload-content">
        <div class="upload-icon">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
        </div>
        <h3>{{ t('battlepass.upload_image') }}</h3>
        <p>{{ t('battlepass.drag_drop') }}</p>
        <div class="upload-buttons" style="display: flex; gap: 1rem; margin-top: 0.5rem; flex-wrap: wrap; justify-content: center;">
          <label class="btn btn-primary">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            {{ t('battlepass.select_file') }}
            <input type="file" hidden accept="image/*" @change="handleFileUpload">
          </label>
          
          <label class="btn btn-secondary" :title="t('battlepass.import_project_title')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            {{ t('battlepass.import_project') }}
            <input type="file" hidden accept=".json" @change="handleImportProject">
          </label>
        </div>
      </div>
    </div>

    <!-- Editor Layout (Layers exist or designs exist) -->
    <div class="editor-layout" v-else>
      <template v-if="layers.length > 0">
        <!-- TOP SECTION: Full-width Preview Viewport -->
        <div class="preview-section">
          <div class="preview-header">
            <span class="preview-title">{{ t('battlepass.preview') }}</span>
            <span class="preview-hint">{{ t('battlepass.navigation_hint') }}</span>
          </div>

          <div
            class="preview-viewport"
            :style="containerStyle"
            @mousedown="startPan"
            @mousemove="onPan"
            @mouseup="stopPan"
            @mouseleave="stopPan"
            @wheel="handleWheel"
          >
            <!-- Layer Images -->
            <img 
              v-for="layer in layers" 
              :key="layer.id"
              :src="layer.imageDataUrl" 
              :style="getLayerStyle(layer)"
              class="layer-img"
              :class="{ 'active-layer': activeLayerId === layer.id }"
              draggable="false"
              alt="Layer image" 
            />
            
            <!-- Template Overlay -->
            <img v-if="calibration.transparentTemplate" :src="calibration.transparentTemplate" :style="templateStyle" draggable="false" alt="Template overlay" />

            <!-- Grid overlay for alignment help -->
            <div class="grid-overlay"></div>

            <!-- Center crosshair -->
            <div class="crosshair"></div>
          </div>

          <div class="preview-info" v-if="activeLayer">
            <span>{{ t('battlepass.position') }}: {{ (activeLayer.panX * 100).toFixed(1) }}%, {{ (activeLayer.panY * 100).toFixed(1) }}%</span>
            <span>{{ t('battlepass.zoom') }}: {{ Math.round(activeLayer.scale * 100) }}%</span>
          </div>
        </div>


        <!-- BOTTOM SECTION: Controls Grid (2 Columns) -->
        <div class="editor-workspace-grid" style="margin-top: 1.5rem;">
          <!-- LEFT COLUMN: Layers Stack & Inline Upload -->
          <div class="viewport-column">
          <!-- Layers Stack Manager -->
          <div class="controls-card glass-panel layers-panel">
            <h3>{{ t('battlepass.layers') }}</h3>
            
            <div class="layers-list">
              <!-- Stack visual order: top of list is top layer (drawn last) -->
              <div 
                v-for="(layer, index) in [...layers].reverse()" 
                :key="layer.id"
                class="layer-item"
                :class="{ 'active': activeLayerId === layer.id }"
                @click="selectLayer(layer.id)"
              >
                <!-- Layer Thumbnail -->
                <div class="layer-thumb">
                  <img :src="layer.imageDataUrl" alt="Thumbnail" />
                </div>
                
                <!-- Layer Info -->
                <div class="layer-info">
                  <input 
                    type="text" 
                    v-model="layer.name" 
                    class="layer-name-input"
                    @click.stop
                    :title="t('battlepass.rename_layer')"
                  />
                  <span class="layer-meta">
                    Scale: {{ Math.round(layer.scale * 100) }}% | {{ layer.blendMode }}
                  </span>
                </div>
                
                <!-- Layer Quick Actions -->
                <div class="layer-actions" @click.stop>
                  <!-- Visibility eye icon -->
                  <button 
                    class="btn btn-ghost btn-icon layer-btn" 
                    @click="toggleLayerVisibility(layer)" 
                    :title="t('battlepass.toggle_visibility')"
                  >
                    <svg v-if="layer.visible" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                      <circle cx="12" cy="12" r="3"/>
                    </svg>
                    <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                      <line x1="1" y1="1" x2="23" y2="23"/>
                    </svg>
                  </button>
                  
                  <!-- Move Layer Up -->
                  <button 
                    class="btn btn-ghost btn-icon layer-btn" 
                    @click="moveLayerUp(layers.length - 1 - index)" 
                    :disabled="(layers.length - 1 - index) === layers.length - 1"
                    :title="t('battlepass.move_up')"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="18 15 12 9 6 15"/>
                    </svg>
                  </button>
                  
                  <!-- Move Layer Down -->
                  <button 
                    class="btn btn-ghost btn-icon layer-btn" 
                    @click="moveLayerDown(layers.length - 1 - index)" 
                    :disabled="(layers.length - 1 - index) === 0"
                    :title="t('battlepass.move_down')"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="6 9 12 15 18 9"/>
                    </svg>
                  </button>
                  
                  <!-- Delete Layer -->
                  <button 
                    class="btn btn-ghost btn-icon layer-btn btn-remove" 
                    @click="removeLayer(layer.id)" 
                    :title="t('battlepass.delete_layer')"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                    </svg>
                  </button>
                </div>
              </div>
            </div>
            
            <div class="button-row">
              <label class="btn btn-secondary btn-full">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 5v14M5 12h14"/>
                </svg>
                {{ t('battlepass.add_layer') }}
                <input type="file" hidden accept="image/*" @change="handleFileUpload">
              </label>
            </div>
          </div>

          <!-- Inline Upload for adding more layers -->
          <div class="upload-inline glass-panel">
            <div class="upload-inline-content">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
              <span>{{ t('battlepass.add_layer') }}</span>
              <label class="btn btn-primary">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="17 8 12 3 7 8"/>
                  <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                {{ t('battlepass.select_file') }}
                <input type="file" hidden accept="image/*" @change="handleFileUpload">
              </label>
            </div>
          </div>
          </div>

          <!-- RIGHT COLUMN: Active Layer Settings & Exports -->
          <div class="controls-column">
          <!-- Active Layer Settings Panel -->
          <div class="controls-card glass-panel" v-if="activeLayer">
            <h3>{{ t('battlepass.active_layer_settings') }}</h3>
            <p class="selected-layer-name">Selected: <strong>{{ activeLayer.name }}</strong></p>

            <div class="control-group">
              <label>
                <span>{{ t('battlepass.scale') }}</span>
                <span class="value">{{ Math.round(activeLayer.scale * 100) }}%</span>
              </label>
              <input
                type="range"
                min="0.1"
                max="10"
                step="0.01"
                v-model.number="activeLayer.scale"
              >
            </div>

            <div class="control-group">
              <label>
                <span>{{ t('battlepass.horizontal') }}</span>
                <span class="value">{{ (activeLayer.panX * 100).toFixed(1) }}%</span>
              </label>
              <input
                type="range"
                min="-5"
                max="5"
                step="0.01"
                v-model.number="activeLayer.panX"
              >
            </div>

            <div class="control-group">
              <label>
                <span>{{ t('battlepass.vertical') }}</span>
                <span class="value">{{ (activeLayer.panY * 100).toFixed(1) }}%</span>
              </label>
              <input
                type="range"
                min="-5"
                max="5"
                step="0.01"
                v-model.number="activeLayer.panY"
              >
            </div>

            <div class="control-group">
              <label>
                <span>{{ t('battlepass.rotation') }}</span>
                <span class="value">{{ activeLayer.rotation || 0 }}°</span>
              </label>
              <input
                type="range"
                min="-180"
                max="180"
                step="1"
                v-model.number="activeLayer.rotation"
              >
            </div>

            <div class="control-group">
              <label>
                <span>{{ t('battlepass.opacity') }}</span>
                <span class="value">{{ Math.round((activeLayer.opacity ?? 1) * 100) }}%</span>
              </label>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                v-model.number="activeLayer.opacity"
              >
            </div>

            <div class="control-group">
              <label>
                <span>{{ t('battlepass.blend_mode') }}</span>
              </label>
              <select v-model="activeLayer.blendMode" class="blend-mode-select">
                <option value="normal">{{ t('battlepass.normal') }}</option>
                <option value="multiply">{{ t('battlepass.multiply') }}</option>
                <option value="screen">{{ t('battlepass.screen') }}</option>
                <option value="overlay">{{ t('battlepass.overlay') }}</option>
                <option value="darken">{{ t('battlepass.darken') }}</option>
                <option value="lighten">{{ t('battlepass.lighten') }}</option>
                <option value="color-dodge">{{ t('battlepass.color_dodge') }}</option>
                <option value="color-burn">{{ t('battlepass.color_burn') }}</option>
                <option value="hard-light">{{ t('battlepass.hard_light') }}</option>
                <option value="soft-light">{{ t('battlepass.soft_light') }}</option>
                <option value="difference">{{ t('battlepass.difference') }}</option>
                <option value="exclusion">{{ t('battlepass.exclusion') }}</option>
              </select>
            </div>

            <div class="button-row">
              <button class="btn btn-primary" @click="addToSession" :title="t('battlepass.add_to_pdf')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 5v14M5 12h14"/>
                </svg>
                {{ editingItemId ? t('battlepass.update_design') : t('battlepass.add_to_pdf') }}
              </button>
              <button v-if="editingItemId" class="btn btn-secondary" @click="cancelEdit">
                {{ t('battlepass.cancel') }}
              </button>
            </div>
            
            <div class="button-row">
              <button class="btn btn-secondary" @click="fitToTemplate" :title="t('battlepass.fit_to_template')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>
                </svg>
                {{ t('battlepass.fit_to_template') }}
              </button>
              <button class="btn btn-secondary" @click="resetPosition">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                  <path d="M3 3v5h5"/>
                </svg>
                {{ t('battlepass.reset') }}
              </button>
            </div>

            <div class="button-row">
              <button class="btn btn-secondary btn-remove" @click="removeLayer(activeLayer.id)" :title="t('battlepass.delete_layer')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                </svg>
                {{ t('battlepass.delete_layer') }}
              </button>
            </div>
          </div>

          <!-- Exports Panel -->
          <div class="export-card glass-panel">
            <h3>{{ t('battlepass.export') }}</h3>

            <div class="export-buttons">
              <button class="btn btn-primary btn-large" @click="generatePDF" :disabled="!canExportPDF || isExporting">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                  <line x1="16" y1="13" x2="8" y2="13"/>
                  <line x1="16" y1="17" x2="8" y2="17"/>
                  <polyline points="10 9 9 9 8 9"/>
                </svg>
                {{ t('battlepass.pdf_download') }}{{ sessionItems.length > 0 ? ` (${itemsForPDF.length} ${itemsForPDF.length === 1 ? t('battlepass.entry_singular') : t('battlepass.entry_plural')})` : '' }}
              </button>

              <div class="export-secondary">
                <button class="btn btn-ghost" @click="exportPNG" :disabled="isExporting" title="Als PNG exportieren">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                    <circle cx="9" cy="9" r="2"/>
                    <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>
                  </svg>
                  PNG
                </button>

                <button class="btn btn-ghost" @click="exportSVG" :disabled="isExporting" title="Als SVG exportieren">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polygon points="12 2 2 7 12 12 22 7 12 2"/>
                    <polyline points="2 17 12 22 22 17"/>
                    <polyline points="2 12 12 17 22 12"/>
                  </svg>
                  SVG
                </button>
              </div>
            </div>

            <p class="export-hint" v-if="!canExportPDF">
              {{ t('battlepass.pdf_hint_empty') }}
            </p>
            <p class="export-hint" v-else>
              <strong>PDF:</strong> {{ t('battlepass.pdf_hint_entries', { count: itemsForPDF.length, label: itemsForPDF.length === 1 ? t('battlepass.entry_singular') : t('battlepass.entry_plural') }) }}<br>
              <strong>PNG/SVG:</strong> {{ t('battlepass.png_svg_hint') }}
            </p>
          </div>
          </div>
        </div>
      </template>

      <!-- Next-Upload / Standalone Export State (when layers are empty but session items exist) -->
      <template v-else>
        <div class="upload-inline glass-panel" style="margin-bottom: 1.5rem;">
          <div class="upload-inline-content">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            <span>{{ t('battlepass.upload_next') }}</span>
            <label class="btn btn-primary">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
              {{ t('battlepass.select_file') }}
              <input type="file" hidden accept="image/*" @change="handleFileUpload">
            </label>
          </div>
        </div>

        <div class="export-standalone glass-panel" style="margin-bottom: 1.5rem; display: flex; justify-content: center;">
          <button class="btn btn-primary btn-large" @click="generatePDF" :disabled="isExporting">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="16" y1="13" x2="8" y2="13"/>
              <line x1="16" y1="17" x2="8" y2="17"/>
              <polyline points="10 9 9 9 8 9"/>
            </svg>
            {{ t('battlepass.pdf_download') }} ({{ sessionItems.length }} {{ sessionItems.length === 1 ? 'Design' : 'Designs' }})
          </button>
        </div>
      </template>
    </div>

    <!-- Standalone PDF Download / Designs List (always at the bottom if designs exist) -->
    <div class="designs-section-container" v-if="sessionItems.length > 0" style="margin-top: 2rem; width: 100%;">
      <!-- Saved Designs Card -->
      <div class="session-list-card glass-panel">
        <div class="session-list-header">
          <h3>{{ t('battlepass.your_designs') }} ({{ sessionItems.length }})</h3>
          <button class="btn btn-ghost btn-small btn-danger-ghost" @click="clearSessionList" :title="t('battlepass.delete_all')">
            {{ t('battlepass.delete_all') }}
          </button>
        </div>
        <div class="session-grid">
          <div
            v-for="(item, index) in sessionItems"
            :key="item.id"
            class="session-card"
            :class="{ 'is-editing': editingItemId === item.id }"
          >
            <div class="session-card-preview">
              <img :src="item.previewDataUrl || (item.layers && item.layers[0]?.imageDataUrl)" :alt="item.imageName" />
              <span v-if="editingItemId === item.id" class="editing-badge">{{ t('battlepass.being_edited') }}</span>
            </div>
            <div class="session-card-footer">
              <span class="session-card-name">{{ index + 1 }}. {{ item.imageName }}</span>
              <div class="session-card-actions">
                <button
                  class="btn btn-ghost btn-icon"
                  @click="editItem(item)"
                  :title="t('battlepass.edit')"
                  :disabled="editingItemId === item.id"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                </button>
                <button class="btn btn-ghost btn-icon btn-remove" @click="removeItem(item.id)" :title="t('battlepass.delete')">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Export loading overlay -->
    <div class="export-overlay" v-if="isExporting">
      <div class="spinner"></div>
      <span>{{ t('battlepass.exporting') }}</span>
    </div>
  </div>
</template>

<style scoped>

.workspace-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.5rem;
  gap: 1rem;
}

.workspace-header h2 {
  margin: 0;
  font-size: 1.5rem;
  font-weight: 600;
  background: linear-gradient(135deg, #fff, #888);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

/* Glass Panel */
.glass-panel {
  background: rgba(255, 255, 255, 0.05);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  padding: 1.25rem;
}

/* Upload Section */
.upload-section {
  padding: 3rem;
}

.upload-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  text-align: center;
}

.upload-icon {
  color: #666;
  margin-bottom: 0.5rem;
}

.upload-content h3 {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 500;
}

.upload-content p {
  margin: 0;
  color: #888;
  font-size: 0.9rem;
}

/* Inline Upload */
.upload-inline {
  padding: 2rem;
}

.upload-inline-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  text-align: center;
  color: #888;
}

.upload-inline-content span {
  font-size: 0.9rem;
}

/* Standalone Export */
.export-standalone {
  display: flex;
  justify-content: center;
}

/* Layout Grid System */
.editor-layout {
  display: flex;
  flex-direction: column;
  width: 100%;
}

.editor-workspace-grid {
  display: grid;
  grid-template-columns: 1.3fr 1fr;
  gap: 1.5rem;
  width: 100%;
}

@media (max-width: 900px) {
  .editor-workspace-grid {
    grid-template-columns: 1fr;
  }
}

.viewport-column {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
}

.controls-column {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
}

/* Preview Section */
.preview-section {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-width: 0;
  overflow: hidden;
}

.preview-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.preview-title {
  font-size: 0.9rem;
  font-weight: 500;
  color: #ccc;
}

.preview-hint {
  font-size: 0.75rem;
  color: #666;
}

/* Aspect Ratio ~4.35:1 (111.55/25.64) */
.preview-viewport {
  position: relative;
  aspect-ratio: 111.55 / 25.64;
  width: 100%;
  max-width: 100%;
  background-color: #1a1a1a;
  background-image:
    linear-gradient(45deg, #252525 25%, transparent 25%),
    linear-gradient(-45deg, #252525 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #252525 75%),
    linear-gradient(-45deg, transparent 75%, #252525 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0px;
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4), inset 0 0 0 1px rgba(255, 255, 255, 0.1);
}

.layer-img {
  width: auto !important;
  max-width: none !important;
  max-height: none !important;
}

img.active-layer {
  outline: 2px dashed var(--color-primary);
  outline-offset: -2px;
}

.preview-info {
  display: flex;
  justify-content: space-between;
  font-size: 0.75rem;
  color: #666;
  font-family: monospace;
}

/* Grid overlay */
.grid-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 85;
  opacity: 0.1;
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.3) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.3) 1px, transparent 1px);
  background-size: 20% 20%;
}

/* Crosshair */
.crosshair {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 24px;
  height: 24px;
  pointer-events: none;
  z-index: 95;
}

.crosshair::before,
.crosshair::after {
  content: '';
  position: absolute;
  background: rgba(255, 255, 255, 0.3);
}

.crosshair::before {
  left: 50%;
  top: 0;
  width: 1px;
  height: 100%;
  transform: translateX(-50%);
}

.crosshair::after {
  top: 50%;
  left: 0;
  width: 100%;
  height: 1px;
  transform: translateY(-50%);
}

/* Controls Panel */
.controls-card h3,
.export-card h3 {
  margin: 0 0 1rem;
  font-size: 0.9rem;
  font-weight: 500;
  color: #aaa;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.selected-layer-name {
  font-size: 0.8rem;
  color: #888;
  margin-top: -0.5rem;
  margin-bottom: 1rem;
}

.control-group {
  margin-bottom: 1rem;
}

.control-group label {
  display: flex;
  justify-content: space-between;
  font-size: 0.8rem;
  color: #888;
  margin-bottom: 0.5rem;
}

.control-group .value {
  font-family: monospace;
  color: #aaa;
}

.control-group input[type="range"] {
  width: 100%;
  height: 6px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
  appearance: none;
  cursor: pointer;
}

.control-group input[type="range"]::-webkit-slider-thumb {
  appearance: none;
  width: 16px;
  height: 16px;
  background: var(--color-primary);
  border-radius: 50%;
  cursor: pointer;
  transition: transform 0.2s;
}

.control-group input[type="range"]::-webkit-slider-thumb:hover {
  transform: scale(1.2);
}

.blend-mode-select {
  width: 100%;
  background: #1e1e24;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 6px;
  color: #fff;
  padding: 0.5rem;
  font-size: 0.85rem;
  outline: none;
  cursor: pointer;
}

.blend-mode-select:focus {
  border-color: var(--color-primary);
}

.button-row {
  display: flex;
  gap: 0.5rem;
  margin-top: 1rem;
}

.button-row .btn {
  flex: 1;
}

.btn-full {
  width: 100%;
}

/* Layers Stack Manager */
.layers-panel {
  display: flex;
  flex-direction: column;
}

.layers-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  max-height: 250px;
  overflow-y: auto;
  padding-right: 0.25rem;
  margin-bottom: 0.5rem;
}

.layer-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 0.5rem;
  cursor: pointer;
  transition: all 0.2s;
}

.layer-item:hover {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(255, 255, 255, 0.15);
}

.layer-item.active {
  background: rgba(100, 108, 255, 0.1);
  border-color: var(--color-primary);
}

.layer-thumb {
  width: 40px;
  height: 40px;
  border-radius: 4px;
  background: #111;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255, 255, 255, 0.1);
  flex-shrink: 0;
}

.layer-thumb img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.layer-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 0.2rem;
}

.layer-name-input {
  background: transparent;
  border: none;
  border-bottom: 1px solid transparent;
  color: #fff;
  font-size: 0.85rem;
  font-weight: 500;
  padding: 0;
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.layer-name-input:focus {
  outline: none;
  border-color: var(--color-primary);
}

.layer-meta {
  font-size: 0.7rem;
  color: #666;
}

.layer-actions {
  display: flex;
  align-items: center;
  gap: 0.15rem;
}

.layer-btn {
  padding: 0.3rem;
  border-radius: 4px;
  opacity: 0.6;
}

.layer-btn:hover:not(:disabled) {
  opacity: 1;
}

.layer-btn:disabled {
  opacity: 0.25;
}

.no-layers-placeholder {
  text-align: center;
  padding: 2rem 1rem;
  color: #666;
  font-size: 0.9rem;
}

/* Export Section */
.export-buttons {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.export-secondary {
  display: flex;
  gap: 0.5rem;
}

.export-secondary .btn {
  flex: 1;
}

.export-hint {
  margin: 1rem 0 0;
  font-size: 0.75rem;
  color: #666;
  line-height: 1.5;
}

/* Saved Designs list */
.session-list-card {
  width: 100%;
}

.session-list-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
}

.session-list-header h3 {
  margin: 0;
  font-size: 0.9rem;
  font-weight: 500;
  color: #aaa;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.session-grid {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.session-card {
  background: rgba(0, 0, 0, 0.2);
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  overflow: hidden;
  transition: border-color 0.2s;
}

.session-card.is-editing {
  border-color: var(--color-primary);
  box-shadow: 0 0 12px rgba(100, 108, 255, 0.15);
}

.session-card-preview {
  position: relative;
  width: 100%;
  aspect-ratio: 4.35 / 1;
  background-color: #1a1a1a;
  background-image:
    linear-gradient(45deg, #252525 25%, transparent 25%),
    linear-gradient(-45deg, #252525 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #252525 75%),
    linear-gradient(-45deg, transparent 75%, #252525 75%);
  background-size: 12px 12px;
  background-position: 0 0, 0 6px, 6px -6px, -6px 0px;
}

.session-card-preview img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.editing-badge {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  background: var(--color-primary);
  color: white;
  padding: 0.2rem 0.6rem;
  border-radius: 4px;
  font-size: 0.7rem;
  font-weight: 500;
  letter-spacing: 0.3px;
}

.session-card-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.5rem 0.75rem;
}

.session-card-name {
  font-size: 0.85rem;
  color: #ccc;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
}

.session-card-actions {
  display: flex;
  gap: 0.25rem;
  flex-shrink: 0;
}

.session-card-actions .btn-remove:hover {
  color: #ff6b6b;
}

.btn-small {
  padding: 0.35rem 0.6rem;
  font-size: 0.8rem;
}

.btn-icon {
  padding: 0.4rem;
}

/* File info */
.file-info {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  color: #888;
  font-size: 0.8rem;
}

.filename {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Buttons */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  border-radius: 8px;
  border: 1px solid transparent;
  padding: 0.6rem 1rem;
  font-size: 0.85rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-ghost {
  background: transparent;
  color: #ccc;
  border-color: transparent;
}

.btn-ghost:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
}

.btn-secondary {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  border-color: rgba(255, 255, 255, 0.15);
}

.btn-secondary:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.15);
  border-color: rgba(255, 255, 255, 0.25);
}

.btn-primary {
  background: linear-gradient(135deg, var(--color-primary), #8b5cf6);
  color: white;
  box-shadow: 0 4px 15px rgba(100, 108, 255, 0.3);
}

.btn-primary:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 6px 20px rgba(100, 108, 255, 0.4);
}

.btn-large {
  padding: 0.9rem 1.25rem;
  font-size: 0.95rem;
}

.btn-danger-ghost {
  background: transparent;
  color: #ff6b6b;
  border-color: transparent;
}

.btn-danger-ghost:hover {
  background: rgba(255, 107, 107, 0.1);
}

/* Export Overlay */
.export-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  z-index: 150;
  backdrop-filter: blur(4px);
}

.spinner {
  width: 48px;
  height: 48px;
  border: 3px solid rgba(255, 255, 255, 0.1);
  border-top-color: var(--color-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.project-actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
</style>

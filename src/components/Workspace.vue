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
const uploadedImage = ref(null)
const uploadedImageName = ref('')
const imageScale = ref(1)
const panX = ref(0)
const panY = ref(0)
const isPanning = ref(false)
const isExporting = ref(false)
const showExportMenu = ref(false)
const autoFitApplied = ref(false)

/** Items to be rendered one below the other in PDF export. */
const sessionItems = ref([])
const editingItemId = ref(null)

const A4_WIDTH_MM = 210
const A4_HEIGHT_MM = 297
const ITEM_GAP_MM = 5

// Print dimensions from calibration (configurable per template)
const pdfItemWidthMM = computed(() => props.calibration.printWidthMM ?? 111.6)
const pdfItemHeightMM = computed(() => props.calibration.printHeightMM ?? 27)

// Load saved workspace settings
onMounted(async () => {
  const settings = await storage.loadWorkspaceSettings()
  panX.value = settings.panX
  panY.value = settings.panY
  imageScale.value = settings.scale
})

// Auto-save workspace settings
watch([panX, panY, imageScale], async () => {
  await storage.saveWorkspaceSettings({
    panX: panX.value,
    panY: panY.value,
    scale: imageScale.value
  })
}, { debounce: 500 })

// Emit content state
watch([uploadedImage, sessionItems], ([img, items]) => {
  emit('has-content', !!img || items.length > 0)
}, { immediate: true, deep: true })

// File upload
const handleFileUpload = (e) => {
  const target = e.target
  if (target.files && target.files[0]) {
    const file = target.files[0]
    uploadedImageName.value = file.name
    editingItemId.value = null
    autoFitApplied.value = false
    const reader = new FileReader()
    reader.onload = (e) => {
      const dataUrl = e.target?.result
      uploadedImage.value = dataUrl

      // Check if image matches template proportions
      const img = new Image()
      img.onload = () => {
        const uploadedAspect = img.width / img.height
        const templateAspect = props.calibration.templateWidthMM / props.calibration.templateHeightMM
        const diff = Math.abs(uploadedAspect - templateAspect) / templateAspect
        if (diff < 0.02) {
          fitToTemplate()
          autoFitApplied.value = true
        }
      }
      img.src = dataUrl
    }
    reader.readAsDataURL(file)
  }
  target.value = '' // allow re-selecting the same file
}

// Remove the uploaded image (return to upload view)
const removeImage = () => {
  uploadedImage.value = null
  uploadedImageName.value = ''
  editingItemId.value = null
  autoFitApplied.value = false
  resetPosition()
}

/** Renders a masked slot DataURL from a PrintItem + calibration (without template overlay). */
async function renderItemToMaskedDataUrl(item, calibration) {
  // Load both images, using blob fetch for cross-origin template URLs
  const [itemBlobUrl, templateBlobUrl] = await Promise.all([
    loadImageAsBlob(item.imageDataUrl),
    loadImageAsBlob(calibration.transparentTemplate)
  ])

  return new Promise((resolve, reject) => {
    const img = new Image()
    img.src = itemBlobUrl

    const templateImg = new Image()
    templateImg.src = templateBlobUrl

    const cleanup = () => {
      if (itemBlobUrl !== item.imageDataUrl) URL.revokeObjectURL(itemBlobUrl)
      if (templateBlobUrl !== calibration.transparentTemplate) URL.revokeObjectURL(templateBlobUrl)
    }

    const run = () => {
      const tw = templateImg.width
      const th = templateImg.height
      const aspect = img.width / img.height

      const cutoutLeftPx = (calibration.cutoutXMM / calibration.templateWidthMM) * tw
      const cutoutTopPx = (calibration.cutoutYMM / calibration.templateHeightMM) * th
      const cutoutWidthPx = (TARGET_WIDTH_MM / calibration.templateWidthMM) * tw
      const cutoutHeightPx = (TARGET_HEIGHT_MM / calibration.templateHeightMM) * th

      const imgHeightPx = cutoutHeightPx * item.scale
      const imgWidthPx = imgHeightPx * aspect
      const centerXpx = cutoutLeftPx + (0.5 + item.panX) * cutoutWidthPx
      const centerYpx = cutoutTopPx + (0.5 + item.panY) * cutoutHeightPx
      const drawX = centerXpx - imgWidthPx / 2
      const drawY = centerYpx - imgHeightPx / 2

      const canvas = document.createElement('canvas')
      canvas.width = tw
      canvas.height = th
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        cleanup()
        reject(new Error('Could not get canvas context'))
        return
      }

      const useDefaultMask = isDefaultCalibration(calibration)
      if (useDefaultMask) {
        ctx.clearRect(0, 0, tw, th)
        ctx.save()
        ctx.rect(cutoutLeftPx, cutoutTopPx, cutoutWidthPx, cutoutHeightPx)
        ctx.clip()
        ctx.drawImage(img, drawX, drawY, imgWidthPx, imgHeightPx)
        ctx.restore()
      } else {
        ctx.clearRect(0, 0, tw, th)
        ctx.drawImage(img, drawX, drawY, imgWidthPx, imgHeightPx)
        ctx.globalCompositeOperation = 'destination-out'
        ctx.drawImage(templateImg, 0, 0, tw, th)
      }

      cleanup()
      resolve(canvas.toDataURL('image/png'))
    }

    let done = false
    const runWhenBoth = () => {
      if (done || !img.complete || !templateImg.complete) return
      done = true
      run()
    }
    img.onload = runWhenBoth
    img.onerror = () => { cleanup(); reject(new Error('Failed to load item image')) }
    templateImg.onload = runWhenBoth
    templateImg.onerror = () => { cleanup(); reject(new Error('Failed to load template')) }
    if (img.complete && templateImg.complete) runWhenBoth()
  })
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
  if (!uploadedImage.value) return

  if (editingItemId.value) {
    // Update existing item in-place
    const idx = sessionItems.value.findIndex(i => i.id === editingItemId.value)
    if (idx !== -1) {
      const updated = {
        ...sessionItems.value[idx],
        imageDataUrl: uploadedImage.value,
        imageName: uploadedImageName.value || 'Bild',
        panX: panX.value,
        panY: panY.value,
        scale: imageScale.value,
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
      imageDataUrl: uploadedImage.value,
      imageName: uploadedImageName.value || 'Bild',
      panX: panX.value,
      panY: panY.value,
      scale: imageScale.value,
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
  uploadedImage.value = item.imageDataUrl
  uploadedImageName.value = item.imageName
  panX.value = item.panX
  panY.value = item.panY
  imageScale.value = item.scale
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
  if (uploadedImage.value)
    return [
      {
        id: 'current',
        imageDataUrl: uploadedImage.value,
        imageName: uploadedImageName.value || 'Bild',
        panX: panX.value,
        panY: panY.value,
        scale: imageScale.value
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
  if (!uploadedImage.value) return

  isExporting.value = true
  showExportMenu.value = false

  try {
    const img = new Image()
    img.src = uploadedImage.value

    await new Promise((resolve) => {
      img.onload = () => {
        const aspect = img.width / img.height
        const svgWidth = TARGET_WIDTH_MM * 10 // Scale for better resolution
        const svgHeight = TARGET_HEIGHT_MM * 10

        const drawHeight = svgHeight * imageScale.value
        const drawWidth = drawHeight * aspect

        const centerX = (0.5 + panX.value) * svgWidth
        const centerY = (0.5 + panY.value) * svgHeight

        const drawX = centerX - (drawWidth / 2)
        const drawY = centerY - (drawHeight / 2)

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
    <image x="${drawX}" y="${drawY}" width="${drawWidth}" height="${drawHeight}"
           xlink:href="${uploadedImage.value}"
           preserveAspectRatio="xMidYMid slice"/>
  </g>
</svg>`

        const blob = new Blob([svg], { type: 'image/svg+xml' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'battlepass-cutout.svg'
        a.click()
        URL.revokeObjectURL(url)

        resolve()
      }
    })
  } finally {
    isExporting.value = false
  }
}

// PNG Export (high resolution)
const exportPNG = async () => {
  if (!uploadedImage.value) return

  isExporting.value = true
  showExportMenu.value = false

  try {
    const img = new Image()
    img.src = uploadedImage.value

    await new Promise((resolve) => {
      img.onload = () => {
        // High resolution export (300 DPI equivalent)
        const scale = 4
        const canvasWidth = Math.round(TARGET_WIDTH_MM * 11.811 * scale) // mm to px at 300dpi
        const canvasHeight = Math.round(TARGET_HEIGHT_MM * 11.811 * scale)

        const canvas = document.createElement('canvas')
        canvas.width = canvasWidth
        canvas.height = canvasHeight

        const ctx = canvas.getContext('2d')
        if (!ctx) return

        // Fill with transparency
        ctx.clearRect(0, 0, canvasWidth, canvasHeight)

        const aspect = img.width / img.height
        const drawHeight = canvasHeight * imageScale.value
        const drawWidth = drawHeight * aspect

        const centerX = (0.5 + panX.value) * canvasWidth
        const centerY = (0.5 + panY.value) * canvasHeight

        const drawX = centerX - (drawWidth / 2)
        const drawY = centerY - (drawHeight / 2)

        // Create rounded clip path
        const radius = 20 * scale
        ctx.beginPath()
        ctx.roundRect(0, 0, canvasWidth, canvasHeight, radius)
        ctx.clip()

        ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight)

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
      }
    })
  } finally {
    isExporting.value = false
  }
}

// Fit image width to template cutout width
const fitToTemplate = () => {
  const cal = props.calibration
  imageScale.value = cal.templateWidthMM / TARGET_WIDTH_MM
  panX.value = cal.templateWidthMM / (2 * TARGET_WIDTH_MM) - cal.cutoutXMM / TARGET_WIDTH_MM - 0.5
  panY.value = cal.templateHeightMM / (2 * TARGET_HEIGHT_MM) - cal.cutoutYMM / TARGET_HEIGHT_MM - 0.5
}

// Reset position
const resetPosition = () => {
  panX.value = 0
  panY.value = 0
  imageScale.value = 1
  autoFitApplied.value = false
}

// Pan Logic with improved sensitivity
const startPan = (e) => {
  if (e.button !== 0) return
  isPanning.value = true
}

const onPan = (e) => {
  if (!isPanning.value) return
  const sensitivity = 0.002
  panX.value += e.movementX * sensitivity
  panY.value += e.movementY * sensitivity
}

const stopPan = () => {
  isPanning.value = false
}

// Wheel zoom
const handleWheel = (e) => {
  e.preventDefault()
  const delta = e.deltaY > 0 ? -0.05 : 0.05
  imageScale.value = Math.max(0.1, Math.min(10, imageScale.value + delta))
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
  zIndex: 10
}))

const userImageStyle = computed(() => ({
  height: '100%',
  position: 'absolute',
  left: `${(0.5 + panX.value) * 100}%`,
  top: `${(0.5 + panY.value) * 100}%`,
  transform: `translate(-50%, -50%) scale(${imageScale.value})`,
  transformOrigin: 'center',
  userSelect: 'none',
  pointerEvents: 'none',
  zIndex: 1
}))
</script>

<template>
  <div class="workspace">
    <div class="workspace-header">
      <h2>{{ t('battlepass.workspace') }}</h2>
    </div>

    <!-- Upload Section (nur wenn kein Bild UND keine Session-Items) -->
    <div class="upload-section glass-panel" v-if="!uploadedImage && sessionItems.length === 0">
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
        <label class="btn btn-primary">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          {{ t('battlepass.select_file') }}
          <input type="file" hidden accept="image/*" @change="handleFileUpload">
        </label>
      </div>
    </div>

    <!-- Editor Layout (Bild geladen ODER Session-Items vorhanden) -->
    <div class="editor-layout" v-else>
      <div class="preview-column">
        <div class="preview-section" v-if="uploadedImage">
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
            <img :src="uploadedImage" :style="userImageStyle" draggable="false" alt="Uploaded image" />
            <img v-if="calibration.transparentTemplate" :src="calibration.transparentTemplate" :style="templateStyle" draggable="false" alt="Template overlay" />

            <!-- Grid overlay for alignment help -->
            <div class="grid-overlay"></div>

            <!-- Center crosshair -->
            <div class="crosshair"></div>
          </div>

          <div class="preview-info">
            <span>{{ t('battlepass.position') }}: {{ (panX * 100).toFixed(1) }}%, {{ (panY * 100).toFixed(1) }}%</span>
            <span>{{ t('battlepass.zoom') }}: {{ Math.round(imageScale * 100) }}%</span>
          </div>

          <div class="auto-fit-hint" v-if="autoFitApplied">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M20 6L9 17l-5-5"/>
            </svg>
            {{ t('battlepass.autofit_hint') }}
          </div>
        </div>

        <!-- Kompakter Upload-Bereich wenn kein Bild aber Session-Items vorhanden -->
        <div class="upload-inline glass-panel" v-if="!uploadedImage && sessionItems.length > 0">
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

        <!-- Standalone Export wenn kein Bild aber Session-Items vorhanden -->
        <div class="export-standalone glass-panel" v-if="!uploadedImage && sessionItems.length > 0">
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

        <!-- Bildeinstellungen & Export unter der Vorschau, gleiche Breite wie Vorschau -->
        <div class="controls-below-preview" v-if="uploadedImage">
          <div class="controls-card glass-panel">
            <h3>{{ t('battlepass.image_settings') }}</h3>

            <div class="control-group">
              <label>
                <span>{{ t('battlepass.scale') }}</span>
                <span class="value">{{ Math.round(imageScale * 100) }}%</span>
              </label>
              <input
                type="range"
                min="0.1"
                max="10"
                step="0.01"
                v-model.number="imageScale"
              >
            </div>

            <div class="control-group">
              <label>
                <span>{{ t('battlepass.horizontal') }}</span>
                <span class="value">{{ (panX * 100).toFixed(1) }}%</span>
              </label>
              <input
                type="range"
                min="-5"
                max="5"
                step="0.01"
                v-model.number="panX"
              >
            </div>

            <div class="control-group">
              <label>
                <span>{{ t('battlepass.vertical') }}</span>
                <span class="value">{{ (panY * 100).toFixed(1) }}%</span>
              </label>
              <input
                type="range"
                min="-5"
                max="5"
                step="0.01"
                v-model.number="panY"
              >
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
              <label class="btn btn-secondary" :title="t('battlepass.change_image')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                  <circle cx="9" cy="9" r="2"/>
                  <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>
                </svg>
                {{ t('battlepass.change_image') }}
                <input type="file" hidden accept="image/*" @change="handleFileUpload">
              </label>

              <button class="btn btn-secondary btn-remove" @click="removeImage" :title="t('battlepass.remove_image')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                </svg>
                {{ t('battlepass.remove_image') }}
              </button>
            </div>
          </div>

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

        <!-- Deine Designs -->
        <div class="session-list-card glass-panel" v-if="sessionItems.length > 0">
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
                <img :src="item.previewDataUrl || item.imageDataUrl" :alt="item.imageName" />
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

        <!-- Current file info -->
        <div class="file-info glass-panel" v-if="uploadedImageName">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
            <circle cx="9" cy="9" r="2"/>
            <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>
          </svg>
          <span class="filename">{{ uploadedImageName }}</span>
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
.workspace {
  width: 100%;
  max-width: 1100px;
}

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

/* Inline Upload (kompakt, wenn Session-Items vorhanden) */
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

/* Standalone Export (kein Bild, aber Session-Items) */
.export-standalone {
  display: flex;
  justify-content: center;
}

/* Editor Layout */
.editor-layout {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 100%;
}

.preview-column {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-width: 0;
  width: 100%;
}

/* Bildeinstellungen & Export unter der Vorschau */
.controls-below-preview {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
  width: 100%;
  min-width: 0;
}

@media (max-width: 600px) {
  .controls-below-preview {
    grid-template-columns: 1fr;
  }
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
  min-height: 180px;
  max-height: min(60vh, 100vw / 4.35);
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

.preview-info {
  display: flex;
  justify-content: space-between;
  font-size: 0.75rem;
  color: #666;
  font-family: monospace;
}

.auto-fit-hint {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.8rem;
  color: #00c864;
  padding: 0.4rem 0.75rem;
  background: rgba(0, 200, 100, 0.1);
  border-radius: 6px;
  border: 1px solid rgba(0, 200, 100, 0.2);
}

/* Grid overlay */
.grid-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 5;
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
  z-index: 15;
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

.controls-card h3,
.export-card h3 {
  margin: 0 0 1rem;
  font-size: 0.9rem;
  font-weight: 500;
  color: #aaa;
  text-transform: uppercase;
  letter-spacing: 0.5px;
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

.button-row {
  display: flex;
  gap: 0.5rem;
  margin-top: 1rem;
}

.button-row .btn {
  flex: 1;
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

/* Deine Designs */
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
  z-index: 100;
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
</style>

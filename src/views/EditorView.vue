<script setup>
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import Workspace from '../components/Workspace.vue'
import { storage, DEFAULT_CALIBRATION, isDefaultCalibration } from '../utils/storage'
import { makeColorTransparent } from '../utils/imageProcessing'

const { t } = useI18n()
const calibrationData = ref(null)
const isLoading = ref(true)

const hasWorkspaceContent = ref(false)

function handleContentChange(hasContent) {
  hasWorkspaceContent.value = hasContent
}

/**
 * Prepare the default template by making the gray cutout area transparent.
 * Only removes the gray body color (rgb ~131,146,153) – the white frame
 * and colorful design elements remain visible as the overlay.
 */
async function prepareDefaultTemplate(calibration) {
  try {
    const transparentDataUrl = await makeColorTransparent(
      calibration.transparentTemplate,
      { r: 131, g: 146, b: 153 },
      calibration.transparencyTolerance ?? 30
    )
    return { ...calibration, transparentTemplate: transparentDataUrl }
  } catch (e) {
    console.error('Failed to prepare default template transparency:', e)
    return calibration
  }
}

onMounted(async () => {
  try {
    await storage.migrateFromLocalStorage()

    // Load local calibration from IndexedDB
    const local = await storage.loadCalibration()
    if (local?.templateWidthMM && local?.transparentTemplate) {
      calibrationData.value = local
    } else {
      // Use built-in default and apply transparency
      calibrationData.value = await prepareDefaultTemplate(DEFAULT_CALIBRATION)
    }
  } catch (e) {
    console.error('Failed to load calibration config', e)
    calibrationData.value = await prepareDefaultTemplate(DEFAULT_CALIBRATION)
  } finally {
    isLoading.value = false
  }
})
</script>

<template>
  <div class="editor-view">
    <!-- Loading state -->
    <div v-if="isLoading" class="loading-screen">
      <div class="loader">
        <div class="loader-ring"></div>
        <span>{{ t('battlepass.loading') }}</span>
      </div>
    </div>

    <template v-else>
      <!-- Page Header with Description and Preview Tile -->
      <transition name="fade-slide">
        <div class="page-header" v-if="!hasWorkspaceContent">
          <div class="header-content">
            <h1 class="page-title">{{ t('battlepass.battlepass_link') }}</h1>
            <p class="page-description">{{ t('battlepass.editor_description') }}</p>
          </div>
          <div class="header-preview">
            <div class="preview-tile">
              <img src="/Bilder/battlepass-preview.png" alt="Battle Pass Preview" class="preview-image" />
              <div class="tile-badge">{{ t('battlepass.preview') }}</div>
            </div>
          </div>
        </div>
      </transition>

      <!-- Workspace -->
      <Workspace
        v-if="calibrationData"
        :calibration="calibrationData"
        :is-using-default-calibration="false"
        @has-content="handleContentChange"
      />
    </template>
  </div>
</template>

<style scoped>
.editor-view {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 2rem 1rem;
  max-width: 1200px;
  margin: 0 auto;
}

.page-header {
  display: flex;
  align-items: center;
  gap: 3rem;
  margin-bottom: 4rem;
  text-align: left;
  width: 100%;
}

.header-content {
  flex: 1;
}

.page-title {
  font-size: 3rem;
  font-weight: 800;
  margin-bottom: 1.5rem;
  background: linear-gradient(135deg, var(--color-primary) 0%, #a855f7 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  letter-spacing: -0.03em;
  line-height: 1.1;
}

.page-description {
  font-size: 1.25rem;
  line-height: 1.6;
  color: var(--color-text-muted, #94a3b8);
}

.header-preview {
  flex: 1;
  display: flex;
  justify-content: center;
}

.preview-tile {
  position: relative;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 20px;
  padding: 1rem;
  backdrop-filter: blur(10px);
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
  transition: transform 0.3s ease, box-shadow 0.3s ease;
  max-width: 450px;
}

.preview-tile:hover {
  transform: translateY(-5px) scale(1.02);
  box-shadow: 0 35px 60px -15px rgba(0, 0, 0, 0.6);
  border-color: var(--color-primary);
}

.preview-image {
  width: 100%;
  height: auto;
  border-radius: 12px;
  display: block;
}

.tile-badge {
  position: absolute;
  top: -12px;
  right: 20px;
  background: var(--color-primary);
  color: white;
  padding: 0.4rem 1rem;
  border-radius: 99px;
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.3);
}

@media (max-width: 968px) {
  .page-header {
    flex-direction: column;
    text-align: center;
    gap: 2rem;
  }
  
  .page-title {
    font-size: 2.5rem;
  }

  .header-preview {
    width: 100%;
  }
}

/* Animations */
.fade-slide-enter-active,
.fade-slide-leave-active {
  transition: all 0.5s cubic-bezier(0.4, 0, 0.2, 1);
}

.fade-slide-enter-from,
.fade-slide-leave-to {
  opacity: 0;
  transform: translateY(-20px);
  max-height: 0;
  margin-bottom: 0;
  padding-top: 0;
  padding-bottom: 0;
  overflow: hidden;
}

.loading-screen {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-bg);
  z-index: 100;
}

.loader {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  color: #888;
}

.loader-ring {
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

/**
 * Persistent Storage Service using IndexedDB
 * Handles workspace settings and calibration data
 */

const DB_NAME = 'BattlepassPrinterDB'
const DB_VERSION = 1
const STORE_NAME = 'config'

/** Path to the default template – BASE_URL handles local vs. GitHub Pages correctly */
export const DEFAULT_TEMPLATE_PATH = `${import.meta.env.BASE_URL}template.png`

/**
 * Default calibration matched to the bundled template.png (1024×282px).
 * Gray cutout area: x=36..997, y=27..247 → 961×220px
 */
export const DEFAULT_CALIBRATION = {
    templateWidthMM: 118.86,
    templateHeightMM: 32.87,
    cutoutXMM: 4.18,
    cutoutYMM: 3.15,
    transparentTemplate: DEFAULT_TEMPLATE_PATH,
    sourceImage: DEFAULT_TEMPLATE_PATH,
    transparencyTolerance: 30,
    boxPosition: { x: 3.52, y: 9.57, width: 93.85 },
    printWidthMM: 111.6,
    printHeightMM: 27
}

/** Checks if the calibration is the built-in default */
export function isDefaultCalibration(calibration) {
    return calibration.transparentTemplate === DEFAULT_TEMPLATE_PATH ||
        calibration.transparentTemplate.endsWith('template.png')
}

const DEFAULT_WORKSPACE = {
    panX: 0,
    panY: 0,
    scale: 1
}

class StorageService {
    constructor() {
        this.db = null
        this.initPromise = null
    }

    async init() {
        if (this.db) return
        if (this.initPromise) return this.initPromise

        this.initPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION)

            request.onerror = () => {
                console.error('Failed to open IndexedDB:', request.error)
                reject(request.error)
            }

            request.onsuccess = () => {
                this.db = request.result
                resolve()
            }

            request.onupgradeneeded = (event) => {
                const db = event.target.result

                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'id' })
                }
            }
        })

        return this.initPromise
    }

    async getStore(mode = 'readonly') {
        await this.init()
        if (!this.db) throw new Error('Database not initialized')

        const transaction = this.db.transaction(STORE_NAME, mode)
        return transaction.objectStore(STORE_NAME)
    }

    async saveCalibration(data) {
        await this.init()
        if (!this.db) throw new Error('Database not initialized')

        const config = await this.loadConfig()

        const calibrationPlain = JSON.parse(JSON.stringify(data))
        const workspacePlain = JSON.parse(
            JSON.stringify(config?.workspace ?? DEFAULT_WORKSPACE)
        )

        const updatedConfig = {
            id: 'main',
            calibration: calibrationPlain,
            workspace: workspacePlain,
            version: 1,
            lastUpdated: new Date().toISOString()
        }

        const transaction = this.db.transaction(STORE_NAME, 'readwrite')
        const store = transaction.objectStore(STORE_NAME)

        return new Promise((resolve, reject) => {
            const request = store.put(updatedConfig)
            request.onsuccess = () => resolve()
            request.onerror = () => reject(request.error)
        })
    }

    async saveWorkspaceSettings(settings) {
        await this.init()
        if (!this.db) throw new Error('Database not initialized')

        const config = await this.loadConfig()

        const updatedConfig = {
            id: 'main',
            calibration: config?.calibration ?? null,
            workspace: { ...(config?.workspace ?? DEFAULT_WORKSPACE), ...settings },
            version: 1,
            lastUpdated: new Date().toISOString()
        }

        const transaction = this.db.transaction(STORE_NAME, 'readwrite')
        const store = transaction.objectStore(STORE_NAME)

        return new Promise((resolve, reject) => {
            const request = store.put(updatedConfig)
            request.onsuccess = () => resolve()
            request.onerror = () => reject(request.error)
        })
    }

    async loadConfig() {
        try {
            const store = await this.getStore('readonly')

            return new Promise((resolve, reject) => {
                const request = store.get('main')
                request.onsuccess = () => resolve(request.result ?? null)
                request.onerror = () => reject(request.error)
            })
        } catch {
            return null
        }
    }

    async loadCalibration() {
        const config = await this.loadConfig()
        return config?.calibration ?? null
    }

    async loadWorkspaceSettings() {
        const config = await this.loadConfig()
        return config?.workspace ?? DEFAULT_WORKSPACE
    }

    async clearAll() {
        const store = await this.getStore('readwrite')

        return new Promise((resolve, reject) => {
            const request = store.delete('main')
            request.onsuccess = () => resolve()
            request.onerror = () => reject(request.error)
        })
    }

    async clearCalibration() {
        await this.init()
        if (!this.db) throw new Error('Database not initialized')

        const config = await this.loadConfig()
        if (!config) return

        const updatedConfig = {
            id: 'main',
            calibration: null,
            workspace: config.workspace,
            version: 1,
            lastUpdated: new Date().toISOString()
        }

        const transaction = this.db.transaction(STORE_NAME, 'readwrite')
        const store = transaction.objectStore(STORE_NAME)

        return new Promise((resolve, reject) => {
            const request = store.put(updatedConfig)
            request.onsuccess = () => resolve()
            request.onerror = () => reject(request.error)
        })
    }

    async migrateFromLocalStorage() {
        const oldKey = 'battlepass_printer_config_v1'
        const savedData = localStorage.getItem(oldKey)

        if (savedData) {
            try {
                const parsed = JSON.parse(savedData)
                if (parsed.templateWidthMM && parsed.transparentTemplate) {
                    await this.saveCalibration(parsed)
                    localStorage.removeItem(oldKey)
                    return true
                }
            } catch (e) {
                console.error('Failed to migrate from localStorage:', e)
            }
        }
        return false
    }
}

export const storage = new StorageService()

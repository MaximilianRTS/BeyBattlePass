/**
 * Loads an image as a blob URL to avoid CORS canvas taint issues.
 * Falls back to the original URL for local/data URLs.
 */
export const loadImageAsBlob = async (src) => {
    if (!src || src.startsWith('data:') || src.startsWith('/') || src.startsWith('blob:')) {
        return src
    }
    const response = await fetch(src)
    const blob = await response.blob()
    return URL.createObjectURL(blob)
}

/**
 * Loads an Image element from a source, using blob fetch for cross-origin URLs.
 */
export const loadImage = (src) => {
    return new Promise(async (resolve, reject) => {
        try {
            const blobUrl = await loadImageAsBlob(src)
            const img = new Image()
            img.onload = () => resolve({ img, blobUrl })
            img.onerror = (err) => reject(err)
            img.src = blobUrl
        } catch (err) {
            reject(err)
        }
    })
}

/**
 * Removes a specific color from an image by setting its alpha channel to 0.
 * @param {string} imageSrc The source image URL/DataURL
 * @param {{ r: number, g: number, b: number }} targetColor The color to remove
 * @param {number} tolerance Tolerance level (0-255) for color matching
 * @returns {Promise<string>} Promise resolving to the processed image DataURL
 */
export const makeColorTransparent = async (imageSrc, targetColor, tolerance = 30) => {
    const { img, blobUrl } = await loadImage(imageSrc)

    const canvas = document.createElement('canvas')
    canvas.width = img.width
    canvas.height = img.height
    const ctx = canvas.getContext('2d')

    if (!ctx) {
        throw new Error('Could not get canvas context')
    }

    ctx.drawImage(img, 0, 0)

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const data = imageData.data

    const { r, g, b } = targetColor

    for (let i = 0; i < data.length; i += 4) {
        const pr = data[i] ?? 0
        const pg = data[i + 1] ?? 0
        const pb = data[i + 2] ?? 0

        const distance = Math.sqrt(
            Math.pow(pr - r, 2) +
            Math.pow(pg - g, 2) +
            Math.pow(pb - b, 2)
        )

        if (distance <= tolerance) {
            data[i + 3] = 0 // Set Alpha to 0
        }
    }

    ctx.putImageData(imageData, 0, 0)

    // Clean up blob URL if we created one
    if (blobUrl !== imageSrc) {
        URL.revokeObjectURL(blobUrl)
    }

    return canvas.toDataURL('image/png')
}

/**
 * Finds the bounding box of all transparent pixels (alpha === 0) in an image.
 * @param {string} imageSrc - Data URL or image source
 * @returns {Promise<{x: number, y: number, width: number, height: number, imgWidth: number, imgHeight: number} | null>}
 *   Returns null if no transparent pixels found.
 */
export const findTransparentBounds = async (imageSrc) => {
    const { img, blobUrl } = await loadImage(imageSrc)

    const canvas = document.createElement('canvas')
    canvas.width = img.width
    canvas.height = img.height
    const ctx = canvas.getContext('2d')

    if (!ctx) {
        if (blobUrl !== imageSrc) URL.revokeObjectURL(blobUrl)
        throw new Error('Could not get canvas context')
    }

    ctx.drawImage(img, 0, 0)

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const data = imageData.data
    const w = canvas.width
    const h = canvas.height

    let minX = w
    let minY = h
    let maxX = -1
    let maxY = -1

    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) {
            const pixelIndex = i / 4
            const x = pixelIndex % w
            const y = Math.floor(pixelIndex / w)

            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
        }
    }

    if (blobUrl !== imageSrc) URL.revokeObjectURL(blobUrl)

    if (maxX < 0 || maxY < 0) return null

    return {
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
        imgWidth: w,
        imgHeight: h
    }
}

export const hexToRgb = (hex) => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
    if (!result) return null

    return {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    }
}

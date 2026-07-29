import sharp from 'sharp'
import { config } from '../config.js'

/**
 * Prepare a user-supplied reference for the model.
 *
 * The original stays on disk at full size for `analyze_reference` / `import_image`, which want real
 * detail. What goes into the conversation is downscaled — providers reject very large images, and a
 * 4000px photo costs a fortune in image tokens to convey the same information.
 */
export async function toReferenceDataUri(buffer: Buffer): Promise<string> {
  const resized = await sharp(buffer)
    .rotate() // honour EXIF orientation before we discard the metadata
    .resize(config.referenceMaxPx, config.referenceMaxPx, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .png()
    .toBuffer()

  return `data:image/png;base64,${resized.toString('base64')}`
}

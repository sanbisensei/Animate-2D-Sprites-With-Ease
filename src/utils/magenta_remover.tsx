import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Upload,
  Download,
  Trash2,
  ShieldCheck,
  Sliders,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  RotateCcw,
  FileArchive,
  ZoomIn,
  ZoomOut,
  Eye,
  X,
  Image as ImageIcon,
  Info,
  Crosshair,
  Grid,
  Pipette,
  Wand2,
  Eraser,
  Paintbrush,
  Layers,
  Sun,
  Moon
} from 'lucide-react';

// ============================================================================
// UTILITY 1: SMART MULTI-SHADE MAGENTA & HALO REMOVAL ENGINE
// ============================================================================

/**
 * Samples the 4 corners and perimeter of an ImageData buffer to automatically
 * detect the dominant background shade(s), even if JPG compression shifted #FF00FF.
 */
function autoDetectBackgroundColors(imageData) {
  const { width, height, data } = imageData;
  const sampleCoords = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
    [Math.floor(width / 2), 0],
    [0, Math.floor(height / 2)],
    [width - 1, Math.floor(height / 2)]
  ];

  const picked = [];
  for (const [x, y] of sampleCoords) {
    const idx = (y * width + x) * 4;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    const a = data[idx + 3];
    if (a < 128) continue;

    // Avoid duplicates within close RGB distance
    const exists = picked.some(
      (c) => Math.hypot(c.r - r, c.g - g, c.b - b) < 12
    );
    if (!exists) {
      picked.push({
        r,
        g,
        b,
        hex:
          '#' +
          [r, g, b]
            .map((v) => v.toString(16).padStart(2, '0'))
            .join('')
            .toUpperCase()
      });
    }
  }

  // Always ensure pure #FF00FF is included as a reference target
  const hasPureMagenta = picked.some(
    (c) => Math.hypot(c.r - 255, c.g - 0, c.b - 255) < 10
  );
  if (!hasPureMagenta) {
    picked.unshift({ r: 255, g: 0, b: 255, hex: '#FF00FF' });
  }

  return picked.slice(0, 6);
}

/**
 * Multi-Algorithm Chroma Key & Multi-Shade Magenta Removal Engine.
 *
 * Designed specifically for pixel-art characters (like dark-armored / crimson vampire knights)
 * on noisy / multi-shade magenta JPG or PNG backgrounds:
 *
 * 1. SMART MULTI-SHADE MAGENTA MODE ('smart'):
 *    - Evaluates "Magenta Dominance" = min(R, B) - G alongside Blue-to-Red balance.
 *    - Why this works so well: A character's dark red cape or skin tone has Red > Green,
 *      but Blue is LOW, so `min(R, B) - G` is very small or negative.
 *      In contrast, ANY shade of magenta/pink/fuchsia (#FF00FF, #E208E0, #FF44FF, #B814B8)
 *      has BOTH Red and Blue significantly higher than Green!
 *    - Also checks Euclidean RGB distance against all user-sampled & auto-sampled background shades.
 *
 * 2. COLOR DISTANCE / SAMPLED SHADES MODE ('tolerance'):
 *    - Removes pixels within `tolerance` Euclidean distance of #FF00FF or any eyedropped shade.
 *
 * 3. EXACT #FF00FF MODE ('exact'):
 *    - Strictly removes only R=255, G=0, B=255.
 *
 * 4. EDGE HALO DE-FRINGE & SPILL SUPPRESSION:
 *    - JPG compression blends the magenta background into black/dark armor outlines, leaving
 *      glowing pink/purple edge fringes.
 *    - When `defringe > 0`, boundary pixels next to transparent pixels have their excess
 *      magenta spill neutralized (clamping B and R toward G on dark outlines) and/or choked.
 */
function processMagentaRemoval(
  sourceImageData: any,
  {
    mode = 'smart',
    tolerance = 55,
    magentaDominance = 42,
    defringe = 75,
    edgeChoke = 1,
    sampledColors = [{ r: 255, g: 0, b: 255, hex: '#FF00FF' }],
    manualMask = null // Optional Int8Array: -1 = force erase, 1 = force keep
  }: any = {}
): Promise<{
  blob: Blob;
  url: string;
  removedCount: number;
  totalPixels: number;
}> {
  return new Promise((resolve, reject) => {
    try {
      const width = sourceImageData.width;
      const height = sourceImageData.height;
      const srcData = sourceImageData.data;
      const totalPixels = width * height;

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = false;

      const outputImageData = new ImageData(
        new Uint8ClampedArray(srcData),
        width,
        height
      );
      const data = outputImageData.data;

      // Precompute squared tolerance threshold
      const toleranceSq = tolerance * tolerance;
      const activeColors =
        sampledColors && sampledColors.length > 0
          ? sampledColors
          : [{ r: 255, g: 0, b: 255 }];

      let removedCount = 0;

      // PASS 1: Primary Background Classification
      for (let p = 0; p < totalPixels; p++) {
        const i = p * 4;
        const a = data[i + 3];
        if (a === 0) continue;

        // Check manual brush overrides first
        if (manualMask) {
          if (manualMask[p] === -1) {
            data[i + 3] = 0;
            removedCount++;
            continue;
          } else if (manualMask[p] === 1) {
            continue;
          }
        }

        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        if (mode === 'exact') {
          if (r === 255 && g === 0 && b === 255) {
            data[i + 3] = 0;
            removedCount++;
          }
          continue;
        }

        // Check Euclidean RGB distance against all sampled background shades
        let matchedSample = false;
        let minSampleDistSq = Infinity;

        for (let c = 0; c < activeColors.length; c++) {
          const col = activeColors[c];
          const dr = r - col.r;
          const dg = g - col.g;
          const db = b - col.b;
          const dSq = dr * dr + dg * dg + db * db;
          if (dSq < minSampleDistSq) {
            minSampleDistSq = dSq;
          }
          if (dSq <= toleranceSq) {
            matchedSample = true;
            break;
          }
        }

        if (matchedSample) {
          data[i + 3] = 0;
          removedCount++;
          continue;
        }

        // In 'smart' mode, also catch ANY shade of magenta/fuchsia/pink compression blocks
        // while strictly protecting dark crimson reds (where Blue is much lower than Red)
        if (mode === 'smart') {
          // Magenta requires BOTH Red and Blue to be elevated above Green,
          // AND Blue must be comparable to Red (unlike crimson/red/skin where R >> B).
          const minRB = r < b ? r : b;
          const magScore = minRB - g; // High when both R and B are strong and G is low
          const rbBalance = Math.abs(r - b);

          // Adaptive threshold based on user slider (magentaDominance: 10..90, default ~42)
          // Lower slider value = more aggressive magenta shade removal
          const requiredMagScore = Math.max(18, 105 - magentaDominance);

          // Protect crimson red & warm skin tones: in magenta, B is at least 65% of R (or B >= R)
          const isTrueMagentaHue =
            b >= r * 0.68 &&
            r >= b * 0.55 &&
            r > 75 &&
            b > 75 &&
            g < Math.min(r, b) * 0.72;

          if (isTrueMagentaHue && magScore >= requiredMagScore && rbBalance < 95) {
            data[i + 3] = 0;
            removedCount++;
          }
        }
      }

      // PASS 2: Optional Edge Choke / Specular JPG Artifact Cleanup (1px - 2px)
      // Removes thin 1-pixel magenta-tinted halo rings hugging the character outline
      if (mode !== 'exact' && edgeChoke > 0) {
        for (let pass = 0; pass < edgeChoke; pass++) {
          const alphaSnapshot = new Uint8Array(totalPixels);
          for (let p = 0; p < totalPixels; p++) {
            alphaSnapshot[p] = data[p * 4 + 3];
          }

          for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
              const p = y * width + x;
              if (alphaSnapshot[p] === 0) continue;
              if (manualMask && manualMask[p] === 1) continue;

              // Count transparent 4-neighbors
              let transNeighbors = 0;
              if (alphaSnapshot[p - 1] === 0) transNeighbors++;
              if (alphaSnapshot[p + 1] === 0) transNeighbors++;
              if (alphaSnapshot[p - width] === 0) transNeighbors++;
              if (alphaSnapshot[p + width] === 0) transNeighbors++;

              if (transNeighbors === 0) continue;

              const i = p * 4;
              const r = data[i];
              const g = data[i + 1];
              const b = data[i + 2];

              // Isolated single/double stray pixel surrounded by transparency
              if (transNeighbors >= 3) {
                data[i + 3] = 0;
                removedCount++;
                continue;
              }

              // Boundary pixel with strong magenta tint (JPEG ringing artifact on the edge)
              const minRB = r < b ? r : b;
              const edgeMagTint = minRB - g;
              const isPinkishEdge =
                b >= r * 0.62 && edgeMagTint > 22 && (r > 95 || b > 95);

              if (isPinkishEdge) {
                data[i + 3] = 0;
                removedCount++;
              }
            }
          }
        }
      }

      // PASS 3: Edge De-fringe / Magenta Spill Neutralization
      // Neutralizes purple/magenta color cast blended into dark armor/hair outlines on JPGs
      if (mode !== 'exact' && defringe > 0) {
        const strength = defringe / 100; // 0.0 to 1.0
        const alphaMap = new Uint8Array(totalPixels);
        for (let p = 0; p < totalPixels; p++) {
          alphaMap[p] = data[p * 4 + 3];
        }

        for (let y = 1; y < height - 1; y++) {
          for (let x = 1; x < width - 1; x++) {
            const p = y * width + x;
            if (alphaMap[p] === 0) continue;
            if (manualMask && manualMask[p] === 1) continue;

            // Check if pixel is within 1-2 pixels of a transparent background pixel
            const isNearEdge =
              alphaMap[p - 1] === 0 ||
              alphaMap[p + 1] === 0 ||
              alphaMap[p - width] === 0 ||
              alphaMap[p + width] === 0 ||
              alphaMap[p - width - 1] === 0 ||
              alphaMap[p - width + 1] === 0 ||
              alphaMap[p + width - 1] === 0 ||
              alphaMap[p + width + 1] === 0;

            if (!isNearEdge) continue;

            const i = p * 4;
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];

            // Detect magenta spill: Blue is significantly elevated alongside Red over Green.
            // (True crimson armor details have high R but low B; magenta spill has high B!)
            const minRB = r < b ? r : b;
            const magentaSpill = minRB - g;

            if (magentaSpill > 10 && b > g + 12 && b >= r * 0.55) {
              // Suppress the magenta spill by pulling R and B down toward the neutral luminance/Green channel
              const spillAmount = magentaSpill * strength;
              const targetNeutral = Math.round(g + (minRB - g) * (1 - strength));

              data[i] = Math.max(g, Math.round(r - spillAmount * 0.85));
              data[i + 2] = Math.max(g, Math.min(b, targetNeutral));

              // If the edge pixel was mostly bright magenta halo, semi-feather its alpha
              if (magentaSpill > 65 && r > 130 && b > 130) {
                data[i + 3] = Math.round(data[i + 3] * (1 - strength * 0.75));
              }
            }
          }
        }
      }

      ctx.putImageData(outputImageData, 0, 0);

      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('Failed to encode transparent PNG output.'));
          return;
        }
        const url = URL.createObjectURL(blob);
        resolve({
          blob,
          url,
          removedCount,
          totalPixels
        });
      }, 'image/png');
    } catch (err) {
      reject(err);
    }
  });
}

// ============================================================================
// UTILITY 2: DOWNLOAD & ZERO-DEPENDENCY LOCAL ZIP BUILDER (utils/downloadImage.js)
// ============================================================================

/**
 * Formats output filename: "vampire-knight.jpg" -> "vampire-knight-transparent.png"
 */
function getTransparentFilename(originalName) {
  const baseName = originalName.replace(/\.[^/.]+$/, '');
  return `${baseName}-transparent.png`;
}

/**
 * Triggers a browser download for a Blob or Object URL.
 */
function triggerBlobDownload(blobOrUrl, filename) {
  const isBlob = blobOrUrl instanceof Blob;
  const url = isBlob ? URL.createObjectURL(blobOrUrl) : blobOrUrl;
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  if (isBlob) {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/**
 * Standard CRC32 lookup table for valid local ZIP file generation.
 */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(uint8Arr) {
  let crc = 0xffffffff;
  for (let i = 0; i < uint8Arr.length; i++) {
    crc = CRC32_TABLE[(crc ^ uint8Arr[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Builds a valid standard ZIP archive locally in the browser (STORE mode, since PNGs are already compressed).
 * Requires zero external network calls or third-party dependencies.
 */
async function createZipFromProcessedImages(items) {
  const encoder = new TextEncoder();
  const fileEntries = [];
  let offset = 0;

  // Deduplicate filenames inside the ZIP if multiple files have the same name
  const usedNames = new Map();

  for (const item of items) {
    if (!item.processedBlob) continue;
    let fileName = getTransparentFilename(item.name);
    if (usedNames.has(fileName)) {
      const count = usedNames.get(fileName) + 1;
      usedNames.set(fileName, count);
      const base = fileName.replace(/-transparent\.png$/, '');
      fileName = `${base}-transparent-${count}.png`;
    } else {
      usedNames.set(fileName, 1);
    }

    const nameBytes = encoder.encode(fileName);
    const arrayBuffer = await item.processedBlob.arrayBuffer();
    const dataBytes = new Uint8Array(arrayBuffer);
    const crc = crc32(dataBytes);
    const size = dataBytes.length;

    // Local File Header (30 bytes + filename length)
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true); // Local file header signature
    lv.setUint16(4, 20, true);         // Version needed to extract (2.0)
    lv.setUint16(6, 0x0800, true);     // UTF-8 filename flag
    lv.setUint16(8, 0, true);          // Compression method (0 = STORE, PNG is already compressed)
    lv.setUint16(10, 0, true);         // File last mod time
    lv.setUint16(12, 0x5421, true);    // File last mod date
    lv.setUint32(14, crc, true);       // CRC-32
    lv.setUint32(18, size, true);      // Compressed size
    lv.setUint32(22, size, true);      // Uncompressed size
    lv.setUint16(26, nameBytes.length, true); // File name length
    lv.setUint16(28, 0, true);         // Extra field length
    localHeader.set(nameBytes, 30);

    fileEntries.push({
      nameBytes,
      dataBytes,
      localHeader,
      crc,
      size,
      offset
    });

    offset += localHeader.length + size;
  }

  // Build Central Directory
  const centralDirectores = [];
  let centralSize = 0;

  for (const entry of fileEntries) {
    const cdHeader = new Uint8Array(46 + entry.nameBytes.length);
    const cv = new DataView(cdHeader.buffer);
    cv.setUint32(0, 0x02014b50, true); // Central directory signature
    cv.setUint16(4, 20, true);         // Version made by
    cv.setUint16(6, 20, true);         // Version needed
    cv.setUint16(8, 0x0800, true);     // UTF-8 flag
    cv.setUint16(10, 0, true);         // Store method
    cv.setUint16(12, 0, true);         // Mod time
    cv.setUint16(14, 0x5421, true);    // Mod date
    cv.setUint32(16, entry.crc, true); // CRC-32
    cv.setUint32(20, entry.size, true);// Compressed size
    cv.setUint32(24, entry.size, true);// Uncompressed size
    cv.setUint16(28, entry.nameBytes.length, true);
    cv.setUint16(30, 0, true);         // Extra field length
    cv.setUint16(32, 0, true);         // File comment length
    cv.setUint16(34, 0, true);         // Disk number
    cv.setUint16(36, 0, true);         // Internal attributes
    cv.setUint32(38, 0, true);         // External attributes
    cv.setUint32(42, entry.offset, true); // Relative offset of local header
    cdHeader.set(entry.nameBytes, 46);

    centralDirectores.push(cdHeader);
    centralSize += cdHeader.length;
  }

  // End of Central Directory Record (22 bytes)
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // EOCD signature
  ev.setUint16(4, 0, true);          // Number of this disk
  ev.setUint16(6, 0, true);          // Disk where central directory starts
  ev.setUint16(8, fileEntries.length, true); // Number of central directory records on this disk
  ev.setUint16(10, fileEntries.length, true);// Total number of central directory records
  ev.setUint32(12, centralSize, true);       // Size of central directory
  ev.setUint32(16, offset, true);            // Offset of start of central directory
  ev.setUint16(20, 0, true);                 // Comment length

  // Combine all parts into a single Blob
  const blobParts = [];
  for (const entry of fileEntries) {
    blobParts.push(entry.localHeader, entry.dataBytes);
  }
  for (const cd of centralDirectores) {
    blobParts.push(cd);
  }
  blobParts.push(eocd);

  return new Blob(blobParts, { type: 'application/zip' });
}

// ============================================================================
// UTILITY 3: BUILT-IN 16-BIT PIXEL ART SAMPLE GENERATOR
// ============================================================================

/**
 * Loads the user's uploaded Vampire Knight JPG if reachable in the environment,
 * or synthesizes a high-detail Multi-Shade Magenta JPG Vampire Knight test image
 * that mirrors the exact multi-shade magenta + dark crimson + black armor challenge.
 */
async function loadOrGenerateDefaultKnightImage(): Promise<File> {
  const candidatePaths = [
    '5a314a00-cd85-4e1e-8f36-00fbf3472b8a.jpg',
    '/5a314a00-cd85-4e1e-8f36-00fbf3472b8a.jpg',
    './5a314a00-cd85-4e1e-8f36-00fbf3472b8a.jpg'
  ];

  for (const path of candidatePaths) {
    try {
      const res = await fetch(path);
      if (res.ok) {
        const blob = await res.blob();
        if (blob && blob.size > 1000 && blob.type.startsWith('image/')) {
          return new File([blob], 'vampire-knight-magenta.jpg', {
            type: blob.type || 'image/jpeg'
          });
        }
      }
    } catch {
      // Ignore and fall back
    }
  }

  return generateSampleSpriteFile('cursed-knight-multishade-jpg');
}

function generateSampleSpriteFile(type = 'cursed-knight-multishade-jpg'): Promise<File> {
  return new Promise((resolve) => {
    const gridSize = 32;
    const scale = 16; // 512x512
    const width = gridSize * scale;
    const height = gridSize * scale;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    if (type === 'vampire-knight-png') {
      ctx.fillStyle = '#FF00FF';
      ctx.fillRect(0, 0, width, height);
    } else {
      // Simulate multi-shade magenta background (#FF00FF, #F406F0, #E812E8, #FF24FF, #D800D8)
      for (let y = 0; y < gridSize; y++) {
        for (let x = 0; x < gridSize; x++) {
          const wave = Math.floor((Math.sin(x * 0.5) + Math.cos(y * 0.5)) * 14);
          const r = Math.min(255, Math.max(215, 248 - ((x * 9 + y * 5) % 28) + wave));
          const g = Math.min(45, Math.max(0, ((x * 7 + y * 11) % 32)));
          const b = Math.min(255, Math.max(210, 246 - ((x * 5 + y * 13) % 30) - wave));
          ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
          ctx.fillRect(x * scale, y * scale, scale, scale);
        }
      }
    }

    const drawPixel = (gx, gy, color) => {
      ctx.fillStyle = color;
      ctx.fillRect(gx * scale, gy * scale, scale, scale);
    };

    const palette = {
      '.': null,
      'K': '#0d0d14', // Dark outline
      'A': '#353842', // Dark obsidian armor mid
      'L': '#5a6070', // Armor highlight
      'D': '#1e2029', // Armor shadow
      'R': '#7d1522', // Deep crimson cape/bat crest
      'C': '#a81c2e', // Crimson highlight
      'S': '#c69076', // Warm skin tone
      'E': '#ff1e38', // Glowing red eyes
      'G': '#4a252a', // Dark burgundy trim
      'B': '#470b14'  // Deep blood shadow
    };

    const spriteMap = [
      "..............KKKK..............",
      "............KKKKKKKK............",
      "...........KKKKKKKKKK...........",
      "..........KKKKSSSSKKKK..........",
      "..........KKKSEKKESKKK..........",
      ".........KKKKSSSSSSKKKK.........",
      ".........KRKKKSSSSKKKRK.........",
      "........KRRKKKKKKKKKKRRK........",
      ".......KCRRRKLLLLLLKRRRRCK......",
      "......KCRRRRKLAAGGAALKRRRRCK....",
      ".....KCRRRRRKLAACCAACLKRRRRRCK..",
      ".....KBRRRRRKDDDDDDDDKRRRRRBK...",
      "....KBRRRRRKGGGGGGGGGGKRRRRRBK..",
      "....KBRRRRRKAAADDDDAAAKRRRRRBK..",
      "....KBRRRRRKAAKBBBBKAAKRRRRRBK..",
      "...KBRRRRRRKAAKBBBBKAAKRRRRRRBK.",
      "...KBRRRRRRKKKKBBBBKKKKRRRRRRBK.",
      "...KBBBBBBBB..KDDDDK..BBBBBBBBK.",
      "...KBBBBBB....KAAAAK....BBBBBBK.",
      "....KKKKK....KAA..AAK....KKKKK..",
      ".............KAA..AAK...........",
      "............KDDD..DDDK..........",
      "............KGGG..GGGK..........",
      "...........KDDDD..DDDDK.........",
      "..........KKKKKK..KKKKKK........",
      "................................"
    ];

    spriteMap.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const ch = row[x];
        if (palette[ch]) drawPixel(x, y + 3, palette[ch]);
      }
    });

    if (type === 'vampire-knight-png') {
      canvas.toBlob((blob) => {
        const file = new File([blob], 'vampire-knight-exact.png', { type: 'image/png' });
        resolve(file);
      }, 'image/png');
    } else {
      // Export as JPEG so authentic JPG block artifacts & edge halos are created
      canvas.toBlob(
        (blob) => {
          const file = new File([blob], 'vampire-knight-multishade.jpg', {
            type: 'image/jpeg'
          });
          resolve(file);
        },
        'image/jpeg',
        0.85
      );
    }
  });
}

// ============================================================================
// COMPONENT 1: DROP ZONE (components/DropZone.jsx)
// ============================================================================

function DropZone({ onFilesSelected, onLoadSample, isProcessingBatch, compact }) {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(null);
  const dragCounter = useRef(0);

  const handleDragEnter = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current += 1;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current -= 1;
    if (dragCounter.current === 0) {
      setIsDragging(false);
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    dragCounter.current = 0;

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onFilesSelected(Array.from(e.dataTransfer.files));
      e.dataTransfer.clearData();
    }
  };

  const handleFileInputChange = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      onFilesSelected(Array.from(e.target.files));
      e.target.value = '';
    }
  };

  return (
    <div className="w-full">
      <div
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        className={`relative group cursor-pointer rounded-xl border-2 border-dashed transition-all duration-200 ${
          compact ? 'p-5 sm:p-6' : 'p-8 sm:p-10'
        } text-center select-none overflow-hidden ${
          isDragging
            ? 'border-[#FF00FF] bg-[#FF00FF]/10 shadow-[0_0_35px_rgba(255,0,255,0.28)] scale-[1.005]'
            : 'border-[#2a2a3d] bg-[#12121a] hover:border-[#FF00FF]/70 hover:bg-[#151520] hover:shadow-[0_0_25px_rgba(255,0,255,0.12)]'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
          onChange={handleFileInputChange}
          className="hidden"
        />

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 max-w-2xl mx-auto">
          <div
            className={`w-14 h-14 rounded-2xl flex items-center justify-center border shrink-0 transition-all duration-200 ${
              isDragging
                ? 'bg-[#FF00FF] text-black border-[#FF00FF] shadow-[0_0_25px_rgba(255,0,255,0.7)] scale-110'
                : 'bg-[#1a1a26] text-[#FF00FF] border-[#2e2e42] group-hover:border-[#FF00FF]/60 group-hover:shadow-[0_0_15px_rgba(255,0,255,0.25)]'
            }`}
          >
            <Upload className="w-6 h-6" />
          </div>

          <div className="text-center sm:text-left space-y-1">
            <p className="text-base sm:text-lg font-semibold text-white tracking-tight">
              Drop your magenta background image here (PNG, JPG, WebP)
            </p>
            <p className="text-xs sm:text-sm text-gray-400">
              or <span className="text-[#FF00FF] underline font-medium">click to browse</span> • Paste directly with{' '}
              <kbd className="px-1.5 py-0.5 text-xs bg-[#1e1e2d] border border-[#32324a] rounded text-gray-300 font-mono">
                Ctrl+V
              </kbd>
            </p>
          </div>
        </div>
      </div>

      {/* Quick Test Sample Bar */}
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-lg bg-[#12121a]/90 border border-[#222233] text-xs text-gray-400">
        <div className="flex items-center gap-2">
          <Sparkles className="w-3.5 h-3.5 text-[#FF00FF] shrink-0" />
          <span>Handles noisy multi-shade magenta JPGs, interior holes & pink edge halos automatically:</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={isProcessingBatch}
            onClick={() => onLoadSample('cursed-knight-multishade-jpg')}
            className="px-2.5 py-1 rounded bg-[#1b1b29] hover:bg-[#252538] text-gray-200 border border-[#2f2f46] hover:border-[#FF00FF]/50 transition-colors font-medium flex items-center gap-1.5 cursor-pointer"
          >
            <span className="w-2 h-2 rounded-full bg-[#FF00FF]" />
            Load Multi-Shade Knight (JPG)
          </button>
          <button
            type="button"
            disabled={isProcessingBatch}
            onClick={() => onLoadSample('vampire-knight-png')}
            className="px-2.5 py-1 rounded bg-[#1b1b29] hover:bg-[#252538] text-gray-200 border border-[#2f2f46] hover:border-[#FF00FF]/50 transition-colors font-medium flex items-center gap-1.5 cursor-pointer"
          >
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            Load Solid #FF00FF (PNG)
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// COMPONENT 2: PROCESSING CONTROLS (components/ProcessingControls.jsx)
// ============================================================================

function ProcessingControls({
  mode,
  setMode,
  tolerance,
  setTolerance,
  magentaDominance,
  setMagentaDominance,
  defringe,
  setDefringe,
  edgeChoke,
  setEdgeChoke,
  onReset,
  previewBg,
  setPreviewBg
}) {
  const isDefault =
    mode === 'smart' &&
    tolerance === 55 &&
    magentaDominance === 42 &&
    defringe === 75 &&
    edgeChoke === 1;

  return (
    <div className="rounded-xl bg-[#12121a] border border-[#262638] p-5 sm:p-6 shadow-lg space-y-5">
      {/* Header Row */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-[#222232]">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Sliders className="w-4 h-4 text-[#FF00FF]" />
            <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-200">
              Background Removal Engine
            </h2>
          </div>
          <p className="text-xs text-gray-400">
            <strong className="text-gray-200">Smart Multi-Shade Mode</strong> removes all shades of magenta & JPG compression noise while protecting dark red capes, skin tones, and black armor.
          </p>
        </div>

        {/* Preview Backdrop Selector & Reset */}
        <div className="flex flex-wrap items-center gap-2 self-start md:self-center">
          <div className="flex items-center bg-[#181824] border border-[#2a2a3d] rounded-lg p-0.5 text-xs">
            <span className="px-2 py-1 text-gray-400 flex items-center gap-1">
              <Grid className="w-3.5 h-3.5 text-gray-400" />
              Backdrop:
            </span>
            {[
              { id: 'dark', label: 'Dark Grid' },
              { id: 'light', label: 'Light Grid' },
              { id: 'black', label: 'Black' },
              { id: 'white', label: 'White' }
            ].map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => setPreviewBg(b.id)}
                className={`px-2 py-1 rounded-md font-medium transition-colors cursor-pointer ${
                  previewBg === b.id
                    ? 'bg-[#2a2a3d] text-white'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                {b.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={onReset}
            disabled={isDefault}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
              isDefault
                ? 'border-[#222232] bg-[#161620] text-gray-600 cursor-not-allowed'
                : 'border-[#34344e] bg-[#1a1a28] text-gray-200 hover:border-[#FF00FF]/60 hover:text-white cursor-pointer'
            }`}
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset Defaults
          </button>
        </div>
      </div>

      {/* Mode Selection Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* 1. SMART MULTI-SHADE MODE (DEFAULT) */}
        <label
          className={`relative flex items-start gap-3 p-3.5 rounded-xl border cursor-pointer transition-all select-none ${
            mode === 'smart'
              ? 'border-[#FF00FF] bg-[#FF00FF]/[0.08] shadow-[0_0_20px_rgba(255,0,255,0.12)]'
              : 'border-[#252538] bg-[#161622] hover:border-[#363652]'
          }`}
        >
          <input
            type="radio"
            name="processingMode"
            checked={mode === 'smart'}
            onChange={() => setMode('smart')}
            className="sr-only"
          />
          <div className="mt-0.5">
            <Wand2
              className={`w-4 h-4 ${
                mode === 'smart' ? 'text-[#FF00FF]' : 'text-gray-500'
              }`}
            />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-1">
              <span className="font-semibold text-white text-sm">
                Smart Multi-Shade
              </span>
              <span className="px-1.5 py-0.5 text-[10px] font-mono uppercase rounded bg-[#FF00FF]/20 text-[#ff77ff] border border-[#FF00FF]/40">
                Best for JPGs
              </span>
            </div>
            <p className="text-xs text-gray-400 mt-1 leading-relaxed">
              Removes all magenta/pink shades + edge halos while preserving red capes & dark armor.
            </p>
          </div>
        </label>

        {/* 2. TOLERANCE DISTANCE MODE */}
        <label
          className={`relative flex items-start gap-3 p-3.5 rounded-xl border cursor-pointer transition-all select-none ${
            mode === 'tolerance'
              ? 'border-[#FF00FF] bg-[#FF00FF]/[0.08] shadow-[0_0_20px_rgba(255,0,255,0.12)]'
              : 'border-[#252538] bg-[#161622] hover:border-[#363652]'
          }`}
        >
          <input
            type="radio"
            name="processingMode"
            checked={mode === 'tolerance'}
            onChange={() => setMode('tolerance')}
            className="sr-only"
          />
          <div className="mt-0.5">
            <Pipette
              className={`w-4 h-4 ${
                mode === 'tolerance' ? 'text-[#FF00FF]' : 'text-gray-500'
              }`}
            />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-1">
              <span className="font-semibold text-white text-sm">
                Sampled Color Distance
              </span>
              <span className="px-1.5 py-0.5 text-[10px] font-mono uppercase rounded bg-[#222234] text-gray-300 border border-[#33334d]">
                Eyedropper
              </span>
            </div>
            <p className="text-xs text-gray-400 mt-1 leading-relaxed">
              Removes pixels within RGB distance of sampled background colors.
            </p>
          </div>
        </label>

        {/* 3. EXACT #FF00FF MODE */}
        <label
          className={`relative flex items-start gap-3 p-3.5 rounded-xl border cursor-pointer transition-all select-none ${
            mode === 'exact'
              ? 'border-[#FF00FF] bg-[#FF00FF]/[0.08] shadow-[0_0_20px_rgba(255,0,255,0.12)]'
              : 'border-[#252538] bg-[#161622] hover:border-[#363652]'
          }`}
        >
          <input
            type="radio"
            name="processingMode"
            checked={mode === 'exact'}
            onChange={() => setMode('exact')}
            className="sr-only"
          />
          <div className="mt-0.5">
            <Crosshair
              className={`w-4 h-4 ${
                mode === 'exact' ? 'text-[#FF00FF]' : 'text-gray-500'
              }`}
            />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-1">
              <span className="font-semibold text-white text-sm">
                Exact #FF00FF Only
              </span>
              <span className="px-1.5 py-0.5 text-[10px] font-mono uppercase rounded bg-[#222234] text-gray-400 border border-[#33334d]">
                Strict PNG
              </span>
            </div>
            <p className="text-xs text-gray-400 mt-1 leading-relaxed">
              Strictly removes only pure <code className="font-mono text-gray-200">255, 0, 255</code> pixels.
            </p>
          </div>
        </label>
      </div>

      {/* Sliders Grid for Smart / Tolerance Tuning */}
      {mode !== 'exact' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 pt-3 border-t border-[#222232]">
          {/* Slider 1: Color Distance Tolerance */}
          <div className="p-3 rounded-lg bg-[#161622] border border-[#242436] space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-gray-300">Shade Tolerance</span>
              <span className="font-mono font-semibold text-[#FF00FF]">{tolerance}</span>
            </div>
            <input
              type="range"
              min="0"
              max="140"
              step="1"
              value={tolerance}
              onChange={(e) => setTolerance(Number(e.target.value))}
              className="w-full h-2 rounded-lg cursor-pointer bg-[#252538] accent-[#FF00FF]"
            />
            <p className="text-[11px] text-gray-500">
              How far from sampled magenta shades to remove (0–140).
            </p>
          </div>

          {/* Slider 2: Magenta Range Sensitivity */}
          <div
            className={`p-3 rounded-lg bg-[#161622] border border-[#242436] space-y-2 ${
              mode !== 'smart' ? 'opacity-40 pointer-events-none' : ''
            }`}
          >
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-gray-300">Magenta Range</span>
              <span className="font-mono font-semibold text-[#FF00FF]">{magentaDominance}</span>
            </div>
            <input
              type="range"
              min="10"
              max="85"
              step="1"
              value={magentaDominance}
              onChange={(e) => setMagentaDominance(Number(e.target.value))}
              className="w-full h-2 rounded-lg cursor-pointer bg-[#252538] accent-[#FF00FF]"
            />
            <p className="text-[11px] text-gray-500">
              Catches off-magenta pink/purple blocks while sparing red capes.
            </p>
          </div>

          {/* Slider 3: Edge Pink Halo De-fringe */}
          <div className="p-3 rounded-lg bg-[#161622] border border-[#242436] space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-gray-300">Edge Halo De-fringe</span>
              <span className="font-mono font-semibold text-[#FF00FF]">{defringe}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="100"
              step="5"
              value={defringe}
              onChange={(e) => setDefringe(Number(e.target.value))}
              className="w-full h-2 rounded-lg cursor-pointer bg-[#252538] accent-[#FF00FF]"
            />
            <p className="text-[11px] text-gray-500">
              Neutralizes purple/pink JPG color spill on dark outlines.
            </p>
          </div>

          {/* Control 4: Edge Choke (px) */}
          <div className="p-3 rounded-lg bg-[#161622] border border-[#242436] space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-gray-300">Outline Fringe Cleanup</span>
              <span className="font-mono font-semibold text-[#FF00FF]">{edgeChoke}px</span>
            </div>
            <div className="grid grid-cols-3 gap-1.5 pt-0.5">
              {[
                { val: 0, label: '0px (Off)' },
                { val: 1, label: '1px Crisp' },
                { val: 2, label: '2px Deep' }
              ].map((opt) => (
                <button
                  key={opt.val}
                  type="button"
                  onClick={() => setEdgeChoke(opt.val)}
                  className={`py-1 rounded text-xs font-mono border transition-colors cursor-pointer ${
                    edgeChoke === opt.val
                      ? 'bg-[#FF00FF]/20 border-[#FF00FF] text-white font-semibold'
                      : 'bg-[#1e1e2e] border-[#2e2e44] text-gray-400 hover:text-gray-200'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-gray-500">
              Strips 1–2px JPEG magenta halo rings hugging the sprite.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// COMPONENT 3: IMAGE PREVIEW CARD WITH EYEDROPPER & TOUCH-UP BRUSH
// ============================================================================

function ImageCard({
  item,
  mode,
  previewBg,
  onDownload,
  onRemove,
  onAddSampledColor,
  onRemoveSampledColor,
  onResetSampledColors,
  onApplyManualBrush,
  onClearManualBrush,
  onSwitchToSmart
}) {
  const [zoomMode, setZoomMode] = useState('fit'); // 'fit' | 'actual' | '2x'
  const [activeTool, setActiveTool] = useState('eyedropper'); // 'eyedropper' | 'erase' | 'restore'
  const [brushRadius, setBrushRadius] = useState(4);
  const [inspectedPixel, setInspectedPixel] = useState(null);
  const [isPainting, setIsPainting] = useState(false);

  const removedPercent =
    item.totalPixels > 0
      ? ((item.removedCount / item.totalPixels) * 100).toFixed(1)
      : '0.0';

  const zeroRemovedInExact = mode === 'exact' && item.removedCount === 0 && !item.isProcessing;

  /**
   * Translates mouse event coordinates on an <img> element into exact source pixel (x, y).
   */
  const getPixelCoordsFromEvent = (e) => {
    const imgEl = e.currentTarget;
    const rect = imgEl.getBoundingClientRect();

    const imgAspect = item.width / item.height;
    const boxAspect = rect.width / rect.height;

    let renderW = rect.width;
    let renderH = rect.height;
    let offsetX = 0;
    let offsetY = 0;

    if (zoomMode === 'fit') {
      if (imgAspect > boxAspect) {
        renderH = rect.width / imgAspect;
        offsetY = (rect.height - renderH) / 2;
      } else {
        renderW = rect.height * imgAspect;
        offsetX = (rect.width - renderW) / 2;
      }
    }

    const relX = e.clientX - rect.left - offsetX;
    const relY = e.clientY - rect.top - offsetY;

    if (relX < 0 || relY < 0 || relX >= renderW || relY >= renderH) {
      return null;
    }

    const px = Math.min(
      item.width - 1,
      Math.max(0, Math.floor((relX / renderW) * item.width))
    );
    const py = Math.min(
      item.height - 1,
      Math.max(0, Math.floor((relY / renderH) * item.height))
    );

    return { px, py };
  };

  const handleMouseMoveOriginal = (e) => {
    if (!item.sourceImageData) return;
    const coords = getPixelCoordsFromEvent(e);
    if (!coords) {
      setInspectedPixel(null);
      return;
    }
    const { px, py } = coords;
    const idx = (py * item.width + px) * 4;
    const d = item.sourceImageData.data;
    const r = d[idx];
    const g = d[idx + 1];
    const b = d[idx + 2];
    const hex =
      '#' +
      [r, g, b]
        .map((v) => v.toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase();

    setInspectedPixel({ x: px, y: py, r, g, b, hex });

    if (isPainting && (activeTool === 'erase' || activeTool === 'restore')) {
      onApplyManualBrush(item.id, px, py, brushRadius, activeTool === 'erase' ? -1 : 1);
    }
  };

  const handleClickImage = (e) => {
    if (!item.sourceImageData) return;
    const coords = getPixelCoordsFromEvent(e);
    if (!coords) return;
    const { px, py } = coords;

    if (activeTool === 'eyedropper') {
      const idx = (py * item.width + px) * 4;
      const d = item.sourceImageData.data;
      const r = d[idx];
      const g = d[idx + 1];
      const b = d[idx + 2];
      const hex =
        '#' +
        [r, g, b]
          .map((v) => v.toString(16).padStart(2, '0'))
          .join('')
          .toUpperCase();
      onAddSampledColor(item.id, { r, g, b, hex });
    } else if (activeTool === 'erase' || activeTool === 'restore') {
      onApplyManualBrush(item.id, px, py, brushRadius, activeTool === 'erase' ? -1 : 1);
    }
  };

  // Preview Backdrop Style
  const getBackdropStyle = () => {
    if (previewBg === 'black') {
      return { backgroundColor: '#050508' };
    }
    if (previewBg === 'white') {
      return { backgroundColor: '#ffffff' };
    }
    if (previewBg === 'light') {
      return {
        backgroundImage: 'linear-gradient(45deg, #cbd5e1 25%, transparent 25%), linear-gradient(-45deg, #cbd5e1 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #cbd5e1 75%), linear-gradient(-45deg, transparent 75%, #cbd5e1 75%)',
        backgroundSize: '16px 16px',
        backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',
        backgroundColor: '#f8fafc'
      };
    }
    return {
      backgroundImage: 'linear-gradient(45deg, #1d1d2b 25%, transparent 25%), linear-gradient(-45deg, #1d1d2b 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #1d1d2b 75%), linear-gradient(-45deg, transparent 75%, #1d1d2b 75%)',
      backgroundSize: '16px 16px',
      backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',
      backgroundColor: '#12121c'
    };
  };

  return (
    <div className="rounded-xl bg-[#12121a] border border-[#262638] overflow-hidden shadow-xl transition-all">
      {/* Warning Banner if in Exact Mode and 0 exact #FF00FF pixels were found */}
      {zeroRemovedInExact && (
        <div className="px-4 py-3 bg-amber-500/10 border-b border-amber-500/30 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-amber-200 text-xs">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            <span className="font-medium">
              No exact #FF00FF pixels found — your image has multiple magenta shades (JPG compression).
            </span>
          </div>
          <button
            type="button"
            onClick={onSwitchToSmart}
            className="self-start sm:self-auto px-3 py-1 rounded bg-[#FF00FF] text-black font-semibold transition-colors shrink-0 cursor-pointer"
          >
            Switch to Smart Multi-Shade Mode
          </button>
        </div>
      )}

      {/* Interactive Toolbar: Eyedropper, Manual Brush, & Sampled Background Swatches */}
      <div className="px-4 sm:px-5 py-3 bg-[#151521] border-b border-[#222232] flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-gray-400 mr-1">
            Click Image Tool:
          </span>

          <button
            type="button"
            onClick={() => setActiveTool('eyedropper')}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border transition-all cursor-pointer ${
              activeTool === 'eyedropper'
                ? 'bg-[#FF00FF]/20 border-[#FF00FF] text-white shadow-[0_0_12px_rgba(255,0,255,0.25)]'
                : 'bg-[#1b1b29] border-[#2d2d44] text-gray-300 hover:text-white'
            }`}
            title="Click any stubborn background pixel on the image to add its shade to the removal list"
          >
            <Pipette className="w-3.5 h-3.5 text-[#FF00FF]" />
            + Pick Background Shade
          </button>

          <button
            type="button"
            onClick={() => setActiveTool('erase')}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border transition-all cursor-pointer ${
              activeTool === 'erase'
                ? 'bg-[#FF00FF]/20 border-[#FF00FF] text-white'
                : 'bg-[#1b1b29] border-[#2d2d44] text-gray-300 hover:text-white'
            }`}
            title="Manually erase any remaining stray pixels"
          >
            <Eraser className="w-3.5 h-3.5 text-rose-400" />
            Erase Brush
          </button>

          <button
            type="button"
            onClick={() => setActiveTool('restore')}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border transition-all cursor-pointer ${
              activeTool === 'restore'
                ? 'bg-[#FF00FF]/20 border-[#FF00FF] text-white'
                : 'bg-[#1b1b29] border-[#2d2d44] text-gray-300 hover:text-white'
            }`}
            title="Manually restore character pixels"
          >
            <Paintbrush className="w-3.5 h-3.5 text-emerald-400" />
            Restore Brush
          </button>

          {(activeTool === 'erase' || activeTool === 'restore') && (
            <div className="flex items-center gap-1.5 pl-2 text-xs text-gray-400">
              <span>Size:</span>
              <input
                type="range"
                min="1"
                max="20"
                value={brushRadius}
                onChange={(e) => setBrushRadius(Number(e.target.value))}
                className="w-20 h-1.5 bg-[#252538] rounded-lg accent-[#FF00FF] cursor-pointer"
              />
              <span className="font-mono text-gray-200">{brushRadius}px</span>
            </div>
          )}

          {item.hasManualEdits && (
            <button
              type="button"
              onClick={() => onClearManualBrush(item.id)}
              className="px-2 py-1 rounded text-[11px] bg-[#1e1e2e] hover:bg-[#2a2a3f] text-gray-300 border border-[#32324a] cursor-pointer"
            >
              Reset Brush Edits
            </button>
          )}
        </div>

        {/* Sampled Background Color Swatches */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-gray-400 mr-1">
            Target Shades ({item.sampledColors?.length || 1}):
          </span>
          {(item.sampledColors || []).map((c, idx) => (
            <div
              key={`${c.hex}-${idx}`}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#1d1d2c] border border-[#32324c] text-[11px] font-mono text-gray-200"
              title={`RGB(${c.r}, ${c.g}, ${c.b})`}
            >
              <span
                className="w-3 h-3 rounded-sm border border-white/20"
                style={{ backgroundColor: `rgb(${c.r}, ${c.g}, ${c.b})` }}
              />
              <span>{c.hex}</span>
              {item.sampledColors.length > 1 && (
                <button
                  type="button"
                  onClick={() => onRemoveSampledColor(item.id, idx)}
                  className="text-gray-400 hover:text-red-400 ml-0.5 cursor-pointer"
                  title="Remove this sampled shade"
                >
                  ×
                </button>
              )}
            </div>
          ))}
          {item.sampledColors && item.sampledColors.length > 2 && (
            <button
              type="button"
              onClick={() => onResetSampledColors(item.id)}
              className="text-[11px] text-gray-400 hover:text-white underline ml-1 cursor-pointer"
            >
              Reset Shades
            </button>
          )}
        </div>
      </div>

      {/* Side-by-Side Comparison Grid */}
      <div
        className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-[#222232]"
        onMouseUp={() => setIsPainting(false)}
        onMouseLeave={() => setIsPainting(false)}
      >
        {/* LEFT: ORIGINAL UNTOUCHED IMAGE */}
        <div className="p-4 sm:p-5 flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-gray-400">
                Original
              </span>
              <span className="px-2 py-0.5 text-[10px] font-mono rounded bg-[#1c1c29] text-gray-400 border border-[#2a2a3d]">
                Click any background shade to remove
              </span>
            </div>

            {inspectedPixel ? (
              <div className="flex items-center gap-1.5 text-[11px] font-mono bg-[#181824] px-2 py-0.5 rounded border border-[#2e2e45] text-gray-300">
                <span
                  className="w-2.5 h-2.5 rounded-sm border border-white/20 shrink-0"
                  style={{
                    backgroundColor: `rgb(${inspectedPixel.r}, ${inspectedPixel.g}, ${inspectedPixel.b})`
                  }}
                />
                <span>{inspectedPixel.hex}</span>
                <span className="text-gray-500">
                  ({inspectedPixel.r},{inspectedPixel.g},{inspectedPixel.b})
                </span>
              </div>
            ) : (
              <span className="text-[11px] text-gray-500 flex items-center gap-1">
                <Pipette className="w-3 h-3" /> Hover / Click to sample shade
              </span>
            )}
          </div>

          <div className="relative flex-1 min-h-[280px] sm:min-h-[360px] max-h-[480px] rounded-lg bg-[#0b0b10] border border-[#202030] overflow-auto flex items-center justify-center p-2">
            <img
              src={item.originalUrl}
              alt={`Original ${item.name}`}
              draggable={false}
              onMouseDown={(e) => {
                setIsPainting(true);
                handleClickImage(e);
              }}
              onMouseMove={handleMouseMoveOriginal}
              onMouseLeave={() => setInspectedPixel(null)}
              style={{
                imageRendering: 'pixelated',
                ...(zoomMode === 'actual'
                  ? { width: `${item.width}px`, height: `${item.height}px`, maxWidth: 'none', maxHeight: 'none' }
                  : zoomMode === '2x'
                  ? { width: `${item.width * 2}px`, height: `${item.height * 2}px`, maxWidth: 'none', maxHeight: 'none' }
                  : {})
              }}
              className={
                zoomMode === 'fit'
                  ? 'max-w-full max-h-[440px] w-auto h-auto object-contain select-none cursor-crosshair'
                  : 'select-none cursor-crosshair'
              }
            />
          </div>
        </div>

        {/* RIGHT: TRANSPARENT RESULT ON UI CHECKERBOARD */}
        <div className="p-4 sm:p-5 flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-[#FF00FF]">
                Transparent Result
              </span>
              <span className="px-2 py-0.5 text-[10px] font-mono rounded bg-[#FF00FF]/10 text-[#ff88ff] border border-[#FF00FF]/30">
                Click any leftover spot to zap it
              </span>
            </div>

            {/* Pixel Zoom Toggle */}
            <div className="flex items-center gap-1 bg-[#181824] border border-[#2a2a3d] rounded-md p-0.5 text-[11px] font-mono">
              <button
                type="button"
                onClick={() => setZoomMode('fit')}
                className={`px-2 py-0.5 rounded transition-colors cursor-pointer ${
                  zoomMode === 'fit'
                    ? 'bg-[#2a2a3d] text-white'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                Fit
              </button>
              <button
                type="button"
                onClick={() => setZoomMode('actual')}
                className={`px-2 py-0.5 rounded transition-colors cursor-pointer ${
                  zoomMode === 'actual'
                    ? 'bg-[#2a2a3d] text-white'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                1:1
              </button>
              <button
                type="button"
                onClick={() => setZoomMode('2x')}
                className={`px-2 py-0.5 rounded transition-colors cursor-pointer ${
                  zoomMode === '2x'
                    ? 'bg-[#2a2a3d] text-white'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                2×
              </button>
            </div>
          </div>

          <div
            style={getBackdropStyle()}
            className="relative flex-1 min-h-[280px] sm:min-h-[360px] max-h-[480px] rounded-lg border border-[#28283e] overflow-auto flex items-center justify-center p-2"
          >
            {item.processedUrl ? (
              <img
                src={item.processedUrl}
                alt={`Transparent result for ${item.name}`}
                draggable={false}
                onMouseDown={(e) => {
                  setIsPainting(true);
                  handleClickImage(e);
                }}
                onMouseMove={handleMouseMoveOriginal}
                style={{
                  imageRendering: 'pixelated',
                  ...(zoomMode === 'actual'
                    ? { width: `${item.width}px`, height: `${item.height}px`, maxWidth: 'none', maxHeight: 'none' }
                    : zoomMode === '2x'
                    ? { width: `${item.width * 2}px`, height: `${item.height * 2}px`, maxWidth: 'none', maxHeight: 'none' }
                    : {})
                }}
                className={
                  zoomMode === 'fit'
                    ? 'max-w-full max-h-[440px] w-auto h-auto object-contain select-none cursor-crosshair'
                    : 'select-none cursor-crosshair'
                }
              />
            ) : (
              <div className="text-xs text-gray-400 font-mono animate-pulse">
                Removing background...
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Card Footer: Metadata + Download Button */}
      <div className="px-4 sm:px-5 py-4 bg-[#0e0e15] border-t border-[#222232] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <span
              className="font-semibold text-white text-sm sm:text-base truncate max-w-xs sm:max-w-md"
              title={item.name}
            >
              {item.name}
            </span>
            <span className="px-2 py-0.5 text-xs font-mono uppercase rounded bg-[#1a1a28] text-gray-300 border border-[#2d2d44]">
              {item.format}
            </span>
            <span className="text-xs font-mono text-gray-400">
              {item.width} × {item.height}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span className="font-mono text-gray-300">
              Removed:{' '}
              <strong
                className={
                  item.removedCount > 0 ? 'text-[#FF00FF]' : 'text-amber-400'
                }
              >
                {item.removedCount.toLocaleString()} pixels
              </strong>{' '}
              <span className="text-gray-500">({removedPercent}%)</span>
            </span>
            <span className="text-gray-500 font-mono">
              Output: {getTransparentFilename(item.name)} ({item.width}×{item.height} Transparent PNG)
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={() => onDownload(item)}
            disabled={!item.processedBlob || item.isProcessing}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold bg-[#FF00FF] hover:bg-[#e600e6] active:bg-[#cc00cc] text-black shadow-[0_0_20px_rgba(255,0,255,0.35)] hover:shadow-[0_0_25px_rgba(255,0,255,0.55)] transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Download className="w-4 h-4 stroke-[2.5]" />
            Download Transparent PNG
          </button>

          <button
            type="button"
            onClick={() => onRemove(item.id)}
            className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 rounded-lg text-sm font-medium bg-[#181824] hover:bg-red-500/15 text-gray-300 hover:text-red-300 border border-[#2c2c40] hover:border-red-500/40 transition-colors cursor-pointer"
            title="Remove this image"
          >
            <Trash2 className="w-4 h-4" />
            <span>Remove</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// MAIN APPLICATION COMPONENT (MagentaRemover)
// ============================================================================

export default function MagentaRemover({ onNavigateToStudio }: { onNavigateToStudio?: () => void } = {}) {
  const [images, setImages] = useState([]);
  // Default to 'smart' so multi-shade magenta JPGs work immediately on upload!
  const [mode, setMode] = useState('smart'); // 'smart' | 'tolerance' | 'exact'
  const [tolerance, setTolerance] = useState(55); // Default 55 for multi-shade magenta
  const [magentaDominance, setMagentaDominance] = useState(42); // Default 42
  const [defringe, setDefringe] = useState(75); // Default 75% pink edge spill removal
  const [edgeChoke, setEdgeChoke] = useState(1); // Default 1px outline fringe cleanup
  const [previewBg, setPreviewBg] = useState('dark'); // 'dark' | 'light' | 'black' | 'white'
  const [errors, setErrors] = useState([]);
  const [isZipping, setIsZipping] = useState(false);

  const imagesRef = useRef(images);
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);

  useEffect(() => {
    return () => {
      imagesRef.current.forEach((img) => {
        if (img.originalUrl) URL.revokeObjectURL(img.originalUrl);
        if (img.processedUrl) URL.revokeObjectURL(img.processedUrl);
      });
    };
  }, []);

  const addError = useCallback((message) => {
    const id = `${Date.now()}-${Math.random()}`;
    setErrors((prev) => [...prev, { id, message }]);
  }, []);

  const dismissError = (id) => {
    setErrors((prev) => prev.filter((e) => e.id !== id));
  };

  /**
   * Decodes an uploaded image File into an untouched ImageData buffer,
   * auto-samples the corner shades, and runs the multi-shade magenta removal engine.
   */
  const decodeAndProcessFile = useCallback(
    async (
      file,
      currentMode,
      currentTolerance,
      currentMagDom,
      currentDefringe,
      currentEdgeChoke
    ) => {
      if (!file || file.size === 0) {
        throw new Error(`"${file?.name || 'File'}" is empty (0 bytes).`);
      }

      const ext = (file.name.split('.').pop() || '').toLowerCase();
      const validMime =
        file.type === 'image/png' ||
        file.type === 'image/jpeg' ||
        file.type === 'image/jpg' ||
        file.type === 'image/webp';
      const validExt = ['png', 'jpg', 'jpeg', 'webp'].includes(ext);

      if (!validMime && !validExt) {
        throw new Error(
          `"${file.name}" is not a supported format. Please upload PNG, JPG, JPEG, or WebP files.`
        );
      }

      const formatLabel =
        ext === 'png' || file.type === 'image/png'
          ? 'PNG'
          : ext === 'webp' || file.type === 'image/webp'
          ? 'WEBP'
          : ext === 'jpeg'
          ? 'JPEG'
          : 'JPG';

      const originalUrl = URL.createObjectURL(file);

      try {
        const imgElement = await new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () =>
            reject(
              new Error(`"${file.name}" could not be decoded or appears to be corrupted.`)
            );
          img.src = originalUrl;
        });

        const width = imgElement.naturalWidth || imgElement.width;
        const height = imgElement.naturalHeight || imgElement.height;

        if (!width || !height) {
          throw new Error(`"${file.name}" has invalid image dimensions.`);
        }

        if (width * height > 64_000_000) {
          throw new Error(
            `"${file.name}" (${width}×${height}) is extremely large and may exceed browser Canvas memory limits.`
          );
        }

        const sourceCanvas = document.createElement('canvas');
        sourceCanvas.width = width;
        sourceCanvas.height = height;
        const sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
        sourceCtx.imageSmoothingEnabled = false;
        sourceCtx.drawImage(imgElement, 0, 0);

        const sourceImageData = sourceCtx.getImageData(0, 0, width, height);

        // Auto-detect corner background shades so off-magenta JPGs work automatically
        const autoSampled = autoDetectBackgroundColors(sourceImageData);

        const result = await processMagentaRemoval(sourceImageData, {
          mode: currentMode,
          tolerance: currentTolerance,
          magentaDominance: currentMagDom,
          defringe: currentDefringe,
          edgeChoke: currentEdgeChoke,
          sampledColors: autoSampled,
          manualMask: null
        });

        return {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          name: file.name,
          format: formatLabel,
          width,
          height,
          originalUrl,
          sourceImageData,
          sampledColors: autoSampled,
          manualMask: null,
          hasManualEdits: false,
          processedBlob: result.blob,
          processedUrl: result.url,
          removedCount: result.removedCount,
          totalPixels: result.totalPixels,
          isProcessing: false
        };
      } catch (err) {
        URL.revokeObjectURL(originalUrl);
        throw err;
      }
    },
    []
  );

  const handleFilesSelected = useCallback(
    async (fileList) => {
      if (!fileList || fileList.length === 0) {
        addError('No files were detected in the upload.');
        return;
      }

      const newItems = [];
      for (const file of fileList) {
        try {
          const processedItem = await decodeAndProcessFile(
            file,
            mode,
            tolerance,
            magentaDominance,
            defringe,
            edgeChoke
          );
          newItems.push(processedItem);
        } catch (err) {
          addError(err.message || `Failed to process "${file?.name || 'image'}".`);
        }
      }

      if (newItems.length > 0) {
        setImages((prev) => [...newItems, ...prev]);
      }
    },
    [decodeAndProcessFile, mode, tolerance, magentaDominance, defringe, edgeChoke, addError]
  );

  // Auto-load default knight image on startup so the user immediately sees it working
  useEffect(() => {
    let mounted = true;
    loadOrGenerateDefaultKnightImage().then(async (file) => {
      if (!mounted || !file) return;
      try {
        const item = await decodeAndProcessFile(file, 'smart', 55, 42, 75, 1);
        if (mounted) {
          setImages([item]);
        }
      } catch {
        // Ignore startup sample failure
      }
    });
    return () => {
      mounted = false;
    };
  }, [decodeAndProcessFile]);

  // Support Ctrl+V clipboard image pasting anywhere on the page
  useEffect(() => {
    const handlePaste = (e) => {
      if (!e.clipboardData || !e.clipboardData.files) return;
      const pastedFiles = Array.from(e.clipboardData.files);
      if (pastedFiles.length > 0) {
        handleFilesSelected(pastedFiles);
      }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [handleFilesSelected]);

  // Re-process all loaded images whenever any slider or mode changes
  useEffect(() => {
    if (imagesRef.current.length === 0) return;

    let isCancelled = false;

    async function updateAllPreviews() {
      const currentList = imagesRef.current;
      const updatedList = await Promise.all(
        currentList.map(async (item) => {
          try {
            const res = await processMagentaRemoval(item.sourceImageData, {
              mode,
              tolerance,
              magentaDominance,
              defringe,
              edgeChoke,
              sampledColors: item.sampledColors,
              manualMask: item.manualMask
            });
            return {
              ...item,
              oldProcessedUrl: item.processedUrl,
              processedBlob: res.blob,
              processedUrl: res.url,
              removedCount: res.removedCount
            };
          } catch {
            return item;
          }
        })
      );

      if (isCancelled) {
        updatedList.forEach((u) => {
          if (u.processedUrl && u.processedUrl !== u.oldProcessedUrl) {
            URL.revokeObjectURL(u.processedUrl);
          }
        });
        return;
      }

      updatedList.forEach((u) => {
        if (u.oldProcessedUrl && u.oldProcessedUrl !== u.processedUrl) {
          URL.revokeObjectURL(u.oldProcessedUrl);
        }
      });

      setImages(
        updatedList.map(({ oldProcessedUrl, ...cleanItem }) => cleanItem)
      );
    }

    updateAllPreviews();

    return () => {
      isCancelled = true;
    };
  }, [mode, tolerance, magentaDominance, defringe, edgeChoke]);

  /**
   * Re-runs processing for a single image item (when eyedropper or brush is used).
   */
  const reprocessSingleItem = async (updatedItem) => {
    try {
      const res = await processMagentaRemoval(updatedItem.sourceImageData, {
        mode,
        tolerance,
        magentaDominance,
        defringe,
        edgeChoke,
        sampledColors: updatedItem.sampledColors,
        manualMask: updatedItem.manualMask
      });

      setImages((prev) =>
        prev.map((img) => {
          if (img.id !== updatedItem.id) return img;
          if (img.processedUrl && img.processedUrl !== res.url) {
            URL.revokeObjectURL(img.processedUrl);
          }
          return {
            ...updatedItem,
            processedBlob: res.blob,
            processedUrl: res.url,
            removedCount: res.removedCount
          };
        })
      );
    } catch {
      // Ignore single item reprocess error
    }
  };

  /**
   * Adds a new background shade when the user clicks on the image with the Eyedropper.
   */
  const handleAddSampledColor = (id, colorObj) => {
    const target = images.find((img) => img.id === id);
    if (!target) return;

    const existing = target.sampledColors || [];
    const alreadyExists = existing.some((c) => c.hex === colorObj.hex);
    const updatedColors = alreadyExists ? existing : [...existing, colorObj];

    const updatedItem = {
      ...target,
      sampledColors: updatedColors
    };
    reprocessSingleItem(updatedItem);
  };

  const handleRemoveSampledColor = (id, indexToRemove) => {
    const target = images.find((img) => img.id === id);
    if (!target) return;
    const updatedColors = (target.sampledColors || []).filter(
      (_, idx) => idx !== indexToRemove
    );
    const updatedItem = {
      ...target,
      sampledColors:
        updatedColors.length > 0
          ? updatedColors
          : [{ r: 255, g: 0, b: 255, hex: '#FF00FF' }]
    };
    reprocessSingleItem(updatedItem);
  };

  const handleResetSampledColors = (id) => {
    const target = images.find((img) => img.id === id);
    if (!target) return;
    const autoSampled = autoDetectBackgroundColors(target.sourceImageData);
    const updatedItem = {
      ...target,
      sampledColors: autoSampled
    };
    reprocessSingleItem(updatedItem);
  };

  /**
   * Applies manual Erase (-1) or Restore (+1) brush stroke to the image's mask.
   */
  const handleApplyManualBrush = (id, centerX, centerY, radius, value) => {
    const target = images.find((img) => img.id === id);
    if (!target) return;

    const total = target.width * target.height;
    const mask = target.manualMask
      ? new Int8Array(target.manualMask)
      : new Int8Array(total);

    const rSq = radius * radius;
    const minY = Math.max(0, centerY - radius);
    const maxY = Math.min(target.height - 1, centerY + radius);
    const minX = Math.max(0, centerX - radius);
    const maxX = Math.min(target.width - 1, centerX + radius);

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - centerX;
        const dy = y - centerY;
        if (dx * dx + dy * dy <= rSq) {
          mask[y * target.width + x] = value;
        }
      }
    }

    const updatedItem = {
      ...target,
      manualMask: mask,
      hasManualEdits: true
    };
    reprocessSingleItem(updatedItem);
  };

  const handleClearManualBrush = (id) => {
    const target = images.find((img) => img.id === id);
    if (!target) return;
    const updatedItem = {
      ...target,
      manualMask: null,
      hasManualEdits: false
    };
    reprocessSingleItem(updatedItem);
  };

  const handleLoadSample = async (sampleType) => {
    try {
      const sampleFile = await generateSampleSpriteFile(sampleType);
      await handleFilesSelected([sampleFile]);
    } catch {
      addError('Could not generate sample sprite.');
    }
  };

  const handleRemoveImage = (id) => {
    setImages((prev) => {
      const target = prev.find((img) => img.id === id);
      if (target) {
        if (target.originalUrl) URL.revokeObjectURL(target.originalUrl);
        if (target.processedUrl) URL.revokeObjectURL(target.processedUrl);
      }
      return prev.filter((img) => img.id !== id);
    });
  };

  const handleClearAll = () => {
    images.forEach((img) => {
      if (img.originalUrl) URL.revokeObjectURL(img.originalUrl);
      if (img.processedUrl) URL.revokeObjectURL(img.processedUrl);
    });
    setImages([]);
  };

  const handleDownloadSingle = (item) => {
    if (!item.processedBlob) return;
    const outputFilename = getTransparentFilename(item.name);
    triggerBlobDownload(item.processedBlob, outputFilename);
  };

  const handleDownloadAllIndividual = () => {
    images.forEach((item, index) => {
      if (!item.processedBlob) return;
      setTimeout(() => {
        triggerBlobDownload(
          item.processedBlob,
          getTransparentFilename(item.name)
        );
      }, index * 180);
    });
  };

  const handleDownloadAllZip = async () => {
    if (images.length === 0) return;
    setIsZipping(true);
    try {
      const zipBlob = await createZipFromProcessedImages(images);
      triggerBlobDownload(zipBlob, 'magenta-removed-sprites.zip');
    } catch {
      addError('Failed to create ZIP archive. Try downloading PNGs individually.');
    } finally {
      setIsZipping(false);
    }
  };

  const handleResetControls = () => {
    setMode('smart');
    setTolerance(55);
    setMagentaDominance(42);
    setDefringe(75);
    setEdgeChoke(1);
  };

  return (
    <div className="flex-1 w-full bg-[#09090d] text-gray-100 font-sans selection:bg-[#FF00FF] selection:text-black">
      {/* Subtle Top Magenta Ambient Glow */}
      <div className="pointer-events-none fixed top-0 left-1/2 -translate-x-1/2 w-[650px] h-[180px] bg-[#FF00FF]/10 blur-[120px] rounded-full z-0" />

      <div className="relative z-10 max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-6 space-y-5">
        {/* ================================================================
            HEADER SECTION
            ================================================================ */}
        <header className="text-center space-y-2.5">
          <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-[#14141f] border border-[#2a2a3f] text-xs font-medium text-gray-300 shadow-inner">
            <ShieldCheck className="w-4 h-4 text-[#FF00FF]" />
            <span>100% local processing — your images never leave your browser.</span>
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-center gap-3">
              <span className="w-3.5 h-3.5 rounded-sm bg-[#FF00FF] shadow-[0_0_12px_#FF00FF] inline-block" />
              <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white">
                MAGENTA <span className="text-[#FF00FF] drop-shadow-[0_0_18px_rgba(255,0,255,0.35)]">REMOVER</span>
              </h1>
            </div>
            <p className="text-xs sm:text-sm text-gray-300 max-w-2xl mx-auto">
              Removes solid <code className="px-1.5 py-0.5 rounded bg-[#FF00FF]/15 text-[#ff77ff] border border-[#FF00FF]/30 font-mono text-xs">#FF00FF</code> AND noisy multi-shade magenta JPG backgrounds without hurting dark red capes or armor.
            </p>
          </div>
        </header>

        {/* ================================================================
            INLINE ERROR ALERTS
            ================================================================ */}
        {errors.length > 0 && (
          <div className="space-y-2">
            {errors.map((err) => (
              <div
                key={err.id}
                className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-200 text-sm"
              >
                <div className="flex items-center gap-2.5">
                  <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
                  <span>{err.message}</span>
                </div>
                <button
                  type="button"
                  onClick={() => dismissError(err.id)}
                  className="p-1 rounded-lg hover:bg-red-500/20 text-red-300 transition-colors cursor-pointer"
                  aria-label="Dismiss error"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* ================================================================
            DRAG & DROP AREA
            ================================================================ */}
        <DropZone
          onFilesSelected={handleFilesSelected}
          onLoadSample={handleLoadSample}
          isProcessingBatch={false}
          compact={images.length > 0}
        />

        {/* ================================================================
            PROCESSING CONTROLS (SMART MULTI-SHADE + TOLERANCE + DEFRINGE)
            ================================================================ */}
        <ProcessingControls
          mode={mode}
          setMode={setMode}
          tolerance={tolerance}
          setTolerance={setTolerance}
          magentaDominance={magentaDominance}
          setMagentaDominance={setMagentaDominance}
          defringe={defringe}
          setDefringe={setDefringe}
          edgeChoke={edgeChoke}
          setEdgeChoke={setEdgeChoke}
          onReset={handleResetControls}
          previewBg={previewBg}
          setPreviewBg={setPreviewBg}
        />

        {/* ================================================================
            PROCESSED IMAGE CARDS & BATCH CONTROLS
            ================================================================ */}
        {images.length > 0 && (
          <section className="space-y-6">
            {/* Top Batch Bar */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-3 border-b border-[#222232]">
              <div className="flex items-center gap-3">
                <span className="px-3 py-1 rounded-lg bg-[#FF00FF]/15 border border-[#FF00FF]/40 text-[#ff77ff] font-mono text-sm font-bold">
                  {images.length} {images.length === 1 ? 'IMAGE' : 'IMAGES'}
                </span>
                <span className="text-xs text-gray-400">
                  Tip: Click anywhere on the background in the preview to zap additional magenta shades!
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  onClick={handleClearAll}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs sm:text-sm font-medium bg-[#161622] hover:bg-red-500/15 text-gray-300 hover:text-red-300 border border-[#2a2a3d] hover:border-red-500/40 transition-colors cursor-pointer"
                >
                  <Trash2 className="w-4 h-4" />
                  Clear All
                </button>

                {images.length > 1 && (
                  <button
                    type="button"
                    onClick={handleDownloadAllIndividual}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs sm:text-sm font-medium bg-[#1b1b29] hover:bg-[#242436] text-gray-100 border border-[#32324c] hover:border-[#FF00FF]/50 transition-colors cursor-pointer"
                  >
                    <Download className="w-4 h-4 text-[#FF00FF]" />
                    Download All ({images.length})
                  </button>
                )}

                <button
                  type="button"
                  onClick={handleDownloadAllZip}
                  disabled={isZipping}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs sm:text-sm font-semibold bg-[#FF00FF] hover:bg-[#e600e6] text-black shadow-[0_0_20px_rgba(255,0,255,0.3)] hover:shadow-[0_0_25px_rgba(255,0,255,0.5)] transition-all cursor-pointer disabled:opacity-50"
                >
                  <FileArchive className="w-4 h-4 stroke-[2.2]" />
                  {isZipping ? 'Creating ZIP...' : 'Download All as ZIP'}
                </button>
              </div>
            </div>

            {/* Image Cards List */}
            <div className="space-y-6">
              {images.map((item) => (
                <ImageCard
                  key={item.id}
                  item={item}
                  mode={mode}
                  previewBg={previewBg}
                  onDownload={handleDownloadSingle}
                  onRemove={handleRemoveImage}
                  onAddSampledColor={handleAddSampledColor}
                  onRemoveSampledColor={handleRemoveSampledColor}
                  onResetSampledColors={handleResetSampledColors}
                  onApplyManualBrush={handleApplyManualBrush}
                  onClearManualBrush={handleClearManualBrush}
                  onSwitchToSmart={() => setMode('smart')}
                />
              ))}
            </div>
          </section>
        )}

        {/* ================================================================
            FOOTER TECHNICAL NOTE
            ================================================================ */}
        <footer className="pt-6 border-t border-[#191926] flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-gray-500">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[#FF00FF]" />
            <span>
              Multi-Shade Magenta Chroma-Key + Edge De-fringe Engine (<code className="text-gray-400 font-mono">imageSmoothingEnabled = false</code>)
            </span>
          </div>
          <div>
            100% local processing — your images never leave your browser.
          </div>
        </footer>
      </div>
    </div>
  );
}
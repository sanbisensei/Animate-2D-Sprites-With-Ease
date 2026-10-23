import React, { useState, useRef, useEffect, useCallback } from "react";
import { createZipBlob } from "./utils/zipBuilder";
import { generateSampleMagentaVideo } from "./utils/demoVideo";
import MagentaRemover from "./utils/magenta_remover";

const FPS_OPTIONS = [2, 4, 6, 8, 10, 12, 15, 24];
const INTERVAL_OPTIONS = [
  { value: 1, label: "Every Frame" },
  { value: 2, label: "Every 2nd Frame" },
  { value: 3, label: "Every 3rd Frame" },
  { value: 4, label: "Every 4th Frame" },
  { value: 5, label: "Every 5th Frame" },
];

export default function App() {
  // 0. Active Studio View Navigation: 'video' | 'magenta'
  const [currentView, setCurrentView] = useState("video");

  // 1. Video Upload & Metadata State
  const [videoFile, setVideoFile] = useState(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [videoMeta, setVideoMeta] = useState({
    name: "",
    width: 0,
    height: 0,
    duration: 0,
    estimatedFps: 30,
  });
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [isGeneratingDemo, setIsGeneratingDemo] = useState(false);

  // 2. Video Trimming State
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(0);
  const [isPreviewingSelection, setIsPreviewingSelection] = useState(false);

  // 3. Frame Extraction State
  const [extractMode, setExtractMode] = useState("interval"); // 'interval' | 'target'
  const [frameInterval, setFrameInterval] = useState(3);
  const [targetFrameCount, setTargetFrameCount] = useState(8);
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractProgress, setExtractProgress] = useState({
    current: 0,
    total: 0,
  });

  // 4. Extracted Frames & Selection Timeline State
  // Each extracted frame: { id, index, label, timestamp, fullBlob, thumbUrl, width, height }
  const [extractedFrames, setExtractedFrames] = useState([]);
  // Timeline items allow chronological selection, duplication, and custom drag-and-drop ordering
  // Each item: { instanceId, frameId }
  const [timelineItems, setTimelineItems] = useState([]);
  const [inspectedFrameId, setInspectedFrameId] = useState(null);
  const [activeTimelineIndex, setActiveTimelineIndex] = useState(0);
  const [draggedTimelineIdx, setDraggedTimelineIdx] = useState(null);

  // 5. Animation Preview & Pixel Art Mode State
  const [isPlaying, setIsPlaying] = useState(false);
  const [fps, setFps] = useState(8);
  const [loop, setLoop] = useState(true);
  const [pixelArtMode, setPixelArtMode] = useState(true);

  // 6. Export & Spritesheet Settings State
  const [sheetLayout, setSheetLayout] = useState("horizontal"); // 'horizontal' | 'vertical' | 'grid'
  const [gridColumns, setGridColumns] = useState(3);
  const [scalePreset, setScalePreset] = useState("original"); // 'original' | '512' | '256' | '128' | 'custom'
  const [customScaleSize, setCustomScaleSize] = useState(256);
  const [isExporting, setIsExporting] = useState(false);

  // 7. Error & Status Messages
  const [errorMessage, setErrorMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState("");

  // Refs
  const videoRef = useRef(null);
  const previewCanvasRef = useRef(null);
  const inspectCanvasRef = useRef(null);
  const fileInputRef = useRef(null);
  const bitmapCacheRef = useRef(new Map());

  // Clean up object URLs & bitmaps
  const clearExtractedFrames = useCallback(() => {
    setExtractedFrames((prev) => {
      prev.forEach((f) => {
        if (f.thumbUrl) URL.revokeObjectURL(f.thumbUrl);
      });
      return [];
    });
    bitmapCacheRef.current.forEach((bmp) => {
      if (bmp && typeof bmp.close === "function") bmp.close();
    });
    bitmapCacheRef.current.clear();
    setTimelineItems([]);
    setInspectedFrameId(null);
    setActiveTimelineIndex(0);
    setIsPlaying(false);
  }, []);

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  // Load new video file
  const handleVideoFile = (file) => {
    setErrorMessage("");
    setStatusMessage("");

    if (!file) return;

    const validTypes = ["video/mp4", "video/webm", "video/quicktime"];
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (
      !validTypes.includes(file.type) &&
      !["mp4", "webm", "mov"].includes(ext)
    ) {
      setErrorMessage(
        "Unsupported video format. Please upload an MP4, WebM, or browser-compatible MOV file.",
      );
      return;
    }

    if (file.size > 500 * 1024 * 1024) {
      setErrorMessage(
        "Video file exceeds 500MB. Please upload a shorter sprite clip (e.g., 1–10 seconds).",
      );
      return;
    }

    clearExtractedFrames();
    if (videoUrl) URL.revokeObjectURL(videoUrl);

    const nextUrl = URL.createObjectURL(file);
    setVideoFile(file);
    setVideoUrl(nextUrl);
  };

  // Remove current video
  const handleRemoveVideo = () => {
    clearExtractedFrames();
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoFile(null);
    setVideoUrl("");
    setVideoMeta({
      name: "",
      width: 0,
      height: 0,
      duration: 0,
      estimatedFps: 30,
    });
    setStartTime(0);
    setEndTime(0);
    setErrorMessage("");
    setStatusMessage("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // Load Demo Magenta Sprite Video
  const handleLoadDemoVideo = async () => {
    try {
      setIsGeneratingDemo(true);
      setErrorMessage("");
      setStatusMessage(
        "Generating sample 512×512 knight attack video on solid magenta...",
      );
      const demoFile = await generateSampleMagentaVideo();
      handleVideoFile(demoFile);
      setStatusMessage(
        "Sample video loaded! Click [EXTRACT FRAMES] to test the pipeline.",
      );
    } catch (err) {
      setErrorMessage("Could not generate demo video: " + err.message);
    } finally {
      setIsGeneratingDemo(false);
    }
  };

  // Video Metadata Loaded
  const handleLoadedMetadata = () => {
    const v = videoRef.current;
    if (!v) return;

    const dur =
      Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 2.0;
    const width = v.videoWidth || 512;
    const height = v.videoHeight || 512;

    if (width === 0 || height === 0) {
      setErrorMessage(
        "Video decoding failed: Could not read video dimensions.",
      );
      return;
    }

    setVideoMeta({
      name: videoFile ? videoFile.name : "sprite_clip.mp4",
      width,
      height,
      duration: Number(dur.toFixed(2)),
      estimatedFps: 30,
    });
    setStartTime(0);
    setEndTime(Number(dur.toFixed(2)));
  };

  // Handle video playback timeupdate for [Preview Selection]
  const handleVideoTimeUpdate = () => {
    const v = videoRef.current;
    if (!v || !isPreviewingSelection) return;
    if (v.currentTime >= endTime) {
      v.pause();
      v.currentTime = startTime;
      setIsPreviewingSelection(false);
    }
  };

  const handlePreviewSelection = () => {
    const v = videoRef.current;
    if (!v) return;

    if (startTime >= endTime) {
      setErrorMessage("Start time must be less than End time.");
      return;
    }

    setErrorMessage("");
    v.currentTime = startTime;
    setIsPreviewingSelection(true);
    v.play().catch((err) => {
      setIsPreviewingSelection(false);
      setErrorMessage("Could not play video preview: " + err.message);
    });
  };

  // Helper: Seek hidden video element accurately to a timestamp
  const seekVideoTo = (videoEl, time) =>
    new Promise((resolve, reject) => {
      const clampedTime = Math.max(0, Math.min(time, videoEl.duration || time));

      const onSeeked = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("Failed while seeking video for frame extraction."));
      };
      const cleanup = () => {
        videoEl.removeEventListener("seeked", onSeeked);
        videoEl.removeEventListener("error", onError);
      };

      videoEl.addEventListener("seeked", onSeeked, { once: true });
      videoEl.addEventListener("error", onError, { once: true });
      videoEl.currentTime = clampedTime;
    });

  // 3. Extract Real Frames from Uploaded Video
  const handleExtractFrames = async () => {
    if (!videoUrl) return;
    setErrorMessage("");
    setStatusMessage("");

    const parsedStart = Number(startTime);
    const parsedEnd = Number(endTime);

    if (isNaN(parsedStart) || isNaN(parsedEnd) || parsedStart < 0) {
      setErrorMessage("Invalid trim start or end time.");
      return;
    }
    if (parsedStart >= parsedEnd) {
      setErrorMessage("Start time must be strictly less than End time.");
      return;
    }

    const durationRange = parsedEnd - parsedStart;
    const baseFps = videoMeta.estimatedFps || 30;
    const totalRawFramesInWindow = Math.max(
      1,
      Math.round(durationRange * baseFps),
    );

    let timestamps = [];
    if (extractMode === "interval") {
      const step = Math.max(1, Number(frameInterval) || 1);
      const dt = step / baseFps;
      for (let t = parsedStart; t <= parsedEnd + 0.0001; t += dt) {
        timestamps.push(Math.min(t, parsedEnd));
      }
    } else {
      const count = Math.max(1, Math.min(200, Number(targetFrameCount) || 8));
      if (count === 1) {
        timestamps.push(parsedStart);
      } else {
        const stepTime = durationRange / (count - 1);
        for (let i = 0; i < count; i++) {
          timestamps.push(Math.min(parsedStart + i * stepTime, parsedEnd));
        }
      }
    }

    if (timestamps.length === 0) {
      setErrorMessage(
        "Zero frames calculated for the selected range. Try widening the trim range.",
      );
      return;
    }

    // Pause main player if playing
    if (videoRef.current && !videoRef.current.paused) {
      videoRef.current.pause();
    }

    clearExtractedFrames();
    setIsExtracting(true);
    setExtractProgress({ current: 0, total: timestamps.length });

    // Create an offscreen decoding video element so the UI doesn't flicker
    const decoderVideo = document.createElement("video");
    decoderVideo.src = videoUrl;
    decoderVideo.muted = true;
    decoderVideo.playsInline = true;
    decoderVideo.crossOrigin = "anonymous";

    try {
      await new Promise((res, rej) => {
        decoderVideo.onloadeddata = res;
        decoderVideo.onerror = () =>
          rej(new Error("Video decoding failed during extraction."));
      });

      const fullWidth = decoderVideo.videoWidth || videoMeta.width;
      const fullHeight = decoderVideo.videoHeight || videoMeta.height;

      // Full-resolution offscreen canvas for lossless frame capture
      const fullCanvas = document.createElement("canvas");
      fullCanvas.width = fullWidth;
      fullCanvas.height = fullHeight;
      const fullCtx = fullCanvas.getContext("2d", { willReadFrequently: true });

      // Smaller thumbnail canvas for fast gallery rendering without bloating DOM memory
      const maxThumbDim = 180;
      const thumbScale = Math.min(
        1,
        maxThumbDim / Math.max(fullWidth, fullHeight),
      );
      const thumbWidth = Math.max(1, Math.round(fullWidth * thumbScale));
      const thumbHeight = Math.max(1, Math.round(fullHeight * thumbScale));

      const thumbCanvas = document.createElement("canvas");
      thumbCanvas.width = thumbWidth;
      thumbCanvas.height = thumbHeight;
      const thumbCtx = thumbCanvas.getContext("2d");

      const results = [];

      for (let i = 0; i < timestamps.length; i++) {
        const t = timestamps[i];
        await seekVideoTo(decoderVideo, t);

        // Draw exact frame to full-resolution canvas
        fullCtx.imageSmoothingEnabled = false;
        fullCtx.clearRect(0, 0, fullWidth, fullHeight);
        fullCtx.drawImage(decoderVideo, 0, 0, fullWidth, fullHeight);

        const fullBlob = await new Promise((res) =>
          fullCanvas.toBlob(res, "image/png"),
        );
        if (!fullBlob)
          throw new Error(`Failed to encode PNG for frame ${i + 1}`);

        // Cache ImageBitmap for instant crisp animation preview
        const bmp = await createImageBitmap(fullBlob);
        const frameId = `frame_${i + 1}_${Date.now()}`;
        bitmapCacheRef.current.set(frameId, bmp);

        // Create lightweight thumbnail object URL for the gallery
        thumbCtx.imageSmoothingEnabled = !pixelArtMode;
        thumbCtx.clearRect(0, 0, thumbWidth, thumbHeight);
        thumbCtx.drawImage(fullCanvas, 0, 0, thumbWidth, thumbHeight);
        const thumbBlob = await new Promise((res) =>
          thumbCanvas.toBlob(res, "image/png"),
        );
        const thumbUrl = URL.createObjectURL(thumbBlob);

        const label = `F${String(i + 1).padStart(2, "0")}`;
        results.push({
          id: frameId,
          index: i + 1,
          label,
          timestamp: Number(t.toFixed(2)),
          fullBlob,
          thumbUrl,
          width: fullWidth,
          height: fullHeight,
        });

        setExtractProgress({ current: i + 1, total: timestamps.length });
        // Yield to UI thread so browser never freezes
        await new Promise((r) => setTimeout(r, 0));
      }

      if (results.length === 0) {
        setErrorMessage("Zero frames were extracted from the video.");
      } else {
        setExtractedFrames(results);
        // Select up to 6 evenly spaced frames initially or let user toggle
        const initialSelection = results.map((f, idx) => ({
          instanceId: `inst_${f.id}_${idx}`,
          frameId: f.id,
        }));
        setTimelineItems(initialSelection);
        setInspectedFrameId(results[0].id);
        setActiveTimelineIndex(0);
        setIsPlaying(true);
        setStatusMessage(
          `Extracted ${results.length} frames (${fullWidth}×${fullHeight}). Click thumbnails below to curate your animation poses.`,
        );
      }
    } catch (err) {
      setErrorMessage(err.message || "Failed to extract frames from video.");
    } finally {
      decoderVideo.src = "";
      setIsExtracting(false);
    }
  };

  // Lookup helper for frame by ID
  const frameMap = React.useMemo(() => {
    const map = new Map();
    extractedFrames.forEach((f) => map.set(f.id, f));
    return map;
  }, [extractedFrames]);

  // Resolved frames in the Final Animation Timeline
  const selectedFramesList = React.useMemo(() => {
    return timelineItems
      .map((item) => {
        const frame = frameMap.get(item.frameId);
        return frame ? { ...frame, instanceId: item.instanceId } : null;
      })
      .filter(Boolean);
  }, [timelineItems, frameMap]);

  // Check if an extracted frame is currently included in the timeline
  const selectedFrameIdSet = React.useMemo(() => {
    return new Set(timelineItems.map((i) => i.frameId));
  }, [timelineItems]);

  // Toggle a frame from the Gallery while automatically maintaining chronological order
  const handleToggleGalleryFrame = (frame) => {
    setErrorMessage("");
    setInspectedFrameId(frame.id);

    const exists = selectedFrameIdSet.has(frame.id);
    if (exists) {
      setTimelineItems((prev) => {
        const next = prev.filter((item) => item.frameId !== frame.id);
        if (activeTimelineIndex >= next.length) {
          setActiveTimelineIndex(Math.max(0, next.length - 1));
        }
        return next;
      });
    } else {
      // Insert in chronological order based on original frame.index
      setTimelineItems((prev) => {
        const newItem = {
          instanceId: `inst_${frame.id}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          frameId: frame.id,
        };
        const next = [...prev];
        let insertAt = next.length;
        for (let i = 0; i < next.length; i++) {
          const existingFrame = frameMap.get(next[i].frameId);
          if (existingFrame && existingFrame.index > frame.index) {
            insertAt = i;
            break;
          }
        }
        next.splice(insertAt, 0, newItem);
        return next;
      });
    }
  };

  // Select All / Deselect All in chronological order
  const handleSelectAllFrames = () => {
    const all = extractedFrames.map((f) => ({
      instanceId: `inst_${f.id}_${Date.now()}_${f.index}`,
      frameId: f.id,
    }));
    setTimelineItems(all);
    setActiveTimelineIndex(0);
  };

  const handleDeselectAllFrames = () => {
    setTimelineItems([]);
    setActiveTimelineIndex(0);
    setIsPlaying(false);
  };

  // Duplicate active timeline frame (useful for holding an impact pose)
  const handleDuplicateSelectedFrame = () => {
    if (selectedFramesList.length === 0) return;
    const idx = Math.min(activeTimelineIndex, timelineItems.length - 1);
    const targetItem = timelineItems[idx];
    if (!targetItem) return;

    const duplicateItem = {
      instanceId: `inst_${targetItem.frameId}_dup_${Date.now()}`,
      frameId: targetItem.frameId,
    };

    setTimelineItems((prev) => {
      const next = [...prev];
      next.splice(idx + 1, 0, duplicateItem);
      return next;
    });
    setActiveTimelineIndex(idx + 1);
  };

  // Delete currently active frame from the timeline
  const handleDeleteSelectedTimelineFrame = () => {
    if (timelineItems.length === 0) return;
    const idx = Math.min(activeTimelineIndex, timelineItems.length - 1);
    setTimelineItems((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      if (activeTimelineIndex >= next.length) {
        setActiveTimelineIndex(Math.max(0, next.length - 1));
      }
      return next;
    });
  };

  // Remove specific timeline chip
  const handleRemoveTimelineInstance = (instanceId, e) => {
    e.stopPropagation();
    setTimelineItems((prev) => {
      const next = prev.filter((item) => item.instanceId !== instanceId);
      if (activeTimelineIndex >= next.length) {
        setActiveTimelineIndex(Math.max(0, next.length - 1));
      }
      return next;
    });
  };

  // Drag-and-drop reordering on the Selected Frame Timeline
  const handleTimelineDragStart = (idx) => {
    setDraggedTimelineIdx(idx);
  };

  const handleTimelineDragOver = (e, idx) => {
    e.preventDefault();
    if (draggedTimelineIdx === null || draggedTimelineIdx === idx) return;

    setTimelineItems((prev) => {
      const next = [...prev];
      const [moved] = next.splice(draggedTimelineIdx, 1);
      next.splice(idx, 0, moved);
      return next;
    });
    setDraggedTimelineIdx(idx);
    setActiveTimelineIndex(idx);
  };

  const handleTimelineDragEnd = () => {
    setDraggedTimelineIdx(null);
  };

  // Discrete Frame-by-Frame Animation Loop (NO interpolation)
  useEffect(() => {
    if (!isPlaying || selectedFramesList.length === 0) return;

    const intervalMs = 1000 / fps;
    const timer = setInterval(() => {
      setActiveTimelineIndex((prev) => {
        const next = prev + 1;
        if (next >= selectedFramesList.length) {
          if (loop) {
            return 0;
          } else {
            setIsPlaying(false);
            return prev;
          }
        }
        return next;
      });
    }, intervalMs);

    return () => clearInterval(timer);
  }, [isPlaying, fps, loop, selectedFramesList.length]);

  // Render current discrete animation frame onto the Preview Canvas
  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    if (selectedFramesList.length === 0) {
      canvas.width = 320;
      canvas.height = 320;
      ctx.fillStyle = "#12131a";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const safeIdx = Math.min(
      activeTimelineIndex,
      selectedFramesList.length - 1,
    );
    const activeFrame = selectedFramesList[safeIdx];
    if (!activeFrame) return;

    const bmp = bitmapCacheRef.current.get(activeFrame.id);
    if (!bmp) return;

    canvas.width = activeFrame.width;
    canvas.height = activeFrame.height;

    // Enforce Pixel Art Mode setting on canvas context
    ctx.imageSmoothingEnabled = !pixelArtMode;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  }, [selectedFramesList, activeTimelineIndex, pixelArtMode]);

  // Render larger inspected frame preview modal/panel if user clicks to inspect
  useEffect(() => {
    const canvas = inspectCanvasRef.current;
    if (!canvas || !inspectedFrameId) return;
    const frame = frameMap.get(inspectedFrameId);
    const bmp = bitmapCacheRef.current.get(inspectedFrameId);
    if (!frame || !bmp) return;

    const ctx = canvas.getContext("2d");
    canvas.width = frame.width;
    canvas.height = frame.height;
    ctx.imageSmoothingEnabled = !pixelArtMode;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  }, [inspectedFrameId, frameMap, pixelArtMode]);

  // Calculate Output Frame Dimensions (Never stretches aspect ratio)
  const getOutputDimensions = useCallback(() => {
    const srcW = extractedFrames[0]?.width || videoMeta.width || 1024;
    const srcH = extractedFrames[0]?.height || videoMeta.height || 1024;

    if (scalePreset === "original") {
      return { width: srcW, height: srcH };
    }

    const targetMax =
      scalePreset === "custom"
        ? Math.max(16, Math.min(4096, Number(customScaleSize) || 256))
        : Number(scalePreset);

    // Maintain exact source aspect ratio within target box
    if (srcW === srcH) {
      return { width: targetMax, height: targetMax };
    }
    const aspect = srcW / srcH;
    if (aspect > 1) {
      return {
        width: targetMax,
        height: Math.max(1, Math.round(targetMax / aspect)),
      };
    } else {
      return {
        width: Math.max(1, Math.round(targetMax * aspect)),
        height: targetMax,
      };
    }
  }, [extractedFrames, videoMeta, scalePreset, customScaleSize]);

  const outputDims = getOutputDimensions();

  // Compute Spritesheet Dimensions & Info
  const spritesheetMetrics = React.useMemo(() => {
    const count = selectedFramesList.length;
    const fw = outputDims.width;
    const fh = outputDims.height;

    if (count === 0) {
      return {
        frames: 0,
        frameWidth: fw,
        frameHeight: fh,
        columns: 0,
        rows: 0,
        sheetWidth: 0,
        sheetHeight: 0,
      };
    }

    let cols = count;
    let rows = 1;

    if (sheetLayout === "horizontal") {
      cols = count;
      rows = 1;
    } else if (sheetLayout === "vertical") {
      cols = 1;
      rows = count;
    } else {
      cols = Math.max(1, Math.min(count, Number(gridColumns) || 3));
      rows = Math.ceil(count / cols);
    }

    return {
      frames: count,
      frameWidth: fw,
      frameHeight: fh,
      columns: cols,
      rows,
      sheetWidth: cols * fw,
      sheetHeight: rows * fh,
    };
  }, [selectedFramesList.length, outputDims, sheetLayout, gridColumns]);

  // Render a single frame to a scaled PNG Blob (preserving solid magenta background)
  const renderFrameToBlob = async (frame, targetW, targetH) => {
    if (targetW === frame.width && targetH === frame.height && frame.fullBlob) {
      return frame.fullBlob;
    }

    const bmp = bitmapCacheRef.current.get(frame.id);
    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = !pixelArtMode;
    ctx.drawImage(bmp, 0, 0, targetW, targetH);

    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Failed to encode scaled frame PNG."));
      }, "image/png");
    });
  };

  // Trigger browser download of a Blob
  const triggerBlobDownload = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  };

  // 9A. Download Current Preview Frame as PNG
  const handleDownloadCurrentFrame = async () => {
    if (selectedFramesList.length === 0) {
      setErrorMessage("No frames selected to export.");
      return;
    }
    try {
      setErrorMessage("");
      const idx = Math.min(activeTimelineIndex, selectedFramesList.length - 1);
      const frame = selectedFramesList[idx];
      const blob = await renderFrameToBlob(
        frame,
        outputDims.width,
        outputDims.height,
      );
      const fileNumber = String(idx + 1).padStart(3, "0");
      triggerBlobDownload(blob, `frame_${fileNumber}.png`);
      setStatusMessage(
        `Exported frame_${fileNumber}.png (${outputDims.width}×${outputDims.height})`,
      );
    } catch (err) {
      setErrorMessage("Export failed: " + err.message);
    }
  };

  // 9B. Download All Selected Frames as a ZIP of frame_001.png, frame_002.png...
  const handleDownloadAllFrames = async () => {
    if (selectedFramesList.length === 0) {
      setErrorMessage("Please select at least one frame before exporting.");
      return;
    }
    try {
      setIsExporting(true);
      setErrorMessage("");
      const zipEntries = [];

      for (let i = 0; i < selectedFramesList.length; i++) {
        const frame = selectedFramesList[i];
        const blob = await renderFrameToBlob(
          frame,
          outputDims.width,
          outputDims.height,
        );
        const arrayBuffer = await blob.arrayBuffer();
        const filename = `frame_${String(i + 1).padStart(3, "0")}.png`;
        zipEntries.push({
          name: filename,
          data: new Uint8Array(arrayBuffer),
        });
      }

      const zipBlob = createZipBlob(zipEntries);
      triggerBlobDownload(zipBlob, "spriteframe_frames.zip");
      setStatusMessage(
        `Packaged and exported ${selectedFramesList.length} PNG frames (frame_001.png – frame_${String(
          selectedFramesList.length,
        ).padStart(3, "0")}.png) in spriteframe_frames.zip.`,
      );
    } catch (err) {
      setErrorMessage("Failed to export frames archive: " + err.message);
    } finally {
      setIsExporting(false);
    }
  };

  // 10. Download Combined Spritesheet PNG
  const handleDownloadSpritesheet = async () => {
    if (selectedFramesList.length === 0) {
      setErrorMessage(
        "Please select at least one frame to generate a spritesheet.",
      );
      return;
    }

    const { frameWidth, frameHeight, columns, sheetWidth, sheetHeight } =
      spritesheetMetrics;
    if (sheetWidth > 16384 || sheetHeight > 16384) {
      setErrorMessage(
        `Spritesheet dimensions (${sheetWidth}×${sheetHeight}) exceed browser canvas limits. Try Grid layout or Output Scaling.`,
      );
      return;
    }

    try {
      setIsExporting(true);
      setErrorMessage("");

      const sheetCanvas = document.createElement("canvas");
      sheetCanvas.width = sheetWidth;
      sheetCanvas.height = sheetHeight;
      const ctx = sheetCanvas.getContext("2d");
      ctx.imageSmoothingEnabled = !pixelArtMode;

      for (let i = 0; i < selectedFramesList.length; i++) {
        const frame = selectedFramesList[i];
        const bmp = bitmapCacheRef.current.get(frame.id);
        if (!bmp) continue;

        const col = i % columns;
        const row = Math.floor(i / columns);
        const x = col * frameWidth;
        const y = row * frameHeight;

        ctx.drawImage(bmp, x, y, frameWidth, frameHeight);
      }

      const sheetBlob = await new Promise((resolve, reject) => {
        sheetCanvas.toBlob((b) => {
          if (b) resolve(b);
          else reject(new Error("Canvas failed to generate spritesheet PNG."));
        }, "image/png");
      });

      triggerBlobDownload(
        sheetBlob,
        `spritesheet_${sheetWidth}x${sheetHeight}.png`,
      );
      setStatusMessage(
        `Exported spritesheet_${sheetWidth}x${sheetHeight}.png (${selectedFramesList.length} frames).`,
      );
    } catch (err) {
      setErrorMessage("Spritesheet export failed: " + err.message);
    } finally {
      setIsExporting(false);
    }
  };

  const inspectedFrame = inspectedFrameId
    ? frameMap.get(inspectedFrameId)
    : null;

  return (
    <div className="sf-app">
      {/* HEADER */}
      <header className="sf-header">
        <div className="sf-brand">
          <span className="sf-logo-cube" />
          <h1>SpriteFrame</h1>
          <span className="sf-badge">STUDIO</span>
        </div>

        {/* NAVIGATION TABS */}
        <div className="sf-nav-tabs">
          <button
            type="button"
            className={`sf-nav-tab ${currentView === "video" ? "active" : ""}`}
            onClick={() => setCurrentView("video")}
          >
            <span>🎞️</span> Video to Sprites
          </button>
          <button
            type="button"
            className={`sf-nav-tab sf-nav-tab-magenta ${currentView === "magenta" ? "active" : ""}`}
            onClick={() => setCurrentView("magenta")}
          >
            <span>✨</span> Magenta Remover
          </button>
        </div>

        {currentView === "video" ? (
          <div className="sf-pipeline-crumbs">
            <span className={videoUrl ? "done" : "active"}>1. Upload</span>
            <span>→</span>
            <span className={videoUrl ? "active" : ""}>2. Trim</span>
            <span>→</span>
            <span className={extractedFrames.length > 0 ? "done" : ""}>
              3. Extract
            </span>
            <span>→</span>
            <span className={selectedFramesList.length > 0 ? "done" : ""}>
              4. Select
            </span>
            <span>→</span>
            <span className={selectedFramesList.length > 0 ? "active" : ""}>
              5. Preview & Export
            </span>
          </div>
        ) : (
          <button
            type="button"
            className="sf-btn sf-btn-secondary sf-btn-sm"
            onClick={() => setCurrentView("video")}
          >
            ← Back to Video Studio
          </button>
        )}
      </header>

      {currentView === "magenta" ? (
        <MagentaRemover onNavigateToStudio={() => setCurrentView("video")} />
      ) : (
        <>
          {/* ALERTS */}
      {errorMessage && (
        <div className="sf-banner sf-banner-error">
          <span>⚠ {errorMessage}</span>
          <button onClick={() => setErrorMessage("")}>✕</button>
        </div>
      )}
      {statusMessage && !errorMessage && (
        <div className="sf-banner sf-banner-info">
          <span>✓ {statusMessage}</span>
          <button onClick={() => setStatusMessage("")}>✕</button>
        </div>
      )}

      <main className="sf-main">
        {/* TOP ROW: VIDEO & EXTRACTION SETTINGS */}
        <section className="sf-top-grid">
          {/* LEFT: VIDEO UPLOAD / PLAYER & TRIMMING */}
          <div className="sf-panel">
            <div className="sf-panel-header">
              <h2>VIDEO</h2>
              {videoFile && (
                <button
                  className="sf-btn sf-btn-danger sf-btn-sm"
                  onClick={handleRemoveVideo}
                >
                  Remove Video
                </button>
              )}
            </div>

            {!videoUrl ? (
              <div
                className={`sf-dropzone ${isDraggingFile ? "dragging" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDraggingFile(true);
                }}
                onDragLeave={() => setIsDraggingFile(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDraggingFile(false);
                  const file = e.dataTransfer.files?.[0];
                  if (file) handleVideoFile(file);
                }}
              >
                <div className="sf-dropzone-icon">🎞️</div>
                <p className="sf-dropzone-title">
                  Drop your sprite animation video here
                </p>
                <p className="sf-dropzone-sub">
                  Supports MP4, WebM, MOV (local browser decoding)
                </p>
                <div className="sf-dropzone-actions">
                  <button
                    className="sf-btn sf-btn-primary"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    Choose Video
                  </button>
                  <button
                    className="sf-btn sf-btn-secondary"
                    onClick={handleLoadDemoVideo}
                    disabled={isGeneratingDemo}
                  >
                    {isGeneratingDemo
                      ? "Generating Demo..."
                      : "Load Demo Magenta Video"}
                  </button>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov"
                  style={{ display: "none" }}
                  onChange={(e) => handleVideoFile(e.target.files?.[0])}
                />
              </div>
            ) : (
              <div className="sf-video-workspace">
                <div className="sf-video-stage">
                  <video
                    ref={videoRef}
                    src={videoUrl}
                    controls
                    playsInline
                    onLoadedMetadata={handleLoadedMetadata}
                    onTimeUpdate={handleVideoTimeUpdate}
                    onError={() =>
                      setErrorMessage(
                        "Failed to decode video stream. Ensure the file is a valid MP4/WebM.",
                      )
                    }
                    className={pixelArtMode ? "pixelated" : ""}
                  />
                </div>
                <div className="sf-video-meta-bar">
                  <div className="sf-meta-pill">
                    <strong>File:</strong> {videoMeta.name}
                  </div>
                  <div className="sf-meta-pill">
                    <strong>Resolution:</strong> {videoMeta.width} ×{" "}
                    {videoMeta.height}
                  </div>
                  <div className="sf-meta-pill">
                    <strong>Duration:</strong> {videoMeta.duration.toFixed(2)}{" "}
                    seconds
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* RIGHT: TRIM & EXTRACTION SETTINGS */}
          <div className="sf-panel">
            <div className="sf-panel-header">
              <h2>SETTINGS</h2>
            </div>

            <div className="sf-settings-body">
              {/* TRIM SECTION */}
              <div className="sf-field-group">
                <label className="sf-section-label">1. Video Trimming</label>
                <div className="sf-trim-inputs">
                  <div className="sf-input-box">
                    <span>Start (seconds)</span>
                    <input
                      type="number"
                      step="0.05"
                      min="0"
                      max={videoMeta.duration || 100}
                      value={startTime}
                      disabled={!videoUrl || isExtracting}
                      onChange={(e) => setStartTime(Number(e.target.value))}
                    />
                  </div>
                  <div className="sf-input-box">
                    <span>End (seconds)</span>
                    <input
                      type="number"
                      step="0.05"
                      min="0"
                      max={videoMeta.duration || 100}
                      value={endTime}
                      disabled={!videoUrl || isExtracting}
                      onChange={(e) => setEndTime(Number(e.target.value))}
                    />
                  </div>
                </div>

                {/* Dual visual range sliders */}
                {videoUrl && videoMeta.duration > 0 && (
                  <div className="sf-range-sliders">
                    <div className="sf-range-row">
                      <span>Start Slider</span>
                      <input
                        type="range"
                        min="0"
                        max={videoMeta.duration}
                        step="0.01"
                        value={startTime}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setStartTime(Math.min(v, endTime));
                          if (videoRef.current)
                            videoRef.current.currentTime = v;
                        }}
                      />
                    </div>
                    <div className="sf-range-row">
                      <span>End Slider</span>
                      <input
                        type="range"
                        min="0"
                        max={videoMeta.duration}
                        step="0.01"
                        value={endTime}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setEndTime(Math.max(v, startTime));
                          if (videoRef.current)
                            videoRef.current.currentTime = v;
                        }}
                      />
                    </div>
                  </div>
                )}

                <button
                  className="sf-btn sf-btn-secondary sf-btn-full"
                  disabled={!videoUrl || isExtracting}
                  onClick={handlePreviewSelection}
                >
                  ▶ Preview Selection (
                  {Math.max(0, endTime - startTime).toFixed(2)}s)
                </button>
              </div>

              <hr className="sf-divider" />

              {/* EXTRACTION MODE */}
              <div className="sf-field-group">
                <label className="sf-section-label">2. Frame Extraction</label>

                <div className="sf-radio-tabs">
                  <button
                    type="button"
                    className={`sf-tab-btn ${extractMode === "interval" ? "active" : ""}`}
                    onClick={() => setExtractMode("interval")}
                  >
                    Frame Interval
                  </button>
                  <button
                    type="button"
                    className={`sf-tab-btn ${extractMode === "target" ? "active" : ""}`}
                    onClick={() => setExtractMode("target")}
                  >
                    Target Count
                  </button>
                </div>

                {extractMode === "interval" ? (
                  <div className="sf-input-box">
                    <span>Extract:</span>
                    <select
                      value={frameInterval}
                      disabled={!videoUrl || isExtracting}
                      onChange={(e) => setFrameInterval(Number(e.target.value))}
                    >
                      {INTERVAL_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div className="sf-input-box">
                    <span>Target approximately (frames):</span>
                    <input
                      type="number"
                      min="2"
                      max="120"
                      value={targetFrameCount}
                      disabled={!videoUrl || isExtracting}
                      onChange={(e) =>
                        setTargetFrameCount(Number(e.target.value))
                      }
                    />
                  </div>
                )}

                <button
                  className="sf-btn sf-btn-accent sf-btn-large sf-btn-full"
                  disabled={!videoUrl || isExtracting}
                  onClick={handleExtractFrames}
                >
                  {isExtracting ? "EXTRACTING..." : "EXTRACT FRAMES"}
                </button>

                {isExtracting && (
                  <div className="sf-progress-box">
                    <div className="sf-progress-text">
                      <span>Extracting frames...</span>
                      <strong>
                        {extractProgress.current} / {extractProgress.total}
                      </strong>
                    </div>
                    <div className="sf-progress-track">
                      <div
                        className="sf-progress-fill"
                        style={{
                          width: `${
                            extractProgress.total
                              ? (extractProgress.current /
                                  extractProgress.total) *
                                100
                              : 0
                          }%`,
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* MIDDLE: EXTRACTED FRAMES GALLERY (LARGEST WORKSPACE AREA) */}
        <section className="sf-panel sf-gallery-panel">
          <div className="sf-panel-header">
            <div className="sf-gallery-title-group">
              <h2>EXTRACTED FRAMES</h2>
              <span className="sf-counter-pill">
                {selectedFramesList.length} frames selected
              </span>
              {extractedFrames.length > 0 && (
                <span className="sf-muted-hint">
                  Total extracted: {extractedFrames.length} • Click thumbnails
                  to toggle selection
                </span>
              )}
            </div>
            <div className="sf-gallery-actions">
              <button
                className="sf-btn sf-btn-secondary sf-btn-sm"
                disabled={extractedFrames.length === 0}
                onClick={handleSelectAllFrames}
              >
                Select All
              </button>
              <button
                className="sf-btn sf-btn-secondary sf-btn-sm"
                disabled={timelineItems.length === 0}
                onClick={handleDeselectAllFrames}
              >
                Deselect All
              </button>
            </div>
          </div>

          {extractedFrames.length === 0 ? (
            <div className="sf-empty-gallery">
              <p>
                No frames extracted yet. Upload a video and click [EXTRACT
                FRAMES] above.
              </p>
            </div>
          ) : (
            <div className="sf-gallery-workspace">
              <div className="sf-frames-grid">
                {extractedFrames.map((frame) => {
                  const isSelected = selectedFrameIdSet.has(frame.id);
                  const isInspected = inspectedFrameId === frame.id;
                  return (
                    <div
                      key={frame.id}
                      className={`sf-frame-card ${isSelected ? "selected" : ""} ${
                        isInspected ? "inspected" : ""
                      }`}
                      onClick={() => handleToggleGalleryFrame(frame)}
                    >
                      <div className="sf-frame-card-top">
                        <span className="sf-frame-tag">[{frame.label}]</span>
                        <span className="sf-frame-time">
                          {frame.timestamp.toFixed(2)}s
                        </span>
                        <span
                          className={`sf-check-badge ${isSelected ? "on" : ""}`}
                        >
                          {isSelected ? "✓" : "+"}
                        </span>
                      </div>
                      <div className="sf-thumb-wrap">
                        <img
                          src={frame.thumbUrl}
                          alt={frame.label}
                          className={pixelArtMode ? "pixelated" : ""}
                        />
                      </div>
                      <div className="sf-frame-card-footer">
                        <button
                          type="button"
                          className="sf-inspect-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            setInspectedFrameId(frame.id);
                          }}
                        >
                          🔍 Inspect
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* LARGER FRAME INSPECTOR SIDE PANEL */}
              {inspectedFrame && (
                <div className="sf-inspector-card">
                  <div className="sf-inspector-header">
                    <strong>
                      Inspector: [{inspectedFrame.label}] (
                      {inspectedFrame.timestamp}s)
                    </strong>
                    <span>
                      {inspectedFrame.width} × {inspectedFrame.height}
                    </span>
                  </div>
                  <div className="sf-inspector-canvas-wrap">
                    <canvas
                      ref={inspectCanvasRef}
                      className={pixelArtMode ? "pixelated" : ""}
                    />
                  </div>
                  <div className="sf-inspector-actions">
                    <button
                      className="sf-btn sf-btn-primary sf-btn-sm sf-btn-full"
                      onClick={() => handleToggleGalleryFrame(inspectedFrame)}
                    >
                      {selectedFrameIdSet.has(inspectedFrame.id)
                        ? "✓ Selected in Timeline (Click to Remove)"
                        : "+ Add Frame to Final Animation"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {/* SELECTED FRAME TIMELINE */}
        <section className="sf-panel sf-timeline-panel">
          <div className="sf-panel-header">
            <div className="sf-gallery-title-group">
              <h2>FINAL ANIMATION TIMELINE</h2>
              <span className="sf-muted-hint">
                Drag and drop frames to reorder • Click a frame to inspect/hold
                pose
              </span>
            </div>
            <div className="sf-gallery-actions">
              <button
                className="sf-btn sf-btn-secondary sf-btn-sm"
                disabled={selectedFramesList.length === 0}
                onClick={handleDuplicateSelectedFrame}
                title="Duplicate active frame to hold an impact pose longer"
              >
                + Duplicate Frame
              </button>
              <button
                className="sf-btn sf-btn-danger sf-btn-sm"
                disabled={selectedFramesList.length === 0}
                onClick={handleDeleteSelectedTimelineFrame}
              >
                Delete Selected Frame
              </button>
              <button
                className="sf-btn sf-btn-secondary sf-btn-sm"
                disabled={selectedFramesList.length === 0}
                onClick={handleDeselectAllFrames}
              >
                Clear Timeline
              </button>
            </div>
          </div>

          {selectedFramesList.length === 0 ? (
            <div className="sf-empty-timeline">
              No frames in timeline. Select frames from the Extracted Frames
              gallery above.
            </div>
          ) : (
            <div className="sf-timeline-strip">
              {selectedFramesList.map((frame, idx) => {
                const isActive = idx === activeTimelineIndex;
                return (
                  <div
                    key={frame.instanceId}
                    draggable
                    onDragStart={() => handleTimelineDragStart(idx)}
                    onDragOver={(e) => handleTimelineDragOver(e, idx)}
                    onDragEnd={handleTimelineDragEnd}
                    onClick={() => {
                      setActiveTimelineIndex(idx);
                      setInspectedFrameId(frame.id);
                    }}
                    className={`sf-timeline-item ${isActive ? "active" : ""}`}
                  >
                    <div className="sf-timeline-item-head">
                      <span className="sf-step-num">#{idx + 1}</span>
                      <span className="sf-orig-label">[{frame.label}]</span>
                      <button
                        type="button"
                        className="sf-timeline-remove"
                        title="Remove from timeline"
                        onClick={(e) =>
                          handleRemoveTimelineInstance(frame.instanceId, e)
                        }
                      >
                        ✕
                      </button>
                    </div>
                    <img
                      src={frame.thumbUrl}
                      alt={frame.label}
                      className={pixelArtMode ? "pixelated" : ""}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* BOTTOM GRID: ANIMATION PREVIEW & EXPORT STUDIO */}
        <section className="sf-bottom-grid">
          {/* LEFT: DISCRETE ANIMATION PREVIEW */}
          <div className="sf-panel">
            <div className="sf-panel-header">
              <h2>ANIMATION PREVIEW</h2>
              <span className="sf-counter-pill">
                Frame{" "}
                {selectedFramesList.length > 0
                  ? `${Math.min(activeTimelineIndex + 1, selectedFramesList.length)} / ${
                      selectedFramesList.length
                    }`
                  : "0 / 0"}
              </span>
            </div>

            <div className="sf-preview-body">
              <div className="sf-preview-stage">
                <canvas
                  ref={previewCanvasRef}
                  className={pixelArtMode ? "pixelated" : ""}
                />
              </div>

              <div className="sf-playback-controls">
                <button
                  className="sf-btn sf-btn-secondary"
                  disabled={selectedFramesList.length === 0}
                  onClick={() => {
                    setIsPlaying(false);
                    setActiveTimelineIndex((prev) =>
                      prev > 0 ? prev - 1 : selectedFramesList.length - 1,
                    );
                  }}
                >
                  ◀ Previous
                </button>
                <button
                  className="sf-btn sf-btn-accent"
                  disabled={selectedFramesList.length === 0}
                  onClick={() => setIsPlaying((p) => !p)}
                >
                  {isPlaying ? "⏸ Pause" : "▶ Play"}
                </button>
                <button
                  className="sf-btn sf-btn-secondary"
                  disabled={selectedFramesList.length === 0}
                  onClick={() => {
                    setIsPlaying(false);
                    setActiveTimelineIndex((prev) =>
                      prev + 1 < selectedFramesList.length ? prev + 1 : 0,
                    );
                  }}
                >
                  Next ▶
                </button>
              </div>

              <div className="sf-preview-options-bar">
                <div className="sf-option-item">
                  <label>FPS:</label>
                  <select
                    value={fps}
                    onChange={(e) => setFps(Number(e.target.value))}
                  >
                    {FPS_OPTIONS.map((val) => (
                      <option key={val} value={val}>
                        {val} FPS
                      </option>
                    ))}
                  </select>
                </div>

                <label className="sf-checkbox-label">
                  <input
                    type="checkbox"
                    checked={loop}
                    onChange={(e) => setLoop(e.target.checked)}
                  />
                  <span>Loop</span>
                </label>

                <label className="sf-checkbox-label">
                  <input
                    type="checkbox"
                    checked={pixelArtMode}
                    onChange={(e) => setPixelArtMode(e.target.checked)}
                  />
                  <span>Pixel Art Mode (Nearest-Neighbor)</span>
                </label>
              </div>
            </div>
          </div>

          {/* RIGHT: PNG FRAME & SPRITESHEET EXPORT */}
          <div className="sf-panel">
            <div className="sf-panel-header">
              <h2>EXPORT</h2>
              <span className="sf-magenta-tag">MAGENTA BG PRESERVED</span>
            </div>

            <div className="sf-export-body">
              {/* OPTIONAL OUTPUT SCALING */}
              <div className="sf-field-group">
                <label className="sf-section-label">
                  Output Resolution Scaling
                </label>
                <div className="sf-scale-row">
                  <select
                    value={scalePreset}
                    onChange={(e) => setScalePreset(e.target.value)}
                  >
                    <option value="original">
                      Original Resolution (
                      {extractedFrames[0]?.width || videoMeta.width || 1024} ×{" "}
                      {extractedFrames[0]?.height || videoMeta.height || 1024})
                    </option>
                    <option value="512">512 × 512</option>
                    <option value="256">256 × 256</option>
                    <option value="128">128 × 128</option>
                    <option value="custom">Custom Size</option>
                  </select>

                  {scalePreset === "custom" && (
                    <input
                      type="number"
                      min="16"
                      max="4096"
                      value={customScaleSize}
                      onChange={(e) =>
                        setCustomScaleSize(Number(e.target.value))
                      }
                      placeholder="Width (px)"
                    />
                  )}
                </div>
              </div>

              <hr className="sf-divider" />

              {/* INDIVIDUAL PNG FRAMES EXPORT */}
              <div className="sf-field-group">
                <label className="sf-section-label">
                  Individual PNG Frames
                </label>
                <p className="sf-muted-hint">
                  Exports <code>frame_001.png</code> through{" "}
                  <code>
                    frame_
                    {String(Math.max(1, selectedFramesList.length)).padStart(
                      3,
                      "0",
                    )}
                    .png
                  </code>{" "}
                  at {outputDims.width} × {outputDims.height}.
                </p>
                <div className="sf-export-btn-row">
                  <button
                    className="sf-btn sf-btn-secondary"
                    disabled={selectedFramesList.length === 0 || isExporting}
                    onClick={handleDownloadCurrentFrame}
                  >
                    Download Current Frame
                  </button>
                  <button
                    className="sf-btn sf-btn-primary"
                    disabled={selectedFramesList.length === 0 || isExporting}
                    onClick={handleDownloadAllFrames}
                  >
                    {isExporting
                      ? "Packaging ZIP..."
                      : "Download All Frames (.ZIP)"}
                  </button>
                </div>
              </div>

              <hr className="sf-divider" />

              {/* SPRITESHEET EXPORT */}
              <div className="sf-field-group">
                <label className="sf-section-label">
                  Spritesheet Layout & Export
                </label>
                <div className="sf-radio-tabs">
                  <button
                    type="button"
                    className={`sf-tab-btn ${sheetLayout === "horizontal" ? "active" : ""}`}
                    onClick={() => setSheetLayout("horizontal")}
                  >
                    Horizontal
                  </button>
                  <button
                    type="button"
                    className={`sf-tab-btn ${sheetLayout === "vertical" ? "active" : ""}`}
                    onClick={() => setSheetLayout("vertical")}
                  >
                    Vertical
                  </button>
                  <button
                    type="button"
                    className={`sf-tab-btn ${sheetLayout === "grid" ? "active" : ""}`}
                    onClick={() => setSheetLayout("grid")}
                  >
                    Grid
                  </button>
                </div>

                {sheetLayout === "grid" && (
                  <div className="sf-input-box">
                    <span>Columns:</span>
                    <input
                      type="number"
                      min="1"
                      max={Math.max(1, selectedFramesList.length)}
                      value={gridColumns}
                      onChange={(e) => setGridColumns(Number(e.target.value))}
                    />
                  </div>
                )}

                <div className="sf-sheet-stats">
                  <div>
                    <span>Frames:</span>
                    <strong>{spritesheetMetrics.frames}</strong>
                  </div>
                  <div>
                    <span>Frame Width:</span>
                    <strong>{spritesheetMetrics.frameWidth}</strong>
                  </div>
                  <div>
                    <span>Frame Height:</span>
                    <strong>{spritesheetMetrics.frameHeight}</strong>
                  </div>
                  <div>
                    <span>Columns:</span>
                    <strong>{spritesheetMetrics.columns}</strong>
                  </div>
                  <div>
                    <span>Rows:</span>
                    <strong>{spritesheetMetrics.rows}</strong>
                  </div>
                  <div>
                    <span>Sheet Width:</span>
                    <strong>{spritesheetMetrics.sheetWidth}</strong>
                  </div>
                  <div>
                    <span>Sheet Height:</span>
                    <strong>{spritesheetMetrics.sheetHeight}</strong>
                  </div>
                </div>

                <button
                  className="sf-btn sf-btn-accent sf-btn-large sf-btn-full"
                  disabled={selectedFramesList.length === 0 || isExporting}
                  onClick={handleDownloadSpritesheet}
                >
                  Download Spritesheet (.PNG)
                </button>

                <div style={{ marginTop: "12px", textAlign: "center" }}>
                  <button
                    type="button"
                    className="sf-nav-shortcut-btn"
                    onClick={() => setCurrentView("magenta")}
                    style={{ width: "100%", justifyContent: "center" }}
                  >
                    ✨ Open Frames in Magenta Remover →
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
        </>
      )}
    </div>
  );
}

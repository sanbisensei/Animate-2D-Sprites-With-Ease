export async function generateSampleMagentaVideo() {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext("2d");

  const stream = canvas.captureStream(30);
  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
    ? "video/webm;codecs=vp9"
    : "video/webm";

  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 8000000,
  });

  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  return new Promise((resolve, reject) => {
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType });
      const file = new File([blob], "knight_sword_attack.webm", {
        type: mimeType,
      });
      resolve(file);
    };
    recorder.onerror = reject;

    recorder.start();

    let frame = 0;
    const totalFrames = 48; // ~1.6 seconds at 30fps

    const interval = setInterval(() => {
      const progress = frame / totalFrames;

      // 1. Solid #FF00FF Magenta Background
      ctx.fillStyle = "#FF00FF";
      ctx.fillRect(0, 0, 512, 512);

      // 2. Draw RPG Knight Character performing a sword slash
      ctx.save();
      ctx.imageSmoothingEnabled = false;

      // Character lunges forward during swing
      let lungeX = 0;
      let swordAngle = -0.4; // Idle ready
      let slashEffect = false;

      if (progress < 0.25) {
        // Ready / Wind-up
        swordAngle = -0.4 - (progress / 0.25) * 1.4;
        lungeX = -(progress / 0.25) * 18;
      } else if (progress < 0.55) {
        // Fast Swing & Impact
        const swingP = (progress - 0.25) / 0.3;
        swordAngle = -1.8 + swingP * 3.2;
        lungeX = -18 + swingP * 65;
        if (swingP > 0.4 && swingP < 0.85) slashEffect = true;
      } else {
        // Follow-through & Recovery
        const recP = (progress - 0.55) / 0.45;
        swordAngle = 1.4 - recP * 1.8;
        lungeX = 47 * (1 - recP);
      }

      const cx = 230 + lungeX;
      const cy = 280;

      // Shadow
      ctx.fillStyle = "#660066";
      ctx.fillRect(cx - 48, cy + 96, 96, 16);

      // Legs
      ctx.fillStyle = "#2d3748";
      ctx.fillRect(cx - 28, cy + 40, 20, 56);
      ctx.fillRect(cx + 12, cy + 40, 20, 56);

      // Tunic / Armor Body
      ctx.fillStyle = "#3182ce";
      ctx.fillRect(cx - 36, cy - 32, 72, 76);
      ctx.fillStyle = "#cbd5e0";
      ctx.fillRect(cx - 28, cy - 24, 56, 48);

      // Helmet / Head
      ctx.fillStyle = "#a0aec0";
      ctx.fillRect(cx - 32, cy - 92, 64, 60);
      // Visor
      ctx.fillStyle = "#1a202c";
      ctx.fillRect(cx - 12, cy - 72, 40, 14);
      // Red Plume
      ctx.fillStyle = "#e53e3e";
      ctx.fillRect(cx - 24, cy - 112, 40, 20);

      // Sword Arm & Blade
      ctx.save();
      ctx.translate(cx + 16, cy - 10);
      ctx.rotate(swordAngle);

      // Hilt
      ctx.fillStyle = "#d69e2e";
      ctx.fillRect(-8, -28, 16, 28);
      ctx.fillRect(-24, -34, 48, 10);

      // Blade
      ctx.fillStyle = "#edf2f7";
      ctx.fillRect(-10, -160, 20, 126);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(-4, -156, 6, 118);

      ctx.restore();

      // Impact Flash Arc
      if (slashEffect) {
        ctx.strokeStyle = "#fefcbf";
        ctx.lineWidth = 14;
        ctx.beginPath();
        ctx.arc(cx + 24, cy - 10, 145, -0.9, 1.1);
        ctx.stroke();
      }

      // Frame stamp in top-left corner for easy visual verification
      ctx.fillStyle = "#1a202c";
      ctx.fillRect(16, 16, 94, 34);
      ctx.fillStyle = "#00f5d4";
      ctx.font = "bold 18px monospace";
      ctx.fillText(`RAW #${String(frame + 1).padStart(2, "0")}`, 24, 39);

      ctx.restore();

      frame++;
      if (frame >= totalFrames) {
        clearInterval(interval);
        recorder.stop();
      }
    }, 1000 / 30);
  });
}

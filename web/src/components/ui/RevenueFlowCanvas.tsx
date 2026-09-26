import React, { useEffect, useRef } from 'react';

export interface RevenueFlowCanvasProps {
  className?: string;
  opacity?: number;
  speed?: number;
  density?: number;
  interactive?: boolean;
  active?: boolean;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  stage: number; // 0 to 4 (representing 5 deal pipeline stages)
  size: number;
  color: string;
  alpha: number;
  trail: { x: number; y: number }[];
  targetY: number;
}

interface StageNode {
  x: number;
  y: number;
  label: string;
  pulseRadius: number;
  maxPulse: number;
}

export const RevenueFlowCanvas: React.FC<RevenueFlowCanvasProps> = ({
  className = '',
  opacity = 0.85,
  speed = 1.0,
  density = 45,
  interactive = true,
  active = true,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !active) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    let width = (canvas.width = canvas.parentElement?.clientWidth || window.innerWidth);
    let height = (canvas.height = canvas.parentElement?.clientHeight || window.innerHeight);

    const isDark = document.documentElement.classList.contains('dark');

    // Stage nodes representing the 5 pipeline milestones
    const stageLabels = ['LEADS', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'CLOSED WON'];
    let stageNodes: StageNode[] = [];

    const initStageNodes = () => {
      stageNodes = stageLabels.map((label, idx) => ({
        x: (width / 6) * (idx + 1),
        y: height * 0.5 + Math.sin(idx * 0.8) * (height * 0.12),
        label,
        pulseRadius: 4,
        maxPulse: 18 + idx * 3,
      }));
    };

    initStageNodes();

    // Mouse coordinates for interactive repulsion / acceleration
    let mouse = { x: -1000, y: -1000, active: false };

    const handleMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
      mouse.active = true;
    };

    const handleMouseLeave = () => {
      mouse.active = false;
      mouse.x = -1000;
      mouse.y = -1000;
    };

    if (interactive) {
      canvas.addEventListener('mousemove', handleMouseMove);
      canvas.addEventListener('mouseleave', handleMouseLeave);
    }

    // Color palette based on pipeline stage progression
    const colorsLight = [
      'rgba(59, 130, 246, ',   // Blue (Leads)
      'rgba(14, 165, 233, ',   // Sky (Qualified)
      'rgba(99, 102, 241, ',   // Indigo (Proposal)
      'rgba(168, 85, 247, ',   // Purple (Negotiation)
      'rgba(16, 185, 129, ',   // Emerald (Won)
    ];

    const colorsDark = [
      'rgba(96, 165, 250, ',   // Bright Blue
      'rgba(56, 189, 248, ',   // Bright Sky
      'rgba(129, 140, 248, ',  // Bright Indigo
      'rgba(192, 132, 252, ',  // Bright Purple
      'rgba(52, 211, 153, ',   // Bright Emerald
    ];

    const palette = isDark ? colorsDark : colorsLight;

    // Initialize particles representing flowing deals
    const particles: Particle[] = [];
    for (let i = 0; i < density; i++) {
      const startX = Math.random() * width;
      const initialStage = Math.min(4, Math.floor((startX / width) * 5));
      particles.push({
        x: startX,
        y: height * 0.25 + Math.random() * (height * 0.5),
        vx: (1.2 + Math.random() * 1.6) * speed,
        vy: (Math.random() - 0.5) * 0.6 * speed,
        stage: initialStage,
        size: 1.8 + Math.random() * 2.2,
        color: palette[initialStage],
        alpha: 0.2 + Math.random() * 0.7,
        trail: [],
        targetY: height * 0.5 + (Math.random() - 0.5) * (height * 0.35),
      });
    }

    const handleResize = () => {
      if (!canvas) return;
      width = canvas.width = canvas.parentElement?.clientWidth || window.innerWidth;
      height = canvas.height = canvas.parentElement?.clientHeight || window.innerHeight;
      initStageNodes();
    };

    window.addEventListener('resize', handleResize);

    // Animation loop
    const render = () => {
      ctx.clearRect(0, 0, width, height);

      // 1. Draw subtle connecting pipeline spline pathways
      ctx.beginPath();
      ctx.lineWidth = 1;
      ctx.strokeStyle = isDark ? 'rgba(59, 130, 246, 0.08)' : 'rgba(59, 130, 246, 0.12)';
      ctx.setLineDash([4, 6]);

      for (let i = 0; i < stageNodes.length - 1; i++) {
        const p1 = stageNodes[i];
        const p2 = stageNodes[i + 1];
        const cx = (p1.x + p2.x) / 2;
        ctx.moveTo(p1.x, p1.y);
        ctx.bezierCurveTo(cx, p1.y, cx, p2.y, p2.x, p2.y);
      }
      ctx.stroke();
      ctx.setLineDash([]); // Reset line dash

      // 2. Draw stage milestone pulse nodes
      stageNodes.forEach((node, idx) => {
        node.pulseRadius += 0.22 * speed;
        if (node.pulseRadius > node.maxPulse) {
          node.pulseRadius = 4;
        }

        const pulseAlpha = Math.max(0, 1 - node.pulseRadius / node.maxPulse) * 0.35;
        const nodeColor = palette[idx];

        // Pulse wave ring
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.pulseRadius, 0, Math.PI * 2);
        ctx.strokeStyle = `${nodeColor}${pulseAlpha})`;
        ctx.lineWidth = 1.2;
        ctx.stroke();

        // Solid core node
        ctx.beginPath();
        ctx.arc(node.x, node.y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = `${nodeColor}0.8)`;
        ctx.fill();
      });

      // 3. Update & render deal velocity particles
      particles.forEach((p) => {
        // Record trail positions
        p.trail.push({ x: p.x, y: p.y });
        if (p.trail.length > 7) {
          p.trail.shift();
        }

        // Steer gently toward stage spline height
        const currentStageIdx = Math.min(4, Math.floor((p.x / width) * 5));
        p.stage = currentStageIdx;
        p.color = palette[currentStageIdx];

        // Gentle vertical spring towards target spline height
        const dy = p.targetY - p.y;
        p.y += dy * 0.02;

        // Interactive mouse physics
        if (mouse.active) {
          const mdx = p.x - mouse.x;
          const mdy = p.y - mouse.y;
          const dist = Math.sqrt(mdx * mdx + mdy * mdy);
          if (dist < 120) {
            const force = (120 - dist) / 120;
            p.x += (mdx / (dist || 1)) * force * 3.5;
            p.y += (mdy / (dist || 1)) * force * 3.5;
          }
        }

        // Advance along x axis with slight acceleration in final stages
        const stageSpeedMultiplier = 1 + (p.stage * 0.15);
        p.x += p.vx * stageSpeedMultiplier;

        // Wrap around when past the right edge (new inbound deal)
        if (p.x > width + 20) {
          p.x = -20;
          p.y = height * 0.25 + Math.random() * (height * 0.5);
          p.targetY = height * 0.5 + (Math.random() - 0.5) * (height * 0.35);
          p.trail = [];
          p.stage = 0;
        }

        // Draw particle trail (comet tail)
        for (let t = 0; t < p.trail.length; t++) {
          const pt = p.trail[t];
          const trailAlpha = (t / p.trail.length) * p.alpha * 0.35;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, (p.size * (t + 1)) / p.trail.length, 0, Math.PI * 2);
          ctx.fillStyle = `${p.color}${trailAlpha})`;
          ctx.fill();
        }

        // Draw particle head with bright core
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = `${p.color}${p.alpha})`;
        ctx.fill();

        // Glow halo on high-stage particles (Closed Won deals)
        if (p.stage === 4) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * 2.2, 0, Math.PI * 2);
          ctx.fillStyle = isDark ? 'rgba(52, 211, 153, 0.22)' : 'rgba(16, 185, 129, 0.15)';
          ctx.fill();
        }
      });

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', handleResize);
      if (interactive) {
        canvas.removeEventListener('mousemove', handleMouseMove);
        canvas.removeEventListener('mouseleave', handleMouseLeave);
      }
    };
  }, [opacity, speed, density, interactive, active]);

  return (
    <canvas
      ref={canvasRef}
      className={`absolute inset-0 w-full h-full pointer-events-auto ${className}`}
      style={{ opacity }}
    />
  );
};

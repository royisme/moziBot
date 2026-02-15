import * as THREE from "three";
import type { AvatarRenderer, Phase } from "./types";

const PHASE_STYLE: Record<Phase, { color: number; amp: number }> = {
  idle: { color: 0x6ea8fe, amp: 0.02 },
  listening: { color: 0x62d5ff, amp: 0.08 },
  thinking: { color: 0x8f7bff, amp: 0.055 },
  speaking: { color: 0xffa173, amp: 0.065 },
  executing: { color: 0x00ff7a, amp: 0.1 },
  error: { color: 0xff4f64, amp: 0.03 },
};

export class OrbRenderer implements AvatarRenderer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- three.js ambient module
  private renderer: any = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private orb: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private aura: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private orbMat: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private auraMat: any = null;
  private currentPhase: Phase = "idle";
  private tick = 0;
  private animId = 0;
  private container: HTMLElement | null = null;

  async init(container: HTMLElement): Promise<void> {
    this.container = container;
    const canvas = document.createElement("canvas");
    canvas.className = "orb-canvas";
    container.appendChild(canvas);

    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.camera.position.z = 3.5;

    const key = new THREE.PointLight(0xffffff, 1.15);
    key.position.set(2.5, 2.2, 3.2);
    this.scene.add(key);

    const fill = new THREE.PointLight(0x9ed5ff, 0.5);
    fill.position.set(-2, -1, 2.5);
    this.scene.add(fill);

    this.orbMat = new THREE.MeshPhysicalMaterial({
      color: PHASE_STYLE.idle.color,
      emissive: PHASE_STYLE.idle.color,
      emissiveIntensity: 0.2,
      roughness: 0.24,
      metalness: 0.11,
      transmission: 0.46,
      transparent: true,
      opacity: 0.96,
    });

    this.orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.92, 20), this.orbMat);
    this.scene.add(this.orb);

    this.auraMat = new THREE.MeshBasicMaterial({
      color: PHASE_STYLE.idle.color,
      transparent: true,
      opacity: 0.12,
      blending: THREE.AdditiveBlending,
    });
    this.aura = new THREE.Mesh(new THREE.SphereGeometry(1.16, 44, 44), this.auraMat);
    this.scene.add(this.aura);

    this.resize();
    this.animate();
  }

  setPhase(phase: Phase): void {
    const normalized = (Object.keys(PHASE_STYLE).includes(phase) ? phase : "idle") as Phase;
    this.currentPhase = normalized;
    const style = PHASE_STYLE[normalized];
    this.orbMat?.color.setHex(style.color);
    this.orbMat?.emissive.setHex(style.color);
    this.auraMat?.color.setHex(style.color);
  }

  setMouthOpen(_value: number): void {
    // Orb does not support mouth animation; pulse amplitude could react here in the future.
  }

  resize(): void {
    if (!this.container || !this.renderer) return;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  destroy(): void {
    cancelAnimationFrame(this.animId);
    this.renderer?.dispose();
    this.renderer = null;
  }

  private animate = (): void => {
    this.tick += 0.016;
    const style = PHASE_STYLE[this.currentPhase];
    const pulse = 1 + Math.sin(this.tick * 2.8) * style.amp;
    if (this.orb) {
      this.orb.scale.setScalar(pulse);
      this.orb.rotation.y += this.currentPhase === "executing" ? 0.016 : 0.004;
      this.orb.rotation.x += 0.0018;
    }
    if (this.aura && this.auraMat) {
      this.aura.scale.setScalar(1 + Math.sin(this.tick * 2.1) * style.amp * 1.45);
      this.auraMat.opacity = 0.08 + style.amp;
    }
    this.renderer?.render(this.scene, this.camera);
    this.animId = requestAnimationFrame(this.animate);
  };
}

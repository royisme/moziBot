import * as THREE from "three";
import "./style.css";
import { loadWidgetConfig } from "./widget-config";

type Phase = "idle" | "listening" | "thinking" | "speaking" | "executing" | "error";

const PHASE_STYLE: Record<Phase, { color: number; amp: number }> = {
  idle: { color: 0x6ea8fe, amp: 0.02 },
  listening: { color: 0x62d5ff, amp: 0.08 },
  thinking: { color: 0x8f7bff, amp: 0.055 },
  speaking: { color: 0xffa173, amp: 0.065 },
  executing: { color: 0x00ff7a, amp: 0.1 },
  error: { color: 0xff4f64, amp: 0.03 },
};

let currentPhase: Phase = "idle";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Widget root not found");
}

const root = document.createElement("div");
root.className = "widget-root";

const canvas = document.createElement("canvas");
canvas.className = "orb-canvas";

const hud = document.createElement("div");
hud.className = "hud";
const phaseLabel = document.createElement("span");
phaseLabel.textContent = "phase: idle";
const statusLabel = document.createElement("span");
statusLabel.textContent = "channel: connecting";
hud.append(phaseLabel, statusLabel);

const composer = document.createElement("div");
composer.className = "composer";
const input = document.createElement("input");
input.placeholder = "Click orb then type message…";
const send = document.createElement("button");
send.textContent = "Send";
composer.append(input, send);

root.append(canvas, hud, composer);
app.appendChild(root);

const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.z = 3.5;

const key = new THREE.PointLight(0xffffff, 1.15);
key.position.set(2.5, 2.2, 3.2);
scene.add(key);

const fill = new THREE.PointLight(0x9ed5ff, 0.5);
fill.position.set(-2, -1, 2.5);
scene.add(fill);

const orbMat = new THREE.MeshPhysicalMaterial({
  color: PHASE_STYLE.idle.color,
  emissive: PHASE_STYLE.idle.color,
  emissiveIntensity: 0.2,
  roughness: 0.24,
  metalness: 0.11,
  transmission: 0.46,
  transparent: true,
  opacity: 0.96,
});

const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.92, 20), orbMat);
scene.add(orb);

const auraMat = new THREE.MeshBasicMaterial({
  color: PHASE_STYLE.idle.color,
  transparent: true,
  opacity: 0.12,
  blending: THREE.AdditiveBlending,
});
const aura = new THREE.Mesh(new THREE.SphereGeometry(1.16, 44, 44), auraMat);
scene.add(aura);

function setPhase(next: string): void {
  const normalized = (Object.keys(PHASE_STYLE).includes(next) ? next : "idle") as Phase;
  currentPhase = normalized;
  const style = PHASE_STYLE[normalized];
  phaseLabel.textContent = `phase: ${normalized}`;
  orbMat.color.setHex(style.color);
  orbMat.emissive.setHex(style.color);
  auraMat.color.setHex(style.color);
}

function resize(): void {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

let tick = 0;
function animate(): void {
  tick += 0.016;
  const style = PHASE_STYLE[currentPhase];
  const pulse = 1 + Math.sin(tick * 2.8) * style.amp;
  orb.scale.setScalar(pulse);
  aura.scale.setScalar(1 + Math.sin(tick * 2.1) * style.amp * 1.45);
  auraMat.opacity = 0.08 + style.amp;
  orb.rotation.y += currentPhase === "executing" ? 0.016 : 0.004;
  orb.rotation.x += 0.0018;
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

function buildBaseUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}

function buildEventsUrl(baseUrl: string, peerId: string, token?: string): string {
  const url = new URL(`${baseUrl}/events`);
  url.searchParams.set("peerId", peerId);
  if (token) {
    url.searchParams.set("token", token);
  }
  return url.toString();
}

async function sendText(params: {
  baseUrl: string;
  peerId: string;
  authToken?: string;
}): Promise<void> {
  const text = input.value.trim();
  if (!text) {
    return;
  }

  setPhase("listening");
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (params.authToken) {
      headers.authorization = `Bearer ${params.authToken}`;
    }
    await fetch(`${params.baseUrl}/inbound`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        peerId: params.peerId,
        senderId: "desktop-user",
        senderName: "Desktop User",
        text,
      }),
    });
  } catch {
    setPhase("error");
  }
  input.value = "";
}

void bootstrap();

async function bootstrap(): Promise<void> {
  const config = await loadWidgetConfig();

  if (!config.enabled) {
    statusLabel.textContent = "channel: disabled by config";
    send.disabled = true;
    input.disabled = true;
    return;
  }

  const baseUrl = buildBaseUrl(config.host, config.port);

  send.addEventListener("click", () => {
    void sendText({ baseUrl, peerId: config.peerId, authToken: config.authToken });
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      void sendText({ baseUrl, peerId: config.peerId, authToken: config.authToken });
    }
  });
  canvas.addEventListener("click", () => {
    setPhase("listening");
  });

  const eventsUrl = buildEventsUrl(baseUrl, config.peerId, config.authToken);
  const events = new EventSource(eventsUrl);
  events.addEventListener("open", () => {
    statusLabel.textContent = `channel: connected ${config.host}:${config.port}`;
  });
  events.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data) as { type?: string; phase?: string };
      if (typeof payload.phase === "string") {
        setPhase(payload.phase);
      }
      if (payload.type === "assistant_message") {
        statusLabel.textContent = "channel: reply received";
      }
    } catch {
      // ignore
    }
  });
  events.addEventListener("error", () => {
    statusLabel.textContent = "channel: disconnected";
  });
}

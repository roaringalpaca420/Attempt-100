const PRIMARY_MODEL_URL = "./Avocadotar 4 .glb";
const FALLBACK_MODEL_URL = "./raccoon_head .glb";

const statusEl = document.getElementById("status");
const startButton = document.getElementById("startButton");
const logsToggleButton = document.getElementById("logsToggleButton");
const logsPanel = document.getElementById("logsPanel");
const logsOutput = document.getElementById("logsOutput");
const clearLogsButton = document.getElementById("clearLogsButton");
const copyLogsButton = document.getElementById("copyLogsButton");
const video = document.getElementById("video");
const modelSelect = document.getElementById("modelSelect");

let faceLandmarker = null;
let avatar = null;
let scene = null;
let camera = null;
let renderer = null;
let controls = null;
let THREE = null;
let OrbitControls = null;
let GLTFLoader = null;
let FilesetResolver = null;
let FaceLandmarker = null;
let libsLoaded = false;
let frameCount = 0;

function log(message, ...details) {
  const time = new Date().toLocaleTimeString();
  const line = `[${time}] ${message} ${details.map((x) => JSON.stringify(x)).join(" ")}`;
  if (logsOutput) {
    logsOutput.textContent += `${line}\n`;
    logsOutput.scrollTop = logsOutput.scrollHeight;
  }
  console.log(message, ...details);
}

function setStatus(text) {
  if (statusEl) {
    statusEl.textContent = text;
  }
  log(`STATUS: ${text}`);
}

function getErrorMessage(error) {
  if (!error) {
    return "Unknown error";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error.message) {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function copyLogsToClipboard() {
  const text = logsOutput ? logsOutput.textContent : "";
  if (!text || !text.trim()) {
    setStatus("No logs to copy yet.");
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    setStatus("Logs copied to clipboard.");
  } catch {
    setStatus("Clipboard blocked. Copy logs manually.");
  }
}

async function loadLibraries() {
  if (libsLoaded) {
    return;
  }
  setStatus("Loading app libraries...");
  const [threeModule, orbitModule, gltfModule, dracoModule, visionModule] = await Promise.all([
    import("three"),
    import("https://unpkg.com/three@0.150.1/examples/jsm/controls/OrbitControls.js"),
    import("https://unpkg.com/three@0.150.1/examples/jsm/loaders/GLTFLoader.js"),
    import("https://unpkg.com/three@0.150.1/examples/jsm/loaders/DRACOLoader.js"),
    import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.1.0-alpha-16")
  ]);

  THREE = threeModule;
  OrbitControls = orbitModule.OrbitControls;
  GLTFLoader = gltfModule.GLTFLoader;
  const DRACOLoader = dracoModule.DRACOLoader;
  FilesetResolver = visionModule.FilesetResolver;
  FaceLandmarker = visionModule.FaceLandmarker;
  
  // Set up the loader with Draco support
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
  dracoLoader.setDecoderConfig({ type: 'js' });
  
  // Create a reusable GLTFLoader instance with Draco attached
  const sharedGLTFLoader = new GLTFLoader();
  sharedGLTFLoader.setDRACOLoader(dracoLoader);
  
  // Store it globally for the Avatar class to access
  window.sharedGLTFLoader = sharedGLTFLoader;

  libsLoaded = true;
  setStatus("Libraries loaded.");
}

function getViewportSizeAtDepth(cam, depth) {
  const viewportHeightAtDepth = 2 * depth * Math.tan(THREE.MathUtils.degToRad(0.5 * cam.fov));
  const viewportWidthAtDepth = viewportHeightAtDepth * cam.aspect;
  return new THREE.Vector2(viewportWidthAtDepth, viewportHeightAtDepth);
}

function createCameraPlaneMesh(cam, depth, material) {
  const viewportSize = getViewportSizeAtDepth(cam, depth);
  const cameraPlaneGeometry = new THREE.PlaneGeometry(viewportSize.width, viewportSize.height);
  cameraPlaneGeometry.translate(0, 0, -depth);
  return new THREE.Mesh(cameraPlaneGeometry, material);
}

class Avatar {
  constructor(url, targetScene) {
    this.url = url;
    this.scene = targetScene;
    
    // Use shared loader if available, otherwise create new (fallback)
    this.loader = window.sharedGLTFLoader || new GLTFLoader();
    
    this.gltf = null;
    this.root = null;
    this.morphTargetMeshes = [];
  }

  loadModel() {
    return new Promise((resolve, reject) => {
      log("Loading model", { url: this.url });
      this.loader.load(
        this.url,
        (gltf) => {
          this.gltf = gltf;
          this.scene.add(gltf.scene);
          gltf.scene.traverse((object) => {
            if (object.isBone && !this.root) {
              this.root = object;
            }
            if (!object.isMesh) {
              return;
            }
            object.frustumCulled = false;
            if (object.morphTargetDictionary && object.morphTargetInfluences) {
              this.morphTargetMeshes.push(object);
            }
          });
          log("Model loaded successfully", { morphMeshCount: this.morphTargetMeshes.length });
          resolve();
        },
        (progress) => {
          if (progress.total) {
            log("Model loading progress", {
              percent: Number((100 * (progress.loaded / progress.total)).toFixed(1))
            });
          }
        },
        (error) => {
          reject(error);
        }
      );
    });
  }

  updateBlendshapes(blendshapesMap) {
    const lerpAmount = 0.5; // Smoother transition to feel more "weighted" and sticky

    for (const mesh of this.morphTargetMeshes) {
      for (const [name, targetValue] of blendshapesMap) {
        if (!Object.prototype.hasOwnProperty.call(mesh.morphTargetDictionary, name)) {
          continue;
        }
        const idx = mesh.morphTargetDictionary[name];
        
        // Smooth transition
        const currentValue = mesh.morphTargetInfluences[idx];
        mesh.morphTargetInfluences[idx] = currentValue + (targetValue - currentValue) * lerpAmount;
      }
    }
  }

  applyMatrix(matrix, scale = 40) {
    if (!this.gltf) {
      return;
    }
    matrix.scale(new THREE.Vector3(scale, scale, scale));
    this.gltf.scene.matrixAutoUpdate = false;
    this.gltf.scene.matrix.copy(matrix);
  }
  
  dispose() {
    if (this.gltf) {
        this.scene.remove(this.gltf.scene);
        this.gltf = null;
        this.morphTargetMeshes = [];
        this.root = null;
    }
  }
}

function buildScene() {
  const width = window.innerWidth;
  const height = window.innerHeight;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(60, width / height, 0.01, 5000);
  camera.position.z = 0;

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  document.body.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  const orbitTarget = camera.position.clone();
  orbitTarget.z -= 5;
  controls.target = orbitTarget;
  controls.update();

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.5);
  directionalLight.position.set(0, 1, 0);
  scene.add(ambientLight);
  scene.add(directionalLight);

  const inputFrameTexture = new THREE.VideoTexture(video);
  inputFrameTexture.encoding = THREE.sRGBEncoding;
  const inputFramesPlane = createCameraPlaneMesh(
    camera,
    500,
    new THREE.MeshBasicMaterial({ map: inputFrameTexture })
  );
  scene.add(inputFramesPlane);

  window.addEventListener("resize", () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  });

  function renderLoop() {
    renderer.render(scene, camera);
    requestAnimationFrame(renderLoop);
  }
  renderLoop();
}

function retarget(blendshapes) {
  const categories = blendshapes[0].categories;
  const coefsMap = new Map();
  
  // Track some key mouth shapes for logging
  const debugValues = {};
  const debugKeys = ["jawOpen", "mouthSmileLeft", "mouthSmileRight", "mouthPucker"];

  for (let i = 0; i < categories.length; i += 1) {
    let value = categories[i].score;
    const name = categories[i].categoryName;

    // Apply boosts
    if (name.includes("brow")) {
      value *= 1.2;
    }
    if (name.includes("eyeBlink")) {
      value *= 1.2;
    }
    if (name.includes("mouth") || name === "jawOpen") {
      value *= 2.0; // Moderate boost for "stickiness"
    }

    // Clamp
    value = Math.min(1.0, Math.max(0, value));

    coefsMap.set(name, value);

    if (debugKeys.includes(name)) {
      debugValues[name] = value.toFixed(2);
    }
  }

  // Log every ~60 frames (approx 2 seconds at 30fps)
  frameCount++;
  if (frameCount % 60 === 0) {
    log("Tracking Debug", debugValues);
  }

  return coefsMap;
}

function detectFaceLandmarks(time) {
  if (!faceLandmarker || !avatar) {
    return;
  }
  const landmarks = faceLandmarker.detectForVideo(video, time);
  const matrices = landmarks.facialTransformationMatrixes;
  if (matrices && matrices.length > 0) {
    const matrix = new THREE.Matrix4().fromArray(matrices[0].data);
    avatar.applyMatrix(matrix, 40);
  }
  const blendshapes = landmarks.faceBlendshapes;
  if (blendshapes && blendshapes.length > 0) {
    avatar.updateBlendshapes(retarget(blendshapes));
  }
}

function onVideoFrame(time) {
  detectFaceLandmarks(time);
  if (typeof video.requestVideoFrameCallback === "function") {
    video.requestVideoFrameCallback(onVideoFrame);
  } else {
    requestAnimationFrame(() => onVideoFrame(performance.now()));
  }
}

async function startCamera() {
  setStatus("Requesting webcam access...");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: "user",
      width: 1280,
      height: 720
    }
  });
  video.srcObject = stream;
  await video.play();
  if (typeof video.requestVideoFrameCallback === "function") {
    video.requestVideoFrameCallback(onVideoFrame);
  } else {
    requestAnimationFrame(() => onVideoFrame(performance.now()));
  }
  setStatus("Webcam started.");
}

async function loadFaceLandmarker() {
  setStatus("Loading MediaPipe vision files...");
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.1.0-alpha-16/wasm"
  );
  setStatus("Creating face landmarker...");
  faceLandmarker = await FaceLandmarker.createFromModelPath(
    vision,
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task"
  );
  await faceLandmarker.setOptions({
    baseOptions: { delegate: "GPU" },
    runningMode: "VIDEO",
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true
  });
  setStatus("MediaPipe ready.");
}

async function switchAvatar(url) {
  if (avatar) {
    avatar.dispose();
  }
  setStatus(`Loading model: ${url}...`);
  avatar = new Avatar(url, scene);
  try {
    await avatar.loadModel();
    setStatus("Model switched successfully.");
  } catch (error) {
    setStatus(`Failed to switch model: ${getErrorMessage(error)}`);
    // Restore default if switch fails? Or just leave it broken. 
    // For now, leave it and let user try another.
  }
}

async function run() {
  try {
    await loadLibraries();
    buildScene();
    
    // Initial model load
    const selectedUrl = modelSelect.value;
    await switchAvatar(selectedUrl);
    
    await loadFaceLandmarker();
    await startCamera();
    setStatus("Tracking active.");
  } catch (error) {
    setStatus("Startup failed. Open logs.");
    log("Startup error", {
      message: error?.message ?? String(error)
    });
    await copyLogsToClipboard();
    startButton.disabled = false;
  }
}

if (logsToggleButton && logsPanel) {
  logsToggleButton.addEventListener("click", () => {
    logsPanel.classList.toggle("hidden");
    logsToggleButton.textContent = logsPanel.classList.contains("hidden") ? "Show Logs" : "Hide Logs";
  });
}

if (clearLogsButton && logsOutput) {
  clearLogsButton.addEventListener("click", () => {
    logsOutput.textContent = "";
  });
}

if (copyLogsButton) {
  copyLogsButton.addEventListener("click", async () => {
    await copyLogsToClipboard();
  });
}

if (startButton) {
  startButton.addEventListener("click", async () => {
    startButton.disabled = true;
    await run();
  });
}

if (modelSelect) {
  modelSelect.addEventListener("change", async (e) => {
    // If scene is active, switch. Otherwise just wait for start.
    if (scene && libsLoaded) {
      await switchAvatar(e.target.value);
    }
  });
}

window.addEventListener("error", (event) => {
  log("Window error", { message: event.message, file: event.filename });
});

window.addEventListener("unhandledrejection", (event) => {
  log("Unhandled promise rejection", { reason: getErrorMessage(event.reason) });
});

log("App loaded. Select model and click Start Camera.");
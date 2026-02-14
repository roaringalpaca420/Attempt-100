import * as THREE from "https://cdn.skypack.dev/three@0.150.1";
import { OrbitControls } from "https://cdn.skypack.dev/three@0.150.1/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "https://cdn.skypack.dev/three@0.150.1/examples/jsm/loaders/GLTFLoader.js";
import {
  FilesetResolver,
  FaceLandmarker
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.1.0-alpha-16";

const MODEL_URL = "../Pug.glb";

const statusEl = document.getElementById("status");
const startButton = document.getElementById("startButton");
const logsToggleButton = document.getElementById("logsToggleButton");
const logsPanel = document.getElementById("logsPanel");
const logsOutput = document.getElementById("logsOutput");
const clearLogsButton = document.getElementById("clearLogsButton");
const video = document.getElementById("video");

let faceLandmarker = null;
let avatar = null;
let scene = null;
let camera = null;
let renderer = null;
let controls = null;

function log(message, ...details) {
  const time = new Date().toLocaleTimeString();
  const line = `[${time}] ${message} ${details.map((x) => JSON.stringify(x)).join(" ")}`;
  logsOutput.textContent += `${line}\n`;
  logsOutput.scrollTop = logsOutput.scrollHeight;
  console.log(message, ...details);
}

function setStatus(text) {
  statusEl.textContent = text;
  log(`STATUS: ${text}`);
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
    this.loader = new GLTFLoader();
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
    for (const mesh of this.morphTargetMeshes) {
      for (const [name, value] of blendshapesMap) {
        if (!Object.hasOwn(mesh.morphTargetDictionary, name)) {
          continue;
        }
        const idx = mesh.morphTargetDictionary[name];
        mesh.morphTargetInfluences[idx] = value;
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
  for (let i = 0; i < categories.length; i += 1) {
    const blendshape = categories[i];
    if (blendshape.categoryName === "browOuterUpLeft" || blendshape.categoryName === "browOuterUpRight") {
      blendshape.score *= 1.2;
    }
    if (blendshape.categoryName === "eyeBlinkLeft" || blendshape.categoryName === "eyeBlinkRight") {
      blendshape.score *= 1.2;
    }
    coefsMap.set(blendshape.categoryName, blendshape.score);
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
  video.requestVideoFrameCallback(onVideoFrame);
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
  video.requestVideoFrameCallback(onVideoFrame);
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

async function run() {
  try {
    buildScene();
    avatar = new Avatar(MODEL_URL, scene);
    await avatar.loadModel();
    await loadFaceLandmarker();
    await startCamera();
    setStatus("Tracking active.");
  } catch (error) {
    setStatus("Startup failed. Open logs.");
    log("Startup error", {
      message: error?.message ?? String(error)
    });
  }
}

logsToggleButton.addEventListener("click", () => {
  logsPanel.classList.toggle("hidden");
  logsToggleButton.textContent = logsPanel.classList.contains("hidden") ? "Show Logs" : "Hide Logs";
});

clearLogsButton.addEventListener("click", () => {
  logsOutput.textContent = "";
});

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  await run();
});

log("App loaded. Click Start Camera to begin.");

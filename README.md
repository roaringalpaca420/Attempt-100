# Face Avatar - 3D ROARINGAPACA

Webcam-driven 3D face avatar using MediaPipe face tracking. Default model: **3D ROARINGAPACA.glb**.

## Run locally

```bash
node server.js
```

Then open http://localhost:8080

## Models

- **3D ROARINGAPACA** (default) - Primary avatar model
- **Raccoon Backup** - Fallback model

To add new models: place `.glb` files in this folder and add an option to the model dropdown in `index.html`.

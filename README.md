# Opus Home Twin: room video to repaintable 3D room

Upload a video of a room and get a 3D model of it that you can repaint in Birla Opus shades, measure, and send to a PaintCraft survey.

## How it works

1. The app (`public/index.html`) uploads the video to this server.
2. The server shrinks it to 1080p (KIRI's limit) with ffmpeg and sends it to the **KIRI Engine 3DGS API** with "3DGS to Mesh" on, asking for a GLB.
3. The app polls for progress. KIRI usually takes a few minutes.
4. The server downloads KIRI's zip, pulls out the GLB and sends it to the app. The app caches it on the phone, so reopening is instant.
5. In the browser the app finds the room in the scan (which way is up, floor, ceiling, walls, door and window gaps), scales it from the ceiling height the user enters, and repaints only the wall surfaces while keeping the real lighting and furniture.

The KIRI API key stays on the server and is never sent to the phone.

## Run it locally

```bash
npm install
npm run mock        # no KIRI key needed: returns a built-in sample scan after ~20 s
# or, with a real key:
KIRI_API_KEY=your_key npm start
```

Open http://localhost:8080.

## Deploy (Render, about 10 minutes)

1. Put this folder in a GitHub repository.
2. In Render, choose **New > Blueprint** and pick the repository. `render.yaml` sets everything up.
3. When asked, paste your **KIRI_API_KEY** (from the KIRI Engine developer portal).
4. Open the Render URL on your phone. Camera upload works because the page is served over HTTPS.

The Starter plan is recommended for demos: the free plan sleeps when idle and takes about a minute to wake.

Any Node 20+ host works (Railway, Fly.io, a VM). Set `KIRI_API_KEY` and run `npm start`.

### Keeping the app on Netlify instead

Deploy the server as above, then open the Netlify app with `?api=https://your-server.onrender.com` added to the link. To lock the server to your site, set `ALLOW_ORIGIN=https://your-site.netlify.app`.

## Demo tips

- **Process the room before the meeting.** When a scan finishes, the app remembers it. You can also open `https://your-server/?scan=SCAN_ID` to jump straight to a finished scan. KIRI keeps finished models for a limited time, so reprocess close to the demo date.
- **Filming:** a bright room, a slow walk along the walls with the phone upright at chest height, every wall and corner in view, 1 to 2 minutes.
- **If the model appears on its side**, tap "Model on its side? Turn it" on the check screen.

## Limits to know

- Rectangular rooms work best. Walls are found as flat vertical planes at right angles; curved or angled walls are not repainted.
- Pictures hanging flat on a wall are tinted along with it.
- Scale comes from the ceiling height the user enters, so a tape-measured value gives the best estimate.
- Each reconstruction uses KIRI credits.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | `{ ok, mock }` |
| POST | `/api/scans` | multipart `video` field, returns `{ id }` |
| GET | `/api/scans/:id` | `{ state, serialize }`, state is preparing, sending, queued, processing, ready, failed or expired |
| GET | `/api/scans/:serialize/model` | the GLB |

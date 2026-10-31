# Garden Builder

A 3D garden planner that runs in the browser. Scan your garden with your phone, load the scan, then plant trees, shrubs and flowers in it. You can watch them grow over the years, change with the seasons, and see where the sun and shade fall.

There's no build step and nothing to install. It's plain HTML, CSS and ES modules, with [Three.js](https://threejs.org) loaded from a CDN.

## Features

- **Load a 3D scan** of your garden: `.glb` / `.gltf` (textured mesh, the best option), `.ply` (mesh, point cloud or Gaussian splat), `.obj` (plus `.mtl` and textures if you drop them in together). Draco and Meshopt compressed GLBs work too.
- **Fix the orientation**: PLY and OBJ scans are turned upright automatically. *Scan settings* lets you tilt, roll, rescale or raise/lower the ground.
- **18 low-poly plants**: trees, shrubs, flowers, foliage plants and a raised veg bed. Each has its mature size, sun needs and flowering time.
- **Plant by clicking**: pick a plant, then click (or tap) on the ground in the scan. Each copy gets a slightly different shape.
- **Edit plants**: select a plant to move it (it stays on the ground), rotate it, resize it, duplicate or delete it, and add a planted date and notes.
- **Growth slider**: see the garden today or up to 20 years ahead. Each plant's age comes from its planted date.
- **Month slider**: spring blossom, summer flowers, autumn colour and bare winter branches. Bulbs and perennials die back when they should.
- **Sun and shade**: the time-of-day slider moves the sun for your latitude and month, with real shadows. Use the 🧭 button to line up north with your scan.
- **Mature spread circles** show how far each plant will reach, to help with spacing.
- **Autosave**: the layout is kept in localStorage and the scan in IndexedDB, so your garden is still there when you come back. Back up or move to another device with *⋯ → Save layout file*.
- **Export** a `.png` picture or the whole scene as a `.glb` (scan plus plants).
- Works on desktop and on phones/tablets (touch to orbit, tap to plant).

## Sharing with a partner

Sign in (top right) to keep your scan and plants online and plan the garden together. Both of you use your own email and get a sign-in link, so there are no passwords. One of you creates the garden and gets an invite code. The other signs in and joins with that code.

- The scan is uploaded once to private storage and downloaded automatically on your partner's device.
- Plants, notes, compass direction and scan orientation sync live: when your partner plants something, it appears on your screen.
- Growth, month and time sliders are yours alone, so you can each look at different seasons.
- If you edit the same plant at the same moment, the last change wins.
- Without signing in, everything still works and stays on your device.

Backend: [Supabase](https://supabase.com) (sign-in, a small Postgres database, file storage and realtime). The database setup is in `supabase/schema.sql`. The URL and publishable key in `js/cloud.js` are meant to be public, because `schema.sql` restricts every table and the scan storage to the members of each garden.

## Scanning your garden

1. Use a phone scanning app: **Polycam**, **Scaniverse**, **Luma AI**, **KIRI Engine** or **RealityScan**. LiDAR iPhones/iPads (Pro models) are quickest.
2. Pick a bright, overcast day. Harsh sun and moving shadows make scans patchy.
3. Walk slowly round the edge of the garden with the phone at chest height, pointing slightly down. Then do a second loop pointing more steeply at the ground.
4. Export as **GLB** if you can. A PLY point cloud or splat also works.
5. Open the planner and click **Load scan**, or drag the file onto the page.

Scans from these apps are normally in metres. If yours comes out the wrong size, change *Scan settings → Scale*. For example, use `0.01` if the app exported centimetres.

## Running locally

ES modules need to be served over HTTP (opening `index.html` as a file won't work):

```bash
python3 -m http.server 8765
```

Then open <http://localhost:8765>.

`tests/selftest.html` runs a quick self-check. It builds every plant in every season and loads generated PLY, splat and GLB scans. Open <http://localhost:8765/tests/selftest.html> and every line should say PASS.

## Hosting on GitHub Pages

Repository **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)`**. The app will be at `https://<user>.github.io/garden-builder/`.

Scans are never uploaded anywhere. They stay in your own browser.

## Project layout

| File | What it does |
| --- | --- |
| `index.html` | Page structure, UI panels, import map |
| `css/style.css` | Styling, including the small-screen layout |
| `js/main.js` | App wiring: scene, input, placing/selecting plants, UI, save/load |
| `js/plants.js` | Plant catalogue, procedural plant models, growth and seasons |
| `js/scan.js` | Loading scans, auto-orientation, centring/grounding, fast raycasting |
| `js/environment.js` | Sun position, sky, shadows, compass, demo garden |
| `js/storage.js` | localStorage + IndexedDB persistence, downloads |
| `js/cloud.js` | Supabase client: sign-in, gardens, plants, scan files |
| `js/sync.js` | Sign-in dialog and live syncing with your partner |
| `supabase/schema.sql` | Database tables, access rules and storage setup |

### Adding a plant

Add an entry to `PLANTS` in `js/plants.js`. Give it an `id`, its display info, `height`/`spread` in metres, `mature` (years to full size), `start` (fraction of full size when planted), seasonal fields (`autumn`, `winter`, `dormant`, `bloom`) and a `build(b)` function. In `build`, add shapes with `b.add(role, color, geometry)`. Roles are `foliage`, `flower`, `fruit`, `trunk` and `mulch`, and the role decides how each part behaves through the seasons.

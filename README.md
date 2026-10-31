# Garden Builder

A 3D garden planner that runs in the browser. Scan your garden with your phone, load the scan, then plant trees, shrubs and flowers in it. You can watch them grow over the years, change with the seasons, and see where the sun and shade fall.

There's no build step and nothing to install. It's plain HTML, CSS and ES modules, with [Three.js](https://threejs.org) loaded from a CDN.

## Features

- **Load a 3D scan** of your garden: `.glb` / `.gltf` (textured mesh, the best option), `.ply` (mesh, point cloud or Gaussian splat), `.obj` (plus `.mtl` and textures if you drop them in together). Draco and Meshopt compressed GLBs work too.
- **Fix the orientation**: PLY and OBJ scans are turned upright automatically. *Scan settings* lets you tilt, roll, rescale or raise/lower the ground.
- **56 plants** in six groups:
  - **NZ natives (25):** pōhutukawa, southern rātā, kōwhai, kauri, rimu, tōtara, kānuka, mānuka, tī kōuka, nīkau, ponga, harakeke, toetoe, pīngao, kākābeak, kawakawa, koromiko, kōhūhū, taupata, horoeka, rengarenga, Chatham Island forget-me-not, rautini, shrubby tororaro and a kāpuka hedge. Forms and flowering follow the [DOC native plants guide](https://www.doc.govt.nz/nature/native-plants/).
  - **Edible (15):** lemon, feijoa, avocado, fig, plum, apple, blueberry, raspberry canes, strawberries, tomatoes, passionfruit trellis, kiwifruit pergola, rosemary, pumpkin patch and a raised veg bed.
  - **Trees, shrubs, flowers and foliage plants:** the rest.

  Each plant has its mature size, sun needs and flowering or fruiting time, and is modelled with bark, twigs, leafy canopies, petals and fruit.
- **Plant by clicking**: pick a plant, then click (or tap) on the ground in the scan. Each copy gets a slightly different shape.
- **Edit plants**: select a plant to move it (it stays on the ground), rotate it, resize it, duplicate or delete it, and add a planted date and notes.
- **Growth slider**: see the garden today or up to 20 years ahead. Each plant's age comes from its planted date.
- **Month slider**: spring blossom, summer flowers, autumn colour and bare winter branches. Bulbs and perennials die back when they should.
- **Sun and shade**: the time-of-day slider moves the sun for your latitude and month, with real shadows. Use the 🧭 button to line up north with your scan.
- **Mature spread circles** show how far each plant will reach, to help with spacing.
- **Autosave**: the layout is kept in localStorage and the scan in IndexedDB, so your garden is still there when you come back. Back up or move to another device with *⋯ → Save layout file*.
- **Print a plan** (*⋯ → Print plan*): a scaled, north-up PDF for clients and crews. See [Printed plans](#printed-plans).
- **Export** a `.png` picture or the whole scene as a `.glb` (scan plus plants).
- Works on desktop and on phones/tablets (touch to orbit, tap to plant).

## Landscaping

Open the **Landscaping** tab to build hard landscaping into the garden:

| Tool | How to draw it | Materials |
|---|---|---|
| Path | click along the route (smooth curves optional) | gravel, red scoria, bark, concrete pavers, clay brick, flagstone, exposed aggregate, decking boardwalk, stepping stones |
| Paving & patio | click each corner | pavers, brick, flagstone, exposed aggregate, raised timber deck, gravel, scoria |
| Garden bed / lawn | click around the edge | mulched soil, bark, lawn, gravel, scoria |
| Retaining wall | click along the line | H4 sleepers, concrete block, dry-stacked stone, gabion baskets, brick, corten steel |
| Fence | click along the line | timber paling |
| Steps | click the bottom, then the top | timber, concrete, stone, brick, sleeper & gravel |

To finish, double-click, press <kbd>Enter</kbd> or tap **Finish**. For areas, you can also click the first corner again. Hold <kbd>Shift</kbd> to keep lines at 15° angles. Click a feature to change its material, width or height, drag its white dots to reshape it, or drag the feature to move it.

Each feature shows its length or area, plus a rough shopping list: pavers or bricks (with spare), sleepers and posts, m³ of gravel or concrete, and step riser and tread sizes. Plants can be placed on top of paving, decks and beds. `tests/landscape.html` shows every tool on the demo garden.

## Printed plans

*⋯ → Print plan (.pdf)* makes a PDF drawn to scale from directly above, with north at the top:

- **Sheet 1, the plan.** Your scan sits underneath, faded. Landscaping is drawn on top as vector shapes with real-size hatches (400 mm pavers, brick bond, 140 mm deck boards, gravel stipple). Each feature has a tag (L1, L2…). Plants are circles at their mature spread, numbered by species. Straight edges of paving, beds and walls get dimension lines. Curved walls and paths show their total length.
- **Sidebar.** A landscaping schedule (size and materials to order for each feature), a plant schedule (quantity and mature height × width for each species), a north arrow, a scale bar and a title block (client, site, designer, date, revision, scale, sheet number). Long schedules continue on extra sheets.
- **3D view sheet** (optional): the current camera view, month and growth.

Options: A4 to A1 paper, a scale from 1:20 to 1:1000 (or *Best fit*), the design only or the whole scan, and a background of faded scan (a working drawing), full colour from above (for clients) or none (a line drawing). The title block details are remembered for next time.

Set north with 🧭 before printing, so the plan and north arrow face the right way. jsPDF and the DejaVu Sans font load from the CDN the first time you print. The font is used so macrons (ā, ō) print correctly.

## Sharing with a partner

Sign in (top right) to keep your scan and plants online and plan the garden together. One of you creates the garden and gets an invite code; the other signs in and joins with that code.

Accounts are created by hand in the Supabase dashboard, so there's no email or sign-up step. Go to **Authentication → Users → Add user → Create new user** and enter:

- Email: `<username>@users.garden-builder.invalid` (for example `ally@users.garden-builder.invalid`). The `.invalid` domain can never receive mail.
- Password: the person's password.
- Tick **Auto Confirm User**.

People then sign in with just their username (`Ally`, any capitalisation) and password. To change a password, use **Authentication → Users** in Supabase. You can also turn off **Allow new users to sign up** (Authentication → Sign In / Providers), so nobody else can create accounts.

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

`tests/gallery.html` shows every plant side by side, by category and season. `tests/selftest.html` runs a quick self-check. It builds every plant in every season and loads generated PLY, splat and GLB scans. Open <http://localhost:8765/tests/selftest.html> and every line should say PASS.

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
| `js/landscape.js` | Landscaping materials, textures, shapes and quantities |
| `js/landscapeEditor.js` | Drawing, selecting and reshaping landscaping |
| `js/plan.js` | Printed PDF plan: top-down underlay, vector drawing, schedules, title block |
| `supabase/schema.sql` | Database tables, access rules and storage setup |

### Adding a plant

Add an entry to `PLANTS` in `js/plants.js`. Give it an `id`, its display info, `height`/`spread` in metres, `mature` (years to full size), `start` (fraction of full size when planted), seasonal fields (`autumn`, `winter`, `dormant`, `bloom`) and a `build(b)` function. In `build`, add shapes with `b.add(role, color, geometry)`. Roles are `foliage`, `flower`, `fruit`, `trunk` and `mulch`, and the role decides how each part behaves through the seasons.

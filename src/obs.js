/**
 * An importable OBS scene, so setup is one file instead of hand-adding
 * browser sources and pasting URLs.
 *
 * The shape here was derived from a real OBS 31 scene collection and verified
 * by importing a generated one into OBS, which loaded it and rendered both
 * sources. Fields OBS fills in itself are still written out, because a
 * collection missing them gets silently "repaired" on load.
 */
import { randomUUID } from 'node:crypto';

/** Everything OBS expects on a source, minus the parts that differ. */
const SOURCE_BASE = {
  prev_ver: 520159233,
  mixers: 0,
  sync: 0,
  flags: 0,
  volume: 1.0,
  balance: 0.5,
  enabled: true,
  muted: false,
  'push-to-mute': false,
  'push-to-mute-delay': 0,
  'push-to-talk': false,
  'push-to-talk-delay': 0,
  hotkeys: {},
  deinterlace_mode: 0,
  deinterlace_field_order: 0,
  monitoring_type: 0,
  canvas_uuid: '',
  private_settings: {},
};

/** OBS's own default browser CSS — this is what makes a source transparent. */
const TRANSPARENT_CSS =
  'body { background-color: rgba(0, 0, 0, 0); margin: 0px auto; overflow: hidden; }';

function sceneItem({ name, uuid, id, x, y, width, height, canvas }) {
  return {
    name,
    source_uuid: uuid,
    visible: true,
    locked: false,
    rot: 0.0,
    // The canvas the scale was authored against, NOT the source size. Setting
    // it to the source made OBS think the canvas was 410x396 and scale the
    // browser source up ~3x, which rendered the text enormous and truncated
    // every name.
    scale_ref: { x: canvas.width, y: canvas.height },
    align: 5,
    bounds_type: 0,
    bounds_align: 0,
    bounds_crop: false,
    crop_left: 0,
    crop_top: 0,
    crop_right: 0,
    crop_bottom: 0,
    id,
    group_item_backup: false,
    pos: { x, y },
    pos_rel: { x: (x / canvas.width) * 2 - 1, y: (y / canvas.height) * 2 - 1 },
    scale: { x: 1.0, y: 1.0 },
    scale_rel: { x: 1.0, y: 1.0 },
    bounds: { x: 0.0, y: 0.0 },
    bounds_rel: { x: 0.0, y: 0.0 },
    scale_filter: 'disable',
    blend_method: 'default',
    blend_type: 'normal',
    show_transition: { duration: 0 },
    hide_transition: { duration: 0 },
  };
}

/**
 * @param {object} opts
 * @param {string} opts.base      e.g. http://127.0.0.1:8787
 * @param {number} [opts.width]   canvas width  (your OBS base resolution)
 * @param {number} [opts.height]  canvas height
 * @param {object} [opts.overlay] query options to bake into the chat URL
 * @param {object} [opts.board]   query options to bake into the leaderboard URL
 * @param {string} [opts.name]    scene collection name
 */
export function buildScene({
  base,
  width = 1920,
  height = 1080,
  overlay = {},
  board = {},
  name = 'pumpstream',
} = {}) {
  const canvas = { width, height };
  const sceneName = 'pumpstream';

  const chatUuid = randomUUID();
  const boardUuid = randomUUID();
  const sceneUuid = randomUUID();

  const qs = (obj) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(obj)) {
      p.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
    }
    const s = p.toString();
    return s ? '?' + s : '';
  };

  // Chat down the left, leaderboard top-right — the arrangement most streams
  // end up at anyway, and it leaves the middle of frame clear.
  const chatW = Math.round(width * 0.32);
  const chatH = Math.round(height * 0.55);
  const boardW = Math.round(width * 0.3);
  const boardH = Math.round(height * 0.38);

  // Text size has to follow the canvas, or a 720p board truncates every name
  // while a 4K one renders it postage-stamp small. Verified at 720p and 1080p.
  const fontFor = (fraction) => Math.max(10, Math.round(height * fraction));

  const sources = [
    {
      ...SOURCE_BASE,
      name: 'pumpstream chat',
      uuid: chatUuid,
      id: 'browser_source',
      versioned_id: 'browser_source',
      settings: {
        // A caller-supplied font still wins: qs(overlay) is spread last.
        url: `${base}/overlay${qs({ font: fontFor(1 / 54), ...overlay })}`,
        width: chatW,
        height: chatH,
        css: TRANSPARENT_CSS,
        restart_when_active: true,
      },
    },
    {
      ...SOURCE_BASE,
      name: 'pumpstream leaderboard',
      uuid: boardUuid,
      id: 'browser_source',
      versioned_id: 'browser_source',
      settings: {
        url: `${base}/overlay/leaderboard${qs({ font: fontFor(1 / 72), ...board })}`,
        width: boardW,
        height: boardH,
        css: TRANSPARENT_CSS,
        restart_when_active: true,
      },
    },
    {
      ...SOURCE_BASE,
      name: sceneName,
      uuid: sceneUuid,
      id: 'scene',
      versioned_id: 'scene',
      settings: {
        id_counter: 2,
        custom_size: false,
        items: [
          sceneItem({
            name: 'pumpstream chat',
            uuid: chatUuid,
            id: 1,
            x: Math.round(width * 0.02),
            y: height - chatH - Math.round(height * 0.04),
            width: chatW,
            height: chatH,
            canvas,
          }),
          sceneItem({
            name: 'pumpstream leaderboard',
            uuid: boardUuid,
            id: 2,
            x: width - boardW - Math.round(width * 0.02),
            y: Math.round(height * 0.04),
            width: boardW,
            height: boardH,
            canvas,
          }),
        ],
      },
    },
  ];

  return {
    current_scene: sceneName,
    current_program_scene: sceneName,
    scene_order: [{ name: sceneName }],
    name,
    sources,
    groups: [],
    quick_transitions: [],
    transitions: [],
    saved_projectors: [],
    canvases: [],
    current_transition: 'Fade',
    transition_duration: 300,
    preview_locked: false,
    scaling_enabled: false,
    scaling_level: 0,
    scaling_off_x: 0.0,
    scaling_off_y: 0.0,
    modules: {},
    resolution: { x: width, y: height },
    version: 2,
  };
}

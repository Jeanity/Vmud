/**
 * The zone map — one level of a zone, drawn.
 *
 * Track A4b, owner-requested: *"the zone editor is going to need some kind of visual map so you can
 * see the zone along with being able to select rooms."* A table can tell you a zone has 219 rooms;
 * only a map tells you it is a castle with a spine of stairs up the middle.
 *
 * **Cheap, because the data is already this shape.** Worldgen normalises room coordinates *per zone*,
 * so every room carries a small integer cell on its own level's grid — IceCrag's level 9 is 110 rooms
 * inside 13x14 — and drawing it is a direct transcription rather than a layout problem. Nothing here
 * computes a position; it reads one.
 *
 * ## The one thing it must not assert
 *
 * **East does not always mean the cell to the right.** `HANDOFF.md`'s first decision is that zones are
 * joined by portals rather than roads, and a staircase or a cross-zone exit leaves this grid entirely.
 * So an exit is drawn as a line to its neighbour **only when that neighbour is a room on this same
 * level, in the cell the direction points at**. Everything else — a portal, a level change, an exit to
 * a zone that is not loaded — is a stub: the map says "there is a way out here" without claiming where
 * it lands. Drawing those as lines would put an adjacency on screen that the world does not have,
 * which is the exact failure the Place model exists to prevent.
 *
 * SVG rather than canvas: it is a few hundred rects, every one of them wants to be clickable and to
 * carry a tooltip, and both are free in the DOM.
 */

import type { Occupants, ZoneRoomRow } from './api.ts';

/** Cell pitch and the room square inside it, in SVG units. The gap is where exit lines are drawn. */
const CELL = 30;
const ROOM = 20;

/**
 * Terrain colour. Deliberately muted and close to the game's own palette — the map is for reading
 * shape and finding a room, not for admiring, and a rainbow would drown the marks that matter.
 */
const SECTOR_FILL: Readonly<Record<string, string>> = {
  inside: '#4a4436',
  city: '#55503f',
  road: '#6b6046',
  field: '#54613f',
  forest: '#3d5434',
  hills: '#5c5a3c',
  mountain: '#5a5145',
  swamp: '#3f4f42',
  desert: '#7a6c48',
  arctic: '#6a7480',
  cave: '#3b3a36',
  shallow_water: '#3c5566',
  deep_water: '#2d4356',
  underwater: '#27384a',
  air: '#4b5560',
  astral: '#4d4258',
};

const UNKNOWN_FILL = '#3a3a34';

export interface ZoneMapOptions {
  readonly rooms: readonly ZoneRoomRow[];
  /** Which level to draw. Rooms on any other are not on this grid. */
  readonly level: number;
  readonly selected: number | undefined;
  readonly onPick: (roomId: number) => void;
}

/** Which cell a compass direction points at, or nothing for the two that leave the plane. */
const STEP: Readonly<Record<string, { dx: number; dy: number } | undefined>> = {
  north: { dx: 0, dy: -1 },
  south: { dx: 0, dy: 1 },
  east: { dx: 1, dy: 0 },
  west: { dx: -1, dy: 0 },
  up: undefined,
  down: undefined,
};

function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function occupantLine(occupants: Occupants): string {
  const parts: string[] = [];
  if (occupants.mobs.length > 0) parts.push(occupants.mobs.join(', '));
  if (occupants.players.length > 0) parts.push(`${occupants.players.join(', ')} (player)`);
  if (occupants.corpses.length > 0) parts.push(`${occupants.corpses.length} corpse(s)`);
  return parts.join(' · ');
}

/** Draws one level and returns the `<svg>`. Empty levels return an svg with nothing in them. */
export function drawZoneMap(options: ZoneMapOptions): SVGElement {
  const here = options.rooms.filter((room) => room.level === options.level);
  const byCell = new Map<string, ZoneRoomRow>();
  for (const room of here) byCell.set(`${room.x},${room.y}`, room);

  const maxX = here.reduce((max, room) => Math.max(max, room.x), 0);
  const maxY = here.reduce((max, room) => Math.max(max, room.y), 0);
  const width = (maxX + 1) * CELL;
  const height = (maxY + 1) * CELL;

  const root = svg('svg', {
    viewBox: `${-CELL / 2} ${-CELL / 2} ${width + CELL} ${height + CELL}`,
    width: width + CELL,
    height: height + CELL,
    class: 'zone-map',
  });

  const centre = (room: ZoneRoomRow): { cx: number; cy: number } => ({
    cx: room.x * CELL + CELL / 2,
    cy: room.y * CELL + CELL / 2,
  });

  // Exits first, so the room squares sit on top of their own lines.
  for (const room of here) {
    const { cx, cy } = centre(room);
    for (const exit of room.exits) {
      const step = STEP[exit.dir];
      if (!step) {
        // Vertical travel. A caret in the corner rather than a line: the far side is a different
        // Place and there is nowhere on *this* grid to draw it to.
        root.append(
          svg('text', {
            x: cx + ROOM / 2 - 4,
            y: cy - ROOM / 2 + 8,
            class: 'zone-map-vertical',
          }),
        );
        (root.lastChild as SVGElement).textContent = exit.dir === 'up' ? '▴' : '▾';
        continue;
      }
      const neighbour = byCell.get(`${room.x + step.dx},${room.y + step.dy}`);
      // A line only when the destination really is the room in that cell. Otherwise a stub — a way
      // out that goes somewhere this drawing cannot show.
      const joined = neighbour !== undefined && neighbour.id === exit.to;
      const reach = joined ? CELL / 2 : ROOM / 2 + 3;
      root.append(
        svg('line', {
          x1: cx + (step.dx * ROOM) / 2,
          y1: cy + (step.dy * ROOM) / 2,
          x2: cx + step.dx * reach,
          y2: cy + step.dy * reach,
          class: joined ? 'zone-map-link' : 'zone-map-stub',
        }),
      );
    }
  }

  for (const room of here) {
    const { cx, cy } = centre(room);
    const group = svg('g', { class: 'zone-map-room', tabindex: 0 });
    const cell = svg('rect', {
      x: cx - ROOM / 2,
      y: cy - ROOM / 2,
      width: ROOM,
      height: ROOM,
      rx: 2,
      fill: SECTOR_FILL[room.sector] ?? UNKNOWN_FILL,
      class: room.id === options.selected ? 'picked' : '',
    });
    group.append(cell);

    // A flagged room is worth finding at a glance — `safe`, `no_mob` and `dark` all change a rule.
    if (room.flags.length > 0) {
      group.append(svg('rect', { x: cx - ROOM / 2, y: cy - ROOM / 2, width: ROOM, height: ROOM, rx: 2, class: 'zone-map-flagged' }));
    }
    // Live occupancy, which is the half a static map of the same data could never show.
    const bodies = room.occupants.mobs.length + room.occupants.players.length;
    if (bodies > 0) {
      group.append(svg('circle', { cx, cy, r: 3.5, class: room.occupants.players.length > 0 ? 'zone-map-player' : 'zone-map-mob' }));
    }
    if (room.occupants.corpses.length > 0) {
      group.append(svg('circle', { cx: cx + 6, cy: cy + 6, r: 2, class: 'zone-map-corpse' }));
    }

    const title = svg('title', {});
    const who = occupantLine(room.occupants);
    title.textContent =
      `${room.name} (#${room.id})\n${room.sector}` +
      (room.flags.length > 0 ? ` · ${room.flags.join(' ')}` : '') +
      (who ? `\n${who}` : '');
    group.append(title);

    group.addEventListener('click', () => options.onPick(room.id));
    group.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') options.onPick(room.id);
    });
    root.append(group);
  }

  return root;
}

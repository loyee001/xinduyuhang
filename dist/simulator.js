/* Meter-scale highway renderer. Pose x/y maps to world X/Z; heading is
   clockwise from +Z. Scenery repeats every 400 m; traffic, road markings,
   exits, entrances and signs retain world positions through every camera rebase. */
(() => {
  'use strict';

  const ROAD = Object.freeze({ laneWidth: 3.75, lanes: 3, halfWidth: 5.625, shoulderEdge: 7.1, guardrail: 7.4,
    emergencyStart: 5.625, emergencyEnd: 8.625, emergencyCenter: 7.125,
    guardrailLeft: -7.4, guardrailRight: 8.9, cameraHeight: 1.25, repeat: 400, far: 1500 });
  const bounds = Object.freeze({ left: ROAD.guardrailLeft, right: ROAD.guardrailRight, back: -Infinity, front: Infinity });
  const obstacles = Object.freeze([]);
  const NEAR = .08, FOCAL = 1.48, HORIZON = .45;
  // The camera follows the selected travel direction, while the physical
  // vehicle pose continues to describe its nose even when reversing.
  const viewHeading = pose => pose.heading + (pose.gear === 'reverse' ? 180 : 0);
  const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const COLORS = {
    grass: rgb('#91a877'), verge: rgb('#b6b39a'), road: rgb('#515961'), shoulder: rgb('#626a70'),
    paint: rgb('#f6f4db'), steel: rgb('#b1bcc0'), steelDark: rgb('#687a80'), green: rgb('#22705c'),
    amber: rgb('#f5bb51'), red: rgb('#f06456'), white: rgb('#f0f5ee'), dark: rgb('#354448'),
    hills: rgb('#709580'), hillsFar: rgb('#97b4a2')
  };

  // Separate ground, road, paint and object layers also give the Canvas 2D
  // fallback correct occlusion without sorting a giant ground plane over signs.
  function mesh() { return { vertices: [], faces: [] }; }
  function polygon(target, points, color, layer = 3, material = 0, shade = 1) {
    const tint = color.map(value => Math.min(1, value * shade));
    let x = 0, z = 0;
    for (const point of points) { x += point[0]; z += point[2]; }
    x /= points.length; z /= points.length;
    const radius = Math.max(...points.map(point => Math.hypot(point[0] - x, point[2] - z)));
    target.faces.push({ points, color: tint, layer, material, x, z, radius });
    for (let i = 1; i < points.length - 1; i++) {
      for (const index of [0, i, i + 1]) target.vertices.push(...points[index], ...tint, material);
    }
  }
  function ground(target, x1, x2, z1, z2, height, color, layer = 1, material = 0) {
    polygon(target, [[x1,height,z1],[x2,height,z1],[x2,height,z2],[x1,height,z2]], color, layer, material);
  }
  function box(target, x, y, z, width, height, depth, color, layer = 3) {
    const l = x - width / 2, r = x + width / 2, n = z - depth / 2, f = z + depth / 2, t = y + height;
    polygon(target, [[l,y,n],[r,y,n],[r,t,n],[l,t,n]], color, layer, 0, .87);
    polygon(target, [[r,y,f],[l,y,f],[l,t,f],[r,t,f]], color, layer, 0, .94);
    polygon(target, [[l,y,f],[l,y,n],[l,t,n],[l,t,f]], color, layer, 0, .73);
    polygon(target, [[r,y,n],[r,y,f],[r,t,f],[r,t,n]], color, layer, 0, .82);
    polygon(target, [[l,t,n],[r,t,n],[r,t,f],[l,t,f]], color, layer, 0, 1.08);
  }
  function hill(target, x, z, width, depth, height, color) {
    const peak = [x + width * .08, height, z];
    const ring = [[x-width/2,-.1,z-depth/2],[x+width/2,-.1,z-depth/2],[x+width*.55,-.1,z+depth*.45],[x-width*.4,-.1,z+depth/2]];
    for (let i = 0; i < 4; i++) polygon(target, [ring[i], ring[(i+1)%4], peak], color, 0, 0, [.93,1,.86,.8][i]);
  }

  // Small vector lettering stays sharp on both backends and needs no textures,
  // fonts, image downloads or external graphics dependencies.
  const FONT = {
    'A':['01110','10001','10001','11111','10001','10001','10001'],
    'E':['11111','10000','10000','11110','10000','10000','11111'],
    'G':['01111','10000','10000','10111','10001','10001','01110'],
    'H':['10001','10001','10001','11111','10001','10001','10001'],
    'I':['111','010','010','010','010','010','111'],
    'O':['01110','10001','10001','10001','10001','10001','01110'],
    'M':['10001','11011','10101','10101','10001','10001','10001'],
    'P':['11110','10001','10001','11110','10000','10000','10000'],
    'R':['11110','10001','10001','11110','10100','10010','10001'],
    'S':['01111','10000','10000','01110','00001','00001','11110'],
    'T':['11111','00100','00100','00100','00100','00100','00100'],
    'W':['10001','10001','10001','10101','10101','10101','01010'],
    'X':['10001','10001','01010','00100','01010','10001','10001'],
    'Y':['10001','10001','01010','00100','00100','00100','00100'],
    '0':['01110','10001','10011','10101','11001','10001','01110'],
    '1':['010','110','010','010','010','010','111'],
    '2':['01110','10001','00001','00010','00100','01000','11111'],
    '3':['11110','00001','00001','01110','00001','00001','11110'],
    '4':['10010','10010','10010','11111','00010','00010','00010'],
    '5':['11111','10000','10000','11110','00001','00001','11110'],
    '6':['01110','10000','10000','11110','10001','10001','01110'],
    '7':['11111','00001','00010','00100','01000','01000','01000'],
    '8':['01110','10001','10001','01110','10001','10001','01110'],
    '9':['01110','10001','10001','01111','00001','00001','01110']
  };
  function lettering(target, text, centerX, bottom, z, height, color = COLORS.white) {
    const pixel = height / 7;
    const width = [...text].reduce((sum, character) => sum + (FONT[character]?.[0].length || 3) + 1, -1) * pixel;
    let left = centerX - width / 2;
    for (const character of text) {
      const glyph = FONT[character];
      if (glyph) glyph.forEach((row, r) => [...row].forEach((value, c) => {
        if (value === '1') {
          const x = left + c * pixel, y = bottom + (6 - r) * pixel;
          polygon(target, [[x,y,z],[x+pixel*.94,y,z],[x+pixel*.94,y+pixel*.94,z],[x,y+pixel*.94,z]], color);
        }
      }));
      left += ((glyph?.[0].length || 3) + 1) * pixel;
    }
  }
  function gantry(target, z) {
    for (const x of [-8.3,9.8]) {
      box(target,x,0,z,.34,7.3,.34,COLORS.steelDark);
      box(target,x,0,z,.75,.3,.75,COLORS.steel);
    }
    box(target,.75,7,z,18.4,.28,.38,COLORS.steel);
    box(target,0,5.75,z,10.8,1.65,.18,COLORS.green);
    const front = z - .1;
    // A pale border, route badge, highway name and one arrow per lane.
    box(target,0,5.81,front,10.62,.035,.015,COLORS.white);
    box(target,0,7.3,front,10.62,.035,.015,COLORS.white);
    for (const x of [-5.3,5.3]) box(target,x,5.82,front,.035,1.5,.015,COLORS.white);
    lettering(target,'HIGHWAY',0,6.7,front-.025,.42);
    lettering(target,'G60',-4.45,6.88,front-.025,.22);
    for (const x of [-3.75,0,3.75]) {
      polygon(target,[[x-.055,6.04,front-.03],[x+.055,6.04,front-.03],[x+.055,6.42,front-.03],[x-.055,6.42,front-.03]],COLORS.white);
      polygon(target,[[x-.23,6.29,front-.03],[x,6.55,front-.03],[x,6.38,front-.03]],COLORS.white);
      polygon(target,[[x,6.38,front-.03],[x,6.55,front-.03],[x+.23,6.29,front-.03]],COLORS.white);
    }
  }

  function clearSections(start, end, blocked) {
    const sections = [];
    let cursor = start;
    for (const interval of blocked) {
      if (interval.end <= cursor || interval.start >= end) continue;
      if (interval.start > cursor) sections.push([cursor, Math.min(end, interval.start)]);
      cursor = Math.max(cursor, interval.end);
      if (cursor >= end) break;
    }
    if (cursor < end) sections.push([cursor, end]);
    return sections;
  }
  function exitSign(target, exit, worldY, origin) {
    const x = 11.3, z = worldY - origin, front = z - .11;
    box(target,x,0,z,.14,4.5,.14,COLORS.steel);
    box(target,x,3.05,z,3.85,1.45,.18,COLORS.green);
    lettering(target,`EXIT ${exit.number}`,x,3.85,front,.37);
    lettering(target,`${Math.max(0,Math.round(exit.start-worldY))}M`,x-.35,3.32,front,.33);
    polygon(target,[[x+1,3.2,front],[x+1.15,3.2,front],[x+1.6,3.64,front],[x+1.45,3.64,front]],COLORS.white);
    polygon(target,[[x+1.2,3.64,front],[x+1.62,3.75,front],[x+1.62,3.32,front]],COLORS.white);
  }
  const localGeometry = () => window.RoverRoad?.localRoad || { speedLimitKmh:50,laneCenter:29,oncomingLaneCenter:25.5,width:7,halfLaneWidth:1.75 };
  function localSpeedSign(target, worldY, origin) {
    const settings = localGeometry(), x = settings.laneCenter+settings.halfLaneWidth+1.3, z = worldY-origin;
    box(target,x,0,z,.09,2.8,.09,COLORS.steel);
    disc(target,x,2.7,z-.015,.55,rgb('#d4493f'));
    disc(target,x,2.7,z-.025,.44,COLORS.white);
    lettering(target,String(settings.speedLimitKmh),x,2.5,z-.035,.39,COLORS.dark);
  }
  function entranceOccupies(entrances, x, worldY, halfWidth = 0, halfLength = 0) {
    const road = window.RoverRoad;
    return entrances.some(entrance => {
      if (worldY + halfLength < entrance.start || worldY - halfLength > entrance.end) return false;
      // The centerline is monotone, so endpoints bound every intermediate x.
      const near = road.centerForEntrance(entrance,worldY-halfLength);
      const far = road.centerForEntrance(entrance,worldY+halfLength);
      return x+halfWidth >= Math.min(near,far)-entrance.width/2-.75 &&
        x-halfWidth <= Math.max(near,far)+entrance.width/2+.75;
    });
  }
  function buildLocalRoad(target, origin, route, start=-1600, end=2000, entrances=[]) {
    const settings = localGeometry(), left = settings.oncomingLaneCenter-settings.halfLaneWidth;
    const right = settings.laneCenter+settings.halfLaneWidth, middle = (left+right)/2;
    const connection = route?.rampEnd ?? -Infinity, begin = Math.max(start,connection-120-origin);
    for (let z = begin; z < end; z += 20) {
      const z2 = Math.min(z+20,end);
      // The last 120 m widens gently from the exit lane into a two-way road.
      const edge = (at, side) => {
        const t = Math.max(0,Math.min(1,(at+origin-(connection-120))/120));
        return side < 0 ? 26.5+(left-26.5)*t : 31.5+(right-31.5)*t;
      };
      const l1 = Number.isFinite(connection) ? edge(z,-1) : left, r1 = Number.isFinite(connection) ? edge(z,1) : right;
      const l2 = Number.isFinite(connection) ? edge(z2,-1) : left, r2 = Number.isFinite(connection) ? edge(z2,1) : right;
      polygon(target,[[l1,.008,z],[r1,.008,z],[r2,.008,z2],[l2,.008,z2]],COLORS.road,1.2,1);
      if (z+origin < connection) continue;
      for (const x of [middle-.13,middle+.13]) ground(target,x-.045,x+.045,z,z2,.022,COLORS.amber,2);
      for (const x of [left,right]) {
        const outside = x === left ? x-2.15 : x+2.15;
        ground(target,Math.min(x,outside),Math.max(x,outside),z,z2,.085,rgb('#b2b0a1'),1.3);
        box(target,x,.008,(z+z2)/2,.13,.13,z2-z,rgb('#d5d2be'),2);
        for (let zz = z; zz < z2; zz += 4) ground(target,Math.min(x,outside),Math.max(x,outside),zz,zz+.035,.09,rgb('#999d90'),2);
      }
    }
    const firstWorld = Math.ceil(Math.max(origin+start,connection+25)/64)*64;
    for (let y = firstWorld; y < origin+end; y += 64) {
      const z = y-origin, block = Math.floor(y/64), height = 3.2+((block%3+3)%3)*.8;
      for (const side of [-1,1]) {
        const x = side < 0 ? left-1.35 : right+1.35;
        box(target,x,0,z,.11,5.4,.11,COLORS.steelDark);
        box(target,x-side*.52,5.3,z,1.1,.12,.15,COLORS.steelDark);
        box(target,x-side*.9,5.24,z,.42,.08,.23,rgb('#fff0ba'));
        const buildingX = side < 0 ? left-7.1 : right+7.1;
        if (entranceOccupies(entrances,buildingX,y+18,3.75,7.2)) continue;
        const facade = (block+side)%2 ? rgb('#b6b2a0') : rgb('#a6b2a7');
        box(target,buildingX,0,z+18,7.2,height,14,facade);
        box(target,buildingX,height,z+18,7.5,.22,14.3,rgb('#65756d'));
        for (const dx of [-2,0,2]) {
          box(target,buildingX+dx,1.4,z+10.98,1,.95,.04,rgb('#46696f'));
          box(target,buildingX+dx,1.4,z+25.02,1,.95,.04,rgb('#46696f'));
        }
        const nearSide = buildingX-side*3.62;
        for (const dz of [14,18,22]) box(target,nearSide,1.4,z+dz,.04,.95,1.15,rgb('#46696f'));
      }
      for (const [x,direction] of [[settings.laneCenter,1],[settings.oncomingLaneCenter,-1]]) {
        const point = (side,along) => [x+side,.026,z+along*direction];
        polygon(target,[point(-.09,-2),point(.09,-2),point(.09,1),point(-.09,1)],COLORS.paint,2);
        polygon(target,[point(-.5,.8),point(0,2.3),point(.5,.8)],COLORS.paint,2);
      }
      if (((block%5)+5)%5 === 0) localSpeedSign(target,y+24,origin);
    }
    if (route && route.rampEnd+30 >= origin+start && route.rampEnd+30 <= origin+end) localSpeedSign(target,route.rampEnd+30,origin);
  }
  function buildExits(target, exits, origin) {
    const road = window.RoverRoad;
    if (!road) return;
    for (const exit of exits) {
      for (const y of [exit.start-600,exit.start-300,exit.entryStart-30]) exitSign(target,exit,y,origin);
      const half = exit.width / 2;
      // The final part belongs to the widening connection to the local road.
      const pavementEnd = exit.rampEnd-120;
      for (let y = exit.entryStart; y < pavementEnd; y += 10) {
        const y2 = Math.min(y+10,pavementEnd), x1 = road.centerForExit(exit,y), x2 = road.centerForExit(exit,y2);
        const z1 = y-origin, z2 = y2-origin;
        const strip = (left,right,height,color,layer=1) => polygon(target,
          [[x1+left,height,z1],[x1+right,height,z1],[x2+right,height,z2],[x2+left,height,z2]],color,layer,1);
        strip(-half-.6,half+.6,.004,COLORS.shoulder,1.1);
        strip(-half,half,.005,COLORS.road,1.2);
        // The left boundary only starts outside the highway so a joining ramp
        // never draws a solid diagonal across the main right-hand travel lane.
        if (x1-half > ROAD.emergencyEnd) strip(-half,-half+.12,.018,COLORS.paint,2);
        if (x1+half > ROAD.emergencyEnd) strip(half-.12,half,.018,COLORS.paint,2);
        if (y > exit.entryStart+110 && y < exit.entryStart+200) {
          const left = ROAD.emergencyEnd+.25, right = x1-half-.25;
          if (right > left) ground(target,left,right,z1,z1+.4,.02,COLORS.paint,2);
        }
        if (x1-half > ROAD.guardrailRight+.5) {
          for (const side of [-1,1]) {
            const edge1 = x1+side*(half+.5), edge2 = x2+side*(half+.5);
            polygon(target,[[edge1,.65,z1],[edge2,.65,z2],[edge2,.87,z2],[edge1,.87,z1]],COLORS.steel);
          }
        }
      }
      // A lane-shaped arrow follows the branch; chevrons distinguish its
      // paved entrance from the amber emergency shoulder alongside it.
      for (let y = exit.entryStart+30; y < exit.rampEnd-120; y += 65) {
        const x = road.centerForExit(exit,y), z = y-origin;
        const slope = (road.centerForExit(exit,y+2)-road.centerForExit(exit,y-2))/4;
        const point = (side,along) => [x+side+slope*along,.028,z+along];
        polygon(target,[point(-.1,-2),point(.1,-2),point(.1,1),point(-.1,1)],COLORS.paint,2);
        polygon(target,[point(-.7,.8),point(0,3),point(.7,.8)],COLORS.paint,2);
      }
    }
  }
  function entranceSign(target, entrance, worldY, origin) {
    const x = 11.3, z = worldY-origin, front = z-.11;
    box(target,x,0,z,.14,4.5,.14,COLORS.steel);
    box(target,x,3.05,z,3.85,1.45,.18,COLORS.amber);
    lettering(target,'MERGE',x-.35,3.85,front,.37,COLORS.dark);
    lettering(target,`${Math.max(0,Math.round(entrance.mergeStart-worldY))}M`,x-.35,3.32,front,.33,COLORS.dark);
    // A straight mainline with a branch joining from its right.
    polygon(target,[[x+1,3.25,front],[x+1.13,3.25,front],[x+1.13,4.02,front],[x+1,4.02,front]],COLORS.dark);
    polygon(target,[[x+.86,3.92,front],[x+1.06,4.2,front],[x+1.27,3.92,front]],COLORS.dark);
    polygon(target,[[x+1.04,3.66,front],[x+1.13,3.76,front],[x+1.61,3.38,front],[x+1.53,3.28,front]],COLORS.dark);
  }
  function buildEntrances(target, entrances, origin) {
    const road = window.RoverRoad;
    if (!road) return;
    for (const entrance of entrances) {
      for (const y of [entrance.signStart,entrance.start-150]) entranceSign(target,entrance,y,origin);
      const half = entrance.width/2;
      for (let y = entrance.start; y < entrance.mergeEnd; y += 5) {
        const y2 = Math.min(y+5,entrance.mergeEnd);
        const x1 = road.centerForEntrance(entrance,y), x2 = road.centerForEntrance(entrance,y2);
        const z1 = y-origin, z2 = y2-origin;
        const strip = (left,right,height,color,layer=1) => polygon(target,
          [[x1+left,height,z1],[x1+right,height,z1],[x2+right,height,z2],[x2+left,height,z2]],color,layer,1);
        const left1 = Math.max(ROAD.halfWidth,x1-half-.45), left2 = Math.max(ROAD.halfWidth,x2-half-.45);
        const right1 = Math.max(left1,x1+half+.45), right2 = Math.max(left2,x2+half+.45);
        polygon(target,[[left1,.006,z1],[right1,.006,z1],[right2,.006,z2],[left2,.006,z2]],COLORS.shoulder,1.1,1);
        strip(-half,half,.009,COLORS.road,1.2);
        if (x2-half > ROAD.emergencyEnd) strip(-half,-half+.12,.024,COLORS.paint,2);
        // Keep diagonal edge paint out of the main travel lane as the ramp
        // tapers into it. The highway remains an uninterrupted through lane.
        if (x2+half > ROAD.halfWidth) strip(half-.12,half,.024,COLORS.paint,2);
        if (y2 <= entrance.openingStart) {
          for (const side of [-1,1]) {
            const edge1 = x1+side*(half+.5), edge2 = x2+side*(half+.5);
            polygon(target,[[edge1,.65,z1],[edge2,.65,z2],[edge2,.87,z2],[edge1,.87,z1]],COLORS.steel);
          }
        }
      }
      // Dashed separation opens the acceleration lane; arrows point along
      // the actual curved merge path rather than across a fictitious wall.
      for (let y = entrance.accelerationStart; y < entrance.mergeEnd-30; y += 16)
        ground(target,ROAD.halfWidth-.065,ROAD.halfWidth+.065,y-origin,y+6-origin,.025,COLORS.paint,2);
      for (let y = entrance.start+40; y < entrance.mergeEnd-20; y += 65) {
        const x = road.centerForEntrance(entrance,y), z = y-origin;
        const slope = (road.centerForEntrance(entrance,y+2)-road.centerForEntrance(entrance,y-2))/4;
        const point = (side,along) => [x+side+slope*along,.03,z+along];
        polygon(target,[point(-.1,-2),point(.1,-2),point(.1,1),point(-.1,1)],COLORS.paint,2);
        polygon(target,[point(-.65,.8),point(0,3),point(.65,.8)],COLORS.paint,2);
      }
    }
  }
  function buildHighway(origin = 0, route = null, trafficRoutes = []) {
    const target = mesh();
    const start = -1600, end = 2000;
    const events = window.RoverRoad?.eventsAround(origin+200,2100) || { solids: [], exits: [], entrances: [] };
    events.entrances ||= [];
    if (route) { events.exits = [route]; events.entrances = []; }
    else {
      const existing=new Set(events.exits.map(exit=>exit.id));
      for(const exit of trafficRoutes)if(!existing.has(exit.id)) {events.exits.push(exit);existing.add(exit.id);}
      events.exits.sort((a,b)=>a.entryStart-b.entryStart);
    }
    const solids = events.solids.map(zone => ({ start:zone.start-origin, end:zone.end-origin }));
    const openings = [...events.exits,...events.entrances]
      .map(event => ({ start:event.openingStart-origin, end:event.openingEnd-origin })).sort((a,b)=>a.start-b.start);
    const openingAt = z => openings.some(opening => z >= opening.start && z <= opening.end);
    const entranceSignAt = z => events.entrances.some(entrance =>
      Math.abs(z+origin-entrance.signStart)<8 || Math.abs(z+origin-(entrance.start-150))<8);
    // Short ground strips preserve fog and perspective near the horizon.
    for (let z = start; z < end; z += 50) {
      ground(target,-2000,2000,z,z+50,-.07,COLORS.grass,0);
      ground(target,-9.5,11,z,z+50,-.015,COLORS.verge,0);
      ground(target,-ROAD.shoulderEdge,ROAD.emergencyEnd,z,z+50,0,COLORS.shoulder,1,1);
      ground(target,ROAD.emergencyStart,ROAD.emergencyEnd,z,z+50,.002,rgb('#686b62'),1,1);
      ground(target,-ROAD.halfWidth,ROAD.halfWidth,z,z+50,.003,COLORS.road,1,1);
      ground(target,-ROAD.halfWidth-.085,-ROAD.halfWidth+.085,z,z+50,.012,COLORS.paint,2);
      for (const [a,b] of clearSections(z,z+50,openings)) {
        ground(target,ROAD.halfWidth-.085,ROAD.halfWidth+.085,a,b,.012,COLORS.paint,2);
        ground(target,ROAD.emergencyEnd-.1,ROAD.emergencyEnd,a,b,.013,COLORS.amber,2);
      }
      // A parallel opposing carriageway, beyond the planted central reservation.
      ground(target,-29.1,-14.9,z,z+50,0,COLORS.shoulder,1,1);
      ground(target,-27.625,-16.375,z,z+50,.003,COLORS.road,1,1);
      for (const x of [-27.625,-16.375]) ground(target,x-.08,x+.08,z,z+50,.012,COLORS.paint,2);
      for (const x of [ROAD.guardrailLeft,ROAD.guardrailRight,-14.6,-29.4]) {
        for (const [a,b] of x === ROAD.guardrailRight ? clearSections(z,z+50,openings) : [[z,z+50]]) {
          box(target,x,0,(a+b)/2,.34,.37,b-a,COLORS.steelDark);
          box(target,x,.62,(a+b)/2,.13,.23,b-a,COLORS.steel);
          box(target,x,.6,(a+b)/2,.14,.045,b-a,COLORS.steelDark);
        }
      }
    }
    for (let z = start; z < end; z += 16) {
      for (const x of [-20.125,-23.875]) ground(target,x-.075,x+.075,z,z+6,.014,COLORS.paint,2);
      for (const [a,b] of clearSections(z,z+6,solids)) {
        for (const x of [-1.875,1.875]) ground(target,x-.075,x+.075,a,b,.014,COLORS.paint,2);
      }
    }
    for (const zone of solids) for (let z = Math.max(start,zone.start); z < Math.min(end,zone.end); z += 40) {
      for (const x of [-1.875,1.875]) ground(target,x-.075,x+.075,z,Math.min(z+40,zone.end,end),.014,COLORS.paint,2);
    }
    for (let z = start; z < end; z += 12.5) {
      for (const x of [ROAD.guardrailLeft,ROAD.guardrailRight]) if (x !== ROAD.guardrailRight || !openingAt(z)) box(target,x,0,z,.12,.77,.13,COLORS.steelDark);
    }
    for (let z = start; z < end; z += 50) {
      for (const x of [-8.2,9.7]) {
        if (x > 0 && openingAt(z)) continue;
        box(target,x,0,z,.16,1.05,.16,COLORS.white);
        box(target,x,.65,z-.09,.18,.27,.02,COLORS.dark);
        box(target,x,.72,z-.105,.09,.11,.022,x < 0 ? COLORS.amber : COLORS.red);
      }
      // Rumble-strip insets along the hard shoulder provide near-field motion.
      for (const x of [-6,6]) for (let dz = 0; dz < 50; dz += 5) if (x < 0 || !openingAt(z+dz)) ground(target,x-.17,x+.17,z+dz,z+dz+.16,.008,COLORS.steelDark,2);
      // The 3 m paved emergency lane is outside the solid white edge line.
      // Cross-hatching by the outer rail and SOS boards distinguish it from
      // a fourth travel lane without filling the usable stopping surface.
      for (let dz = 0; dz < 50; dz += 8) if (!openingAt(z+dz)) polygon(target,
        [[8.1,.015,z+dz],[8.5,.015,z+dz+1],[8.5,.015,z+dz+1.5],[8.1,.015,z+dz+.5]],COLORS.amber,2);
    }
    for (let z = start; z < end; z += ROAD.repeat) {
      if (!openingAt(z+200) && !entranceSignAt(z+200)) gantry(target,z+200);
      if (!openingAt(z+110)) {
        box(target,10,0,z+110,.12,2.6,.12,COLORS.steel);
        box(target,10,2.1,z+110,1.55,1.02,.13,COLORS.amber);
        lettering(target,'SOS',10,2.38,z+109.92,.44,COLORS.dark);
      }
      hill(target,480,z+150,670,470,120,COLORS.hillsFar);
      hill(target,-520,z+290,660,500,155,COLORS.hillsFar);
      hill(target,310,z+65,340,290,72,COLORS.hills);
      hill(target,-355,z+310,320,310,91,COLORS.hills);
      // Low roadside planting, kept well outside the driving surface.
      for (const [x,dz,h] of [[24,45,5],[-41,135,6],[34,280,4.4],[-43,340,5.5]]) {
        if (x > 0 && (events.exits.some(exit => z+dz+origin >= exit.entryStart && z+dz+origin <= exit.rampEnd && Math.abs(x-window.RoverRoad.centerForExit(exit,z+dz+origin)) < 6) ||
          entranceOccupies(events.entrances,x,z+dz+origin,2.5,2.5))) continue;
        box(target,x,0,z+dz,.22,h*.58,.22,COLORS.dark);
        hill(target,x,z+dz,4.5,4.5,h,COLORS.hills);
      }
    }
    buildExits(target,events.exits,origin);
    buildEntrances(target,events.entrances,origin);
    // Unselected exits still have a visible continuation. Once a route is
    // selected, only that connection is drawn so later exits cannot overlap it.
    const activeTrafficRoutes=new Set(trafficRoutes.map(exit=>exit.id));
    for (const exit of events.exits) buildLocalRoad(target,origin,exit,start,
      route||activeTrafficRoutes.has(exit.id)?end:Math.min(end,exit.rampEnd+700-origin),events.entrances);
    target.data = new Float32Array(target.vertices);
    target.vertices = null;
    return target;
  }
  function buildLocalWorld(origin, route) {
    const target = mesh(), start = -1600, end = 2000;
    for (let z = start; z < end; z += 50) ground(target,-2000,2000,z,z+50,-.07,COLORS.grass,0);
    // Entering local-road mode is a lasting scene transition. Its road runs
    // in both directions, even if reverse travel passes the old ramp station.
    buildLocalRoad(target,origin,null,start,end);
    target.data = new Float32Array(target.vertices);
    target.vertices = null;
    return target;
  }

  const vehicleTemplates = new Map();
  function buildVehicleTemplate(vehicle, level) {
    const key = `${vehicle.kind}-${vehicle.color}-${level}`;
    if (vehicleTemplates.has(key)) return vehicleTemplates.get(key);
    const target = mesh(), truck = vehicle.kind === 'truck';
    const detail = level === 2;
    const body = rgb(vehicle.color), glass = rgb('#264454'), tyres = rgb('#20292c');
    const metal = rgb('#a0adb0'), lamps = rgb('#fff0ba'), tail = rgb('#e74637');
    // Distant traffic is only a few pixels tall. Keep its silhouette and cab,
    // but omit wheels, mirrors and tiny lamps in dense traffic scenes.
    if (level === 0) {
      box(target,0,.35,0,vehicle.width,truck ? 2.65 : .6,vehicle.length,body);
      if (!truck) box(target,0,.95,-.12,1.45,.52,1.85,glass);
      else box(target,0,1.65,vehicle.length/2+.01,1.95,.65,.02,glass);
      vehicleTemplates.set(key,target);
      return target;
    }
    // Local +Z is the nose. The complete template is turned 180 degrees for
    // opposing traffic, including windscreens, cab, lamps and wheel positions.
    ground(target,-vehicle.width*.57,vehicle.width*.57,-vehicle.length*.52,vehicle.length*.52,.023,rgb('#384245'),2);
    if (truck) {
      box(target,0,.46,0,2.12,.4,8.2,tyres);
      box(target,0,.87,-1.05,2.35,2.34,6.2,body);
      box(target,0,.75,3,2.23,1.84,2.24,body);
      box(target,0,1.63,4.125,1.96,.65,.022,glass);
      box(target,0,.9,4.15,1.15,.3,.025,tyres);
      for (const side of [-1,1]) {
        box(target,side*1.12,1.66,3.24,.022,.59,1.22,glass);
        box(target,side*.88,.9,4.16,.39,.2,.025,lamps);
        box(target,side*.91,.9,-4.16,.29,.23,.025,tail);
      }
      if (detail) {
        for (const x of [-.91,0,.91]) box(target,x,.92,-4.165,.038,2.17,.02,metal);
        box(target,0,.81,-4.18,2.31,.075,.03,metal);
        box(target,0,.59,4.18,2.19,.18,.06,metal);
        for (const side of [-1,1]) box(target,side*1.26,1.92,3.81,.18,.32,.13,tyres);
      }
    } else {
      box(target,0,.39,0,1.85,.49,4.5,body);
      box(target,0,.84,1.64,1.8,.11,1.16,body);
      // A tapered roof and sloping windows give cars a readable silhouette.
      polygon(target,[[-.88,.86,-1.27],[.88,.86,-1.27],[.7,1.46,-.75],[-.7,1.46,-.75]],glass);
      polygon(target,[[.88,.86,1.11],[-.88,.86,1.11],[-.7,1.46,.51],[.7,1.46,.51]],glass);
      polygon(target,[[-.7,1.46,-.75],[.7,1.46,-.75],[.7,1.46,.51],[-.7,1.46,.51]],body,3,0,1.08);
      for (const side of [-1,1]) {
        polygon(target,[[side*.88,.9,-1.16],[side*.88,.9,1.02],[side*.71,1.43,.48],[side*.71,1.43,-.71]],glass,3,0,side < 0 ? .8 : 1);
        box(target,side*.65,.63,2.261,.42,.16,.025,lamps);
        box(target,side*.65,.63,-2.261,.43,.17,.025,tail);
        if (detail) {
          polygon(target,[[side*.889,.88,-.14],[side*.889,.88,-.02],[side*.712,1.445,-.02],[side*.712,1.445,-.14]],body);
          box(target,side*.98,.98,.68,.16,.12,.26,body);
        }
      }
      if (detail) {
        box(target,0,.46,2.27,1.72,.09,.04,metal);
        box(target,0,.46,-2.27,1.72,.09,.04,metal);
        box(target,0,.62,-2.282,.4,.14,.02,COLORS.white);
        box(target,0,.61,2.281,.64,.18,.02,tyres);
      }
    }
    const axles = truck ? [-2.95,-1.75,2.83] : [-1.4,1.38];
    const wheelRadius = truck ? .44 : .32;
    for (const z of axles) for (const side of [-1,1]) {
      const x = side*(vehicle.width/2-.065);
      box(target,x,.08,z,.21,wheelRadius*2,.67+(truck ? .18 : 0),tyres);
      if (detail) box(target,x+side*.111,.22,z,.014,wheelRadius*.9,wheelRadius*.9,metal);
    }
    vehicleTemplates.set(key,target);
    return target;
  }
  function disc(target,x,y,z,radius,color) {
    const points = [];
    for (let i=0;i<24;i++) { const angle = i*Math.PI/12; points.push([x+Math.cos(angle)*radius,y+Math.sin(angle)*radius,z]); }
    polygon(target,points,color);
  }
  function speedSign(target,sign,origin) {
    const roadState = window.RoverRoad?.getState(sign.y), exit = roadState?.activeExit;
    const center = exit ? window.RoverRoad.centerForExit(exit,sign.y) : 0;
    let x = exit && Math.abs(center-10) < 4 ? center+exit.width/2+1.5 : 10;
    const entrance = roadState?.activeEntrance;
    if (entrance && entranceOccupies([entrance],x,sign.y,1,.1))
      x = window.RoverRoad.centerForEntrance(entrance,sign.y)+entrance.width/2+1.5;
    const z = sign.y-origin;
    box(target,x,0,z,.12,3.6,.12,COLORS.steel);
    disc(target,x,3.55,z+.012,.88,COLORS.steelDark);
    disc(target,x,3.55,z-.02,.88,rgb('#d4493f'));
    disc(target,x,3.55,z-.028,.71,COLORS.white);
    lettering(target,String(sign.limitKmh),x,3.28,z-.035,.55,rgb('#26363b'));
  }
  function placeVehicleMesh(target,source,x,z,sin,cos,includeFaces) {
    if (includeFaces) {
      for (const face of source.faces) {
        const points = face.points.map(p => [x+p[0]*cos+p[2]*sin,p[1],z-p[0]*sin+p[2]*cos]);
        // Rigid rotation preserves each face's color and bounding radius.
        target.faces.push({ ...face, points, x:x+face.x*cos+face.z*sin, z:z-face.x*sin+face.z*cos });
      }
    } else {
      // WebGL only needs packed triangle vertices, including their yaw.
      const vertices = source.vertices;
      for (let i = 0; i < vertices.length; i += 7) {
        target.vertices.push(x+vertices[i]*cos+vertices[i+2]*sin,vertices[i+1],z-vertices[i]*sin+vertices[i+2]*cos,
          vertices[i+3],vertices[i+4],vertices[i+5],vertices[i+6]);
      }
    }
  }
  function buildTraffic(pose,origin,stats,includeFaces) {
    const heading = viewHeading(pose)*Math.PI/180;
    const target = mesh(), sin = Math.sin(heading), cos = Math.cos(heading);
    stats.visibleTraffic = 0;
    for (const vehicle of pose.traffic || []) {
      if (![vehicle.x,vehicle.y].every(Number.isFinite)) continue;
      if (pose.localRoad) {
        const local = localGeometry();
        if (vehicle.x < local.oncomingLaneCenter-local.halfLaneWidth || vehicle.x > local.laneCenter+local.halfLaneWidth) continue;
      }
      const dx = vehicle.x-pose.x, dz = vehicle.y-pose.y;
      const depth = dx*sin+dz*cos, side = dx*cos-dz*sin;
      const margin = vehicle.length || 8;
      if (depth+margin < NEAR || depth-margin > ROAD.far || Math.abs(side) > Math.max(12,depth*1.4)+margin) continue;
      stats.visibleTraffic++;
      const template = buildVehicleTemplate(vehicle,depth < 260 ? 2 : depth < 500 ? 1 : 0);
      const yaw = (Number.isFinite(vehicle.heading) ? vehicle.heading : vehicle.direction < 0 ? 180 : 0)*Math.PI/180;
      const vehicleSin = Math.sin(yaw), vehicleCos = Math.cos(yaw), z = vehicle.y-origin;
      placeVehicleMesh(target,template,vehicle.x,z,vehicleSin,vehicleCos,includeFaces);
      if (vehicle.braking && depth < 130) {
        const lamps = mesh();
        for (const side of [-1,1]) box(lamps,side*vehicle.width*.34,.62,-(vehicle.length/2+.022),.4,.21,.024,rgb('#ff7155'));
        placeVehicleMesh(target,lamps,vehicle.x,z,vehicleSin,vehicleCos,includeFaces);
      }
    }
    const signs = pose.localRoad ? [] : pose.roadSigns || window.RoverTraffic?.signsAround(pose.y) || [];
    for (const sign of signs) speedSign(target,sign,origin);
    return target;
  }

  const boundedNumber = (value, fallback, min, max) =>
    Math.max(min,Math.min(max,Number.isFinite(Number(value)) ? Number(value) : fallback));
  const collisionBodies=new WeakMap();
  function dentCollisionPoint([x,y,z],effect,damage) {
    const end=effect.impactEnd==='rear'?-1:1;
    if(z*end>.9) {
      const dent=Math.min(1,(z*end-.9)/1.4)*damage;
      z-=end*.55*dent;y-=dent*(y>.8?.24:.1);x*=1-.12*dent;
    }
    return [x,y,z];
  }
  function collisionBody(effect,damage) {
    const cached=collisionBodies.get(effect);
    if(cached?.damage===damage&&cached.impactEnd===effect.impactEnd)return cached.faces;
    const template=buildVehicleTemplate({kind:'car',color:'#d9ee78',width:1.85,length:4.5},2);
    // The underside is visible during a tumble: a dark floor pan, axles and
    // exhaust make the rotating body readable from below as well as above.
    const underside=mesh(),chassis=rgb('#333d40'),metal=rgb('#7d898a');
    box(underside,0,.28,0,1.48,.11,3.85,chassis);
    for(const z of [-1.4,1.38])box(underside,0,.25,z,1.7,.09,.14,metal);
    box(underside,.52,.25,-.15,.09,.08,3.15,metal);
    const faces=[...template.faces.filter(face=>face.layer!==2),...underside.faces].map(face=>{
      const wheel=Math.abs(face.x)>.72&&Math.abs(face.z)>1&&Math.abs(face.z)<1.8&&face.points.every(p=>p[1]<=.73);
      return {...face,points:face.points.map(p=>wheel?p:dentCollisionPoint(p,effect,damage))};
    });
    collisionBodies.set(effect,{damage,impactEnd:effect.impactEnd,faces});return faces;
  }
  // Shared rigid-body transform: wheels, body, scars and the engine smoke
  // source rotate together about the same centre of mass, even upside down.
  function collisionRotation(sample) {
    const pitch=sample.pitch*Math.PI/180,roll=sample.roll*Math.PI/180;
    const sp=Math.sin(pitch),cp=Math.cos(pitch),sr=Math.sin(roll),cr=Math.cos(roll);
    return ([x,y,z])=>{
      const cy=y-.7,py=cy*cp+z*sp,pz=z*cp-cy*sp;
      return [x*cr-py*sr,x*sr+py*cr+.7,pz];
    };
  }
  function tumbleCollisionSample(effect,sample,elapsed,flightTime,slideTime) {
    const axis=effect.tumbleAxis,rate=boundedNumber(effect.tumbleRateDeg,0,-280,280);
    const t=Math.min(elapsed,flightTime);
    let angle=rate*t*(1-.06*t/flightTime),angularSpeed=rate*(1-.12*t/flightTime);
    if(elapsed>=flightTime) {
      const landing=rate*flightTime*.94,step=axis==='roll'?90:180;
      const rest=Math.round(landing/step)*step;
      const settleTime=Math.max(.001,Math.min(.8,slideTime));
      const u=Math.min(1,(elapsed-flightTime)/settleTime),delta=rest-landing;
      // Ground contact absorbs most angular momentum. The remaining rotation
      // settles onto a side, roof or wheels without snapping back to upright.
      const initial=Math.sign(delta)===Math.sign(rate)?Math.min(Math.abs(rate)*.22,Math.abs(delta)*2/settleTime)*Math.sign(rate):0;
      angle=landing+(3*u*u-2*u*u*u)*delta+(u*u*u-2*u*u+u)*settleTime*initial;
      angularSpeed=u===1?0:(6*u-6*u*u)*delta/settleTime+(3*u*u-4*u+1)*initial;
    }
    const rotation={...sample,[axis]:angle||0,tumbleAngle:angle||0,angularSpeed};
    const rotate=collisionRotation(rotation);
    let lowest=Infinity;
    for(const face of collisionBody(effect,sample.damage))for(const point of face.points)
      lowest=Math.min(lowest,rotate(point)[1]);
    return {...rotation,bodyLift:Math.max(sample.height,.035-lowest)};
  }
  function sampleCollisionEffect(effect) {
    const resting = {height:0,bodyLift:0,pitch:0,roll:0,tumbleAngle:0,angularSpeed:0,travelDistance:0,travelSpeed:0,phase:'settled',damage:effect?.reducedMotion?1:0,smoke:effect?.reducedMotion?1:0,smokeTime:1.2};
    if (!effect || effect.reducedMotion) return resting;
    const peak = boundedNumber(effect.peakHeight,2.6,0,4);
    const requestedFlight = boundedNumber(effect.flightTime,2*Math.sqrt(2*peak/9.81),.1,3);
    const requestedSlide = boundedNumber(effect.slideTime,.8,0,3);
    const smokeDwell = boundedNumber(effect.smokeDwell,1.2,0,5);
    const duration = boundedNumber(effect.duration,requestedFlight+requestedSlide+smokeDwell,.1,10);
    const elapsed = boundedNumber(effect.elapsed,0,0,duration);
    const flightTime = Math.min(requestedFlight,duration),slideTime=Math.min(requestedSlide,Math.max(0,duration-flightTime));
    const launchSpeed=boundedNumber(effect.launchSpeed,0,0,60),flightElapsed=Math.min(elapsed,flightTime);
    const landingSpeed=launchSpeed*.65,flightDistance=launchSpeed*flightTime*.825;
    let travelDistance=launchSpeed*flightElapsed-.5*(launchSpeed*.35/flightTime)*flightElapsed*flightElapsed;
    let travelSpeed=launchSpeed*(1-.35*flightElapsed/flightTime);
    if(elapsed>=flightTime) {
      const t=Math.min(Math.max(0,elapsed-flightTime),slideTime);
      travelDistance=flightDistance+(slideTime>0?landingSpeed*(t-.5*t*t/slideTime):0);
      travelSpeed=slideTime>0?landingSpeed*(1-t/slideTime):0;
    }
    const sample={...resting,travelDistance,travelSpeed:Math.max(0,travelSpeed),damage:Math.min(1,.55+peak*.11),
      smoke:Math.min(1,.22+elapsed*.95),smokeTime:elapsed};
    // Very small impacts also get proportionally smaller angles, keeping all
    // wheels above the pavement instead of rotating the body through it.
    const tiltScale = Math.min(1,peak/.6);
    const pitch = boundedNumber(effect.pitchDeg,8,-12,12)*tiltScale;
    const roll = boundedNumber(effect.rollDeg,5,-9,9)*tiltScale;
    let result={...sample,phase:elapsed<flightTime+slideTime?'sliding':'smoking'};
    if (elapsed < flightTime) {
      const t = elapsed/flightTime, tilt = Math.sin(Math.PI*t);
      result={...sample,height:4*peak*t*(1-t),pitch:pitch*tilt||0,roll:roll*tilt||0,phase:'airborne'};
    }
    if(elapsed>=duration)result={...sample,travelSpeed:0,phase:'settled'};
    if(['pitch','roll'].includes(effect.tumbleAxis))return tumbleCollisionSample(effect,result,elapsed,flightTime,slideTime);
    return {...result,bodyLift:result.height};
  }
  const collisionMotionRules=new WeakMap();
  function motionRules(pose) {
    const effect=pose.collisionEffect;
    if(!effect)return {scale:1};
    if(collisionMotionRules.has(effect))return collisionMotionRules.get(effect);
    const rules={scale:1},contact=(pose.traffic||[]).find(vehicle=>vehicle.id===effect.contactVehicleId);
    if(contact&&!effect.reducedMotion) {
      const heading=boundedNumber(effect.travelHeading,viewHeading(pose),-1e8,1e8)*Math.PI/180,sin=Math.sin(heading),cos=Math.cos(heading);
      const extent=vehicle=>{
        const angle=(Number.isFinite(vehicle.heading)?vehicle.heading:vehicle.direction<0?180:0)*Math.PI/180-heading;
        const length=(vehicle.length||(vehicle.kind==='truck'?8.3:4.5))/2,width=(vehicle.width||(vehicle.kind==='truck'?2.35:1.85))/2;
        return {along:Math.abs(Math.cos(angle))*length+Math.abs(Math.sin(angle))*width,
          side:Math.abs(Math.cos(angle))*width+Math.abs(Math.sin(angle))*length};
      };
      const contactExtent=extent(contact),dx=contact.x-pose.x,dz=contact.y-pose.y;
      const tumbling=['pitch','roll'].includes(effect.tumbleAxis);
      // A rotating bumper can sweep beyond the upright 2.25 m half-length.
      // Reserve its enclosing radius, including trim, from first contact.
      const egoReach=tumbling?2.55:2.25;
      const ahead=dx*sin+dz*cos,initialGap=Math.max(0,ahead-contactExtent.along-egoReach);
      const finalDistance=sampleCollisionEffect({...effect,elapsed:1e9}).travelDistance;
      const landingDistance=sampleCollisionEffect({...effect,elapsed:boundedNumber(effect.flightTime,1.45,.1,3)}).travelDistance;
      if(ahead>0&&Math.abs(dx*cos-dz*sin)<contactExtent.side+1&&finalDistance>initialGap&&
          (tumbling||landingDistance<ahead+contactExtent.along+2.25)) {
        let room=Infinity;
        for(const other of pose.traffic||[]) {
          if(other===contact)continue;
          const dx=other.x-contact.x,dz=other.y-contact.y,forward=dx*sin+dz*cos,otherExtent=extent(other);
          if(forward<=0||Math.abs(dx*cos-dz*sin)>=contactExtent.side+otherExtent.side+.08)continue;
          room=Math.min(room,Math.max(0,forward-contactExtent.along-otherExtent.along-.12));
        }
        rules.contactId=contact.id;rules.initialGap=initialGap;
        rules.contactImpulse=tumbling?Math.min(room,Math.max(0,egoReach+contactExtent.along-ahead)):0;
        rules.scale=Math.min(1,(initialGap+Math.max(0,room-rules.contactImpulse))/finalDistance);
      }
    }
    collisionMotionRules.set(effect,rules);return rules;
  }
  function collisionSample(pose) {
    const sample=sampleCollisionEffect(pose.collisionEffect),rules=motionRules(pose);
    return {...sample,travelDistance:sample.travelDistance*rules.scale,travelSpeed:sample.travelSpeed*rules.scale};
  }
  function collisionTravel(pose,sample=collisionSample(pose)) {
    const heading=boundedNumber(pose.collisionEffect?.travelHeading,viewHeading(pose),-1e8,1e8)*Math.PI/180;
    return {x:Math.sin(heading)*sample.travelDistance,y:Math.cos(heading)*sample.travelDistance};
  }
  function collisionTraffic(pose,sample=collisionSample(pose)) {
    const rules=motionRules(pose);
    if(rules.contactId===undefined)return pose.traffic||[];
    const shift=(rules.contactImpulse||0)+Math.max(0,sample.travelDistance-rules.initialGap),offset=collisionTravel(pose,{travelDistance:shift});
    return (pose.traffic||[]).map(vehicle=>vehicle.id===rules.contactId?{...vehicle,x:vehicle.x+offset.x,y:vehicle.y+offset.y}:vehicle);
  }
  const collisionViews = new WeakMap();
  function vehicleBlocksView(vehicle,from,to) {
    const angle = (Number.isFinite(vehicle.heading) ? vehicle.heading : vehicle.direction<0 ? 180 : 0)*Math.PI/180;
    const sin = Math.sin(angle), cos = Math.cos(angle);
    const local = point=>{const dx=point[0]-vehicle.x,dz=point[2]-vehicle.y;return [dx*cos-dz*sin,point[1],dx*sin+dz*cos];};
    const start=local(from),end=local(to),truck=vehicle.kind==='truck';
    const width=(Number(vehicle.width)||(truck?2.35:1.85))/2+.08;
    const length=(Number(vehicle.length)||(truck?8.3:4.5))/2+.08;
    const low=[-width,0,-length],high=[width,truck?3.32:1.55,length];
    let near=0,far=1;
    for(let axis=0;axis<3;axis++) {
      const delta=end[axis]-start[axis];
      if(Math.abs(delta)<1e-8) {if(start[axis]<low[axis]||start[axis]>high[axis])return false;continue;}
      const a=(low[axis]-start[axis])/delta,b=(high[axis]-start[axis])/delta;
      near=Math.max(near,Math.min(a,b));far=Math.min(far,Math.max(a,b));
      if(near>far)return false;
    }
    return far>=0&&near<=1;
  }
  function collisionCamera(pose,aspect=1.3) {
    if (!pose.collisionEffect) return {...pose,cameraHeight:ROAD.cameraHeight,cameraPitch:0,collisionViewClear:true};
    const motion=collisionTravel(pose),follow=view=>({...pose,...view,x:view.x+motion.x,y:view.y+motion.y,gear:'forward',traffic:collisionTraffic(pose)});
    const framingAspect=Math.min(aspect,1),cached=collisionViews.get(pose.collisionEffect);
    if(cached&&cached.framingAspect<=framingAspect+.001)return follow(cached);
    const angle=viewHeading(pose)*Math.PI/180,sin=Math.sin(angle),cos=Math.cos(angle);
    const peak=pose.collisionEffect.reducedMotion?0:boundedNumber(pose.collisionEffect.peakHeight,2.6,0,4);
    const extraHeight=Math.max(0,peak-1),distanceScale=1+extraHeight*.09;
    const targetHeight=2.5+peak*.5;
    const roadCenter=pose.localRoad?localGeometry().laneCenter:0;
    const preference=(pose.x-roadCenter)*cos>0?-1:1;
    const candidates=[
      [preference*3.2,8.6,3.7],[-preference*3.2,8.6,3.7],
      [preference*6,5.5,4.2],[-preference*6,5.5,4.2],
      [preference*6.5,1,4.8],[-preference*6.5,1,4.8],
      [preference*4.5,-7,4.2],[-preference*4.5,-7,4.2],
      [preference*6.5,1,6.6],[-preference*6.5,1,6.6],
      [preference*6.5,1,9.2],[-preference*6.5,1,9.2],
      [preference*6.5,1,11.8],[-preference*6.5,1,11.8],
    ];
    const yaw=pose.heading*Math.PI/180,bodySin=Math.sin(yaw),bodyCos=Math.cos(yaw);
    const framePoints=[];
    for(const x of [-1.35,1.35])for(const z of [-2.9,2.9])for(const height of [0,peak+1.9])
      framePoints.push([pose.x+x*bodyCos+z*bodySin,height,pose.y-x*bodySin+z*bodyCos]);
    for(const x of [-1.4,1.4])for(const z of [-.5,3])for(const height of [.8,peak+5.25])
      framePoints.push([pose.x+x*bodyCos+z*bodySin,height,pose.y-x*bodySin+z*bodyCos]);
    const effect=pose.collisionEffect,flight=boundedNumber(effect.flightTime,1.45,.1,3),slide=boundedNumber(effect.slideTime,.8,0,3);
    const tumbling=['pitch','roll'].includes(effect.tumbleAxis)&&!effect.reducedMotion;
    const sampleTimes=tumbling?[...Array.from({length:17},(_,i)=>flight*i/16),...Array.from({length:8},(_,i)=>flight+slide*(i+1)/8)]:
      [0,flight*.5,flight,flight+slide*.5,flight+slide];
    const rotationSamples=sampleTimes.map(elapsed=>sampleCollisionEffect({...effect,elapsed}));
    if(tumbling)for(const sample of rotationSamples) {
      const rotate=collisionRotation(sample),low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity];
      for(const face of collisionBody(effect,sample.damage))for(const point of face.points) {
        const p=rotate(point);p[1]+=sample.bodyLift;
        for(let i=0;i<3;i++){low[i]=Math.min(low[i],p[i]);high[i]=Math.max(high[i],p[i]);}
      }
      for(const x of [low[0]-.12,high[0]+.12])for(const z of [low[2]-.12,high[2]+.12])for(const height of [low[1]-.08,high[1]+.12])
        framePoints.push([pose.x+x*bodyCos+z*bodySin,height,pose.y-x*bodySin+z*bodyCos]);
      const source=rotate(dentCollisionPoint([0,.95,1.25],effect,sample.damage));
      for(const x of [source[0]-1.5,source[0]+1.5])for(const z of [source[2]-1.5,source[2]+1.5])
        framePoints.push([pose.x+x*bodyCos+z*bodySin,source[1]+sample.bodyLift+4.2,pose.y-x*bodySin+z*bodyCos]);
    }
    function fitsFrame(view) {
      const yaw=view.heading*Math.PI/180,sinYaw=Math.sin(yaw),cosYaw=Math.cos(yaw);
      const sinPitch=Math.sin(view.cameraPitch),cosPitch=Math.cos(view.cameraPitch);
      return framePoints.every(([x,height,z])=>{
        const dx=x-view.x,dz=z-view.y,dy=height-view.cameraHeight,flat=dx*sinYaw+dz*cosYaw;
        const depth=flat*cosPitch-dy*sinPitch;
        const horizontal=(dx*cosYaw-dz*sinYaw)*FOCAL/(framingAspect*depth);
        const vertical=(dy*cosPitch+flat*sinPitch)*FOCAL/depth+.1;
        return depth>NEAR&&Math.abs(horizontal)<.9&&Math.abs(vertical)<.9;
      });
    }
    const localTargets=[[0,1.1,0],[0,1.48,0],[-.65,1.05,-1.2],[.65,1.05,-1.2],[-.65,1.05,1.2],[.65,1.05,1.2]];
    const travelSamples=rotationSamples
      .map(sample=>{sample.travelDistance*=motionRules(pose).scale;
        const offset=collisionTravel(pose,sample);
        const rotate=collisionRotation(sample),targets=localTargets.map(point=>{
          const [x,height,z]=tumbling?rotate(point):point;
          return [pose.x+x*bodyCos+z*bodySin,height+sample.bodyLift,pose.y-x*bodySin+z*bodyCos];
        });
        return {...offset,targets,traffic:collisionTraffic(pose,sample).filter(vehicle=>
          Number.isFinite(vehicle.x)&&Number.isFinite(vehicle.y)&&Math.hypot(vehicle.x-pose.x-offset.x,vehicle.y-pose.y-offset.y)<30)};});
    let selected=null,bestScore=-1;
    for(let index=0;index<candidates.length;index++) {
      const [baseSide,baseDistance,baseHeight]=candidates[index];
      let view;
      for(const framingScale of [1,1.16,1.35,1.6,2,2.5,3]) {
        const side=baseSide*distanceScale*framingScale,distance=baseDistance*distanceScale*framingScale;
        const cameraHeight=targetHeight+(baseHeight+extraHeight*.6-targetHeight)*framingScale;
        const x=pose.x+side*cos-distance*sin,y=pose.y-side*sin-distance*cos;
        view={x,y,heading:Math.atan2(pose.x-x,pose.y-y)*180/Math.PI,cameraHeight,
          cameraPitch:Math.atan2(cameraHeight-targetHeight,Math.hypot(side,distance)),collisionViewCandidate:index};
        if(fitsFrame(view))break;
      }
      const {x,y,cameraHeight}=view,from=[x,cameraHeight,y];
      if(travelSamples.some(offset=>offset.traffic.some(vehicle=>vehicleBlocksView(vehicle,[x+offset.x,cameraHeight,y+offset.y],[x+offset.x,cameraHeight,y+offset.y]))))continue;
      const visible=localTargets.map((_,i)=>travelSamples.every(offset=>!offset.traffic.some(vehicle=>vehicleBlocksView(vehicle,
        [from[0]+offset.x,from[1],from[2]+offset.y],[offset.targets[i][0]+offset.x,offset.targets[i][1],offset.targets[i][2]+offset.y]))));
      const score=visible.reduce((sum,clear,i)=>sum+(clear?(i<2?2:1):0),0);
      if(score<=bestScore)continue;
      bestScore=score;
      selected={...view,framingAspect,collisionViewClear:visible.every(Boolean)};
      if(selected.collisionViewClear)break;
    }
    // High candidates sit above even a tightly packed set of trucks. Their
    // scoring retains normal depth occlusion; no vehicles are hidden or erased.
    collisionViews.set(pose.collisionEffect,selected);
    return follow(selected);
  }
  function buildCollisionVehicle(pose,origin,stats) {
    const target = mesh(), effect = pose.collisionEffect;
    const sample = collisionSample(pose);
    stats.selfVisible = Boolean(effect);
    stats.collisionHeight = effect ? sample.height : 0;
    stats.collisionPitch = effect ? sample.pitch : 0;
    stats.collisionRoll = effect ? sample.roll : 0;
    stats.collisionTumbleAngle = sample.tumbleAngle;
    stats.collisionAngularSpeed = sample.angularSpeed;
    stats.collisionBodyLift = sample.bodyLift;
    stats.collisionPhase = effect ? sample.phase : 'none';
    stats.collisionTravelDistance = sample.travelDistance;
    stats.collisionTravelSpeed = sample.travelSpeed;
    stats.collisionDamage = sample.damage;
    stats.collisionSmoke = sample.smoke;
    stats.collisionVisualX = pose.x;
    stats.collisionVisualY = pose.y;
    stats.collisionTravelLimited = motionRules(pose).scale<1;
    stats.collisionContactShift = (motionRules(pose).contactImpulse||0)+Math.max(0,sample.travelDistance-(motionRules(pose).initialGap??sample.travelDistance));
    if (!effect) return target;
    const yaw = pose.heading*Math.PI/180, sinYaw = Math.sin(yaw), cosYaw = Math.cos(yaw);
    const rotate=collisionRotation(sample);
    const anchorZ = pose.y-origin;
    // The shadow stays on the asphalt while the body moves independently.
    const liftFraction=Math.min(1,sample.height/4),spread = 1+liftFraction*.12, shadow = [];
    for (let i=0;i<24;i++) {
      const angle = i*Math.PI/12, x = Math.cos(angle)*1.13*spread, z = Math.sin(angle)*2.55*spread;
      shadow.push([pose.x+x*cosYaw+z*sinYaw,.032,anchorZ-x*sinYaw+z*cosYaw]);
    }
    const shadowBase = rgb('#343d40'), shadowLifted = rgb('#454d4f');
    polygon(target,shadow,shadowBase.map((value,index)=>value+(shadowLifted[index]-value)*liftFraction),2);
    const body = collisionBody(effect,sample.damage);
    const impactEnd=effect.impactEnd==='rear'?-1:1;
    function transformPoint(point) {
      const [x,y,z]=rotate(point);
      return [pose.x+x*cosYaw+z*sinYaw,y+sample.bodyLift,anchorZ-x*sinYaw+z*cosYaw];
    }
    for (const face of body) {
      const points=face.points.map(point=>transformPoint(point));
      const damaged=face.z*impactEnd>1;
      const color=damaged?face.color.map(channel=>channel*(1-sample.damage*.48)):face.color;
      polygon(target,points,color,face.layer,face.material);
    }
    // Permanent crease marks sit on the crumpled panel, including a rear
    // impact when reversing. Smoke still originates at the engine in front.
    for(const [x,z] of [[-.45,1.42],[.13,1.77]]) {
      const points=[[x,.86,z*impactEnd],[x+.42,.86,(z-.2)*impactEnd],[x+.47,.86,(z-.16)*impactEnd],[x+.02,.86,(z+.04)*impactEnd]];
      polygon(target,points.map(point=>transformPoint(dentCollisionPoint(point,effect,sample.damage))),rgb('#313a31'),3);
    }
    return target;
  }
  function buildCollisionSmoke(pose,view,origin,stats) {
    const target=mesh(),effect=pose.collisionEffect;
    stats.smokeParticleCount=0;
    if(!effect)return target;
    const sample=collisionSample(pose),yaw=pose.heading*Math.PI/180;
    const source=collisionRotation(sample)(dentCollisionPoint([0,.95,1.25],effect,sample.damage));
    const sourceY=source[1]+sample.bodyLift;
    const sourceX=pose.x+source[0]*Math.cos(yaw)+source[2]*Math.sin(yaw),sourceZ=pose.y-origin-source[0]*Math.sin(yaw)+source[2]*Math.cos(yaw);
    stats.smokeSourceX=sourceX;stats.smokeSourceY=sourceY;stats.smokeSourceZ=sourceZ+origin;
    const cameraYaw=view.heading*Math.PI/180,sinYaw=Math.sin(cameraYaw),cosYaw=Math.cos(cameraYaw);
    const sinPitch=Math.sin(view.cameraPitch),cosPitch=Math.cos(view.cameraPitch);
    const right=[cosYaw,0,-sinYaw],up=[sinYaw*sinPitch,cosPitch,cosYaw*sinPitch];
    const travelHeading=boundedNumber(effect.travelHeading,viewHeading(pose),-1e8,1e8)*Math.PI/180;
    for(let index=0;index<8;index++) {
      const age=(sample.smokeTime*.28+index/8)%1;
      const radius=.24+age*.7,drift=.6*age;
      const x=sourceX-Math.sin(travelHeading)*drift+Math.sin(index*2.1+sample.smokeTime*.8)*age*.25;
      const y=sourceY+age*3.2,z=sourceZ-Math.cos(travelHeading)*drift;
      const gray=.18+age*.16,color=[gray,gray+.025,gray+.04];
      const opacity=sample.smoke*(.5+.5*Math.sin(Math.PI*age))*(1-age*.75);
      for(const [scale,alpha] of [[1,.22],[.76,.28],[.5,.33]]) {
        const points=[];
        for(let point=0;point<12;point++) {
          const angle=point*Math.PI/6,r=radius*scale*(1+.08*Math.sin(point*2+index));
          const a=Math.cos(angle)*r,b=Math.sin(angle)*r;
          points.push([x+right[0]*a+up[0]*b,y+up[1]*b,z+right[2]*a+up[2]*b]);
        }
        polygon(target,points,color,3,-alpha*opacity);
      }
      stats.smokeParticleCount++;
    }
    // The transparent pass uses the same ordinary depth buffer as traffic.
    // Only its own overlapping puffs need to be ordered from far to near.
    const depth=face=>(face.x-view.x)*sinYaw+(face.z-(view.y-origin))*cosYaw;
    target.faces.sort((a,b)=>depth(b)-depth(a));
    target.vertices=[];
    for(const face of target.faces)for(let i=1;i<face.points.length-1;i++)
      for(const index of [0,i,i+1])target.vertices.push(...face.points[index],...face.color,face.material);
    return target;
  }

  // No road length limit: guardrails are the only collision boundaries.
  function canOccupy(x, y, radius = .9) {
    return Number.isFinite(x) && Number.isFinite(y) && x - radius > bounds.left && x + radius < bounds.right;
  }
  function rangeAhead(x, y, heading) {
    if (![x,y,heading].every(Number.isFinite)) return 0;
    if (x <= bounds.left || x >= bounds.right) return 0;
    const side = Math.sin(heading * Math.PI / 180);
    if (Math.abs(side) < 1e-7) return ROAD.far;
    return Math.max(0,Math.min(ROAD.far,((side > 0 ? bounds.right : bounds.left)-x)/side));
  }

  function buildBrakingGuide(pose, origin, stats) {
    const target = mesh();
    stats.emergencyLaneAlert = Boolean(pose.emergencyLaneAlert);
    if (stats.emergencyLaneAlert) {
      // Overlay only: the controller owns the alert and braking decision.
      const near = pose.y-origin-100, far = pose.y-origin+100;
      for (const x of [ROAD.emergencyStart,ROAD.emergencyEnd]) ground(target,x-.1,x+.1,near,far,.028,COLORS.red,2);
      for (let z = Math.floor(near/12)*12; z < far; z += 12) {
        const x = ROAD.emergencyCenter;
        polygon(target,[[x-.6,.03,z],[x-.42,.03,z-.12],[x+.6,.03,z+2],[x+.42,.03,z+2.12]],COLORS.red,2);
        polygon(target,[[x+.6,.03,z],[x+.42,.03,z-.12],[x-.6,.03,z+2],[x-.42,.03,z+2.12]],COLORS.red,2);
      }
    }
    const anchor = pose.brakeAnchor;
    const anchored = anchor && [anchor.x,anchor.y,anchor.heading,anchor.distance].every(Number.isFinite);
    const distance = Math.max(0,anchored ? anchor.distance : Number(pose.brakePrediction) || 0);
    const heading = (anchored ? anchor.heading : viewHeading(pose)) * Math.PI / 180;
    const sin = Math.sin(heading), cos = Math.cos(heading);
    const ax = anchored ? anchor.x : pose.x, az = (anchored ? anchor.y : pose.y) - origin;
    const travelled = anchored ? (pose.x-ax)*sin+(pose.y-origin-az)*cos : 0;
    const facingForward = Math.cos(viewHeading(pose)*Math.PI/180-heading) >= 0;
    const windowStart = travelled-(facingForward ? 2 : 1198);
    const start = Math.max(0,Math.min(Math.max(0,distance-1200),windowStart));
    const end = Math.min(distance,start+1200);
    stats.brakeClipped = distance > end;
    stats.brakeDistance = distance;
    if (distance < .12 || end < start) return target;
    function point(side, along, height = .034) { return [ax+sin*along+cos*side,height,az+cos*along-sin*side]; }
    function strip(left,right,from,to,color) { polygon(target,[point(left,from),point(right,from),point(right,to),point(left,to)],color,2); }
    const spacing = distance < 20 ? 2 : 8, dash = Math.min(spacing*.6,distance*.4);
    for (let d = Math.floor(start/spacing)*spacing; d < end; d += spacing) {
      const from = Math.max(start,d), to = Math.min(end,d+dash);
      if (to <= from) continue;
      strip(-1.08,-.96,from,to,COLORS.amber);
      strip(.96,1.08,from,to,COLORS.amber);
      if (d > 1) {
        const tip = Math.min(to,from+.6);
        polygon(target,[point(-.36,from),point(0,tip),point(0,from+.16)],COLORS.amber,2);
        polygon(target,[point(0,from+.16),point(0,tip),point(.36,from)],COLORS.amber,2);
      }
    }
    // The true projected endpoint alone gets a red stop line. A long estimate
    // clipped at 1200 m never gets a false endpoint at the visibility cap.
    if (!stats.brakeClipped && distance >= start) {
      strip(-1.7,1.7,Math.max(0,distance-.18),distance+.18,COLORS.red);
      for (const side of [-1.7,1.7]) {
        const p = point(side,distance);
        box(target,p[0],.035,p[2],.055,.7,.055,COLORS.red);
        box(target,p[0],.61,p[2],.19,.14,.055,COLORS.red);
      }
    }
    return target;
  }

  function createCamera(canvas) {
    let highwayOrigin = 0, sceneKey = 'highway:none:', highway = buildHighway(highwayOrigin);
    let gl = null, context = null, program = null, staticBuffer = null, guideBuffer = null, trafficBuffer = null, skyBuffer = null, smokeBuffer = null;
    let width = 0, height = 0, frames = 0, totalFrames = 0, frameStart = performance.now(), disposed = false;
    let locations;
    const shaders = [];
    const stats = { backend: '', fps: 0, frames: 0, worldOrigin: 0, cameraHeight: ROAD.cameraHeight, cameraHeading: 0, brakeClipped: false, brakeDistance: 0, visibleTraffic: 0 };
    try { gl = canvas.getContext('webgl',{alpha:false,antialias:true,preserveDrawingBuffer:true,powerPreference:'low-power'}); } catch {}
    if (gl) {
      const compile = (type,source) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader,source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
        shaders.push(shader); return shader;
      };
      program = gl.createProgram();
      gl.attachShader(program,compile(gl.VERTEX_SHADER,`
        attribute vec3 aPosition; attribute vec3 aColor; attribute float aMaterial;
        uniform vec4 uPose; uniform vec3 uCamera; uniform mediump vec2 uSize; uniform mediump float uSky;
        varying mediump vec3 vColor; varying mediump float vDepth; varying mediump float vMaterial;
        void main(){
          vColor=aColor;vMaterial=aMaterial;
          if(uSky>.5){gl_Position=vec4(aPosition.xy,0.,1.);vDepth=0.;}
          else{
            vec3 d=aPosition-vec3(uPose.x,uCamera.x,uPose.y);
            float side=d.x*uPose.w-d.z*uPose.z;
            float flatDepth=d.x*uPose.z+d.z*uPose.w;
            float vertical=d.y*uCamera.z+flatDepth*uCamera.y;
            float depth=flatDepth*uCamera.z-d.y*uCamera.y;
            gl_Position=vec4(side*1.48/(uSize.x/uSize.y),vertical*1.48+.1*depth,1.000107*depth-.160009,depth);
            vDepth=depth;
          }
        }`));
      gl.attachShader(program,compile(gl.FRAGMENT_SHADER,`
        precision mediump float;
        uniform mediump vec2 uSize; uniform mediump float uSky; uniform float uWet;
        varying mediump vec3 vColor; varying mediump float vDepth; varying mediump float vMaterial;
        void main(){
          if(uSky>.5){
            float h=gl_FragCoord.y/uSize.y;
            vec3 sky=mix(vec3(.83,.89,.88),vec3(.36,.65,.83),smoothstep(.45,1.,h));
            gl_FragColor=vec4(mix(sky,vec3(.67,.76,.79),uWet*.2),1.);
          }else{
            vec3 color=vColor;
            if(vMaterial>.5){
              color=mix(color,color*vec3(.72,.79,.86),uWet);
              color+=vec3(.07,.09,.11)*uWet*smoothstep(30.,400.,vDepth);
            }
            float fog=smoothstep(110.,1480.,vDepth)*.91;
            float opacity=vMaterial<0. ? clamp(-vMaterial,0.,1.) : 1.;
            gl_FragColor=vec4(mix(color,vec3(.79,.86,.86),fog),opacity);
          }
        }`));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error(`Highway camera shader link failed: ${gl.getProgramInfoLog(program) || 'No WebGL linker log available'}`);
      gl.useProgram(program);
      locations = {
        position:gl.getAttribLocation(program,'aPosition'), color:gl.getAttribLocation(program,'aColor'), material:gl.getAttribLocation(program,'aMaterial'),
        pose:gl.getUniformLocation(program,'uPose'), camera:gl.getUniformLocation(program,'uCamera'),
        size:gl.getUniformLocation(program,'uSize'), sky:gl.getUniformLocation(program,'uSky'), wet:gl.getUniformLocation(program,'uWet')
      };
      for (const key of ['position','color','material']) gl.enableVertexAttribArray(locations[key]);
      staticBuffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,staticBuffer); gl.bufferData(gl.ARRAY_BUFFER,highway.data,gl.STATIC_DRAW);
      guideBuffer = gl.createBuffer();
      trafficBuffer = gl.createBuffer();
      skyBuffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,skyBuffer);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,0,0,0,0,0,3,-1,0,0,0,0,0,-1,3,0,0,0,0,0]),gl.STATIC_DRAW);
      smokeBuffer=gl.createBuffer();
      gl.disable(gl.CULL_FACE); gl.clearColor(.79,.86,.86,1);
      stats.backend = 'WebGL';
    } else {
      context = canvas.getContext('2d',{alpha:false});
      if (!context) throw new Error('Highway camera rendering unavailable');
      stats.backend = 'Canvas 2D';
    }
    function bind(buffer) {
      gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
      gl.vertexAttribPointer(locations.position,3,gl.FLOAT,false,28,0);
      gl.vertexAttribPointer(locations.color,3,gl.FLOAT,false,28,12);
      gl.vertexAttribPointer(locations.material,1,gl.FLOAT,false,28,24);
    }
    function resize() {
      const rect = canvas.getBoundingClientRect(), ratio = Math.min(window.devicePixelRatio || 1,1.5);
      width = Math.max(1,Math.round(rect.width*ratio)); height = Math.max(1,Math.round(rect.height*ratio));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      if (gl) gl.viewport(0,0,width,height);
    }
    function clipDepth(points, boundary, greater) {
      const clipped = [];
      for (let i = 0; i < points.length; i++) {
        const p = points[i], q = points[(i+1)%points.length];
        const pin = greater ? p[2] >= boundary : p[2] <= boundary, qin = greater ? q[2] >= boundary : q[2] <= boundary;
        if (pin) clipped.push(p);
        if (pin !== qin) {
          const t = (boundary-p[2])/(q[2]-p[2]);
          clipped.push([p[0]+(q[0]-p[0])*t,p[1]+(q[1]-p[1])*t,boundary]);
        }
      }
      return clipped;
    }
    function softwareDraw(pose, localY, guide, traffic,smoke) {
      const angle = viewHeading(pose)*Math.PI/180, sin = Math.sin(angle), cos = Math.cos(angle), focal = height*FOCAL/2;
      const pitchSin = Math.sin(pose.cameraPitch), pitchCos = Math.cos(pose.cameraPitch);
      const sky = context.createLinearGradient(0,0,0,height*.59);
      sky.addColorStop(0,pose.wet ? '#73a1b7' : '#5ca6d4'); sky.addColorStop(1,'#d4e3e0');
      context.fillStyle = sky; context.fillRect(0,0,width,height);
      const projected = [];
      for (const face of [...highway.faces,...guide.faces,...traffic.faces,...smoke.faces]) {
        const centerDepth = (face.x-pose.x)*sin+(face.z-localY)*cos;
        if (centerDepth+face.radius < NEAR || centerDepth-face.radius > ROAD.far) continue;
        let points = face.points.map(([x,y,z]) => {
          const dx = x-pose.x, dz = z-localY, dy = y-pose.cameraHeight, flatDepth = dx*sin+dz*cos;
          return [dx*cos-dz*sin,dy*pitchCos+flatDepth*pitchSin,flatDepth*pitchCos-dy*pitchSin];
        });
        points = clipDepth(clipDepth(points,NEAR,true),ROAD.far,false);
        if (points.length < 3) continue;
        const screen = points.map(p => [width/2+p[0]*focal/p[2],height*HORIZON-p[1]*focal/p[2]]);
        if (screen.every(p => p[0] < 0) || screen.every(p => p[0] > width) || screen.every(p => p[1] < 0) || screen.every(p => p[1] > height)) continue;
        const depth = points.reduce((sum,p) => sum+p[2],0)/points.length;
        projected.push({face,points:screen,depth});
      }
      projected.sort((a,b) => a.face.layer-b.face.layer || b.depth-a.depth);
      for (const entry of projected) {
        const t = Math.max(0,Math.min(1,(entry.depth-110)/1370)), fog = t*t*(3-2*t)*.91;
        const color = entry.face.color.map((value,i) => {
          if (entry.face.material>.5 && pose.wet) value *= [.72,.79,.86][i];
          return Math.round((value*(1-fog)+[.79,.86,.86][i]*fog)*255);
        });
        context.fillStyle = entry.face.material<0?`rgba(${color.join(',')},${-entry.face.material})`:`rgb(${color.join(',')})`; context.beginPath();
        entry.points.forEach(([x,y],i) => i ? context.lineTo(x,y) : context.moveTo(x,y));
        context.closePath(); context.fill();
      }
    }
    resize();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    observer?.observe(canvas);
    if (!observer) window.addEventListener('resize',resize);
    const lost = event => { event.preventDefault(); window.dispatchEvent(new CustomEvent('rover-camera-lost')); };
    const restored = () => window.dispatchEvent(new CustomEvent('rover-camera-lost'));
    canvas.addEventListener('webglcontextlost',lost); canvas.addEventListener('webglcontextrestored',restored);
    return {
      stats,
      draw(pose,now = performance.now()) {
        if (disposed || gl?.isContextLost() || ![pose.x,pose.y,pose.heading].every(Number.isFinite)) return false;
        const motion=collisionTravel(pose);
        const visualPose=pose.collisionEffect?{...pose,x:pose.x+motion.x,y:pose.y+motion.y}:pose;
        const origin = Math.floor(visualPose.y/ROAD.repeat)*ROAD.repeat;
        const view = collisionCamera(pose,width/height), localY = view.y-origin;
        const route = pose.exitRoute || null;
        const trafficRoutes=!pose.localRoad&&!route?[...new Map((pose.traffic||[])
          .map(vehicle=>vehicle.exitRoute?.event)
          .filter(exit=>exit&&typeof exit.id==='string'&&Number.isFinite(exit.entryStart)&&Number.isFinite(exit.rampEnd))
          .map(exit=>[exit.id,exit])).values()].sort((a,b)=>a.entryStart-b.entryStart):[];
        const nextSceneKey = `${pose.localRoad ? 'local' : 'highway'}:${route?.id || 'none'}:${trafficRoutes.map(exit=>exit.id).join(',')}`;
        if (origin !== highwayOrigin || nextSceneKey !== sceneKey) {
          highwayOrigin = origin;
          sceneKey = nextSceneKey;
          highway = pose.localRoad ? buildLocalWorld(origin,route) : buildHighway(origin,route,trafficRoutes);
          if (gl) {
            gl.bindBuffer(gl.ARRAY_BUFFER,staticBuffer);
            gl.bufferData(gl.ARRAY_BUFFER,highway.data,gl.STATIC_DRAW);
          }
        }
        stats.worldOrigin = origin;
        stats.roadType = pose.localRoad ? 'local' : route ? 'exit' : 'highway';
        stats.roadSolid = !pose.localRoad && Boolean(window.RoverRoad?.getState(pose.y).solid);
        stats.nearbyExits = pose.localRoad ? 0 : route ? 1 : window.RoverRoad?.eventsAround(pose.y,ROAD.far).exits.length || 0;
        stats.nearbyEntrances = pose.localRoad || route ? 0 : window.RoverRoad?.eventsAround(pose.y,ROAD.far).entrances?.length || 0;
        stats.cameraHeading = viewHeading(view);
        stats.cameraHeight = view.cameraHeight;
        stats.cameraPitch = view.cameraPitch;
        stats.cameraX = view.x;
        stats.cameraY = view.y;
        stats.collisionViewClear = view.collisionViewClear;
        stats.collisionViewCandidate = view.collisionViewCandidate ?? null;
        const guide = buildBrakingGuide(pose,origin,stats);
        const traffic = buildTraffic(view,origin,stats,!gl);
        const self = buildCollisionVehicle(visualPose,origin,stats);
        stats.selfVertexCount = self.vertices.length/7;
        traffic.vertices.push(...self.vertices);
        traffic.faces.push(...self.faces);
        const smoke=buildCollisionSmoke(visualPose,view,origin,stats);
        stats.smokeVertexCount=smoke.vertices.length/7;
        if (gl) {
          gl.useProgram(program); gl.uniform2f(locations.size,width,height); gl.uniform1f(locations.wet,pose.wet ? 1 : 0);
          gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
          gl.disable(gl.DEPTH_TEST); gl.uniform1f(locations.sky,1); bind(skyBuffer); gl.drawArrays(gl.TRIANGLES,0,3);
          gl.enable(gl.DEPTH_TEST); gl.uniform1f(locations.sky,0);
          const angle = stats.cameraHeading*Math.PI/180;
          gl.uniform4f(locations.pose,view.x,localY,Math.sin(angle),Math.cos(angle));
          gl.uniform3f(locations.camera,view.cameraHeight,Math.sin(view.cameraPitch),Math.cos(view.cameraPitch));
          bind(staticBuffer); gl.drawArrays(gl.TRIANGLES,0,highway.data.length/7);
          if (guide.vertices.length) {
            bind(guideBuffer); gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(guide.vertices),gl.DYNAMIC_DRAW);
            gl.drawArrays(gl.TRIANGLES,0,guide.vertices.length/7);
          }
          if (traffic.vertices.length) {
            bind(trafficBuffer); gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(traffic.vertices),gl.DYNAMIC_DRAW);
            gl.drawArrays(gl.TRIANGLES,0,traffic.vertices.length/7);
          }
          if(smoke.vertices.length) {
            gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.depthMask(false);
            bind(smokeBuffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(smoke.vertices),gl.DYNAMIC_DRAW);
            gl.drawArrays(gl.TRIANGLES,0,smoke.vertices.length/7);
            gl.depthMask(true);gl.disable(gl.BLEND);
          }
        } else softwareDraw(view,localY,guide,traffic,smoke);
        frames++; totalFrames++;
        if (now-frameStart >= 1000) { stats.fps = Math.round(frames*1000/(now-frameStart)); frameStart = now; frames = 0; }
        stats.frames = totalFrames;
        return true;
      },
      pause() { frames = 0; stats.fps = 0; frameStart = performance.now(); },
      dispose() {
        disposed = true; observer?.disconnect(); window.removeEventListener('resize',resize);
        canvas.removeEventListener('webglcontextlost',lost); canvas.removeEventListener('webglcontextrestored',restored);
        if (gl) { for (const buffer of [staticBuffer,guideBuffer,trafficBuffer,skyBuffer,smokeBuffer]) gl.deleteBuffer(buffer); for (const shader of shaders) gl.deleteShader(shader); gl.deleteProgram(program); }
      }
    };
  }
  window.RoverSimulator = Object.freeze({createCamera,canOccupy,rangeAhead,bounds,obstacles,road:ROAD,sampleCollisionEffect});
})();

const D=Math.PI/180;
// vFOV 30, pitch 65 from horizontal, 16:9
const vfov=30*D, pitch=65*D, aspect=16/9;
const hfov=2*Math.atan(Math.tan(vfov/2)*aspect);
// Solve camera range so a 1.8m character is 5% of frame height.
// Apparent vertical extent of an upright 1.8m figure viewed at elevation `pitch`: 1.8*cos(pitch)
const apparent=1.8*Math.cos(pitch);
const range=(apparent/2)/Math.tan(0.05*vfov/2);
const h=range*Math.sin(pitch);
console.log('hFOV deg', (hfov/D).toFixed(1));
console.log('apparent char height m', apparent.toFixed(2));
console.log('camera slant range m', range.toFixed(1), 'height m', h.toFixed(1));
// ground depth visible
const near=h/Math.tan(pitch+vfov/2), far=h/Math.tan(pitch-vfov/2);
console.log('ground band from nadir: near',near.toFixed(1),'far',far.toFixed(1),'depth',(far-near).toFixed(1));
const width=2*range*Math.tan(hfov/2);
console.log('width at player m', width.toFixed(1));
const cells=(far-near)/12*(width/12);
console.log('room cells visible ~', cells.toFixed(1));
console.log('area m2', ((far-near)*width).toFixed(0));
// proposal's own claim
console.log('proposal 45x35 =', 45*35, 'm2 ->', (45*35/144).toFixed(1), 'cells (claimed 16)');

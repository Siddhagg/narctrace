'use strict';

/* ============================================================
   NarcTrace — client-only prototype
   Everything runs in the browser: camera, geolocation, colour
   analysis and history storage. No backend, no uploads.
   ============================================================ */

const TARGET_PHOTOS = 6;
const MIN_PHOTOS_TO_FINISH_EARLY = 4;


const el = (id) => document.getElementById(id);

const state = {
  officer: null,          // { name, badge }
  permissions: { camera: false, location: false },
  cameraStream: null,
  liveSampleTimer: null,
  liveColorBuffer: [],
  lastRawFocusColor: null,   // pre-white-balance reading, used by the calibrate action
  calibrationGains: null,    // manual white-balance gains, set by "Calibrate White Balance"
  currentTest: null,      // { id, officer, badge, startedAt, lat, lon, city, state, address, photos: [] }
};

/* --------------------- Screen navigation --------------------- */

const SCREENS = ['permissions', 'login', 'home', 'test', 'report', 'history', 'detail'];

function showScreen(name) {
  for (const s of SCREENS) {
    const node = el(`screen-${s}`);
    if (node) node.hidden = s !== name;
  }
  const topnav = el('topnav');
  if (state.officer) {
    topnav.hidden = false;
    el('navTest').classList.toggle('active', name === 'test' || name === 'report');
    el('navHistory').classList.toggle('active', name === 'history' || name === 'detail');
  } else {
    topnav.hidden = true;
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* --------------------- Utility helpers --------------------- */

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  const v = max;
  return { h, s, v };
}

// Hue/saturation/value based classification — far more reliable for real
// camera pixels than nearest-RGB-point matching, which frequently confused
// blue/purple/green because it ignores brightness and saturation.
function nearestColorName(r, g, b) {
  const { h, s, v } = rgbToHsv(r, g, b);

  if (v < 0.16) return 'Black';
  if (s < 0.14 && v > 0.78) return 'White';
  if (s < 0.16) return 'Gray';

  // Light, desaturated warm hues read as Pink rather than Red.
  if (v > 0.75 && s < 0.55 && (h >= 320 || h < 20)) return 'Pink';

  // Dark, muted red/orange hues read as Brown rather than Orange/Red.
  if (v < 0.55 && s > 0.25 && h >= 5 && h < 50) return 'Brown';

  if (h < 12 || h >= 345) return 'Red';
  if (h < 45) return 'Orange';
  if (h < 65) return 'Yellow';
  if (h < 170) return 'Green';
  if (h < 255) return 'Blue';
  if (h < 320) return 'Purple';
  return 'Pink';
}

/* --------------------- Fine-grained shade matching (CIE Lab) --------------------- */
// RGB Euclidean distance does not match human colour perception well — equal
// RGB distances can look very different apart, or very similar colours can be
// far apart in RGB. Lab space is built so that Euclidean distance in it tracks
// perceived difference, which is what lets a large named-colour table (150+
// shades below) reliably tell "Pink" from "Baby Pink" from "Hot Pink" instead
// of them all collapsing onto one nearest fixed point.

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToLab(r, g, b) {
  let [rl, gl, bl] = [r, g, b].map((v) => {
    v /= 255;
    return v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92;
  });
  let x = (rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375) / 0.95047;
  let y = (rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750) / 1.0;
  let z = (rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return { L: 116 * fy - 16, A: 500 * (fx - fy), B: 200 * (fy - fz) };
}

// Standard CSS/X11 named colours plus a handful of common colloquial shades
// (baby pink, baby blue, peach, etc.) that field officers are more likely to
// reach for than their formal CSS equivalents.
const NAMED_COLOR_HEX = [
  ['Black', '#000000'], ['White', '#FFFFFF'], ['Gray', '#808080'], ['Silver', '#C0C0C0'],
  ['DimGray', '#696969'], ['DarkGray', '#A9A9A9'], ['LightGray', '#D3D3D3'], ['Gainsboro', '#DCDCDC'],
  ['WhiteSmoke', '#F5F5F5'], ['Snow', '#FFFAFA'], ['Ivory', '#FFFFF0'], ['Charcoal', '#36454F'],
  ['SlateGray', '#708090'], ['LightSlateGray', '#778899'], ['DarkSlateGray', '#2F4F4F'],
  ['Red', '#FF0000'], ['DarkRed', '#8B0000'], ['FireBrick', '#B22222'], ['Crimson', '#DC143C'],
  ['IndianRed', '#CD5C5C'], ['LightCoral', '#F08080'], ['Salmon', '#FA8072'], ['DarkSalmon', '#E9967A'],
  ['LightSalmon', '#FFA07A'], ['Maroon', '#800000'], ['Brown', '#A52A2A'], ['Sienna', '#A0522D'],
  ['SaddleBrown', '#8B4513'], ['Chocolate', '#D2691E'], ['Peru', '#CD853F'], ['RosyBrown', '#BC8F8F'],
  ['Tan', '#D2B48C'], ['Beige', '#F5F5DC'], ['Wheat', '#F5DEB3'], ['Rust', '#B7410E'], ['Burgundy', '#800020'],
  ['Orange', '#FFA500'], ['DarkOrange', '#FF8C00'], ['OrangeRed', '#FF4500'], ['Coral', '#FF7F50'],
  ['Tomato', '#FF6347'], ['Peach', '#FFE5B4'], ['PeachPuff', '#FFDAB9'], ['SandyBrown', '#F4A460'],
  ['BurlyWood', '#DEB887'], ['NavajoWhite', '#FFDEAD'], ['Bisque', '#FFE4C4'], ['Moccasin', '#FFE4B5'],
  ['Yellow', '#FFFF00'], ['Gold', '#FFD700'], ['Khaki', '#F0E68C'], ['DarkKhaki', '#BDB76B'],
  ['PaleGoldenRod', '#EEE8AA'], ['GoldenRod', '#DAA520'], ['DarkGoldenRod', '#B8860B'],
  ['LemonChiffon', '#FFFACD'], ['LightYellow', '#FFFFE0'], ['Cornsilk', '#FFF8DC'], ['Cream', '#FFFDD0'],
  ['Green', '#008000'], ['DarkGreen', '#006400'], ['ForestGreen', '#228B22'], ['LimeGreen', '#32CD32'],
  ['Lime', '#00FF00'], ['SeaGreen', '#2E8B57'], ['MediumSeaGreen', '#3CB371'], ['SpringGreen', '#00FF7F'],
  ['MediumSpringGreen', '#00FA9A'], ['LightGreen', '#90EE90'], ['PaleGreen', '#98FB98'], ['Mint', '#98FF98'],
  ['DarkSeaGreen', '#8FBC8F'], ['OliveDrab', '#6B8E23'], ['Olive', '#808000'], ['DarkOliveGreen', '#556B2F'],
  ['YellowGreen', '#9ACD32'], ['GreenYellow', '#ADFF2F'], ['Chartreuse', '#7FFF00'], ['LawnGreen', '#7CFC00'],
  ['Cyan', '#00FFFF'], ['Teal', '#008080'], ['DarkCyan', '#008B8B'], ['LightCyan', '#E0FFFF'],
  ['Turquoise', '#40E0D0'], ['MediumTurquoise', '#48D1CC'], ['DarkTurquoise', '#00CED1'],
  ['PaleTurquoise', '#AFEEEE'], ['Aquamarine', '#7FFFD4'], ['MediumAquaMarine', '#66CDAA'],
  ['CadetBlue', '#5F9EA0'],
  ['Blue', '#0000FF'], ['DarkBlue', '#00008B'], ['MediumBlue', '#0000CD'], ['Navy', '#000080'],
  ['MidnightBlue', '#191970'], ['RoyalBlue', '#4169E1'], ['SteelBlue', '#4682B4'], ['DodgerBlue', '#1E90FF'],
  ['DeepSkyBlue', '#00BFFF'], ['SkyBlue', '#87CEEB'], ['LightSkyBlue', '#87CEFA'], ['BabyBlue', '#89CFF0'],
  ['LightBlue', '#ADD8E6'], ['PowderBlue', '#B0E0E6'], ['LightSteelBlue', '#B0C4DE'],
  ['CornflowerBlue', '#6495ED'], ['SlateBlue', '#6A5ACD'], ['MediumSlateBlue', '#7B68EE'],
  ['DarkSlateBlue', '#483D8B'],
  ['Purple', '#800080'], ['DarkViolet', '#9400D3'], ['DarkOrchid', '#9932CC'], ['MediumOrchid', '#BA55D3'],
  ['Orchid', '#DA70D6'], ['Violet', '#EE82EE'], ['Plum', '#DDA0DD'], ['Thistle', '#D8BFD8'],
  ['Lavender', '#E6E6FA'], ['Lilac', '#C8A2C8'], ['Mauve', '#E0B0FF'], ['Indigo', '#4B0082'],
  ['BlueViolet', '#8A2BE2'], ['MediumPurple', '#9370DB'], ['RebeccaPurple', '#663399'],
  ['Magenta', '#FF00FF'], ['Fuchsia', '#FF00FF'], ['DarkMagenta', '#8B008B'],
  ['Pink', '#FFC0CB'], ['LightPink', '#FFB6C1'], ['BabyPink', '#F4C2C2'], ['HotPink', '#FF69B4'],
  ['DeepPink', '#FF1493'], ['PaleVioletRed', '#DB7093'], ['MediumVioletRed', '#C71585'],
];
const NAMED_COLORS = NAMED_COLOR_HEX.map(([name, hex]) => {
  const { r, g, b } = hexToRgb(hex);
  return { name, hex, r, g, b, lab: rgbToLab(r, g, b) };
});

function nearestNamedColor(r, g, b) {
  const lab = rgbToLab(r, g, b);
  let best = null, bestDist = Infinity;
  for (const c of NAMED_COLORS) {
    const d = (lab.L - c.lab.L) ** 2 + (lab.A - c.lab.A) ** 2 + (lab.B - c.lab.B) ** 2;
    if (d < bestDist) { bestDist = d; best = c; }
  }
  return best.name;
}

/* --------------------- Lighting / white-balance correction --------------------- */
// A single uncalibrated phone camera cannot perfectly undo colour casts from
// mixed lighting (fluorescent, tungsten, shade, direct sun all shift colour).
// Two mitigations are applied: (1) automatic per-frame gray-world correction
// as a sane default, and (2) an optional one-tap manual calibration against a
// white/gray reference, which is far more reliable when precision matters —
// this is the same approach real colour-matching tools use, since illuminant
// colour casts cannot be fully undone from a single image without a reference.

function computeGrayWorldGains(canvas) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let r = 0, g = 0, b = 0, n = 0;
  const stride = 4 * 20; // sparse sample across the full frame for performance
  for (let i = 0; i < data.length; i += stride) {
    r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
  }
  r /= n; g /= n; b /= n;
  const gray = (r + g + b) / 3;
  const clamp = (v) => Math.min(1.8, Math.max(0.6, v));
  return {
    r: clamp(gray / Math.max(r, 1)),
    g: clamp(gray / Math.max(g, 1)),
    b: clamp(gray / Math.max(b, 1)),
  };
}

function applyGains(r, g, b, gains) {
  const clamp = (v) => Math.min(255, Math.max(0, Math.round(v)));
  return { r: clamp(r * gains.r), g: clamp(g * gains.g), b: clamp(b * gains.b) };
}

function generateTestId() {
  let counter = parseInt(localStorage.getItem('narctrace_counter') || '120', 10);
  counter += 1;
  localStorage.setItem('narctrace_counter', String(counter));
  return `FT-${String(counter).padStart(5, '0')}`;
}

function formatTimestamp(date) {
  return date.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function getCurrentPositionAsync(options) {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

async function reverseGeocode(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=14&addressdetails=1`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('reverse geocode failed');
    const data = await res.json();
    const addr = data.address || {};
    const city = addr.city || addr.town || addr.village || addr.suburb || addr.county || '';
    const stateName = addr.state || addr.state_district || '';
    const address = data.display_name || '';
    return { city, state: stateName, address };
  } catch (err) {
    return { city: '', state: '', address: 'Unable to resolve address (offline or API unavailable)' };
  }
}

function setMapFrame(lat, lon) {
  const d = 0.008;
  const bbox = `${lon - d}%2C${lat - d}%2C${lon + d}%2C${lat + d}`;
  el('mapFrame').src = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat}%2C${lon}`;
  el('mapWrap').hidden = false;
}

/* --------------------- Permissions screen --------------------- */

el('btnEnable').addEventListener('click', requestPermissions);

async function requestPermissions() {
  const btn = el('btnEnable');
  btn.disabled = true;
  el('permError').hidden = true;

  const camItem = el('permCameraItem');
  const locItem = el('permLocationItem');
  const camStatus = el('permCameraStatus');
  const locStatus = el('permLocationStatus');

  camStatus.textContent = 'Requesting…';
  locStatus.textContent = 'Requesting…';

  // Camera
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    stream.getTracks().forEach((t) => t.stop());
    state.permissions.camera = true;
    camItem.classList.add('granted');
    camItem.classList.remove('denied');
    camStatus.textContent = 'Granted';
  } catch (err) {
    state.permissions.camera = false;
    camItem.classList.add('denied');
    camStatus.textContent = 'Denied';
  }

  // Location
  try {
    await getCurrentPositionAsync({ enableHighAccuracy: true, timeout: 10000 });
    state.permissions.location = true;
    locItem.classList.add('granted');
    locItem.classList.remove('denied');
    locStatus.textContent = 'Granted';
  } catch (err) {
    state.permissions.location = false;
    locItem.classList.add('denied');
    locStatus.textContent = 'Denied';
  }

  btn.disabled = false;

  if (state.permissions.camera && state.permissions.location) {
    const savedOfficer = sessionStorage.getItem('narctrace_officer');
    if (savedOfficer) {
      state.officer = JSON.parse(savedOfficer);
      el('homeOfficerName').textContent = state.officer.name;
      showScreen('home');
    } else {
      showScreen('login');
    }
  } else {
    const missing = [];
    if (!state.permissions.camera) missing.push('camera');
    if (!state.permissions.location) missing.push('location');
    const errNode = el('permError');
    errNode.hidden = false;
    errNode.textContent = `NarcTrace needs ${missing.join(' and ')} access to continue. Please allow the permission in your browser (check the site settings/padlock icon) and try again.`;
  }
}

/* --------------------- Officer login --------------------- */

el('btnLogin').addEventListener('click', () => {
  const name = el('officerName').value.trim();
  const badge = el('officerBadge').value.trim();
  const errNode = el('loginError');
  if (!name || !badge) {
    errNode.hidden = false;
    errNode.textContent = 'Please enter both your name and badge/ID number.';
    return;
  }
  errNode.hidden = true;
  state.officer = { name, badge };
  sessionStorage.setItem('narctrace_officer', JSON.stringify(state.officer));
  el('homeOfficerName').textContent = name;
  el('officerChip').hidden = false;
  el('officerChip').textContent = `${name} · ${badge}`;
  showScreen('home');
});

/* --------------------- Home --------------------- */

el('btnStartTest').addEventListener('click', startNewTest);
el('btnViewHistory').addEventListener('click', () => { renderHistory(); showScreen('history'); });
el('navTest').addEventListener('click', () => {
  if (state.currentTest && !state.currentTest.finishedAt) showScreen('test');
  else startNewTest();
});
el('navHistory').addEventListener('click', () => { renderHistory(); showScreen('history'); });
el('btnLogout').addEventListener('click', () => {
  sessionStorage.removeItem('narctrace_officer');
  state.officer = null;
  el('officerChip').hidden = true;
  el('officerName').value = '';
  el('officerBadge').value = '';
  showScreen('login');
});

/* --------------------- Active test --------------------- */

async function startNewTest() {
  stopCamera();

  const test = {
    id: generateTestId(),
    officer: state.officer.name,
    badge: state.officer.badge,
    startedAt: new Date().toISOString(),
    lat: null,
    lon: null,
    city: '',
    state: '',
    address: '',
    photos: [],
  };
  state.currentTest = test;
  state.liveColorBuffer = [];
  state.calibrationGains = null;
  updateCalibrateStatus();

  el('activeTestId').textContent = test.id;
  el('metaOfficer').textContent = `${test.officer} (${test.badge})`;
  el('metaTime').textContent = formatTimestamp(new Date(test.startedAt));
  el('metaGpsStatus').textContent = 'Locating…';
  el('metaCoords').textContent = '—';
  el('metaCityState').textContent = '—';
  el('metaAddress').textContent = '—';
  el('mapWrap').hidden = true;
  el('thumbGrid').innerHTML = '';
  el('btnFinishEarly').hidden = true;
  updateProgress();

  showScreen('test');
  locateForTest(test);
  startCamera();
}

async function locateForTest(test) {
  try {
    const pos = await getCurrentPositionAsync({ enableHighAccuracy: true, timeout: 15000 });
    test.lat = pos.coords.latitude;
    test.lon = pos.coords.longitude;
    el('metaGpsStatus').textContent = `Locked (±${Math.round(pos.coords.accuracy)}m)`;
    el('metaCoords').textContent = `${test.lat.toFixed(6)}, ${test.lon.toFixed(6)}`;
    setMapFrame(test.lat, test.lon);

    const geo = await reverseGeocode(test.lat, test.lon);
    test.city = geo.city;
    test.state = geo.state;
    test.address = geo.address;
    el('metaCityState').textContent = [geo.city, geo.state].filter(Boolean).join(', ') || 'Unknown';
    el('metaAddress').textContent = geo.address || '—';
  } catch (err) {
    el('metaGpsStatus').textContent = 'Unavailable';
    el('metaCityState').textContent = 'Unknown';
    el('metaAddress').textContent = 'Location could not be determined';
  }
}

async function startCamera() {
  const video = el('video');
  const overlay = el('overlayCanvas');
  const hidden = el('hiddenCanvas');
  const statusEl = el('cameraStatus');

  try {
    statusEl.textContent = 'Starting camera…';
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 960 } },
    });
    state.cameraStream = stream;
    video.srcObject = stream;
    await video.play();

    hidden.width = video.videoWidth || 1280;
    hidden.height = video.videoHeight || 960;
    resizeOverlay();

    statusEl.textContent = 'Point the reaction/object at the centre box';

    state.liveSampleTimer = setInterval(sampleLiveColor, 250);
  } catch (err) {
    statusEl.textContent = 'Camera access failed — check permissions and reload';
  }
}

function stopCamera() {
  if (state.liveSampleTimer) {
    clearInterval(state.liveSampleTimer);
    state.liveSampleTimer = null;
  }
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach((t) => t.stop());
    state.cameraStream = null;
  }
}

window.addEventListener('resize', resizeOverlay);

function resizeOverlay() {
  const box = document.querySelector('.camera-box');
  const overlay = el('overlayCanvas');
  if (!box || !overlay) return;
  overlay.width = box.clientWidth;
  overlay.height = box.clientHeight;
  drawFocusBoxOutline();
}

function focusBoxRect(width, height) {
  const size = Math.floor(Math.min(width, height) * 0.35);
  const x = Math.floor((width - size) / 2);
  const y = Math.floor((height - size) / 2);
  return { x, y, size };
}

function drawFocusBoxOutline() {
  const overlay = el('overlayCanvas');
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  const { x, y, size } = focusBoxRect(overlay.width, overlay.height);
  ctx.strokeStyle = '#29d3b0';
  ctx.lineWidth = 3;
  ctx.setLineDash([8, 6]);
  ctx.strokeRect(x, y, size, size);
  ctx.setLineDash([]);
  const corner = 14;
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#eaf0fb';
  [[x, y, 1, 1], [x + size, y, -1, 1], [x, y + size, 1, -1], [x + size, y + size, -1, -1]].forEach(([cx, cy, dx, dy]) => {
    ctx.beginPath();
    ctx.moveTo(cx, cy + corner * dy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + corner * dx, cy);
    ctx.stroke();
  });
}

function readFocusColor(canvas) {
  const ctx = canvas.getContext('2d');
  const { x, y, size } = focusBoxRect(canvas.width, canvas.height);
  const data = ctx.getImageData(x, y, size, size).data;
  let r = 0, g = 0, b = 0, n = 0;
  const stride = 4 * 3; // sample every 3rd pixel for performance
  for (let i = 0; i < data.length; i += stride) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    n++;
  }
  r = Math.round(r / n);
  g = Math.round(g / n);
  b = Math.round(b / n);
  return { r, g, b };
}

function correctedFocusReading(hidden) {
  const raw = readFocusColor(hidden);
  state.lastRawFocusColor = raw;
  const gains = state.calibrationGains || computeGrayWorldGains(hidden);
  return applyGains(raw.r, raw.g, raw.b, gains);
}

function sampleLiveColor() {
  const video = el('video');
  const hidden = el('hiddenCanvas');
  if (!video.videoWidth) return;
  const ctx = hidden.getContext('2d');
  ctx.drawImage(video, 0, 0, hidden.width, hidden.height);
  drawFocusBoxOutline();

  const { r, g, b } = correctedFocusReading(hidden);
  state.liveColorBuffer.push({ r, g, b });
  if (state.liveColorBuffer.length > 5) state.liveColorBuffer.shift();

  const avg = state.liveColorBuffer.reduce((acc, c) => ({ r: acc.r + c.r, g: acc.g + c.g, b: acc.b + c.b }), { r: 0, g: 0, b: 0 });
  const n = state.liveColorBuffer.length;
  const sr = Math.round(avg.r / n), sg = Math.round(avg.g / n), sb = Math.round(avg.b / n);
  const hex = rgbToHex(sr, sg, sb);
  const family = nearestColorName(sr, sg, sb);
  const shade = nearestNamedColor(sr, sg, sb);

  el('liveSwatch').style.background = hex;
  el('liveColorName').textContent = family;
  el('liveColorShade').textContent = shade !== family ? `Closest shade: ${shade}` : '';
  el('liveColorHex').textContent = `${hex} · rgb(${sr}, ${sg}, ${sb})`;
}

function updateCalibrateStatus() {
  const statusEl = el('calibrateStatus');
  if (!statusEl) return;
  statusEl.textContent = state.calibrationGains
    ? 'Calibrated to reference ✓ — tap again to recalibrate'
    : 'Auto white-balance active — for best accuracy, point at a plain white/gray surface and calibrate';
}

el('btnCalibrate').addEventListener('click', () => {
  if (!state.lastRawFocusColor) return;
  const { r, g, b } = state.lastRawFocusColor;
  const target = 228; // bright neutral target — lands in the White bucket, safely below sensor clipping
  const clamp = (v) => Math.min(1.8, Math.max(0.5, v));
  state.calibrationGains = {
    r: clamp(target / Math.max(r, 1)),
    g: clamp(target / Math.max(g, 1)),
    b: clamp(target / Math.max(b, 1)),
  };
  state.liveColorBuffer = [];
  updateCalibrateStatus();
});

function updateProgress() {
  const count = state.currentTest ? state.currentTest.photos.length : 0;
  el('progressFill').style.width = `${Math.min(100, (count / TARGET_PHOTOS) * 100)}%`;
  el('progressText').textContent = `${count} / ${TARGET_PHOTOS} photos`;
  el('btnFinishEarly').hidden = count < MIN_PHOTOS_TO_FINISH_EARLY || count >= TARGET_PHOTOS;
}

el('btnCapture').addEventListener('click', capturePhoto);
el('btnFinishEarly').addEventListener('click', finishTest);

function capturePhoto() {
  const video = el('video');
  const hidden = el('hiddenCanvas');
  if (!video.videoWidth) return;

  const ctx = hidden.getContext('2d');
  ctx.drawImage(video, 0, 0, hidden.width, hidden.height);

  // Use the smoothed, white-balance-corrected buffer (same value shown live)
  // rather than a single fresh frame, so the recorded reading isn't thrown
  // off by a momentary glare spike or motion blur at the instant of the tap.
  const source = state.liveColorBuffer.length ? state.liveColorBuffer : [correctedFocusReading(hidden)];
  const avg = source.reduce((acc, c) => ({ r: acc.r + c.r, g: acc.g + c.g, b: acc.b + c.b }), { r: 0, g: 0, b: 0 });
  const r = Math.round(avg.r / source.length);
  const g = Math.round(avg.g / source.length);
  const b = Math.round(avg.b / source.length);
  const hex = rgbToHex(r, g, b);
  const name = nearestColorName(r, g, b);
  const shade = nearestNamedColor(r, g, b);

  // Downscale for storage-efficient thumbnail/report image
  const small = document.createElement('canvas');
  const scale = 480 / hidden.width;
  small.width = 480;
  small.height = Math.round(hidden.height * scale);
  small.getContext('2d').drawImage(hidden, 0, 0, small.width, small.height);
  const dataUrl = small.toDataURL('image/jpeg', 0.6);

  const photo = { dataUrl, hex, rgb: { r, g, b }, name, shade, capturedAt: new Date().toISOString() };
  state.currentTest.photos.push(photo);

  const thumb = document.createElement('div');
  thumb.className = 'thumb-item';
  thumb.innerHTML = `
    <img src="${dataUrl}" alt="Captured photo ${state.currentTest.photos.length}" />
    <span class="thumb-badge">#${state.currentTest.photos.length}</span>
    <span class="thumb-swatch" style="background:${hex}" title="${name} · ${shade} (${hex})"></span>
  `;
  el('thumbGrid').appendChild(thumb);

  updateProgress();

  if (state.currentTest.photos.length >= TARGET_PHOTOS) {
    finishTest();
  }
}

function finishTest() {
  stopCamera();
  state.currentTest.finishedAt = new Date().toISOString();
  renderReport(state.currentTest);
  showScreen('report');
}

/* --------------------- Report --------------------- */

const FAMILY_NAMES = ['Red', 'Orange', 'Yellow', 'Green', 'Blue', 'Purple', 'Pink', 'Brown', 'Black', 'White', 'Gray'];

// A photo can carry three layers of colour info: the original AI reading
// (never overwritten — kept for audit), an optional re-processed "enhanced"
// reading, and an optional officer confirmation/correction (human-in-the-loop,
// per the project's own mitigation plan). These helpers pick the most
// authoritative value without ever discarding the earlier layers.
function effectiveName(p) { return p.officerConfirmedName || (p.enhancedColor ? p.enhancedColor.name : p.name); }
function effectiveShade(p) { return p.enhancedColor ? p.enhancedColor.shade : p.shade; }
function effectiveHex(p) { return p.enhancedColor ? p.enhancedColor.hex : p.hex; }
function effectiveRgb(p) { return p.enhancedColor ? p.enhancedColor.rgb : p.rgb; }

function modeColorName(photos) {
  const counts = {};
  for (const p of photos) counts[effectiveName(p)] = (counts[effectiveName(p)] || 0) + 1;
  let best = null, bestCount = -1;
  for (const [name, c] of Object.entries(counts)) {
    if (c > bestCount) { best = name; bestCount = c; }
  }
  return best;
}

// Re-processes the whole captured frame (not just the small live sample) with
// gray-world white-balance correction, producing a visually clearer image and
// a more accurate colour reading — this is what "Fix Lighting" runs.
function enhancePhotoLighting(photo, onDone) {
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    const gains = computeGrayWorldGains(canvas);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    const clamp = (v) => Math.min(255, Math.max(0, v));
    for (let i = 0; i < data.length; i += 4) {
      data[i] = clamp(data[i] * gains.r);
      data[i + 1] = clamp(data[i + 1] * gains.g);
      data[i + 2] = clamp(data[i + 2] * gains.b);
    }
    ctx.putImageData(imageData, 0, 0);

    const { r, g, b } = readFocusColor(canvas);
    const hex = rgbToHex(r, g, b);
    photo.enhancedDataUrl = canvas.toDataURL('image/jpeg', 0.75);
    photo.enhancedColor = { hex, rgb: { r, g, b }, name: nearestColorName(r, g, b), shade: nearestNamedColor(r, g, b) };
    photo.showEnhanced = true;
    onDone();
  };
  img.src = photo.dataUrl;
}

function buildPhotoCardHtml(p, i) {
  const showEnhanced = !!(p.showEnhanced && p.enhancedDataUrl);
  const src = showEnhanced ? p.enhancedDataUrl : p.dataUrl;
  const hex = showEnhanced ? p.enhancedColor.hex : p.hex;
  const name = showEnhanced ? p.enhancedColor.name : p.name;
  const shade = showEnhanced ? p.enhancedColor.shade : p.shade;
  const confirmed = p.officerConfirmedName || '';

  const options = FAMILY_NAMES.map((n) => `<option value="${n}" ${confirmed === n ? 'selected' : ''}>${n}</option>`).join('');

  return `
    <div class="report-photo" data-photo-index="${i}">
      <div class="report-photo-img-wrap">
        <img src="${src}" alt="Frame ${i + 1}" />
        ${showEnhanced ? '<span class="badge-enhanced">Enhanced</span>' : ''}
      </div>
      <div class="report-photo-info">
        <span class="swatch" style="background:${hex}"></span>
        <span>${name} · ${shade} · ${hex}</span>
      </div>
      <div class="report-photo-actions">
        <button type="button" class="btn-xs" data-action="enhance">${p.enhancedDataUrl ? (showEnhanced ? '👁 Show Original' : '👁 Show Enhanced') : '🪄 Fix Lighting'}</button>
        <select data-action="confirm" title="Officer confirmation — corrects the family without erasing the AI reading">
          <option value="">Confirm family (AI: ${p.name})</option>
          ${options}
        </select>
      </div>
    </div>
  `;
}

function wirePhotoCardEvents(test, grid, rerender) {
  grid.querySelectorAll('[data-action="enhance"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = btn.closest('[data-photo-index]');
      const i = Number(card.dataset.photoIndex);
      const photo = test.photos[i];
      if (photo.enhancedDataUrl) {
        photo.showEnhanced = !photo.showEnhanced;
        rerender();
      } else {
        btn.disabled = true;
        btn.textContent = 'Processing…';
        enhancePhotoLighting(photo, rerender);
      }
    });
  });
  grid.querySelectorAll('[data-action="confirm"]').forEach((sel) => {
    sel.addEventListener('change', () => {
      const card = sel.closest('[data-photo-index]');
      const i = Number(card.dataset.photoIndex);
      test.photos[i].officerConfirmedName = sel.value || null;
      rerender();
    });
  });
}

function renderReport(test) {
  test.photos.forEach((p) => { if (!p.shade) p.shade = nearestNamedColor(p.rgb.r, p.rgb.g, p.rgb.b); });
  el('reportTestId').textContent = test.id;
  el('reportOfficer').textContent = `${test.officer} (${test.badge})`;
  el('reportTime').textContent = formatTimestamp(new Date(test.startedAt));
  el('reportCoords').textContent = test.lat != null ? `${test.lat.toFixed(6)}, ${test.lon.toFixed(6)}` : 'Unavailable';
  el('reportCityState').textContent = [test.city, test.state].filter(Boolean).join(', ') || 'Unknown';
  el('reportAddress').textContent = test.address || '—';
  el('reportNotes').value = test.notes || '';

  const dominant = test.photos.length ? modeColorName(test.photos) : '—';
  const dominantPhoto = test.photos.find((p) => effectiveName(p) === dominant);
  el('reportDominantColor').innerHTML = dominantPhoto
    ? `<span class="swatch" style="display:inline-block;width:16px;height:16px;vertical-align:middle;margin-right:6px;border-radius:4px;background:${effectiveHex(dominantPhoto)}"></span>${dominant} · ${effectiveShade(dominantPhoto)} (${effectiveHex(dominantPhoto)})`
    : '—';

  const grid = el('reportPhotoGrid');
  grid.innerHTML = test.photos.map((p, i) => buildPhotoCardHtml(p, i)).join('');
  wirePhotoCardEvents(test, grid, () => renderReport(test));

  el('btnSaveReport').disabled = false;
  el('btnSaveReport').textContent = '💾 Save to Test History';
}

el('reportNotes').addEventListener('input', () => {
  if (state.currentTest) state.currentTest.notes = el('reportNotes').value;
});

el('btnSaveReport').addEventListener('click', () => {
  state.currentTest.notes = el('reportNotes').value;
  saveTestToHistory(state.currentTest);
  el('btnSaveReport').disabled = true;
  el('btnSaveReport').textContent = '✅ Saved';
});
el('btnNewTestFromReport').addEventListener('click', startNewTest);
el('btnHistoryFromReport').addEventListener('click', () => { renderHistory(); showScreen('history'); });
el('btnDownloadPdf').addEventListener('click', () => generatePdfReport(state.currentTest));

/* --------------------- PDF export --------------------- */

const DISCLAIMER_TEXT = "Colour readings assist documentation only. Compare against your test kit's reference chart to interpret the reaction. NarcTrace does not identify substances and is not a replacement for confirmatory laboratory testing.";

function generatePdfReport(test) {
  if (!test) return;
  const { jsPDF } = window.jspdf || {};
  if (!jsPDF) {
    alert('PDF library failed to load. Check your internet connection and try again.');
    return;
  }

  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 15;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;

  doc.setFontSize(18);
  doc.setTextColor(20, 30, 40);
  doc.text('NarcTrace — Test Report', margin, y);
  y += 7;
  doc.setFontSize(10);
  doc.setTextColor(110, 110, 110);
  doc.text('Digital Companion for Field Drug Testing · SIH26231 · Team Vertex231', margin, y);
  y += 6;
  doc.setDrawColor(210);
  doc.line(margin, y, pageWidth - margin, y);
  y += 9;

  test.photos.forEach((p) => { if (!p.shade) p.shade = nearestNamedColor(p.rgb.r, p.rgb.g, p.rgb.b); });
  const dominant = test.photos.length ? modeColorName(test.photos) : null;
  const dominantPhoto = dominant ? test.photos.find((p) => effectiveName(p) === dominant) : null;
  const dominantLabel = dominantPhoto ? `${dominant} · ${effectiveShade(dominantPhoto)} (${effectiveHex(dominantPhoto)})` : 'Unavailable';

  const fields = [
    ['Test ID', test.id],
    ['Officer', `${test.officer} (${test.badge})`],
    ['Timestamp', formatTimestamp(new Date(test.startedAt))],
    ['Coordinates', test.lat != null ? `${test.lat.toFixed(6)}, ${test.lon.toFixed(6)}` : 'Unavailable'],
    ['City / State', [test.city, test.state].filter(Boolean).join(', ') || 'Unknown'],
    ['Approx. Address', test.address || 'Unavailable'],
    ['Dominant Colour', dominantLabel],
  ];

  doc.setFontSize(11);
  const labelWidth = 42;
  for (const [label, value] of fields) {
    doc.setFont(undefined, 'bold');
    doc.setTextColor(20, 30, 40);
    doc.text(`${label}:`, margin, y);
    doc.setFont(undefined, 'normal');
    doc.setTextColor(50, 50, 50);
    const wrapped = doc.splitTextToSize(String(value), contentWidth - labelWidth);
    doc.text(wrapped, margin + labelWidth, y);
    if (label === 'Dominant Colour' && dominantPhoto) {
      const drgb = effectiveRgb(dominantPhoto);
      doc.setFillColor(drgb.r, drgb.g, drgb.b);
      doc.setDrawColor(180);
      doc.rect(margin + labelWidth + doc.getTextWidth(dominantLabel) + 4, y - 4, 5, 5, 'FD');
    }
    y += 6.5 * wrapped.length;
  }

  y += 4;
  doc.setDrawColor(210);
  doc.line(margin, y, pageWidth - margin, y);
  y += 9;

  doc.setFontSize(13);
  doc.setTextColor(20, 30, 40);
  doc.text('Captured Frames & Colour Analysis', margin, y);
  y += 8;

  const imgW = 82, imgH = 61.5, labelH = 17, gapX = 10, gapY = 6;
  const colX = [margin, margin + imgW + gapX];
  let col = 0;

  test.photos.forEach((photo, photoIndex) => {
    if (y + imgH + labelH > pageHeight - margin) {
      doc.addPage();
      y = margin;
      col = 0;
    }
    const x = colX[col];
    const imgSrc = photo.enhancedDataUrl || photo.dataUrl;
    // Explicit unique alias per image — jsPDF's auto-generated alias can
    // collide between visually-similar images (a known jsPDF quirk), which
    // silently drops all but one image onto the page.
    const alias = `${test.id}-photo-${photoIndex}${photo.enhancedDataUrl ? '-enhanced' : ''}`;
    try {
      doc.addImage(imgSrc, 'JPEG', x, y, imgW, imgH, alias);
    } catch (e) {
      doc.setDrawColor(200);
      doc.rect(x, y, imgW, imgH);
    }
    if (photo.enhancedDataUrl) {
      doc.setFillColor(41, 211, 176);
      doc.setFontSize(7);
      doc.setTextColor(6, 35, 31);
      doc.roundedRect(x + 2, y + 2, 20, 5, 1, 1, 'F');
      doc.text('Enhanced', x + 3.5, y + 5.5);
    }
    const rgb = effectiveRgb(photo);
    doc.setFillColor(rgb.r, rgb.g, rgb.b);
    doc.setDrawColor(180);
    doc.rect(x, y + imgH + 1.5, 4.5, 4.5, 'FD');
    doc.setFontSize(9.5);
    doc.setTextColor(40, 40, 40);
    doc.text(`${effectiveName(photo)} · ${effectiveShade(photo)}`, x + 6.5, y + imgH + 5);
    doc.setFontSize(8);
    doc.setTextColor(110, 110, 110);
    const noteBits = [effectiveHex(photo)];
    if (photo.officerConfirmedName) noteBits.push(`officer-confirmed, AI said ${photo.name}`);
    doc.text(doc.splitTextToSize(noteBits.join(' · '), imgW - 6.5), x + 6.5, y + imgH + 10);

    if (col === 0) {
      col = 1;
    } else {
      col = 0;
      y += imgH + labelH + gapY;
    }
  });
  if (col === 1) y += imgH + labelH + gapY;

  if (test.notes && test.notes.trim()) {
    y += 5;
    doc.setFontSize(11);
    doc.setTextColor(20, 30, 40);
    doc.setFont(undefined, 'bold');
    if (y + 10 > pageHeight - margin) { doc.addPage(); y = margin; }
    doc.text('Officer Notes / Remarks', margin, y);
    y += 6;
    doc.setFont(undefined, 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(50, 50, 50);
    const noteLines = doc.splitTextToSize(test.notes.trim(), contentWidth);
    if (y + noteLines.length * 4.8 > pageHeight - margin) { doc.addPage(); y = margin; }
    doc.text(noteLines, margin, y);
    y += noteLines.length * 4.8;
  }

  y += 3;
  if (y + 22 > pageHeight - margin) { doc.addPage(); y = margin; }
  doc.setDrawColor(230, 180, 90);
  doc.setFillColor(255, 249, 235);
  const disclaimerLines = doc.splitTextToSize(DISCLAIMER_TEXT, contentWidth - 10);
  const boxHeight = disclaimerLines.length * 4.5 + 6;
  doc.rect(margin, y, contentWidth, boxHeight, 'FD');
  doc.setFontSize(8.5);
  doc.setTextColor(140, 100, 20);
  doc.text(disclaimerLines, margin + 5, y + 6);

  doc.save(`NarcTrace_${test.id}.pdf`);
}

/* --------------------- History (localStorage) --------------------- */

const HISTORY_KEY = 'narctrace_tests';

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch (e) {
    return [];
  }
}

function saveTestToHistory(test) {
  let history = loadHistory();
  history.unshift(test);
  while (history.length > 0) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
      return;
    } catch (e) {
      // Storage quota exceeded — drop the oldest record and retry.
      history.pop();
    }
  }
}

function renderHistory() {
  const history = loadHistory();
  const list = el('historyList');
  const empty = el('historyEmpty');
  list.innerHTML = '';

  if (history.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  history.forEach((test) => {
    const row = document.createElement('div');
    row.className = 'history-row';
    const thumb = test.photos[0] ? test.photos[0].dataUrl : '';
    const dominant = test.photos.length ? modeColorName(test.photos) : null;
    const dominantPhoto = dominant ? test.photos.find((p) => effectiveName(p) === dominant) : null;
    row.innerHTML = `
      ${thumb ? `<img src="${thumb}" alt="" />` : ''}
      <span class="swatch" style="background:${dominantPhoto ? effectiveHex(dominantPhoto) : '#333'}"></span>
      <div class="history-row-info">
        <div class="hrow-top"><span class="testid">${test.id}</span><strong>${test.officer}</strong></div>
        <span class="hrow-sub">${formatTimestamp(new Date(test.startedAt))} · ${[test.city, test.state].filter(Boolean).join(', ') || 'Unknown location'}</span>
      </div>
    `;
    row.addEventListener('click', () => showHistoryDetail(test));
    list.appendChild(row);
  });
}

function updateHistoryRecord(test) {
  const history = loadHistory();
  const idx = history.findIndex((t) => t.id === test.id && t.startedAt === test.startedAt);
  if (idx === -1) return false;
  history[idx] = test;
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    return true;
  } catch (e) {
    return false;
  }
}

function showHistoryDetail(test) {
  const card = el('detailCard');
  // Fall back to computing the shade for records saved before this field existed.
  test.photos.forEach((p) => { if (!p.shade) p.shade = nearestNamedColor(p.rgb.r, p.rgb.g, p.rgb.b); });
  const dominant = test.photos.length ? modeColorName(test.photos) : '—';
  const dominantPhoto = test.photos.find((p) => effectiveName(p) === dominant);
  card.innerHTML = `
    <div class="report-header">
      <h1>Test Report</h1>
      <span class="testid">${test.id}</span>
    </div>
    <div class="report-grid">
      <div class="report-field"><span>Officer</span><strong>${test.officer} (${test.badge})</strong></div>
      <div class="report-field"><span>Timestamp</span><strong>${formatTimestamp(new Date(test.startedAt))}</strong></div>
      <div class="report-field"><span>Coordinates</span><strong>${test.lat != null ? `${test.lat.toFixed(6)}, ${test.lon.toFixed(6)}` : 'Unavailable'}</strong></div>
      <div class="report-field"><span>City / State</span><strong>${[test.city, test.state].filter(Boolean).join(', ') || 'Unknown'}</strong></div>
      <div class="report-field wide"><span>Approx. address</span><strong>${test.address || '—'}</strong></div>
      <div class="report-field"><span>Dominant reaction colour</span><strong>${dominantPhoto ? `${dominant} · ${effectiveShade(dominantPhoto)} (${effectiveHex(dominantPhoto)})` : '—'}</strong></div>
    </div>
    <h3>Captured Frames &amp; Colour Analysis</h3>
    <div class="report-photo-grid" id="detailPhotoGrid">${test.photos.map((p, i) => buildPhotoCardHtml(p, i)).join('')}</div>
    <label class="field" style="margin-top:14px;">
      <span>Officer Notes / Remarks</span>
      <textarea id="detailNotes" rows="3" placeholder="Any observations about the test, kit, or conditions...">${test.notes || ''}</textarea>
    </label>
    <div class="disclaimer">
      ⚠️ Colour readings assist documentation only. Compare against your test kit's reference chart to interpret the reaction. NarcTrace does not identify substances and is not a replacement for confirmatory laboratory testing.
    </div>
    <div class="report-actions">
      <button class="btn btn-primary" id="btnUpdateRecord">💾 Save Changes</button>
      <button class="btn btn-secondary" id="btnDownloadPdfDetail">⬇ Download PDF Report</button>
      <button class="btn btn-secondary" id="btnBackToHistory">← Back to History</button>
    </div>
  `;
  const detailGrid = el('detailPhotoGrid');
  wirePhotoCardEvents(test, detailGrid, () => showHistoryDetail(test));
  el('detailNotes').addEventListener('input', () => { test.notes = el('detailNotes').value; });
  el('btnUpdateRecord').addEventListener('click', () => {
    test.notes = el('detailNotes').value;
    const btn = el('btnUpdateRecord');
    btn.textContent = updateHistoryRecord(test) ? '✅ Saved' : '⚠ Save failed (storage full)';
    setTimeout(() => { btn.textContent = '💾 Save Changes'; }, 1800);
  });
  el('btnDownloadPdfDetail').addEventListener('click', () => generatePdfReport(test));
  el('btnBackToHistory').addEventListener('click', () => { renderHistory(); showScreen('history'); });
  showScreen('detail');
}

el('btnClearHistory').addEventListener('click', () => {
  if (confirm('Delete all saved test records from this device? This cannot be undone.')) {
    localStorage.removeItem(HISTORY_KEY);
    renderHistory();
  }
});

el('btnBackHome').addEventListener('click', () => showScreen('home'));

/* --------------------- Init --------------------- */

showScreen('permissions');
